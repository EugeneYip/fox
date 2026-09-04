// @ts-check
/**
 * 把一個失敗步驟的輸出整理成「看得出哪裡壞了」的幾行。
 *
 * ## 為什麼需要這個
 *
 * `ci:sim` 的失敗分支十二圈以來**一次都沒有跑過** —— 每一輪都是全綠的。
 * 第 7 輪（第十二圈）故意弄壞四樣東西各跑一次，才第一次看到它印什麼：
 *
 *   壞掉的東西            原本印出來的全部內容
 *   ──────────────────  ────────────────────────────────
 *   詩的日期打錯          `X verify:all` ＋「Syncing content」一行
 *   src/ 的型別錯誤       一排波浪號 ＋「Result (110 files): 1 error」
 *   腳本本身語法錯誤      同上，另外一行「14 項失敗。」
 *   （任何一個失敗）      「X dist/CNAME 不見了 —— GitHub 會取消自訂網域」
 *
 * 第一列最要命：Astro 的建置錯誤**整段走 stderr**，而原本只讀 `err.stdout`，
 * 所以「哪個檔案、哪個欄位、該怎麼改」那三行全部被丟掉，
 * 留下的是一句進度訊息。第 3 輪（第十二圈）才剛把那些 zod 訊息寫得
 * 對打錯字的人有用 —— CI 模擬把它們扔了。
 *
 * 第二列是另一種：`astro check` 全部走 stdout，但**只留最後 8 行**，
 * 而它的輸出是 14 行、真正那句 `檔案:行 - error ts(…)` 在倒數第 10 行。
 * 窗開得太小，剛好切在有用的東西上面。
 *
 * 所以：兩個管道都印，stderr 先（錯誤在那裡），窗放大到 20 行，
 * 而且先把尾端的空行去掉再取 —— 不然窗會被空行吃掉
 * （「日期打錯」那次的 stdout 是 3 行內容 ＋ 一堆空行）。
 */

/** @param {unknown} v */
const text = (v) => (v == null ? '' : String(v)).replace(/\s+$/, '');

/**
 * @param {unknown} err  execFileSync 丟出來的錯誤（stdio: 'pipe' 時帶著兩個管道）
 * @param {{ lines?: number, indent?: string }} [opts]
 * @returns {string} 已經縮排好、可以直接 console.log 的區塊
 */
export function formatStepFailure(err, { lines = 20, indent = '      ' } = {}) {
  const e = /** @type {{ stdout?: unknown, stderr?: unknown }} */ (err ?? {});
  const stderr = text(e.stderr);
  const stdout = text(e.stdout);

  /** @param {string} body @param {string} label */
  const block = (body, label) => {
    const all = body.split('\n');
    const shown = all.slice(-lines);
    const head = all.length > shown.length ? `${label}（最後 ${lines} 行，共 ${all.length} 行）` : label;
    return [`── ${head} ──`, ...shown].map((l) => indent + l).join('\n');
  };

  /** @type {string[]} */
  const parts = [];
  /*
   * stderr 先。這不是美觀問題：真正的錯誤幾乎都在那裡，
   * 而人只會看緊接在 `X 步驟名` 底下的那幾行。
   */
  if (stderr) parts.push(block(stderr, '錯誤輸出 stderr'));
  if (stdout) parts.push(block(stdout, '一般輸出 stdout'));
  if (parts.length === 0) {
    /*
     * 兩邊都空的話要明講。原本會印出一行六個空白，
     * 看起來像「有輸出但看不懂」，而不是「這個步驟什麼都沒說」。
     */
    return indent + '（這個步驟沒有留下任何輸出 —— 連錯誤訊息都沒有）';
  }
  return parts.join('\n');
}
