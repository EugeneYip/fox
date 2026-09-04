#!/usr/bin/env node
// @ts-check
/**
 * 建置管線的靜態檢查 —— `npm run check:workflows`
 *
 * 兩件事：GitHub Actions 的 workflow 檔案本身，以及跑它的 Node 版本。
 *
 * ## 為什麼需要
 *
 * 第二圈第 5 輪我在 `deploy.yml` 的同一個 step 上加了第二個 `env:` ——
 * YAML 的重複鍵。那份檔案在本機**完全沒有任何東西會檢查它**，
 * 而 GitHub 那邊很可能直接拒絕整個 workflow。
 * 也就是說：部署流程壞掉了，而且要等到真的 push 上去才會知道。
 *
 * 這個專案的三個 workflow 到現在**一次都沒有在 GitHub 上跑過**，
 * 所以「push 之後就會發現」不是一個安全的假設。
 *
 * ## 為什麼不用 YAML 剖析器
 *
 * `js-yaml` 不是這個專案的相依套件，而站主的磁碟空間很緊。
 * 這裡要抓的東西很具體（重複鍵、關卡有沒有接上、指令拼錯），
 * 用行為單位的掃描就夠了，不需要完整剖析。
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployStepsFrom, withoutComments } from './lib/deploy-steps.mjs';

/*
 * `--root=<路徑>` 只給 scripts/test-workflow-rules.mjs 用 —— 它會做一份
 * 假的專案（假 workflow + 假 package.json + 假 .nvmrc），確認每條規則
 * 真的會在該響的時候響。第 7 輪（第六圈）之前這四條規則一個案例都沒有。
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg
  ? resolve(rootArg.slice('--root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, '.github/workflows');

/** @type {{ file: string, line: number, id: string, msg: string }[]} */
const problems = [];
/**
 * 這支腳本認得的規則。
 *
 * 為什麼要有這份明列：測試需要知道「有哪幾條規則」才能檢查每條都有案例，
 * 而從原始碼用正則去抽 `add(...)` 的第三個參數會漏掉多行寫法的呼叫
 * （第 7 輪〔第六圈〕第一版就漏了兩條，還「只抽到 2 個」地通過了一半）。
 * 拿正則剖結構化資料是這個 repo 反覆踩到的坑，所以改成讓腳本自己說。
 *
 * 下面的 add() 會擋住沒登記的 id，兩邊不可能默默分岔。
 */
const RULE_IDS = [
  'duplicate-key',
  'unknown-script',
  'gate-not-on-deploy-path',
  'gate-missing-in-check',
  'needs-dist-before-build',
  'test-file-not-run',
];

if (process.argv.includes('--list-rules')) {
  console.log(RULE_IDS.join('\n'));
  process.exit(0);
}

/**
 * 每條規則這次實際判斷過幾個東西。
 *
 * 第二十一圈的問題：一條只判斷過 3 個東西的規則，跟判斷過幾百個的，
 * 綠燈的意思完全不一樣。這一支尤其值得問 ——
 * 它守的是**三份從來沒有在 GitHub 上跑過的 workflow**。
 *
 * @type {Map<string, number>}
 */
const subjects = new Map();
/** 這條規則這次看了 n 個東西（0 也要看得見） */
const saw = (/** @type {string} */ id, /** @type {number} */ n) =>
  subjects.set(id, (subjects.get(id) ?? 0) + n);

/**
 * @param {string} file
 * @param {number} line  0 表示「整份檔案」，不指向特定行
 * @param {string} id
 * @param {string} msg
 */
const add = (file, line, id, msg) => {
  if (!RULE_IDS.includes(id)) throw new Error(`規則 id "${id}" 沒有登記在 RULE_IDS 裡`);
  problems.push({ file, line, id, msg });
};

const files = (await readdir(DIR)).filter((f) => /\.ya?ml$/.test(f));

/** package.json 裡真的存在的 script 名稱 */
const scripts = new Set(
  Object.keys(JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')).scripts ?? {}),
);

for (const name of files) {
  const path = resolve(DIR, name);
  const rel = relative(ROOT, path);
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n');

  /*
   * ── 重複鍵 ──────────────────────────────────────
   *
   * 一個 mapping 裡不能有兩個一樣的鍵。用縮排追蹤區塊：
   * 縮排變深就進入新區塊、變淺就把比它深的區塊全部關掉。
   * 遇到 `- ` 開頭表示新的陣列元素，同層的鍵要重新開始算。
   */
  /** @type {Map<number, Set<string>>} */
  const keysAtIndent = new Map();
  let inBlockScalar = false;
  let blockScalarIndent = 0;

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) return;

    const indent = line.length - line.trimStart().length;

    // `run: |` 之類的區塊純量裡面是 shell，不是 YAML，整段跳過
    if (inBlockScalar) {
      if (indent > blockScalarIndent) return;
      inBlockScalar = false;
    }

    for (const [ind] of keysAtIndent) if (ind > indent) keysAtIndent.delete(ind);

    const body = line.trimStart();
    const isItem = body.startsWith('- ');
    if (isItem) for (const [ind] of keysAtIndent) if (ind >= indent) keysAtIndent.delete(ind);

    const m = body.replace(/^-\s+/, '').match(/^([A-Za-z_][\w.-]*)\s*:(\s|$)/);
    if (!m) return;
    const key = m[1];
    const effIndent = isItem ? indent + 2 : indent;

    if (/:\s*[|>][-+]?\s*$/.test(line)) {
      inBlockScalar = true;
      blockScalarIndent = effIndent;
    }

    /* 主體是「在某個縮排層看到的鍵」—— 每一個都跟同層的既有鍵比過一次 */
    saw('duplicate-key', 1);
    let set = keysAtIndent.get(effIndent);
    if (!set) keysAtIndent.set(effIndent, (set = new Set()));
    if (set.has(key)) {
      add(
        rel,
        i + 1,
        'duplicate-key',
        `同一個區塊裡出現兩個 "${key}:"。YAML 不允許，GitHub 會拒絕整份 workflow。` +
          '　改法：留一個、刪一個 —— 兩個都要的話，多半是縮排寫錯了（本來應該是不同層）。',
      );
    }
    set.add(key);
  });

  /*
   * ── run: npm run <name> 指的 script 真的存在嗎 ──
   *
   * 掃的是**抹掉註解之後**的同一份文字（行數不變，所以行號還是對的）。
   * 第 7 輪（第十六圈）的誤報探針量到：註解裡寫「以前這裡跑 npm run 舊名字」
   * 會被報成「package.json 裡沒有這個 script」—— 那是在講它，不是在跑它。
   * `run: |` 區塊裡的 shell 註解同理。
   */
  const bare = withoutComments(text).split('\n');
  for (const [idx, raw] of bare.entries()) {
    for (const m of raw.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      saw('unknown-script', 1);
      if (!scripts.has(m[1])) {
        add(
          rel,
          idx + 1,
          'unknown-script',
          `package.json 裡沒有 "${m[1]}" 這個 script。` +
            '　改法：對照 package.json 的 scripts 把名字打對；' +
            '如果那個 script 是被改名或刪掉的，這一步也要跟著改。',
        );
      }
    }
  }
}

/*
 * ── 部署路徑上該有的關卡 ────────────────────────
 *
 * 這一條守的是一個踩過兩次的坑：關卡加在 check.yml 裡，
 * 但那個 workflow 跟 deploy.yml 互相獨立 —— 紅燈擋不住部署。
 */
const deploy = await readFile(resolve(DIR, 'deploy.yml'), 'utf8').catch(() => '');
/*
 * 「這份 workflow 真的會跑哪幾個 npm script」統一走 deployStepsFrom() ——
 * 它會剝掉 YAML 註解與行尾註解，也認得區塊純量。
 *
 * 為什麼不用 `yml.includes('npm run X')`：deploy.yml 現在就有一行註解寫著
 * 「之前這裡只跑 npm run build」。用字串比對的話，**註解會被當成有跑** ——
 * 對這一條來說那是**假的綠燈**：真的把 verify:all 那一步刪掉、
 * 而註解裡還提到它，這條規則會安靜通過。
 * （第 7 輪〔第十五圈〕實測：那一行註解讓「部署路徑上會跑什麼」多算了一個
 * build —— 我自己新寫的那段就先踩到了。）
 */
const deploySteps = deployStepsFrom(deploy);
const DEPLOY_MUST_RUN = ['verify:all', 'test:units', 'test:built'];
/* deploy.yml 讀不到的話這一條是 0 —— 那才是實話 */
saw('gate-not-on-deploy-path', deploy ? DEPLOY_MUST_RUN.length : 0);
for (const required of DEPLOY_MUST_RUN) {
  if (deploy && !deploySteps.includes(required)) {
    add(
      '.github/workflows/deploy.yml',
      0,
      'gate-not-on-deploy-path',
      `deploy.yml 沒有跑 npm run ${required}。加在 check.yml 裡是不夠的 —— ` +
        '那個 workflow 紅燈不會擋住部署。' +
        `　改法：在 deploy.yml 的部署步驟之前加一步 \`run: npm run ${required}\`。`,
    );
  }
}

/*
 * ── check.yml 有沒有跟上 verify:all ────────────────
 *
 * `check.yml` 把六道關卡**逐一列成獨立的 step**，而不是跑一次 `verify:all`。
 * 那是刻意的：GitHub 的介面上看得出是哪一道紅了，而不是「verify:all ✗」。
 *
 * 代價是同一份清單存在兩個地方。加第七道關卡的時候：
 * `deploy.yml` 會自動跟上（它跑的是複合的 `verify:all`），
 * 而 `check.yml` **不會** —— 於是 push 之後看到的是一個少跑一道的綠勾。
 *
 * 第 7 輪（第七圈）實測當下兩份是一致的（六道、順序也一樣），
 * 所以這條規則加的是「以後也不會分岔」。
 */
/*
 * ── scripts/test-*.mjs 有沒有人跑 ────────────────────
 *
 * 「這個專案有哪些測試」寫在兩個地方：**檔案系統**（scripts/test-*.mjs）
 * 與 **package.json**。加一個測試檔要動兩邊，而只動一邊不會有任何徵兆 ——
 * 檔案在那裡、看起來很完整、六道關卡全綠，它只是從來沒有跑過。
 *
 * 第 7 輪（第二十四圈）數的時候是 **30 個檔案、30 個都有人跑**，沒發現問題。
 * 加這條規則不是因為現在有洞，是因為那個洞不會叫 ——
 * 同一輪之前我自己加了兩個測試檔，兩次都是靠記得去改 package.json。
 *
 * 反方向（npm script 指到不存在的檔案）也一起看：那個至少會在跑的時候爆，
 * 但爆在 CI 上比爆在這裡貴。
 */
{
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  const allScripts = Object.values(pkg.scripts ?? {}).join(' && ');
  const testFiles = (await readdir(resolve(ROOT, 'scripts')).catch(() => [])).filter((f) =>
    /^test-.*\.mjs$/.test(f),
  );
  saw('test-file-not-run', testFiles.length);
  for (const f of testFiles) {
    if (allScripts.includes('scripts/' + f)) continue;
    add(
      'scripts/' + f,
      0,
      'test-file-not-run',
      '這個測試檔沒有任何 npm script 會跑到它 —— 它存在、看起來很完整、' +
        '而六道關卡全綠，因為沒有人執行它。\n' +
        '      改法：在 package.json 加一個 script，並串進 test:units。',
    );
  }
  const referenced = [...new Set([...allScripts.matchAll(/scripts\/(test-[\w-]+\.mjs)/g)].map((m) => m[1]))];
  for (const r of referenced) {
    if (testFiles.includes(r)) continue;
    add(
      'package.json',
      0,
      'test-file-not-run',
      `有 npm script 指到 scripts/${r}，但那個檔案不存在。\n` +
        '      改法：把檔案補回來，或把那個 script 拿掉。',
    );
  }
}

{
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  const gates = String(pkg.scripts?.['verify:all'] ?? '')
    .split(' && ')
    .map((/** @type {string} */ s) => s.replace('npm run ', '').trim())
    .filter(Boolean);
  const checkYml = await readFile(resolve(DIR, 'check.yml'), 'utf8').catch(() => '');
  /*
   * ── 要求的清單從 deploy.yml 推出來，不要再寫一份 ──
   *
   * 原本這裡只比對 `verify:all` 展開的六道。第 7 輪（第十五圈）把三份
   * workflow 的清單實際列出來比對，發現 **`test:units` 與 `test:built`
   * 沒有任何規則要求 check.yml 跑**：把它們從 check.yml 拿掉，
   * PR 上就不再跑單元測試與產出測試，而三支檢查全部維持綠燈
   * （deploy.yml 仍然會跑，但那是**合併之後**才發生的事）。
   *
   * 所以清單改成從 deploy.yml 自己抽：部署路徑上會擋的每一件事，
   * PR 上都要先擋一次。`verify:all` 展開成它的六道，其餘照原樣。
   * 這樣加第七道關卡的時候不必記得回來改這裡。
   */
  const requiredInCheck = [
    ...new Set(deploySteps.flatMap((g) => (g === 'verify:all' ? gates : [g]))),
  ];
  saw('gate-missing-in-check', checkYml ? requiredInCheck.length : 0);
  if (checkYml && requiredInCheck.length > 0) {
    const ran = deployStepsFrom(checkYml);
    for (const gate of requiredInCheck) {
      if (ran.includes(gate)) continue;
      add(
        '.github/workflows/check.yml',
        0,
        'gate-missing-in-check',
        `部署路徑上會跑 npm run ${gate}，但 check.yml 沒有跑它。` +
          'check.yml 是逐一列出關卡的（為了在 GitHub 上看得出哪一道紅），' +
          '不然 PR 上看到的是一個少跑一道的綠勾，而真正擋下來會晚到合併之後。' +
          `　改法：在 check.yml 的 steps 裡加一步 \`run: npm run ${gate}\`。`,
      );
    }
  }
}

/*
 * ── Node 版本 ──────────────────────────────────────
 *
 * `engines` 寫 >=22.19.0（那是 undici 的實際需求，第一圈第 7 輪查過）。
 * 但本機跑的版本沒有任何地方會擋 —— `.npmrc` 沒有開 engine-strict，
 * 開了的話 `npm ci` 會直接失敗，對站主太粗暴。
 *
 * 所以這裡只是講出來。「works on my machine」最常見的成因就是
 * 沒有人知道 my machine 跟宣告的不一樣。
 */
const required = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')).engines?.node;
const minMatch = /(\d+)\.(\d+)\.(\d+)/.exec(required ?? '');
/** @type {string[]} */
const notes = [];
if (minMatch) {
  const min = minMatch.slice(1, 4).map(Number);
  const cur = process.versions.node.split('.').map(Number);
  const older =
    cur[0] < min[0] ||
    (cur[0] === min[0] && cur[1] < min[1]) ||
    (cur[0] === min[0] && cur[1] === min[1] && cur[2] < min[2]);
  if (older) {
    notes.push(
      `目前的 Node 是 v${process.versions.node}，低於 package.json 宣告的 ${required}。\n` +
        `      那個下限來自 undici（Astro 工具鏈的傳遞相依）。現在還能跑，但屬於「宣告與實際不一致」，\n` +
        `      CI 用 .nvmrc 的「22」會解析成最新的 22.x，所以 CI 上跟本機不是同一個版本。\n` +
        `      要對齊的話：nvm install 22.19.0 && nvm use 22.19.0`,
    );
  }
}

/*
 * ── 需要 dist/ 的檢查不能排在建置前面 ──────────────
 *
 * 第 3 輪（第四圈）把 check:content 加進 test:tools，而 deploy.yml 把
 * test:tools 排在 verify:all（含建置）**之前** —— 乾淨的 checkout 沒有 dist/，
 * 所以部署每次都會失敗。
 *
 * 而三個 workflow 到現在**沒有在 GitHub 上跑過一次**，
 * 所以那個錯要等到第一次 push 才會出現。這種「本機看不出來」的問題
 * 正是這支腳本存在的理由。
 */
const NEEDS_DIST = ['check:content', 'check:copy', 'check:a11y', 'check:perf', 'test:built'];
const BUILDS = ['build', 'verify:all'];
for (const name of files) {
  const text = await readFile(resolve(DIR, name), 'utf8');
  const rel = `.github/workflows/${name}`;
  /** 依出現順序記下每個 `npm run X` */
  /* 同樣抹掉註解 —— 註解裡提到某個需要 dist 的檢查，不代表 workflow 會跑它 */
  const scanned = withoutComments(text);
  const calls = [...scanned.matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => ({
    script: m[1],
    line: scanned.slice(0, m.index).split('\n').length,
  }));
  const firstBuild = calls.findIndex((c) => BUILDS.includes(c.script));
  for (const [i, c] of calls.entries()) {
    if (!NEEDS_DIST.includes(c.script)) continue;
    /* 主體是「需要 dist 的那些呼叫」，不是全部的 npm run */
    saw('needs-dist-before-build', 1);
    if (firstBuild !== -1 && i > firstBuild) continue;
    add(
      rel,
      c.line,
      'needs-dist-before-build',
      `\`npm run ${c.script}\` 需要 dist/，但它排在建置之前` +
        (firstBuild === -1 ? '（這個 workflow 裡根本沒有建置）' : '') +
        '。乾淨的 checkout 沒有 dist/，這一步在 CI 上一定會失敗。' +
        '　改法：把這一步移到建置之後' +
        (firstBuild === -1 ? '，而這個 workflow 還得先加一步 `run: npm run build`。' : '。'),
    );
  }
}

console.log('\n建置管線檢查\n' + '─'.repeat(56));

/*
 * ── 每條規則判斷過多少東西 ──────────────────────────
 *
 * 零的那幾條要看得見：它們的綠燈是「沒有東西可判斷」，
 * 不是「判斷過而且沒問題」。跟另外四支檢查同一個作法。
 */
for (const id of RULE_IDS) if (!subjects.has(id)) subjects.set(id, 0);
if (process.argv.includes('--verbose')) {
  console.log('\n每條規則實際判斷過的東西：');
  for (const [id, n] of [...subjects.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${id}`);
  }
}
for (const n of notes) console.log(`\n  ⚠ ${n}`);
if (problems.length === 0) {
  console.log(`\n${files.length} 份 workflow，沒有發現問題。\n`);
  process.exit(0);
}
for (const p of problems) {
  console.log(`\n  X [${p.id}] ${p.msg}`);
  console.log(`      ${p.file}${p.line ? ':' + p.line : ''}`);
}
console.log('\n' + '─'.repeat(56));
console.log(`${problems.length} 個問題。\n`);
process.exit(1);
