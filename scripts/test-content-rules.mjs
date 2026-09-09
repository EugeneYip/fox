#!/usr/bin/env node
// @ts-check
/**
 * 內容管線規則的實測 —— `npm run test:content-rules`
 *
 * 每一條規則做一份「該響」的假 src/content + 假 dist，跑 check-content，
 * 確認擋下來的是**那一條**。另外做一份乾淨的，確認不誤報。
 *
 * ## 為什麼需要這個
 *
 * `check-content.mjs` 是第 3 輪（第四圈）加的，到第 3 輪（第六圈）為止
 * **是唯一一支沒有測試的檢查腳本**（另外十支都有）。
 *
 * 而它自己的歷史正好說明為什麼需要：第 3 輪（第五圈）在裡面找到三個 bug ——
 * draft-leaked 對詩詞永遠不會響、missing-page 對英文內容誤報、
 * slug 大小寫在 macOS 上看不出來。三個都是「規則存在，但不會在該響的時候響」。
 *
 * 那次是靠手動放測試檔案發現的，發現完就把檔案刪了。
 * 這一份把那件事變成每次都會跑的東西。
 */
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 一頁產出。內容檢查只看字串有沒有出現，不需要真的像 HTML */
const page = (/** @type {string} */ body) =>
  `<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body>${body}</body></html>`;

/**
 * 一份最小但合法的 RSS 2.0。
 * `broken: 'xml'` 塞一個沒跳脫的 `&`（語法就壞了），
 * `broken: 'empty'` 是語法對但一筆都沒有 —— 兩種壞法要分得開。
 * @param {{ broken?: 'xml' | 'empty' }} [o]
 */
const feed = ({ broken } = {}) =>
  '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>' +
  `<title>狐說八道${broken === 'xml' ? ' & 別的' : ''}</title>` +
  '<link>https://bellafoxy.com/</link><description>詩詞</description>' +
  (broken === 'empty'
    ? ''
    : '<item><title>烏衣巷</title><link>https://bellafoxy.com/poems/wu-yi-xiang</link>' +
      '<pubDate>Mon, 01 Jan 2026 00:00:00 +0000</pubDate></item>') +
  '</channel></rss>';


/**
 * 一篇詩。用詩而不是文章當預設案例，是因為第 3 輪（第五圈）的三個 bug
 * 全部只在詩詞上出現 —— 詩詞頁顯示的是 poem.title，不是 frontmatter 的 title。
 */
const poem = (
  /** @type {{ title?: string, poemTitle?: string, first?: string, draft?: boolean, lang?: string }} */
  { title = '烏衣巷', poemTitle = title, first = '朱雀橋邊野草花', draft = false, lang = 'zh-TW' } = {},
) =>
  `---
title: ${title}
lang: ${lang}
${draft ? 'draft: true\n' : ''}poem:
  title: ${poemTitle}
  author: 劉禹錫
  original: |
    ${first}
    烏衣巷口夕陽斜
---
測試用。
`;

/*
 * 一份**通得過真 schema** 的假 syndication，帶一支可以對日期的影片。
 *
 * `external-date-drift` 與 `syndication-schema` 這兩條都吃這份檔案，
 * 所以它不能只放前者要的那兩個欄位 —— 少了 `$schema` 或欄位不齊，
 * `syndication-schema` 的主體會掉成 0，CLEAN 那一格的「沒東西可看」
 * 名單就會多一條，而那一格的意思正好是「這份名單該是空的」。
 *
 * @param {string} videoPublishedAt 那支影片在平臺上的發佈時刻
 */
const syndWith = (/** @type {string} */ videoPublishedAt) =>
  JSON.stringify({
    $schema: './syndication.schema.json',
    generatedAt: new Date().toISOString(),
    itemCount: 1,
    sources: {
      'youtube-x': {
        status: 'ok',
        platform: 'youtube',
        itemCount: 1,
        lastSuccessAt: new Date().toISOString(),
      },
    },
    items: [
      {
        id: 'youtube-x--fixturevid01',
        sourceId: 'youtube-x',
        platform: 'youtube',
        title: '一首詩的朗讀',
        url: 'https://www.youtube.com/watch?v=FIXTUREvid01',
        externalId: 'FIXTUREvid01',
        publishedAt: videoPublishedAt,
      },
    ],
  });

/** 那支假影片的發佈時刻。臺北時間是 2024-10-22 —— 刻意選一個 UTC 已經跨日的 */
const FIXTURE_VIDEO_AT = '2024-10-21T16:51:45.000Z';

/** 把一首詩接上那支假影片 */
const withVideo = (/** @type {string} */ md, /** @type {string} */ publishedAt) =>
  md.replace(
    'lang: zh-TW',
    `lang: zh-TW\npublishedAt: ${publishedAt}\nvideoUrl: https://www.youtube.com/watch?v=FIXTUREvid01`,
  );

/* 真的那份寫作指南 —— field-undocumented 的案例拿它改一個字當 fixture */
const REAL_GUIDE = await readFile(resolve(ROOT, 'docs/CONTENT.md'), 'utf8');

/**
 * 一頁「接線完整」的搜尋頁：`data-strings` 裡有指路用的三個鍵。
 * 宣告放在 CASES 與 CLEAN 兩個消費者之前。第一版只放到 CLEAN 前面
 * 就以為夠了 —— CASES 在更上面，於是 ReferenceError。這一圈第六次。
 */
const searchPage = (/** @type {string} */ lang, /** @type {string} */ json) =>
  `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><title>Search</title></head>` +
  /* 屬性用雙引號、裡面的引號逃脫成 &quot; —— Astro 產出的就是這個形狀 */
  `<body><main><form data-strings="${json.replaceAll('"', '&quot;')}"></form></main></body></html>`;

const SEARCH_PAGE = searchPage(
  'zh-Hant-TW',
  '{"otherLangOne":"有 1 篇","otherLangMany":"有 {n} 篇","otherLangHref":"/archive"}',
);

/*
 * fixture 用的是**真的那份 schema**，不是另寫一份小的。
 * 另寫一份就是同一個合約兩個地方，而測試會驗那份假的。
 */
const REAL_SYNDICATION_SCHEMA = await readFile(resolve(ROOT, 'src/data/syndication.schema.json'), 'utf8');

/* 列表頁的一個項目 —— `listing-order` 的案例與 CLEAN 的列表都用它 */
const listItem = (/** @type {string} */ d, /** @type {boolean} */ f) =>
  `<article><h2 class="entry__title"${f ? ' data-featured' : ''}>一篇</h2>` +
  `<time datetime="${d}">${d}</time></article>`;

/**
 * 每條規則一份假的 { content, dist }。
 * key 是規則 id，用來確認擋下來的是**那一條**。
 *
 * `also` 宣告「這個 fixture 預期還會順帶觸發哪幾條」。**沒有宣告的連帶觸發
 * 算失敗** —— 因為一個同時響好幾條的案例，沒辦法證明是哪一條讓它綠的。
 * 第 1 輪（第八圈）就踩過這個：無障礙的案例被測試樣板自己的中文觸發，
 * 規則確實響了，但響的不是案例要測的東西。
 *
 * `mustMention` 是「報告裡必須提到的字串」—— 用來確認**涵蓋範圍**而不只是
 * 「有沒有響」。一條規則掃三種檔案型別時，只響一次證明不了三種都掃到了。
 *
 * `extra` 是照原樣寫的相對路徑、`args` 是要多帶給腳本的旗標 ——
 * 兩個一起用，才寫得出「比對 content／dist 以外的檔案」那種案例。
 *
 * @type {Record<string, { content: Record<string, string>, dist: Record<string, string>, also?: string[], mustMention?: string[], expect?: string, noIndex?: boolean, guide?: string, extra?: Record<string, string>, args?: (dir: string) => string[] }>}
 */
const CASES = {
  /*
   * ── 列表的順序 ──────────────────────────────
   *
   * 第 3 輪（第四十六圈）加的。那一圈問「這一段如果拿掉，輸出會差在哪裡」——
   * 把 `getEntries()` 的 `sort` 拿掉，**dist 有 4 個檔案不一樣而沒有人說話**
   *（`poems/index.html` 的順序，加上三篇詩頁的上一篇／下一篇）。
   *
   * 判準不重寫一次排序（那會變成同一個判斷寫兩份），驗的是一個**性質**：
   * 拿掉 `data-featured` 的項目之後剩下的日期要遞減，
   * featured 那幾個彼此之間也要遞減。
   */
  'listing-order': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/index.html': page(listItem('2026-08-20', false) + listItem('2026-08-28', false)),
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
    },
  },

  'no-title': {
    content: { 'poems/x.md': '---\nlang: zh-TW\n---\n沒有 title 的東西。\n' },
    dist: { 'index.html': page('首頁') },
  },

  /*
   * 草稿的字串出現在產出裡。
   *
   * 這個案例刻意用**三個字的詩名**（烏衣巷）—— 中文的詩名兩三個字太常見了，
   * 而 needles 有一條 `n.length >= 4` 的過濾。如果只用四個字以上的標題測，
   * 這條規則對短標題的盲點就會被測試本身蓋掉。
   */
  /*
   * 標題**刻意含會被逃脫的字元**，而產出裡放的是逃脫之後的樣子。
   *
   * 第 3 輪（第十三圈）量到的：這支腳本拿原始碼的字去搜產出，而產出會逃脫
   * （Astro 的 HTML 出 `&quot;`／`&#39;`，RSS 的 XML 出 `&apos;`，
   * JSON 出 `\\"`）。原本的案例標題是純中文，逃脫前後長得一樣，
   * 所以這條路十三圈沒有被走過 —— 而含半形引號的草稿洩漏到八個檔案裡時，
   * 舊的實作**一個字都不會說**。
   *
   * 純中文那條路由底下的 CLEAN 守著（它要求正常的外站標題找得到）。
   */
  'draft-leaked': {
    content: {
      'poems/wu-yi-xiang.md': poem({ title: "談 <文心> & \"雕龍\" 的 '體例'", poemTitle: "談 <文心> & \"雕龍\" 的 '體例'", draft: true }),
    },
    /*
     * 三種檔案型別各放一份，因為**三種的逃脫方式不一樣**：
     *   HTML  &lt; &amp; &quot; &#39;
     *   XML   同上，但單引號是 &apos;（RSS 走這個）
     *   JSON  只逃脫 \" 與反斜線
     * 只放 HTML 的話，「少了 &apos;」與「不做 JSON 逃脫」兩種壞法會靜靜通過 ——
     * 第 3 輪（第十三圈）的突變掃描就是這樣抓到自己的案例不夠的。
     */
    dist: {
      'poems/wu-yi-xiang/index.html': page("談 &lt;文心&gt; &amp; &quot;雕龍&quot; 的 &#39;體例&#39; — 這一頁是 HTML"),
      /*
       * `<link>` 是第 4 輪（第二十一圈）補的：feed-unreadable 上線之後，
       * 沒有連結的一筆會被 parseFeed 丟掉（沒網址就沒有 id 也沒有去處），
       * 這份 feed 就變成「合法但 0 筆」，害這個案例同時響兩條規則。
       * 真實的 feed 本來就有連結，補上去比較像真的。
       */
      'rss-all.xml':
        '<?xml version="1.0"?><rss><channel><item>' +
        '<title>談 &lt;文心&gt; &amp; &quot;雕龍&quot; 的 &apos;體例&apos;</title>' +
        '<link>https://bellafoxy.com/poems/wu-yi-xiang</link></item></channel></rss>',
      'search-index.json': JSON.stringify([{ t: "談 <文心> & \"雕龍\" 的 '體例'" }]),
    },
    /* 報告要指名三個檔案 —— 少一個代表某一種逃脫沒有被涵蓋 */
    mustMention: ['index.html', 'rss-all.xml', 'search-index.json'],
    /*
     * 這個 fixture 讓草稿有了自己的頁面，所以 draft-page 一定也會響 ——
     * 那是真的問題不是雜訊，宣告出來即可。
     * 第 3 輪（第八圈）用突變驗過：把字串比對弄壞，這個案例會紅 ——
     * 也就是它不是靠 draft-page 蒙混過關的。
     */
    also: ['draft-page'],
  },

  /*
   * 草稿有了自己的頁面。產出的內文刻意**不含**標題，
   * 這樣響的只會是 draft-page，證明它不是靠字串比對抓到的。
   */
  'draft-page': {
    content: { 'poems/wu-yi-xiang.md': poem({ draft: true }) },
    dist: { 'poems/wu-yi-xiang/index.html': page('這一頁的字跟標題完全無關') },
  },

  /*
   * 英文的列表頁是空的，中文有內容，而空狀態裡沒有一條連過去。
   *
   * dist 裡刻意**放齊中文那一篇的頁面** —— 不然 missing-page 也會響，
   * 一個同時響兩條的案例證明不了是哪一條讓它綠的。
   */
  'locale-dead-end': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      'en/poems/index.html': page(
        '<div class="empty"><p class="empty__title">Nothing here yet.</p></div>',
      ),
    },
  },

  /*
   * 兩個字的標題、沒有 original —— needles 會被 `n.length >= 4` 濾成空的。
   * 這正是第 3 輪（第六圈）實測到的洞：以前這種情況會安靜通過。
   */
  /*
   * 空狀態裡**有**連結，但連到自己這個語言 —— 照樣是死路。
   *
   * 少了這一格，把判斷放寬成「空狀態裡有沒有 <a>」會全綠：
   * 上面那格的 fixture 一條連結都沒有，證明不了「連對地方」。
   */
  'locale-dead-end（連結指回自己這個語言不算）': {
    expect: 'locale-dead-end',
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      'en/notes/index.html': page(
        '<div class="empty"><p class="empty__title">Nothing here yet.</p>' +
          '<a href="/en/archive">See everything</a></div>',
      ),
    },
  },

  /*
   * ── 搜尋索引不見了，或漏了某一篇 ──────────────────
   *
   * 第 2 輪（第二十一圈）量到：把 dist/search-index.json 刪掉，
   * 沒有任何一道檢查會說話 —— 而那是站內搜尋的全部。
   *
   * dist 裡放齊那一篇的頁面，免得 missing-page 也響。
   */
  /*
   * ── 某個語言一篇都沒有，而那一頁沒有指路 ──
   *
   * 索引裡兩筆都是 zh-TW，所以 /en/search 的讀者無論打什麼都是「沒有結果」。
   * 那一頁的 data-strings 裡少了指路用的鍵 —— 畫面上不會說為什麼。
   */
  /*
   * ── 指南教了一個 schema 沒有的欄位 ──
   *
   * 上面 `field-undocumented` 走的是「schema → 指南」，這一格是反過來。
   * zod 物件預設把不認得的鍵**安靜丟掉**，所以照著指南寫的那一行
   * 會什麼都不做，而建置不會紅。
   *
   * 這一格帶自己的 `guide`（假指南），跟 `field-undocumented` 那一格一樣。
   */
  'guide-field-unknown': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    /*
     * 用**真的**指南再補一個範例區塊 —— 用小 stub 的話 `field-undocumented`
     * 會一起響（stub 沒教到其他欄位），那就分不出是哪一條讓它綠的。
     */
    guide:
      REAL_GUIDE +
      '\n\n## 一個教錯的範例\n\n```markdown\n---\ntitle: 靜夜思\nlang: zh-TW\n' +
      'thisFieldDoesNotExist: 隨便\n---\n```\n',
  },
  'search-crosslang-mute': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      'search/index.html': SEARCH_PAGE,
      'en/search/index.html': searchPage('en', '{"none":"No matches found."}'),
    },
  },
  'search-index-missing': {
    /* 這一格要的就是「索引不在」，所以不要自動補 */
    noIndex: true,
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
  },
  /*
   * ── 範本文字被留在已發佈的內容裡 ──
   *
   * 第 3 輪（第二十三圈）走「從 npm run write 到站上看得到」那條路時，
   * 順手走了失敗的那一支：把原文留成範本文字然後發佈 ——
   * 當時**六道關卡全綠**，站上就會有一首「原文」是「請在這裡放原文」的詩。
   */
  'template-text-left': {
    content: {
      'poems/wu-yi-xiang.md': poem().replace('朱雀橋邊野草花', '這裡放原文，一行一句'),
    },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 這裡放原文，一行一句') },
  },
  /*
   * 正文那一種也要有案例。
   *
   * 範本文字有兩組：frontmatter 的（詩詞的原文與白話）與**正文**的
   * （「（短札的正文。）」那種）。上面那格只用到第一組 ——
   * 突變掃描證實：把正文那幾句從清單裡拿掉，上面那格照樣綠。
   */
  'template-text-left（正文那一種）': {
    expect: 'template-text-left',
    content: {
      'notes/hello.md':
        '---\ntitle: 隨手\nlang: zh-TW\npublishedAt: 2026-09-01\n---\n（短札的正文。）\n',
    },
    dist: { 'notes/hello/index.html': page('隨手 — （短札的正文。）') },
  },

  /*
   * ── schema 有這個欄位，寫作指南沒教過 ──
   *
   * 第 3 輪（第二十四圈）加的。假指南 = 真指南把 `videoUrl` 全部改名，
   * 所以「少一個欄位」是這一格與真實情況的**唯一**差別 ——
   * 用一份空的假指南也會紅，但那證明不了它數的是欄位而不是「檔案沒內容」。
   */
  /*
   * ── 直排從產出裡消失了 ──
   *
   * `content.config.ts` 寫著 `vertical: z.boolean().default(true)`，
   * 而實作它的只有 `PoemBlock.astro` 裡一行 `writing-mode: vertical-rl`。
   * 第 8 輪（第二十六圈）實測：把那一行改掉，六道關卡加兩套測試全綠，
   * 而全站的詩會變成橫排。誰會告訴我們？讀者，或者她。
   */
  /*
   * 語言清單寫在四個地方（site.ts 的型別、content.config 的 Zod、
   * astro.config 的路由與 sitemap 對照），而沒有東西檢查它們一樣。
   * 第 3 輪（第三十一圈）量到的。這一格讓其中一份多一個語言。
   *
   * 其餘三個情境（一致、少一個、抽不到）在底下的獨立區塊裡 ——
   * 那幾格要驗的是筆記的措辭與離開碼，`CASES` 只比對「有沒有響」。
   */
  /*
   * ── `src/content/` 底下多一個沒註冊的資料夾 ────────────────
   *
   * 第 3 輪（第四十二圈）：`content.config.ts` 最後一行是一份手寫的註冊表，
   * 而沒有東西在比它跟真的資料夾。實測放一篇進沒註冊的資料夾：
   * 建置成功、頁數沒變、`check:content` 還把它算進「幾篇內容」，離開碼 0。
   *
   * fixture 要自己給一份 `content.config.ts`（`--src=` 指過去），
   * 不然規則會走「抽不到」那條路，只印筆記不擋。
   */
  'collection-unregistered': {
    content: {
      'poems/wu-yi-xiang.md': poem(),
      'essays/x.md': '---\ntitle: 一篇散文\nlang: zh-TW\n---\n內文。\n',
    },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    extra: {
      'src/content.config.ts': 'export const collections = { posts, poems, notes, external };\n',
    },
    args: (/** @type {string} */ dir) => [`--src=${join(dir, 'src')}`],
  },
  'locale-list-drift': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    extra: {
      'src/config/site.ts': "export const LOCALES = ['zh-TW', 'en'] as const;\n",
      'src/content.config.ts': "const LOCALE = z.enum(['zh-TW', 'en', 'ja']).default('zh-TW');\n",
      'astro.config.mjs':
        "export default { i18n: { locales: ['zh-TW', 'en'] }, integrations: [sitemap({ i18n: { locales: { 'zh-TW': 'zh-Hant-TW', en: 'en' } } })] };\n",
    },
    args: (/** @type {string} */ dir) => [`--src=${join(dir, 'src')}`, `--astro=${join(dir, 'astro.config.mjs')}`],
  },
  /*
   * ── 網域三份對不起來 ──
   *
   * 跟上面語言清單同一個形狀。`site.ts` 與 `astro.config.mjs` 說同一個網域，
   * 而 `public/CNAME` 是另一個 —— GitHub Pages 實際掛在哪跟站上寫的絕對網址
   * 不一樣，整站的 canonical／sitemap／RSS 都會指到一個不是自己的網域。
   *
   * CNAME 的位置是從 `--astro=` 那個檔案的目錄推出來的，所以 fixture 把它
   * 放在同一層的 `public/` 底下。
   */
  'domain-drift': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    extra: {
      'src/config/site.ts': "export const site = { url: 'https://example.test' };\n",
      'astro.config.mjs': "export default { site: 'https://example.test' };\n",
      'public/CNAME': 'somewhere-else.test\n',
    },
    args: (/** @type {string} */ dir) => [`--src=${join(dir, 'src')}`, `--astro=${join(dir, 'astro.config.mjs')}`],
  },
  /*
   * ── manifest 是第三份，而只有前兩份有人比 ────────────
   *
   * `#faf6ee` 寫在 `tokens.css`（`--c-bg`）、`site.ts`（`themeColor.light`）
   * 與 `public/site.webmanifest` 三個地方。`check:contrast` 在比前兩份，
   * 第三份到第 3 輪（第四十三圈）之前誰都沒看。
   *
   * 實測那一輪：把前兩份一起改成 `#faf6ef`，**六道關卡全綠**，
   * manifest 還是舊的 —— 安裝成 App 的人看到的就是舊顏色。
   *
   * fixture 的位置跟 `domain-drift` 一樣，從 `--astro=` 的目錄推 `public/`。
   */
  'manifest-drift': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    extra: {
      'src/config/site.ts':
        "export const site = {\n  name: { 'zh-TW': '狐說八道', en: 'Fox Says' },\n" +
        "  description: { 'zh-TW': '朗誦經典詩詞曲。', en: 'x' },\n" +
        "  themeColor: { light: '#faf6ee', dark: '#14120f' },\n} as const;\n",
      'public/site.webmanifest': JSON.stringify(
        {
          name: '狐說八道',
          short_name: '狐說八道',
          description: '朗誦經典詩詞曲。',
          theme_color: '#faf6ef',
          background_color: '#faf6ef',
        },
        null,
        2,
      ),
    },
    args: (/** @type {string} */ dir) => [`--src=${join(dir, 'src')}`, `--astro=${join(dir, 'astro.config.mjs')}`],
  },
  /*
   * ── 少一個必填欄，站上會多出一個沒有 href 的 <a> ────────────
   *
   * 第 4 輪（第三十六圈）實測過那個後果：把第一筆的 `url` 改名，
   * `npm run build` 成功、六道關卡全綠、兩套測試全綠，
   * 而 6 個頁面上各多了一個
   * `<a class="synd__link" target="_blank" rel="noopener noreferrer">`。
   * 點不動、tab 不到，看起來卻跟正常的卡片一模一樣。
   *
   * fixture 帶的 schema 是**真的那一份**（照著複製過來，不是另寫一份小的）——
   * 另寫一份的話，這一格驗的是那份小的，真的合約改了它不會知道。
   */
  'syndication-schema': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    extra: {
      'synd/syndication.json': JSON.stringify({
        $schema: './syndication.schema.json',
        generatedAt: new Date().toISOString(),
        itemCount: 1,
        sources: { 'youtube-x': { status: 'ok', platform: 'youtube', itemCount: 1, lastSuccessAt: new Date().toISOString() } },
        /* url 少了 —— 這正是實測會漏掉的那種壞法 */
        items: [{ id: 'a', sourceId: 'youtube-x', platform: 'youtube', title: '一首詩' }],
      }),
      'synd/syndication.schema.json': REAL_SYNDICATION_SCHEMA,
    },
    args: (/** @type {string} */ dir) => [`--syndication=${join(dir, 'synd', 'syndication.json')}`],
  },
  /*
   * 反向：同樣一份 fixture，欄位補齊就不該響。
   * 少了這一格，把規則寫成「一律報錯」也會全綠。
   */
  'syndication-schema（補齊就不報）': {
    expect: 'no-title',
    content: {
      'poems/wu-yi-xiang.md': poem(),
      'poems/broken.md': '---\nlang: zh-TW\n---\n沒有 title。\n',
    },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    extra: {
      'synd/syndication.json': JSON.stringify({
        $schema: './syndication.schema.json',
        generatedAt: new Date().toISOString(),
        itemCount: 1,
        sources: { 'youtube-x': { status: 'ok', platform: 'youtube', itemCount: 1, lastSuccessAt: new Date().toISOString() } },
        items: [{ id: 'a', sourceId: 'youtube-x', platform: 'youtube', title: '一首詩', url: 'https://example.test/a' }],
      }),
      'synd/syndication.schema.json': REAL_SYNDICATION_SCHEMA,
    },
    args: (/** @type {string} */ dir) => [`--syndication=${join(dir, 'synd', 'syndication.json')}`],
  },
  /*
   * ── 站上的日期跟外站對不上 ──────────────────────
   *
   * 站主 2026-09-09 定了「接了外站作品就用外站的發佈時刻」之後加的。
   * 這一格用的日期刻意選在**臺北已經跨日、UTC 還沒跨**的那一格
   *（16:51 UTC ＝ 隔天 00:51 臺北）—— 規則比的是臺北日，
   * 拿 UTC 比的話這一格會漏掉。
   */
  'external-date-drift': {
    content: { 'poems/wu-yi-xiang.md': withVideo(poem(), '2026-09-08') },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    mustMention: ['2024-10-22', FIXTURE_VIDEO_AT],
    extra: {
      'synd/syndication.json': syndWith(FIXTURE_VIDEO_AT),
      'synd/syndication.schema.json': REAL_SYNDICATION_SCHEMA,
    },
    args: (/** @type {string} */ dir) => [`--syndication=${join(dir, 'synd', 'syndication.json')}`],
  },
  /*
   * ── 會指到她檔案的規則，她的文件裡要有 ────────────────
   *
   * 第 3 輪（第三十七圈）：這一支 20 條規則，`docs/CONTENT.md`、`CLAUDE.md`、
   * `ARCHITECTURE.md` 加起來提到 **0 條**。其中 11 條會擋住建置**並指名她的檔案**
   * —— 她照文件寫，然後在 CI 上被一個沒看過的名字擋下來。
   * 跟 `check:copy` 的 `rule-not-documented` 是同一件事。
   *
   * 這一格的假指南**刻意只少寫一條**（`template-text-left`）——
   * 全都不寫的話，「一律報錯」那種壞法也會過。
   */
  'rule-not-in-guide': {
    /* 假的指南當然沒寫 schema 欄位，所以 field-undocumented 一定會跟著響 */
    also: ['field-undocumented'],
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    extra: {
      'guide.md': '寫錯的時候會看到什麼：`no-title`、`poem-title-bracketed`、`draft-page`、`draft-unscannable`、`draft-leaked`、`external-missing`、`missing-page`、`lang-leaked`、`bad-reference`、`search-index-missing`。\n',
    },
    args: (/** @type {string} */ dir) => [`--guide=${join(dir, 'guide.md')}`],
  },
  /* 反向：十一條都寫了就不該報 */
  'rule-not-in-guide（都寫了就不報）': {
    expect: 'no-title',
    also: ['field-undocumented'],
    content: {
      'poems/wu-yi-xiang.md': poem(),
      'poems/broken.md': '---\nlang: zh-TW\n---\n沒有 title。\n',
    },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    extra: {
      'guide.md': '寫錯的時候會看到什麼：`no-title`、`poem-title-bracketed`、`draft-page`、`draft-unscannable`、`draft-leaked`、`external-missing`、`missing-page`、`lang-leaked`、`bad-reference`、`search-index-missing`、`template-text-left`、`collection-unregistered`、`external-date-drift`。\n',
    },
    args: (/** @type {string} */ dir) => [`--guide=${join(dir, 'guide.md')}`],
  },
  'vertical-lost': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      '_astro/x.css': '.poem__original{writing-mode:horizontal-tb}\n',
    },
  },
  /* 反向：CSS 裡還有那條宣告就不該報 */
  'vertical-lost（還在就不報）': {
    expect: 'no-title',
    content: {
      'poems/wu-yi-xiang.md': poem(),
      'poems/broken.md': '---\nlang: zh-TW\n---\n沒有 title。\n',
    },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      '_astro/x.css': '.poem__original{writing-mode:vertical-rl}\n',
    },
  },
  /*
   * ── 宣告還在，但被無條件蓋掉 ──────────
   *
   * 第 8 輪（第二十七圈）量到的：把窄螢幕那個 `max-width: 48rem`
   * 寫成 `min-width: 0rem`（一個看起來像在放寬的改動），
   * `vertical-rl` **仍然在**、`build` 成功、`check:content` **exit 0** ——
   * 而每一台裝置上的詩都變成橫排。
   *
   * 上面那一格守的是「宣告在不在」，這一格守的是它的補集。
   */
  'vertical-lost（宣告還在但被無條件蓋掉）': {
    expect: 'vertical-lost',
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      '_astro/x.css':
        '.poem__original{writing-mode:vertical-rl}' +
        '@media (width>=0){.poem__original{writing-mode:horizontal-tb!important}}\n',
    },
  },

  /*
   * 反向：關在**從上方設限**的媒體查詢裡就不該報 —— 那是真的站在做的事。
   * 少了這一格，把判準改成「只要有 horizontal-tb!important 就報」會靜靜通過，
   * 而真正的站會被誤報成壞的。
   */
  'vertical-lost（窄螢幕改橫排是正常的）': {
    expect: 'no-title',
    content: {
      'poems/wu-yi-xiang.md': poem(),
      'poems/broken.md': '---\nlang: zh-TW\n---\n沒有 title。\n',
    },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      '_astro/x.css':
        '.poem__original{writing-mode:vertical-rl}' +
        '@media (width<=48rem){.poem__original{writing-mode:horizontal-tb!important}}\n',
    },
  },

  /*
   * 反向：打在**別的元素**上的 horizontal-tb!important 不關這條的事。
   *
   * 突變掃描抓到的語料缺口：把選擇器那道濾網拿掉，測試照樣全綠 ——
   * 因為沒有一格是「別的元素上有無條件的 horizontal-tb!important」。
   * 而真的站上一定會有那種東西（英文頁、註解區⋯⋯），
   * 少了濾網會把正常的站報成壞的。
   */
  'vertical-lost（別的元素橫排不關這條的事）': {
    expect: 'no-title',
    content: {
      'poems/wu-yi-xiang.md': poem(),
      'poems/broken.md': '---\nlang: zh-TW\n---\n沒有 title。\n',
    },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      '_astro/x.css':
        '.poem__original{writing-mode:vertical-rl}' +
        '.some-note{writing-mode:horizontal-tb!important}\n',
    },
  },

  /* 反向：每一首都寫了 vertical: false 的話，這條沒有主體 */
  'vertical-lost（全部橫排就沒東西可守）': {
    expect: 'no-title',
    content: {
      'poems/wu-yi-xiang.md': poem().replace('---\n\n', '---\n') .replace('lang: zh-TW', 'lang: zh-TW\nvertical: false'),
      'poems/broken.md': '---\nlang: zh-TW\n---\n沒有 title。\n',
    },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      '_astro/x.css': '.poem__original{writing-mode:horizontal-tb}\n',
    },
  },

  'field-undocumented': {
    guide: REAL_GUIDE.replaceAll('videoUrl', 'videoLink'),
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    mustMention: ['videoUrl'],
    /*
     * 改了名字之後指南教的是 `videoLink`，而 schema 裡沒有那個欄位 ——
     * 所以第 3 輪（第三十四圈）加的反方向那條**本來就該一起響**。
     * 兩條是同一個錯位的兩半，不是誤報。
     */
    also: ['guide-field-unknown'],
  },

  /*
   * 「文件裡有這個詞」不算教過。
   *
   * 這一格的假指南把 `videoUrl` 改名之後，在最後補一句**純內文**的
   * 「⋯不是 videoUrl」—— 判準若放寬成「整份文件搜得到」，這一格就綠了。
   * 欄位名很多是普通字，這種擦邊會安靜地讓規則失效。
   */
  'field-undocumented（只在內文提到不算）': {
    expect: 'field-undocumented',
    guide:
      REAL_GUIDE.replaceAll('videoUrl', 'videoLink') +
      '\n\n影片網址那個欄位現在叫 videoLink，以前叫 videoUrl。\n',
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    /* 同上：指南教的 `videoLink` 不在 schema 裡，反方向那條也該響 */
    also: ['guide-field-unknown'],
  },

  /*
   * 我們自己發出去的 feed 壞掉的兩種樣子。
   *
   * 第一種（沒跳脫的 `&`）是這條規則會存在的原因：**我們自己的剖析器
   * 讀得動它**（實測照樣讀出 5 筆），所以只用剖析器判斷的話這一格會綠 ——
   * 第一版就是那樣寫的，突變掃描當場抓到。真正會拒絕它的是 XML 規格本身。
   */
  'feed-unreadable': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      'rss.xml': feed({ broken: 'xml' }),
    },
    mustMention: ['rss.xml'],
  },
  /* 語法沒錯，但一筆都沒有 —— 訂閱的人拿到一個空的來源 */
  'feed-unreadable（合法但空的）': {
    expect: 'feed-unreadable',
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      'rss-all.xml': feed({ broken: 'empty' }),
    },
  },

  /* 索引在，但漏了那一篇 —— 比整個不見更難發現 */
  'search-index-missing（索引在但漏了一篇）': {
    expect: 'search-index-missing',
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      'search-index.json': JSON.stringify({ n: 1, items: [{ t: '別的', u: '/notes/other' }] }),
    },
  },

  /*
   * ── related 指到不存在的東西 ────────────────────
   *
   * 第 3 輪（第二十圈）量到的：打錯一個字，Astro 印一行 ERROR 但
   * **build 照樣 exit 0**，那一頁的「相關的詩」整段消失，六道關卡全綠。
   *
   * dist 裡放齊兩篇的頁面，免得 missing-page 也響 ——
   * 同時響兩條的案例證明不了是哪一條讓它綠的。
   */
  'bad-reference': {
    content: {
      'poems/wu-yi-xiang.md': poem().replace('lang: zh-TW', 'lang: zh-TW\nrelated: [bu-cun-zai]'),
    },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
  },
  /*
   * 大小寫不符也要抓得到。Astro 的 reference() 是大小寫敏感的，
   * 而 macOS 的檔案系統不是 —— 這個 repo 在標籤上踩過同一個坑兩次。
   * 少了這一格，把比對改成不分大小寫會靜靜通過（突變掃描量到的）。
   */
  'bad-reference（大小寫不符）': {
    expect: 'bad-reference',
    content: {
      'poems/wu-yi-xiang.md': poem().replace('lang: zh-TW', 'lang: zh-TW\nrelated: [Wu-Yi-Xiang]'),
    },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
  },

  /* 清單形式也要抓得到（兩種寫法在 YAML 裡都合法） */
  'bad-reference（清單形式）': {
    expect: 'bad-reference',
    content: {
      'poems/wu-yi-xiang.md': poem().replace('lang: zh-TW', 'lang: zh-TW\nrelated:\n  - bu-cun-zai'),
    },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
  },

  'draft-unscannable': {
    content: { 'posts/dushi.md': '---\ntitle: 讀詩\nlang: zh-TW\ndraft: true\n---\n還沒寫完。\n' },
    dist: { 'index.html': page('首頁') },
  },

  /*
   * 非草稿的手動登錄，卻沒出現在 elsewhere/ 底下。
   * dist 裡刻意放一個有內容的 elsewhere 頁 —— 證明規則看的是「有沒有這一筆」，
   * 不是「elsewhere 這個目錄存不存在」。
   */
  'external-missing': {
    content: {
      'external/threads-post.md':
        '---\ntitle: 讀《文心雕龍》讀到一半想到的事\nlang: zh-TW\nplatform: threads\nurl: https://example.com/x\n---\n備忘。\n',
    },
    dist: { 'elsewhere/index.html': page('這裡有別的文章，就是沒有那一筆') },
  },

  /*
   * poem.title 自己加了書名號。
   *
   * dist 刻意放一份**正常的**產出（needles 都找得到、路徑也對），
   * 所以響的只會是這一條 —— 證明它看的是 frontmatter 的寫法，
   * 不是產出裡有沒有〈〈。
   */
  'poem-title-bracketed': {
    content: { 'poems/wu-yi-xiang.md': poem({ poemTitle: '〈烏衣巷〉' }) },
    dist: { 'poems/wu-yi-xiang/index.html': page('〈〈烏衣巷〉〉 — 朱雀橋邊野草花') },
  },
  /*
   * ── 誤報探針補上的兩格 ──────────────────────────────
   *
   * 第 3 輪（第十六圈）量到：「題《赤壁圖》」是完全正常的詩題
   * （畫面會畫成〈題《赤壁圖》〉），但它結尾是》，舊的判斷就報了。
   * 條件改成「頭尾成對」之後，這兩格證明它還會響、而且不再冤枉人。
   */
  'poem-title-bracketed（書名號整個包起來也要抓）': {
    expect: 'poem-title-bracketed',
    content: {
      'poems/cjhy.md':
        '---\ntitle: 春江花月夜\nlang: zh-TW\npoem:\n  title: 《春江花月夜》\n  author: 張若虛\n  original: |\n    春江潮水連海平\n---\nx\n',
    },
    dist: { 'poems/cjhy/index.html': page('《春江花月夜》 春江潮水連海平') },
  },

  'missing-page': {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'index.html': page('首頁上沒有這首詩的頁面') },
  },

  /*
   * lang: en 的內容卻出現在中文路徑下。
   * 第 3 輪（第五圈）加這條的時候，是靠手動放一篇 `lang: en` 的詩發現
   * missing-page 會誤報 —— 這裡把兩種路徑都放出來，同時驗
   * 「en 的頁面在 /en/ 下不算缺頁」與「它不該在中文路徑下出現」。
   */
  'lang-leaked': {
    content: { 'poems/wu-yi-xiang.md': poem({ lang: 'en' }) },
    dist: {
      'en/poems/wu-yi-xiang/index.html': page('英文路徑，這個是對的'),
      'poems/wu-yi-xiang/index.html': page('中文路徑，這個不該存在'),
    },
  },
};

/** 乾淨的一份：一篇正常的詩 + 一篇草稿，草稿的字一個都沒進產出 */
const CLEAN = {
  content: {
    /*
     * 接上假影片，而且日期**對得上** —— `external-date-drift` 的反向案例。
     * 少了它那條規則在這份語料上主體是 0，「不該響的不響」就沒有人守，
     * 把它改成「一律報」也會全綠。
     */
    'poems/wu-yi-xiang.md': withVideo(poem(), FIXTURE_VIDEO_AT),
    /*
     * 詩題本身含書名號是完全正常的（畫面會畫成〈題《赤壁圖》〉）。
     * 第 3 輪（第十六圈）之前的判斷是「開頭或結尾有括號」，這一份會被冤枉。
     * 放在 CLEAN 裡，等於「不該響的不響」有人守著 —— 突變掃描證實會紅。
     */
    /* related 指對了的樣子 —— 少了它，把 bad-reference 改成「一律報」也會全綠 */
    'poems/ti-chi-bi.md': poem({ title: '題《赤壁圖》', poemTitle: '題《赤壁圖》', first: '折戟沉沙鐵未銷' }).replace(
      'lang: zh-TW',
      'lang: zh-TW\nrelated: [wu-yi-xiang]',
    ),
    /*
     * 這個草稿的原文**刻意留著 npm run write 的範本文字**。
     * 草稿本來就是還沒寫完的東西，對它報 `template-text-left`
     * 只會讓人學會忽略整道檢查 —— 所以「不該響的不響」在這裡守。
     * （放在 CLEAN 而不是自己一格：那條規則響或不響是這份 fixture 的事，
     * 而它同時也在守 draft-page／draft-leaked 不誤報。）
     */
    'poems/secret.md': poem({ title: '還沒寫完', poemTitle: '還沒寫完', first: '這裡放原文，一行一句', draft: true }),
    'external/threads-post.md':
      '---\ntitle: 讀《文心雕龍》讀到一半想到的事\nlang: zh-TW\nplatform: threads\nurl: https://example.com/x\n---\n備忘。\n',
    /*
     * 反向的另一半：標題含 `& < > " '` 的外站文章**有**畫在頁面上，
     * 只是被逃脫了 —— 不該報 external-missing。
     * 第 3 輪（第十三圈）之前，五種標題裡有四種會誤報。
     */
    'external/escaped-post.md':
      '---\ntitle: 談 <文心> & "雕龍" 的 \'體例\'\nlang: zh-TW\nplatform: threads\nurl: https://example.com/y\n---\n備忘。\n',
  },
  /*
   * 自己帶一份 syndication，不吃 `src/data/syndication.json`。
   * 吃真的那一份的話，這一格會隨著排程每天重寫的資料一起飄 ——
   * 而它要驗的是「日期對得上就不響」，不是「今天的 feed 長什麼樣」。
   */
  extra: {
    'synd/syndication.json': syndWith(FIXTURE_VIDEO_AT),
    'synd/syndication.schema.json': REAL_SYNDICATION_SCHEMA,
  },
  dist: {
    'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
    'poems/ti-chi-bi/index.html': page('題《赤壁圖》 — 折戟沉沙鐵未銷'),
    /*
     * 一個**排序正確**的列表頁 —— 這是 `listing-order` 的反向案例，
     * 同時也是它在乾淨語料上的主體（沒有它，那條規則的主體是 0，
     * 而 0 主體的綠燈證明不了任何事）。
     * featured 那一個刻意比後面那個舊：那是對的，`featuredFirst: true`
     * 的列表就是這樣排的。
     */
    'poems/index.html': page(
      listItem('2026-08-20', true) + listItem('2026-08-28', false) + listItem('2026-08-15', false),
    ),
    /* 索引裡有那兩篇 —— 少了它，把規則改成「一律報」也會全綠 */
    'search-index.json': JSON.stringify({
      n: 2,
      items: [
        { t: '烏衣巷', u: '/poems/wu-yi-xiang' },
        { t: '題《赤壁圖》', u: '/poems/ti-chi-bi' },
      ],
    }),
    /*
     * 兩頁搜尋頁，`data-strings` 裡帶齊指路用的三個鍵 ——
     * search-crosslang-mute 的反向那一半（不該響的不響），
     * 也讓它在這份語料上有主體，不會被列進「沒東西可看」。
     */
    'search/index.html': SEARCH_PAGE,
    'en/search/index.html': SEARCH_PAGE,
    'elsewhere/index.html': page(
      '讀《文心雕龍》讀到一半想到的事｜談 &lt;文心&gt; &amp; &quot;雕龍&quot; 的 &#39;體例&#39;',
    ),
    /*
     * 一份合法、有東西的 feed —— 這是 feed-unreadable 的反向那一半。
     * 少了它，那條規則在這份 fixture 裡沒有主體，會被列進
     * 「這次沒有東西可看的規則」；有了它，「不該響的不響」才有人守。
     */
    'rss.xml': feed(),
    /*
     * 反向的兩半，都放在 CLEAN 裡：
     *
     *   1. 空狀態**帶著**往中文的連結 —— 修好的樣子，不該再響。
     *   2. /en/elsewhere 的空狀態沒有連結，但那是「同步還沒跑」，
     *      兩個語言一起空，指過去也是空的 —— 不歸這條規則管。
     *
     * 少了第 2 格，把規則的路徑範圍放寬成「所有頁面」也會全綠。
     */
    'en/poems/index.html': page(
      '<div class="empty"><p class="empty__title">Nothing here yet.</p>' +
        '<a class="ui" href="/poems">There are 2 in Chinese</a></div>',
    ),
    'en/elsewhere/index.html': page(
      '<div class="empty"><p class="empty__title">Nothing synced yet.</p></div>',
    ),
  },
};

const tmp = await mkdtemp(join(tmpdir(), 'fox-content-'));
let failed = 0;

console.log('\n內容管線規則實測\n' + '─'.repeat(64));

try {
  for (const [label, files] of Object.entries(CASES)) {
    /*
     * `expect` 讓同一條規則有第二個案例（key 取的是情境，比對的仍是規則 id）——
     * 跟 test-perf-budgets、test-workflow-rules 的做法一致。
     */
    const id = /** @type {any} */ (files).expect ?? label;
    const dir = await build(`case-${label}`, files);
    /* `args` 讓案例換掉腳本讀的路徑（`--src=`、`--astro=`），配合上面的 extra */
    const out = await check(dir, /** @type {any} */ (files).args?.(dir) ?? []);
    const hit = out.includes(`[${id}]`);
    const fired = [...new Set([...out.matchAll(/\[([a-z-]+)\]/g)].map((m) => m[1]))];
    const undeclared = fired.filter((x) => x !== id && !(files.also ?? []).includes(x));
    console.log(`  ${hit ? '✓' : 'X'} ${label}`);
    if (undeclared.length > 0) {
      failed++;
      console.log(`      這個 fixture 還順帶觸發了沒宣告的規則：${undeclared.join('、')}`);
      console.log('      同時響好幾條的案例證明不了是哪一條讓它綠的。要嘛把 fixture 收窄，要嘛在 also 裡寫出來。');
    }
    for (const m of files.mustMention ?? []) {
      if (!out.includes(m)) {
        failed++;
        console.log(`      報告裡沒有提到「${m}」—— 這條規則沒有掃到那一種檔案。`);
      }
    }
    if (!hit) {
      failed++;
      console.log('      這條規則沒有響。輸出：');
      console.log(
        out
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => '        ' + l)
          .join('\n'),
      );
    }
  }

  {
    const dir = await build('clean', CLEAN);
    /*
     * 帶著**真的**寫作指南跑。
     *
     * `rule-not-in-guide` 比的是「會指到她檔案的規則有沒有寫進 docs/CONTENT.md」——
     * 那跟 fixture 的內容無關，而 fixture 目錄裡沒有那份文件。
     * 不帶 `--guide=` 的話它會被跳過、補成 0，於是出現在「沒東西可看」名單上，
     * 而這一格的意思正好是「這份 fixture 上不該有那份名單」。
     *
     * 指到真的那一份，這一格就順便在驗它：文件少寫一條，這裡會紅。
     */
    const syndArg = `--syndication=${join(dir, 'synd', 'syndication.json')}`;
    const out = await check(dir, [`--guide=${resolve(ROOT, 'docs/CONTENT.md')}`, syndArg]);
    /*
     * ── CLEAN 護得到哪幾條規則的邊界 ────────────────────
     *
     * 第 3 輪（第三十二圈）：把四條規則各改成**一律會響**，四條都被
     * 這一格抓到 —— 它就是這一支的反向案例。
     *
     * 但第 1 輪（第三十二圈）在無障礙那邊量到：這種「乾淨語料」
     * **只護得到它身上有東西可踩的那幾條**。主體是 0 的規則，
     * 邊界移一格也不會有人說話。所以把數字說出來。
     */
    const verbose = await check(dir, ['--verbose', `--guide=${resolve(ROOT, 'docs/CONTENT.md')}`, syndArg]);
    const subjects = new Map(
      [...verbose.matchAll(/^\s*(\d+)\s+([a-z0-9-]+)\s*$/gm)].map((m) => [m[2], Number(m[1])]),
    );
    const bare = [...subjects.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
    if (subjects.size === 0) {
      failed++;
      console.log('  X 讀不到 CLEAN 的主體數 —— 底下那句是假的');
    } else {
      console.log(
        `  · CLEAN 這份語料上，${subjects.size} 條規則裡 ${bare.length} 條主體是 0` +
          (bare.length > 0 ? `：${bare.join('、')}` : '（每一條都踩得到）') +
          '\n      主體是 0 的那幾條，「不該響的不響」在這一格證明不了 —— 邊界移一格也不會紅。',
      );
    }
    const ok = out.includes('沒有發現問題');
    console.log(`  ${ok ? '✓' : 'X'} 正常的內容不誤報`);
    if (!ok) {
      failed++;
      console.log(out.split('\n').map((l) => '        ' + l).join('\n'));
    }

    /*
     * 這一份 fixture **每一條規則都有主體**（有草稿、有非草稿、有詩、
     * 有非草稿的外站登錄，還有一頁英文的空狀態），所以「沒東西可看」的名單
     * 必須是空的、那一行不該出現。
     *
     * 為什麼要有這一格：少了它，把某條規則的 `saw()` 呼叫刪掉會**靜靜通過** ——
     * 上面那格只證明「該進名單的有進去」，證明不了「不該進的沒進去」。
     * 突變掃描實際上就是這樣漏掉兩個的。
     */
    const idleOk = !out.includes('這次沒有東西可看的規則');
    if (!idleOk) failed++;
    console.log(`  ${idleOk ? '✓' : 'X'} 每條規則都有主體時不印「沒東西可看」`);
    if (!idleOk) {
      console.log(
        '        ' + (out.split('\n').find((l) => l.includes('沒有東西可看')) ?? ''),
      );
    }
  }

  /*
   * ── 「沒有東西可看」的名單真的會動嗎 ──
   *
   * 第 3 輪（第十五圈）加的那段輸出，只有在會隨輸入改變的時候才有意義。
   * 這一份 fixture 完全沒有草稿、沒有 external、也沒有任何一頁列表頁，
   * 所以那五條規則的主體數都是 0，名單裡一定要有它們；
   * 而有主體的那幾條一定不能在名單裡。
   */
  {
    const dir = await build('idle', {
      content: { 'poems/wu-yi-xiang.md': poem() },
      dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    });
    const out = await check(dir);
    const line = out.split('\n').find((l) => l.includes('這次沒有東西可看的規則')) ?? '';
    const want = [
      'draft-page',
      'draft-unscannable',
      'draft-leaked',
      'external-missing',
      'locale-dead-end',
    ];
    const wantNot = ['no-title', 'missing-page', 'lang-leaked', 'poem-title-bracketed'];
    const ok =
      want.every((r) => line.includes(r)) && wantNot.every((r) => !line.includes(r));
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 沒有草稿、外站登錄與列表頁時，那五條會被列成「沒東西可看」`);
    if (!ok) console.log(`        實際印的是：${line || '（完全沒有這一行）'}`);
  }

  /*
   * ── frontmatter 的欄位只在 frontmatter 裡找 ──────────────
   *
   * 第 3 輪（第四十一圈）：`field()` 原本比對「整份檔案裡第一行
   * `name:` 開頭的」。`title` 是必填所以永遠先命中 frontmatter，
   * 出事的是**選填**的 —— 今天只有 `lang`。
   *
   * 這一格放一篇**沒有寫 `lang:`**、而正文裡有一段示範 frontmatter 的內容
   * （這個站正好在教人怎麼發文，那種程式碼框很自然）。
   * 錨在長相上的話它會被讀成 `en`，於是被 `lang-leaked` 冤枉。
   */
  {
    const dir = await build('field-frontmatter-only', {
      content: {
        'poems/p.md':
          '---\ntitle: 一首詩\npoem:\n  title: 一首詩\n  author: 某人\n  original: |\n    山\n---\n' +
          '示範一下 frontmatter 怎麼寫：\n\n```\nlang: en\n```\n',
      },
      dist: { 'poems/p/index.html': page('一首詩 山') },
    });
    const out = await check(dir);
    const ok = !/lang-leaked/.test(out);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 正文裡的 \`lang:\` 不會被當成這篇的語言`);
    if (!ok) {
      console.log(
        `        ${out.split('\n').find((l) => l.includes('lang-leaked'))?.trim() ?? ''}\n` +
          '        `field()` 要先切 frontmatter，不要在整份檔案裡找。',
      );
    }
  }

  /*
   * ── 「poem.title」要錨在 `poem:` 上，不是錨在縮排上 ──────────
   *
   * 第 3 輪（第四十圈）：原本用 `/^\s{2,}title:/` 抽 `poem.title`，
   * 而 frontmatter 裡不只 `poem:` 有巢狀 title —— 短札的 `inResponseTo`
   * 也有一個。於是一篇根本沒有 `poem:` 的短札被當成詩詞，
   * 進了「這幾篇詩詞的 title 讀者看不到」那份名單。
   *
   * 兩個方向：短札不能被當成詩，真的詩還是要抓得到。
   */
  {
    const dir = await build('poem-title-anchor', {
      content: {
        'notes/n.md':
          '---\ntitle: 一篇短札\nlang: zh-TW\ninResponseTo:\n  title: 某篇文章\n  url: https://example.com/x\n---\nx\n',
      },
      dist: { 'notes/n/index.html': page('一篇短札 回應 某篇文章') },
    });
    const out = await check(dir);
    const ok = !out.includes('這幾篇詩詞的 title 讀者看不到');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 短札的 inResponseTo.title 不會被當成 poem.title`);
    if (!ok) {
      console.log(
        `        ${out.split('\n').find((l) => l.includes('讀者看不到'))?.trim() ?? ''}\n` +
          '        判準要錨在 `poem:` 這個鍵上，不是「有沒有縮排」。',
      );
    }

    const dir2 = await build('poem-title-anchor-real', {
      content: {
        'poems/p.md':
          '---\ntitle: 琵琶行（節錄）\nlang: zh-TW\npoem:\n  title: 琵琶行\n  author: 白居易\n  original: |\n    潯陽江頭夜送客\n---\nx\n',
      },
      dist: { 'poems/p/index.html': page('琵琶行 潯陽江頭夜送客') },
    });
    const out2 = await check(dir2);
    const ok2 = out2.includes('這幾篇詩詞的 title 讀者看不到') && out2.includes('琵琶行（節錄）');
    if (!ok2) failed++;
    console.log(`  ${ok2 ? '✓' : 'X'} 真的被 poem.title 蓋住的詩還是抓得到（反向案例）`);
    if (!ok2) console.log(`        ${out2.split('\n').find((l) => l.includes('讀者看不到'))?.trim() ?? '（那一行完全沒印）'}`);
  }

  /*
   * ── 第二把尺：Astro 自己寫出來的 schema ──────────────
   *
   * 上面那一格驗的是「內容用過的欄位有沒有抽到」—— 只驗得到**用過的**。
   * 宣告了但還沒有人寫過的欄位抽漏了，那一格是綠的。
   * 第 3 輪（第四十五圈）補的第二把尺是 `.astro/collections/*.schema.json`
   * （`astro sync` 產生的，Astro 自己從 zod 推出來的）。
   */
  {
    const mkDir = async (/** @type {string} */ name, /** @type {Record<string, string>} */ extra) => {
      const dir = await build(name, {
        content: { 'poems/wu-yi-xiang.md': poem() },
        dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
        extra,
      });
      const out = await check(dir, [`--src=${join(dir, 'src')}`, `--astro=${join(dir, 'astro.config.mjs')}`]);
      await rm(dir, { recursive: true, force: true });
      return out;
    };
    /* fixture 的內容用到哪些欄位，這份就要有 —— 不然會先掉進「抽不到內容用過的」那條路 */
    const configTs =
      'const poems = defineCollection({\n  schema: z.object({\n' +
      ['title', 'lang', 'poem', 'author', 'original'].map((n) => `    ${n}: z.string(),`).join('\n') +
      '\n  }),\n});\n';
    const schemaJson = (/** @type {string[]} */ names) =>
      JSON.stringify({ properties: Object.fromEntries(names.map((n) => [n, {}])) });

    const missed = await mkDir('schema-second-ruler', {
      'src/content.config.ts': configTs,
      'astro.config.mjs': "export default { site: 'https://example.test' };\n",
      '.astro/collections/poems.schema.json': schemaJson(['title', 'coverAlt']),
    });
    const okMissed = /Astro 自己的 schema 有 coverAlt，這支腳本的正則沒抽到/.test(missed);
    if (!okMissed) failed++;
    console.log(`  ${okMissed ? '✓' : 'X'} 正則抽漏 Astro 認得的欄位時，說自己沒查`);
    if (!okMissed) console.log('        ' + (missed.split('\n').find((l) => l.includes('欄位使用情況')) ?? '（沒印）'));

    /* 反向一：兩把尺一致時不亂講 */
    const agree = await mkDir('schema-second-ruler-ok', {
      'src/content.config.ts': configTs,
      'astro.config.mjs': "export default { site: 'https://example.test' };\n",
      '.astro/collections/poems.schema.json': schemaJson(['title', '$schema']),
    });
    const okAgree = !/這支腳本的正則沒抽到/.test(agree) && !/只有一把尺/.test(agree);
    if (!okAgree) failed++;
    console.log(`  ${okAgree ? '✓' : 'X'} 兩把尺一致時不亂講（Astro 自己那個 $schema 鍵不算欄位）`);

    /* 反向二：第二把尺不在的時候，要說出來，而不是安靜地當作過關 */
    const absent = await mkDir('schema-second-ruler-absent', {
      'src/content.config.ts': configTs,
      'astro.config.mjs': "export default { site: 'https://example.test' };\n",
    });
    const okAbsent = /欄位抽取只有一把尺/.test(absent);
    if (!okAbsent) failed++;
    console.log(`  ${okAbsent ? '✓' : 'X'} 第二把尺不在時說出來，不當作過關`);
  }

  /*
   * ── 「沒有任何一篇用過的欄位」這份名單 ──
   *
   * 它是靠正則從 content.config.ts 抽欄位名的，所以必須有兩件事成立：
   * 用過的欄位不會被列進去，以及抽不到的時候會**說自己沒查**（而不是印錯名單）。
   */
  {
    /*
     * `annotations` 那一段是刻意的：它的欄位 `term`／`gloss` 在 schema 裡
     * 寫在**同一行**（`z.object({ term: z.string(), gloss: z.string() })`），
     * 而在內容裡是**陣列項**（`- term:`）。兩種形狀各自需要抽取的一半，
     * 少了哪一半這一格都會紅 —— 突變掃描就是這樣補上的。
     */
    const withUpdated = poem().replace(
      'lang: zh-TW',
      'lang: zh-TW\nupdatedAt: 2026-01-01\nannotations:\n  - term: 烏衣\n    gloss: 舊時世族的住處',
    );
    const dir = await build('fields-used', {
      content: { 'poems/wu-yi-xiang.md': withUpdated },
      dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    });
    const out = await check(dir);
    const line = out.split('\n').find((l) => l.includes('沒有任何一篇內容用過的欄位')) ?? '';
    const ok =
      line !== '' &&
      !line.includes('updatedAt') &&
      !line.includes('term') &&
      line.includes('videoUrl') &&
      !out.includes('欄位使用情況沒有檢查');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 用過的欄位不會被列成「沒有人用過」`);
    if (!ok) console.log(`        實際印的是：${line || '（完全沒有這一行）'}`);
  }
  {
    /*
     * frontmatter 出現 schema 裡抽不到的欄位 —— 就是「抽取方式有洞」的樣子。
     * 這時要印「沒有檢查」，不能照樣印一份名單。
     */
    const odd = poem().replace('lang: zh-TW', 'lang: zh-TW\nzzzNotInSchema: 1');
    const dir = await build('fields-unreadable', {
      content: { 'poems/wu-yi-xiang.md': odd },
      dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    });
    const out = await check(dir);
    const ok =
      out.includes('欄位使用情況沒有檢查') && !out.includes('沒有任何一篇內容用過的欄位');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 抽不到欄位時說「沒有檢查」，而不是印一份可能是錯的名單`);
    if (!ok) {
      console.log(out.split('\n').filter((l) => l.includes('欄位')).map((l) => '        ' + l).join('\n'));
    }
  }

  /*
   * 反向案例：`related` 寫成抽不出來的形狀時要說「沒有檢查」，
   * 而不是安靜地當成「沒有 related」放行。
   *
   * 少了這一格，把那道自我檢查拿掉會**靜靜通過** —— 突變掃描量到的。
   */
  {
    const folded = poem().replace('lang: zh-TW', 'lang: zh-TW\nrelated: >-\n  wu-yi-xiang');
    const dir = await build('related-unreadable', {
      content: { 'poems/cjhy.md': folded },
      dist: { 'poems/cjhy/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    });
    const out = await check(dir);
    const ok = out.includes('related 的檢查沒有執行') && !out.includes('[bad-reference]');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} related 抽不出來時說「沒有檢查」（反向案例）`);
    await rm(dir, { recursive: true, force: true });
  }

  /*
   * 反向案例：索引的格式變了（解析不出 items）時要說「沒有檢查」，
   * 而不是把每一篇都報成「不在索引裡」。
   *
   * 少了這一格，把那道自我檢查拿掉會**靜靜通過** —— 突變掃描量到的。
   */
  {
    const dir = await build('index-unreadable', {
      content: { 'poems/wu-yi-xiang.md': poem() },
      dist: {
        'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
        'search-index.json': JSON.stringify({ n: 1, rows: [{ t: 'x', u: '/poems/wu-yi-xiang' }] }),
      },
    });
    const out = await check(dir);
    const ok = out.includes('搜尋索引沒有檢查') && !out.includes('[search-index-missing]');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 索引格式變了時說「沒有檢查」（反向案例）`);
    await rm(dir, { recursive: true, force: true });
  }

  /*
   * ── 誤報：草稿的字串別篇也有 ────────────────────────
   *
   * 第 3 輪（第十六圈）的探針：一篇草稿的標題剛好是**別篇已發佈**內容
   * 正文裡的一句話。舊版報「草稿洩漏」—— 洩漏的其實是別人的句子。
   *
   * 現在的行為分兩層：不報 `draft-leaked`（不猜），但要**說出來**
   * （這次沒有用字串比對），而且**不擋建置** ——
   * 用擋的等於把「你寫了一個跟別人重複的句子」變成建置失敗。
   */
  {
    const dir = await build('draft-shared-needle', {
      content: {
        'poems/wu-yi-xiang.md': poem({ first: '春天的雨落在瓦上' }),
        'notes/draft.md': '---\ntitle: 春天的雨落在瓦上\nlang: zh-TW\ndraft: true\n---\n還沒寫完。\n',
      },
      dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 春天的雨落在瓦上') },
    });
    const out = await check(dir);
    const ok =
      !out.includes('[draft-leaked]') &&
      out.includes('別篇已發佈的內容也有') &&
      out.includes('沒有發現問題');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 草稿的字串別篇也有：不報洩漏、說出來、不擋`);
    if (!ok) console.log(out.split('\n').filter(Boolean).slice(-6).map((l) => '        ' + l).join('\n'));
  }

  /*
   * 反向的那一半：字串是這篇獨有的時候，洩漏還是要抓。
   * 少了它，「一律不比對」也會通過上面那一格。
   */
  {
    const dir = await build('draft-unique-needle', {
      content: {
        'poems/wu-yi-xiang.md': poem(),
        'notes/draft.md': '---\ntitle: 還沒寫完的那一篇\nlang: zh-TW\ndraft: true\n---\n還沒寫完。\n',
      },
      dist: {
        'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
        'index.html': page('最新：還沒寫完的那一篇'),
      },
    });
    const out = await check(dir);
    const ok = out.includes('[draft-leaked]');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 草稿的字串是獨有的：洩漏照樣抓得到`);
    if (!ok) console.log(out.split('\n').filter(Boolean).slice(-6).map((l) => '        ' + l).join('\n'));
  }

  /*
   * ── dist/ 比內容舊的時候，要先說那件事 ──────────────
   *
   * 這幾條規則比的是「src/content 有什麼」對「dist 有什麼」，而**最常見的
   * 不一致原因不是 bug，是還沒重新 build**。第 3 輪（第十七圈）實測那個情境：
   * 加一首詩、不 build、跑這支檢查，得到的是「某個路由可能漏掉它了」——
   * 站主會照著那句話去 src/pages/ 找一個不存在的 bug。
   *
   * 兩個方向都要測：舊的時候要說、新的時候不要說（不然那句話就變成噪音，
   * 而且會把真的路由 bug 誤導成「重 build 就好」）。
   */
  {
    /** @param {string} dir @param {number} ms */
    const ageDist = async (dir, ms) => {
      const when = new Date(Date.now() - ms);
      /** @param {string} d */
      const walk = async (d) => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) await walk(full);
          else await utimes(full, when, when);
        }
      };
      await walk(join(dir, 'dist'));
    };
    const files = {
      content: { 'poems/wu-yi-xiang.md': poem() },
      dist: { 'index.html': page('首頁') },
    };

    const stale = await build('stale-dist', files);
    await ageDist(stale, 60 * 60 * 1000);
    const staleOut = await check(stale);
    const staleOk =
      staleOut.includes('先跑 npm run build 再看下面的結果') &&
      staleOut.includes('多半只是還沒重新建置');
    if (!staleOk) failed++;
    console.log(`  ${staleOk ? '✓' : 'X'} dist 比內容舊：先說「去 build」`);
    if (!staleOk) console.log(staleOut.split('\n').filter(Boolean).slice(-4).map((l) => '        ' + l).join('\n'));

    const fresh = await build('fresh-dist', files);
    const freshOut = await check(fresh);
    const freshOk =
      !freshOut.includes('先跑 npm run build 再看下面的結果') &&
      freshOut.includes('dist/ 是新的');
    if (!freshOk) failed++;
    console.log(`  ${freshOk ? '✓' : 'X'} dist 是新的：不說那句話，改指路由`);
    if (!freshOk) console.log(freshOut.split('\n').filter(Boolean).slice(-4).map((l) => '        ' + l).join('\n'));
  }

  /*
   * ── 同步的資料放了多久 ──────────────────────────
   *
   * 第 3 輪（第二十六圈）量到的：`/colophon` 印「來源狀態：1 個正常」，
   * 而那是**上一次真的跑過**時記下的狀態 —— 排程從此不再觸發的話，
   * 那一頁會永遠說「1 個正常」。停掉的排程跟健康的排程長得一模一樣。
   *
   * 這一項只說話、不擋（剛 clone 的機器資料本來就會舊，擋下來是製造誤報）。
   */
  {
    const stale = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const fresh = new Date(Date.now() - 6 * 3_600_000).toISOString();

    /**
     * @param {string} label
     * @param {string | null} generatedAt null 代表根本沒有那個檔案
     * @param {(out: string) => boolean} want
     */
    const withSync = async (label, generatedAt, want) => {
      const dir = await build(`sync-${label}`, {
        content: { 'poems/wu-yi-xiang.md': poem() },
        dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
      });
      const at = join(dir, 'src/data');
      if (generatedAt !== null) {
        await mkdir(at, { recursive: true });
        await writeFile(join(at, 'syndication.json'), JSON.stringify({ generatedAt, sources: {}, items: [] }), 'utf8');
      }
      const { out } = await checkWithCode(dir, [`--syndication=${join(at, 'syndication.json')}`]);
      const ok = want(out);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : 'X'} ${label}`);
      if (!ok) console.log('        ' + out.split('\n').filter((l) => l.includes('同步')).join('\n        ') || '        （完全沒提到同步）');
      await rm(dir, { recursive: true, force: true });
    };

    await withSync('同步資料放很久：說出來（但不擋）', stale, (out) => /同步的資料已經 [\d.]+ 天沒更新/.test(out));
    await withSync('同步資料是新的：不說那句話（反向案例）', fresh, (out) => !/天沒更新/.test(out));
    await withSync('沒有那個檔案：說「沒有檢查」而不是安靜跳過', null, (out) => /同步資料的新舊沒有檢查/.test(out));

    /*
     * ── 來源死掉，跟排程停掉，是兩件事 ────────────────
     *
     * 第 4 輪（第三十圈）：`generatedAt` 每跑一次就更新，不管來源成不成功。
     * 排程一天兩次，所以上面那個「3 天沒更新」的鬧鐘在排程活著的時候
     * **永遠不會響** —— 來源死了幾個月也一樣。
     *
     * 第一格是這件事的證明：`generatedAt` 是新的、`lastSuccessAt` 是舊的。
     * 舊的判準在那一格完全安靜。
     */
    /**
     * @param {string} label
     * @param {unknown} json 整份 syndication.json
     * @param {(out: string) => boolean} want
     */
    const withJson = async (label, json, want) => {
      const dir = await build(`cold-${label}`, {
        content: { 'poems/wu-yi-xiang.md': poem() },
        dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
      });
      const at = join(dir, 'src/data');
      await mkdir(at, { recursive: true });
      await writeFile(join(at, 'syndication.json'), JSON.stringify(json), 'utf8');
      const { out } = await checkWithCode(dir, [`--syndication=${join(at, 'syndication.json')}`]);
      const ok = want(out);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : 'X'} ${label}`);
      if (!ok) {
        const said = out.split('\n').filter((l) => /來源|成功|天沒更新/.test(l)).join(' ｜ ');
        console.log('        ' + (said || '（完全沒提到來源）'));
      }
      await rm(dir, { recursive: true, force: true });
    };

    /* `fresh` 這個名字外面那一格已經用掉了 —— 型別關卡當場說 ts(2451) */
    const justNow = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const long = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const src = (/** @type {string | null} */ lastSuccessAt) => ({
      generatedAt: justNow,
      sources: { yt: { status: 'error', platform: 'youtube', itemCount: 9, lastSuccessAt, message: 'x' } },
      items: [],
    });

    await withJson(
      '排程是新的、來源 20 天沒成功：說出來（舊判準在這一格完全安靜）',
      src(long),
      (out) => /1 個已經超過 3 天沒有成功過/.test(out) && !/天沒更新/.test(out),
    );
    await withJson('來源剛剛才成功過：不說那句話（反向案例）', src(justNow), (out) => !/沒有成功過/.test(out));
    await withJson(
      'lastSuccessAt 是空的：說「從來沒有成功過」',
      src(null),
      (out) => /從來沒有成功過/.test(out),
    );
    /* 反向：一個來源都沒有的時候不要無中生有 */
    await withJson(
      '一個來源都沒有：不說那句話（反向案例）',
      { generatedAt: justNow, sources: {}, items: [] },
      (out) => !/沒有成功過/.test(out),
    );
  }

  /*
   * ── 那份排除清單，哪幾條什麼都沒擋 ──────────────────
   *
   * 第 3 輪（第三十二圈）：`SCHEMA_STRUCTURAL` 有 6 個名字，
   * 實測只有 3 個真的濾到東西。`base` 最有意思 —— 它在
   * `content.config.ts` 裡出現 4 次，但都寫在 `glob({ base: … })` 裡面，
   * 而抽取的正則只認行首那種，所以從來沒抽到它。
   *
   * 語料要同時有「真的擋到的」與「什麼都沒擋的」，
   * 不然「一律說沒擋」跟「真的算」在輸出上是同一句話。
   */
  {
    /**
     * @param {string} label
     * @param {string} config 假的 content.config.ts
     * @param {(out: string) => boolean} want
     */
    const withConfig = async (label, config, want) => {
      const dir = await build(`struct-${label}`, {
        content: { 'poems/wu-yi-xiang.md': poem() },
        dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
        extra: { 'src/content.config.ts': config },
      });
      const out = await check(dir, [`--src=${join(dir, 'src')}`]);
      const ok = want(out);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : 'X'} ${label}`);
      if (!ok) {
        const said = out.split('\n').filter((l) => l.includes('SCHEMA_STRUCTURAL')).join(' ｜ ');
        console.log('        ' + (said || '（完全沒提到 SCHEMA_STRUCTURAL）'));
      }
      await rm(dir, { recursive: true, force: true });
    };

    /* `loader` 在行首會被抽到（真的擋到），`type`／`message`／`base` 抽不到 */
    await withConfig(
      '有的擋到、有的沒擋到：只點名沒擋到的那幾個',
      "const c = {\n  loader: glob({ base: './x' }),\n  schema: z.object({ title: z.string() }),\n};\n",
      (out) => {
        const m = /SCHEMA_STRUCTURAL 有 (\d+) 個名字，這一輪\*\*(\d+) 個什麼都沒擋\*\*：(.+?)。/.exec(out);
        /* 總數要大於「沒擋到的」—— 不然「總數印成沒擋到的那個數」看不出來 */
        return (
          m !== null &&
          Number(m[1]) > Number(m[2]) &&
          Number(m[2]) === 4 &&
          m[3].trim() === 'base、error、message、type'
        );
      },
    );
    /* 反向：六個全部都抽得到的話，整段不該出現 */
    await withConfig(
      '六個全部都擋到：整段不印（反向案例）',
      "const c = {\n  loader: 1,\n  schema: 1,\n  type: 1,\n  base: 1,\n  message: 1,\n  error: 1,\n};\n",
      (out) => !/什麼都沒擋/.test(out),
    );
  }

  /*
   * ── translationKey：填了，然後呢 ──────────────────────
   *
   * 第 3 輪（第三十一圈）量到：真的 repo 裡 3 篇填了 translationKey，
   * 而每一個 key 都只有一篇 —— 跨語言互連那條路從來沒跑過。
   *
   * 「真的 repo 現在是 0」正是這一格必須存在的理由：突變「配成對的數字
   * 一律印 0」在真站上看不出來，因為答案剛好就是 0。
   * 所以這裡做一份**真的有配對**的語料。
   */
  {
    /**
     * @param {string} label
     * @param {Record<string, string>} content
     * @param {(out: string) => boolean} want
     */
    const withKeys = async (label, content, want) => {
      const dir = await build(`tk-${label}`, {
        content,
        dist: Object.fromEntries(
          Object.keys(content).map((k) => [
            k.replace(/^poems\//, 'poems/').replace(/\.md$/, '/index.html'),
            page('烏衣巷 — 朱雀橋邊野草花'),
          ]),
        ),
      });
      const out = await check(dir);
      const ok = want(out);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : 'X'} ${label}`);
      if (!ok) {
        const said = out.split('\n').filter((l) => l.includes('translationKey')).join(' ｜ ');
        console.log('        ' + (said || '（完全沒提到 translationKey）'));
      }
      await rm(dir, { recursive: true, force: true });
    };

    const withKey = (/** @type {string} */ key, /** @type {string} */ lang) =>
      poem({ lang }).replace('lang: ' + lang, `lang: ${lang}\ntranslationKey: ${key}`);

    await withKeys(
      '兩篇共用一個 key：說「1 組真的配成對」',
      { 'poems/a.md': withKey('wu-yi', 'zh-TW'), 'poems/b.md': withKey('wu-yi', 'en') },
      (out) => /2 篇填了、1 個 key，其中 \*\*1 組真的配成對\*\*/.test(out),
    );
    /* 反向：每個 key 各自獨立時要說 0，而且要講明那是「還沒被翻譯過」不是壞了 */
    await withKeys(
      '每個 key 各自獨立：說「0 組」並解釋（反向案例）',
      { 'poems/a.md': withKey('aaa', 'zh-TW'), 'poems/b.md': withKey('bbb', 'zh-TW') },
      (out) => /2 篇填了、2 個 key，其中 \*\*0 組真的配成對\*\*/.test(out) && /還沒有任何一篇被翻譯過/.test(out),
    );
  }

  /*
   * ── 語言清單的四份要一致 ────────────────────────────
   *
   * 第 3 輪（第三十一圈）量到 `['zh-TW', 'en']` 寫在四個地方
   * （site.ts 的型別、content.config 的 Zod、astro.config 的路由與 sitemap 對照），
   * 而沒有任何東西檢查它們一樣 —— 「只有中文與英文」是三條硬性限制之一，
   * 卻只寫在散文裡。
   *
   * 這幾格用真的 ROOT 底下那四個檔案的**副本**，改其中一份再比對。
   */
  {
    /**
     * @param {string} label
     * @param {Record<string, string>} files 相對於假 root 的路徑 → 內容
     * @param {(out: string, code: number) => boolean} want
     */
    const withRoot = async (label, files, want) => {
      const dir = await build(`loc-${label}`, {
        content: { 'poems/wu-yi-xiang.md': poem() },
        dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
      });
      for (const [rel, body] of Object.entries(files)) {
        await mkdir(dirname(join(dir, rel)), { recursive: true });
        await writeFile(join(dir, rel), body, 'utf8');
      }
      const { out, code } = await checkWithCode(dir, [`--src=${join(dir, 'src')}`, `--astro=${join(dir, 'astro.config.mjs')}`]);
      const ok = want(out, code);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : 'X'} ${label}`);
      if (!ok) {
        const said = out.split('\n').filter((l) => /語言清單|locale-list/.test(l)).join(' ｜ ');
        console.log('        ' + (said || `（完全沒提到語言清單，exit ${code}）`));
      }
      await rm(dir, { recursive: true, force: true });
    };

    const four = (/** @type {string} */ enumList) => ({
      'src/config/site.ts': "export const LOCALES = ['zh-TW', 'en'] as const;\n",
      'src/content.config.ts': `const LOCALE = z.enum([${enumList}]).default('zh-TW');\n`,
      'astro.config.mjs':
        "export default { i18n: { locales: ['zh-TW', 'en'] }, integrations: [sitemap({ i18n: { locales: { 'zh-TW': 'zh-Hant-TW', en: 'en' } } })] };\n",
    });

    await withRoot('四份一致：不報（反向案例）', four("'zh-TW', 'en'"), (out) => !/locale-list-drift/.test(out));
    await withRoot(
      '有一份少了語言：擋下來',
      four("'zh-TW'"),
      (out, code) => /locale-list-drift/.test(out) && code === 1,
    );
    /*
     * 反向：抽不到的時候要說「沒有比對到」，不是安靜地當成一致 ——
     * 一份抽不到就只剩三份在比，而輸出看起來跟四份全對一樣。
     */
    await withRoot(
      '抽不到其中一份：說「沒有比對到」而不是安靜放行',
      { ...four("'zh-TW', 'en'"), 'src/config/site.ts': 'export const LOCALES = ALL_LOCALES;\n' },
      (out) => /語言清單只比對了 3／4 份/.test(out),
    );
  }

  /*
   * ── 版面斷點的清單 ──────────────────────────────────
   *
   * 第 8 輪（第三十圈）實測：把一處 `@media (max-width: 34rem)` 改成
   * `32rem`，重建，六道關卡加兩套測試**全綠** —— 而 33rem 寬的視窗上
   * 頁首與頁尾會切在不同的版面，中間裂一條縫。
   *
   * 這一項只數，不判斷對錯（這個站真的有四種斷點，「全部要一樣」是錯的），
   * 所以這幾格驗的是「數得對」。
   */
  {
    /**
     * @param {string} label
     * @param {string} css 放進假 dist 的一份外部 CSS
     * @param {(out: string) => boolean} want
     */
    const withCss = async (label, css, want) => {
      const dir = await build(`bp-${label}`, {
        content: { 'poems/wu-yi-xiang.md': poem() },
        dist: {
          'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
          '_astro/x.css': css,
        },
      });
      const { out } = await checkWithCode(dir);
      const ok = want(out);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : 'X'} ${label}`);
      if (!ok) {
        const said = out.split('\n').filter((l) => l.includes('版面斷點')).join(' ｜ ');
        console.log('        ' + (said || '（完全沒提到版面斷點）'));
      }
      await rm(dir, { recursive: true, force: true });
    };

    /*
     * 少的那個**寫在前面** —— 這樣「出現順序」跟「照數量排」是兩個不同的答案。
     * 第一版把 34rem 寫在前面，於是突變「不排序」照樣全綠：
     * 兩種順序在那份語料上剛好一樣。判準沒問題，是語料分不出來
     * （這一圈第三次踩到，前兩次在第 2 輪與第 5 輪）。
     */
    await withCss(
      '兩種斷點：數得出各幾處，多的排前面',
      '@media (max-width: 32rem){c{color:red}}@media (max-width: 34rem){a{color:red}}@media (max-width: 34rem){b{color:red}}',
      (out) => /版面斷點：2 種，共 3 處 —— 34rem × 2、32rem × 1/.test(out),
    );
    /* 壓縮過的 CSS 寫的是 `(width<=34rem)` —— 只認沒壓縮那種的話，真的站上一處都數不到 */
    await withCss(
      '壓縮過的 (width<=34rem) 也算（反向案例）',
      '@media (width<=34rem){a{color:red}}',
      (out) => /版面斷點：1 種，共 1 處 —— 34rem × 1/.test(out),
    );
    /* 反向：一個 max-width 查詢都沒有時說「沒有檢查」，不是安靜跳過 */
    await withCss(
      '一個斷點都沒有：說「沒有檢查」而不是安靜跳過',
      'a{color:red}@media print{b{color:blue}}',
      (out) => /版面斷點沒有檢查/.test(out),
    );
    /* 反向：min-width 不算 —— 這個站用的是 max-width，混進來數字會對不上 */
    await withCss(
      'min-width 不算（反向案例）',
      '@media (min-width: 40rem){a{color:red}}@media (max-width: 34rem){b{color:red}}',
      (out) => /版面斷點：1 種，共 1 處 —— 34rem × 1/.test(out),
    );
  }

  /*
   * ── 從 src/pages 走不到的元件 ────────────────────────
   *
   * 第 3 輪（第三十圈）加的。跟上面的同步資料一樣**只說話、不擋** ——
   * 「要刪還是要接上去」是站主的決定。
   *
   * 這幾格守的是四件會讓它安靜失效的事：別名解不開、遞移沒走完、
   * glob 不算數、以及反過來的誤報。
   */
  {
    /**
     * @param {string} label
     * @param {Record<string, string>} tree `src/` 底下的相對路徑 → 內容
     * @param {(out: string) => boolean} want
     */
    const withSrc = async (label, tree, want) => {
      const dir = await build(`unreached-${label}`, {
        content: { 'poems/wu-yi-xiang.md': poem() },
        dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
      });
      const fake = join(dir, 'fakesrc');
      for (const [rel, body] of Object.entries(tree)) {
        await mkdir(dirname(join(fake, rel)), { recursive: true });
        await writeFile(join(fake, rel), body, 'utf8');
      }
      const { out } = await checkWithCode(dir, [`--src=${fake}`]);
      const ok = want(out);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : 'X'} ${label}`);
      if (!ok) {
        const said = out.split('\n').filter((l) => /走不到|元件/.test(l)).join(' ｜ ');
        console.log('        ' + (said || '（完全沒提到元件）'));
      }
      await rm(dir, { recursive: true, force: true });
    };

    const named = (/** @type {string} */ f) => (/** @type {string} */ out) =>
      new RegExp('· .*components/' + f).test(out);
    const quiet = (/** @type {string} */ f) => (/** @type {string} */ out) => !named(f)(out);

    await withSrc(
      '沒有人 import 的元件：說出來',
      { 'pages/index.astro': '<p>x</p>', 'components/Orphan.astro': '<p>孤兒</p>' },
      named('Orphan.astro'),
    );

    /* 反向一：相對路徑 import 得到就不該報 */
    await withSrc(
      '頁面用相對路徑 import 它：不報（反向案例）',
      {
        'pages/index.astro': "---\nimport Used from '../components/Used.astro';\n---\n<Used />",
        'components/Used.astro': '<p>有人用</p>',
      },
      quiet('Used.astro'),
    );

    /*
     * 反向二：別名。別名是從 tsconfig.json 讀的 ——
     * 少了這一格，「別名一律解不開」的寫法會讓**每一個**元件都被報成走不到，
     * 而那時候第一格照樣是綠的（它本來就該被報）。
     */
    await withSrc(
      '頁面用 @components 別名 import 它：不報（反向案例）',
      {
        'pages/index.astro': "---\nimport Used from '@components/Used.astro';\n---\n<Used />",
        'components/Used.astro': '<p>有人用</p>',
      },
      quiet('Used.astro'),
    );

    /* 反向三：遞移 —— 頁面 → 甲 → 乙，乙也算走得到 */
    await withSrc(
      '隔一層 import 到的也算走得到（反向案例）',
      {
        'pages/index.astro': "---\nimport A from '@components/A.astro';\n---\n<A />",
        'components/A.astro': "---\nimport B from '@components/B.astro';\n---\n<B />",
        'components/B.astro': '<p>乙</p>',
      },
      quiet('B.astro'),
    );

    /*
     * 正向二：甲是死的，那只有甲在 import 的乙也是死的。
     * 只數「有沒有人 import」的寫法在這一格會說乙有人用。
     */
    await withSrc(
      '只有死元件在 import 的元件，也是死的',
      {
        'pages/index.astro': '<p>x</p>',
        'components/Dead.astro': "---\nimport B from '@components/OnlyFromDead.astro';\n---\n<B />",
        'components/OnlyFromDead.astro': '<p>乙</p>',
      },
      (out) => named('Dead.astro')(out) && named('OnlyFromDead.astro')(out),
    );

    /* 反向四：import.meta.glob 也算 import —— identity.local.ts 就是這樣進來的 */
    await withSrc(
      'import.meta.glob 進來的也算走得到（反向案例）',
      {
        'pages/index.astro': "---\nconst m = import.meta.glob('@components/Globbed.astro');\n---\n<p>x</p>",
        'components/Globbed.astro': '<p>glob</p>',
      },
      quiet('Globbed.astro'),
    );
  }

  /*
   * ── 一個內容檔都沒有的時候，不能說「沒有發現問題」──────
   *
   * 第 3 輪（第二十五圈）量到：`--content=` 指到空目錄時，這支腳本印
   * 「0 篇內容⋯沒有發現問題」然後 exit 0 —— 十四條規則裡十二條沒東西可判斷，
   * 而判決那一行是綠的。
   *
   * 第二格是這一格的代價：判準必須數**檔案**，不能數 entries。
   * 沒有 title 的檔案會被 `continue` 掉，永遠進不了 entries ——
   * 用 entries 當判準的話，`no-title` 那一格會被誤判成「一個檔案都沒有」
   * （第一版就是那樣寫的，那一格當場紅了）。
   */
  {
    const dir = await build('no-content', { content: {}, dist: { 'index.html': page('首頁') } });
    const { out, code } = await checkWithCode(dir);
    const ok = /一篇內容都沒有/.test(out) && !/沒有發現問題/.test(out) && code === 1;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 一個內容檔都沒有：不說「沒有發現問題」，而且擋得住`);
    if (!ok) console.log('        ' + out.split('\n').filter(Boolean).join('\n        ') + `（exit ${code}）`);
  }

  {
    /* 只有一個壞掉的檔案，不算「一個檔案都沒有」—— 那一條規則要照樣響 */
    const dir = await build('one-broken', {
      content: { 'poems/x.md': '---\nlang: zh-TW\n---\n沒有 title 的東西。\n' },
      dist: { 'index.html': page('首頁'), 'search-index.json': JSON.stringify({ n: 0, items: [] }) },
    });
    const { out } = await checkWithCode(dir);
    const ok = /\[no-title\]/.test(out) && !/一篇內容都沒有/.test(out);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 只有一個壞掉的檔案：報那條規則，不是報「沒有內容」`);
    if (!ok) console.log('        ' + out.split('\n').filter(Boolean).slice(0, 6).join('\n        '));
  }

  /*
   * ── 每一條規則都要說得出「改法：」────────────────────
   *
   * 第十七圈問的是「站主照著做得到嗎」。第 1 輪（a11y）量到 14 條只講事實，
   * 這一支好一些，但措辭不一致：有的講了改法卻沒有標記，
   * 有的（`no-title`，而那是站主最常踩的一條）只有一句「找不到 title」。
   *
   * 統一用「改法：」當標記，這一格守它不會退回去。
   * 判準跟 `test:a11y-rules` 那一格一樣，是慣例不是規範。
   */
  {
    const src = await readFile(resolve(ROOT, 'scripts/check-content.mjs'), 'utf8');
    const ids = [...new Set([...src.matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]))];
    const missing = [];
    for (const id of ids) {
      /* 抓這條規則的 msg 區塊：從 id 那一行到下一個 `});` */
      const at = src.indexOf(`id: '${id}'`);
      const block = src.slice(at, src.indexOf('});', at));
      if (!block.includes('改法：')) missing.push(id);
    }
    if (missing.length > 0) {
      failed += missing.length;
      console.log(`\n  X 這些規則的訊息沒有講「改法：」：${missing.join('、')}`);
      console.log('      站主看到的是一句事實，不知道下一步要做什麼。');
    } else {
      console.log(`  ✓ ${ids.length} 條規則都講了「改法：」`);
    }
  }

  // 有沒有規則漏了案例
  {
    const source = await readFile(resolve(ROOT, 'scripts/check-content.mjs'), 'utf8');
    const ids = [...new Set([...source.matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]))];
    /*
     * 抽不到 id 的話上面那個比對會「沒有缺的」而安靜通過 —— 假綠燈。
     * 這個 repo 修過同一種東西（第 5 輪〔第三圈〕的 check:history
     * 在查不了的時候回 exit 0）。所以先確認真的抽到了東西。
     */
    /*
     * 比對的是**相異的規則 id**，不是案例數 —— 一條規則可以有第二個案例
     * （`expect`），拿案例數當下限會在那時誤報。
     * 第 3 輪（第十六圈）加「書名號整個包起來」那一格時踩到的。
     */
    const expected = new Set(
      Object.entries(CASES).map(([label, c]) => /** @type {any} */ (c).expect ?? label),
    );
    if (ids.length < expected.size) {
      failed++;
      console.log(`\n  X 只從 check-content.mjs 抽到 ${ids.length} 個規則 id，`);
      console.log(`      但案例涵蓋 ${expected.size} 條規則 —— 抽取方式可能壞了。`);
    }
    const missing = ids.filter((i) => !expected.has(i));
    if (missing.length > 0) {
      failed += missing.length;
      console.log(`\n  X 這些規則沒有測試案例：${missing.join('、')}`);
      console.log('      加規則就要加案例 —— 沒有案例的規則等於沒有人確認過它會響。');
    }

    /*
     * ── 每條規則都要在 RULES 名單裡 ──
     *
     * 那份名單是「誰是空的」報告的來源。一條規則沒被列進去，
     * 它主體數為 0 的時候會**安靜地不出現在名單上** ——
     * 而「綠得因為空」的規則正是最需要被列出來的那種。
     * 跟 `test:a11y-rules` 守 `saw()` 呼叫是同一個形狀（第 1 輪〔第十五圈〕）。
     */
    const declared = source
      .match(/const RULES = \[([\s\S]*?)\];/)?.[1]
      ?.match(/'([a-z-]+)'/g)
      ?.map((q) => q.slice(1, -1));
    if (!declared || declared.length === 0) {
      failed++;
      console.log('\n  X 抽不到 check-content.mjs 的 RULES 名單 —— 抽取方式可能壞了。');
    } else {
      const notDeclared = ids.filter((i) => !declared.includes(i));
      const notARule = declared.filter((d) => !ids.includes(d));
      if (notDeclared.length > 0 || notARule.length > 0) {
        failed++;
        if (notDeclared.length > 0) {
          console.log(`\n  X 這些規則不在 RULES 名單裡：${notDeclared.join('、')}`);
          console.log('      主體數為 0 的時候它們不會出現在「沒東西可看」的名單上。');
        }
        if (notARule.length > 0) {
          console.log(`\n  X RULES 名單裡有不存在的規則：${notARule.join('、')}`);
        }
      } else {
        console.log(`  ✓ 規則都在 RULES 名單裡（${declared.length} 條）`);
      }
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log('─'.repeat(64));
/*
 * ── 第一次跑的人看得到什麼 ──────────
 *
 * 第 3 輪（第二十九圈）問「第一次跑的人跟第一百次跑的人看到的是同一份
 * 東西嗎」。這一支本來說「6 篇內容，產出 50 個檔案」——
 * 說了掃了什麼，沒說用幾條規則掃的；而 `--verbose` 多印的那 16 行
 * （每條規則實際判斷過幾個東西）正是「綠燈代表什麼」的答案，卻沒人看得見。
 */
{
  const dir = await build('firsttime', {
    content: { 'notes/x.md': '---\ntitle: 測試\nlang: zh-TW\n---\n內文。\n' },
    dist: { 'notes/x/index.html': page('<h1>測試</h1>') },
  });
  const out = await check(dir);
  const okRules = /\d+ 條規則/.test(out);
  if (!okRules) failed++;
  console.log(`  ${okRules ? '✓' : 'X'} 標題說得出用了幾條規則`);
  if (!okRules) console.log('        ' + out.split('\n').slice(0, 6).join(' | '));

  const okVerbose = /--verbose/.test(out);
  if (!okVerbose) failed++;
  console.log(`  ${okVerbose ? '✓' : 'X'} 綠燈時說得出怎麼看「判斷過多少東西」（--verbose）`);
  if (!okVerbose) console.log('        ' + out.split('\n').filter(Boolean).slice(0, 8).join(' | '));

  /*
   * 反向：`--verbose` 模式自己不再提示自己。
   *
   * 突變掃描抓到的語料缺口：把那個判斷改成 `if (true)` 之後測試照樣全綠，
   * 因為沒有一格跑過 verbose 那條路。在已經看得到明細的地方
   * 再叫人去看明細，是純粹的噪音。
   */
  const verbose = await checkWithCode(dir, ['--verbose']);
  const okQuiet = !/要看每條規則實際判斷過/.test(verbose.out);
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} --verbose 模式不再提示自己（反向案例）`);
  if (!okQuiet) console.log('        ' + verbose.out.split('\n').filter(Boolean).slice(-4).join(' | '));

}

/*
 * ── 詩詞的 title 被 poem.title 蓋掉時要說出來 ──────────
 *
 * 第 3 輪（第三十三圈）：六條會顯示詩名的路徑全部用 `poem.title`，
 * 所以詩詞的 `title` 是必填而且沒有讀者看得到。
 * 兩個值一樣的時候完全看不出來 —— 而 `npm run write` 兩個都填同一個答案，
 * 所以它產出的每一篇都剛好遮住這件事。
 *
 * 這一格要兩個方向：不一樣的時候要說，一樣的時候不能亂說。
 * 只驗「會說」的話，一條「永遠都說」的規則也會過。
 *
 * 它**不擋**（離開碼 0）—— 要不要讓列表顯示 title 是站主的取捨，
 * 所以這裡也順便釘住「只說不擋」這件事。
 */
{
  const poem = (/** @type {string} */ t, /** @type {string} */ pt) =>
    `---\ntitle: ${t}\nlang: zh-TW\npublishedAt: 2026-01-01\npoem:\n  title: ${pt}\n  author: 李白\n---\n內文。\n`;

  const dirA = await build('title-shadowed', {
    content: { 'poems/a.md': poem('琵琶行（節錄）', '琵琶行') },
    dist: { 'poems/a/index.html': page('〈琵琶行〉白居易') },
  });
  const a = await checkWithCode(dirA);
  const okSays = /title 讀者看不到/.test(a.out) && a.out.includes('琵琶行（節錄）');
  if (!okSays) failed++;
  console.log(`  ${okSays ? '\u2713' : 'X'} title 與 poem.title 不一樣時會說出來`);
  if (!okSays) console.log('        ' + a.out.split('\n').filter((l) => /title/.test(l)).join(' ｜ '));

  const okQuiet = a.code === 0;
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '\u2713' : 'X'} 只說不擋（離開碼 ${a.code}）`);

  const dirB = await build('title-same', {
    content: { 'poems/b.md': poem('靜夜思', '靜夜思') },
    dist: { 'poems/b/index.html': page('〈靜夜思〉李白') },
  });
  const b = await checkWithCode(dirB);
  const okSilent = !/title 讀者看不到/.test(b.out);
  if (!okSilent) failed++;
  console.log(`  ${okSilent ? '\u2713' : 'X'} 兩個一樣時不會亂說`);
  if (!okSilent) console.log('        ' + b.out.split('\n').filter((l) => /title/.test(l)).join(' ｜ '));
}

/*
 * ── 斷點清單要說出它只數 max-width ──────────
 *
 * 第 3 輪（第三十五圈）用第二種算法數斷點，答案跟關卡不一樣。
 * 追下去是我錯（掃了 `src/` 連註解、把 `min-width` 也算進去），
 * **但那一行確實沒說它只數 `max-width`** —— 照著它去對的人會得到別的數字。
 *
 * 兩個方向：沒有 min-width 時要說「0 處」，有的時候要列出來。
 * 只驗一邊的話，一句寫死的「0 處」也會過。
 */
{
  const none = await build('bp-none', {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      '_astro/x.css': '@media (max-width: 34rem){.a{color:red}}.poem__original{writing-mode:vertical-rl}\n',
    },
  });
  const outNone = await check(none);
  const okZero = /min-width 這一輪 0 處/.test(outNone);
  if (!okZero) failed++;
  console.log(`  ${okZero ? '\u2713' : 'X'} 沒有 min-width 時說得出「0 處」`);
  if (!okZero) console.log('        ' + (outNone.split('\n').find((l) => l.includes('斷點')) ?? '（沒印）'));
  await rm(none, { recursive: true, force: true });

  const some = await build('bp-some', {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: {
      'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
      '_astro/x.css':
        '@media (max-width: 34rem){.a{color:red}}@media (min-width: 30rem){.b{color:blue}}' +
        '.poem__original{writing-mode:vertical-rl}\n',
    },
  });
  const outSome = await check(some);
  const okSome = /另有 1 處 min-width：30rem × 1/.test(outSome);
  if (!okSome) failed++;
  console.log(`  ${okSome ? '\u2713' : 'X'} 有 min-width 時列得出來（30rem × 1）`);
  if (!okSome) console.log('        ' + (outSome.split('\n').find((l) => l.includes('斷點')) ?? '（沒印）'));
  await rm(some, { recursive: true, force: true });
}

/*
 * ── manifest 那條的另外兩個方向 ──────────────────
 *
 * 上面 `CASES` 那一格證明「對不上會響」。這裡補兩件事：
 * 對得上的時候不能亂響，讀不到／壞掉的時候不能安靜過去。
 *
 * 描述那一項刻意用前綴：manifest 現在寫的是 `site.ts` 描述的第一句。
 * 只驗「完全相等」的話，今天這個站就會紅；只驗「有響」的話，
 * 一條永遠都響的規則也會過。
 */
{
  const base = {
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
  };
  const siteTs =
    "export const site = {\n  name: { 'zh-TW': '狐說八道', en: 'Fox Says' },\n" +
    "  description: { 'zh-TW': '朗誦經典詩詞曲，用今天的話說出其中的意思。日常的閱讀也收在這裡。', en: 'x' },\n" +
    "  themeColor: { light: '#faf6ee', dark: '#14120f' },\n} as const;\n";
  /** @param {string} name @param {Record<string, string>} extra */
  const run1 = async (name, extra) => {
    const dir = await build(name, { ...base, extra: { 'src/config/site.ts': siteTs, ...extra } });
    const out = await check(dir, [`--src=${join(dir, 'src')}`, `--astro=${join(dir, 'astro.config.mjs')}`]);
    await rm(dir, { recursive: true, force: true });
    return out;
  };

  const agreeing = await run1('manifest-agree', {
    'public/site.webmanifest': JSON.stringify({
      name: '狐說八道',
      short_name: '狐說八道',
      /* 短版：是 site.ts 那句的開頭 */
      description: '朗誦經典詩詞曲，用今天的話說出其中的意思。',
      theme_color: '#FAF6EE',
      background_color: '#faf6ee',
    }),
  });
  const okAgree = !agreeing.includes('[manifest-drift]');
  if (!okAgree) failed++;
  console.log(`  ${okAgree ? '\u2713' : 'X'} 對得上時不亂報（短版描述、大小寫不同的色碼都算對）`);
  if (!okAgree) {
    console.log('        ' + (agreeing.split('\n').find((l) => l.includes('manifest')) ?? '（沒印）'));
  }

  /*
   * 每一項各自要有一格。
   *
   * 上面 `CASES` 那一格只讓**顏色**對不上，於是把描述與站名那兩個比較
   * 各自改成 `true`（等於停掉那一項）之後，測試照樣全綠 ——
   * 因為顏色那一項還在響，`[manifest-drift]` 照樣出現。
   * 突變掃描抓到的：三個比較裡只有一個真的被守著。
   */
  for (const [label, field, mf, want] of /** @type {[string, string, Record<string, string>, string][]} */ ([
    [
      '站名對不上時點名 name',
      'name',
      { name: '狐说八道', short_name: '狐說八道', description: '朗誦經典詩詞曲，用今天的話說出其中的意思。', theme_color: '#faf6ee', background_color: '#faf6ee' },
      "name 跟 site.ts 的 name['zh-TW'] 對不起來",
    ],
    [
      '描述不是開頭時點名 description',
      'description',
      { name: '狐說八道', short_name: '狐說八道', description: '朗誦經典詩詞曲，說出別的意思。', theme_color: '#faf6ee', background_color: '#faf6ee' },
      "description 跟 site.ts 的 description['zh-TW'] 對不起來",
    ],
  ])) {
    const out = await run1(`manifest-${field}`, { 'public/site.webmanifest': JSON.stringify(mf) });
    const ok = out.includes(want);
    if (!ok) failed++;
    console.log(`  ${ok ? '\u2713' : 'X'} ${label}`);
    if (!ok) console.log('        ' + (out.split('\n').find((l) => l.includes('manifest')) ?? '（沒印）'));
  }

  /*
   * ── manifest 裡指路的那三樣 ──────────────────────
   *
   * 上面比的是文字（站名、描述、顏色）。第 3 輪（第四十五圈）逐條驗待辦時
   * 補的是**指路**的：`icons[].src`、`start_url`、`lang`。
   * 指到不存在的東西不會有人說話 —— 這一支不掃圖片，`check:links` 也不掃
   * manifest，而後果要到「安裝成 App」那一刻才看得到。
   */
  {
    /** @param {string} name @param {Record<string, unknown>} mf @param {Record<string, string>} [extraDist] */
    const withManifest = async (name, mf, extraDist = {}) => {
      const dir = await build(name, {
        ...base,
        dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'), ...extraDist },
        extra: { 'src/config/site.ts': siteTs, 'public/site.webmanifest': JSON.stringify(mf) },
      });
      const out = await check(dir, [`--src=${join(dir, 'src')}`, `--astro=${join(dir, 'astro.config.mjs')}`]);
      await rm(dir, { recursive: true, force: true });
      return out;
    };
    const good = {
      name: '狐說八道',
      short_name: '狐說八道',
      description: '朗誦經典詩詞曲，用今天的話說出其中的意思。',
      theme_color: '#faf6ee',
      background_color: '#faf6ee',
    };

    const badIcon = await withManifest('manifest-icon', { ...good, icons: [{ src: '/nope.png' }] });
    const okIcon = /icons 裡的 \/nope\.png 指到的東西不對/.test(badIcon);
    if (!okIcon) failed++;
    console.log(`  ${okIcon ? '✓' : 'X'} 圖示指到不存在的檔案時點名`);
    if (!okIcon) console.log('        ' + (badIcon.split('\n').find((l) => l.includes('nope')) ?? '（沒印）'));

    const badStart = await withManifest('manifest-start', { ...good, start_url: '/nowhere' });
    const okStart = /start_url \/nowhere 指到的東西不對/.test(badStart);
    if (!okStart) failed++;
    console.log(`  ${okStart ? '✓' : 'X'} start_url 指到不存在的頁時點名`);
    if (!okStart) console.log('        ' + (badStart.split('\n').find((l) => l.includes('start_url')) ?? '（沒印）'));

    /* 反向：指到真的存在的東西時不能亂報 */
    const okAll = await withManifest(
      'manifest-pointers-ok',
      { ...good, icons: [{ src: '/there.png' }], start_url: '/', scope: '/' },
      { 'index.html': page('首頁'), 'there.png': 'x' },
    );
    const okQuiet = !/指到的東西不對/.test(okAll);
    if (!okQuiet) failed++;
    console.log(`  ${okQuiet ? '✓' : 'X'} 都指得到的時候不亂報（反向案例）`);
    if (!okQuiet) console.log('        ' + (okAll.split('\n').find((l) => l.includes('指到')) ?? ''));
  }

  const broken = await run1('manifest-broken', { 'public/site.webmanifest': '{ 這不是 JSON' });
  const okBroken = /site.webmanifest 沒有比對：public\/site\.webmanifest 不是合法的 JSON/.test(broken);
  if (!okBroken) failed++;
  console.log(`  ${okBroken ? '\u2713' : 'X'} 壞掉的 manifest 說「沒有比對」，不是安靜過去`);
  if (!okBroken) console.log('        ' + (broken.split('\n').find((l) => l.includes('manifest')) ?? '（沒印）'));
}

console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
/*
 * ── 沒有人用的具名匯出 ──────────────────────
 *
 * 第 3 輪（第三十九圈）：那一圈在逐條驗待辦，而「`PAGE_SIZE` 沒有呼叫者」
 * **驗出來是錯的** —— 它被 `paginate()` 當預設參數用，8 個頁面天天在走。
 *
 * 那條待辦當初怎麼寫錯的，我在驗它的時候當場重演了一次：
 * 第一版探針只看「別的檔案有沒有提到」，於是把 `PAGE_SIZE` 也報成沒人用。
 * 少看了**同一個檔案裡的使用**與 **`src/` 以外的消費者**。
 *
 * 所以這三格釘的是那個判準本身。
 */
{
  console.log('\n' + '─'.repeat(64));
  const run3 = async (/** @type {Record<string, string>} */ extra) => {
    const dir = await build('exports', {
      content: { 'poems/wu-yi-xiang.md': poem() },
      dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
      extra,
    });
    /*
     * `--scripts=` 指到 fixture 自己的（空的）目錄。
     *
     * 不指的話語料會包含**這個測試檔**，而 fixture 裡寫的 `NOBODY`
     * 在這裡也出現一次 —— 於是它看起來「別的檔案有提到」，永遠不會被點名。
     * 第一版就是這樣綠的。
     */
    return check(dir, [`--src=${join(dir, 'src')}`, `--scripts=${join(dir, 'noscripts')}`]);
  };

  const unusedOut = await run3({ 'src/lib/x.ts': 'export const NOBODY = 1;\n' });
  const okUnused = /個沒有人用/.test(unusedOut) && /NOBODY/.test(unusedOut);
  if (!okUnused) failed++;
  console.log(`  ${okUnused ? '✓' : 'X'} 真的沒人用的匯出會被點名`);
  if (!okUnused) console.log('        ' + unusedOut.split('\n').filter((l) => /具名匯出|NOBODY/.test(l)).join(' ｜ '));

  /* 同一個檔案裡用到就不算沒人用 —— 預設參數就是這樣（PAGE_SIZE 那一條就是這樣被誤判的） */
  const selfOut = await run3({
    'src/lib/y.ts': 'export const SIZE = 30;\nexport function go(n = SIZE) {\n  return n;\n}\n',
  });
  /* 比對的是**列出來的那幾行**（`· 路徑　名字`），不是整段文字 —— 說明裡也會提到名字 */
  const okSelf = !/·\s+\S+\s+SIZE\b/.test(selfOut);
  if (!okSelf) failed++;
  console.log(`  ${okSelf ? '✓' : 'X'} 同一個檔案裡當預設參數用，不算沒人用`);
  if (!okSelf) console.log('        ' + selfOut.split('\n').filter((l) => /具名匯出|SIZE/.test(l)).join(' ｜ '));

  /* Astro 依約定去讀的名字不算 */
  const convOut = await run3({ 'src/lib/z.ts': 'export const collections = {};\n' });
  /* 同理：那一段的說明裡就寫著「目前只有 `collections`」，用整段比會被它滿足 */
  const okConv = !/·\s+\S+\s+collections\b/.test(convOut);
  if (!okConv) failed++;
  console.log(`  ${okConv ? '✓' : 'X'} Astro 依約定去讀的 collections 不算沒人用`);
  if (!okConv) console.log('        ' + convOut.split('\n').filter((l) => /具名匯出|collections/.test(l)).join(' ｜ '));
}

process.exit(failed > 0 ? 1 : 0);

/**
 * @param {string} name
 * `extra` 是照原樣寫的相對路徑（不塞進 src/content 或 dist）——
 * 第 3 輪（第三十一圈）加的，理由見 CASES 那份型別上面的說明。
 *
 * @param {{ content: Record<string, string>, dist: Record<string, string>, extra?: Record<string, string>, guide?: string, noIndex?: boolean }} files
 */
async function build(name, files) {
  const dir = join(tmp, name);

  /*
   * ── 假的 dist 預設要有搜尋索引 ────────────────────
   *
   * 第 3 輪（第二十一圈）加了 `search-index-missing` 之後，這裡的每一個
   * 迷你 fixture 都會踩到它 —— 它們是「只放會踩到那一條的東西」的假站，
   * 本來就沒有索引。17 格一起紅。
   *
   * 與其在 17 個案例上各寫一次 `also`，不如讓**基底是一個完整的站**：
   * 沒有明寫 `search-index.json` 的話，就照內容自動補一份對得上的。
   * 要測那一條的案例自己寫（空的、或漏一篇），寫了就以它為準。
   */
  if (!files.dist['search-index.json'] && !(/** @type {any} */ (files).noIndex)) {
    const items = Object.entries(files.content)
      .filter(([, body]) => !/^draft:\s*true\s*$/m.test(body))
      .map(([path, body]) => {
        const [collection, name2] = path.split('/');
        const prefix = { posts: 'writing', poems: 'poems', notes: 'notes' }[collection];
        if (!prefix) return null;
        /* 語言前綴要跟 pagePath() 一致，不然 en 的內容會被當成漏了 */
        const lang = /^lang:\s*(\S+)/m.exec(body)?.[1] ?? 'zh-TW';
        const localePrefix = lang === 'zh-TW' ? '' : `/${lang.split('-')[0]}`;
        return { t: 'x', u: `${localePrefix}/${prefix}/${name2.replace(/\.mdx?$/, '').toLowerCase()}` };
      })
      .filter(Boolean);
    files = { ...files, dist: { ...files.dist, 'search-index.json': JSON.stringify({ n: items.length, items }) } };
  }
  if (/** @type {any} */ (files).guide !== undefined) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'guide.md'), /** @type {any} */ (files).guide);
  }
    for (const [kind, set] of /** @type {const} */ ([['content', files.content], ['dist', files.dist]])) {
    for (const [path, body] of Object.entries(set)) {
      const full = join(dir, kind, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, body);
    }
  }
  /*
   * `files.extra` 是**照原樣寫的相對路徑**（不塞進 src/content 或 dist）。
   * 第 3 輪（第三十一圈）加的：`locale-list-drift` 要比對的是
   * `src/config/site.ts`、`src/content.config.ts`、`astro.config.mjs` ——
   * 三個都不在 content／dist 底下，沒有這個就沒辦法寫成一格 CASE。
   */
  for (const [path, body] of Object.entries(/** @type {any} */ (files).extra ?? {})) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  return dir;
}

/** 跟 check() 一樣，但把離開碼也帶回來 —— 「印了但不擋」跟「擋了」是兩件事 */
/** @param {string} dir */
/** @param {string} dir @param {string[]} [extra] */
async function checkWithCode(dir, extra = []) {
  const args = [
    resolve(ROOT, 'scripts/check-content.mjs'),
    `--dir=${join(dir, 'dist')}`,
    `--content=${join(dir, 'content')}`,
    ...extra,
  ];
  try {
    const { stdout } = await run('node', args);
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1 };
  }
}

/** @param {string} dir */
async function check(dir, /** @type {string[]} */ extra = []) {
  const args = [
    resolve(ROOT, 'scripts/check-content.mjs'),
    `--dir=${join(dir, 'dist')}`,
    `--content=${join(dir, 'content')}`,
  ];
  /*
   * `field-undocumented` 比對的是**真的** src/content.config.ts 與寫作指南，
   * 不是 fixture 裡的東西 —— 所以只有那一格會放一份假指南進來。
   * 其餘每一格都跑真的那份，也就順便當了那條規則的反面案例。
   */
  const guide = join(dir, 'guide.md');
  if (await readFile(guide, 'utf8').then(() => true, () => false)) args.push(`--guide=${guide}`);
  args.push(...extra);
  try {
    const { stdout } = await run('node', args);
    return stdout;
  } catch (err) {
    return String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  }
}
