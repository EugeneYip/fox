// @ts-check
/**
 * YouTube 官方 Atom feed 的剖析 —— 抽出來是為了能測。
 *
 * ## 為什麼抽
 *
 * 第 4 輪（第十三圈）盤點這一圈的問題（「案例是不是都長得太像了」）時
 * 量到一件更基本的事：
 *
 * > `parseFeed`（RSS 2.0／Atom／RDF）有三份樣本、逐欄位比對；
 * > 而**每天真正在跑的是這一段** —— 它一個案例都沒有。
 * > 全部 test-*.mjs 裡沒有任何一個檔案提到 `yt:videoId`、`media:group`
 * > 或 `media:description`。
 *
 * 原因不難理解：`parseFeed` 走的是**還沒有帳號的那些平臺**，
 * 是「以後會用到」的路；YouTube 這條是「現在唯一在用」的路。
 * 測試蓋住的是前者。
 *
 * 抽出來之後就跟 `youtube-source.mjs`（降級層）一樣可以零網路測試。
 *
 * ## 樣本從哪裡來
 *
 * `test-parse-youtube-feed.mjs` 的樣本是 2026-09-03 真的去打
 * `youtube.com/feeds/videos.xml?channel_id=…` 拿回來的那一份改的，
 * 不是照著文件想像出來的。真實的形狀裡有幾件事是想像不到的：
 *
 * - 標題有 emoji 與 hashtag（`🏹 …〈出塞〉… #唐詩`）
 * - `<link rel="alternate">` 指向 **`/shorts/`** 而不是 `/watch?v=`
 * - `<media:description>` 是**多行**的
 * - feed 層的 `<yt:channelId>` 少了 `UC` 前綴，entry 層的有
 * - `<updated>` 可以比 `<published>` 晚兩年（影片被改過）
 */
import { parser, asArray, textOf, stableId, tidyTitle, toPlainText, toIso, cleanUrl } from './parse-feed.mjs';

/**
 * @param {string} xml  feed 的原始內容
 * @param {{ id: string }} source
 * @returns {any[]}
 */
export function parseYouTubeFeed(xml, source) {
  const doc = parser.parse(xml);
  const entries = asArray(doc.feed?.entry);

  /*
   * 空的不是「這個頻道沒有影片」，是「拿到的東西不對」——
   * 安靜地回一個空陣列會讓 mergeItems 什麼都不做，看起來像同步成功。
   */
  if (entries.length === 0) throw new Error('feed 解析後沒有任何影片');

  return entries.map((entry) => {
    const videoId = textOf(entry['yt:videoId']);
    const group = entry['media:group'] ?? {};
    // 縮圖只存網址；前端用「按了才載入」的預覽卡，不會一進站就打 Google
    const thumb = group['media:thumbnail']?.['@_url'];
    return {
      id: stableId(source.id, videoId || textOf(entry.id)),
      title: tidyTitle(toPlainText(textOf(entry.title), 200)) || '(無標題)',
      /*
       * 有 videoId 就自己組網址。
       * 不用 `<link rel="alternate">` 的原因是實測看到的：短影音那一則指向
       * `/shorts/…`，而站上的預覽卡是照 `watch?v=` 這個形狀處理的。
       */
      url: videoId
        ? `https://www.youtube.com/watch?v=${videoId}`
        : cleanUrl(asArray(entry.link)[0]?.['@_href'] ?? ''),
      publishedAt: toIso(textOf(entry.published) || textOf(entry.updated)),
      summary: toPlainText(textOf(group['media:description'])),
      tags: [],
      thumbnail: thumb ?? undefined,
      externalId: videoId || undefined,
    };
  });
}


/**
 * Data API v3 的一筆 `playlistItems` → 跟 RSS 那條路**同一個形狀**的項目。
 *
 * ## 為什麼要跟 RSS 對齊到欄位級
 *
 * 這兩條路是同一件事的兩份實作（RSS 免金鑰、天天在跑；API 需要金鑰、
 * 只有 RSS 掛掉時才走）。它們產生的項目會進同一個 `mergeItems`，
 * 而那個函式是拿 **整個項目 JSON 比對**來判斷「有沒有更新」的。
 *
 * 也就是說：**只要有一個欄位對不齊，切換來源的那一天九支影片會全部被
 * 報成「更新」**，而下一次 RSS 成功時又會全部翻回來 —— 一個在兩個來源
 * 之間永遠來回的假更新。
 *
 * 第 4 輪（第十四圈）逐欄位比對，找到一個對不齊的：**縮圖**。
 *
 *   RSS 的 `media:thumbnail`　實測是 `hqdefault.jpg`（480×360）
 *   原本的 API 對應　　　　　`maxres ?? high ?? medium ?? default`
 *
 * 而 `maxresdefault.jpg` 是真的存在的（實測 HEAD 200、68,558 bytes，
 * 對照 `hqdefault` 的 9,480）—— 所以那不是理論上的差異。
 * 現在改成 `high` 優先，因為 API 的 `high` 就是 `hqdefault`，
 * 跟 RSS 給的同一張。
 *
 * 順帶記一件事：**站上目前沒有任何地方畫這個縮圖**（元件與頁面裡一次都
 * 沒有用到，產出裡 `ytimg.com` 出現 0 次）。存著是為了以後想顯示時
 * 不用再打一次 YouTube。跟 `firstSeenAt` 一樣是「有值、沒有消費者」，
 * 處理方式也一樣：不刪，但寫下來。
 *
 * @param {{ id: string }} source
 * @param {any} apiItem  data.items 裡的一筆
 * @returns {any | null} 沒有 videoId 就回 null（呼叫端跳過）
 */
export function mapYouTubeApiItem(source, apiItem) {
  const videoId = apiItem?.contentDetails?.videoId ?? apiItem?.snippet?.resourceId?.videoId;
  if (!videoId) return null;
  const thumbs = apiItem?.snippet?.thumbnails ?? {};
  return {
    id: stableId(source.id, videoId),
    title: tidyTitle(toPlainText(apiItem?.snippet?.title, 200)) || '(無標題)',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    publishedAt: toIso(apiItem?.contentDetails?.videoPublishedAt ?? apiItem?.snippet?.publishedAt),
    summary: toPlainText(apiItem?.snippet?.description),
    tags: [],
    thumbnail: (thumbs.high ?? thumbs.maxres ?? thumbs.medium ?? thumbs.default)?.url,
    externalId: videoId,
  };
}
