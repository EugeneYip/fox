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

/**
 * @param {{ sources?: Record<string, { status?: string, lastSuccessAt?: string | null }> }} data
 * @param {number} [now] 現在的時間戳（測試用）
 * @returns {{ total: number, cold: { id: string, days: number | null }[] }}
 *   `days` 是 `null` 表示**從來沒有成功過**（`lastSuccessAt` 空的）。
 */
export function sourceHealth(data, now = Date.now()) {
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
  return { total: entries.length, cold };
}

/** 給人看的一行 —— `check:content` 與 `sync:health` 印的是同一句 */
export function coldLine(/** @type {{ id: string, days: number | null }} */ c) {
  return c.days === null
    ? `${c.id} —— **從來沒有成功過**（lastSuccessAt 是空的）`
    : `${c.id} —— 上次真的拿到資料是 ${c.days} 天前`;
}
