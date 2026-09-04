// @ts-check
/**
 * 把剖析出來的一筆變成存進 syndication.json 的形狀，以及「只增不刪」的合併。
 *
 * ## 為什麼獨立成一個檔案
 *
 * 這兩段都屬於**壞掉不會拋錯**的那一類（跟第 4 輪〔第四圈〕對剖析器的判斷一樣）：
 *
 * - `normalizeItem` 的欄位對應錯了 → 同步照樣回報成功，只是資料是空的
 * - `mergeItems` 沒保留 `firstSeenAt` → 每次同步都變成「今天第一次看到」，
 *   而那個欄位存在的理由正是記錄第一次看到的時間
 *
 * ⚠ 第 4 輪（第十二圈）查過：**目前沒有任何地方讀 `firstSeenAt`** ——
 * `lib/syndication.ts` 的 `RawItem` 裡沒有它，頁面上也不顯示。
 * 它是純粹的來歷紀錄（「這一筆是什麼時候第一次出現的」），
 * 而那種東西一旦沒記就補不回來，所以留著、也繼續測著。
 * 但要知道：現在把它弄丟不會有任何畫面變化，也不會有任何檢查說話。
 *
 * 第二個特別隱形：資料看起來完全正常，只是那個時間戳每天都不一樣。
 */

/** @typedef {{ id: string, lang?: string, tags?: string[] }} Source */
/** @typedef {{ id: string, media: string }} Platform */

/** 固定的鍵順序 —— 讓 git diff 只顯示真正變動的內容 */
/** @param {any} item @param {Source} source @param {Platform} platform */
export function normalizeItem(item, source, platform) {
  return {
    id: item.id,
    sourceId: source.id,
    platform: platform.id,
    media: platform.media,
    title: item.title,
    url: item.url,
    publishedAt: item.publishedAt ?? null,
    summary: item.summary || '',
    lang: source.lang ?? 'zh-TW',
    tags: [...new Set([...(source.tags ?? []), ...(item.tags ?? [])])].slice(0, 8),
    thumbnail: item.thumbnail ?? null,
    externalId: item.externalId ?? null,
  };
}

/**
 * 只增不刪的合併。三種情況：沒看過的就加、內容變了就更新
 * （**保留原本的 firstSeenAt**）、完全一樣就不動。
 *
 * @param {Map<string, any>} byId  既有資料，會被就地修改
 * @param {any[]} items
 * @param {Source} source
 * @param {Platform} platform
 * @param {() => string} [now]  只給測試用，讓時間可預測
 */
export function mergeItems(byId, items, source, platform, now = () => new Date().toISOString()) {
  let added = 0;
  let updated = 0;
  for (const item of items) {
    const next = normalizeItem(item, source, platform);
    const prev = byId.get(next.id);
    if (!prev) {
      added++;
      byId.set(next.id, { ...next, firstSeenAt: now() });
    } else if (
      JSON.stringify({ ...prev, firstSeenAt: null }) !== JSON.stringify({ ...next, firstSeenAt: null })
    ) {
      updated++;
      // 保留第一次看到的時間 —— 那正是這個欄位存在的理由
      byId.set(next.id, { ...next, firstSeenAt: prev.firstSeenAt });
    }
  }
  return { added, updated };
}
