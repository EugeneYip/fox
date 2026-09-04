// @ts-check
/**
 * Feed 的剖析 —— RSS 2.0 / Atom / RSS 1.0(RDF) 三種進來，統一結構出去。
 *
 * ## 為什麼獨立成一個檔案
 *
 * 這段程式碼從來沒有被測過（第 4 輪，第四圈才發現）。而它壞掉的方式很難察覺：
 * **格式認不出來會拋錯**（那還好，同步會紅燈），
 * 但**欄位對應壞掉不會拋錯** —— 日期全變 null、摘要全變空字串，
 * 同步照樣回報「抓到 N 筆」，只是抓回來的是空殼。
 *
 * 拆出來之後 scripts/test-parse-feed.mjs 測的是**真正在跑的那份**，
 * 而不是一份長得很像的複製品。
 *
 * 三種格式在中文圈都還很常見（痞客邦是 RSS 2.0、Blogger 是 Atom）。
 */
import { XMLParser } from 'fast-xml-parser';

const MAX_SUMMARY = 400;

/** 去掉 HTML 標籤與多餘空白，做成純文字摘要 */
/** @param {string} html @param {number} [max] */
export function toPlainText(html, max = MAX_SUMMARY) {
  if (!html) return '';
  const text = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

/**
 * 洗掉網址上的追蹤參數。
 * 這既是禮貌，也是隱私：不要把 Medium 的 utm 標記原封不動貼在自己站上。
 */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_[ce]id|igshid|ref_src|ref_url|source$|_branch)/i;
/** @param {unknown} raw */
export function cleanUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(String(raw).trim());
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    /*
     * ── 錨點要留著 ──────────────────────────────────
     *
     * 這裡本來一律 `u.hash = ''`。第 4 輪（第十六圈）的誤報探針量到：
     * `https://example.com/a#chapter-2` 會被洗成 `https://example.com/a` ——
     * 一個**指向文章某一節**的連結被默默改成指向整篇。
     *
     * 而拿掉錨點在隱私上一點好處都沒有：**片段識別碼根本不會送到伺服器**，
     * 它只存在於瀏覽器裡。上面那段註解講的「禮貌與隱私」說的是查詢參數，
     * 不是錨點 —— 兩件事被寫成了一行。
     *
     * 站主連到自己在別處的文章時，錨點就是她指的地方。
     */
    return u.toString();
  } catch {
    return String(raw).trim();
  }
}

/**
 * 把平臺塞在標題裡的雜訊清掉。
 *
 * 短影音平臺的「標題」其實常常是整段貼文文案：開頭一個表情符號、
 * 中間是完整的一句話、結尾掛一串 hashtag。原封不動放進列表會變成一牆文字。
 * 實際抓到的例子：
 *
 *   🏹 王昌齡〈出塞〉「秦時明月漢時關…」邊塞征戰… 🦊 #王昌齡 #出塞 #唐詩 #戰爭
 *
 * 這裡只做兩件明確安全的事：拿掉結尾那一串 hashtag、拿掉開頭與結尾的表情符號。
 * **不裁切句子** —— 那要靠猜，猜錯會把意思砍掉。完整文字本來就還在 summary 裡，
 * 顯示長度由前端用 CSS 控制。
 */
/** @param {unknown} raw */
export function tidyTitle(raw) {
  let t = String(raw ?? '').trim();
  // 結尾連續的 hashtag（中英文都算），至少兩個才動手 —— 一個 hashtag 可能是正文的一部分
  t = t.replace(/(?:\s*#[^\s#]+){2,}\s*$/u, '');
  // 開頭與結尾的表情符號／裝飾符號
  const deco = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu;
  t = t.replace(new RegExp(`^(?:${deco.source}|\\s)+`, 'u'), '');
  t = t.replace(new RegExp(`(?:${deco.source}|\\s)+$`, 'u'), '');
  return t.trim();
}

/** 穩定的項目 id：同一篇文章不管抓幾次都得到同一個 id */
/** @param {string} sourceId @param {string} key */
export function stableId(sourceId, key) {
  const slug = String(key)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9一-鿿]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${sourceId}--${slug}`;
}

/**
 * 沒有帶時區的日期字串，一律當成 UTC。
 *
 * ── 為什麼 ──────────────────────────────────────────
 *
 * `new Date('2026-01-01 00:00:00')` 會用**跑這段程式的機器**的時區。
 * 第 4 輪（第二十二圈）實測同一個字串在三台機器上的結果：
 *
 *   TZ=UTC　　　　　　　→  2026-01-01
 *   TZ=Asia/Taipei　　　→  **2025-12-31**
 *   TZ=America/New_York →  2026-01-01
 *
 * 也就是說同一份 feed，同步跑在哪裡會決定存進 `syndication.json` 的
 * 是哪一天 —— CI 在 UTC、站主的機器在美東、她的機器在臺北。
 *
 * RSS 的 RFC-822 與 Atom 的 RFC-3339 **都要求帶時區**，所以沒帶的本來就是
 * 不合規格的 feed；把它讀成 UTC 是最接近規格的解釋，而且**不管在哪台機器上
 * 都給同一個答案**。那比「猜對」重要。
 *
 * 只補「日期＋時間但沒有時區」那一種。只有日期的 `2026-01-01` 不動 ——
 * 那個規格上本來就是 UTC。
 *
 * @param {string} raw
 */
function assumeUtc(raw) {
  const s = raw.trim();
  /*
   * 已經有時區了：Z、±HH:MM、或 GMT／UTC／具名時區。
   *
   * **這一行目前不改變任何結果** —— 突變掃描證實了（把它拿掉，五格全綠）。
   * 因為下面兩條樣式都用 `$` 錨在字串結尾，帶了時區就配不到。
   * 留著是為了下面那兩條**哪天被放寬**（例如為了容忍結尾空白而拿掉錨點）
   * 的時候，帶時區的日期不會被硬補上第二個時區。
   * 寫出來是因為「看起來在守什麼、其實沒有」正是這個 repo 一再踩的坑。
   */
  if (/(Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|[A-Z]{2,4}T)\b)\s*$/.test(s)) return s;
  /* ISO 的日期＋時間（2026-01-01T00:00:00 或中間用空格） */
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) return s + 'Z';
  /* RFC-822 那一種（Mon, 01 Jan 2026 00:00:00） */
  if (/\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}(:\d{2})?$/.test(s)) return s + ' GMT';
  return s;
}

/** @param {unknown} value */
export function toIso(value) {
  if (!value) return undefined;
  const input = typeof value === 'string' ? assumeUtc(value) : value;
  const d = new Date(/** @type {string | number | Date} */ (input));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** XML 節點可能是單一物件也可能是陣列，統一成陣列 */
/** @param {unknown} v @returns {any[]} */
export const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
/** 節點可能是字串，也可能是 { '#text': '...' } */
/** @param {any} v */
export const textOf = (v) => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return String(v['#text'] ?? v['@_href'] ?? '');
  return '';
};

// ── Feed 解析 ────────────────────────────────────────────

export const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
});

/**
 * 吃 RSS 2.0 / Atom / RSS 1.0(RDF) 三種格式，吐統一結構。
 * 這三種在中文圈都還很常見（痞客邦是 RSS 2.0、Blogger 是 Atom）。
 */
/**
 * @param {string} xml
 * @param {{ id: string }} source
 * @param {{ log?: { warn: (...args: any[]) => void } }} [deps]
 */
export function parseFeed(xml, source, deps = {}) {
  const doc = parser.parse(xml);

  /*
   * ── YouTube 的 feed 要走專用的那一支 ──────────────
   *
   * YouTube 的官方 feed 是合法的 Atom，所以下面的 `parseAtom` 會**成功** ——
   * 只是答得幾乎全錯。第 4 輪（第十四圈）拿真實的 feed 讓兩支各跑一次，
   * 七個欄位裡只有一個一樣：
   *
   *   id          `…--yt-video-uyor3…`（用 <id> 全文）　vs　`…--uyor3t6hnzu`（用 videoId）
   *   url         `/shorts/…`（抄 <link>）　　　　　　　vs　`watch?v=…`
   *   summary     **空字串**（看不懂 media:group）　　　vs　影片說明
   *   thumbnail   **null**　　　　　　　　　　　　　　 vs　media:thumbnail
   *   externalId  **null**　　　　　　　　　　　　　　 vs　videoId
   *   title       保留 emoji 與 hashtag　　　　　　　　vs　tidyTitle 修過
   *   publishedAt 一樣
   *
   * 而 id 不同代表 `mergeItems` 會把每一支都當成新的。
   * 第 4 輪（第十一圈）真的踩過這個：拿通用剖析器去算，得到
   * 「9 筆全新、9 筆消失」，而那跟 `sync:dry` 的輸出互相矛盾才被抓到。
   *
   * 兩支的簽名一模一樣（`(xml, source)`），叫錯了不會有任何徵兆 ——
   * 所以這裡當場擋下來。
   */
  if (doc.feed?.['yt:channelId'] !== undefined || /xmlns:yt=/.test(xml)) {
    throw new Error(
      '這是 YouTube 的 feed —— 要用 lib/parse-youtube-feed.mjs 的 parseYouTubeFeed()。' +
        '通用剖析器讀得動它，但摘要、縮圖、externalId 會是空的，而且 id 算法不同，' +
        '會讓每一支影片都變成「新的」。',
    );
  }

  /** @type {any[]} */
  let items;
  if (doc.rss?.channel) items = parseRss2(doc.rss.channel, source);
  else if (doc.feed) items = parseAtom(doc.feed, source);
  else if (doc['rdf:RDF']) items = parseRdf(doc['rdf:RDF'], source);
  else throw new Error('認不出來的 feed 格式（不是 RSS 2.0 / Atom / RDF）');

  /*
   * 沒有連結的一筆不要放行。
   *
   * 標題早就有 `|| '(無標題)'` 這道保險，網址沒有 —— 第 4 輪（第十圈）實測
   * 才發現這個不對稱。放行的後果有兩個，兩個都不會拋錯：
   *
   *   1. `id` 是 `stableId(source.id, guid || link)`，兩者都空的話**每一筆
   *      算出來的 id 都一樣**（實測：兩筆不同的項目 → 1 個 id），
   *      而 mergeItems 是用 id 當 key 的 → 後面那筆直接消失
   *   2. 站上畫出來是 `<a href target="_blank">` —— HTML 裡沒有值的屬性
   *      等於空字串，而空的 href 指向**當前頁**。點下去是「在新分頁重新開啟
   *      這一頁」。實測：建置過、check:content／a11y／copy 三道都 0 發現
   *
   * 這一頁的功能就是「在別處讀得到」，沒有網址的一筆沒有東西可以給。
   */
  const usable = items.filter((it) => it.url);
  const dropped = items.length - usable.length;
  if (dropped > 0) {
    deps.log?.warn(
      `${source.id}：${dropped} 筆沒有連結，略過（沒有網址就沒有 id 也沒有去處）。` +
        `標題：${items.filter((it) => !it.url).map((it) => it.title).slice(0, 3).join('、')}`,
    );
  }
  return usable;
}

/** @param {any} channel @param {{ id: string }} source */
function parseRss2(channel, source) {
  return asArray(channel.item).map((item) => {
    const link = cleanUrl(textOf(item.link));
    const guid = textOf(item.guid) || link;
    return {
      id: stableId(source.id, guid),
      title: toPlainText(textOf(item.title), 200) || '(無標題)',
      url: link,
      publishedAt: toIso(textOf(item.pubDate) || textOf(item['dc:date'])),
      summary: toPlainText(textOf(item.description) || textOf(item['content:encoded'])),
      tags: asArray(item.category).map((c) => toPlainText(textOf(c), 40)).filter(Boolean),
    };
  });
}

/** @param {any} feed @param {{ id: string }} source */
function parseAtom(feed, source) {
  return asArray(feed.entry).map((entry) => {
    const links = asArray(entry.link);
    const alt =
      links.find((l) => l['@_rel'] === 'alternate' || l['@_rel'] == null) ?? links[0];
    const link = cleanUrl(alt?.['@_href'] ?? textOf(entry.link));
    const id = textOf(entry.id) || link;
    return {
      id: stableId(source.id, id),
      title: toPlainText(textOf(entry.title), 200) || '(無標題)',
      url: link,
      publishedAt: toIso(textOf(entry.published) || textOf(entry.updated)),
      summary: toPlainText(textOf(entry.summary) || textOf(entry.content)),
      tags: asArray(entry.category).map((c) => toPlainText(c['@_term'] ?? textOf(c), 40)).filter(Boolean),
    };
  });
}

/** @param {any} rdf @param {{ id: string }} source */
function parseRdf(rdf, source) {
  return asArray(rdf.item).map((item) => {
    const link = cleanUrl(textOf(item.link));
    return {
      id: stableId(source.id, textOf(item['@_rdf:about']) || link),
      title: toPlainText(textOf(item.title), 200) || '(無標題)',
      url: link,
      publishedAt: toIso(textOf(item['dc:date'])),
      summary: toPlainText(textOf(item.description)),
      tags: asArray(item['dc:subject']).map((c) => toPlainText(textOf(c), 40)).filter(Boolean),
    };
  });
}
