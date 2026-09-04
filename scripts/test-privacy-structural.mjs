#!/usr/bin/env node
// @ts-check
/**
 * 隱私稽核的**結構性檢查**實測 —— `npm run test:privacy-structural`
 *
 * `audit-privacy.mjs` 有兩種檢查：
 *
 * - **內容比對規則**（email、Google Fonts、分析工具⋯⋯）——
 *   `test-privacy-rules.mjs` 已經逐條測過
 * - **結構性檢查**（Actions 的 script injection、CSP 有沒有被拿掉或放寬、
 *   部署前有沒有關卡、個資檔有沒有被 git 追蹤⋯⋯）——
 *   **從來沒有人確認過會不會響**
 *
 * 第二種裡有這個專案最重要的一條：`private-file-tracked`。
 * 那是「她的個資有沒有被推上公開 repo」的最後一道防線，
 * 而它從加進來到現在**沒有被觸發過一次**，沒有人知道它會不會動。
 *
 * 第四圈已經對無障礙規則（22 條）、效能預算（10 條）、feed 剖析做過同樣的事。
 * 每一次都找到東西：a11y 有一條測試資料寫錯、perf 有一個崩潰。
 *
 * ## 做法
 *
 * 每個檢查建一份拋棄式的假 repo，只放那一條會踩到的東西，
 * 用 `--root=` 指過去。**不在真的專案上放違規** —— 備份還原中途失敗
 * 就把專案弄髒了，而這支腳本測的正是「個資有沒有外洩」。
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 一份「乾淨」的假 repo：有 CSP、有關卡、沒有可疑的東西 */
const CLEAN = {
  'dist/index.html':
    '<!DOCTYPE html><html lang="zh-Hant-TW"><head><meta charset="utf-8">' +
    '<meta http-equiv="content-security-policy" content="default-src \'none\'; ' +
    "script-src 'self' 'sha256-aaa'; style-src 'self' 'sha256-bbb'\">" +
    '<title>x</title></head><body><p>乾淨</p></body></html>',
  '.github/workflows/deploy.yml': [
    'name: 部署',
    'on:',
    '  push:',
    'jobs:',
    '  build:',
    '    steps:',
    '      - run: npm run verify:all',
    '      - name: 檢查 CNAME',
    '        run: test -f dist/CNAME',
  ].join('\n'),
  '.github/workflows/sync.yml': ['name: 同步', 'jobs:', '  s:', '    steps:', '      - run: npm run sync'].join('\n'),
  'src/config/privacy.ts': 'export const privacy = {};\n',
  /*
   * 假 repo 也要有 .gitignore —— 不然 `gitignore-weakened` 會在每一個
   * git fixture 上響，那幾個案例就證明不了自己那一條。
   * 內容跟真的那份同形：擋私密檔、放行 .env.example。
   */
  '.gitignore': ['.env', '.env.*', '!.env.example', 'src/config/identity.local.ts', '*.local'].join('\n') + '\n',
  /*
   * 隱私頁與實際存的鍵**對得上**的一份。
   * 少了它，`storage-*` 那條在 CLEAN 上只會說「沒有檢查」——
   * 於是「不該響的不響」就沒有人守（第 5 輪〔第十八圈〕加）。
   */
  'dist/privacy/index.html':
    '<!DOCTYPE html><html lang="zh-Hant-TW"><head>' +
    '<meta http-equiv="content-security-policy" content="default-src \'none\'">' +
    '<title>隱私</title><script>localStorage.getItem(\'fox-theme\')</script></head>' +
    '<body><p>只有 <code>fox-theme</code> 一個項目。</p></body></html>',
};

/**
 * 每個檢查一個案例：在乾淨的基底上疊上「會踩到那一條」的東西。
 * `git` 為 true 表示這個案例需要真的 git repo。
 * `check` 可以覆寫要比對的檢查 id（同一條檢查有多種觸發形式時用）。
 * `git` 是 true 或要 `git add` 的路徑。
 * @type {Record<string, { files: Record<string, string>, git?: boolean | string, check?: string, coFires?: string[] }>}
 */
const CASES = {
  /*
   * 三種寫法都要抓得到。第 5 輪（第四圈）發現原本的正則
   * 配不到 `- run:`（清單項目形式）—— 而那是很常見的寫法。
   */
  'actions-script-injection': {
    files: {
      '.github/workflows/evil.yml':
        'name: 壞的\njobs:\n  a:\n    steps:\n      - run: echo "${{ github.event.issue.title }}"\n',
    },
  },
  'actions-script-injection（block 形式）': {
    check: 'actions-script-injection',
    files: {
      '.github/workflows/evil.yml':
        'name: 壞的\njobs:\n  a:\n    steps:\n      - name: s\n        run: echo "${{ github.event.pull_request.title }}"\n',
    },
  },
  'actions-script-injection（多行 run: |）': {
    check: 'actions-script-injection',
    files: {
      '.github/workflows/evil.yml':
        'name: 壞的\njobs:\n  a:\n    steps:\n      - run: |\n          echo "${{ github.event.comment.body }}"\n',
    },
  },
  'csp-missing': {
    files: { 'dist/index.html': '<!DOCTYPE html><html lang="zh"><head><title>沒有 CSP</title></head><body>x</body></html>' },
  },
  'csp-weakened': {
    files: {
      'dist/index.html':
        '<!DOCTYPE html><html lang="zh"><head><meta http-equiv="content-security-policy" ' +
        "content=\"default-src 'none'; script-src 'self' 'unsafe-inline'\"><title>x</title></head><body>x</body></html>",
    },
  },
  'deploy-without-gates': {
    files: { '.github/workflows/deploy.yml': 'name: 部署\njobs:\n  b:\n    steps:\n      - run: npm run build\n      - run: test -f dist/CNAME\n' },
  },
  'deploy-without-cname-check': {
    files: { '.github/workflows/deploy.yml': 'name: 部署\njobs:\n  b:\n    steps:\n      - run: npm run verify:all\n' },
  },
  /*
   * ── 隱私頁點名的鍵，跟真的存的鍵 ──────────────────
   *
   * 那一頁是她對讀者的承諾（「只有兩個項目」），第 5 輪（第十八圈）之前
   * 沒有任何東西把那句話跟程式碼綁在一起。
   */
  'storage-not-documented': {
    files: {
      'dist/index.html':
        '<!DOCTYPE html><html lang="zh"><head><meta http-equiv="content-security-policy" content="default-src \'none\'">' +
        '<title>x</title><script>localStorage.setItem(\'fox-fontsize\', 2)</script></head><body>x</body></html>',
    },
  },
  /* 命名空間之外的鍵：靠 fox- 前綴看不到，所以另外抓 localStorage 呼叫的字面值 */
  'storage-not-documented（不在 fox- 命名空間裡的鍵）': {
    check: 'storage-not-documented',
    files: {
      'dist/index.html':
        '<!DOCTYPE html><html lang="zh"><head><meta http-equiv="content-security-policy" content="default-src \'none\'">' +
        '<title>x</title><script>localStorage.setItem(\'theme2\', 1)</script></head><body>x</body></html>',
    },
  },
  /* 反過來：那一頁在講一件已經不存在的事 */
  'storage-documented-not-used': {
    files: {
      'dist/privacy/index.html':
        '<!DOCTYPE html><html lang="zh"><head><meta http-equiv="content-security-policy" content="default-src \'none\'">' +
        '<title>隱私</title><script>localStorage.getItem(\'fox-theme\')</script></head>' +
        '<body><p><code>fox-theme</code> 與 <code>fox-zzz</code></p></body></html>',
    },
  },
  'built-third-party-request': {
    files: {
      'dist/index.html':
        '<!DOCTYPE html><html lang="zh"><head><meta http-equiv="content-security-policy" content="default-src \'none\'">' +
        '<title>x</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X"></head><body>x</body></html>',
    },
  },
  /*
   * 掃描目錄裡出現一個沒人認得的副檔名。
   *
   * 第 5 輪（第十圈）的實測：同一組探針放進 `public/site.webmanifest`
   * 稽核完全沒反應，放進 `public/x.json` 就報「必須修正 1」——
   * 差別只有副檔名。補一個副檔名只解決那一個檔案，這條解決下一個。
   */
  'unscanned-file-type': {
    files: { 'public/notes.toml': 'key = "value"\n' },
  },

  'possible-secret': {
    files: { 'src/config/leak.ts': "export const key = 'AKIAIOSFODNN7EXAMPLE';\n" },
  },
  /*
   * 根目錄的檔案。第 5 輪（第五圈）發現它們**完全沒有被掃過** ——
   * README.md 裡放一個信箱與一個 needle，稽核回報「乾淨」。
   * 而散文最容易寫到名字，README 又正是這個 repo 裡最多散文的地方。
   */
  'possible-secret（根目錄的檔案）': {
    check: 'possible-secret',
    files: { 'README.md': '# 專案\n\n金鑰：AKIAIOSFODNN7EXAMPLE\n' },
  },
  /*
   * csp-weakened 有兩個觸發條件，原本只測了 script-src 那個。
   * 這個是 default-src 不是 'none' 的情況。
   */
  "csp-weakened（default-src 不是 'none'）": {
    check: 'csp-weakened',
    files: {
      'dist/index.html':
        '<!DOCTYPE html><html lang="zh"><head><meta http-equiv="content-security-policy" ' +
        "content=\"default-src *; script-src 'self' 'sha256-aaa'\"><title>x</title></head><body>x</body></html>",
    },
  },
  /*
   * private-file-tracked 也查 .env（不只 identity.local.ts）。
   * `.env` 進版控等於把所有金鑰推上去。
   */
  'private-file-tracked（.env）': {
    check: 'private-file-tracked',
    git: '.env',
    files: { '.env': 'YOUTUBE_API_KEY=AIzaSyFakeKeyForTesting1234567890abcd\n' },
  },
  /*
   * ── commit 過、後來清掉：現在乾淨，歷史裡有 ──
   *
   * `private-file-tracked` 問的是 `git ls-files`，也就是**現在的索引**。
   * 一個檔案 commit 過、後來 `git rm --cached` 再加進 .gitignore，
   * 那一項會完全安靜 —— 而內容永遠留在公開 repo 的歷史裡。
   *
   * 第 5 輪（第二十六圈）問「壞了誰會告訴我們」：這一項本來沒有人會說，
   * 而且它是**不可逆的**（推上去之後，改寫歷史只能防未來）。
   */
  'private-file-in-history': {
    check: 'private-file-in-history',
    git: 'history:.env',
    files: { '.env': 'YOUTUBE_API_KEY=AIzaSyFakeKeyForTesting1234567890abcd\n' },
    coFires: ['possible-secret'],
  },

  /*
   * ── .gitignore 自己被改弱 ──
   *
   * 這是「個資外洩」的**事前**那一道，而它到第 5 輪（第十五圈）之前
   * 沒有任何檢查在看。案例把 identity 那一行拿掉，其他照舊 ——
   * 檔案本身不存在、也沒有被追蹤，所以只有這一條該響。
   */
  /*
   * ── 沒有人讀的開關 ──
   *
   * `showGhost` 宣告了、沒有人讀、也不在 UNWIRED_SWITCHES 裡 ——
   * 它看起來像閘門，實際上改了不會有任何效果。
   * （UNWIRED 名單刻意放一個別的名字，好讓「名單抽得到」這件事成立。）
   */
  'privacy-switch-unused': {
    files: {
      'src/config/privacy.ts':
        'interface PrivacyConfig {\n  showGhost: boolean;\n  showReal: boolean;\n}\n' +
        "export const UNWIRED_SWITCHES: readonly (keyof PrivacyConfig)[] = ['showReal'];\n",
    },
  },
  /*
   * 反過來：名單說「沒接到」，實際上有人讀。過期的註記比沒有註記危險。
   */
  'privacy-switch-stale-note': {
    files: {
      'src/config/privacy.ts':
        'interface PrivacyConfig {\n  showGhost: boolean;\n}\n' +
        "export const UNWIRED_SWITCHES: readonly (keyof PrivacyConfig)[] = ['showGhost'];\n",
      'src/pages/x.astro': 'const on = privacy.showGhost;\n',
    },
  },
  'gitignore-weakened': {
    git: 'init-only',
    files: { '.gitignore': ['.env', '.env.*', '!.env.example', '*.local'].join('\n') + '\n' },
  },
  /*
   * 第二個案例拿掉的是 **.env 那一段**，identity 那一行還在。
   * 少了它，「只檢查 identity 一個路徑」的寫法會照樣通過 ——
   * 突變掃描實際上就是這樣靜靜通過的。
   */
  'gitignore-weakened（.env 那一段被拿掉）': {
    check: 'gitignore-weakened',
    git: 'init-only',
    files: { '.gitignore': ['src/config/identity.local.ts', '*.local'].join('\n') + '\n' },
  },
  /*
   * `.env.local` —— .gitignore 用 `.env.*` 擋著它，而第 5 輪（第十五圈）
   * 之前這項檢查只問 `.env` 與 identity 兩個字面路徑，
   * 所以這種檔案被追蹤了也不會有人說話。
   */
  'private-file-tracked（.env.local）': {
    check: 'private-file-tracked',
    git: '.env.local',
    files: { '.env.local': 'YOUTUBE_API_KEY=AIzaSyFakeKeyForTesting1234567890abcd\n' },
  },
  'private-file-tracked': {
    git: true,
    files: { 'src/config/identity.local.ts': "export const identity = { realName: { zh: '假名' } };\n" },
  },
};

let failed = 0;
console.log('\n隱私稽核的結構性檢查實測');
console.log('─'.repeat(64));

// 乾淨的基底不該報任何 error
{
  const dir = await build({});
  const { out } = await audit(dir);
  const ok = !out.includes('必須修正（');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 乾淨的假 repo 不誤報`);
  if (!ok) console.log(out.split('\n').filter((l) => l.includes('✗')).slice(0, 4).map((l) => '      ' + l).join('\n'));
  await rm(dir, { recursive: true, force: true });
}

for (const [label, { files, git, check, coFires }] of Object.entries(CASES)) {
  const dir = await build(files, git);
  const { out } = await audit(dir);
  const fired = out.includes(`[${check ?? label}]`);
  if (!fired) failed++;
  console.log(`  ${fired ? '✓' : 'X'} ${label}`);
  /*
   * 順帶觸發到別條要先宣告（`coFires`），沒宣告就算失敗。
   *
   * 第 5 輪（第九圈）量過：這支測試的 14 個案例**每一個都只響自己那條**，
   * 所以這裡加的是「以後也維持這樣」。
   * （a11y 那支量出來是 25／27 有連帶，perf 是 4／13 —— 這支本來就是乾淨的。）
   */
  const allIds = [...new Set([...out.matchAll(/\[([a-z-]+)\]/g)].map((m) => m[1]))];
  const undeclared = allIds.filter((x) => x !== (check ?? label) && !(coFires ?? []).includes(x));
  if (undeclared.length > 0) {
    failed++;
    console.log(`      這個 fixture 還順帶觸發了沒宣告的規則：${undeclared.join('、')}`);
    console.log('      同時響好幾條的案例證明不了是哪一條讓它綠的。');
  }
  if (!fired) {
    const found = [...out.matchAll(/\[([a-z-]+)\]/g)].map((m) => m[1]);
    console.log(`      實際觸發的是：${[...new Set(found)].join('、') || '（一條都沒有）'}`);
  }
  await rm(dir, { recursive: true, force: true });
}

/*
 * 反向案例：`secrets.*` 是 GitHub 注入的，不是外部可控的值，
 * 不該被當成注入風險。少了這個斷言，「把規則放寬到全部不報」也會通過。
 */
{
  const dir = await build({
    '.github/workflows/ok.yml':
      'name: 好的\njobs:\n  a:\n    steps:\n      - run: echo "${{ secrets.TOKEN }}"\n',
  });
  const { out } = await audit(dir);
  const quiet = !out.includes('[actions-script-injection]');
  if (!quiet) failed++;
  console.log(`  ${quiet ? '✓' : 'X'} secrets.* 不算注入風險（反向案例）`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * 反向案例：`.env.example` 是**範本**，本來就該進版控
 * （.gitignore 也用 `!` 放行它）。`private-file-tracked` 的 pathspec 
 * 若少了 `:!.env.example`，這一份就會被誤報成個資外洩。
 */
{
  const dir = await build({ '.env.example': 'YOUTUBE_API_KEY=\n' }, '.env.example');
  const { out } = await audit(dir);
  const quiet = !out.includes('[private-file-tracked]');
  if (!quiet) failed++;
  console.log(`  ${quiet ? '✓' : 'X'} .env.example 進版控不算外洩（反向案例）`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 一個錯誤出現在很多頁時，報告要收得住 ──────────
 *
 * 第 5 輪（第十九圈）在 634 頁下量到：頁尾放一張第三方圖片，
 * 這支腳本印 600 筆、2418 行，而共用元件在每一頁都出現 ——
 * **掃產出的規則天生會乘上頁數**。三格一起：要收、總數要照實說、
 * `--verbose` 要全印。
 */
{
  /** @type {Record<string, string>} */
  const files = { 'dist/index.html': CLEAN['dist/index.html'] };
  const bad =
    '<!DOCTYPE html><html lang="zh"><head>' +
    '<meta http-equiv="content-security-policy" content="default-src \'none\'">' +
    '<title>x</title></head><body><img src="https://i.imgur.com/x.png" alt=""></body></html>';
  for (let i = 0; i < 8; i++) files[`dist/p${i}/index.html`] = bad;
  const dir = await build(files);
  const { out } = await audit(dir);
  const headers = (out.match(/\n  ✗ dist\/p\d+\/index\.html:\d+  \[built-third-party-request\]/g) ?? []).length;
  const ok =
    headers === 1 &&
    out.includes('…另外 5 個地方') &&
    out.includes('必須修正 8');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 同一件事出現在 8 頁：只列 3 個地方，總數照實說`);
  if (!ok) console.log(`      實際：標題 ${headers} 個、收合 ${out.includes('…另外 5 個地方')}、總數 ${out.includes('必須修正 8')}`);

  const verbose = await audit(dir, {}, ['--verbose']);
  const vOk =
    (verbose.out.match(/dist\/p\d+\/index\.html:\d+/g) ?? []).length === 8 &&
    !verbose.out.includes('…另外');
  if (!vOk) failed++;
  console.log(`  ${vOk ? '✓' : 'X'} --verbose 把 8 個地方都印出來`);
  await rm(dir, { recursive: true, force: true });

  /* 反向：只有 2 個地方時不要多說那一行 */
  const few = { 'dist/index.html': CLEAN['dist/index.html'], 'dist/a/index.html': bad, 'dist/b/index.html': bad };
  const dir2 = await build(few);
  const { out: out2 } = await audit(dir2);
  const fewOk = !out2.includes('…另外') && out2.includes('必須修正 2');
  if (!fewOk) failed++;
  console.log(`  ${fewOk ? '✓' : 'X'} 只有 2 個地方時不印「另外 N 個」（反向案例）`);
  await rm(dir2, { recursive: true, force: true });
}

/*
 * ── identity.local.ts 的值抽得出來嗎 ──────────────
 *
 * 第 5 輪（第二十圈）第一次真的建了那個檔案再看抽出來的東西，
 * 發現五個敏感鍵裡有兩個**從來沒有作用過**（`realName`、`city`）——
 * 它們在檔案裡是巢狀的 `key: { zh: '…', en: '…' }`，
 * 而樣式要求冒號後面直接是引號。其中一個是**本名**。
 *
 * 三格：巢狀的抽得到、範本值不當 needle、全部都是範本值時說「沒有執行」。
 */
{
  const { readIdentityNeedles } = await import(resolve(ROOT, 'scripts/lib/identity-needles.mjs'));

  const exampleText =
    "export const identity = {\n" +
    "  realName: { zh: '範本名', en: 'Example Name' },\n" +
    "  education: { zh: { school: '範本大學', dept: '範本系' } },\n" +
    "  location: { city: { zh: '範本市', en: 'Exampleville' } },\n" +
    "  email: 'x@example.com',\n" +
    '};\n';

  const mk = async (/** @type {string} */ local) => {
    const dir = await mkdtemp(join(tmpdir(), 'needles-'));
    await mkdir(join(dir, 'src', 'config'), { recursive: true });
    await writeFile(join(dir, 'src', 'config', 'identity.local.example.ts'), exampleText, 'utf8');
    await writeFile(join(dir, 'src', 'config', 'identity.local.ts'), local, 'utf8');
    return dir;
  };

  const filled = await mk(
    "export const identity = {\n" +
      "  realName: { zh: '真的名字', en: 'Real Name' },\n" +
      "  location: { city: { zh: '真的城市' } },\n" +
      '};\n',
  );
  const r1 = readIdentityNeedles(filled);
  const ok1 = r1.needles.includes('真的名字') && r1.needles.includes('真的城市');
  if (!ok1) failed++;
  console.log(`  ${ok1 ? '✓' : 'X'} 巢狀的 realName／city 抽得到（本名不能是抽不到的那一個）`);
  if (!ok1) console.log('      實際：', JSON.stringify(r1.needles));
  await rm(filled, { recursive: true, force: true });

  const mixed = await mk(
    "export const identity = {\n" +
      "  realName: { zh: '真的名字', en: 'Example Name' },\n" +
      "  email: 'x@example.com',\n" +
      '};\n',
  );
  const r2 = readIdentityNeedles(mixed);
  const ok2 =
    r2.needles.includes('真的名字') &&
    !r2.needles.includes('Example Name') &&
    !r2.needles.includes('x@example.com');
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} 還沒改的範本值不當成 needle（不然會去撞範本檔與測試）`);
  if (!ok2) console.log('      實際：', JSON.stringify(r2.needles));
  await rm(mixed, { recursive: true, force: true });

  const untouched = await mk(exampleText);
  const r3 = readIdentityNeedles(untouched);
  const ok3 = r3.source === 'none' && r3.detail.includes('還是範本的值');
  if (!ok3) failed++;
  console.log(`  ${ok3 ? '✓' : 'X'} 整份都是範本值：說「沒有執行」而不是報一堆錯`);
  if (!ok3) console.log('      實際：', r3.source, r3.detail);
  await rm(untouched, { recursive: true, force: true });
}

/*
 * 反向案例：隱私頁上抽不到鍵名的時候要說「沒有檢查」，
 * 而不是把站上真的在用的每一個鍵都報成「沒有寫在隱私頁上」。
 *
 * 少了這一格，把 `documented.size === 0` 那道自我檢查拿掉會**靜靜通過**，
 * 而它壞掉的方式正好是「印出一份反過來的名單」。
 */
{
  const dir = await build({
    'dist/privacy/index.html':
      '<!DOCTYPE html><html lang="zh"><head><meta http-equiv="content-security-policy" content="default-src \'none\'">' +
      '<title>隱私</title><script>localStorage.getItem(\'fox-theme\')</script></head>' +
      '<body><p>鍵名沒有包成 code</p></body></html>',
  });
  const { out } = await audit(dir);
  const ok = out.includes('瀏覽器儲存的檢查沒有執行') && !out.includes('[storage-');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 隱私頁抽不到鍵名時說「沒有檢查」（反向案例）`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * 反向案例：抽不到 UNWIRED_SWITCHES 的時候要說「沒有檢查」，
 * 而不是把每一個沒人讀的開關都報成違規。
 *
 * 少了這一格，把自我檢查拿掉會**靜靜通過** —— 突變掃描就是這樣漏掉的。
 */
{
  const dir = await build({
    'src/config/privacy.ts': 'interface PrivacyConfig {\n  showGhost: boolean;\n}\n',
  });
  const { out } = await audit(dir);
  const ok = out.includes('隱私開關沒有檢查') && !out.includes('[privacy-switch-unused]');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 抽不到 UNWIRED_SWITCHES 時說「沒有檢查」（反向案例）`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 一個檔案都沒掃到，不能說「乾淨」──────────────────
 *
 * 第 5 輪（第二十五圈）拿一個空目錄當 root 跑一次：六項印了「沒有檢查」，
 * 然後結尾是「乾淨。沒有硬編碼的個資，也沒有第三方資源。」＋ exit 0。
 *
 * 那些「沒有檢查」是這支腳本最好的習慣。但**判決那一行推翻了它們** ——
 * 什麼都沒看過，卻宣告沒有個資外洩。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'privacy-empty-'));
  const { out, code } = await audit(dir);
  const ok = /一個檔案都沒掃到/.test(out) && !/^乾淨。/m.test(out) && code === 1;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 一個檔案都沒掃到：不說「乾淨」，而且擋得住`);
  if (!ok) console.log('        ' + out.split('\n').filter(Boolean).slice(-4).join('\n        ') + `（exit ${code}）`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 有東西沒查到的時候，「乾淨」要說清楚範圍 ──────────
 *
 * 乾淨的 fixture 一定會有幾項「沒有檢查」（沒有 identity.local.ts、
 * 沒有 PRIVACY_NEEDLES）。不把它們算進判決的話，那個結尾跟
 * 「全部查過而且乾淨」一模一樣。
 *
 * **不因此擋下來** —— 本機沒有個資檔是常態。
 */
{
  const dir = await build(CLEAN);
  const { out, code } = await audit(dir);
  const ok = /^乾淨。/m.test(out) && /這次沒有檢查/.test(out) && code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 乾淨但有項目沒查到：說出範圍，但不擋`);
  if (!ok) console.log('        ' + out.split('\n').filter(Boolean).slice(-4).join('\n        ') + `（exit ${code}）`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 開關一覽（docs/PRIVACY.md）跟程式說的一樣嗎 ──
 *
 * 第 5 輪（第二十四圈）量到：文件的「影響」欄把四個刻意沒接的開關寫得
 * 像有作用（`showBirthday` 寫「生日」、`stripImageExif` 寫
 * 「`npm run clean-images` 會清掉圖片的 GPS 等資訊」）。
 *
 * `privacy.ts` 的註解寫得很清楚，但要決定「這個開關該開還是關」的人
 * 讀的是那張表。隱私上特別貴：看起來像閘門、實際上不是。
 */
const PRIVACY_TS = (/** @type {string[]} */ unwired, /** @type {string} */ extra = '') =>
  'interface PrivacyConfig {\n  showGhost: boolean;\n  showReal: boolean;\n}\n' +
  `export const UNWIRED_SWITCHES = [${unwired.map((/** @type {string} */ k) => `'${k}'`).join(', ')}];\n` +
  'export const privacy = { showGhost: false, showReal: false };\n' +
  extra;

/** 表格那一列 —— `mark` 給 true 就加上「沒有接上」的記號 */
const row = (/** @type {string} */ key, /** @type {boolean} */ mark) =>
  `| \`${key}\` | \`false\` | ${mark ? '⚠ 這個開關沒有接上 —— 改它不會有效果' : '會做某件事'} |`;

{
  /* 宣告成沒接，文件卻寫得像有作用 */
  const dir = await build({
    'src/config/privacy.ts': PRIVACY_TS(['showGhost']),
    'src/pages/x.astro': '<p>{privacy.showReal}</p>\n',
    'docs/PRIVACY.md': ['# 隱私', '', row('showGhost', false), row('showReal', false)].join('\n'),
  });
  const { out } = await audit(dir);
  const ok = out.includes('[privacy-doc-unwired]') && out.includes('showGhost');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 沒接的開關，文件寫得像有作用`);
  if (!ok) console.log(out.split('\n').map((l) => '        ' + l).join('\n'));
  await rm(dir, { recursive: true, force: true });
}

{
  /*
   * 反過來：文件說「沒有接上」，而它其實有人讀。
   * 過期的警告比沒有警告危險 —— 有人會照著它以為改了沒差。
   */
  const dir = await build({
    'src/config/privacy.ts': PRIVACY_TS(['showGhost']),
    'src/pages/x.astro': '<p>{privacy.showReal}</p>\n',
    'docs/PRIVACY.md': ['# 隱私', '', row('showGhost', true), row('showReal', true)].join('\n'),
  });
  const { out } = await audit(dir);
  const ok = out.includes('[privacy-doc-unwired]') && out.includes('showReal');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 文件說沒接，實際有人讀（反向案例）`);
  if (!ok) console.log(out.split('\n').map((l) => '        ' + l).join('\n'));
  await rm(dir, { recursive: true, force: true });
}

{
  /* 兩邊一致就不該響 */
  const dir = await build({
    'src/config/privacy.ts': PRIVACY_TS(['showGhost']),
    'src/pages/x.astro': '<p>{privacy.showReal}</p>\n',
    'docs/PRIVACY.md': ['# 隱私', '', row('showGhost', true), row('showReal', false)].join('\n'),
  });
  const { out } = await audit(dir);
  const ok = !out.includes('[privacy-doc-unwired]');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 兩邊一致就不報`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 爬蟲數量：文件寫的數字 vs robots.txt.ts 的清單 ──
 *
 * 判準刻意不綁句型 —— 抓那一列裡**所有**數字，必須剛好等於
 * {擋幾個, 放行幾個}。第一版要求特定寫法，拿真的漂移過的文件一跑，
 * 它說的是「找不到這種寫法」，也就是抓不到。
 */
const ROBOTS = (/** @type {number} */ t, /** @type {number} */ r) =>
  `const TRAINING_CRAWLERS = [${Array.from({ length: t }, (_, i) => `'T${i}'`).join(', ')}];\n` +
  `const RETRIEVAL_CRAWLERS = [${Array.from({ length: r }, (_, i) => `'R${i}'`).join(', ')}];\n`;

const crawlerRow = (/** @type {string} */ text) => `| \`allowAiCrawlers\` | \`false\` | ${text} |`;

{
  const dir = await build({
    'src/config/privacy.ts': PRIVACY_TS([]),
    'src/pages/robots.txt.ts': ROBOTS(13, 5),
    'docs/PRIVACY.md': ['# 隱私', '', crawlerRow('擋掉 17 種')].join('\n'),
  });
  const { out } = await audit(dir);
  const ok = out.includes('[privacy-doc-crawler-count]');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 文件的爬蟲數字過期`);
  if (!ok) console.log(out.split('\n').map((l) => '        ' + l).join('\n'));
  await rm(dir, { recursive: true, force: true });
}

{
  /* 換一種寫法但數字對 —— 不該響（判準不綁句型） */
  const dir = await build({
    'src/config/privacy.ts': PRIVACY_TS([]),
    'src/pages/robots.txt.ts': ROBOTS(13, 5),
    'docs/PRIVACY.md': ['# 隱私', '', crawlerRow('放行 5 種檢索爬蟲，其餘 13 種訓練爬蟲擋掉')].join('\n'),
  });
  const { out } = await audit(dir);
  const ok = !out.includes('[privacy-doc-crawler-count]');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 數字對就不報，句子怎麼寫都行`);
  if (!ok) console.log(out.split('\n').map((l) => '        ' + l).join('\n'));
  await rm(dir, { recursive: true, force: true });
}

{
  /* 那一列沒寫數字 —— 沒有第二份說法，就沒有東西會不一致 */
  const dir = await build({
    'src/config/privacy.ts': PRIVACY_TS([]),
    'src/pages/robots.txt.ts': ROBOTS(13, 5),
    'docs/PRIVACY.md': ['# 隱私', '', crawlerRow('擋掉訓練爬蟲，放行檢索爬蟲')].join('\n'),
  });
  const { out } = await audit(dir);
  const ok = !out.includes('[privacy-doc-crawler-count]') && out.includes('沒有寫數字');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 沒寫數字就說「沒有東西需要核對」`);
  if (!ok) console.log(out.split('\n').map((l) => '        ' + l).join('\n'));
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 文件在講「不要用第三方資源」時，不該被自己的稽核擋 ──
 *
 * 第 5 輪（第十六圈）的誤報探針量到：`google-fonts`、`analytics`、
 * `third-party-cdn` 三條都會在**散文檔**上響 —— 也就是說，
 * 這個 repo 只要在文件裡寫出「不要用 fonts.googleapis.com」這句話，
 * 自己的稽核就紅燈。（`docs/PRIVACY.md` 早就在豁免清單裡，
 * 所以這件事一直被那份豁免蓋著，換一份文件就現形。）
 *
 * `.md` 不會被瀏覽器載入，寫在裡面的網域只是在講它。
 * 真的載入了由 `built-third-party-request` 掃 dist/ 抓 —— 下面第二格就是。
 */
{
  const dir = await build({
    'docs/ARCHITECTURE.md':
      '# 架構\n\n零第三方請求：不載入 fonts.googleapis.com 的字型，也沒有 google-analytics.com，' +
      '更不從 cdn.jsdelivr.net 取檔案。\n',
  });
  const { out } = await audit(dir);
  const quiet = !/\[(google-fonts|analytics|third-party-cdn)\]/.test(out);
  if (!quiet) failed++;
  console.log(`  ${quiet ? '✓' : 'X'} 文件講到那幾個網域時不算違規（反向案例）`);
  if (!quiet) {
    console.log(out.split('\n').filter((l) => l.includes('[')).slice(0, 3).map((l) => '        ' + l).join('\n'));
  }
  await rm(dir, { recursive: true, force: true });
}
{
  /* 反向的另一半：**原始碼**裡真的載入就要抓（散文的豁免不能溢出去） */
  const dir = await build({
    'src/layouts/Bad.astro': '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">\n',
  });
  const { out } = await audit(dir);
  const fired = out.includes('[google-fonts]');
  if (!fired) failed++;
  console.log(`  ${fired ? '✓' : 'X'} 原始碼裡真的載入 Google Fonts 照樣抓`);
  await rm(dir, { recursive: true, force: true });
}
{
  /* public/ 底下的 .md 會被送出去，不算散文 */
  const dir = await build({ 'public/note.md': '看看 https://fonts.googleapis.com/css2?family=X\n' });
  const { out } = await audit(dir);
  const fired = out.includes('[google-fonts]');
  if (!fired) failed++;
  console.log(`  ${fired ? '✓' : 'X'} public/ 底下的 .md 不算散文`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 結構性檢查也要說得出「改法：」──────────────────────
 *
 * 第 5 輪（第十七圈）量到：樣式規則那七條補完之後，結構性這一側還有四條
 * 只講事實 —— `csp-missing`、兩處 `csp-weakened`、`deploy-without-cname-check`。
 * 判準跟 `test:privacy-rules`、`test:a11y-rules`、`test:content-rules` 一樣，
 * 用「改法：」當標記；那是慣例不是規範。
 *
 * 這裡不逐條跑 fixture（太慢），直接讀原始碼裡每個 `id:` 區塊 ——
 * 跟 `test-content-rules` 守同一件事的做法一致。
 */
{
  const src = await readFile(resolve(ROOT, 'scripts/audit-privacy.mjs'), 'utf8');
  /** 這幾條的「事實本身就是改法」，或者訊息裡沒有 why 欄位 */
  const NO_HINT_NEEDED = new Set(['privacy-switch-unused', 'privacy-switch-stale-note']);
  const missing = [];
  for (const m of src.matchAll(/id: '([a-z-]+)'/g)) {
    const id = m[1];
    if (NO_HINT_NEEDED.has(id)) continue;
    const block = src.slice(m.index, src.indexOf('},', m.index));
    /* 有 why 的才要求；沒有 why 的那幾條訊息寫在 msg 裡，另有守法 */
    if (block.includes('why:') && !block.includes('改法：')) missing.push(id);
  }
  const ok = missing.length === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 結構性檢查的訊息都講了「改法：」`);
  if (!ok) {
    console.log(`      沒講的：${missing.join('、')}`);
    console.log('      站主看到的是一句事實，不知道下一步要做什麼。');
  }
}

/*
 * ── 身分規則與豁免清單的互動 ────────────────────────
 *
 * 這是這個專案最不能失守的一條，而第 5 輪（第八圈）的突變掃描發現
 * **它一條測試都沒有**：把「豁免不套用到身分規則」那個例外拿掉、
 * 或把 identity-value 整條略過，`test-privacy-structural` 照樣全綠。
 *
 * 而那正是第 5 輪（第二圈）找到並修好的 bug ——
 * 稽核腳本自己在 ALLOWLIST 裡，於是「唯一含有個資的檔案剛好豁免於
 * 自己的檢查」。**沒有測試的話，那個 bug 回來也不會有人知道。**
 *
 * 原因也很清楚：上面那些案例跑 audit 時把 PRIVACY_NEEDLES 清空了
 * （那是刻意的，不然每個案例都要處理身分規則），所以身分規則從來沒跑過。
 * 這裡明確帶著 needles 跑。
 *
 * 三個方向都要驗：
 *   - 豁免清單裡的檔案含個資 → **要抓**（豁免對身分規則無效）
 *   - identity.local.ts 含個資 → **不抓**（值本來就住在那裡）
 *   - 一般檔案含個資 → 要抓
 */
{
  const NEEDLE = '假的真名QQZ';
  const withNeedle = { PRIVACY_NEEDLES: NEEDLE };

  const inAllowlisted = await audit(
    await build({ 'src/config/privacy.ts': `// ${NEEDLE}\nexport const privacy = {};\n` }),
    withNeedle,
  );
  const ok1 = inAllowlisted.out.includes('[identity-value]');
  if (!ok1) failed++;
  console.log(`  ${ok1 ? '✓' : 'X'} 豁免清單裡的檔案含個資：仍然要抓`);

  const inHome = await audit(
    await build({ 'src/config/identity.local.ts': `export const identity = { realName: { zh: '${NEEDLE}' } };\n` }),
    withNeedle,
  );
  const ok2 = !inHome.out.includes('[identity-value]');
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} identity.local.ts 含個資：不該抓（值本來就住在那裡）`);

  const inNormal = await audit(
    await build({ 'src/pages/about.astro': `<p>${NEEDLE}</p>\n` }),
    withNeedle,
  );
  const ok3 = inNormal.out.includes('[identity-value]');
  if (!ok3) failed++;
  console.log(`  ${ok3 ? '✓' : 'X'} 一般檔案含個資：要抓`);
}

/*
 * ── 「查不了」在 CI 上要是紅燈 ──────────────────────
 *
 * 第 5 輪（第三圈）已經對 `check:history` 做過這個判斷：查不了的時候
 * 回 exit 0 是假的綠燈。`audit-privacy` 當時漏掉了，第 5 輪（第七圈）補上。
 *
 * 三個方向都要驗，少了任何一個都可能「用錯的理由通過」：
 * 只驗 CI 會擋，把它改成「永遠擋」也會過；只驗本機不擋，
 * 把 CI 那段刪掉也會過。
 */
{
  const dir = await build({});

  const ci = await audit(dir, { CI: 'true' });
  const okCi = ci.code === 1 && /不是「乾淨」，是「沒有檢查」/.test(ci.out);
  if (!okCi) failed++;
  console.log(`  ${okCi ? '✓' : 'X'} CI 上沒有 PRIVACY_NEEDLES：exit 1`);

  const ciWith = await audit(dir, { CI: 'true', PRIVACY_NEEDLES: '某個假名' });
  const okWith = ciWith.code === 0;
  if (!okWith) failed++;
  console.log(`  ${okWith ? '✓' : 'X'} CI 上有 PRIVACY_NEEDLES：exit 0`);

  const local = await audit(dir, {});
  const okLocal = local.code === 0 && /身分規則沒有執行/.test(local.out);
  if (!okLocal) failed++;
  console.log(`  ${okLocal ? '✓' : 'X'} 本機沒有 needles：只警告，不擋人`);

  await rm(dir, { recursive: true, force: true });
}

/*
 * ── reveal() 的鍵有沒有人畫出來 ────────────────────────
 *
 * 第 5 輪（第二十三圈）走「填了 identity.local.ts → 開開關 → 站上看得到」
 * 那條路時量到：四個值裡有三個照著開關出現與消失，**email 不管怎麼開都不出現**
 * —— 因為沒有任何頁面呼叫 `reveal('email')`。
 *
 * 而 `privacy-switch-unused` 不會響：它問的是「有沒有人讀這個開關」，
 * 而 `privacy.ts` 自己就讀了。鏈子是「開關 → reveal() → 沒有人」。
 */
{
  const noConsumer = await build({
    'src/config/privacy.ts':
      'interface PrivacyConfig {\n  showThing: boolean;\n}\n' +
      "export const UNWIRED_SWITCHES: readonly (keyof PrivacyConfig)[] = [];\n" +
      "function reveal(key) {\n  switch (key) {\n    case 'thing':\n      return 1;\n  }\n}\n",
    'src/pages/about.astro': '<p>沒有人呼叫 reveal</p>\n',
  });
  const out = await audit(noConsumer);
  const okCatch = /reveal-key-unused/.test(out.out);
  if (!okCatch) failed++;
  console.log(`  ${okCatch ? '✓' : 'X'} reveal() 的鍵沒有人畫出來：說出來`);
  if (!okCatch) console.log('        ' + out.out.split('\n').filter((l) => /reveal|請確認/.test(l)).join(' ｜ '));

  /* 反向：有人呼叫就放行。少了這格，把判斷改成「一律報」也會通過上面那格 */
  const withConsumer = await build({
    'src/config/privacy.ts':
      'interface PrivacyConfig {\n  showThing: boolean;\n}\n' +
      "export const UNWIRED_SWITCHES: readonly (keyof PrivacyConfig)[] = [];\n" +
      "function reveal(key) {\n  switch (key) {\n    case 'thing':\n      return 1;\n  }\n}\n",
    'src/pages/about.astro': "const v = reveal('thing');\n",
  });
  const out2 = await audit(withConsumer);
  const okQuiet = !/reveal-key-unused/.test(out2.out);
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} 有人呼叫就放行（反向案例）`);
}

/*
 * ── 擋住個資的那條規則，是 repo 的還是這台機器的 ────────
 *
 * `git check-ignore` 會把**個人設定**也算進去（`~/.config/git/ignore`、
 * `core.excludesFile`、`.git/info/exclude`）—— 那幾個都不會進版控。
 *
 * 第 5 輪（第二十二圈）實測：`.gitignore` 裡完全沒有那三行、
 * 但個人的 excludesFile 有的時候，這支稽核**報 0 個錯**。
 * 而別人 clone 下來（CI、她的電腦）那裡沒有那份設定，
 * 下一次 `git add .` 就把含本名的檔案加進公開 repo。
 *
 * 這是這個 repo 最重要的一道防線，所以正反兩面都要有案例。
 */
{
  const personal = await build(
    { '.gitignore': 'node_modules\ndist\n' },
    'personal:.env,.env.local,src/config/identity.local.ts',
  );
  const out = await audit(personal);
  const okCatch = /沒有進版控的忽略檔/.test(out.out) && out.code === 1;
  if (!okCatch) failed++;
  console.log(`  ${okCatch ? '✓' : 'X'} 只有個人設定擋住：抓出來並擋下（exit ${out.code}）`);
  if (!okCatch) console.log('        ' + out.out.split('\n').filter((l) => /gitignore|必須/.test(l)).join(' ｜ '));

  /*
   * `.git/info/exclude` 是每一份 clone 自己的，也不會進版控 ——
   * 但它印出來是**相對路徑**，所以光看「是不是絕對路徑」分不出來。
   * 第一版就是那樣寫的，突變掃描（把判斷放寬成只看絕對路徑）當場通過，
   * 補了這一格才紅。
   */
  const excludeFile = await build(
    { '.gitignore': 'node_modules\ndist\n' },
    'exclude:.env,.env.local,src/config/identity.local.ts',
  );
  const out3 = await audit(excludeFile);
  const okExclude = /沒有進版控的忽略檔/.test(out3.out) && out3.code === 1;
  if (!okExclude) failed++;
  console.log(`  ${okExclude ? '✓' : 'X'} .git/info/exclude 擋住的也算數（那是每份 clone 自己的）`);
  if (!okExclude) console.log('        ' + out3.out.split('\n').filter((l) => /gitignore|必須/.test(l)).join(' ｜ '));

  /*
   * 反向：規則寫在 repo 自己的 `.gitignore` 裡就該放行。
   * 少了這一格，把判斷改成「一律報」也會通過上面那格。
   *
   * 而且**刻意不 commit** —— 剛把那一行加進去、還沒 `git add` 的時候
   * 不該誤報，那正是最可能跑這支稽核的時刻。
   */
  const inRepo = await build({}, 'init-only');
  const out2 = await audit(inRepo);
  const okQuiet = !/沒有進版控的忽略檔/.test(out2.out);
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} 寫在 repo 的 .gitignore 裡就放行（還沒 commit 也一樣）`);
  if (!okQuiet) console.log('        ' + out2.out.split('\n').filter((l) => /gitignore/.test(l)).join(' ｜ '));
}

/*
 * ── 用 git 的那兩項，查不了的時候會說話嗎 ──────────────
 *
 * 第 5 輪（第二十一圈）量到的：`private-file-tracked` 與 `gitignore-weakened`
 * 都包在 `try { … } catch { /* 跳過 *\/ }` 裡。在一個不是 git repo 的目錄上跑
 * （實測 `git ls-files` 與 `git check-ignore` 都以 128 結束），
 * **兩項都沒跑，而報告照樣說「乾淨」**。
 *
 * 那兩項正是擋「含本名的檔案進公開 repo」的唯二兩道。
 * 這一格守的是「查不了要說出來」——
 * 而反向那一格（真的是 repo 時**不能**說）同樣重要：
 * 少了它，把訊息改成無條件印也會全綠。
 */
{
  const noGit = await audit(await build({}));
  const okSay =
    /私密檔追蹤狀態沒有檢查/.test(noGit.out) && /\.gitignore 沒有檢查/.test(noGit.out);
  if (!okSay) failed++;
  console.log(`  ${okSay ? '✓' : 'X'} git 用不了：兩項都說「這一次沒有查」`);

  const withGit = await audit(await build({}, 'init-only'));
  const okQuiet =
    !/私密檔追蹤狀態沒有檢查/.test(withGit.out) && !/\.gitignore 沒有檢查/.test(withGit.out);
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} 真的是 repo：不說那兩句（反向案例）`);
}

/*
 * ── 主體數：0 也要印得出來 ────────────────────────────
 *
 * 第二十一圈整圈在問「這一條檢查實際上判斷過多少東西」。
 * 對這一支而言，最強的那一種「判斷過 0 個」不是印出 0 ——
 * 是**整項從名單裡消失**，而消失看起來就跟「沒有這種東西」一樣。
 *
 * 所以兩件事都要守：查不了的那兩項要在名單裡（值是 0），
 * 而每一個測得到的檢查都要在名單裡（不然新增一項會沒有人發現它沒被計數）。
 */
{
  const { out } = await audit(await build({}), {}, ['--verbose']);
  const rows = new Map(
    [...out.matchAll(/^\s*(\d+)\s+([a-z-]+)$/gm)].map((m) => [m[2], Number(m[1])]),
  );

  const okZero =
    rows.get('private-file-tracked') === 0 && rows.get('gitignore-weakened') === 0;
  if (!okZero) failed++;
  console.log(
    `  ${okZero ? '✓' : 'X'} 查不了的那兩項在名單裡，值是 0（不是不見）`,
    okZero ? '' : `—— 實際：${rows.get('private-file-tracked')} / ${rows.get('gitignore-weakened')}`,
  );

  const okCounted = (rows.get('csp-missing') ?? 0) > 0 && (rows.get('possible-secret') ?? 0) > 0;
  if (!okCounted) failed++;
  console.log(
    `  ${okCounted ? '✓' : 'X'} 真的跑過的項目數得出主體` +
      `（CSP ${rows.get('csp-missing')} 頁、機密掃了 ${rows.get('possible-secret')} 個檔案）`,
  );

  /*
   * 最重要的那一條也要在名單裡。
   *
   * `identity-value` 是動態產生的：沒有 needles 就沒有那條規則。
   * 少了這一格，它會整條從主體數名單裡消失 —— 而消失看起來像
   * 「沒有這種檢查」，不是「這一次什麼都沒守到」。
   * 有 needles 的時候它是主體最多的一條（掃得比誰都多，連豁免清單都穿得過）。
   */
  const okIdentityZero = rows.get('identity-value') === 0;
  if (!okIdentityZero) failed++;
  console.log(
    `  ${okIdentityZero ? '✓' : 'X'} 沒有 needles 時 identity-value 是 0（不是不見）`,
  );

  const withNeedles = await audit(await build({}), { PRIVACY_NEEDLES: 'ZzQqXx假值' }, ['--verbose']);
  const nIdentity = Number(
    /^\s*(\d+)\s+identity-value$/m.exec(withNeedles.out)?.[1] ?? '0',
  );
  const okIdentityMost = nIdentity > 0;
  if (!okIdentityMost) failed++;
  console.log(
    `  ${okIdentityMost ? '✓' : 'X'} 有 needles 時它真的在掃東西（${nIdentity} 個檔案）`,
  );

  /* 每一個有測試案例的檢查，都要出現在主體數名單裡 */
  const tested = new Set(Object.values(CASES).map((c) => c.check ?? '').filter(Boolean));
  for (const k of Object.keys(CASES)) tested.add(k.replace(/（.*$/, ''));
  const missing = [...tested].filter((id) => !rows.has(id)).sort();
  if (missing.length > 0) failed++;
  console.log(
    `  ${missing.length === 0 ? '✓' : 'X'} 有案例的檢查都在主體數名單裡（${tested.size} 項）`,
  );
  if (missing.length > 0) console.log(`      不在名單裡：${missing.join('、')}`);
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);

/**
 * @param {Record<string, string>} overrides
 * @param {boolean | string} [asGitRepo]  true 用預設路徑，字串則 add 那個路徑
 */
async function build(overrides, asGitRepo = false) {
  const dir = await mkdtemp(join(tmpdir(), 'privacy-struct-'));
  for (const [name, content] of Object.entries({ ...CLEAN, ...overrides })) {
    const p = join(dir, name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }
  if (asGitRepo === 'init-only') {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: /** @type {const} */ ('ignore') });
    return dir;
  }
  /*
   * `personal:<樣式>` —— 把忽略規則放進**個人**的 excludesFile 而不是 repo 的
   * `.gitignore`。那份檔案不會進版控，所以只有這一台機器擋得住。
   * 第 5 輪（第二十二圈）加的，見那一輪的紀錄。
   */
  /*
   * `exclude:<樣式>` —— 放進 `.git/info/exclude`。那個檔案是**每一份 clone
   * 自己的**，不會進版控，所以跟個人 excludesFile 是同一種問題。
   * 分開一格是因為它是**相對路徑**，光看「是不是絕對路徑」分不出來 ——
   * 突變掃描抓到第一版就是那樣寫的。
   */
  if (typeof asGitRepo === 'string' && asGitRepo.startsWith('exclude:')) {
    const opts = { cwd: dir, stdio: /** @type {const} */ ('ignore') };
    execFileSync('git', ['init', '-q'], opts);
    await mkdir(join(dir, '.git/info'), { recursive: true });
    await writeFile(
      join(dir, '.git/info/exclude'),
      asGitRepo.slice('exclude:'.length).split(',').join('\n') + '\n',
      'utf8',
    );
    return dir;
  }
  if (typeof asGitRepo === 'string' && asGitRepo.startsWith('personal:')) {
    const opts = { cwd: dir, stdio: /** @type {const} */ ('ignore') };
    execFileSync('git', ['init', '-q'], opts);
    await writeFile(join(dir, 'personal-ignore'), asGitRepo.slice('personal:'.length).split(',').join('\n') + '\n', 'utf8');
    execFileSync('git', ['config', 'core.excludesFile', join(dir, 'personal-ignore')], opts);
    return dir;
  }
  /*
   * `history:<路徑>` —— commit 那個檔案，**然後把它從索引拿掉**。
   * 這就是 private-file-in-history 要抓的情況：現在沒被追蹤，歷史裡有。
   */
  if (typeof asGitRepo === 'string' && asGitRepo.startsWith('history:')) {
    const path = asGitRepo.slice('history:'.length);
    const opts = { cwd: dir, stdio: /** @type {const} */ ('ignore') };
    execFileSync('git', ['init', '-q'], opts);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], opts);
    execFileSync('git', ['config', 'user.name', 'test'], opts);
    execFileSync('git', ['add', '-f', path], opts);
    execFileSync('git', ['commit', '-q', '-m', 'oops'], opts);
    execFileSync('git', ['rm', '-q', '--cached', path], opts);
    return dir;
  }
  if (asGitRepo) {
    /*
     * private-file-tracked 靠 `git ls-files` 判斷，所以要真的建一個 repo
     * 並且**把那個檔案 add 進去** —— 光是檔案存在不算違規，
     * 「被 git 追蹤」才是。
     */
    const opts = { cwd: dir, stdio: /** @type {const} */ ('ignore') };
    execFileSync('git', ['init', '-q'], opts);
    execFileSync(
      'git',
      ['add', '-f', typeof asGitRepo === 'string' ? asGitRepo : 'src/config/identity.local.ts'],
      opts,
    );
  }
  return dir;
}

/** @param {string} dir */
async function audit(dir, env = {}, /** @type {string[]} */ extraArgs = []) {
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/audit-privacy.mjs'), `--root=${dir}`, ...extraArgs], {
      env: { ...process.env, CI: '', PRIVACY_NEEDLES: '', ...env },
    });
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? '') + String(/** @type {any} */ (err)?.stderr ?? ''), code: e?.code ?? 1 };
  }
}
