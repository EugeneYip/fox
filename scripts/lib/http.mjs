// @ts-check
/**
 * 對外請求時的自我介紹 —— 三支腳本共用一個地方。
 *
 * ## 為什麼要集中
 *
 * 第 4 輪（第一圈）踩過一個很貴的坑：`sync-feeds.mjs` 的 User-Agent 裡有一個
 * 全形破折號（U+2014）。HTTP header 的值只能是 Latin-1，所以 `fetch` 在
 * **送出之前**就拋 `Cannot convert argument to a ByteString` ——
 * 而那個錯誤看起來像網路問題。
 *
 * 結果是：**整條同步管線從第一天起就沒有成功送出過任何一個請求**，
 * 而且被另一個「缺 API 金鑰」的錯誤蓋住，一直沒被發現。
 *
 * 值放在這裡，加上 scripts/test-http-headers.mjs 用**真的 `new Headers()`**
 * 驗證（不是用正則掃原始碼 —— 那種掃描本身就不可靠，第 4 輪〔第三圈〕
 * 寫這段時我的正則就漏抓了兩個多行宣告）。
 */

/** 同步：老實說明自己是誰、多久來一次 */
export const UA_SYNC =
  'bellafoxy.com feed sync (+https://bellafoxy.com/colophon); polite, runs twice a day';

/** 檢查來源是否還通：一次性的檢查，同樣老實說明 */
export const UA_VERIFY = 'bellafoxy.com source check (+https://bellafoxy.com/colophon)';

/*
 * 查帳號存不存在時假裝成瀏覽器。
 *
 * 這一支不是抓資料，是「這個名字在這個平臺上有沒有東西」的一次性查詢，
 * 而好幾個平臺對非瀏覽器的 UA 直接回登入頁或 403 —— 那會讓結果全部變成
 * 「查不準」，等於這支腳本沒有用。
 */
export const UA_BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export const ALL_USER_AGENTS = { UA_SYNC, UA_VERIFY, UA_BROWSER };
