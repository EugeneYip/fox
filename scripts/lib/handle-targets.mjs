// @ts-check
/**
 * `npm run handle <帳號名>` 要去問哪些平臺 —— 只有這裡知道。
 *
 * ## 為什麼抽出來
 *
 * 第 4 輪（第二十四圈）實測：`npm run handle FoxPoetry` 掃了 18 個平臺，
 * **YouTube 不在裡面** —— 也就是說，唯一已知她真的有帳號的那一個，
 * 這支工具從來沒有問過。
 *
 * 排除的規則本來寫成「`handleShape` 是 domain／instance-user／channel-id
 * 就跳過」，理由是「套樣板沒有意義」。前兩種是對的：它們的 `homeTemplate`
 * 就是 `https://{handle}`，handle **本身就是主機名**，填一個裸名字進去
 * 組出 `https://FoxPoetry` 這種東西。
 *
 * 但 `channel-id` 不是那樣。YouTube 的兩個樣板要的是**不同的東西**：
 *
 *     homeTemplate  https://www.youtube.com/@{handle}          ← 顯示用的帳號名
 *     feedTemplate  …/feeds/videos.xml?channel_id={handle}     ← UC 開頭的頻道 ID
 *
 * `handleShape` 描述的是**後者**。拿它去決定前者要不要查，
 * 是「一個欄位被當成兩個問題的答案」。
 *
 * 實測（2026-09-04）：
 *
 *     https://www.youtube.com/@FoxPoetry      → 200「狐說八道 - YouTube」
 *     https://www.youtube.com/@（亂打的名字）   → 404
 *
 * 個人頁這條路不但通，而且分得出在與不在。
 *
 * ## 那 feed 那一側呢
 *
 * 一樣不能用顯示用的帳號名去填 —— 填了會組出 `?channel_id=FoxPoetry`
 * 然後回 404，被讀成「沒有這個帳號」。那正是第 4 輪（第二圈）那個 bug。
 * 所以 feed 那一側改用 `sourceFeedUrl()`（它讀 `handleShape`，
 * channel-id 而手上只有帳號名時回空字串），組不出來就不打，直接看個人頁。
 */

/** handle 本身就是主機名的形式 —— 填一個裸帳號名進去組不出網址 */
const HANDLE_IS_HOST = new Set(['domain', 'instance-user']);

/**
 * @template {{ homeTemplate?: string, handleShape?: string, region?: string }} P
 * @param {readonly P[]} platforms
 * @param {Set<string> | null} [regions] 只留這幾個地區；null 或省略代表全部
 * @returns {P[]}
 */
export function handleTargets(platforms, regions = null) {
  return platforms.filter(
    (p) =>
      Boolean(p.homeTemplate) &&
      !HANDLE_IS_HOST.has(p.handleShape ?? 'username') &&
      (!regions || regions.has(p.region ?? '')),
  );
}
