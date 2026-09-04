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

/* 真的那份寫作指南 —— field-undocumented 的案例拿它改一個字當 fixture */
const REAL_GUIDE = await readFile(resolve(ROOT, 'docs/CONTENT.md'), 'utf8');

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
 * @type {Record<string, { content: Record<string, string>, dist: Record<string, string>, also?: string[], mustMention?: string[], expect?: string, noIndex?: boolean, guide?: string }>}
 */
const CASES = {
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
  'field-undocumented': {
    guide: REAL_GUIDE.replaceAll('videoUrl', 'videoLink'),
    content: { 'poems/wu-yi-xiang.md': poem() },
    dist: { 'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花') },
    mustMention: ['videoUrl'],
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
    'poems/wu-yi-xiang.md': poem(),
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
  dist: {
    'poems/wu-yi-xiang/index.html': page('烏衣巷 — 朱雀橋邊野草花'),
    'poems/ti-chi-bi/index.html': page('題《赤壁圖》 — 折戟沉沙鐵未銷'),
    /* 索引裡有那兩篇 —— 少了它，把規則改成「一律報」也會全綠 */
    'search-index.json': JSON.stringify({
      n: 2,
      items: [
        { t: '烏衣巷', u: '/poems/wu-yi-xiang' },
        { t: '題《赤壁圖》', u: '/poems/ti-chi-bi' },
      ],
    }),
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
    const out = await check(dir);
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
    const out = await check(dir);
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
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);

/**
 * @param {string} name
 * @param {{ content: Record<string, string>, dist: Record<string, string> }} files
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
async function check(dir) {
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
  try {
    const { stdout } = await run('node', args);
    return stdout;
  } catch (err) {
    return String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  }
}
