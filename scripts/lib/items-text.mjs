/**
 * 「剖析出幾筆」那一格要印什麼。
 *
 * ## 為什麼抽出來
 *
 * 它原本是 `verify-sources.mjs` 裡的一個區域常數，而那一支**只走網路**
 * —— 要驗它的輸出就得真的去打十一個平臺。
 *
 * 第 4 輪（第三十九圈）加了「第二種算法」的對照之後更需要一個測得到的縫：
 * 那個對照要在**兩邊不一樣**的時候說話，而真實的 feed 幾乎永遠一樣，
 * 也就是說最重要的那條路在真的執行時**跑不到**。
 *
 * ## 那個對照在守什麼
 *
 * `countItems()` 走的是完整剖析器。它哪天開始漏掉項目，
 * 這一格的數字只會**變小** —— 沒有人看得出來。
 * 直接數標籤是一個獨立的算法，兩邊一比就看得見。
 *
 * **不一樣不一定是錯的**：剖析器會丟掉沒有連結或標題的項目。
 * 所以只把差說出來，不當成失敗。
 */

/**
 * @param {{ items?: number, parseErr?: string, naive?: number }} r
 * @returns {string}
 */
export function itemsText(r) {
  if (r.items === undefined) return '';
  if (r.items < 0) return `**剖析失敗：${r.parseErr}**`;
  if (r.items === 0) return '**0 筆**';
  const gap = typeof r.naive === 'number' && r.naive !== r.items ? `（標籤數 ${r.naive}）` : '';
  return `${r.items} 筆${gap}`;
}
