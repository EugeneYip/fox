// @ts-check
/**
 * 「今天是哪一天」—— 照這個專案釘住的時區算。
 *
 * ## 為什麼不是 `toISOString().slice(0, 10)`
 *
 * 那個是 **UTC**。而這個專案把時區釘成 `Asia/Taipei`（`src/lib/dates.ts` 兩處，
 * `test:portability` 有兩格在守），因為站上的日期是給臺灣的讀者看的。
 *
 * 兩者在**臺北的 00:00–08:00** 之間不一樣 —— UTC 還停在前一天。
 *
 * 第 4 輪（第三十五圈）實測撞到：`verify-sources.mjs` 用 UTC 算
 * 「最舊的宣稱是幾天前」，而 `verifiedAt` 是照臺北日期寫的。
 * 當下 UTC 是 2026-09-05、臺北已經是 2026-09-06 ——
 * 報告說「0 天前」，照專案自己的時區是 **1 天前**。
 *
 * 差一天不會讓任何東西壞掉，但那是一個**新鮮度**的訊號：
 * 它存在的理由就是「這個宣稱多舊了」，而它系統性地少算最多一天。
 *
 * `lib/sync-core.mjs` 早就用對了（它比對兩次同步是不是同一天）。
 * 抽成一支是為了只有一個地方寫這件事 —— 第三十四圈整整八輪都在講這個。
 *
 * @param {Date} [at] 要換算的時刻，預設現在
 * @returns {string} `YYYY-MM-DD`
 */
export function projectDay(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
