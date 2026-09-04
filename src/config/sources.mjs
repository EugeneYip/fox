// @ts-check
// 同 platforms.data.mjs：這是資料，重複鍵或打錯欄位名都不會有執行期錯誤，
// 只會安靜地少做一件事。用 ts-check 讓 JSDoc 的型別真的生效。
/**
 * 來源清單 —— 「狐狸在哪些平臺上發表東西」。
 *
 * ⚠️ 現況（2026-09-04 更新）：**網站上只有 YouTube 一個來源。**
 * 網站在零來源的情況下設計過，不會出現半殘的空卡片或錯誤訊息。
 *
 * 原本這裡寫「其他帳號都還不知道」。那句話從 2026-09-04 起不再成立：
 * 整理網域 DNS 的那天，在轉址設定裡看到了另一個平臺的帳號，
 * 而站主當場明確說**不可以放上網站**。
 *
 * 所以它不在這份清單裡，也**不寫在這個 repo 的任何地方** ——
 * repo 是公開的，把帳號名寫進註解就等於發佈它，那正好是不要的結果。
 * 這是刻意留的缺口。不要為了「補齊」而去把它挖出來填進來。
 *
 * 這裡是唯一要維護的名單。同步腳本 (scripts/sync-feeds.mjs) 和
 * 網站前端 (/elsewhere) 都讀這一份，不會有兩邊對不起來的問題。
 *
 * 刻意寫成 .mjs 而不是 .ts：這樣 `node scripts/sync-feeds.mjs` 可以
 * 直接 import，不需要編譯步驟。
 *
 * @typedef {object} Source
 * @property {string}  id          內部識別碼，必須唯一
 * @property {string}  platform    對應 src/config/platforms.data.mjs 的 id
 * @property {boolean} enabled     關掉就完全不處理（不抓、不顯示）
 * @property {string}  [handle]    帳號名。要填什麼形式見 docs/PLATFORMS.md 的 handleShape 欄
 * @property {string}  [feedUrl]   直接指定 feed 網址（優先於平臺樣板）
 * @property {string}  [homeUrl]   直接指定個人頁網址（優先於平臺樣板）
 * @property {string}  [channelId] YouTube 專用：UC 開頭的頻道 ID
 * @property {string}  [label]     顯示名稱，留空則用平臺名
 * @property {string}  [lang]      這個來源的主要語言（zh-TW / en）
 * @property {string[]} [tags]     自動附加到這個來源所有文章上的標籤
 * @property {number}  [limit]     每次同步最多取幾筆
 * @property {boolean} [featured]  是否在 /elsewhere 置頂
 * @property {string}  [note]      給人看的備註
 */

/** @type {Source[]} */
export const sources = [
  {
    id: 'youtube-foxpoetry',
    platform: 'youtube',
    enabled: true,
    handle: 'FoxPoetry',
    channelId: 'UCiCJBnqbS3ECSPEM7vSmrPw',
    label: '狐說八道',
    lang: 'zh-TW',
    tags: ['詩詞', '朗讀'],
    limit: 50,
    featured: true,
    note:
      '唯一已知的帳號，來源是 eugeneyip.com/fox 上列的 @FoxPoetry；' +
      '頻道名稱「狐說八道」與內容（每日詩詞短片）都對得上，但仍請本人確認一次。' +
      '同步走官方 Atom feed，不需要金鑰。YOUTUBE_API_KEY 只是備援（feed 端點會間歇性 404）' +
      '以及想往回抓 15 支以外的歷史時才需要。',
  },

  // ─────────────────────────────────────────────────────
  // 之後要加的時候，複製下面這塊，取消註解，把值換掉。
  //
  //   {
  //     id: 'medium-main',        // 自己取，不重複就好
  //     platform: 'medium',       // 見 docs/PLATFORMS.md 的 id 欄
  //     enabled: true,
  //     handle: '她的帳號名',       // 要填帳號名還是完整網域？見同一份文件
  //     lang: 'zh-TW',
  //     limit: 20,
  //   },
  //
  // 加完先跑 `npm run verify` 確認抓得到，再跑 `npm run sync` 實際抓一次。
  //
  // 有些平臺（方格子、Matters）的 feed 網址含內部 ID，推導不出來，
  // 要到她的個人頁點 RSS 圖示複製網址，填在 feedUrl。
  //
  // 完全沒有 feed 的平臺（Instagram、微信公眾號、Behance）不要加在這裡，
  // 改用手動登錄：在 src/content/external/ 開一個檔案，見 docs/CONTENT.md。
  //
  // Threads、X、小紅書那幾個是 bridge：有 RSSHub 路由，但沒設 RSSHUB_BASE
  // 就抓不到東西。沒有要架 RSSHub 的話，它們實際上也是手動登錄。
  // ─────────────────────────────────────────────────────
];

/** 只回傳有啟用的來源 */
export function enabledSources() {
  return sources.filter((s) => s.enabled);
}

export default sources;
