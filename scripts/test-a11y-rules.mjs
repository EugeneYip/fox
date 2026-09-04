#!/usr/bin/env node
// @ts-check
/**
 * 無障礙規則的實測 —— `npm run test:a11y-rules`
 *
 * 每一條規則產生一頁「剛好違反它」的假頁面，跑 check-a11y，確認那條規則會響。
 * 另外產生一頁乾淨的，確認不會誤報。
 *
 * ## 為什麼需要這個
 *
 * 第三圈的八輪裡，有五輪的主要發現是同一類：
 * **一個看起來在運作的東西，其實沒有在檢查、或根本沒生效。**
 * （預算量錯單位、假資料太好壓、沒東西守 header、`-S` 看不到 commit message、
 * 媒體查詢不增加權重。）
 *
 * `check-a11y.mjs` 有 21 條規則，其中早期加的那些**從來沒被驗證過會不會響**。
 * 一條不會響的規則比沒有規則糟：它會讓人以為那件事已經有人在看了。
 *
 * ## 加新規則的時候
 *
 * 這支測試會列出「沒有測試案例」的規則並直接失敗 ——
 * 跟 test-privacy-rules.mjs 一樣的作法。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 包成一份完整的頁面；`head`／`body` 可以蓋掉預設值 */
function page({ lang = 'zh-Hant-TW', title = '測試頁', head = '', body = '' } = {}) {
  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>${head}</head>
<body><a class="skip-link" href="#main">跳到主要內容</a>
<header><nav aria-label="選單"><a href="/">首頁</a></nav></header>
<main id="main"><h1>標題</h1>${body}</main>
<footer>頁尾</footer></body></html>`;
}

/**
 * 英文頁專用的樣板：把框架文字也換成英文。
 *
 * `page()` 預設的「跳到主要內容」「選單」「首頁」「標題」「頁尾」都是中文，
 * 而在 `en/` 底下那些會**順帶觸發** `unlabelled-cjk`（文字）與
 * `unlabelled-cjk-attr`（`aria-label="選單"`）。
 *
 * 第 1 輪（第八圈）發現這件事時只修了當時新加的兩個案例；
 * 第 1 輪（第九圈）把所有 `en/` 案例都換過來 ——
 * 不然「這個案例響的是它自己那條嗎」永遠答不出來。
 *
 * @param {{ title?: string, head?: string, body?: string }} [o]
 */
const enPage = (o = {}) =>
  page({ lang: 'en', title: 'English', ...o })
    .replace('跳到主要內容', 'Skip to content')
    .replace('選單', 'Menu')
    .replace('首頁', 'Home')
    .replace('<h1>標題</h1>', '<h1>Title</h1>')
    .replace('<footer>頁尾</footer>', '<footer>Footer</footer>');

/**
 * 每一條規則一個案例。
 *
 * `file` 是相對於假 dist 的路徑（有些規則只看 en/ 底下）。
 * `also` 放額外需要的檔案 —— 有的規則要比對兩份文件才判定得出來。
 *
 * `rule` 覆寫「該響的是哪一條」—— 同一條規則有多種觸發形式時，
 * 案例名稱取的是情境，響的仍然是那條規則。
 * `quiet` 是**反向案例**：那一條規則**不該**響。
 * 少了反向案例，「把規則放寬到永遠不響」也會通過。
 *
 * `level` 釘住嚴重度（`'error'` 或 `'warn'`）。**warn 不會讓關卡紅燈**，
 * 所以「這一條是 error」是一個會被安靜改掉的事實 ——
 * 第 1 輪（第十四圈）的突變掃描量到：把 skip-link 從 error 改回 warn，
 * 所有案例照樣綠。
 *
 * @type {Record<string, { file?: string, html: string, also?: Record<string, string>, rule?: string, quiet?: boolean, coFires?: string[], level?: 'error'|'warn' }>}
 */
const CASES = {
  'html-lang': { html: page().replace('<html lang="zh-Hant-TW">', '<html>') },
  /*
   * 同一條規則的第二個案例：`data-lang` **不算** `lang`。
   *
   * 第 7 輪（第十二圈）拿這個當探針時發現整份都在漏：`attr()` 用 `\b` + 屬性名，
   * 而連字號後面就是一個單字邊界。上面那個案例抓不到，因為它把屬性
   * **整個拿掉**了 —— 從來沒有一頁同時「沒有 lang」又「有一個 data-lang」。
   */
  'html-lang（data-lang 不是 lang）': {
    rule: 'html-lang',
    html: page().replace('<html lang="zh-Hant-TW">', '<html data-lang="zh-Hant-TW">'),
  },
  title: { html: page().replace('<title>測試頁</title>', '') },
  h1: { html: page().replace('<h1>標題</h1>', '<p>沒有 h1</p>') },
  'heading-order': { html: page({ body: '<h4>跳過 h2 h3</h4>' }) },
  'empty-heading': { html: page({ body: '<h2></h2>' }) },
  /*
   * 反向：`aria-label` 給了標題可及名稱，螢幕閱讀器唸得出來 ——
   * 只是視覺上看不見。第 1 輪（第十六圈）拿這個當探針時 `empty-heading`
   * 響了，那是**冤枉**：那份標記沒有無障礙缺陷。
   * 判斷改成走 `hasAccessibleName()`（`button-name`／`link-name` 用的同一支）。
   */
  'empty-heading（名字來自 aria-label，不該報）': {
    rule: 'empty-heading',
    quiet: true,
    html: page({ body: '<h2 aria-label="這一節的名字"></h2><p>內文</p>' }),
  },
  /*
   * ── 同名不同去處 ──────────────────────────────────
   *
   * 螢幕閱讀器的連結清單沒有上下文：兩個都叫「看全部」的連結
   * 在那份清單裡分不出誰是誰。第 1 輪（第十八圈）從讀者那一側量到的，
   * 站上真的有（首頁兩個「看全部→」）。
   */
  'same-name-different-target': {
    level: 'warn',
    html: page({
      body: '<a href="/archive">看全部</a><a href="/elsewhere">看全部</a>',
    }),
  },
  /* 反向一：同名但**同一個去處**（只是重複的連結）不算問題 */
  'same-name-different-target（同名同去處，不該報）': {
    rule: 'same-name-different-target',
    quiet: true,
    html: page({ body: '<a href="/archive">看全部</a><a href="/archive/">看全部</a>' }),
  },
  /* 反向二：用 aria-label 分開之後就不該報 —— 那正是訊息教的改法 */
  'same-name-different-target（aria-label 分開了，不該報）': {
    rule: 'same-name-different-target',
    quiet: true,
    html: page({
      body:
        '<a href="/archive" aria-label="看全部：最近">看全部</a>' +
        '<a href="/elsewhere" aria-label="看全部：在別處">看全部</a>',
    }),
  },
  landmark: { html: page().replace('<main id="main">', '<div id="main">').replace('</main>', '</div>') },
  'nav-label': { html: page({ body: '<nav><a href="/x">沒有名字的導覽</a></nav>' }) },
  'duplicate-landmark-name': { html: page({ body: '<nav aria-label="選單"><a href="/y">同名</a></nav>' }) },
  'unnamed-region': { html: page({ body: '<section><p>沒有名字的 section</p></section>' }) },
  'img-alt': { html: page({ body: '<img src="/x.png">' }) },
  /*
   * 反向：無值的 `alt` 是合法的「這張圖是裝飾用的」寫法
   * （HTML 規定無值屬性的值是空字串），而 Astro 就是這樣輸出的。
   * 第 3 輪（第八圈）之前這會被誤報成「圖片沒有 alt」——
   * 而那個誤報看不見，因為站上沒有任何內容有封面圖。
   */
  'img-alt（無值的 alt 是裝飾圖，不該報）': {
    rule: 'img-alt',
    quiet: true,
    html: page({ body: '<img src="/x.png" alt>' }),
  },
  'button-name': { html: page({ body: '<button></button>' }) },
  'link-name': { html: page({ body: '<a href="/x"></a>' }) },
  /*
   * 裝飾符號留在可及名稱裡。
   *
   * 第 1 輪（第十一圈）用瀏覽器的無障礙樹量到全站有九個地方這樣寫，
   * 而同一個 repo 裡另外兩個地方早就用 aria-hidden 包起來了。
   */
  /*
   * 內容**整個**被 aria-hidden 藏起來 → 螢幕閱讀器唸不出任何東西。
   *
   * 第 1 輪（第十四圈）之前，`hasAccessibleName` 不看 aria-hidden
   * （而隔十幾行的 decorative-glyph-in-name 看），所以這種連結會安靜通過。
   * 原本的案例是 `<a href="/x"></a>`（空的）—— 空的跟「有字但唸不出來」
   * 是兩種形狀，而真實的站上用的是後者（分頁、章節標題都包 aria-hidden）。
   */
  'link-name（內容整個 aria-hidden 就沒有名字）': {
    rule: 'link-name',
    html: page({ body: '<a href="/x"><span aria-hidden="true">↗</span></a>' }),
  },
  /*
   * 反向：`aria-hidden="false"` 是「**不要**藏」，不是「藏」。
   * 突變掃描指出來的：把判斷放寬成「有 aria-hidden 就算藏起來」，
   * 上面那個正向案例照樣綠。
   */
  'link-name（aria-hidden="false" 不算藏起來）': {
    rule: 'link-name',
    quiet: true,
    html: page({ body: '<a href="/x"><span aria-hidden="false">前往</span></a>' }),
  },
  'decorative-glyph-in-name': { html: page({ body: '<a href="/x">前往 ↗</a>' }) },
  'decorative-glyph-in-name（包起來就不該報）': {
    rule: 'decorative-glyph-in-name',
    quiet: true,
    html: page({ body: '<a href="/x">前往 <span aria-hidden="true">↗</span></a>' }),
  },
  'decorative-glyph-in-name（aria-label 蓋掉內容，也不該報）': {
    rule: 'decorative-glyph-in-name',
    quiet: true,
    html: page({ body: '<a href="/x" aria-label="前往 YouTube">前往 ↗</a>' }),
  },
  'input-label': { html: page({ body: '<input type="text">' }) },
  'duplicate-id': { html: page({ body: '<p id="dup">一</p><p id="dup">二</p>' }) },
  'aria-ref': { html: page({ body: '<p aria-labelledby="不存在的id">指到不存在的東西</p>' }) },
  /* `level` 是第 5 輪（第十四圈）加的：那一輪把這條升成 error，
     而第 1 輪（第十四圈）的突變掃描示範過「改回 warn」不會有任何東西說話。 */
  'blank-rel': {
    level: 'error',
    html: page({ body: '<a href="https://example.com" target="_blank">外連沒有 rel</a>' }),
  },
  /*
   * `level: 'error'` 是第 1 輪（第十四圈）加的。那一輪把這條從 warn 升成
   * error（那個連結是 Base.astro 為每一頁畫的，44／44 都有，沒有正當例外），
   * 而突變掃描當場指出「改回 warn」所有案例照樣綠 —— warn 不會讓關卡紅燈，
   * 所以嚴重度本身也要有東西守著。
   */
  'skip-link': {
    level: 'error',
    html: page().replace('<a class="skip-link" href="#main">跳到主要內容</a>', ''),
  },
  /*
   * ── 判準要跟訊息說的是同一件事 ──────────────────
   *
   * 這一條本來只認 `class="skip-link"`，而訊息說的是
   * 「沒有『跳到主要內容』連結」。第 1 輪（第二十四圈）拿一個語意完全正確、
   * 只是 class 名字不同的跳轉連結當探針 —— 它照樣被報成「沒有」。
   * 照訊息去做不會變綠，要照它沒說的那件事去做才會。
   *
   * 判準改成也認「指向後面真的存在的錨點的 `<a href="#…">`」。
   * 下面三格守住那個放寬**沒有把不是跳轉連結的東西也放進來**。
   */
  'skip-link（class 名字不同但語意正確，不該報）': {
    rule: 'skip-link',
    quiet: true,
    html: page().replace(
      '<a class="skip-link" href="#main">跳到主要內容</a>',
      '<a class="jump" href="#main">跳到主要內容</a>',
    ),
  },
  /* 「回到頂端」那種：連結在錨點**後面**，救不了要穿過導覽列的人 */
  'skip-link（連結在錨點之後，還是要報）': {
    rule: 'skip-link',
    level: 'error',
    html: page({ body: '<p>內文</p><a href="#main">回到主要內容</a>' }).replace(
      '<a class="skip-link" href="#main">跳到主要內容</a>',
      '',
    ),
  },
  /* 指向不存在的錨點：按下去什麼都不會發生 */
  'skip-link（錨點不存在，還是要報）': {
    rule: 'skip-link',
    level: 'error',
    html: page()
      .replace('<a class="skip-link" href="#main">跳到主要內容</a>', '<a href="#nope">跳到主要內容</a>')
      .replace('<main id="main">', '<main>'),
  },
  /*
   * 這一條的判準是「英文頁的 <main> 跟對應的中文頁**一模一樣**」——
   * 那是明確的「忘了翻」。所以案例必須同時放兩份文件。
   *
   * 第一版只放了 en/index.html，規則沒響 —— 而那是**測試資料錯了，不是規則壞了**。
   * 留著這段註解，免得下次又以為規則失效。
   */
  'lang-content-mismatch': {
    file: 'en/index.html',
    html: page({ lang: 'en', title: 'English', body: '<p>這一頁忘記翻譯了。</p>' }),
    also: { 'index.html': page({ body: '<p>這一頁忘記翻譯了。</p>' }) },
    /*
     * **這一條不能用 enPage()。** 它的判準是「英文頁的 <main> 跟中文頁
     * 一模一樣」，而 `<h1>` 就在 <main> 裡 —— 把框架換成英文之後兩邊不再
     * 一樣，規則就不響了。第 1 輪（第九圈）先換成 enPage、被新加的斷言
     * 抓到「規則沒響」，才想清楚這件事。
     *
     * 所以中文框架在這裡是**必要的**，它順帶觸發的兩條就宣告出來：
     *   unlabelled-cjk       ← 內文是中文，那正是這一條的定義
     *   unlabelled-cjk-attr  ← 樣板的 aria-label="選單"
     */
    coFires: ['unlabelled-cjk', 'unlabelled-cjk-attr'],
  },
  'unlabelled-cjk': { file: 'en/x.html', html: enPage({ body: '<p>English text.</p><p>沒有標語言的中文</p>' }) },
  /*
   * 標了，但標錯。第 1 輪（第八圈）之前 `lang="en"` 會讓這條規則放行 ——
   * 而那正是最該抓的情況：螢幕閱讀器會照著那個假的宣告用英文語音唸中文。
   */
  'unlabelled-cjk（標成 en 也要抓）': {
    rule: 'unlabelled-cjk',
    file: 'en/x2.html',
    /*
     * 框架也要換成英文，理由跟下面的反向案例一樣 ——
     * 不換的話規則響的是模板的「標題」「頁尾」，**不是這裡要測的那一句**。
     * 第 1 輪（第八圈）第一版沒換，於是把判準改回鬆的也照樣通過：
     * 案例用錯的理由通過，突變驗證抓到的。
     */
    html: enPage({ body: '<p lang="en">這幾個字是中文</p>' }),
  },
  /*
   * 反向：標對了就不該抓。
   *
   * 這一份的框架文字必須換成英文 —— page() 預設的「標題」「首頁」「頁尾」
   * 在英文頁上本來就會觸發這條規則，反向案例會被自己的模板汙染。
   * （第一版就是這樣紅的，而那不是判準壞了。）
   */
  'unlabelled-cjk（標 zh 就放行）': {
    rule: 'unlabelled-cjk',
    quiet: true,
    file: 'en/x3.html',
    html: enPage({ body: '<p lang="zh-Hant">這幾個字是中文</p>' }),
  },
  /*
   * 反向：`data-title` **不是** `title`。
   *
   * 第 1 輪（第十三圈）量到的另一半 —— 同一個 `\b` 的成因，
   * 在這條規則上是**誤報**而不是漏報：`<span data-title="中文標題">`
   * 會被讀成「英文頁上有中文的 title 屬性」。
   */
  'unlabelled-cjk-attr（data-title 不是 title）': {
    rule: 'unlabelled-cjk-attr',
    quiet: true,
    file: 'en/x4.html',
    html: enPage({ body: '<span data-title="中文標題">plain english</span>' }),
  },
  /*
   * 用 iframe title 當案例不是隨便挑的：那正是 VideoFacade 實際會產生的東西
   * （title 是「〈詩名〉作者」），而它到第六圈為止從來沒有被算繪過。
   * lang="en" 是刻意寫的 —— 光有 lang 不該算過。
   */
  'unlabelled-cjk-attr': {
    file: 'en/z.html',
    html: enPage({ body: '<iframe lang="en" title="〈靜夜思〉李白"></iframe>' }),
  },
  'fullwidth-in-english': { file: 'en/y.html', html: enPage({ body: '<p>Last synced：September 3</p>' }) },
  /*
   * 這一條要靠 CSS 檔而不是 HTML。
   * 第 1 輪（第九圈）之前那個 CSS 是寫進**每一個**案例的暫存目錄的
   * （`EXTRA_FILES` 無條件展開），於是這條規則在 27 個案例裡響了 27 次 ——
   * 包括它自己那個。也就是說**它自己的案例證明不了任何事**。
   * 現在只給它自己。
   */
  'focus-outline-removed': {
    html: page({ head: '<link rel="stylesheet" href="/_astro/t.css">' }),
    also: { '_astro/t.css': '.tidy{outline:none}' },
  },
  /*
   * ── prefers-reduced-motion 的那道毯子 ──
   *
   * 第 1 輪（第二十六圈）實測：把 `global.css` 那個查詢改成
   * `no-preference`（意思正好相反），**六道關卡加兩套測試全部綠燈**。
   * 而受影響的人只會覺得不舒服，不會知道那是一行 media query ——
   * 沒有任何東西、也沒有任何人會來告訴我們。
   */
  'reduced-motion-blanket': {
    html: page({ head: '<style>.probe-x{transition:color .2s}</style>' }),
  },
  /* 反向：有那道毯子就不該報 */
  'reduced-motion-blanket（毯子在就不報）': {
    rule: 'reduced-motion-blanket',
    quiet: true,
    html: page({
      head:
        '<style>.probe-x{transition:color .2s}' +
        '@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important;' +
        'animation-duration:.01ms!important}}</style>',
    }),
  },
  /*
   * 反向二：只提到 `prefers-reduced-motion` 不算。
   *
   * 這個站真的有第二個那種區塊（`Foxfire.astro` 只停它自己那一個動畫），
   * 所以「字串搜得到」這種判準會在毯子被拿掉之後照樣通過。
   */
  'reduced-motion-blanket（只停一個動畫不算毯子）': {
    rule: 'reduced-motion-blanket',
    html: page({
      head:
        '<style>.probe-x{transition:color .2s}' +
        '@media (prefers-reduced-motion:reduce){.fox-fire{animation:none}}</style>',
    }),
  },
  /*
   * 判準有兩個部分，各要一格證明它撐得住 —— 否則拿掉那一半不會有人紅
   * （第二十五圈整圈都在講這個）。
   *
   * 這一格守的是「**reduce** 才算」：`no-preference` 的毯子意思正好相反，
   * 而站上真的發生過這種寫法（第 1 輪〔第二十六圈〕的突變就是它）。
   */
  'reduced-motion-blanket（no-preference 的毯子不算）': {
    rule: 'reduced-motion-blanket',
    html: page({
      head:
        '<style>.probe-x{transition:color .2s}' +
        '@media (prefers-reduced-motion:no-preference){*{transition-duration:.01ms!important;' +
        'animation-duration:.01ms!important}}</style>',
    }),
  },
  /* 這一格守的是「兩種都要關掉」：只關動畫、沒關轉場，不算毯子 */
  'reduced-motion-blanket（只關動畫沒關轉場不算）': {
    rule: 'reduced-motion-blanket',
    html: page({
      head:
        '<style>.probe-x{transition:color .2s}' +
        '@media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important}}</style>',
    }),
  },

  /*
   * 反向三：站上一個動效都沒有的話，這條規則沒東西可守 ——
   * 要進「這次沒有東西可看」的名單，不是報一個沒有主體的錯。
   */
  'reduced-motion-blanket（沒有動效就沒東西可守）': {
    rule: 'reduced-motion-blanket',
    quiet: true,
    html: page({ head: '<style>.probe-x{color:#000}</style>' }),
  },

  /*
   * 同一條規則，**內嵌的 `<style>`**。
   *
   * 第 2 輪（第十四圈）之前這條只讀 `dist/_astro/*.css`，而這個站幾乎所有
   * 樣式都是元件的 scoped style、被 Astro 內嵌進 HTML ——
   * 外部 21,251 bytes、內嵌 34,449 bytes，也就是這條規則守的是 38%。
   * 上面那個案例用的是外部檔案，所以這條路一次都沒被走過。
   */
  'focus-outline-removed（內嵌的 <style> 也要掃）': {
    rule: 'focus-outline-removed',
    html: page({ head: '<style>.probe-btn:focus{outline:none}</style>' }),
  },
  /* 反向：內嵌區塊裡自己補回來了就不該報（真實的搜尋框就是這樣寫的） */
  'focus-outline-removed（內嵌區塊裡補回來就不報）': {
    rule: 'focus-outline-removed',
    quiet: true,
    html: page({
      head: '<style>.probe-btn:focus{outline:none}.probe-btn:focus-visible{outline:2px solid red}</style>',
    }),
  },
  'positive-tabindex': { html: page({ body: '<button tabindex="3">插隊</button>' }) },
};

const tmp = await mkdtemp(join(tmpdir(), 'a11y-rules-'));
let failed = 0;

try {
  console.log('\n無障礙規則實測');
  console.log('─'.repeat(64));

  // 先確認「乾淨的一頁」不會誤報
  await writeFile(join(tmp, 'clean.html'), page(), 'utf8');
  const clean = await runCheck(tmp);
  if (clean.includes('沒有發現問題')) {
    console.log('  ✓ 乾淨的頁面不誤報');
  } else {
    failed++;
    console.log('  X 乾淨的頁面被誤報了：\n' + clean.split('\n').slice(0, 6).map((l) => '      ' + l).join('\n'));
  }

  /*
   * 「這次沒有東西可看的規則」那份名單要真的印出來。
   *
   * 第 1 輪（第十五圈）加的那段輸出，是為了把「檢查過而且沒問題」跟
   * 「沒有東西可檢查」分開 —— 而乾淨的那一頁沒有圖片、沒有 aria 參照、
   * 沒有 tabindex，所以那三條一定要出現在名單裡。
   */
  {
    const ok = /沒有東西可看的規則/.test(clean) && ['img-alt', 'aria-ref', 'positive-tabindex'].every((r) => clean.includes(r));
    console.log(`  ${ok ? '✓' : 'X'} 沒有東西可看的規則會被列出來`);
    if (!ok) {
      failed++;
      console.log('      預期名單裡有 img-alt、aria-ref、positive-tabindex。實際輸出：');
      console.log(clean.split('\n').filter((l) => l.includes('沒有東西可看')).map((l) => '        ' + l).join('\n') || '        （那一段完全沒有印）');
    }
  }

  for (const [label, { file, html, also, rule, quiet, coFires, level }] of Object.entries(CASES)) {
    const id = rule ?? label;
    const dir = await mkdtemp(join(tmpdir(), 'a11y-one-'));
    const target = join(dir, file ?? 'index.html');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, html, 'utf8');
    for (const [name, content] of Object.entries(also ?? {})) {
      const p = join(dir, name);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, content, 'utf8');
    }
    const out = await runCheck(dir);
    const fired = out.includes(`[${id}]`);
    const ok = quiet ? !fired : fired;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} ${label}`);
    if (level && fired) {
      /* 輸出裡 error 是 `X [id]`、warn 是 `! [id]` */
      const mark = level === 'error' ? 'X' : '!';
      if (!out.includes(`${mark} [${id}]`)) {
        failed++;
        console.log(`      嚴重度不對：預期 ${level}（輸出應該是「${mark} [${id}]」）`);
      }
    }
    /*
     * 順帶觸發到別的規則要先宣告（`coFires`），沒宣告就算失敗。
     *
     * 理由跟 test-content-rules 一樣：**一個同時響好幾條的案例，
     * 證明不了是哪一條讓它綠的。** 第 1 輪（第九圈）量之前，27 個案例裡有
     * 25 個順帶觸發 `focus-outline-removed`（fixture CSS 被寫進每個案例），
     * 而 `en/` 的案例還多拖兩條（樣板的中文框架與 `aria-label="選單"`）。
     */
    const allFired = [...new Set([...out.matchAll(/\[([a-z0-9-]+)\]/g)].map((m) => m[1]))];
    const undeclared = allFired.filter((x) => x !== id && !(coFires ?? []).includes(x));
    if (undeclared.length > 0) {
      failed++;
      console.log(`      這個 fixture 還順帶觸發了沒宣告的規則：${undeclared.join('、')}`);
      console.log('      要嘛把 fixture 收窄，要嘛在 coFires 裡寫出來。');
    }
    await rm(dir, { recursive: true, force: true });
  }

  /*
   * ── 每一條「必須修正」的訊息都要說「怎麼辦」──────────
   *
   * 第 1 輪（第十七圈）量到：24 條規則裡有 14 條只講事實、不講下一步
   * （「按鈕沒有可及名稱」「id 出現多次」），而站主不是工程師 ——
   * 看到那句話並不知道要打什麼字。
   *
   * 這一格守的是**已經補上下一步的那幾條不會退回去**。
   * 判準用「改法：」這個字串，因為那是這個 repo 現在的寫法；
   * 沒有一次補滿 24 條 —— 有些規則的事實本身就是改法（「沒有 h1」）。
   */
  /*
   * 有發現的時候要說「上面的路徑是產物」——，沒發現的時候不要多話。
   * 第 1 輪（第十七圈）量到：24 條規則印的位置全是 `dist/…html`，
   * 而沒有任何一句話提過那是 build 出來的、要改的是 `src/`。
   */
  {
    const dirty = await mkdtemp(join(tmpdir(), 'a11y-src-'));
    await writeFile(join(dirty, 'index.html'), page({ body: '<button></button>' }), 'utf8');
    const dirtyOut = await runCheck(dirty);
    const cleanDir = await mkdtemp(join(tmpdir(), 'a11y-src-ok-'));
    await writeFile(join(cleanDir, 'index.html'), page(), 'utf8');
    const cleanOut = await runCheck(cleanDir);
    const ok = dirtyOut.includes('要改的是 src/') && !cleanOut.includes('要改的是 src/');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 有發現時說明「路徑是產物、要改 src/」，沒發現時不多話`);
    await rm(dirty, { recursive: true, force: true });
    await rm(cleanDir, { recursive: true, force: true });
  }

  const NEEDS_FIX_HINT = [
    'button-name',
    'link-name',
    'input-label',
    'aria-ref',
    'blank-rel',
    'duplicate-id',
    'img-alt',
    'heading-order',
  ];
  {
    const missing = [];
    for (const id of NEEDS_FIX_HINT) {
      const label = Object.keys(CASES).find((k) => (CASES[k].rule ?? k) === id && !CASES[k].quiet);
      if (!label) { missing.push(`${id}（找不到案例）`); continue; }
      const c = CASES[label];
      const dir = await mkdtemp(join(tmpdir(), 'a11y-hint-'));
      const target = join(dir, c.file ?? 'index.html');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, c.html, 'utf8');
      for (const [name, content] of Object.entries(c.also ?? {})) {
        const q = join(dir, name);
        await mkdir(dirname(q), { recursive: true });
        await writeFile(q, content, 'utf8');
      }
      const out = await runCheck(dir);
      const line = out.split('\n').find((l) => l.includes(`[${id}]`)) ?? '';
      if (!line.includes('改法：')) missing.push(id);
      await rm(dir, { recursive: true, force: true });
    }
    if (missing.length > 0) {
      failed += missing.length;
      console.log(`\n  X 這些規則的訊息沒有講「改法：」：${missing.join('、')}`);
      console.log('      站主看到的是一句事實，不知道下一步要打什麼字。');
    } else {
      console.log(`  ✓ 需要講改法的 ${NEEDS_FIX_HINT.length} 條都講了`);
    }
  }

  /*
   * ── `--verbose` 要印出每條規則判斷過幾個元素 ──────────
   *
   * 第 1 輪（第二十一圈）加的。判準是數量不是有無：
   * 一條只判斷過 2 個元素的規則跟判斷過 899 個的，
   * 綠燈的意思完全不同 —— 而預設輸出只說得出「有沒有」。
   *
   * 兩格：`--verbose` 要有、預設不要有（那一行對日常沒有用）。
   */
  {
    const dir = await mkdtemp(join(tmpdir(), 'a11y-counts-'));
    /*
     * 要用**乾淨的**一頁 —— 那段統計印在「沒有發現問題」那條路上。
     * 第一版隨手寫了一頁沒有 skip-link 的 HTML，於是它報錯、提早結束，
     * 統計根本沒印。（測試紅了才發現錯的是 fixture。）
     */
    await writeFile(join(dir, 'index.html'), page({ body: '<a href="/a">連結</a>' }), 'utf8');
    const { stdout: verbose } = await run('node', [
      resolve(ROOT, 'scripts/check-a11y.mjs'),
      `--dir=${dir}`,
      '--verbose',
    ]).catch((/** @type {any} */ e) => ({ stdout: String(e?.stdout ?? '') }));
    const vOk = verbose.includes('每條規則實際判斷過的元素數') && /\d+\s+link-name/.test(verbose);
    if (!vOk) failed++;
    console.log(`  ${vOk ? '✓' : 'X'} --verbose 印出每條規則判斷過幾個元素`);

    const plain = await runCheck(dir);
    const pOk = !plain.includes('每條規則實際判斷過的元素數');
    if (!pOk) failed++;
    console.log(`  ${pOk ? '✓' : 'X'} 預設不印那一段（反向案例）`);
    await rm(dir, { recursive: true, force: true });
  }

  /*
   * ── 同一條規則報太多類的時候，報告要收得住 ──────────
   *
   * 第 1 輪（第十九圈）灌 500 篇假內容量到：`same-name-different-target`
   * 一次報 75 類、整份輸出 439 行。每一條訊息都對、都有改法，
   * 但沒有人會讀完 439 行 —— **內容一多，先不能用的是報告本身**。
   *
   * 三格一起：超過 3 類要收、`--verbose` 要全印、只有 2 類時不要多話。
   */
  {
    /** 產生 n 個「同名不同去處」的頁面，每頁一類 */
    const many = async (/** @type {number} */ n) => {
      const dir = await mkdtemp(join(tmpdir(), 'a11y-cap-'));
      for (let i = 0; i < n; i++) {
        const f = join(dir, `p${i}`, 'index.html');
        await mkdir(dirname(f), { recursive: true });
        await writeFile(
          f,
          '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body>' +
            `<main><a href="/a${i}">同一個名字 ${i}</a><a href="/b${i}">同一個名字 ${i}</a></main>` +
            '</body></html>',
          'utf8',
        );
      }
      return dir;
    };

    const dir = await many(6);
    const out = await runCheck(dir);
    const shown = (out.match(/\n  ! \[same-name-different-target\]/g) ?? []).length;
    const capped = out.includes('另外 3 類也是 same-name-different-target');
    const total = out.includes('建議處理（6 類）');
    const ok = shown === 3 && capped && total;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 同一條規則超過 3 類：只印 3 類，其餘收成一行（總數照實說）`);
    if (!ok) console.log(`      實際：印了 ${shown} 類、收合那一行 ${capped}、總數那一行 ${total}`);

    const { stdout: verbose } = await run('node', [
      resolve(ROOT, 'scripts/check-a11y.mjs'),
      `--dir=${dir}`,
      '--verbose',
    ]).catch((/** @type {any} */ e) => ({ stdout: String(e?.stdout ?? '') }));
    const vShown = (verbose.match(/\n  ! \[same-name-different-target\]/g) ?? []).length;
    const vOk = vShown === 6 && !verbose.includes('另外 3 類也是');
    if (!vOk) failed++;
    console.log(`  ${vOk ? '✓' : 'X'} --verbose 仍然全部印出來`);
    if (!vOk) console.log(`      實際：印了 ${vShown} 類`);
    await rm(dir, { recursive: true, force: true });

    /* 反向：沒有超過上限時不要多說那一行 */
    const few = await many(2);
    const fewOut = await runCheck(few);
    const fewOk = !fewOut.includes('類也是 same-name-different-target');
    if (!fewOk) failed++;
    console.log(`  ${fewOk ? '✓' : 'X'} 只有 2 類時不印「另外 N 類」（反向案例）`);
    await rm(few, { recursive: true, force: true });
  }

  // 有沒有規則漏了案例
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(resolve(ROOT, 'scripts/check-a11y.mjs'), 'utf8'),
  );
  /*
   * 規則清單**問腳本自己**（`--list-rules`），不從原始碼用正則抽。
   *
   * 第 1 輪（第二十五圈）改的：`check-workflows.mjs` 的註解早就寫過
   * 那個正則會漏掉多行寫法的呼叫，而這裡一直還在用同一招。
   * 現在 `check-a11y.mjs` 有 RULE_IDS，`add()` 也會擋住沒登記的 id。
   */
  const { stdout: ruleList } = await run('node', [
    resolve(ROOT, 'scripts/check-a11y.mjs'),
    '--list-rules',
  ]);
  const declared = new Set(ruleList.trim().split('\n').filter(Boolean));
  if (declared.size === 0) {
    failed++;
    console.log('\n  X --list-rules 什麼都沒印 —— 下面幾格會空過，那是假的綠燈');
  }
  const covered = new Set(Object.entries(CASES).map(([label, c]) => c.rule ?? label));
  /*
   * 每一條規則都要呼叫 `saw(id, n)`。
   *
   * 第 1 輪（第十五圈）加了「這次沒有東西可看的規則」那段輸出，
   * 而它的名單是從 `saw()` 的呼叫長出來的 —— 漏了呼叫的規則會**安靜地
   * 不出現在那份名單裡**，於是它的綠燈又變回「不知道是對還是空」。
   */
  const counted = new Set([...source.matchAll(/saw\('([a-z0-9-]+)'/g)].map((m) => m[1]));
  const uncounted = [...declared].filter((r) => !counted.has(r));
  if (uncounted.length > 0) {
    failed += uncounted.length;
    console.log(`\n  X 這些規則沒有呼叫 saw()：${uncounted.join('、')}`);
    console.log('      沒有計數的話，「這次沒有東西可看」那份名單就會漏掉它們。');
  }

  /*
   * ── 有幾條規則有「反向案例」──────────────────────
   *
   * 第十六圈問的是：**它會不會冤枉好人？** 一條規則只有正向案例的話，
   * 「該響的會響」是證明了，「不該響的不響」沒有 ——
   * 而誤報一次，人就學會忽略整道關卡（`check-copy.mjs` 早就寫過這句）。
   *
   * 第 1 輪（第十六圈）量到：24 條裡只有 7 條有反向案例，
   * 而那 7 條**全部是先出過誤報才補上的**。這裡只印出來不擋 ——
   * 一次補 17 個 fixture 是湊數，不是檢查。往後每一輪挑真的會冤枉人的補。
   */
  const quietFor = new Set(
    Object.entries(CASES).filter(([, c]) => c.quiet).map(([label, c]) => c.rule ?? label),
  );
  const noQuiet = [...declared].filter((r) => !quietFor.has(r));
  if (noQuiet.length > 0) {
    console.log(
      `\n  · 沒有反向案例的規則（${noQuiet.length}／${declared.size}）：${noQuiet.join('、')}`,
    );
    console.log('      它們只證明了「該響的會響」，沒有人確認過「不該響的不響」。');
  }

  /*
   * ── 一頁都沒有的時候，不能說「沒有發現問題」──────────
   *
   * 第 1 輪（第二十五圈）拿空的 dist 跑一次，原本的輸出是：
   *
   *     無障礙靜態檢查（0 頁）
   *     沒有發現問題。
   *     這次沒有東西可看的規則（1 條）：focus-outline-removed
   *
   * 25 條規則一條都沒跑，關卡是綠的，而那份「沒有東西可看」的名單
   * 只列了 1 條 —— 其餘 24 條的 saw() 都在逐頁迴圈裡，沒有頁面就整個消失。
   * 名單在最需要它的時候最安靜。
   */
  {
    const empty = await mkdtemp(join(tmpdir(), 'a11y-empty-'));
    let out = '';
    let code = 0;
    try {
      ({ stdout: out } = await run('node', [resolve(ROOT, 'scripts/check-a11y.mjs'), `--dir=${empty}`]));
    } catch (err) {
      const e = /** @type {{ stdout?: string, code?: number }} */ (err);
      out = String(e?.stdout ?? '');
      code = typeof e?.code === 'number' ? e.code : -1;
    }
    const ok = /一頁都沒有掃到/.test(out) && !/沒有發現問題/.test(out) && code === 1;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 一頁都沒有時：不說「沒有發現問題」，而且擋得住`);
    if (!ok) console.log('        ' + out.split('\n').filter(Boolean).join('\n        ') + `（exit ${code}）`);
    await rm(empty, { recursive: true, force: true });
  }

  /*
   * 有頁面、但那一頁什麼都沒踩到的時候，**每一條規則都要出現在計數裡**
   * （多數是 0）。少了補 0 那一步，只有真的跑過的規則會出現 ——
   * 而「沒出現」跟「這條規則不存在」在輸出上長得一模一樣。
   */
  {
    const dir = await mkdtemp(join(tmpdir(), 'a11y-backfill-'));
    await writeFile(
      join(dir, 'index.html'),
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body>' +
        '<a class="skip-link" href="#main">跳到主要內容</a><header><nav aria-label="主選單"><a href="/">首頁</a></nav></header>' +
        '<main id="main"><h1>標題</h1><p>一段字。</p></main></body></html>',
      'utf8',
    );
    const { stdout: out } = await run('node', [
      resolve(ROOT, 'scripts/check-a11y.mjs'),
      `--dir=${dir}`,
      '--verbose',
    ]).catch((/** @type {any} */ e) => ({ stdout: String(e?.stdout ?? '') }));
    const counted = new Set([...out.matchAll(/^\s*\d+\s+([a-z0-9-]+)$/gm)].map((m) => m[1]));
    const absent = [...declared].filter((r) => !counted.has(r));
    const ok = absent.length === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 每一條規則都出現在計數裡（${declared.size} 條，含 0）`);
    if (!ok) console.log(`        沒出現的：${absent.join('、')}`);
    await rm(dir, { recursive: true, force: true });
  }

  const missing = [...declared].filter((r) => !covered.has(r));
  if (missing.length > 0) {
    failed += missing.length;
    console.log(`\n  X 這些規則沒有測試案例：${missing.join('、')}`);
    console.log('      加規則就要加案例 —— 沒有案例的規則等於沒有人確認過它會響。');
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);

/** @param {string} dir */
async function runCheck(dir) {
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/check-a11y.mjs'), `--dir=${dir}`]);
    return stdout;
  } catch (err) {
    // 有 error 時 check-a11y 會 exit 1，輸出仍然在 stdout
    return String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  }
}
