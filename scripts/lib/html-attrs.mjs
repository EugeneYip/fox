// @ts-check
/**
 * 從一個開始標籤把屬性讀出來 —— **不用正則**。
 *
 * ## 為什麼要有這個檔案
 *
 * `check-a11y.mjs` 原本用 `new RegExp('\\b' + name + '\\s*=\\s*"…"')` 讀屬性。
 * `\b` 是「單字邊界」，而**連字號後面就是一個單字邊界** ——
 * 所以 `data-lang="zh"` 裡的 `lang="zh"` 完全符合那個樣式。
 *
 * 第 7 輪（第十二圈）拿「把 `<html lang>` 換成 `data-lang`」當探針時撞到：
 * 產出裡一個 `lang` 都沒有，而 `check:a11y` 44 頁全綠。
 * 第 1 輪（第十三圈）把整份掃過，同一個成因造成兩種相反的錯：
 *
 *   誤報：`data-tabindex="5"` → positive-tabindex
 *         `data-aria-labelledby` → aria-ref
 *   漏報：`data-lang` 吃掉 html-lang、`data-alt` 吃掉 img-alt、
 *         `data-rel` 吃掉 blank-rel
 *
 * 這是這個 repo 第 9 次「用正則剖結構化資料」出事。所以這次不再修正則，
 * 而是寫一個真的掃描器：屬性在開始標籤裡**一定是接在空白後面**，
 * 逐字掃就不會有邊界的問題。
 *
 * ## 刻意沒做的事
 *
 * - **不解 HTML 實體**（`&amp;` 留著）。原本的正則也沒解，而這裡的用途是
 *   「這個屬性在不在、值是不是空的」，解了反而多一層跟原本不一樣的行為。
 * - **不處理 `<script>`／`<style>` 裡的假標籤**。呼叫端拿到的已經是
 *   `strip()` 過的 HTML。
 */

/**
 * @param {string} openTag 一個開始標籤，例如 `<img src="a.png" alt>`
 * @returns {Map<string, string>} 屬性名（小寫）→ 值。無值屬性的值是空字串。
 */
export function parseAttrs(openTag) {
  /** @type {Map<string, string>} */
  const out = new Map();
  let i = 0;
  if (openTag[i] === '<') i++;
  // 跳過標籤名
  while (i < openTag.length && !/[\s/>]/.test(openTag[i])) i++;

  while (i < openTag.length) {
    while (i < openTag.length && /[\s/]/.test(openTag[i])) i++;
    if (i >= openTag.length || openTag[i] === '>') break;

    const nameStart = i;
    while (i < openTag.length && !/[\s=/>]/.test(openTag[i])) i++;
    const name = openTag.slice(nameStart, i).toLowerCase();
    if (!name) { i++; continue; }

    while (i < openTag.length && /\s/.test(openTag[i])) i++;
    let value = '';
    if (openTag[i] === '=') {
      i++;
      while (i < openTag.length && /\s/.test(openTag[i])) i++;
      const quote = openTag[i];
      if (quote === '"' || quote === "'") {
        i++;
        const end = openTag.indexOf(quote, i);
        value = end < 0 ? openTag.slice(i) : openTag.slice(i, end);
        i = end < 0 ? openTag.length : end + 1;
      } else {
        const valueStart = i;
        while (i < openTag.length && !/[\s>]/.test(openTag[i])) i++;
        value = openTag.slice(valueStart, i);
      }
    }
    /*
     * 同名屬性重複時第一個勝 —— 瀏覽器就是這樣，後面的直接丟掉。
     * （`<img alt="真的" alt="假的">` 唸出來的是「真的」。）
     */
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * 讀單一屬性。沒有這個屬性時回 `null`；有但沒有值時回 `''`
 * （HTML 規定無值屬性的值就是空字串 —— `<img alt>` 是「裝飾圖」的正確寫法）。
 *
 * @param {string} openTag
 * @param {string} name
 * @returns {string | null}
 */
export function attrOf(openTag, name) {
  const v = parseAttrs(openTag).get(name.toLowerCase());
  return v === undefined ? null : v;
}
