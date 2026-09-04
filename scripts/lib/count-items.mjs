// @ts-check
/**
 * 一份 feed 實際讀得出幾筆 —— **只給診斷用**。
 *
 * ## 為什麼要有這一支，而不是直接呼叫 parseFeed
 *
 * `parseFeed` 對 YouTube 的 feed **會刻意拋錯**（第 4 輪〔第十四圈〕加的護欄：
 * 通用剖析器讀得動它，但摘要、縮圖、externalId 全是空的，而且 id 算法不同）。
 * 所以「隨手剖析一份不知道哪來的 feed」這件事，需要先分流。
 *
 * 第 4 輪（第二十一圈）寫 `verify --patterns` 的剖析檢查時，
 * 第一版就是直接呼叫 `parseFeed` —— 於是一份**完全正常**的 YouTube feed
 * 被報成「剖析失敗」。那正是這個 repo 一再犯的那一種錯：
 * **探針錯了，看起來跟工具錯了一模一樣。**
 *
 * ## 為什麼 sync 不該用這一支
 *
 * `sync-feeds.mjs` 是**照來源的平臺**選剖析器的，那是對的：
 * 它知道自己在抓誰家的東西。這一支是靠內容猜的，因為診斷工具
 * 拿到的是一個網址，不是一個已知的來源。猜錯的代價在這裡只是
 * 一行數字不準，在 sync 那裡是整份快取被寫壞。
 */
import { parseFeed } from './parse-feed.mjs';
import { parseYouTubeFeed } from './parse-youtube-feed.mjs';

/**
 * @param {string} xml
 * @returns {{ n: number, err?: string }} `n` 是筆數；`-1` 代表剖析拋錯，錯誤訊息在 `err`
 */
export function countItems(xml) {
  /*
   * 用命名空間認 YouTube，跟 parse-feed.mjs 的護欄同一條判準。
   * 不用網址認：`verify` 拿到的網址是樣板填出來的，而護欄看的是內容 ——
   * 兩邊用不同的判準，遲早會出現「一邊說是、一邊說不是」的縫。
   */
  const isYouTube = /xmlns:yt=/.test(xml);
  try {
    const items = isYouTube ? parseYouTubeFeed(xml, { id: 'probe' }) : parseFeed(xml, { id: 'probe' });
    return { n: items.length };
  } catch (err) {
    return { n: -1, err: String(/** @type {{ message?: string }} */ (err)?.message ?? err).slice(0, 80) };
  }
}
