// @ts-check
/**
 * 從 workflow 裡把某個 step 的 `run: |` 區塊取出來 —— 為了**跑它**，
 * 而不是照著它再寫一份。
 *
 * ## 為什麼抽成共用的
 *
 * 第 7 輪（第八圈）為 `sync-feeds.yml` 寫過這個取法，理由是那兩段 shell
 * 「一次都沒有被執行過」。第 7 輪（第十四圈）發現 `ci:sim` 有同樣的問題
 * 的另一半：它**照著 `deploy.yml` 的 CNAME step 再寫了一份 JS**。
 *
 *   deploy.yml　`test -f dist/CNAME || { …; exit 1; }` ＋ `echo "CNAME = $(cat …)"`
 *   ci:sim　　　`existsSync(resolve(TMP, 'dist/CNAME'))`
 *
 * 今天兩者的通過／失敗判斷一樣，但**印出來的東西不一樣**（workflow 會印
 * 實際的網域，模擬不會），而且 workflow 那一步以後改了，模擬不會跟。
 * 第 7 輪（第十圈）把步驟清單從「抄一份」改成「讀出來」的理由一模一樣：
 * 走鐘的時候不會有任何徵兆。
 *
 * ## 取完要先驗過
 *
 * 抽不到、或抽到的東西不含預期的關鍵字，就當場拋錯 ——
 * 這個 repo 用正則剖結構化資料踩過九次，取到空字串然後「全部通過」
 * 是最糟的結局。
 */

/**
 * 取出某個 step 的 `run: |` 區塊，並去掉共同縮排。
 *
 * @param {string} yml
 * @param {string} stepName  `- name:` 後面那個字串
 * @returns {string}
 */
export function runBlock(yml, stepName) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.includes(`name: ${stepName}`));
  if (start < 0) throw new Error(`找不到 step「${stepName}」`);
  const runAt = lines.findIndex((l, i) => i > start && /^\s*run:\s*\|\s*$/.test(l));
  if (runAt < 0) throw new Error(`step「${stepName}」沒有 run: | 區塊`);
  const indent = (lines[runAt].match(/^\s*/) ?? [''])[0].length + 2;
  /** @type {string[]} */
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    if ((l.match(/^\s*/) ?? [''])[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n').replace(/\s+$/, '') + '\n';
}
