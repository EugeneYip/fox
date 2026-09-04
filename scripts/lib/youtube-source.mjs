// @ts-check
/**
 * YouTube 的「先 RSS、掛了才退回 Data API」那一層 —— 抽出來是為了能測。
 *
 * ## 為什麼值得抽
 *
 * 這一層只有十幾行，但它決定的是**同步失敗時使用者看到什麼**，
 * 而那三條路在真實世界裡很難湊齊：
 *
 *   RSS 成功                  → 平常就是這樣，天天在跑
 *   RSS 失敗 ＋ 有金鑰         → **從來沒有發生過**（站主還沒設 YOUTUBE_API_KEY）
 *   RSS 失敗 ＋ 沒有金鑰       → 今天很常見（那個端點會一陣一陣地 404）
 *
 * 中間那條是整個降級設計的重點，而它一次都沒有被執行過。
 * 待辦從第 4 輪（第七圈）記到第 4 輪（第九圈），三圈。
 *
 * ## 注入什麼
 *
 * 兩個策略與金鑰都是注入的，所以測試完全不碰網路。
 */

/**
 * @param {any} source
 * @param {object} o
 * @param {(source: any, channelId: string) => Promise<any[]>} o.fetchRss
 * @param {(source: any, channelId: string) => Promise<any[]>} o.fetchApi
 * @param {string} [o.apiKey]
 * @param {{ warn: (...a: any[]) => void }} [o.log]
 */
export async function fetchYouTubeSource(source, { fetchRss, fetchApi, apiKey = '', log = { warn: () => {} } }) {
  const channelId = source.channelId?.trim();
  if (!channelId?.startsWith('UC')) {
    throw new Error('channelId 必須是 UC 開頭的頻道 ID');
  }

  try {
    return await fetchRss(source, channelId);
  } catch (err) {
    const why = /** @type {{ message?: string }} */ (err)?.message ?? String(err);
    /*
     * 沒有金鑰時**不要**去打 API —— 那只會多一個「401 沒有金鑰」的錯誤，
     * 把真正的原因（RSS 為什麼失敗）擠掉。訊息裡保留原因，
     * 因為那是站主在 `sync:dry` 的輸出裡唯一看得到的線索。
     */
    if (!apiKey) {
      /*
       * ── 這是站主最可能看到的一句話 ──────────────────
       *
       * 她現在沒有設 YOUTUBE_API_KEY，所以 RSS 一失敗就走到這裡。
       * 第 4 輪（第十七圈）之前這句話只講「RSS 失敗、沒有金鑰可以退回」——
       * 而這個專案**最貴的一課**就在這個端點上，卻沒有寫進訊息：
       *
       *   CLAUDE.md：「不要因為一次 404 就斷定它下架了 —— 我第一次就是這樣搞錯的。」
       *   實測（2026-09-02）：同一個端點上午對所有頻道都回 404（連 Google
       *   自家頻道都是），中午再測就恢復 200。
       *
       * 那一課寫在文件裡，而她看到的是終端機。所以放進訊息本身。
       */
      const flaky = /404/.test(why);
      throw new Error(
        `RSS 失敗（${why}），而且沒有 YOUTUBE_API_KEY 可以退回。` +
          (flaky
            ? '　改法：**先不要當成帳號沒了** —— 這個端點會間歇性回 404（實測同一天' +
              '上午全部 404、中午恢復）。過幾分鐘用 `npm run verify -- --patterns` 重驗；' +
              '真的持續不通再考慮設 YOUTUBE_API_KEY。'
            : '　改法：先用 `npm run verify` 看那個網址現在通不通；' +
              '持續不通再考慮設 YOUTUBE_API_KEY。'),
      );
    }
    log.warn(`RSS 失敗（${why}），改用 Data API`);
    return await fetchApi(source, channelId);
  }
}
