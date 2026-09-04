#!/usr/bin/env node
// @ts-check
/**
 * 這些事在別的機器上也要成立 —— `npm run test:portability`
 *
 * 第二十二圈問「這件事只在我的機器上成立嗎」。有些答案是**不成立**，
 * 而且不成立的時候不會有任何一道關卡變紅 —— 因為每一道關卡都跑在
 * 同一台機器上。這一支守的就是那幾件事。
 *
 * 現在有兩組：
 *
 *   1. 日期不能跟著建置機器的時區跑
 *   2. import 的大小寫要跟真的檔名一模一樣（macOS 不分，Linux 分）
 *   3. 排程的 cron 是 UTC，而註解說的是臺北時間
 *   4. 排序不能跟著環境的預設語言（LANG／LC_ALL）跑
 *
 * ## 一、時區
 *
 * 這個站的內容日期是**只有日期**的字串（`publishedAt: 2026-01-01`），
 * 而 `new Date('2026-01-01')` 會當成 **UTC 的午夜**。
 * 之後只要用 `getFullYear()` 之類讀「本地時間」的方法，答案就會跟著
 * **跑這段程式的機器**變 —— 在美東是前一年的 12 月 31 日晚上七點。
 *
 * 第 3 輪（第二十二圈）實測到的具體後果：放一篇 `publishedAt: 2026-01-01`
 * 的內容，同一份原始碼在美東建出來的彙整頁會多一個「2025」的年份標題，
 * 而那一篇底下顯示的日期還是「1月1日」——**同一個畫面上自相矛盾**。
 * 站主的機器在美東，CI 在 UTC，讀者在臺北：三台機器三個答案。
 *
 * 這種錯不會拋例外、不會讓任何一道關卡變紅，只有在跨年那一天才看得見。
 * 所以要有東西守著。
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', String(detail).slice(0, 400));
  }
};

console.log('\n可攜性（別的機器上也成立嗎）\n' + '─'.repeat(56));

/**
 * ── 1. `src/` 裡不准有讀本地時間的日期方法 ──────────────
 *
 * 判準是整份 `src/`，不是某幾個檔案：一個新元件在頁尾印個年份，
 * 就會安靜地把這個 bug 帶回來。
 *
 * `scripts/` 不在範圍內 —— `new-entry.mjs` 是**刻意**用本地日期的
 * （她在自己的電腦上開新文章，「今天」就該是她眼中的今天）。
 */
const LOCAL_TIME_METHODS = /\.(getFullYear|getMonth|getDate|getHours|getMinutes|getDay)\s*\(/;

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'content') continue; // markdown，不是程式碼
      yield* walk(full);
    } else if (['.ts', '.astro', '.mjs', '.js'].includes(extname(e.name))) {
      yield full;
    }
  }
}

/** @type {string[]} */
const offenders = [];
for await (const file of walk(resolve(ROOT, 'src'))) {
  const text = (await readFile(file, 'utf8'))
    /* 註解裡提到方法名是在講它，不是在呼叫它 */
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/g, ' ');
  for (const [i, line] of text.split('\n').entries()) {
    if (LOCAL_TIME_METHODS.test(line)) {
      offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}　${line.trim().slice(0, 60)}`);
    }
  }
}
check(
  `src/ 裡沒有讀本地時間的日期方法（掃到 ${offenders.length} 處）`,
  offenders.length === 0,
  offenders.join('\n      '),
);
if (offenders.length > 0) {
  console.log('      這些會跟著建置機器的時區變。改用 lib/dates.ts 的 year()／formatDate()。');
}

/*
 * ── 2. 那兩支自己有沒有把時區釘住 ──────────────────────
 *
 * 上面那一條只擋「有沒有人呼叫壞方法」。如果有人把 `dates.ts` 裡的
 * `timeZone: 'Asia/Taipei'` 拿掉，上面那條**完全不會說話** ——
 * 而全站的日期會一起漂掉。
 */
const dates = await readFile(resolve(ROOT, 'src/lib/dates.ts'), 'utf8');
const pinned = [...dates.matchAll(/timeZone:\s*'([^']+)'/g)].map((m) => m[1]);
check(
  `dates.ts 有兩處把時區釘成 Asia/Taipei（實際 ${pinned.length} 處：${pinned.join('、') || '無'}）`,
  pinned.length >= 2 && pinned.every((t) => t === 'Asia/Taipei'),
  pinned.join('、'),
);

/*
 * ── 3. 真的換一個時區跑一次 ────────────────────────────
 *
 * 上面兩條都是讀原始碼。這一條是**真的在別的時區底下算一次** ——
 * 用子行程把 `TZ` 換掉，問同一個問題：`2026-01-01` 是哪一年？
 *
 * 少了這一格，把 `Asia/Taipei` 改成別的時區（例如 `America/New_York`）
 * 會通過上面那條「有沒有釘住」的檢查嗎？不會，因為它比對的是字串。
 * 但改成 `Asia/Tokyo` 就會通過 —— 而東京跟臺北在元旦那天同一年，
 * 所以那個突變其實無害。真正要守的是**「跟本地時區無關」**這件事本身。
 */
const probe = `
  const d = new Date('2026-01-01');
  const taipei = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(d));
  console.log(JSON.stringify({ tz: process.env.TZ, local: d.getFullYear(), taipei }));
`;
/** @param {string} tz */
const runIn = (tz) =>
  JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: { ...process.env, TZ: tz },
    }).trim(),
  );

const taipei = runIn('Asia/Taipei');
const newYork = runIn('America/New_York');
const utc = runIn('UTC');

check(
  '三個時區底下，臺北年份都是 2026',
  taipei.taipei === 2026 && newYork.taipei === 2026 && utc.taipei === 2026,
  JSON.stringify({ taipei, newYork, utc }),
);
/*
 * 反向：確認這個測試真的分得出東西來。
 * `getFullYear()` 在美東就是會給 2025 —— 如果這一格變綠，
 * 代表子行程的 TZ 沒有生效，上面那一格也就什麼都沒證明。
 */
check(
  '而 getFullYear() 在美東確實會給 2025（證明這個測試分得出差別）',
  newYork.local === 2025 && taipei.local === 2026,
  JSON.stringify({ 美東: newYork.local, 臺北: taipei.local }),
);

/*
 * ## 二、import 的大小寫
 *
 * macOS 的檔案系統**不分大小寫**，Linux 分。所以
 * `import X from '@components/foxMark.astro'`（真檔名是 `FoxMark.astro`）
 * 在這台機器上完全正常，在 CI 上直接建置失敗。
 *
 * 這個 repo 已經在別的地方踩過兩次大小寫（標籤、`related`），
 * 而那兩次是**資料**的大小寫。這一條守的是**檔名**的 ——
 * 目前為止本機沒有任何一道關卡看得到它：`npm run build` 過、
 * `ci:sim` 也過（它從 git archive 建，但仍然建在同一個檔案系統上）。
 *
 * 第 3 輪（第二十二圈）量到：255 個相對／別名 import，0 個對不上。
 * 所以這一條加的是「以後也不會有」。
 */
{
  /** 別名 → 真的目錄（跟 tsconfig 的 paths 對齊） */
  const ALIAS = {
    '@components': 'src/components',
    '@layouts': 'src/layouts',
    '@lib': 'src/lib',
    '@config': 'src/config',
    '@i18n': 'src/i18n',
    '@styles': 'src/styles',
    '@assets': 'src/assets',
    '@data': 'src/data',
  };
  /** 目錄 → 真實檔名（保留大小寫） */
  const listing = new Map();
  /** @param {string} dir */
  const namesIn = async (dir) => {
    if (!listing.has(dir)) listing.set(dir, await readdir(dir).catch(() => []));
    return /** @type {string[]} */ (listing.get(dir));
  };

  let checked = 0;
  /** @type {string[]} */
  const wrongCase = [];
  for await (const file of walk(resolve(ROOT, 'src'))) {
    const text = await readFile(file, 'utf8');
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      let abs = null;
      if (spec.startsWith('.')) abs = resolve(dirname(file), spec);
      else {
        const key = Object.keys(ALIAS).find((a) => spec === a || spec.startsWith(a + '/'));
        if (key) abs = resolve(ROOT, ALIAS[/** @type {keyof typeof ALIAS} */ (key)] + spec.slice(key.length));
      }
      if (!abs) continue; // 套件名，不歸這裡管
      checked++;
      const dir = dirname(abs);
      const want = abs.slice(dir.length + 1);
      const names = await namesIn(dir);
      /* 副檔名可以省略，所以三種都算 */
      const candidates = [want, want + '.ts', want + '.astro', want + '.mjs'];
      const exact = names.some((n) => candidates.includes(n));
      const loose = names.some((n) => candidates.some((c) => c.toLowerCase() === n.toLowerCase()));
      /* 只在「不分大小寫找得到、分大小寫找不到」時報 —— 那正好是會在 Linux 上爆的那一種 */
      if (!exact && loose) wrongCase.push(`${file.slice(ROOT.length + 1)} → ${spec}`);
    }
  }
  check(
    `import 的大小寫都跟真檔名一致（檢查了 ${checked} 個）`,
    wrongCase.length === 0 && checked > 50,
    wrongCase.join('\n      ') || `只檢查到 ${checked} 個 —— 太少，掃描可能壞了`,
  );
  if (wrongCase.length > 0) {
    console.log('      macOS 不分大小寫所以本機正常，Linux 上（CI）會直接建置失敗。');
  }
}

/*
 * ## 三、排程的 cron 是 UTC，而註解說的是臺北時間
 *
 * `sync-feeds.yml` 寫著：
 *
 *     # 台北時間每天 08:00 與 20:00（cron 用 UTC）
 *     - cron: '0 0,12 * * *'
 *
 * 換算是對的（UTC 00:00／12:00 就是臺北 08:00／20:00），
 * 但**沒有任何東西在守這個換算**。改了任何一邊，另一邊會安靜地變成謊話 ——
 * 而「同步在幾點跑」這件事，要等她發現影片晚了半天才會被注意到。
 *
 * 第 4 輪（第二十二圈）加的。判準不看註解怎麼措辭，只抓裡面的 `HH:MM`。
 */
{
  const yml = await readFile(resolve(ROOT, '.github/workflows/sync-feeds.yml'), 'utf8');
  const lines = yml.split('\n');
  const cronAt = lines.findIndex((l) => /^\s*-\s*cron:/.test(l));
  const cron = cronAt >= 0 ? /cron:\s*'([^']+)'/.exec(lines[cronAt])?.[1] ?? '' : '';
  /* 註解在 cron 那一行的上面（可能不只一行） */
  const comment = cronAt > 0 ? lines.slice(Math.max(0, cronAt - 3), cronAt).join(' ') : '';
  const claimed = [...comment.matchAll(/(\d{1,2}):(\d{2})/g)].map((m) => `${m[1].padStart(2, '0')}:${m[2]}`);

  const [min, hours] = cron.split(' ');
  const actual = (hours ?? '')
    .split(',')
    .filter((h) => /^\d+$/.test(h))
    .map((h) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(Date.UTC(2026, 0, 1, Number(h), Number(min ?? 0)))),
    );

  check(
    `cron 換算成臺北時間跟註解說的一樣（cron '${cron}' → ${actual.join('、') || '算不出來'}）`,
    claimed.length > 0 && actual.length > 0 && claimed.join() === actual.join(),
    `註解說 ${claimed.join('、') || '（抓不到時間）'}，實際是 ${actual.join('、') || '（抓不到 cron）'}`,
  );
  if (claimed.join() !== actual.join()) {
    console.log('      GitHub 的 cron 一律是 UTC，而這個站的人在臺北（UTC+8，不實施日光節約）。');
  }
}

/*
 * ## 四、排序不能跟著環境的預設語言跑
 *
 * `'a'.localeCompare('b')` 不給語言的話，用的是**執行環境的預設語言**，
 * 而那個語言跟著 `LANG`／`LC_ALL` 走。第 7 輪（第二十二圈）實測：
 *
 *   en-US　→  aa-x  ab-x  chat-a  china-blog  cukr
 *   cs-CZ　→  aa-x  ab-x  cukr  chat-a  china-blog　← ch 在捷克語是一個字母
 *   da-DK　→  ab-x  …  cukr  aa-x　　　　　　　　　　← aa 在丹麥語排最後
 *
 * `scripts/lib/sync-core.mjs` 就有一個：它排 `syndication.json` 的來源鍵，
 * 而**那個檔案要進版控** —— 同步跑在不同機器上會產生只有鍵順序不同的假 diff。
 * 改成碼位比較（`a < b`）之後就跟語言無關了。
 *
 * 兩格：沒有人再寫出不給語言的 `localeCompare`，
 * 以及**證明這件事真的會差** —— 不然上一格可能只是在守一件不會發生的事。
 */
{
  /** @type {string[]} */
  const bare = [];
  let files = 0;
  /*
   * 這個檔案自己要被排除 —— 底下那一格**故意**寫了一個不給語言的
   * `localeCompare`，用來證明「不給語言真的會差」。
   *
   * 「解釋一條規則，就會需要那條規則禁止的東西」這個模式，
   * 在這個 repo 出現過六次了（本名寫進文件、抄測試信箱、
   * `taiwan-tai` 引用被禁的字⋯⋯）。第一版忘了排除，跑起來就自己紅了。
   */
  /**
   * 這一行有沒有不給語言的 `localeCompare`。
   *
   * 抽成函式是為了**測得到判準本身**：掃真的 `src/`／`scripts/` 只會得到
   * 0 個，而「0 個」在判準寫窄的時候長得一模一樣。
   * 突變掃描證實過：把樣式放寬成只認 `localeCompare()`（完全沒有引數），
   * 掃真檔案照樣全綠 —— 補了下面那幾個樣本才紅。
   *
   * @param {string} line
   */
  const bareLocaleCompare = (line) => /\.localeCompare\(\s*[^,)]+\s*\)/.test(line);

  const SAMPLES = [
    { line: "a.localeCompare(b)", bad: true },
    { line: "x.tag.localeCompare(y.tag)", bad: true },
    { line: "a.localeCompare(b, 'zh-TW')", bad: false },
    { line: "a.localeCompare(b, 'en', { numeric: true })", bad: false },
    { line: "keys.sort((a, b) => (a < b ? -1 : 1))", bad: false },
  ];
  const wrong = SAMPLES.filter((s) => bareLocaleCompare(s.line) !== s.bad);
  check(
    `判準本身分得出來（${SAMPLES.length} 個樣本）`,
    wrong.length === 0,
    wrong.map((w) => `${w.bad ? '該抓沒抓' : '不該抓卻抓了'}：${w.line}`).join('　'),
  );

  const SELF = resolve(ROOT, 'scripts/test-portability.mjs');
  for (const dir of ['src', 'scripts']) {
    for await (const file of walk(resolve(ROOT, dir))) {
      if (file === SELF) continue;
      files++;
      const text = (await readFile(file, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|\s)\/\/[^\n]*/g, ' ');
      for (const [i, line] of text.split('\n').entries()) {
        /* 有第二個引數（語言）就沒問題；`localeCompare(x)` 這種才是 */
        if (bareLocaleCompare(line)) {
          bare.push(`${file.slice(ROOT.length + 1)}:${i + 1}　${line.trim().slice(0, 60)}`);
        }
      }
    }
  }
  check(
    `沒有不給語言的 localeCompare（掃了 ${files} 個檔案）`,
    bare.length === 0 && files > 50,
    bare.join('\n      ') || `只掃到 ${files} 個檔案 —— 太少，掃描可能壞了`,
  );
  if (bare.length > 0) {
    console.log('      排序會跟著 LANG／LC_ALL 變。給它一個明確的語言，或用碼位比較（a < b）。');
  }

  /*
   * 反向的另一半：確認「不給語言真的會差」。
   * 少了這一格，上面那條可能只是在守一件根本不會發生的事 ——
   * 而那正是這個 repo 一再記的「綠得因為空」。
   */
  const probe = `
    const keys = ['aa-x', 'ab-x', 'chat-a', 'china-blog', 'cukr'];
    console.log(JSON.stringify([...keys].sort((a, b) => a.localeCompare(b))));
  `;
  /** @param {string} lang */
  const orderIn = (lang) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
      encoding: 'utf8',
      env: { ...process.env, LANG: lang, LC_ALL: lang },
    }).trim();
  const en = orderIn('en_US.UTF-8');
  const cs = orderIn('cs_CZ.UTF-8');
  const da = orderIn('da_DK.UTF-8');
  check(
    '而不給語言的排序確實會因環境而異（證明上一格在守真的東西）',
    en !== cs && en !== da,
    `en=${en}\n      cs=${cs}\n      da=${da}`,
  );
}

console.log('─'.repeat(56));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
