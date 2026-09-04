/**
 * 介面文案 —— 所有會出現在畫面上的固定字串都放這裡。
 *
 * 規則：zh-TW 是基準，一定要有；en 缺的部分會自動退回 zh-TW，
 * 所以可以先只翻一半，網站不會因此壞掉或出現空白。
 *
 * （這裡本來寫「en / ja」。`ja` 在 2026-09-02 就全部移除了 ——
 * 全站唯一還把它當成現役語言的一句話，就是這一句。
 * 第 6 輪〔第二十四圈〕數過：89 個鍵，兩種語言都有，一個都沒缺。）
 */
import type { Locale } from '@config/site';

export const ui = {
  // ── 導覽與框架 ─────────────────────────────────────
  'nav.skipToContent': { 'zh-TW': '跳到主要內容', en: 'Skip to content' },
  'nav.menu': { 'zh-TW': '選單', en: 'Menu' },
  'nav.language': { 'zh-TW': '語言', en: 'Language' },
  'nav.theme': { 'zh-TW': '切換深淺色', en: 'Toggle theme' },
  /*
   * 上下篇導覽的名稱。
   * 原本跟主選單共用 'nav.menu'，結果同一頁出現兩個都叫「選單」的
   * navigation 地標 —— 螢幕閱讀器的地標清單裡分不出哪個是哪個。
   */
  'nav.adjacent': { 'zh-TW': '上下篇', en: 'Previous and next' },
  // 三段循環的按鈕，每個狀態要能被唸出來 —— 只有一句「切換深淺色」的話，
  // 螢幕閱讀器使用者按下去不知道現在切到哪裡了。
  'theme.system': { 'zh-TW': '目前跟隨系統設定', en: 'Currently following system' },
  'theme.light': { 'zh-TW': '目前是淺色', en: 'Currently light' },
  'theme.dark': { 'zh-TW': '目前是深色', en: 'Currently dark' },
  'theme.next': { 'zh-TW': '按一下改為{next}', en: 'press to switch to {next}' },
  // 兩句之間的分隔符號。中文用全形逗號，英文用半形加空格 —— 寫死一種會讓另一種讀起來很怪
  'theme.join': { 'zh-TW': '，', en: ', ' },
  'theme.nameSystem': { 'zh-TW': '跟隨系統', en: 'system' },
  'theme.nameLight': { 'zh-TW': '淺色', en: 'light' },
  'theme.nameDark': { 'zh-TW': '深色', en: 'dark' },

  // ── 首頁 ──────────────────────────────────────────
  'home.latest': { 'zh-TW': '最近', en: 'Latest' },
  'home.elsewhere': { 'zh-TW': '在別處', en: 'Elsewhere' },
  'home.viewAll': { 'zh-TW': '看全部', en: 'See all' },
  /*
   * 「看全部」的可及名稱 —— 畫面上只寫「看全部」，但同一頁有兩個
   * （最近、在別處），螢幕閱讀器的連結清單裡分不出誰是誰
   *（第 1 輪〔第十八圈〕從讀者那一側量到的）。
   *
   * 標點放在這裡而不是寫在元件的模板字串裡：中文用全形冒號、英文用介系詞，
   * 寫死一個符號的話英文頁會出現全形標點（`fullwidth-in-english` 當場抓到）。
   */
  'home.viewAllOf': { 'zh-TW': '看全部：{section}', en: 'See all in {section}' },
  'home.emptyTitle': { 'zh-TW': '洞還是空的', en: 'The den is still empty' },
  'home.emptyBody': {
    'zh-TW': '第一篇還沒寫。狐狸正在磨爪子。',
    en: 'Nothing written yet. The fox is sharpening her claws.',
  },

  // ── 內容類型 ───────────────────────────────────────
  'type.post': { 'zh-TW': '文章', en: 'Writing' },
  'type.poem': { 'zh-TW': '詩詞', en: 'Poem' },
  'type.note': { 'zh-TW': '短札', en: 'Note' },

  // 列表頁的標題。英文要用複數，跟上面的單數型別標籤分開。
  'section.poems': { 'zh-TW': '詩詞', en: 'Poems' },
  'section.writing': { 'zh-TW': '文章', en: 'Writing' },
  'section.notes': { 'zh-TW': '短札', en: 'Notes' },
  'poems.lead': {
    'zh-TW': '一首一首讀過去。原文、注、白話，還有一點自己的話。',
    en: 'One poem at a time: the original, some notes, a plain retelling, and a few words of my own.',
  },
  'writing.lead': {
    'zh-TW': '讀書筆記、隨筆、翻譯。寫得比較長的東西都在這裡。',
    en: 'Reading notes, essays, translations. The longer pieces live here.',
  },
  'notes.lead': {
    'zh-TW': '一兩段的東西。不夠寫成一篇，但想留著。',
    en: 'A paragraph or two. Not enough for an essay, but worth keeping.',
  },

  // ── 詩詞頁 ────────────────────────────────────────
  'poem.plain': { 'zh-TW': '白話', en: 'In plain words' },
  'poem.notes': { 'zh-TW': '注', en: 'Notes' },
  'poem.thoughts': { 'zh-TW': '狐狸說', en: 'The fox says' },
  'poem.vertical': { 'zh-TW': '直排', en: 'Vertical' },
  'poem.horizontal': { 'zh-TW': '橫排', en: 'Horizontal' },
  'poem.listen': { 'zh-TW': '聽朗讀', en: 'Listen' },
  /*
   * 相關的詩（frontmatter 的 related，例如同一組唱和）。
   *
   * 原本這個區塊借用了 `home.latestPoems`（「最近讀的詩」）—— 意思是錯的：
   * 列出來的是**相關**的詩，不是最近讀的。它一直沒被發現，因為
   * `related` 到第 3 輪（第七圈）為止**沒有任何一首詩填過**，
   * 那個區塊從來沒有被算繪出來。
   *
   * 那個被借用的鍵在第 6 輪（第七圈）刪掉了 —— 首頁的區塊叫「最近」
   * （`home.latest`），從來沒有「最近讀的詩」這個區塊。
   * **一個沒有人用的字串，就是下一次借錯的來源。**
   */
  'poem.related': { 'zh-TW': '相關的詩', en: 'Related poems' },
  // 直橫排切換鈕的狀態播報。跟主題切換鈕同一個做法：說出現況與按下去會發生什麼
  /*
   * 句式跟主題切換鈕對齊 —— 那邊組出來是
   * 「目前是深色，按一下改為淺色」/ "Currently dark, press to switch to light"。
   * 同一個網站上兩個切換鈕，螢幕閱讀器唸出來的句子結構應該一樣。
   */
  'poem.nowVertical': {
    'zh-TW': '目前是直排，按一下改為橫排',
    en: 'Currently vertical, press to switch to horizontal',
  },
  'poem.nowHorizontal': {
    'zh-TW': '目前是橫排，按一下改為直排',
    en: 'Currently horizontal, press to switch to vertical',
  },
  // 中文用〈〉標篇名，英文不用書名號 —— 同樣是「標點跟著語言走」
  'poem.region': { 'zh-TW': '詩詞原文：〈{title}〉', en: 'The poem: {title}' },

  // ── 各處 / 聚合 ────────────────────────────────────
  'elsewhere.title': { 'zh-TW': '各處', en: 'Elsewhere' },
  'elsewhere.intro': {
    'zh-TW': '狐狸也在別的地方寫東西。這裡把它們收在一起。',
    en: 'The fox writes in other places too. Those pieces are collected here.',
  },
  'elsewhere.timeline': { 'zh-TW': '合併時間軸', en: 'Merged timeline' },
  'elsewhere.byPlatform': { 'zh-TW': '依平臺', en: 'By platform' },
  'elsewhere.visit': { 'zh-TW': '前往', en: 'Visit' },
  'elsewhere.readOn': { 'zh-TW': '在 {platform} 上讀', en: 'Read on {platform}' },
  /*
   * 標點在字串裡，不在模板裡。中文用全形冒號、英文用半形加空格 ——
   * 寫成 `${t('...')}：${date}` 的話，英文頁面就會出現「Last synced：Sep 3」。
   * check-a11y 的 fullwidth-in-english 規則守著這件事。
   */
  'elsewhere.lastSynced': { 'zh-TW': '上次同步：{date}', en: 'Last synced: {date}' },
  'elsewhere.notSyncedYet': {
    'zh-TW': '這個平臺還沒有同步到內容',
    en: 'Nothing synced from this platform yet',
  },
  /*
   * 「各處」頁空的時候的說明。
   *
   * 原本借用 `home.emptyBody`（「第一篇還沒寫。狐狸正在磨爪子。」）——
   * 在這一頁那句話是**錯的**：這裡的情況是「平臺還沒同步進來」，
   * 跟「她還沒寫第一篇」是兩件事。首頁同一個位置只給 title 不給 body，
   * 也就是那裡想過、這裡沒有。
   *
   * 第 8 輪（第八圈）第一次把真正的空站建出來（內容全草稿 ＋ syndication 清空）
   * 才看見 —— 在那之前這個組合從來沒有被算繪過。
   */
  'elsewhere.emptyBody': {
    'zh-TW': '還沒有任何平臺同步進來。這一頁的內容是建置時抓的，不是即時的。',
    en: 'Nothing has synced from any platform yet. What appears here is fetched at build time.',
  },
  'elsewhere.autoSynced': { 'zh-TW': '自動同步', en: 'Auto-synced' },
  'elsewhere.handPicked': { 'zh-TW': '手動挑選', en: 'Hand-picked' },

  // ── 列表與導航 ─────────────────────────────────────
  'list.empty': { 'zh-TW': '這裡還沒有東西。', en: 'Nothing here yet.' },
  /*
   * 空狀態指路 —— 第 3 輪（第十八圈）從讀者那一側量到的。
   *
   * 站上五篇已發佈的內容**全部是 zh-TW**，所以英文讀者在 /en/poems、
   * /en/writing、/en/notes 上看到的都是「Nothing here yet.」——
   * 而他無從得知「另一個語言其實有東西」。語言切換鈕在頁首，
   * 但沒有任何一句話把「這裡是空的」跟「那邊不是」連起來。
   *
   * 不翻譯內容（那會變成編造），只告訴他東西在哪裡。
   */
  /*
   * 「含各平臺」那一份 feed 的名字。第 4 輪（第十八圈）量到：
   * `/rss-all.xml` 建得出來、有 14 筆（其中 9 筆是她的影片），
   * 但整個 dist/ 裡**沒有任何一處指得到它** —— 訂閱的人只拿得到
   * /rss.xml 的 5 篇文章，而站上現在真正在更新的是那 9 支影片。
   *
   * 後綴連標點一起翻，不要在頁面上用字串拼 —— 英文頁上拼出全形括號會被
   * `fullwidth-in-english` 擋下來（第 1 輪〔第十八圈〕踩過一次）。
   */
  'rss.allSuffix': { 'zh-TW': '（含各平臺）', en: ' (also from other platforms)' },
  'elsewhere.subscribeAll': { 'zh-TW': '訂閱（含各平臺）', en: 'Subscribe (all platforms)' },

  /*
   * 平臺卡片上的兩條連結，可及名稱都要帶平臺名。
   * 第 1 輪（第十九圈）量到：/about 與 /elsewhere 上每一張卡片都有一個
   * 「看全部」與一個「前往」，**去處各不相同而名字一模一樣** ——
   * 現在只有一個平臺所以只撞到一次，平臺一多就是 N 對。
   */
  /*
   * 短札的來源。第 6 輪（第二十圈）第一次讓 `inResponseTo` 真的畫出來，
   * 畫面上只有「↳ 一篇別人寫的文章」—— 一個箭頭跟一個連結，
   * **沒有任何一個字說明那是什麼關係**。而箭頭是裝飾，螢幕閱讀器唸得到它，
   * 卻唸不到「這是這篇短札的來源」。
   */
  'note.inResponseTo': { 'zh-TW': '回應', en: 'In response to' },

  'elsewhere.visitOn': { 'zh-TW': '前往 {platform}', en: 'Visit {platform}' },

  'list.otherLang': { 'zh-TW': '英文版有 {n} 篇', en: 'There are {n} in Chinese' },
  'list.otherLang_one': { 'zh-TW': '英文版有 {n} 篇', en: 'There is {n} in Chinese' },
  'list.newer': { 'zh-TW': '較新', en: 'Newer' },
  'list.older': { 'zh-TW': '較舊', en: 'Older' },
  // 英文有單複數。zh-TW 不需要 _one，缺的話會自動退回主鍵。
  'list.count': { 'zh-TW': '共 {n} 篇', en: '{n} entries' },
  /*
   * 標籤頁數的是標籤，不是文章。第 6 輪（第十八圈）量到：/tags 上寫著
   * 「共 14 篇」，而站上只有 5 篇 —— 14 是標籤數。讀者會把它讀成文章數。
   */
  'tags.count': { 'zh-TW': '共 {n} 個標籤', en: '{n} tags' },
  'tags.count_one': { 'zh-TW': '共 {n} 個標籤', en: '{n} tag' },
  'list.count_one': { 'zh-TW': '共 {n} 篇', en: '{n} entry' },
  'list.readingTime': { 'zh-TW': '約 {n} 分鐘', en: '{n} min read' },
  'list.range': { 'zh-TW': '第 {from}–{to} 篇，共 {total} 篇', en: '{from}–{to} of {total}' },
  /*
   * JavaScript 關掉時的說明。
   *
   * 這一段原本直接寫死中文在 search.astro 裡，所以 /en/search 的
   * noscript 使用者看到的是一整句中文 —— 而那群人本來就處在受限的環境裡，
   * 是最不該再多一層障礙的。第二圈第 6 輪修的。
   *
   * 頁名用 {archive} 與 {tags} 代入（archive.title / tags.title），不要寫死「彙整」——
   * 那兩個詞在導覽列上也有，兩邊必須是同一個字。
   */
  'search.noJs': {
    'zh-TW': '站內搜尋需要 JavaScript。可以改用上方選單的「{archive}」與「{tags}」瀏覽。',
    en: 'Search needs JavaScript. You can browse via {archive} or {tags} in the menu above.',
  },
  'page.nav': { 'zh-TW': '分頁', en: 'Pagination' },
  'page.prev': { 'zh-TW': '上一頁', en: 'Previous' },
  'page.next': { 'zh-TW': '下一頁', en: 'Next' },
  /*
   * 標題上的頁碼後綴。**括號在字串裡，不在模板裡。**
   *
   * 原本三個地方都寫成 `${title}（${t('page.of', …)}）`，於是英文標題
   * 變成「YouTube（Page 2 of 3）」—— 全形括號夾著英文。
   * 而且中文的括號前不空格、英文的括號前要空一格，這種差異寫在模板裡表達不了。
   *
   * 這個 bug 只有在**內容多到有第 2 頁**時才看得見，真實內容量下完全不會出現。
   * 是用 npm run fixtures 灌到 80 篇之後才發現的。
   */
  'page.titleSuffix': {
    'zh-TW': '（第 {current} / {total} 頁）',
    en: ' (page {current} of {total})',
  },
  'page.goto': { 'zh-TW': '第 {n} 頁', en: 'Page {n}' },
  'series.position': { 'zh-TW': '第 {current} 篇，共 {total} 篇', en: '{current} of {total}' },

  // ── 標籤與彙整 ─────────────────────────────────────
  'tags.title': { 'zh-TW': '標籤', en: 'Tags' },
  'tags.taggedWith': { 'zh-TW': '標記為「{tag}」', en: 'Tagged “{tag}”' },
  'archive.title': { 'zh-TW': '彙整', en: 'Archive' },

  // ── 搜尋 ──────────────────────────────────────────
  'search.title': { 'zh-TW': '搜尋', en: 'Search' },
  'search.placeholder': { 'zh-TW': '找找看…', en: 'Search…' },
  'search.noResults': { 'zh-TW': '沒有找到相符的東西。', en: 'No matches found.' },
  'search.resultCount': { 'zh-TW': '{n} 個結果', en: '{n} results' },
  'search.resultCount_one': { 'zh-TW': '{n} 個結果', en: '{n} result' },
  'search.loading': { 'zh-TW': '載入索引中…', en: 'Loading index…' },
  'search.failed': { 'zh-TW': '索引載入失敗，請重新整理。', en: 'Could not load the index. Try reloading.' },
  'search.hint': {
    'zh-TW': '可以找標題、內文、標籤，也能找詩人的名字。',
    en: 'Looks through titles, body text, tags, and poets’ names.',
  },

  // ── 頁尾與其他 ─────────────────────────────────────
  'footer.builtWith': { 'zh-TW': '本站說明', en: 'About this site' },

  // ── 錯誤 ──────────────────────────────────────────
  'error.404.title': { 'zh-TW': '狐狸把這頁叼走了', en: 'The fox took this page' },
  'error.404.body': {
    'zh-TW': '這裡沒有你要找的東西。也許牠藏到別的洞去了。',
    en: 'Nothing here. Perhaps she buried it in another den.',
  },
  'error.404.back': { 'zh-TW': '回首頁', en: 'Back home' },

  // ── 外連提示 ───────────────────────────────────────
  'external.opensNewTab': { 'zh-TW': '（在新分頁開啟）', en: '(opens in a new tab)' },
  'external.embedBlocked': {
    'zh-TW': '為了不讓第三方在你不知情時記錄你，這段影片要按了才會載入。',
    en: 'To avoid third parties tracking you silently, this video loads only when you ask.',
  },
  'external.loadEmbed': { 'zh-TW': '載入並播放', en: 'Load and play' },
} as const satisfies Record<string, Record<'zh-TW', string> & Partial<Record<Locale, string>>>;

export type UiKey = keyof typeof ui;
