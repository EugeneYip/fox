// @ts-check
/**
 * 內容比對的規則 —— 「原始碼裡不該出現什麼」。
 *
 * 為什麼是獨立的檔案：第 5 輪（第二圈）把 email 規則改窄了（它把
 * `undici@8.10.1` 這種版本字串誤判成信箱）。**把一條隱私規則改寬鬆是有風險的動作**
 * —— 改過頭就會漏掉真的洩漏，而且不會有任何地方報錯。
 *
 * 所以規則搬到這裡，讓 scripts/test-privacy-rules.mjs 能夠測到
 * **真正在跑的那份**：每一條都同時測「該抓到的有抓到」與「不該抓到的沒抓到」。
 */
/*
 * 這裡**沒有**本名、校名、城市那幾條規則了。
 *
 * 它們原本長這樣：`pattern: /她的本名/g`。也就是說，為了檢查「本名有沒有進
 * repo」，我們把本名寫進了 repo —— 而且這個檔案在 audit 自己的 ALLOWLIST 裡，
 * 所以它是唯一含有個資、卻剛好不會被檢查到的檔案。從第一個 commit 就在裡面。
 *
 * 現在那些值改由 lib/identity-needles.mjs 在執行時取得（本機讀
 * identity.local.ts，CI 讀 PRIVACY_NEEDLES secret），兩個都沒有的時候
 * audit 會明講「身分規則沒有跑」。
 */
/**
 * @typedef {object} PrivacyRule
 * @property {string} id
 * @property {'error'|'warn'} level
 * @property {RegExp} pattern
 * @property {string} why
 * @property {RegExp} [only]  只掃符合這個樣式的檔名。沒填就是全部都掃
 * @property {true} [aboutLoading]  這條守的是「站上會不會去載入它」，
 *   而不是「repo 裡有沒有這個字串」。**散文檔（docs 底下的 .md）不掃** ——
 *   那種檔案永遠不會被瀏覽器載入，寫在裡面的網域只是在講它。
 *   第 5 輪（第十六圈）量到：寫「不要用 fonts.googleapis.com」這句話的
 *   文件本身會被自己的稽核擋下來，三條規則都一樣。
 *   真的載入了由 `built-third-party-request` 掃產出抓（那條看的是 dist/）。
 */

/** @type {PrivacyRule[]} */
export const RULES = [
  // ── 個資硬編碼 ────────────────────────────────────
  {
    id: 'email',
    level: 'warn',
    /*
     * 兩個負向前瞻 + 一個「頂級網域必須是字母」的要求，缺一不可：
     *
     *   (?!\d)      —— 擋掉 `undici@8.10.1`、`@astrojs/check@0.9.10` 這種版本字串。
     *                  舊版沒有這個，於是每次在紀錄裡寫到套件版本就多一個誤報，
     *                  而**關卡裡的雜訊會讓人學會忽略警告**
     *   [a-z]{2,}$  —— 頂級網域一定是字母。`1.2.3` 的結尾是數字，不會通過
     *   example     —— 文件裡的示範信箱
     *
     * 改這條之前先跑 npm run test:privacy-rules，那裡有 6 個真信箱與
     * 10 個不該抓的字串。放寬到漏掉真的洩漏，不會有任何地方報錯。
     */
    pattern: /[\w.+-]+@(?!\d)(?!example\.|.*\.example)[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/gi,
    why:
      'Email 直接出現在原始碼裡會被爬蟲收走。' +
      '　改法：確認這是刻意的。要在頁面上留聯絡方式的話，走 privacy.ts 的 showEmail ' +
      '＋ identity.local.ts（那個檔案不會進版控）；只是範例的話換成 example.com 結尾的假信箱。',
  },

  // ── 第三方資源 ────────────────────────────────────
  {
    id: 'google-fonts',
    aboutLoading: true,
    level: 'error',
    pattern: /fonts\.googleapis\.com|fonts\.gstatic\.com/g,
    why:
      '外部字型會把訪客的 IP 送給 Google。' +
      '　改法：拿掉那一行，改用 tokens.css 裡既有的系統字型堆疊（`--font-serif` 那幾個）。',
  },
  {
    id: 'analytics',
    aboutLoading: true,
    level: 'error',
    pattern: /googletagmanager|google-analytics|gtag\(|plausible\.io|umami|hotjar|clarity\.ms|mixpanel/gi,
    why:
      '分析工具。privacy.analytics 設定為 "none"，這個站不做訪客追蹤。' +
      '　改法：拿掉那段程式碼。真的想知道有多少人看，用 GitHub Pages 的流量頁，' +
      '不要在站上放追蹤器。',
  },
  {
    id: 'raw-youtube-embed',
    aboutLoading: true,
    level: 'warn',
    pattern: /<iframe[^>]*youtube\.com\/embed/gi,
    why:
      '直接嵌入 YouTube 會在載入頁面時就送資料給 Google。' +
      '　改法：改用 VideoFacade 元件（`<VideoFacade url={⋯} />`）—— 它按了才載入。',
  },
  {
    id: 'third-party-cdn',
    aboutLoading: true,
    level: 'warn',
    pattern: /(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)/g,
    why:
      '執行期從第三方 CDN 取檔案。' +
      '　改法：把那個檔案下載下來放進 public/，再改成用站內路徑引用。',
  },

  // ── 常見疏漏 ─────────────────────────────────────
  {
    id: 'target-blank-no-rel',
    level: 'warn',
    /*
     * ── 第 1 輪（第十四圈）量到的兩個 bug ──────────
     *
     * 原本是 `/target=["']_blank["'](?![^>]*\brel=)/g`，兩個毛病：
     *
     * 1. **`(?![^>]*…)` 只往後看。** `rel` 寫在 `target` **前面**時看不到，
     *    於是誤報。這個站的 `ExternalLink.astro` 與 `SyndicationList.astro`
     *    現在剛好是「rel 在後面」，換個順序就會誤報。
     * 2. **`\brel=` 會配到 `data-rel=`。** 連字號後面就是一個單字邊界 ——
     *    跟第 1 輪（第十三圈）在 `check-a11y` 修掉的是同一族。
     *
     * `check:a11y` 的 `blank-rel` 守的是同一件事，而它在第 1 輪（第十三圈）
     * 就修好了。**上一圈修好了其中一份實作，這一份原封不動** ——
     * 因為沒有人問過「這件事是不是有兩個地方在守」。四種寫法實測：
     *
     *   寫法                        a11y      這一支（舊）
     *   target ＋ rel（順序正常）    通過      通過
     *   只有 target                 響        響
     *   rel 寫在 target 前面         通過      **誤報**
     *   target ＋ 只有 data-rel      響        **漏報**
     *
     * 現在改成：從標籤開頭起算，**整個標籤裡都沒有 `rel=`** 才算違規
     * （`\s` 開頭把 `data-rel` 排除掉）。順序不再有影響。
     *
     * 已知的限制：`[^>]*` 過不了屬性值裡的 `>`（例如 `title="a > b"`）。
     * 舊的寫法有同樣的限制，而產出裡 Astro 會把它逃脫成 `&gt;`。
     */
    /*
     * `(?![^>]*\{\.\.\.)` 是第 5 輪（第十六圈）加的：Astro 的展開語法
     * `<a target="_blank" {...attrs}>` 完全合法，而 rel 就在那個物件裡 ——
     * 字串比對看不進去。誤報探針量到這一個。
     *
     * 代價寫清楚：展開語法裡**沒有** rel 的話這條也不會響。
     * 取的是「不誤報」那一邊 —— 誤報會讓人學會忽略整道關卡，
     * 而 check:a11y 的 blank-rel 掃的是**產出**，那時 rel 已經算繪出來了，
     * 展開不展開都看得到。兩支合起來仍然守得住。
     */
    pattern: /<[a-zA-Z][a-zA-Z0-9-]*\b(?![^>]*\srel\s*=)(?![^>]*\{\.\.\.)[^>]*\starget\s*=\s*["']_blank["'][^>]*>/g,
    // 只掃會變成畫面的檔案。scripts/ 裡出現這串通常是「檢查這件事的正則」本身。
    only: /\.(astro|html|mdx?)$/,
    why:
      '外連沒有加 rel —— 新分頁拿得到原頁面的參照，也會帶上來源網址。' +
      '　改法：改用 ExternalLink 元件（它會自己補），或在那個標籤上加 rel={externalLinkRel}。',
  },
  {
    id: 'leftover-placeholder',
    level: 'warn',
    /*
     * 排除「在比對它」的寫法（`=== 'CHANGE_ME'`）。
     * 分界不是位置也不是副檔名，是**這串字是被指派的值，還是被比較的對象**。
     */
    pattern: /(?<![=!]==?\s*['"])CHANGE_ME/g,
    /*
     * 依**位置**篩，不是依副檔名。
     *
     * 原本寫的是 `/\.(md|mdx|json|ya?ml)$/`，理由是「程式碼裡出現 CHANGE_ME
     * 通常是在檢查它，不是忘了填」。那個直覺對，但選出來的集合剛好是反的 ——
     * 第 5 輪（第六圈）數過版控裡每一處 CHANGE_ME：
     *
     *   src/config/sources.mjs、src/lib/syndication.ts、scripts/…   全是 .mjs / .ts
     *   docs/REVIEW-LOG.md                                          唯一的 .md
     *
     * 也就是說：**真正的佔位字串住在被排除的副檔名裡**，而唯一掃得到的
     * 是一份在討論它的文件。這條規則六圈以來的實際產出只有誤報。
     *
     * 改成兩件事一起看：
     *   位置 —— src/ 與 .github/ 底下沒填完的東西會上線，那才是問題；
     *           docs/ 是在講這件事，scripts/ 是在檢查這件事
     *   寫法 —— 見下面 pattern 的註解。光看位置還不夠：
     *           src/lib/syndication.ts 裡就有一行在比對這個字串
     */
    only: /^(src|\.github)\//,
    why:
      '還有沒填的佔位字串（CHANGE_ME 之類）。' +
      '　改法：把它換成真的值。如果這是 sources.mjs 的範本，記得那一整塊本來是註解 —— ' +
      '複製之後要填 handle（她在那個平臺的帳號名）；' +
      '不確定帳號存不存在的話，先跑 `npm run handle <帳號名>` 看看。',
  },
];
