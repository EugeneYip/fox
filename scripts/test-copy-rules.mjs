#!/usr/bin/env node
// @ts-check
/**
 * 文案慣例規則的實測 —— `npm run test:copy-rules`
 *
 * 每條規則放一份剛好違反它的假文件，確認會響；另外放一份乾淨的，確認不誤報。
 *
 * ## 為什麼特別需要「不誤報」那一半
 *
 * 這支檢查的規則第一版就寫壞過：`/台/g` 抓所有的「台」，
 * 結果「後台」「站台」「舞台」全部中槍（第 6 輪，第三圈）。
 * 加半形標點那條的時候又差點重演 —— `docs/CONTENT.md` 的 YAML 範例
 * `tags: [唐詩, 李白]` 裡的半形逗號是**對的**。
 *
 * **一條會誤報的規則比沒有規則糟**：它會讓人學會忽略這個檢查。
 * 所以每條規則都要有「不該抓的」案例，而不只是「該抓的」。
 */
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const realClaude = await readFile(resolve(ROOT, 'CLAUDE.md'), 'utf8');

const html = (/** @type {string} */ body) =>
  `<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body>${body}</body></html>`;

/**
 * `hit` 要被抓到，`miss` 不能被抓到。
 * key 預設就是規則 id；`expect` 用來覆寫（測掃描範圍而不是測某條正則時）。
 * @type {Record<string, { hit: Record<string, string>, miss: Record<string, string>, expect?: string, coFires?: string[] }>}
 */
const CASES = {
  /*
   * 地名那一支要有自己的案例。第 6 輪（第八圈）的突變掃描發現：
   * 把規則砍成只剩 `平台`，這個案例照樣綠 —— 因為它的 hit 同時含
   * 「平台」與「台北」，**證明不了地名那一支還活著**。
   */
  'taiwan-tai（地名那一支）': {
    expect: 'taiwan-tai',
    hit: { 'dist/index.html': html('<p>他住在台北，去過台南。</p>') },
    /*
     * miss 這一行必須**含有「台」**，不然 subject（`/台/`）不匹配，
     * 規則連看都不會看 —— 那一格就變成「綠得沒有意義」。
     * 第 6 輪（第二十五圈）量到舊的那一行一個「台」都沒有。
     * 「站台」是「台」的正確用法，正好是這條規則該放行的。
     */
    miss: { 'dist/index.html': html('<p>他住在臺北，去過臺南。站台上人很多。</p>') },
  },
  'taiwan-tai': {
    hit: { 'dist/index.html': html('<p>這是一個平台，位於台北。</p>') },
    miss: { 'dist/index.html': html('<p>這是一個平臺，位於臺北。後台與站台都用「台」是對的。</p>') },
  },
  /*
   * ── SKIP 清單：歷史紀錄與 CLAUDE.md 不掃 ──
   *
   * 那兩份**會引用被禁的東西本身**（訂下規則的地方、以及歷次紀錄），
   * 所以刻意不掃。第 6 輪（第十五圈）的突變掃描發現：把 SKIP 清空，
   * 這支測試**照樣全綠** —— 因為沒有任何 fixture 用得到那兩個檔名。
   * 擋住它的其實是 `test:built` 那一半（真的跑一次 check:copy），
   * 而那是靠真實語料，不是靠可控的輸入。
   *
   * hit 用的是同樣的內容放在別的檔名，證明「被跳過」不是因為內容沒問題。
   */
  'SKIP：歷史紀錄裡的違規不算': {
    expect: 'taiwan-tai',
    hit: { 'docs/OTHER.md': '第 6 輪量到一個平台的寫法。\n' },
    miss: { 'docs/REVIEW-LOG.md': '第 6 輪量到一個平台的寫法。\n' },
  },
  /*
   * ── 引用的原文不掃 ──────────────────────────────────
   *
   * 第 6 輪（第十六圈）的誤報探針：古典詩句「樓台南望」被 `taiwan-tai`
   * 報成用了「台南」—— 那個地名不在句子裡，是兩個字剛好相鄰。
   * 而 CLAUDE.md 的約定講的是**站名與正式文案**，不是引用的原文。
   *
   * hit 用同一句話放在原文區塊**外面**，證明「跳過」跳的是那一塊，
   * 不是那句話。
   */
  'taiwan-tai（引用的原文不掃）': {
    expect: 'taiwan-tai',
    /*
     * hit 刻意把引用區塊放在**前面**，違規放在後面 —— 兩件事一起守：
     * 跳過的範圍不能溢出到後面的內容，找結尾也不能用「第一個 </div>」
     * （巢狀時會切太少、或一路切到檔尾）。突變掃描第一次就是這兩個漏掉的。
     */
    hit: {
      'dist/index.html': html(
        '<div class="poem__original"><p class="poem__stanza">' +
          '<span class="poem__line">樓台南望</span></p></div>' +
          '<p class="poem__annotation">這個平台的注解</p>',
      ),
    },
    miss: {
      'dist/index.html': html(
        '<div class="poem__original" lang="zh-Hant"><p class="poem__stanza">' +
          '<span class="poem__line">樓台南望</span></p></div>',
      ),
    },
  },
  'halfwidth-punct': {
    hit: { 'dist/index.html': html('<p>今天天氣很好,我們出去走走.</p>') },
    miss: {
      // 中英混排時半形標點是正常的；程式碼區塊裡的更是
      'dist/index.html': html('<p>今天天氣很好，用的是 Astro 7, 版本很新。</p>'),
      'docs/x.md': '```yaml\ntags: [唐詩, 李白]\n```\n正文用全形，沒問題。\n',
    },
  },
  /*
   * 這一條測的不是規則本身，是**掃描範圍**：
   * 放在 ui.ts 裡、從來不會被算繪出來的字串也要被抓到。
   * 第 6 輪（第六圈）量到 160 個介面字串裡有 36 個從未出現在任何一頁。
   */
  'unrendered-string': {
    expect: 'taiwan-tai',
    hit: {
      'dist/index.html': html('<p>正常的一頁。</p>'),
      'src/i18n/ui.ts': "export const ui = { 'x.empty': { 'zh-TW': '這個平台還沒有東西' } };\n",
    },
    miss: {
      'dist/index.html': html('<p>正常的一頁。</p>'),
      'src/i18n/ui.ts': "export const ui = { 'x.empty': { 'zh-TW': '這個平臺還沒有東西' } };\n",
    },
  },
  /*
   * 沒有主人的 i18n 鍵。
   *
   * miss 那一份刻意同時放 `list.count` 與 `list.count_one` ——
   * `_one` 是 i18n/utils.ts 在 n===1 時動態組出來的，原始碼裡搜不到。
   * 少了這個反向案例，「把所有 _one 都報成沒人用」的壞版本也會通過
   * （第 6 輪〔第七圈〕第一版就是那樣，3 個裡誤報 2 個）。
   */
  'unused-i18n-key': {
    hit: {
      'dist/index.html': html('<p>正常的一頁。</p>'),
      'src/i18n/ui.ts': "export const ui = { 'a.used': { 'zh-TW': '有人用' }, 'a.orphan': { 'zh-TW': '沒人用' } };\n",
      'src/pages/x.astro': "const t = 'a.used';\n",
    },
    miss: {
      'dist/index.html': html('<p>正常的一頁。</p>'),
      'src/i18n/ui.ts':
        "export const ui = { 'list.count': { 'zh-TW': '共 n 篇' }, 'list.count_one': { 'zh-TW': '共 1 篇' } };\n",
      'src/pages/x.astro': "const t = 'list.count';\n",
    },
  },
  /*
   * 掃描範圍：`docs/` 底下的 markdown 也要掃。
   * 第 6 輪（第八圈）之前沒有任何案例的 hit 在 docs 裡 ——
   * 把整個 docs 掃描拿掉，測試照樣全綠。
   */
  'docs-也要掃': {
    expect: 'taiwan-tai',
    hit: {
      'dist/index.html': html('<p>正常的一頁。</p>'),
      'docs/x.md': '# 說明\n\n這裡寫了平台兩個字。\n',
    },
    miss: {
      'dist/index.html': html('<p>正常的一頁。</p>'),
      'docs/x.md': '# 說明\n\n這裡寫了平臺兩個字。\n',
    },
  },
  'straight-quotes': {
    hit: { 'dist/index.html': html('<p>他說"這樣"就好。</p>') },
    miss: { 'dist/index.html': html('<p>他說「這樣」就好，英文引號像 "hello" 這樣不算。</p>') },
  },
  'cjk-latin-space': {
    hit: { 'dist/index.html': html('<p>這個站是用Astro建的。</p>') },
    miss: {
      'dist/index.html': html(
        // 有空格的正常寫法、以及日期（數字不適用這條規則）
        '<p>這個站是用 Astro 建的，發表於 2026 年 9月2日。第 3 頁還有 CSS 的說明。</p>',
      ),
    },
  },
  /*
   * 中英交界**落在標籤上**。
   *
   * 第 6 輪（第十三圈）之前，這一圈所有案例的交界都在同一個文字節點裡，
   * 所以這條路一次都沒被走過 —— 而 `check:copy` 原本把每個標籤都換成
   * 一個空白，於是 `用<strong>Astro</strong>建的`（瀏覽器算繪出來是
   * 「用Astro建的」，實測 2 處違規）被讀成「用 Astro 建的」，安靜通過。
   *
   * miss 那一份釘的是取捨：相鄰的兩個 `span` 是這個站的版面盒子
   * （靠 flex 的 gap 分開），靜態看不出中間有沒有空白，所以**刻意不抓**。
   * 判準真的在 CSS 上，靜態掃不出來。
   */
  'cjk-latin-space（交界在標籤上）': {
    expect: 'cjk-latin-space',
    hit: { 'dist/index.html': html('<p>這個站是用<strong>Astro</strong>建的。</p>') },
    miss: { 'dist/index.html': html('<p><span>YouTube</span><span>共 9 篇</span></p>') },
  },
  /*
   * 標籤名大寫。HTML 的標籤名不分大小寫，而這個站的產出全是小寫 ——
   * 所以這一格守的是「這支腳本的契約是讀 HTML」，不是守現在的產出。
   * 突變掃描指出來的：拿掉 `toLowerCase()` 的話，上面那個案例照樣綠。
   */
  'cjk-latin-space（標籤名大寫）': {
    expect: 'cjk-latin-space',
    hit: { 'dist/index.html': html('<p>用<EM>Node</EM>跑的。</p>') },
    miss: { 'dist/index.html': html('<p>用 <EM>Node</EM> 跑的。</p>') },
  },
  /*
   * 每一條文案規則都要寫在 CLAUDE.md 裡。
   *
   * 第 6 輪（第十四圈）量到 `straight-quotes` 與 `halfwidth-ellipsis`
   * **只存在於腳本裡**，文件沒寫 —— 照文件寫的人會被 CI 擋下來卻不知道
   * 為什麼。這一格守的是「兩邊的清單一致」。
   *
   * 判準只要求規則 id 出現在文件裡（措辭是人的事）。
   * 這個案例把 CLAUDE.md 換成一份沒有提到任何規則的，所以會響。
   */
  'rule-not-documented': {
    hit: { 'CLAUDE.md': '# 這一份沒有提到任何一條文案規則\n' },
    /* 反向：真正的 CLAUDE.md 五條都提到了，不該響 */
    miss: { 'CLAUDE.md': realClaude },
  },
  'halfwidth-ellipsis': {
    hit: { 'dist/index.html': html('<p>然後就...沒有然後了。</p>') },
    /*
     * miss 的兩行都必須**先過 subject**，否則這一格證明不了任何事 ——
     * 規則根本不會去看它。
     *
     * 第 6 輪（第二十五圈）量到舊的兩行都過不了：
     * 「⋯檔名像 a.b.c 這樣不算」沒有三個連續的半形句點，
     * 「Loading... please wait.」整行沒有漢字。subject 是
     * `/[一-鿿][\s\S]*\.{3}/`，兩行都不匹配，於是那一格**永遠是綠的**。
     *
     * 上面那段註解原本宣稱它守得住「把規則放寬成只要出現 ... 就抓」——
     * 實測那個突變下，這一格照樣綠（真正紅的是一格講「閒置規則」的，
     * 訊息還寫著「沒有，是別的原因」）。
     *
     * 現在那一行**同時有漢字與三個半形句點**（subject ✓），
     * 而句點前面是拉丁字母（bad ✗）—— 那正是這條規則要放行的真實情況：
     * 中英混排時英文句子後面的省略號。放寬 bad 的話它會當場紅。
     */
    miss: {
      'dist/index.html': html('<p>影片在這裡：Loading... please wait.</p>'),
      'dist/en/index.html': html('<p>Loading... please wait.</p>'),
    },
  },
};

let failed = 0;
console.log('\n文案慣例規則實測');
console.log('─'.repeat(64));

for (const [name, { hit, miss, expect, coFires }] of Object.entries(CASES)) {
  /*
   * 案例名稱預設就是規則 id。`expect` 是給「測掃描範圍」用的 ——
   * 那種案例要驗的不是某條規則的正則，而是「這個位置的字有沒有被掃到」，
   * 所以名字取的是情境，響的是別的規則。
   */
  const rule = expect ?? name;
  const hitOut = await check(await build(hit));
  const fired = hitOut.includes(`[${rule}]`);
  if (!fired) failed++;
  console.log(`  ${fired ? '✓' : 'X'} ${name}：該抓的有抓到`);
  /*
   * 順帶觸發到別條要先宣告（`coFires`），沒宣告就算失敗。
   *
   * 第 6 輪（第九圈）量過：9 個 hit 案例**每一個都只響自己那條**，
   * 所以這裡加的是「以後也維持這樣」。
   * （a11y 那支量出來是 25／27 有連帶，perf 是 4／13。）
   */
  const allIds = [...new Set([...hitOut.matchAll(/\[([a-z-]+)\]/g)].map((m) => m[1]))];
  const undeclared = allIds.filter((x) => x !== rule && !(coFires ?? []).includes(x));
  if (undeclared.length > 0) {
    failed++;
    console.log(`      這個 fixture 還順帶觸發了沒宣告的規則：${undeclared.join('、')}`);
  }
  if (!fired) console.log(`      實際抓到：${[...new Set([...hitOut.matchAll(/\[([a-z-]+)\]/g)].map((m) => m[1]))].join('、') || '（無）'}`);

  const missOut = await check(await build(miss));
  const quiet = !missOut.includes(`[${rule}]`);
  if (!quiet) failed++;
  console.log(`  ${quiet ? '✓' : 'X'} ${name}：不該抓的沒抓`);
  if (!quiet) console.log('      ' + missOut.split('\n').filter((l) => l.includes('…')).slice(0, 2).join(' '));
}

// 加規則沒加案例就失敗
{
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(resolve(ROOT, 'scripts/check-copy.mjs'), 'utf8'),
  );
  const declared = [...source.matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  /*
   * 結構性的規則（不是逐行比對語料的）案例寫在下面自己的區塊裡，
   * 不在 CASES 的 hit／miss 格式裡。列在這裡是為了**明說**它們有案例 ——
   * 而不是讓上面那個「有沒有案例」的檢查安靜地放行。
   */
  const STRUCTURAL_WITH_OWN_CASES = ['date-wrong-language'];
  const missing = declared.filter((r) => !(r in CASES) && !STRUCTURAL_WITH_OWN_CASES.includes(r));
  if (missing.length > 0) {
    failed += missing.length;
    console.log(`\n  X 這些規則沒有測試案例：${missing.join('、')}`);
  }
}

/*
 * ── 一個檔案都沒掃到，不是「沒有問題」 ──
 *
 * 第 6 輪（第十五圈）拿一個空的 root 跑了一次：這支腳本回報
 * 「沒有發現問題」並且 exit 0 —— 它一個字都沒看過。
 * `check:content` 早就有同樣的擋（「dist 是空的，先跑 build」），這裡沒有。
 *
 * 反向的那一半也要有：真的有語料的時候不能誤報成「沒東西可掃」。
 */
{
  /*
   * ── 行號要嘛是真的，要嘛不要印 ──────────────────────
   *
   * 第 6 輪（第十七圈）量到：產出那一半印的是「去掉標籤之後那份文字的第幾行」，
   * 而原始 HTML 可能只有一行 —— 站主開檔案找那一行，那裡什麼都沒有。
   * **假的精確比沒有精確更糟**：它會讓人相信自己找對了地方。
   *
   * 兩個方向都要守：dist 的不印行號、docs 的要印（那是真的檔案行號）。
   */
  {
    const dir = await mkdtemp(join(tmpdir(), 'copy-lines-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'dist', 'index.html'), html('<p>這個平台很好用。</p>'), 'utf8');
    await writeFile(join(dir, 'docs', 'NOTE.md'), '# 說明\n\n這裡有一個平台的寫法。\n', 'utf8');
    const out = await check(dir);
    const distLine = out.split('\n').find((l) => l.includes('dist/index.html')) ?? '';
    const docLine = out.split('\n').find((l) => l.includes('docs/NOTE.md')) ?? '';
    const ok = !/dist\/index\.html:\d/.test(distLine) && /docs\/NOTE\.md:3/.test(docLine);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 產出不印行號、原始檔印真的行號`);
    if (!ok) console.log(`        dist：${distLine.trim()}\n        docs：${docLine.trim()}`);

    const said = out.includes('那些字的出處在 src/');
    if (!said) failed++;
    console.log(`  ${said ? '✓' : 'X'} 有產出那半的發現時，說明「路徑是產物」`);
  }
  {
    /*
     * workflow 的名字也要對得回真的行號。
     *
     * 之前那裡是 `filter().join()` —— 報出來的是「第幾個 name」而不是
     * 「第幾行」。突變掃描量到那個行為沒有任何案例走過。
     * 這一份 fixture 的違規在第 6 行，前面刻意墊了幾行不是 name 的內容。
     */
    const dir = await mkdtemp(join(tmpdir(), 'copy-wf-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await mkdir(join(dir, '.github/workflows'), { recursive: true });
    await writeFile(join(dir, 'dist', 'index.html'), html('<p>乾淨的一頁。</p>'), 'utf8');
    await writeFile(
      join(dir, '.github/workflows', 'check.yml'),
      ['name: 檢查', 'on:', '  push:', 'jobs:', '  ci:', '    name: 這個平台的檢查', '    steps: []', ''].join('\n'),
      'utf8',
    );
    const out = await check(dir);
    const line = out.split('\n').find((l) => l.includes('workflows/check.yml')) ?? '';
    const ok = line.includes('check.yml:6');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} workflow 的行號對得回真的檔案（第 6 行）`);
    if (!ok) console.log(`        實際：${line.trim() || '（沒有這一筆）'}`);
  }
  {
    /* 反向：只有原始檔的發現時不要多話 */
    const dir = await mkdtemp(join(tmpdir(), 'copy-srconly-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'dist', 'index.html'), html('<p>乾淨的一頁。</p>'), 'utf8');
    await writeFile(join(dir, 'docs', 'NOTE.md'), '# 說明\n\n這裡有一個平台的寫法。\n', 'utf8');
    const out = await check(dir);
    const quiet = !out.includes('那些字的出處在 src/');
    if (!quiet) failed++;
    console.log(`  ${quiet ? '✓' : 'X'} 只有原始檔的發現時不說那句話`);
  }

  {
    /*
     * ── 同一句話出現在每一頁 ──────────────────────────
     *
     * 第 6 輪（第十九圈）在 600 頁下量到：`ui.ts` 裡一個字串違規，
     * 這支腳本印 589 筆、2373 行 —— 那句話畫在每一頁的頁尾。
     *
     * 收合之後還有第二個問題：**唯一改得動的那個檔案被藏在第 587 個**。
     * 所以位置要排序，非 dist/ 的排前面。
     */
    const many = await mkdtemp(join(tmpdir(), 'copy-many-'));
    await mkdir(join(many, 'dist'), { recursive: true });
    await mkdir(join(many, 'src', 'i18n'), { recursive: true });
    for (let i = 0; i < 8; i++) {
      const f = join(many, 'dist', `p${i}`, 'index.html');
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, html('<p>這裡有一個平台的寫法。</p>'), 'utf8');
    }
    /* 這支腳本只掃特定幾個原始檔（ui.ts、site.ts），不是整個 src/ */
    await writeFile(
      join(many, 'src', 'i18n', 'ui.ts'),
      "export const ui = { x: { 'zh-TW': '這裡有一個平台的寫法。' } };\n",
      'utf8',
    );
    /* check() 會在 finally 裡刪掉整個目錄，所以 --verbose 那次要先跑 */
    const { stdout: verbose } = await run('node', [
      '--experimental-strip-types',
      '--no-warnings=ExperimentalWarning',
      resolve(ROOT, 'scripts/check-copy.mjs'),
      `--root=${many}`,
      '--verbose',
    ]).catch((/** @type {any} */ e) => ({ stdout: String(e?.stdout ?? '') }));
    const out = await check(many);

    const headers = (out.match(/\n  X \[taiwan-tai\]/g) ?? []).length;
    const capped = out.includes('…另外 6 個地方');
    /* 假的 ui.ts 會順帶觸發 unused-i18n-key，所以總數是 9 ＋ 1；只要求它照實說 */
    const total = Number((out.match(/\n(\d+) 處。/) ?? [])[1] ?? 0) >= 9;
    const ok = headers === 1 && capped && total;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 同一句話出現在 9 個地方：收成一組，總數照實說`);
    if (!ok) console.log(`      實際：組數 ${headers}、收合 ${capped}、總數 ${total}`);

    /* 改得動的那個檔案要在最前面，不能被收合藏掉 */
    const srcFirst = /\n  X \[taiwan-tai\] src\/i18n\/ui\.ts/.test(out);
    if (!srcFirst) failed++;
    console.log(`  ${srcFirst ? '✓' : 'X'} 改得動的 src/ 路徑排在最前面（不會被收合藏掉）`);

    const vOk =
      (verbose.match(/dist\/p\d+\/index\.html/g) ?? []).length === 8 &&
      !verbose.includes('個地方（--verbose');
    if (!vOk) failed++;
    console.log(`  ${vOk ? '✓' : 'X'} --verbose 把 9 個地方都印出來`);
    await rm(many, { recursive: true, force: true });

    /* 反向：只有 2 個地方時不要多說那一行 */
    const few = await mkdtemp(join(tmpdir(), 'copy-few-'));
    await mkdir(join(few, 'dist', 'a'), { recursive: true });
    await mkdir(join(few, 'dist', 'b'), { recursive: true });
    await writeFile(join(few, 'dist', 'a', 'index.html'), html('<p>這裡有一個平台的寫法。</p>'), 'utf8');
    await writeFile(join(few, 'dist', 'b', 'index.html'), html('<p>這裡有一個平台的寫法。</p>'), 'utf8');
    const fewOut = await check(few);
    const fewOk = !fewOut.includes('…另外') && fewOut.includes('2 處。');
    if (!fewOk) failed++;
    console.log(`  ${fewOk ? '✓' : 'X'} 只有 2 個地方時不印「另外 N 個」（反向案例）`);
    await rm(few, { recursive: true, force: true });
  }

  {
    /*
     * ── 產出比原始檔舊 ────────────────────────────────
     *
     * 第 6 輪（第十八圈）補的。改完 src/ 的字沒有重新 build 就跑，
     * 產出那半照樣報舊的違規，而下面那句建議會叫她「拿那段字去 grep src/」
     * —— 她會搜到自己剛改好的樣子。
     *
     * 兩格一起：舊的時候要說，新的時候**不要**說
     * （少了反向那一格，「一律印」照樣全綠）。
     */
    const stale = await mkdtemp(join(tmpdir(), 'copy-stale-'));
    await mkdir(join(stale, 'dist'), { recursive: true });
    await mkdir(join(stale, 'src'), { recursive: true });
    await writeFile(join(stale, 'dist', 'index.html'), html('<p>這裡有一個平台的寫法。</p>'), 'utf8');
    await writeFile(join(stale, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
    const future = new Date(Date.now() + 5 * 60_000);
    await utimes(join(stale, 'src', 'x.ts'), future, future);
    const staleOut = await check(stale);
    const staleOk = staleOut.includes('先跑 npm run build 再看上面的結果');
    if (!staleOk) failed++;
    console.log(`  ${staleOk ? '✓' : 'X'} dist 比 src 舊：先說「去 build」`);

    const fresh = await mkdtemp(join(tmpdir(), 'copy-fresh-'));
    await mkdir(join(fresh, 'dist'), { recursive: true });
    await mkdir(join(fresh, 'src'), { recursive: true });
    await writeFile(join(fresh, 'dist', 'index.html'), html('<p>這裡有一個平台的寫法。</p>'), 'utf8');
    await writeFile(join(fresh, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
    const freshOut = await check(fresh);
    const freshOk =
      !freshOut.includes('先跑 npm run build 再看上面的結果') &&
      freshOut.includes('那些字的出處在 src/');
    if (!freshOk) failed++;
    console.log(`  ${freshOk ? '✓' : 'X'} dist 是新的：不說那句話，照樣指出處`);
  }

  const empty = await mkdtemp(join(tmpdir(), 'copy-empty-'));
  await mkdir(join(empty, 'dist'), { recursive: true });
  /*
   * 這裡不用上面的 check()：那支只回 stdout，而這一格要的正是**離開碼**
   * —— 「說了一句話但照樣 exit 0」跟沒說一樣，CI 不會停。
   */
  let out = '';
  let code = 0;
  try {
    const r = await run('node', [
      '--experimental-strip-types',
      '--no-warnings=ExperimentalWarning',
      resolve(ROOT, 'scripts/check-copy.mjs'),
      `--root=${empty}`,
    ]);
    out = r.stdout;
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    out = String(e?.stdout ?? '');
    code = e?.code ?? 1;
  }
  const ok = code === 1 && out.includes('一個檔案都沒掃到');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 空的 dist：說「沒東西可看」並且擋下來`);
  if (!ok) console.log(`        exit=${code}｜${out.split('\n').filter(Boolean).slice(-2).join(' ')}`);
  await rm(empty, { recursive: true, force: true });

  /*
   * 反向的那一半：有語料的時候要數得出來。
   * 少了它，「計數器永遠是 0」會**靜靜通過** —— 每一份 fixture 都會走進
   * 上面那道擋，而 miss 案例只檢查「沒有報那條規則」，那仍然成立。
   * 突變掃描就是這樣漏掉的（這一圈第三次遇到同一件事）。
   */
  const one = await mkdtemp(join(tmpdir(), 'copy-one-'));
  await mkdir(join(one, 'dist'), { recursive: true });
  await writeFile(join(one, 'dist', 'index.html'), html('<p>臺北的天氣很好。</p>'), 'utf8');
  const outOne = await check(one);
  const okOne = /掃了 [1-9]\d* 個檔案/.test(outOne) && outOne.includes('沒有發現問題');
  if (!okOne) failed++;
  console.log(`  ${okOne ? '✓' : 'X'} 有語料時數得出掃了幾個檔案`);
  if (!okOne) console.log(`        ${outOne.split('\n').filter(Boolean).slice(-2).join(' ')}`);
}

/*
 * ── subject 一定要比 bad 寬 ──────────────────────────
 *
 * 第 6 輪（第二十一圈）給每條規則加了 `subject`（「這一行有沒有東西給它判斷」），
 * 而 `scan()` 是**前提不成立就 continue** —— 也就是說
 * **subject 寫窄了，那條規則就會對它本來抓得到的東西閉嘴**，
 * 而且沒有任何徵兆：報告會說「沒有發現問題」，看起來跟真的沒問題一樣。
 *
 * 這一格直接拿每條規則的違規案例去驗：`bad` 配得到的字串，
 * `subject` 一定也要配得到。案例取自這個檔案上面的 CASES ——
 * 那些本來就是「該響」的最小例子。
 */
{
  const { RULES } = await import(pathToFileURL(resolve(ROOT, 'scripts/lib/copy-rules.mjs')).href);
  let bad = 0;
  for (const rule of RULES) {
    for (const sample of rule.samples ?? []) {
      rule.bad.lastIndex = 0;
      const hitsBad = rule.bad.test(sample);
      const hitsSubject = rule.subject.test(sample);
      if (hitsBad && !hitsSubject) {
        bad++;
        console.log(`      ${rule.id}：「${sample}」bad 配得到，subject 配不到`);
      }
    }
  }
  const okWider = bad === 0;
  if (!okWider) failed++;
  console.log(
    `  ${okWider ? '✓' : 'X'} 每條規則的 subject 都比 bad 寬` +
      `（${RULES.reduce((/** @type {number} */ n, /** @type {any} */ r) => n + (r.samples?.length ?? 0), 0)} 個違規樣本）`,
  );

  /* 每條規則都要有樣本 —— 沒有樣本的話上面那一格什麼都沒驗 */
  const noSamples = RULES.filter((/** @type {any} */ r) => (r.samples ?? []).length === 0).map(
    (/** @type {any} */ r) => r.id,
  );
  const okSamples = noSamples.length === 0;
  if (!okSamples) failed++;
  console.log(`  ${okSamples ? '✓' : 'X'} 每條規則都有違規樣本`);
  if (!okSamples) console.log(`      沒有樣本的：${noSamples.join('、')}`);
}

/*
 * ── 沒有東西可判斷的規則要說出來 ──────────────────────
 *
 * `halfwidth-ellipsis` 在真實語料上的主體數是 **0** —— 它從第十四圈加進來
 * 到現在沒有判斷過任何東西。那不是問題（預防性的規則本來就會這樣），
 * 問題是報告看起來像它在守著什麼。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'copy-idle-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  /* 只有一行中文，沒有拉丁字母、沒有引號、沒有刪節號 —— 大部分規則都閒著 */
  await writeFile(join(dir, 'dist', 'index.html'), html('<p>臺北的天氣很好。</p>'), 'utf8');
  const out = await check(dir);
  const okIdle = out.includes('這次沒有東西可判斷的規則') && out.includes('halfwidth-ellipsis');
  if (!okIdle) failed++;
  console.log(`  ${okIdle ? '✓' : 'X'} 沒有東西可判斷的規則會被列出來`);

  /*
   * 反向：語料裡每條規則都有東西可判斷的時候，那一段不該出現。
   * 少了這一格，把清單改成「無條件全印」也會全綠。
   */
  const dir2 = await mkdtemp(join(tmpdir(), 'copy-busy-'));
  await mkdir(join(dir2, 'dist'), { recursive: true });
  /*
   * 每條規則都**有東西可判斷、但都不違規**的語料。刻意逐條湊：
   *   台階　　　　　　　→ 有「台」，但不是台灣／台北／平台
   *   x = 1; 這樣　　　 → 有漢字也有半形分號，但分號左邊不是漢字
   *   他說 "yes" 對　　 → 有漢字也有直引號，但引號兩側不是漢字
   *                       （要用真的 `"`，`&quot;` 不會被還原成引號）
   *   用 Astro 建的站　 → 有漢字也有拉丁字母，而且空格是對的
   *   他說 x... 算了　　→ 有漢字也有三個句點，但句點左邊是 x
   */
  await writeFile(
    join(dir2, 'dist', 'index.html'),
    html(
      '<p>那道台階很高。</p><p>寫成 x = 1; 這樣就好。</p>' +
        '<p>他說 "yes" 對吧。</p><p>用 Astro 建的站。</p><p>他說 x... 算了。</p>',
    ),
    'utf8',
  );
  const out2 = await check(dir2);
  /*
   * 只看五條吃語料的規則。`unused-i18n-key` 與 `rule-not-documented`
   * 在一份沒有 ui.ts 也沒有 CLAUDE.md 的假站上本來就是 0 —— 那是對的，
   * 它們正該被列出來。
   */
  const idleLine = /這次沒有東西可判斷的規則（[^）]*）：(.*)/.exec(out2)?.[1] ?? '';
  const corpusIdle = ['taiwan-tai', 'halfwidth-punct', 'straight-quotes', 'cjk-latin-space', 'halfwidth-ellipsis']
    .filter((id) => idleLine.includes(id));
  const okBusy = out2.includes('沒有發現問題') && corpusIdle.length === 0;
  if (!okBusy) failed++;
  console.log(`  ${okBusy ? '✓' : 'X'} 五條語料規則都有東西可判斷時不列（反向案例）`);
  if (!okBusy) console.log(`        還在閒著的：${corpusIdle.join('、') || '（沒有，是別的原因）'}`);

  await rm(dir, { recursive: true, force: true });
  await rm(dir2, { recursive: true, force: true });
}

/*
 * ── 日期有沒有用對語言 ──────────────────────────────
 *
 * 頁面上的日期是 `Intl.DateTimeFormat` **在建置那台機器上**產生的。
 * 精簡 ICU 的 Node 沒有中文資料，`zh-TW` 會**安靜地退回英文** ——
 * 中文頁上就會出現「September 2, 2026」，而沒有任何一道檢查在看這件事。
 *
 * 四格：中文頁出現英文日期、英文頁出現中文日期、兩邊都對時不誤報、
 * 以及空的 `<time>` 不算數。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'copy-date-'));
  /** @param {Record<string, string>} files */
  const runWith = async (files) => {
    await rm(join(dir, 'dist'), { recursive: true, force: true });
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(dir, 'dist', rel)), { recursive: true });
      await writeFile(join(dir, 'dist', rel), body, 'utf8');
    }
    return check(dir);
  };

  const zhPage = (/** @type {string} */ d) => html(`<p>今天 <time datetime="2026-09-02">${d}</time> 讀了一首。</p>`);
  const enPage = (/** @type {string} */ d) => html(`<p>Read one on <time datetime="2026-09-02">${d}</time>.</p>`);

  /*
   * 比對用 `[id]` 而不是裸的 id。
   * 裸的會撞到「這次沒有東西可判斷的規則：⋯date-wrong-language⋯」那一行 ——
   * 第一版就是這樣，空的 `<time>` 那一格因此紅了，而程式其實是對的。
   */
  const wrongZh = await runWith({ 'index.html': zhPage('September 2, 2026') });
  const ok1 = wrongZh.includes('[date-wrong-language]');
  if (!ok1) failed++;
  console.log(`  ${ok1 ? '✓' : 'X'} 中文頁出現英文日期：抓得到`);

  const wrongEn = await runWith({ 'index.html': zhPage('2026年9月2日'), 'en/index.html': enPage('2026年9月2日') });
  const ok2 = wrongEn.includes('[date-wrong-language]');
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} 英文頁出現中文日期：抓得到`);

  const both = await runWith({ 'index.html': zhPage('2026年9月2日'), 'en/index.html': enPage('September 2, 2026') });
  const ok3 = !both.includes('[date-wrong-language]');
  if (!ok3) failed++;
  console.log(`  ${ok3 ? '✓' : 'X'} 兩邊都對時不誤報（反向案例）`);
  if (!ok3) console.log('        ' + both.split('\n').filter((l) => /date-wrong/.test(l)).join(' ｜ '));

  /* 只有月日的形式（列表頁用的）也要放行 —— 少了這個會把正常的頁面報成壞的 */
  const shortForm = await runWith({ 'index.html': html('<p><time datetime="2026-09-02">9月2日</time></p>') });
  const ok4 = !shortForm.includes('[date-wrong-language]');
  if (!ok4) failed++;
  console.log(`  ${ok4 ? '✓' : 'X'} 只有「9月2日」的短形式也算對`);

  /* 空的 <time>（只有 datetime 屬性）不該被當成違規 */
  const empty = await runWith({ 'index.html': html('<p><time datetime="2026-09-02"></time></p>') });
  const ok5 = !empty.includes('[date-wrong-language]');
  if (!ok5) failed++;
  console.log(`  ${ok5 ? '✓' : 'X'} 空的 <time> 不算數`);

  await rm(dir, { recursive: true, force: true });
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);

/** @param {Record<string, string>} files */
async function build(files) {
  const dir = await mkdtemp(join(tmpdir(), 'copy-rules-'));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }
  return dir;
}

/**
 * 有發現時 check-copy 會 exit 1，而 execFile 會因此 reject ——
 * 輸出仍然在 err.stdout 裡。
 * @param {string} dir
 */
async function check(dir) {
  try {
    /*
     * 旗標要跟 package.json 的 check:copy 一致。
     * 少了它，check-copy 匯入 .ts 會拋錯而被 catch 掉 —— 測試照樣全綠，
     * 但「未算繪的字串」那一段根本沒跑。安靜略過就是假的綠燈。
     */
    const { stdout } = await run('node', [
      '--experimental-strip-types',
      '--no-warnings=ExperimentalWarning',
      resolve(ROOT, 'scripts/check-copy.mjs'),
      `--root=${dir}`,
    ]);
    return stdout;
  } catch (err) {
    return String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
