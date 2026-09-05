// @ts-check
/**
 * 這個平臺在 `sources.mjs` 裡已經有來源了嗎？
 *
 * ## 為什麼要有這一支
 *
 * 第 4 輪（第三十三圈）實測 `npm run handle foxpoetry`：它列出三個「有東西」
 * 的平臺，然後**替三個都產生一段可以貼進 `sources.mjs` 的片段** ——
 * 包括 YouTube，而 YouTube 早就在那個檔案裡了（`youtube-foxpoetry`，
 * 同一個帳號名、同一個頻道）。
 *
 * 那支工具存在的理由只有一個時刻：**站主剛問到一個帳號名**。
 * 而它在那個時刻遞出去的東西裡，有一段貼下去會多一個重複的來源，
 * 而它自己不知道 —— `check-handle.mjs` 從頭到尾沒有讀過 `sources.mjs`。
 *
 * 抽成獨立的一支是為了測得到：`check-handle.mjs` 一載入就會打網路，
 * 沒辦法在單元測試裡跑。
 */

/**
 * @typedef {{ id: string, platform: string, handle?: string }} SourceLike
 */

/**
 * @param {SourceLike[]} sources 現有的來源（`sources.mjs` 的 `sources`）
 * @param {string} platformId 平臺 id
 * @param {string} handle 這次查的帳號名
 * @returns {{ id: string, handle: string, sameHandle: boolean } | null}
 *   已經有就回那一筆；`sameHandle` 為 false 代表**同平臺、不同帳號** ——
 *   那是另一個帳號，不是重複，所以呼叫端仍該給片段，只是要提一下。
 */
export function existingSource(sources, platformId, handle) {
  const hit = sources.find((s) => s.platform === platformId);
  if (!hit) return null;
  const have = (hit.handle ?? '').toLowerCase();
  return { id: hit.id, handle: hit.handle ?? '', sameHandle: have === handle.toLowerCase() };
}
