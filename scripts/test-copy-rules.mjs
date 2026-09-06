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
import { documentationDuty, RULES } from './lib/copy-rules.mjs';
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const realClaude = await readFile(resolve(ROOT, 'CLAUDE.md'), 'utf8');
const realContent = await readFile(resolve(ROOT, 'docs/CONTENT.md'), 'utf8');

const html = (/** @type {string} */ body) =>
  `<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body>${body}</body></html>`;

/**
 * `hit` 要被抓到，`miss` 不能被抓到。
 * key 預設就是規則 id；`expect` 用來覆寫（測掃描範圍而不是測某條正則時）。
 * @type {Record<string, { hit: Record<string, string>, miss: Record<string, string>, expect?: string, coFires?: string[] }>}
 */
const CASES = {
  /*
   * ── 少打一個反引號 ──
   *
   * `stripCode()` 是拿正則配對的，配不成對時它會**配到下一個** ——
   * 中間那一段真的文案就被當成程式碼拿掉了。後果不是誤報是**漏報**，
   * 而且「掃了 N 行」一點都不會變（行還在，內容沒了）。
   *
   * miss 那一行刻意有**兩個**反引號：這條規則的主體是「有反引號的行」，
   * 一個都沒有的話它連看都不會看，那一格就綠得沒有意義。
   */
  'unbalanced-backtick': {
    hit: { 'docs/X.md': '拿掉 `draft: true 那一行就會出現。\n' },
    miss: { 'docs/X.md': '拿掉 `draft: true` 那一行就會出現。\n' },
  },
  /*
   * 圍欄沒關的那一半 —— 從那裡到下一個圍欄之間會被整段拿掉。
   */
  'unbalanced-backtick（圍欄沒關）': {
    expect: 'unbalanced-backtick',
    hit: { 'docs/X.md': '```bash\nnpm run dev\n' },
    miss: { 'docs/X.md': '```bash\nnpm run dev\n```\n' },
  },
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
   * ── SKIP 清單：只剩歷史紀錄 ──
   *
   * `docs/REVIEW-LOG.md` **會引用被禁的東西本身**（歷次紀錄裡的違規記的是
   * 當時的事實），所以刻意不掃。第 6 輪（第十五圈）的突變掃描發現：
   * 把 SKIP 清空，這支測試**照樣全綠** —— 因為沒有任何 fixture 用得到
   * 那個檔名。擋住它的其實是 `test:built` 那一半（真的跑一次 check:copy），
   * 而那是靠真實語料，不是靠可控的輸入。
   *
   * hit 用的是同樣的內容放在別的檔名，證明「被跳過」不是因為內容沒問題。
   *
   * `CLAUDE.md` 原本也在 SKIP 裡。第 6 輪（第二十八圈）逐條量過：
   * 它整份被豁免**只為了一行**（`cjk-latin-space` 的反例）。
   * 反例改放進程式碼區塊之後那條豁免就不需要了 —— 下一格守著它真的回到範圍裡。
   */
  'SKIP：歷史紀錄裡的違規不算': {
    expect: 'taiwan-tai',
    hit: { 'docs/OTHER.md': '第 6 輪量到一個平台的寫法。\n' },
    miss: { 'docs/REVIEW-LOG.md': '第 6 輪量到一個平台的寫法。\n' },
  },

  /*
   * ── CLAUDE.md 不再被豁免 ──
   *
   * 一份 200 行的規矩文件從「完全不檢查」回到「跟其他文件一樣」。
   * 少了這一格，把它加回 SKIP 會靜靜通過。
   */
  'CLAUDE.md 現在有在掃': {
    expect: 'taiwan-tai',
    /*
     * 這個 fixture 把 CLAUDE.md 換成三行的殘根，所以
     * `rule-not-documented` 會連帶響（第 6 輪〔第二十七圈〕加的：
     * 五條規則的 id 兩份文件都要提到）。宣告出來，不然
     * 「同時響好幾條」證明不了是哪一條讓它綠的。
     */
    coFires: ['rule-not-documented'],
    hit: { 'CLAUDE.md': '# 規矩\n\n這裡寫了一個平台的寫法。\n' },
    miss: { 'CLAUDE.md': '# 規矩\n\n這裡寫了一個平臺的寫法。\n' },
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
  /*
   * ── 同步回來的標題與摘要也不掃 ──────────────────────
   *
   * 第 3 輪（第三十六圈）實測：把一支 YouTube 影片標題塞一個「台」再建置，
   * `taiwan-tai` 紅 → `verify:all` 紅 → 部署停住。**而那行字在這個 repo 裡改不了**
   * （`syndication.json` 是同步產生的，手改會被下一次同步蓋掉）。
   *
   * 判準跟「引用的原文」同一條：CLAUDE.md 管的是站名與正式文案。
   *
   * `miss` 是標題與摘要（別的平臺打的字）；
   * `hit` 是 `synd__why` —— **那一句是站主在這個 repo 裡自己寫的**，
   * 所以照樣要掃。少了這一格，把整個 `synd__` 前綴一起排除也會通過。
   */
  'taiwan-tai（同步回來的標題不掃，但 why 要掃）': {
    expect: 'taiwan-tai',
    hit: {
      'dist/index.html': html(
        '<li class="synd__item"><h3 class="synd__title">在台灣的影片標題</h3>' +
          '<p class="synd__why">這個平台的挑選理由</p></li>',
      ),
    },
    miss: {
      'dist/index.html': html(
        '<li class="synd__item"><h3 class="synd__title">在台灣的影片標題</h3>' +
          '<p class="synd__summary muted">影片說明裡也有台灣兩個字</p></li>',
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
    /* 反向：真正的兩份文件五條都提到了，不該響 */
    miss: { 'CLAUDE.md': realClaude, 'docs/CONTENT.md': realContent },
  },

  /*
   * ── 內容檔 frontmatter 的註解也在範圍裡 ──────────
   *
   * 那些 `#` 開頭的行是寫給她看的，而且就在她打字的地方。
   * 第 3 輪（第二十八圈）量到兩處違規，一處在**已發佈**的文章裡、
   * 一處在**她被告知要複製的範本**裡，而 check:copy 說「沒有發現問題」。
   */
  'taiwan-tai（內容檔 frontmatter 的註解）': {
    expect: 'taiwan-tai',
    hit: {
      'src/content/posts/x.md': '---\n# 這篇也發在別的平台上\ntitle: 測試\n---\n正文。\n',
    },
    /* 反向：正文裡的不在這條路的範圍（發佈後會進 dist，那邊才管） */
    miss: {
      'src/content/posts/x.md': '---\n# 這篇也發在別的平臺上\ntitle: 測試\n---\n正文提到平台兩個字。\n',
    },
  },

  /*
   * 反向：`tags: [唐詩, 李白]` 的半形逗號是 YAML 語法，不是文章裡的標點。
   *
   * 這一格是這條範圍的**成立條件**：整包掃 src/content 量到 14 處違規，
   * 其中 12 處是這種誤報。只掃註解行才是 2 處、0 誤報。
   * 少了這一格，把範圍放寬成整個檔案會靜靜通過。
   */
  'halfwidth-punct（YAML 的逗號不算，註解裡的算）': {
    expect: 'halfwidth-punct',
    /* 註解裡的半形逗號夾在漢字之間 —— 那是散文，該抓 */
    hit: {
      'src/content/poems/y.md': '---\n# 這裡有中文,然後接著中文\ntitle: 測試\n---\n正文。\n',
    },
    /* 而 tags 那一行的逗號是 YAML 語法，不該抓 */
    miss: {
      'src/content/poems/y.md': '---\ntitle: 測試\ntags: [唐詩, 李白, 五言絕句]\n---\n正文。\n',
    },
  },

  /*
   * 反向：markdown 的標題（正文裡的 `# `）不走這條路。
   *
   * 突變掃描抓到的語料缺口：把「只看 frontmatter 裡的」拿掉之後測試照樣全綠，
   * 因為沒有一格的正文有標題行。
   *
   * 為什麼不該走這條路：正文發佈之後會進 `dist/`，那本來就在範圍裡；
   * 沒發佈的草稿正文還在改，現在擋它沒有意義。
   * 這條路存在的理由是「寫給她看的**說明**」，不是內容本身。
   */
  'taiwan-tai（正文的標題不走這條路）': {
    expect: 'taiwan-tai',
    hit: {
      'src/content/posts/z.md': '---\n# 這篇也發在別的平台上\ntitle: 測試\n---\n正文。\n',
    },
    miss: {
      'src/content/posts/z.md': '---\ntitle: 測試\ndraft: true\n---\n\n# 平台這個標題在正文裡\n\n內文。\n',
    },
  },

  /*
   * ── 寫文案的人讀的那一份也要有 ──────────
   *
   * 第 6 輪（第二十七圈）量到：五條規則**全部只寫在 CLAUDE.md**，
   * 而那份的第一行是「給之後在這個 repo 上工作的 Claude」。
   * 真正在寫文案的人讀 docs/CONTENT.md（「這份是寫給 Bella 的」），
   * 那裡一條都沒有 —— 而且有三條規則的錯誤訊息還寫著「見 CLAUDE.md」。
   *
   * 這一格守的是：CLAUDE.md 寫得再完整，寫文案的人那一份少了也要響。
   * 少了它，把 DOCS 縮回只剩 CLAUDE.md 會靜靜通過。
   */
  'rule-not-documented（寫文案的人那一份沒寫）': {
    expect: 'rule-not-documented',
    hit: { 'CLAUDE.md': realClaude, 'docs/CONTENT.md': '# 寫東西的方法\n\n這一份沒有提到用字約定。\n' },
    miss: { 'CLAUDE.md': realClaude, 'docs/CONTENT.md': realContent },
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
  const STRUCTURAL_WITH_OWN_CASES = ['date-wrong-language', 'example-not-real'];
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

  /*
   * ── 有幾個介面字串從來沒被算繪出來 ──
   *
   * 第 6 輪（第六圈）量到 36／160，寫在註解裡，之後沒有人重量過。
   * 第 6 輪（第二十六圈）把它搬到報告上：那些字第一個看到的人會是她。
   *
   * 判準比對的是**原始 HTML**，不是可見文字 —— 第一版接可見文字，
   * 量出 44%，而例子裡有 `Menu`、`切換深淺色` 這些每頁都在的字：
   * 它們活在 `aria-label` 屬性裡，被 `toVisibleText()` 連標籤一起剝掉了。
   */
  {
    const dir = await mkdtemp(join(tmpdir(), 'copy-unrendered-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await mkdir(join(dir, 'src/i18n'), { recursive: true });
    await writeFile(
      join(dir, 'src/i18n/ui.ts'),
      /* `c` 帶 `{n}`、`d` 只有一個字 —— 兩種都會被跳過，讓「跳過了幾個」有東西可數 */
      "export const ui = { 'a': { 'zh-TW': '這句在屬性裡' }, 'b': { 'zh-TW': '這句從未出現' }," +
        " 'c': { 'zh-TW': '第 {n} 頁' }, 'd': { 'zh-TW': '頁' } };\n",
      'utf8',
    );
    /*
     * 「這句在屬性裡」放在 aria-label —— 屬性也算「進到產出」了。
     * 兩個字串刻意**不互相包含**：第一版用「有畫出來的字」與「沒有畫出來的字」，
     * 後者包含前者，於是「例如那一行不該提到它」這個斷言永遠是假的。
     */
    await writeFile(
      join(dir, 'dist/index.html'),
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head>' +
        '<body><button aria-label="這句在屬性裡">x</button></body></html>',
      'utf8',
    );
    const out = await check(dir);
    const ok = /1 個（?\d*%?）?/.test(out) && /從來沒有被算繪出來/.test(out) && /這句從未出現/.test(out);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 數得出「幾個介面字串從來沒被算繪出來」`);

    /*
     * ── 那個分母要說得出自己是怎麼來的 ──────────
     *
     * 第 6 輪（第三十五圈）用第二種算法對這個數字：那兩個檔案裡一共 236 個
     * 字串值，扣掉單字與帶 `{佔位符}` 的 45 個才是 191 —— **19% 被跳過了**。
     * 只印 191 的話，「35 個沒被算繪」會被讀成 35／236。
     *
     * 這一格驗的是那句話在，而且**跳過的數字是真的數出來的**（不是寫死的 0）。
     * fixture 的 ui.ts 裡刻意放了一個帶佔位符的字串，所以它一定大於 0。
     */
    const skip = /另外跳過 (\d+) 個單字或帶/.exec(out);
    const okSkip = skip !== null && Number(skip[1]) > 0;
    if (!okSkip) failed++;
    console.log(
      `  ${okSkip ? '✓' : 'X'} 那個分母說得出自己跳過了幾個` + (skip ? `（${skip[1]} 個）` : ''),
    );
    if (!okSkip) console.log('        ' + (out.split('\n').find((l) => l.includes('分母')) ?? '（那一行沒印）'));
    if (!ok) console.log('        ' + out.split('\n').filter((l) => l.includes('算繪')).join('\n        ') || '        （那一段完全沒印）');

    /*
     * 直接看「例如：」那一行有沒有把它列進去 —— 比對可見文字的話
     * `aria-label` 裡的字會被當成沒算繪出來，那一行就會出現它。
     */
    const egLine = out.split('\n').find((l) => l.includes('例如：')) ?? '';
    const ok2 = egLine !== '' && !egLine.includes('這句在屬性裡');
    if (!ok2) failed++;
    console.log(`  ${ok2 ? '✓' : 'X'} 出現在屬性裡的字不算「沒被算繪」（反向案例）`);
    await rm(dir, { recursive: true, force: true });
  }

  /*
   * ── 英文覆蓋 ────────────────────────────────────────
   *
   * 第 6 輪（第三十圈）：`site.ts` 的文案型別上兩種語言都必填
   * （`satisfies L10n`），`ui.ts` 的 `en` 是 `Partial` —— 選填。
   * 兩邊裝的是同一種東西，而 `ui.ts` 少一句 `en` **什麼都不會發生**：
   * `pick()` 安靜地退回中文，英文讀者看到中文，沒有關卡會響。
   *
   * 那個 `Partial` 是刻意的，所以不擋，只把覆蓋率說出來。
   * 這幾格守的是「說出來的數字是真的」。
   */
  /*
   * ── 那個分母，跟靠它算出來的每一個百分比 ────────────
   *
   * 第 6 輪（第三十二圈）實測：把「含漢字的 N 行」一律印成 0 —— **全綠**；
   * 把 `--verbose` 的百分比一律印成 99% —— **也全綠**。
   *
   * 那兩個數字不是裝飾。第二十一圈加 `subject`、第二十九圈加百分比，
   * 為的都是同一件事：**一條判斷過 599 行的規則，跟判斷過 6 行的，
   * 綠燈的意思完全不一樣。** 分母錯了，那整套說法就一起錯，
   * 而在這之前沒有任何東西會說話。
   *
   * 語料是可以手算的：3 行含漢字（其中一行同時有漢字與拉丁字母，
   * 所以 `cjk-latin-space` 的主體剛好是 1）。
   */
  {
    const dir = await mkdtemp(join(tmpdir(), 'copy-pct-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(
      join(dir, 'dist/index.html'),
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head>\n' +
        '<body>\n<p>第一行有漢字</p>\n<p>second line ascii only</p>\n' +
        '<p>這是用 Astro 建的站</p>\n<p>第四行也有漢字</p>\n</body></html>\n',
      'utf8',
    );
    const out = await check(dir, ['--verbose']);

    const scope = /掃了 \d+ 個檔案、\d+ 行（其中含漢字的 (\d+) 行）/.exec(out);
    const okCjk = scope !== null && Number(scope[1]) === 3;
    if (!okCjk) failed++;
    console.log(`  ${okCjk ? '✓' : 'X'} 含漢字的行數是真的數出來的（這份語料剛好 3 行）`);
    if (!okCjk) console.log('        ' + (out.split('\n').find((l) => l.includes('掃了')) ?? '（範圍那一行沒印）'));

    /*
     * 百分比要跟**印出來的**主體數與分母對得起來 —— 自己算一次再比。
     * 只驗「有印百分比」的話，「一律印 99%」會過。
     */
    const rows = [...out.matchAll(/^\s*(\d+)\s+([a-z-]+)　佔含漢字的行 ([\d.]+)%$/gm)];
    const base = scope ? Number(scope[1]) : 0;
    const wrong = rows.filter(([, n, , pct]) => {
      const want = Math.round((Number(n) / (base || 1)) * 1000) / 10;
      return Math.abs(want - Number(pct)) > 0.05;
    });
    const okPct = rows.length > 0 && base > 0 && wrong.length === 0;
    if (!okPct) failed++;
    console.log(`  ${okPct ? '✓' : 'X'} 每一條的百分比都等於「主體數 ÷ 含漢字的行數」`);
    if (!okPct) {
      console.log(
        '        ' +
          (rows.length === 0
            ? '一列百分比都沒抓到 —— 這一格等於沒驗'
            : wrong.map(([, n, id, pct]) => `${id}：印 ${pct}%，${n}／${base} 應該是 ${Math.round((Number(n) / base) * 1000) / 10}%`).join(' ｜ ')),
      );
    }

    await rm(dir, { recursive: true, force: true });
  }

  /*
   * ── 哪幾條要寫進文件，是一個決定 ────────────────────
   *
   * 第 6 輪（第三十一圈）量到：排除清單原本是拿去過濾 `RULES` 的，
   * 而它要排除的 `unused-i18n-key` **從來就不在 `RULES` 裡** ——
   * 那個過濾器一條都沒濾掉。結果是對的，但理由跟程式做的事不是同一件：
   * 註解說「因為它是 ui.ts 的衛生」，程式其實是「因為它不在那份清單裡」。
   *
   * 現在排除作用在全部 8 條上，而且會把決定印出來。這一格守的是
   * **兩個數字加得起來** —— 少了它，「只算 5 條」跟「8 條扣掉 3 條」
   * 在輸出上是同一個數字。
   */
  {
    const dir = await mkdtemp(join(tmpdir(), 'copy-doc-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await writeFile(join(dir, 'CLAUDE.md'), realClaude, 'utf8');
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs/CONTENT.md'), realContent, 'utf8');
    await writeFile(
      join(dir, 'dist/index.html'),
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body><p>一段字。</p></body></html>',
      'utf8',
    );
    const out = await check(dir);
    const m = /文件要求：(\d+) 條規則裡 \*\*(\d+) 條\*\*要同時寫進 .+？；(\d+) 條不用/.exec(out)
      ?? /文件要求：(\d+) 條規則裡 \*\*(\d+) 條\*\*要同時寫進 [^；]+；(\d+) 條不用/.exec(out);
    const ok = m !== null && Number(m[2]) + Number(m[3]) === Number(m[1]);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 「要寫進文件的」加「不用的」等於規則總數`);
    if (!ok) {
      console.log('        ' + (m ? `${m[2]} ＋ ${m[3]} ≠ ${m[1]}` : (out.split('\n').find((l) => l.includes('文件要求')) ?? '那一行根本沒印')));
    }
    /*
     * ── 純函式的那三格 ────────────────────────────────
     *
     * 上面兩格驗的是輸出，而輸出在**今天的資料上分不出新舊兩種寫法**：
     * 舊的只過濾 `RULES`（5 條），新的過濾全部 8 條扣掉排除的 3 條 ——
     * 剛好也是同一批 5 條。突變「改回只過濾 RULES」照樣全綠。
     *
     * 要分得出來，得餵一組「多了一條沒被排除的 extra」的資料，
     * 而那只有純函式餵得進去。
     */
    {
      const why = new Map([['x-hygiene', '不是寫作約定']]);
      const d = documentationDuty(['taiwan-tai', 'x-hygiene', 'x-new-extra'], why);
      const okPure =
        d.required.join('｜') === 'taiwan-tai｜x-new-extra' &&
        d.excluded.join('｜') === 'x-hygiene' &&
        d.unknown.length === 0;
      if (!okPure) failed++;
      console.log(`  ${okPure ? '✓' : 'X'} 沒被排除的 extra 一樣要寫進文件（只過濾語料規則的話會漏掉它）`);
      if (!okPure) console.log(`        required=[${d.required}] excluded=[${d.excluded}]`);

      /* 反向：排除清單裡有不存在的規則時要說出來，不然「加起來剛好」是假的 */
      const ghost = documentationDuty(['taiwan-tai'], new Map([['no-such-rule', '？']]));
      const okGhost = ghost.unknown.join('｜') === 'no-such-rule' && ghost.excluded.length === 0;
      if (!okGhost) failed++;
      console.log(`  ${okGhost ? '✓' : 'X'} 排除清單裡有不存在的規則時會被指出來`);

      /* 反向：排除清單是空的時候，全部都要寫進文件 */
      const none = documentationDuty(['a', 'b'], new Map());
      const okNone = none.required.length === 2 && none.excluded.length === 0;
      if (!okNone) failed++;
      console.log(`  ${okNone ? '✓' : 'X'} 排除清單是空的時候全部都要寫（反向案例）`);
    }

    /* 三條被排除的都要說出理由 —— 只列 id 的話，排除仍然是一個沒有說明的動作 */
    const reasons = [...out.matchAll(/· ([a-z0-9-]+)：(.+)/g)].filter(([, , why]) => why.trim().length > 4);
    const ok2 = m !== null && reasons.length === Number(m[3]);
    if (!ok2) failed++;
    console.log(`  ${ok2 ? '✓' : 'X'} 每一條被排除的都寫了為什麼`);
    if (!ok2) console.log(`        列了 ${reasons.length} 條理由，而說有 ${m?.[3] ?? '?'} 條被排除`);
    await rm(dir, { recursive: true, force: true });
  }

  {
    /**
     * @param {string} label
     * @param {string} ui
     * @param {(out: string) => boolean} want
     */
    const withUi = async (label, ui, want) => {
      const dir = await mkdtemp(join(tmpdir(), 'copy-en-'));
      await mkdir(join(dir, 'dist'), { recursive: true });
      await mkdir(join(dir, 'src/i18n'), { recursive: true });
      await writeFile(join(dir, 'src/i18n/ui.ts'), ui, 'utf8');
      await writeFile(
        join(dir, 'dist/index.html'),
        '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body><p>x</p></body></html>',
        'utf8',
      );
      const out = await check(dir);
      const ok = want(out);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : 'X'} ${label}`);
      if (!ok) {
        const said = out.split('\n').filter((l) => l.includes('英文覆蓋')).join(' ｜ ');
        console.log('        ' + (said || '（完全沒提到英文覆蓋）'));
      }
      await rm(dir, { recursive: true, force: true });
    };

    await withUi(
      '三組裡一組沒有 en：數得出來，而且點名的是那一組',
      "export const ui = { 'a': { 'zh-TW': '甲', en: 'A' }, 'b': { 'zh-TW': '乙', en: 'B' }, 'c': { 'zh-TW': '丙' } };\n",
      (out) => /3 組文案裡 \*\*1 組沒有 en\*\*（67%）/.test(out) && /\bui\.ts\b/.test(out) && /ui\.c\b/.test(out),
    );
    /* 反向：全部都有 en 的時候要說「100%」，不是安靜跳過 —— 不然「有沒有這項檢查」看不出來 */
    await withUi(
      '全部都有 en：明講 100%（不是安靜跳過）',
      "export const ui = { 'a': { 'zh-TW': '甲', en: 'A' }, 'b': { 'zh-TW': '乙', en: 'B' } };\n",
      (out) => /2 組文案全部都有 en（100%）/.test(out),
    );
    /* 反向：空字串的 en 不算數 —— 有那個鍵但沒有內容，畫面上一樣是中文 */
    await withUi(
      'en 是空字串不算有（反向案例）',
      "export const ui = { 'a': { 'zh-TW': '甲', en: '' } };\n",
      (out) => /1 組文案裡 \*\*1 組沒有 en\*\*（0%）/.test(out),
    );
  }

  {
    /* 全部都畫出來了就不說那句話 */
    const dir = await mkdtemp(join(tmpdir(), 'copy-allrendered-'));
    await mkdir(join(dir, 'dist'), { recursive: true });
    await mkdir(join(dir, 'src/i18n'), { recursive: true });
    await writeFile(join(dir, 'src/i18n/ui.ts'), "export const ui = { 'a': { 'zh-TW': '有畫出來的字' } };\n", 'utf8');
    await writeFile(
      join(dir, 'dist/index.html'),
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body><p>有畫出來的字</p></body></html>',
      'utf8',
    );
    const out = await check(dir);
    const ok = !/從來沒有被算繪出來/.test(out);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 全部都畫出來了就不說那句話（反向案例）`);
    await rm(dir, { recursive: true, force: true });
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

  /*
   * ── 上面那一格在 `bad` 壞掉的時候是**空的** ──────────
   *
   * 第 6 輪（第三十九圈）驗到的。那一格的判斷是
   * 「`bad` 配得到、而 `subject` 配不到」—— 也就是說 `bad` 一個都配不到的時候，
   * 迴圈整個跳過，它照樣印綠勾（實測：把 `taiwan-tai` 的 `bad` 改成配不到任何東西，
   * 那一格與「每條規則都有違規樣本」**兩格都還是綠的**）。
   *
   * 整套測試會紅 —— 但紅的是別的格子（CASES 那幾格）。
   * 這一格自己說的是「subject 比 bad 寬」，而它在最需要說話的時候沒有主體。
   *
   * 所以先問一句更基本的：**每個違規樣本，它自己那條規則抓得到嗎。**
   */
  const notMatched = [];
  for (const rule of RULES) {
    for (const sample of rule.samples ?? []) {
      rule.bad.lastIndex = 0;
      if (!rule.bad.test(sample)) notMatched.push(`${rule.id}：「${sample}」`);
    }
  }
  const okSelf = notMatched.length === 0;
  if (!okSelf) failed++;
  console.log(`  ${okSelf ? '✓' : 'X'} 每個違規樣本，它自己那條規則都抓得到`);
  if (!okSelf) {
    console.log('      抓不到的：' + notMatched.join('、'));
    console.log('      —— 上面那一格在這種時候是**空的**（bad 配不到就整個跳過）。');
  }

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
/*
 * ── 邊界那則筆記，兩個方向都要對 ──────────
 *
 * 第 6 輪（第三十六圈）加的。那則筆記報的是「這一支看不到的地方
 * 現在有幾個」——而它最可能的壞法不是報錯，是**報一個漂亮的 0**：
 * 路徑指錯的時候一行註解都走不到，於是印出「邊界外面什麼都沒有」。
 *
 * 所以兩格：有註解的時候數得出來，沒有的時候要**說自己沒量到**。
 */
{
  const withCode = await build({
    'dist/index.html': html('<p>乾淨的一頁。</p>'),
    'src/x.ts': '/*\n * 這是一行含漢字的註解。\n */\nexport const x = 1;\n',
  });
  const out = await check(withCode);
  const m = /(\d+) 行含漢字/.exec(out);
  const okCount = m !== null && Number(m[1]) > 0;
  if (!okCount) failed++;
  console.log(`  ${okCount ? '✓' : 'X'} 邊界那則筆記數得出程式碼註解` + (m ? `（${m[1]} 行）` : ''));
  if (!okCount) console.log('        ' + out.split('\n').filter(Boolean).slice(-6).join(' | '));

  /* 反向：沒有 src／scripts 的時候不能印 0，要說自己沒量到 */
  const noCode = await build({ 'dist/index.html': html('<p>乾淨的一頁。</p>') });
  const out2 = await check(noCode);
  const okEmpty = /這次沒有量到/.test(out2) && !/0 行含漢字/.test(out2);
  if (!okEmpty) failed++;
  console.log(`  ${okEmpty ? '✓' : 'X'} 走不到程式碼時說「沒量到」，不印一個漂亮的 0`);
  if (!okEmpty) console.log('        ' + out2.split('\n').filter(Boolean).slice(-6).join(' | '));
}

console.log('─'.repeat(64));
/*
 * ── 第一次跑的人看得到什麼 ──────────
 *
 * 第 6 輪（第二十九圈）：這一支本來說「掃了 61 個檔案、13647 行」——
 * 說了掃了多少東西，沒說用幾條規則掃的。
 * 而 `--verbose` 多印的 8 行（每條規則真的有東西可判斷幾次，帶佔比）
 * 正是「綠燈代表什麼」的答案，卻沒人看得見。
 *
 * 這是第 1 輪點名的六支裡的最後一支。
 */
{
  const dir = await build({ 'dist/index.html': html('<p>乾淨的一頁。</p>') });
  /* check() 會在 finally 裡刪掉整個目錄，所以 --verbose 那次要先跑 */
  const { stdout: verbose } = await run('node', [
    '--experimental-strip-types',
    '--no-warnings=ExperimentalWarning',
    resolve(ROOT, 'scripts/check-copy.mjs'),
    `--root=${dir}`,
    '--verbose',
  ]).catch((/** @type {any} */ e) => ({ stdout: String(e?.stdout ?? '') }));
  const out = await check(dir);

  const okRules = /\d+ 條規則/.test(out);
  if (!okRules) failed++;
  console.log(`  ${okRules ? '✓' : 'X'} 範圍那一行說得出用了幾條規則`);
  if (!okRules) console.log('        ' + out.split('\n').filter(Boolean).slice(0, 6).join(' | '));

  const okVerbose = /--verbose/.test(out);
  if (!okVerbose) failed++;
  console.log(`  ${okVerbose ? '✓' : 'X'} 綠燈時說得出怎麼看「判斷過多少東西」（--verbose）`);
  if (!okVerbose) console.log('        ' + out.split('\n').filter(Boolean).slice(-4).join(' | '));

  const okQuiet = !/要看每條規則真的有東西/.test(verbose);
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} --verbose 模式不再提示自己（反向案例）`);
  if (!okQuiet) console.log('        ' + verbose.split('\n').filter(Boolean).slice(-4).join(' | '));
}

/*
 * ── `EXTRA_RULE_IDS` 這份名單自己對不對 ────────────────
 *
 * 第 6 輪（第四十二圈）加的。這一圈問「這份清單是誰維護的？漏一個會怎樣？」
 *
 * `EXTRA_RULE_IDS` 跟 `audit:privacy` 的 `STRUCTURAL_IDS` 是同一個角色：
 * **補 0 那一行用的名單**，而且結尾那句「N 條規則」也是
 * `RULES.length + EXTRA_RULE_IDS.length` 算出來的。
 *
 * 也就是說少登記一條的話有兩個後果，兩個都不會紅：
 *   那條規則在區塊沒跑到的時候整條從計數裡消失
 *   結尾印的規則數少一條
 *
 * **這不是假想的** —— 上一圈第 5 輪在 `audit:privacy` 上就抓到三條沒登記的
 * （沒有 `dist/` 的時候規則數從 31 掉到 28，而輸出連「沒跑」都沒說）。
 * 同一個形狀，這一支還沒有人守。
 */
{
  const src = await readFile(resolve(ROOT, 'scripts/check-copy.mjs'), 'utf8');
  const extra = [...(/const EXTRA_RULE_IDS = \[([^\]]*)\]/.exec(src)?.[1] ?? '').matchAll(/'([a-z0-9-]+)'/g)].map(
    (m) => m[1],
  );
  const ruleIds = RULES.map((r) => r.id);
  const used = new Set([
    ...[...src.matchAll(/saw\('([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bid:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
  ]);
  const unregistered = [...used].filter((id) => !ruleIds.includes(id) && !extra.includes(id)).sort();
  const neverUsed = extra.filter((id) => !used.has(id)).sort();
  const ok = extra.length > 0 && unregistered.length === 0 && neverUsed.length === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} EXTRA_RULE_IDS 跟 check-copy 用到的 id 對得上（${extra.length} 條）`);
  if (!ok) {
    if (extra.length === 0) console.log('        抽不到 EXTRA_RULE_IDS —— 這一格等於沒驗');
    if (unregistered.length > 0) {
      console.log(
        `        用到卻沒登記的：${unregistered.join('、')}\n` +
          '        補 0 那一行看不到它，結尾那句「N 條規則」也會少算一條。',
      );
    }
    if (neverUsed.length > 0) {
      console.log(`        登記了卻沒有人用的：${neverUsed.join('、')}　（規則刪了就順手拿掉）`);
    }
  }
}

console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
/*
 * ── 文件裡的正反例，跟規則對得上嗎 ────────────────
 *
 * 第 6 輪（第三十七圈）加的。文案這五條是七支關卡裡唯一早就有文件義務的
 * （`rule-not-documented` 要求兩份文件都寫到每一條的 id），
 * 所以「有沒有寫」那半題早就答完了 —— 剩下的是「寫的跟做的一樣嗎」。
 *
 * `docs/CONTENT.md` 特地跟她說：「反例都放在灰底的框裡，那種框不會被檢查，
 * 所以你可以放心照著看。」那句話是在請她**信任**那些例子。
 *
 * 判準不綁哪一條規則：`✗` 至少要有一條抓得到，`✓` 一條都不能抓到。
 * 這樣 `CLAUDE.md` 那一對（在「語氣」那一節、沒有規則 id 的標題）也守到了。
 */
{
  console.log('\n' + '─'.repeat(64));
  /*
   * 每一格都重建一份 —— `check()` 會在 `finally` 裡把整個目錄刪掉，
   * 所以不能像別的區塊那樣建一次用到底（第一版就是這樣，第二次呼叫 ENOENT）。
   */
  const withDocs = async (/** @type {string} */ body) => {
    const dir = await build({ 'dist/index.html': html('<p>乾淨的一頁。</p>') });
    const guideAt = join(dir, 'docs', 'CONTENT.md');
    await mkdir(dirname(guideAt), { recursive: true });
    await writeFile(guideAt, body, 'utf8');
    await writeFile(join(dir, 'CLAUDE.md'), body, 'utf8');
    return check(dir);
  };
  /* 五條規則的 id 都要出現，不然 rule-not-documented 會跟著響 */
  const ids = '`taiwan-tai` `halfwidth-punct` `cjk-latin-space` `straight-quotes` `halfwidth-ellipsis`\n';

  const good = await withDocs(ids + '```\n✗  用Astro建的站\n✓  用 Astro 建的站\n```\n');
  /*
   * 比對的是 `X [example-not-real]` 這個**問題**標記，不是 id 本身 ——
   * 那個 id 也會出現在「不用寫進文件的規則」那份說明裡，
   * 用 id 當判準的話這一格會被別的東西滿足（第一版就是這樣綠的）。
   */
  const okGood = !/\[example-not-real\]/.test(good);
  if (!okGood) failed++;
  console.log(`  ${okGood ? '✓' : 'X'} 例子對得上時不報`);
  if (!okGood) console.log('        ' + good.split('\n').filter((l) => /example-not-real/.test(l)).join(' ｜ '));

  const badTick = await withDocs(ids + '```\n✓  用Astro建的站\n```\n');
  const okTick = /\[example-not-real\]/.test(badTick) && /cjk-latin-space 會抓到它/.test(badTick);
  if (!okTick) failed++;
  console.log(`  ${okTick ? '✓' : 'X'} 標成正確寫法、規則卻抓得到 → 擋，並說出是哪一條`);
  if (!okTick) console.log('        ' + badTick.split('\n').filter(Boolean).slice(-4).join(' ｜ '));

  const badCross = await withDocs(ids + '```\n✗  這一句其實沒有任何問題。\n```\n');
  const okCross = /\[example-not-real\]/.test(badCross) && /沒有任何一條規則抓得到/.test(badCross);
  if (!okCross) failed++;
  console.log(`  ${okCross ? '✓' : 'X'} 標成反例、卻沒有規則抓得到 → 擋（文件在教不存在的規矩）`);
  if (!okCross) console.log('        ' + badCross.split('\n').filter(Boolean).slice(-4).join(' ｜ '));

  /* 反向：一個例子都抽不到要說話，不然文件改寫法之後這一格會安靜地什麼都不比 */
  const none = await withDocs(ids + '這一份完全沒有程式碼框。\n');
  const okNone = /一個 ✗／✓ 的例子都抽不到 —— \*\*這一格沒有在守\*\*/.test(none);
  if (!okNone) failed++;
  console.log(`  ${okNone ? '✓' : 'X'} 一個例子都抽不到時說「這一格沒有在守」`);
  if (!okNone) console.log('        ' + none.split('\n').filter(Boolean).slice(-4).join(' ｜ '));

}

/*
 * ── 英文覆蓋掉下來的時候，要說得出「這是回退」──────────────
 *
 * 第 6 輪（第三十八圈）：這一項的註解自己就寫著答案 ——
 * 「它從 100% 掉下來的時候，**要有人看得見**」，也就是**靠人**。
 * 而它刻意不擋（`ui.ts` 的 `en` 是選填），所以掉下來只是輸出裡的一個數字，
 * 讀起來像現況，不像回退。
 *
 * 記了一個基準之後，掉下來那一段會附上上一次的數字。
 */
{
  console.log('\n' + '─'.repeat(64));
  const withUi = async (/** @type {string} */ ui) => {
    const dir = await build({
      'dist/index.html': html('<p>乾淨的一頁。</p>'),
      'src/i18n/ui.ts': ui,
    });
    return check(dir);
  };

  const full = await withUi("export const ui = {\n  'a.b': { 'zh-TW': '中', en: 'EN' },\n};\n");
  const okFull = /全部都有 en（100%）/.test(full) && /記下的是 \d+ 組 \d+% ——/.test(full);
  if (!okFull) failed++;
  console.log(`  ${okFull ? '✓' : 'X'} 100% 的時候也說得出基準是多少`);
  if (!okFull) console.log('        ' + full.split('\n').filter((l) => /英文覆蓋|記下的/.test(l)).join(' ｜ '));

  const dropped = await withUi("export const ui = {\n  'a.b': { 'zh-TW': '中' },\n};\n");
  const okDrop = /\*\*這是回退\*\*/.test(dropped) && /沒有人會替你記得上一次是多少/.test(dropped);
  if (!okDrop) failed++;
  console.log(`  ${okDrop ? '✓' : 'X'} 掉下來時說「這是回退」，並附上上一次的數字`);
  if (!okDrop) console.log('        ' + dropped.split('\n').filter((l) => /英文覆蓋|回退/.test(l)).join(' ｜ '));

  /* 反向：沒掉的時候不該說回退 */
  const okQuiet = !/\*\*這是回退\*\*/.test(full);
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} 沒掉的時候不說回退（反向案例）`);

  /*
   * ── 分母不只那兩個 i18n 檔案 ──────────────────
   *
   * 第 6 輪（第四十三圈）量到的：那一圈只 import `ui.ts` 與 `site.ts`，
   * 而頁面自己也寫 `pick({ 'zh-TW': …, en: … }, locale)`。
   * `pick()` 收的是 `Partial`，所以少一個 `en` 型別不會響。
   * 實測拿掉 `about.astro` 的 `en: 'About'`：型別 0、build 0、
   * `check:copy` 0，而且照樣印「108 組文案全部都有 en（100%）」，
   * 同時 `dist/en/about/index.html` 的 `<title>` 變成「關於 — Fox Says」。
   *
   * `.astro` import 不了，所以改用文字上的括號配對抽 —— 而那種抽法
   * 要有東西驗它抽得準，見下一格。
   */
  const page = "---\nconst t = pick({ 'zh-TW': '關於' }, locale);\n---\n<h1>{t}</h1>\n";
  const dirPage = await build({
    'dist/index.html': html('<p>乾淨的一頁。</p>'),
    'src/i18n/ui.ts': "export const ui = {\n  'a.b': { 'zh-TW': '中', en: 'EN' },\n};\n",
    'src/pages/about.astro': page,
  });
  const outPage = await check(dirPage);
  const okPage = /2 組文案裡 \*\*1 組沒有 en\*\*/.test(outPage) && /src\/pages\/about\.astro/.test(outPage);
  if (!okPage) failed++;
  console.log(`  ${okPage ? '✓' : 'X'} 頁面裡的 L10n 物件也算進分母（.astro 也數）`);
  if (!okPage) console.log('        ' + outPage.split('\n').filter((l) => /英文覆蓋|about/.test(l)).join(' ｜ '));

  /*
   * 抽取方式有洞的時候要說出來，而不是印一個更大但可能是錯的分母。
   * 判準：文字抽到的組數必須跟 import 抽到的一樣（那兩個檔案兩種方式都做得到）。
   */
  const dirBlind = await build({
    'dist/index.html': html('<p>乾淨的一頁。</p>'),
    /* 動態組出來的 key：import 看得到，文字上的 `'zh-TW':` 看不到 */
    'src/i18n/ui.ts':
      "const KEY = 'zh' + '-TW';\nexport const ui = {\n  'a.b': { [KEY]: '中', en: 'EN' },\n};\n",
    'src/pages/about.astro': page,
  });
  const outBlind = await check(dirBlind);
  const okBlind = /對不上，所以不敢把別的檔案算進來/.test(outBlind);
  if (!okBlind) failed++;
  console.log(`  ${okBlind ? '✓' : 'X'} 兩種抽法對不上時說「不敢算」，不是印一個大分母`);
  if (!okBlind) console.log('        ' + outBlind.split('\n').filter((l) => /英文覆蓋|抽取|對不上/.test(l)).join(' ｜ '));
}

/*
 * ── 註解那個數字要分得開「引用」與「散文」──────────────
 *
 * 邊界那一段本來只印「命中 N 處」。第 6 輪（第四十四圈）逐處看過一次：
 * 四成在**解釋或測試這些規則的檔案**裡（那種檔案一定會寫出它禁止的東西），
 * 其餘幾乎只有一個詞。「N 處要不要改」跟「一個詞要不要統一」是兩個
 * 難度差很多的問題，而待辦上掛給站主的是前者。
 *
 * 判準是推導的：這個檔案有沒有把 `copy-rules.mjs` 讀進來。
 * 兩個方向都要 —— 不然「全部算成引用」或「一個都不算」都會靜靜通過。
 */
{
  console.log('\n' + '─'.repeat(64));
  const dir = await build({
    'dist/index.html': html('<p>乾淨的一頁。</p>'),
    /* 普通的註解散文：這個「台」該被算進散文那一堆 */
    'src/thing.ts': '/* 這是一個平台的說明。 */\nexport const x = 1;\n',
    /* 解釋規則的檔案：同一個字，但它 import 了規則本身 */
    'scripts/explainer.mjs': "import { RULES } from './lib/copy-rules.mjs';\n/* 例如「平台」會被擋。 */\nexport const y = RULES;\n",
  });
  const out = await check(dir);
  const m = /其中 (\d+) 處在\*\*解釋或測試這些規則的檔案\*\*/.exec(out);
  const p2 = /其餘 (\d+) 處是普通的註解散文，一共 (\d+) 種不同的字/.exec(out);
  const okSplit = m !== null && p2 !== null && Number(m[1]) === 1 && Number(p2[1]) === 1;
  if (!okSplit) failed++;
  console.log(`  ${okSplit ? '✓' : 'X'} 註解命中分得開「引用」與「散文」（各 1 處）`);
  if (!okSplit) console.log('        ' + out.split('\n').filter((l) => /處在|散文/.test(l)).join(' ｜ '));

  const okWord = /最多的是「平台」1 處/.test(out);
  if (!okWord) failed++;
  console.log(`  ${okWord ? '✓' : 'X'} 說得出最多的是哪個字`);
  if (!okWord) console.log('        ' + (out.split('\n').find((l) => l.includes('最多的是')) ?? '（沒印）'));
}

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
async function check(dir, /** @type {string[]} */ extra = []) {
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
      ...extra,
    ]);
    return stdout;
  } catch (err) {
    return String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
