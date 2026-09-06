/**
 * 同步來源的健康狀況 —— 「上一次真的拿到資料是多久以前」。
 *
 * ## 為什麼抽出來
 *
 * 這個判斷原本只活在 `check-content.mjs` 裡，而那一支只在
 * `test:built` 裡跑，也就是**只在部署路徑上**跑。
 *
 * 第 4 輪（第三十八圈）追出來的鏈子：
 *
 *   來源全部失敗 → `sync-feeds.mjs` 沿用快取、離開碼 **0**（沒加 --strict）
 *   → `syndication.json` 沒有變動 → 「有變動就 commit」那一步 `changed=false`
 *   → 「觸發部署」那一步的 `if:` 不成立 → **deploy.yml 不跑**
 *   → `check:content` 不跑 → **這個鬧鐘不會響**
 *
 * 排程那一次是**綠的、而且安靜的**。鬧鐘存在，但從排程那條路走不到它。
 *
 * 所以判斷搬到這裡，讓排程自己也能問一次（`npm run sync:health`）。
 * 門檻只有一個常數，兩邊共用 —— 不要變成「同一件事寫在兩個地方」。
 */

/** 幾天沒成功就算「冷掉了」。跟 `check:content` 共用同一個數字。 */
export const SYNC_STALE_DAYS = 3;

/*
 * ── 分母是「這份資料記了誰」，不是「設定檔宣告了誰」──────────
 *
 * 第 4 輪（第四十三圈）量到的：`syncSources()` 有兩條路會**跳過一個來源
 * 而且不寫任何紀錄**。
 *
 *   handle 還是 `CHANGE_ME` → `say.warn` 之後 `continue`，**連 failures 都不加**
 *   platform id 不存在      → `say.fail`、failures + 1，一樣沒有紀錄
 *
 * 實測（兩個都開著的來源，直接呼叫 `syncSources`）：
 *
 *     宣告的來源：a-changeme、b-unknown
 *     syndication.json 記下的：（一個都沒有）
 *     failures = 1
 *
 * 排程跑的是 `sync-feeds.mjs --verbose`（沒有 `--strict`），所以兩種都
 * 離開碼 0；接著 `sync:health` 只看 `data.sources`，於是印
 * 「1 個來源，全部都在 3 天內成功過 ✓」。
 *
 * **那正是這個模組上面那段在講的同一件事**（排程那一次是綠的、而且安靜的），
 * 只是往上一層：這次不是「鬧鐘走不到」，是**鬧鐘看不到那個來源**。
 *
 * 所以多收一個「設定檔宣告了誰」，兩邊相減。拿不到就說沒有比對。
 */
/**
 * @param {{ sources?: Record<string, { status?: string, lastSuccessAt?: string | null }> }} data
 * @param {number} [now] 現在的時間戳（測試用）
 * @param {string[] | null} [declared] `sources.mjs` 裡開著的來源 id；`null` 表示讀不到，不比對
 * @returns {{ total: number, cold: { id: string, days: number | null }[], missing: string[] }}
 *   `days` 是 `null` 表示**從來沒有成功過**（`lastSuccessAt` 空的）。
 *   `missing` 是宣告了、但這份資料**一筆紀錄都沒有**的來源。
 */
export function sourceHealth(data, now = Date.now(), declared = null) {
  const entries = Object.entries(data.sources ?? {});
  const cold = [];
  for (const [id, st] of entries) {
    const last = st?.lastSuccessAt ? Date.parse(st.lastSuccessAt) : NaN;
    if (Number.isNaN(last)) {
      cold.push({ id, days: null });
      continue;
    }
    const quiet = (now - last) / 86_400_000;
    if (quiet > SYNC_STALE_DAYS) cold.push({ id, days: Number(quiet.toFixed(1)) });
  }
  const known = new Set(entries.map(([id]) => id));
  const missing = (declared ?? []).filter((id) => !known.has(id));
  return { total: entries.length, cold, missing };
}

/** 給人看的一行 —— 宣告了卻連紀錄都沒有的來源 */
export function missingLine(/** @type {string} */ id) {
  return (
    `${id} —— sources.mjs 裡開著，但同步**從來沒有為它寫過任何東西**` +
    '（handle 還是 CHANGE_ME、或 platform id 不存在，都會走到這裡）'
  );
}

/** 給人看的一行 —— `check:content` 與 `sync:health` 印的是同一句 */
export function coldLine(/** @type {{ id: string, days: number | null }} */ c) {
  return c.days === null
    ? `${c.id} —— **從來沒有成功過**（lastSuccessAt 是空的）`
    : `${c.id} —— 上次真的拿到資料是 ${c.days} 天前`;
}
