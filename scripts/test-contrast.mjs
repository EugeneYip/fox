#!/usr/bin/env node
// @ts-check
/**
 * 對比度關卡的實測 —— `npm run test:contrast`
 *
 * 放一組故意不合格的顏色，確認 `check:contrast` 會擋；
 * 放一組合格的，確認不誤報。
 *
 * ## 為什麼
 *
 * 第 8 輪（第四圈）之前，這是**唯一沒有被驗證過會擋的關卡** ——
 * 無障礙 22 條規則、效能 10 條預算、隱私 8 個結構性檢查、文案 4 條規則、
 * feed 剖析都測過了，只有它沒有。
 *
 * 而它守的是最基本的一件事：**字看不看得清楚**。
 * 壞掉的話所有顏色都會安靜地通過，而網站上就是一片看不清的灰。
 *
 * 順便測第 8 輪（第三圈）加的那一段：列印時所有主題都要切回淺色。
 * 那個 bug 活了兩圈才被發現，因為沒有人驗過。
 *
 * ## 第 8 輪（第九圈）把斷言換掉了
 *
 * 舊版的判準只有一句：
 *
 *     const blocked = !/未達標 0 組/.test(out);
 *
 * ——**只問有沒有擋，不問擋的是什麼**。突變掃描 14 個點，6 個靜靜通過：
 * 一律 `exit 0`（關卡不再是關卡，而這裡只讀 stdout 不讀離開碼）、
 * 只算淺色不算深色、PAIRS 少一組、「找不到變數」不計數、
 * 以及**去掉 CSS 註解那一行**（那正是這個 repo 踩過五次的坑的修法，
 * 拿掉之後列印那個案例仍然綠，因為它只需要「有東西缺」而不管缺幾個）。
 *
 * 兩個 needle 也都是空話：通過時的輸出本來就寫著「未達標 0 組」和
 * 「列印：3 個⋯⋯都有覆蓋 ✓」，兩個字串都在。
 *
 * 現在每個案例宣告的是**確切的集合**：哪幾組不合格、哪幾組找不到變數、
 * 列印缺哪幾個選擇器、總共檢查幾組、離開碼是多少。多一個少一個都算失敗。
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 真的 tokens.css 有哪些 token，就照著給 —— 少一個會變成「找不到變數」而不是「對比不足」 */
const realTokens = await readFile(resolve(ROOT, 'src/styles/tokens.css'), 'utf8');
const realGlobal = await readFile(resolve(ROOT, 'src/styles/global.css'), 'utf8');

/**
 * 把真的 tokens.css 裡某個顏色換掉。
 * @param {string} name  例如 '--c-ink'
 * @param {string} light
 * @param {string} dark
 */
function withColor(name, light, dark) {
  const re = new RegExp(`(${name}: )light-dark\\([^)]*\\);`);
  if (!re.test(realTokens)) throw new Error(`tokens.css 裡找不到 ${name} 的 light-dark() 那一行`);
  /*
   * **兩行都要改。** 每個 token 在 tokens.css 裡出現兩次：一行單值的
   * fallback（給不支援 light-dark() 的瀏覽器）、一行 light-dark()。
   * 真的有人改顏色時會兩行一起改。
   *
   * 第 8 輪（第十四圈）加了「fallback 要跟淺色值一致」的檢查之後，
   * 只改一行的假 tokens 會多觸發那一條 —— 於是案例證明的就不只是它想證明
   * 的那件事了（第九圈那一整輪在講的就是這個）。
   */
  const fallbackRe = new RegExp(`(^\\s*${name}: )[^;\\n]+;$`, 'm');
  if (!fallbackRe.test(realTokens)) throw new Error(`tokens.css 裡找不到 ${name} 的 fallback 那一行`);
  return realTokens.replace(fallbackRe, `$1${light};`).replace(re, `$1light-dark(${light}, ${dark});`);
}

/**
 * 把 check:contrast 的輸出讀成結構。
 *
 * 用「現在在哪一段」的狀態機，不用縮排寬度去分 —— 顏色那幾行是
 * `  ✗  位置`（兩個空格），列印缺漏是 `  ✗ 選擇器`（一個空格），
 * 靠空格數量分是遲早要壞的那種寫法。
 *
 * 解析完會自己驗一次（見 parse 尾端）：格式變了要當場說話，
 * 不能安靜地回一個空集合讓每個案例都「符合預期」。
 *
 * @param {string} out
 */
function parse(out) {
  /** @type {string[]} */ const fails = [];
  /** @type {string[]} */ const missing = [];
  /** @type {string[]} */ const printMissing = [];
  /** @type {string[]} */ const coverage = [];
  /** @type {string[]} */ const fallback = [];
  /** @type {string[]} */ const unused = [];
  let theme = '';
  let inPrint = false;
  let inCoverage = false;
  let inFallback = false;
  let inUnused = false;

  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t === '淺色' || t === '深色') { theme = t; continue; }
    /*
     * 三段各自有 `✗` 開頭的行，所以段落狀態要分得開。
     * 第 8 輪（第十圈）加了「涵蓋率」那一段之後，如果不分，
     * 涵蓋率的缺口會被算成顏色不合格 —— 兩件事的意思完全不同。
     */
    if (t.startsWith('未使用：')) { inUnused = true; inCoverage = false; inFallback = false; inPrint = false; continue; }
    if (t.startsWith('涵蓋率：')) { inCoverage = true; inUnused = false; inPrint = false; continue; }
    if (t.startsWith('fallback：')) { inFallback = true; inCoverage = false; inUnused = false; inPrint = false; continue; }
    if (t.startsWith('列印：')) { inPrint = true; inCoverage = false; inFallback = false; inUnused = false; continue; }
    if (!t) continue;
    if (inUnused) {
      const mm = /^✗\s*(--[\w-]+)/.exec(t);
      if (mm) unused.push(mm[1]);
      continue;
    }
    if (inFallback) {
      const mm = /^✗\s*(--[\w-]+)/.exec(t);
      /* 兩種訊息要分得開：「兩行對不起來」與「根本沒有 fallback」是不同的事 */
      if (mm) fallback.push(mm[1] + (t.includes('沒有單值的 fallback') ? '（缺）' : '（不一致）'));
      continue;
    }
    if (inCoverage) {
      const m = /^✗\s*(--c-[\w-]+)/.exec(t);
      if (m) coverage.push(m[1]);
      continue;
    }
    if (inPrint) {
      if (t.startsWith('✗')) printMissing.push(t.replace(/^✗\s*/, ''));
      continue;
    }
    // 顏色那一段：`✗ 位置  比值  門檻  fg on bg` / `⚠ 位置  找不到變數 …`
    if (t.startsWith('✗') || t.startsWith('⚠')) {
      const where = t.replace(/^[✗⚠]\s*/, '').split(/\s{2,}/)[0].trim();
      (t.startsWith('✗') ? fails : missing).push(`${theme}／${where}`);
    }
  }

  const summary = out.split('\n').find((l) => /^檢查 \d+ 組，未達標 \d+ 組。$/.test(l.trim()));
  if (!summary) throw new Error('讀不到結尾的統計行 —— 不是格式變了就是腳本中途死掉');
  const m = /^檢查 (\d+) 組，未達標 (\d+) 組。$/.exec(summary.trim());
  if (!m) throw new Error('統計行讀得到卻剖不開');
  if (!theme) throw new Error('輸出裡連一個主題標題都沒有 —— 解析一定是壞的');

  return { fails, missing, printMissing, coverage, fallback, unused, checked: Number(m[1]), failures: Number(m[2]) };
}

let failed = 0;
console.log('\n對比度關卡實測');
console.log('─'.repeat(64));

/**
 * @param {string} label
 * @param {{ tokens?: string, global?: string, extra?: Record<string, string> }} files
 * @param {{ exit: number, checked: number, fails?: string[], missing?: string[], printMissing?: string[], coverage?: string[], fallback?: string[], unusedHas?: string[], unusedHasNot?: string[] }} want
 */
async function check(label, files, want) {
  const dir = await mkdtemp(join(tmpdir(), 'contrast-'));
  await mkdir(join(dir, 'src/styles'), { recursive: true });
  await writeFile(join(dir, 'src/styles/tokens.css'), files.tokens ?? realTokens, 'utf8');
  await writeFile(join(dir, 'src/styles/global.css'), files.global ?? realGlobal, 'utf8');
  for (const [rel, body] of Object.entries(files.extra ?? {})) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body, 'utf8');
  }

  let out = '';
  let exit = 0;
  try {
    ({ stdout: out } = await run('node', [resolve(ROOT, 'scripts/check-contrast.mjs'), `--root=${dir}`]));
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    out = String(e?.stdout ?? '');
    exit = typeof e?.code === 'number' ? e.code : -1;
  }
  await rm(dir, { recursive: true, force: true });

  /** @type {string[]} */
  const problems = [];
  /*
   * 離開碼要單獨看。verify:all 是 `a && b && c` 串起來的 ——
   * check:contrast 就算把整頁不合格印出來，只要 exit 0 就會被當成過。
   * 舊版只讀 stdout，所以「一律 exit 0」這個突變靜靜通過了。
   */
  if (exit !== want.exit) problems.push(`離開碼：預期 ${want.exit}，實際 ${exit}`);

  let got;
  try {
    got = parse(out);
  } catch (e) {
    problems.push(`剖析輸出失敗：${/** @type {Error} */ (e).message}`);
  }

  if (got) {
    /** @param {string} name @param {string[]} a @param {string[]} b */
    const sameSet = (name, a, b) => {
      const [x, y] = [[...a].sort(), [...b].sort()];
      if (x.join('｜') !== y.join('｜')) {
        problems.push(`${name}：預期 [${y.join('、') || '無'}]，實際 [${x.join('、') || '無'}]`);
      }
    };
    sameSet('不合格的組', got.fails, want.fails ?? []);
    sameSet('找不到變數的組', got.missing, want.missing ?? []);
    sameSet('列印缺漏的選擇器', got.printMissing, want.printMissing ?? []);
    sameSet('沒有人在算的顏色', got.coverage, want.coverage ?? []);
    sameSet('fallback 對不起來的 token', got.fallback, want.fallback ?? []);
    /*
     * 「沒有人用的 token」不做集合比對。
     *
     * 因為假 repo 的 src/ 只有兩份 CSS，真的元件都不在裡面 ——
     * 那份名單在 fixture 裡永遠是「幾乎全部」，釘死只會製造雜訊。
     * 要斷言的案例用 `unusedHas`／`unusedHasNot` 指名那一個就好。
     */
    for (const t of want.unusedHas ?? []) {
      if (!got.unused.includes(t)) problems.push(`${t} 應該被列成沒有人用，但沒有`);
    }
    for (const t of want.unusedHasNot ?? []) {
      if (got.unused.includes(t)) problems.push(`${t} 有人用，卻被列成沒有人用`);
    }
    /*
     * 總組數釘死。PAIRS 少一組不會有任何人抱怨 —— 少的那一組只是
     * 不再被檢查而已。真的要加減組合的時候順手改這個數字，
     * 那一改就是「我知道我在改檢查範圍」。
     */
    if (got.checked !== want.checked) {
      problems.push(
        `檢查的組數：預期 ${want.checked}，實際 ${got.checked}` +
          '（剛加減 PAIRS 就改這個數字；沒改過 PAIRS 的話是有一組不見了）',
      );
    }
  }

  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} ${label}`);
  for (const p of problems) console.log(`      ${p}`);
}

// 正常的 tokens 應該全過
await check('原本的顏色全部合格', {}, { exit: 0, checked: 42 });

// 正文顏色改成幾乎跟底色一樣 → 一定要擋，而且只有用到 --c-ink 的那四組
/*
 * ── 不合格的時候要算出「改成什麼會過」──────────────
 *
 * 第 8 輪（第十七圈）量到：那一行只說「1.40:1 需 4.5:1，#d8d2c6 on #faf6ee」——
 * 事實齊全，但站主看不出要調到多暗才夠。而那正是這裡唯一能算、
 * 她絕對算不出來的東西（WCAG 的相對亮度不是線性的）。
 *
 * 這一格不只看有沒有印，還**把建議的顏色拿去驗**：真的過門檻才算數。
 * 只檢查「有一行改法」的話，算錯的建議也會通過。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'contrast-fix-'));
  await mkdir(join(dir, 'src/styles'), { recursive: true });
  await writeFile(join(dir, 'src/styles/tokens.css'), withColor('--c-ink', '#f5f2ea', '#17150f'), 'utf8');
  await writeFile(join(dir, 'src/styles/global.css'), realGlobal, 'utf8');
  let out = '';
  try {
    ({ stdout: out } = await run('node', [resolve(ROOT, 'scripts/check-contrast.mjs'), `--root=${dir}`]));
  } catch (err) {
    out = String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  }
  const line = out.split('\n').find((l) => l.includes('改法：') && l.includes('--c-ink')) ?? '';
  const hex = /#[0-9a-f]{6}/i.exec(line)?.[0] ?? '';
  let problems = [];
  if (!line) problems.push('沒有印出改法那一行');
  if (!hex) problems.push('改法裡沒有給一個顏色');
  if (hex) {
    /* 建議的顏色配淺色底 #faf6ee 必須真的過 4.5:1 */
    const rgb = (/** @type {string} */ h) =>
      [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
    const lum = (/** @type {string} */ h) =>
      rgb(h)
        .map((v) => v / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((acc, v, i) => acc + [0.2126, 0.7152, 0.0722][i] * v, 0);
    const ratio = (lum('#faf6ee') + 0.05) / (lum(hex) + 0.05);
    if (ratio < 4.5) problems.push(`建議的 ${hex} 只有 ${ratio.toFixed(2)}:1，還是不夠`);
  }
  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 不合格時算出一個真的會過的顏色`);
  for (const x of problems) console.log(`      ${x}`);
  await rm(dir, { recursive: true, force: true });
}

await check(
  '正文顏色貼近底色時會擋（而且只擋用到 --c-ink 的那幾組）',
  { tokens: withColor('--c-ink', '#f5f2ea', '#17150f') },
  {
    exit: 1,
    checked: 42,
    fails: [
      '淺色／正文', '淺色／卡片上的正文', '淺色／程式碼區塊', '淺色／選取範圍',
      '深色／正文', '深色／卡片上的正文', '深色／程式碼區塊', '深色／選取範圍',
    ],
  },
);

// 焦點框的顏色不合格（WCAG 1.4.11 的 3:1）
await check(
  '焦點框對比不足時會擋（只擋兩組焦點框，不牽連別的）',
  { tokens: withColor('--c-focus', '#f7ede2', '#1a1712') },
  {
    exit: 1,
    checked: 42,
    fails: ['淺色／鍵盤焦點框', '淺色／卡片上的焦點框', '深色／鍵盤焦點框', '深色／卡片上的焦點框'],
  },
);

/*
 * 只把深色那一半弄壞。
 *
 * 上面兩個案例都是深淺一起壞，所以「只算淺色、不算深色」跟
 * 「light-dark() 的兩個值讀反了」這兩個突變在它們底下都是綠的。
 * 這一個把兩套顏色分開：淺色維持原值（要全過），深色貼近底色（要擋）。
 */
await check(
  '只有深色壞掉時，只有深色被報出來',
  { tokens: withColor('--c-ink', '#1f1c18', '#17150f') },
  {
    exit: 1,
    checked: 42,
    fails: ['深色／正文', '深色／卡片上的正文', '深色／程式碼區塊', '深色／選取範圍'],
  },
);

/*
 * token 改名 → PAIRS 指到不存在的變數。
 *
 * 這條路是「有一組悄悄不再被檢查」唯一的守門員：改名的人不會知道
 * check-contrast.mjs 裡有一份對照表。它印 ⚠ 而且要計進未達標。
 */
await check(
  'tokens.css 改了名字時會說「找不到變數」而不是安靜地少檢查',
  { tokens: realTokens.replaceAll('--c-ink-faint:', '--c-ink-dim:') },
  {
    exit: 1,
    checked: 38, // 42 減掉算不出來的那 4 組
    missing: [
      '淺色／.faint（日期、註記）', '淺色／卡片上的 .faint',
      '深色／.faint（日期、註記）', '深色／卡片上的 .faint',
    ],
  },
);

/*
 * ── 顏色帶 alpha ──────────────────────────────────
 *
 * 第 8 輪（第十三圈）量到的：這一圈所有案例用的都是**六位不透明的 hex**，
 * 而 `hexToRgb` 原本是「三位就補齊，其他原樣切前六個字」——
 * 於是四位與八位（帶 alpha 的短寫法與長寫法）也會通過：
 *
 *   `#fffdf880`（八位、五成透明）→ alpha 被安靜丟掉，
 *      算出 16.69:1、**印綠勾、離開碼 0**
 *   `#abcd`（四位）→ 第三個色版是 NaN，印出「NaN:1」
 *
 * 半透明是模型外的東西（跟 hero 的漸層一樣），但它還會給綠燈 ——
 * 這兩條把「算不出來就明講」釘住。
 */
await check(
  '顏色帶 alpha（八位）時說「算不出對比」而不是當成不透明算',
  { tokens: withColor('--c-bg-raised', '#fffdf880', '#1d1a16') },
  {
    exit: 1,
    checked: 36, // 42 減掉用到 --c-bg-raised 的那 6 組（只有淺色那一半壞掉）
    missing: [
      '淺色／卡片上的正文', '淺色／卡片上的次要文字', '淺色／卡片上的 .faint',
      '淺色／卡片上的連結', '淺色／卡片上的焦點框', '淺色／卡片上的輸入框邊界',
    ],
  },
);

await check(
  '顏色是四位 hex 時也一樣（原本會印 NaN:1）',
  { tokens: withColor('--c-bg-raised', '#abcd', '#1d1a16') },
  {
    exit: 1,
    checked: 36,
    missing: [
      '淺色／卡片上的正文', '淺色／卡片上的次要文字', '淺色／卡片上的 .faint',
      '淺色／卡片上的連結', '淺色／卡片上的焦點框', '淺色／卡片上的輸入框邊界',
    ],
  },
);

/*
 * ── fallback 跟 light-dark() 的淺色值分岔 ──────────
 *
 * 同一個淺色值在 tokens.css 裡寫了兩次（一行單值給舊瀏覽器、一行
 * light-dark()）。分岔的話現代瀏覽器與這支腳本算出來的對比都不受影響 ——
 * 只有不支援 light-dark() 的瀏覽器會安靜地拿到過期的配色。
 * 第 8 輪（第十四圈）量過：21 個宣告全部一致，這兩條守的是「以後也一致」。
 */
await check(
  'fallback 跟 light-dark() 的淺色值分岔時會擋',
  { tokens: realTokens.replace('  --c-bg-raised: #fffdf8;', '  --c-bg-raised: #ffffff;') },
  { exit: 1, checked: 42, fallback: ['--c-bg-raised（不一致）'] },
);

await check(
  '有 light-dark() 卻沒有單值 fallback 時會擋',
  { tokens: realTokens.replace('  --c-bg-raised: #fffdf8;\n', '') },
  { exit: 1, checked: 42, fallback: ['--c-bg-raised（缺）'] },
);

/*
 * 反向：**註解裡**長得像宣告的東西不算。
 * 這一輪量 fallback 時前兩次都被註解裡提到的 light-dark() 汙染過，
 * 所以掃描前會先把註解拿掉 —— 這一格守的是那一步。
 */
await check(
  '註解裡長得像宣告的東西不算',
  {
    /*
     * 假宣告要放在**真的 fallback 之後、light-dark() 之前** ——
     * 放在前面的話會被後面那行真的蓋掉，等於沒測到（試了兩次才對）。
     */
    tokens: realTokens.replace(
      '  --c-bg-raised: light-dark(#fffdf8, #1d1a16);',
      '  /*\n  --c-bg-raised: #000000;\n  */\n  --c-bg-raised: light-dark(#fffdf8, #1d1a16);',
    ),
  },
  { exit: 0, checked: 42 },
);

/*
 * ── 宣告了卻沒有人用的 token ────────────────────────
 *
 * 第 8 輪（第十五圈）量到真的 tokens.css 有五個（`--t-2xl`、`--lh-loose`、
 * `--r-lg`、`--shadow-soft`、`--dur-slow`）。這兩格守的是那份名單會動：
 * 加一個沒人用的要看得到，接上去之後就要消失。
 *
 * 不用集合比對，因為假 repo 的 src/ 只有兩份 CSS、真的元件都不在裡面。
 */
await check(
  '沒有人用的 token 會被列出來（名字是別人的前綴也一樣）',
  {
    /*
     * `--zzz-never-used` 是 `--zzz-never-used-more` 的**前綴**，而後者有人用。
     * 拿前綴比對數用量的話（我第一次量就是這樣寫的，於是漏掉了
     * `--shadow-soft` —— 它是 `--shadow-soft-near` 的前綴），
     * 前者會被誤算成「有人用」而消失。
     */
    tokens: realTokens.replace(
      ':root {',
      ':root {\n  --zzz-never-used: 1px;\n  --zzz-never-used-more: 2px;',
    ),
    global: realGlobal + '\n.zzz-probe { width: var(--zzz-never-used-more); }\n',
  },
  { exit: 0, checked: 42, unusedHas: ['--zzz-never-used'], unusedHasNot: ['--zzz-never-used-more'] },
);
await check(
  '有人用的 token 不會被列成沒人用',
  {
    tokens: realTokens.replace(':root {', ':root {\n  --zzz-never-used: 1px;'),
    global: realGlobal + '\n.zzz-probe { width: var(--zzz-never-used); }\n',
  },
  { exit: 0, checked: 42, unusedHasNot: ['--zzz-never-used'] },
);

/*
 * 同一件事的另一半：假宣告放在**真宣告之後**。
 *
 * 上面那一格證明的其實只有 fallback 那一段會去註解 —— 因為它的假宣告
 * 在真的 light-dark() 之前，後面那行本來就會蓋掉它，`parseTokens()`
 * 有沒有去註解都一樣。第 8 輪（第十五圈）把假宣告移到後面才看出來：
 * 沒有去註解的版本會讓註解贏，42 組裡 8 組從通過變成不合格。
 */
await check(
  '註解裡長得像宣告的東西不算（放在真宣告之後也一樣）',
  {
    tokens: realTokens.replace(
      /( {2}--c-ink: light-dark\([^)]*\);\n)/,
      '$1  /*\n  --c-ink: light-dark(#faf6ee, #14120f);\n  */\n',
    ),
  },
  { exit: 0, checked: 42 },
);

/*
 * 反向：顏色值裡有逗號時，light-dark() 的兩個引數不能切錯。
 * 站上目前用的是空格分隔的 `rgb(31 28 24 / 0.04)`（裡面沒有逗號），
 * 所以配對括號那段在真實檔案上走不到 —— 這一格用逗號的寫法把它走一次。
 */
await check(
  '值裡有逗號時，light-dark() 的兩個引數還是切得對',
  {
    /*
     * 用 `--shadow-*` 而不是 `--c-*`：陰影不在 PAIRS 裡，所以對比那一段
     * 完全不受影響，這一格就只在測 fallback 的切法。
     * 站上現在用的是空格分隔的 `rgb(31 28 24 / 0.04)`（裡面沒有逗號），
     * 所以配對括號那段在真實檔案上走不到 —— 這裡用逗號的寫法走它一次。
     */
    tokens: realTokens
      .replace('  --shadow-soft-near: rgb(31 28 24 / 0.04);', '  --shadow-soft-near: rgba(31, 28, 24, 0.04);')
      .replace(
        '  --shadow-soft-near: light-dark(rgb(31 28 24 / 0.04), rgb(0 0 0 / 0.3));',
        '  --shadow-soft-near: light-dark(rgba(31, 28, 24, 0.04), rgb(0 0 0 / 0.3));',
      ),
  },
  { exit: 0, checked: 42, fallback: [] },
);

/* 反向：三位是合法的不透明短寫法，不能一起擋掉 */
await check(
  '三位 hex 是合法的短寫法，照樣算得出來',
  { tokens: withColor('--c-bg-raised', '#fff', '#111') },
  { exit: 0, checked: 42 },
);

/*
 * 有人加了一個顏色來寫字，卻沒有在 PAIRS 裡加對應的組合。
 *
 * PAIRS 是手寫的，而手寫清單不會自己長大 —— 沒有這一條的話，
 * 新加的顏色永遠不會被算對比，而這支腳本會照樣印「全部通過」。
 * 這個案例的 fixture 只壞這一件事：顏色全部合格、列印也沒問題。
 */
await check(
  '有顏色在用卻沒有任何一組在算它',
  {
    /*
     * 刻意放在 `src/components/content/` 底下 —— 那個目錄叫 content，
     * 但**不是** `src/content`（markdown 內容，該排除的是那一個）。
     * 寫這條檢查時第一版用 `e.name === 'content'` 比對，結果把整個
     * components/content 都跳過了，而那裡面真的有 `color: var(--c-moss)`。
     * 這個 fixture 把那個 bug 釘住。
     */
    extra: { 'src/components/content/Probe.astro': '<style>.zz-probe { color: var(--c-not-in-pairs); }</style>\n' },
  },
  { exit: 1, checked: 42, coverage: ['--c-not-in-pairs'] },
);

// 列印區塊只寫 :root（第 8 輪〔第三圈〕那個活了兩圈的 bug）
await check(
  '列印區塊沒覆蓋到 data-theme 時會擋（兩個選擇器都要被點名）',
  {
    global: realGlobal.replace(
      /:root,\s*\n\s*:root\[data-theme="light"\],\s*\n\s*:root\[data-theme="dark"\] \{\s*\n\s*color-scheme: light;\s*\n\s*\}/,
      ':root {\n    color-scheme: light;\n  }',
    ),
  },
  {
    exit: 1,
    checked: 42,
    /*
     * **兩個都要**。只要求「有東西缺」的話，「比對前不去掉 CSS 註解」
     * 那個突變會靜靜通過 —— 列印區塊的說明文字裡就寫著
     * `:root[data-theme="dark"]`，字串比對會配到那段註解，
     * 於是只剩 light 被報出來，而舊版看不出 1 跟 2 的差別。
     */
    printMissing: [':root[data-theme="light"]', ':root[data-theme="dark"]'],
  },
);

/*
 * ── 半透明表面 ────────────────────────────────────────
 *
 * 第 8 輪（第二十一圈）在瀏覽器裡量到的：站上的 sticky 頁首是
 * `color-mix(… var(--c-bg) 88%, transparent)`，**所有內容都從它底下捲過去**，
 * 而這支腳本把它當成不透明的 `--c-bg` 在算。
 *
 * 三格：報得出來、反向不誤報、以及**跨檔案追 class 顏色**
 * （標語的顏色來自 `.faint`，定義在 global.css，不在頁首那個檔案裡 ——
 * 第一版沒追到，那一段一句警告都沒有、看起來像沒事）。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'contrast-veil-'));
  await mkdir(join(dir, 'src/styles'), { recursive: true });
  await mkdir(join(dir, 'src/components'), { recursive: true });
  await writeFile(join(dir, 'src/styles/tokens.css'), realTokens, 'utf8');
  await writeFile(join(dir, 'src/styles/global.css'), realGlobal, 'utf8');

  /**
   * 離開碼要一起回傳。
   *
   * 第 1 輪（第二十二圈）的突變掃描抓到：只讀 stdout 的話，
   * 「報出來但不計入 failures」這個突變**靜靜通過** —— 訊息照印，
   * 而 `verify:all` 是 `a && b && c` 串起來的，exit 0 就等於過。
   * 這個檔案上面的 `check()` 早就在做這件事，這裡漏掉了。
   *
   * @param {string} body
   */
  const runIn = async (body) => {
    await writeFile(join(dir, 'src/components/Bar.astro'), body, 'utf8');
    try {
      const { stdout } = await run('node', [resolve(ROOT, 'scripts/check-contrast.mjs'), `--root=${dir}`]);
      return { out: stdout, code: 0 };
    } catch (err) {
      const e = /** @type {{ stdout?: string, code?: number }} */ (err);
      return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1 };
    }
  };

  /* 1. 半透明表面 ＋ 元件自己畫的字 */
  const { out: veil, code: veilCode } = await runIn(
    '<div class="bar"><span class="label">x</span></div>\n<style>\n' +
      '  .bar { background: color-mix(in srgb, var(--c-bg) 88%, transparent); }\n' +
      '  .label { color: var(--c-ink-faint); }\n' +
      '  .under { background: var(--c-flame); }\n' +
      '</style>\n',
  );
  const ok1 = /半透明表面（1 個）/.test(veil) && /\.bar 上的 --c-ink-faint/.test(veil);
  if (!ok1) failed++;
  console.log(`  ${ok1 ? '✓' : 'X'} 半透明表面上的字：算得出最壞情況`);
  if (!ok1) console.log('        ' + veil.split('\n').filter((l) => /半透明|⚠/.test(l)).join(' ｜ '));

  /* 2. 反向：不透明的表面不該進那份名單 */
  const { out: opaque, code: opaqueCode } = await runIn(
    '<div class="bar"><span class="label">x</span></div>\n<style>\n' +
      '  .bar { background: var(--c-bg-raised); }\n' +
      '  .label { color: var(--c-ink-faint); }\n' +
      '</style>\n',
  );
  const ok2 = /半透明表面：沒有/.test(opaque);
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} 不透明的表面不算（反向案例）`);

  /*
   * 3. 顏色定義在別的檔案裡的 class —— 這一格守的是第一版的那個洞。
   *    元件自己一行 `color:` 都沒有，字的顏色全靠 global.css 的 `.faint`。
   */
  const { out: viaClass, code: viaClassCode } = await runIn(
    '<div class="bar"><span class="faint">x</span></div>\n<style>\n' +
      '  .bar { background: color-mix(in srgb, var(--c-bg) 88%, transparent); }\n' +
      '  .under { background: var(--c-flame); }\n' +
      '</style>\n',
  );
  const ok3 = /\.bar 上的 --c-ink-faint/.test(viaClass);
  if (!ok3) failed++;
  console.log(`  ${ok3 ? '✓' : 'X'} class 的顏色定義在別的檔案裡也追得到（.faint）`);
  if (!ok3) console.log('        ' + viaClass.split('\n').filter((l) => /半透明|⚠/.test(l)).join(' ｜ '));

  /*
   * 4. color-mix() 沒有接得住的前一行 —— 不支援時整條宣告會被丟掉。
   *    這一格守的是第 1 輪（第二十二圈）量到的那個洞：
   *    `light-dark()` 有整套 fallback 紀律，`color-mix()` 兩處都沒有。
   */
  const { out: noFallback, code: noFallbackCode } = await runIn(
    '<div class="bar">x</div>\n<style>\n' +
      '  .bar { background: color-mix(in srgb, var(--c-bg) 88%, transparent); }\n' +
      '</style>\n',
  );
  /* 離開碼也要看 —— 只讀訊息的話，「報了但不計入 failures」會靜靜通過 */
  const ok4 = /color-mix\(\) 沒有接得住的前一行/.test(noFallback) && noFallbackCode === 1;
  if (!ok4) failed++;
  console.log(`  ${ok4 ? '✓' : 'X'} color-mix() 沒有 fallback：擋下來（exit ${noFallbackCode}）`);

  /* 5. 反向：前面有一行同屬性的宣告就放行 */
  const { out: withFallback, code: withFallbackCode } = await runIn(
    '<div class="bar">x</div>\n<style>\n' +
      '  .bar { background: var(--c-bg);\n' +
      '         background: color-mix(in srgb, var(--c-bg) 88%, transparent); }\n' +
      '</style>\n',
  );
  const ok5 = /每個 color-mix\(\) 前面也都有一行接得住的宣告/.test(withFallback);
  if (!ok5) failed++;
  console.log(`  ${ok5 ? '✓' : 'X'} 前面有一行同屬性的宣告：放行（反向案例）`);

  /*
   * 6. 前一行也是 color-mix 不算數 —— 兩行都會被丟掉。
   *
   * fixture 要**只有這一種違規**：第一個 color-mix 前面有真的 fallback，
   * 所以它是乾淨的；第二個的前一行是 color-mix，那才是要抓的。
   * 第一版沒有那行 fallback，於是兩個都違規 —— 而「把判斷放寬成
   * 前一行同屬性就好」的突變照樣會留下一個違規，這一格就分不出來了。
   */
  const { out: bothMix } = await runIn(
    '<div class="bar">x</div>\n<style>\n' +
      '  .bar { background: var(--c-bg);\n' +
      '         background: color-mix(in srgb, var(--c-bg) 50%, transparent);\n' +
      '         background: color-mix(in srgb, var(--c-bg) 88%, transparent); }\n' +
      '</style>\n',
  );
  const ok6 = /color-mix\(\) 沒有接得住的前一行/.test(bothMix);
  if (!ok6) failed++;
  console.log(`  ${ok6 ? '✓' : 'X'} 前一行也是 color-mix 不算接得住`);

  await rm(dir, { recursive: true, force: true });
}

/*
 * ── theme-color 與 --c-bg ─────────────────────────────
 *
 * `theme-color` 畫的是緊貼頁面上緣的那一塊（手機網址列、PWA 啟動畫面、
 * Safari 分頁列）。它寫在 `src/config/site.ts`，而這支腳本從第一天起
 * 只讀 `tokens.css` —— 所以那兩個值沒有任何檢查看過。
 *
 * 第 8 輪（第二十四圈）量到它們真的不一樣：淺色差 3/4/6 個階（對比 1:1.035）。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'contrast-theme-'));
  await mkdir(join(dir, 'src/styles'), { recursive: true });
  await mkdir(join(dir, 'src/config'), { recursive: true });
  await writeFile(join(dir, 'src/styles/tokens.css'), realTokens, 'utf8');
  await writeFile(join(dir, 'src/styles/global.css'), realGlobal, 'utf8');

  /** @param {string | null} siteBody null 代表根本沒有 site.ts */
  const runWith = async (siteBody) => {
    const at = join(dir, 'src/config/site.ts');
    if (siteBody === null) await rm(at, { force: true });
    else await writeFile(at, siteBody, 'utf8');
    try {
      const { stdout } = await run('node', [resolve(ROOT, 'scripts/check-contrast.mjs'), `--root=${dir}`]);
      return { out: stdout, code: 0 };
    } catch (err) {
      const e = /** @type {{ stdout?: string, code?: number }} */ (err);
      return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1 };
    }
  };

  const site = (/** @type {string} */ l, /** @type {string} */ d) =>
    `export const site = {\n  themeColor: { light: '${l}', dark: '${d}' },\n} as const;\n`;

  /* 1. 對得上就不報 */
  {
    const { out, code } = await runWith(site('#faf6ee', '#14120f'));
    const ok = /theme-color：兩種主題都跟 --c-bg 一致/.test(out) && code === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} theme-color 跟 --c-bg 一致就不報`);
  }

  /*
   * 2. 對不上就報，而且**離開碼要是 1**。
   *    只印不擋的話 verify:all 照樣綠 —— 這個檔案上面幾格都吃過這個虧。
   */
  {
    const { out, code } = await runWith(site('#F7F2E8', '#12110F'));
    const ok = /✗ 淺色/.test(out) && /✗ 深色/.test(out) && code === 1;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 兩種都對不上：兩行都報，而且擋得住`);
    if (!ok) console.log('        ' + out.split('\n').filter((l) => l.includes('theme-color') || l.includes('✗')).join('\n        ') + `（exit ${code}）`);
  }

  /* 3. 只有一種對不上 */
  {
    const { out, code } = await runWith(site('#faf6ee', '#000000'));
    const ok = !/✗ 淺色/.test(out) && /✗ 深色/.test(out) && code === 1;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 只有深色對不上就只報深色`);
  }

  /* 4. 大小寫不算差異 —— #FAF6EE 與 #faf6ee 是同一個顏色 */
  {
    const { out, code } = await runWith(site('#FAF6EE', '#14120F'));
    const ok = /theme-color：兩種主題都跟 --c-bg 一致/.test(out) && code === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 大小寫不同不算對不上`);
  }

  /* 5. 讀不到就說「沒有核對」，不要靜靜放行也不要誤報 */
  {
    const { out, code } = await runWith(null);
    const ok = /theme-color 沒有核對/.test(out) && code === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 沒有 site.ts 時說「沒有核對」`);
  }

  await rm(dir, { recursive: true, force: true });
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
