/*
 * 畫面上真的用到哪些「前景色配背景色」—— 貼進瀏覽器 console 跑。
 *
 * ## 為什麼是這種形式
 *
 * `check:contrast` 算得很準，但它算的是 `PAIRS` 上有的那幾組 ——
 * 而 `PAIRS` 是**人手維護的清單**。加一個元件、換一個 class，
 * 畫面上就多一組沒有人算過的組合，而那一支不會知道。
 *
 * 要知道「畫面上真的畫了哪些組合」需要算好的樣式，也就是一個真的瀏覽器，
 * 而這個專案刻意沒有那個相依套件（理由與有效期限在
 * `docs/ARCHITECTURE.md` 的「檢查用的瀏覽器：這個決定的有效期限」）。
 * 所以量法跟 `probe-a11y-layout.js` 一樣：**貼上去就能跑**。
 *
 * ## 為什麼這一支存在（第 8 輪〔第三十八圈〕）
 *
 * 第 8 輪（第三十六圈）用這個方法量過一次，找到 `PAIRS` 漏掉的一組
 * （`--c-ink-faint` 畫在 `--c-bg-sunken` 上，淺色 4.52，門檻 4.5）。
 * 但那次的程式是**當場打的**，沒有留下來 —— 留下來的只有一句
 * 「要重量：`npm run preview`，再對每個有文字的元素取 color ＋ 第一個不透明背景」。
 *
 * 那句話是**描述**，不是工具。照著它重寫的人要自己決定：
 * 選取器是什麼、「第一個不透明背景」怎麼走、token 名字怎麼反查。
 * 而那正是會出錯的地方 —— 第 1 輪（第三十八圈）我用自己寫的離線選取器
 * 數可聚焦元素，得到 47 而基準是 45，差的是看不見的元素。
 *
 * ## 怎麼用
 *
 *   1. `npm run preview`（量產出；`npm run dev` 也可以，但那是未壓縮的）
 *   2. 把這整個檔案貼進 console，按 Enter
 *   3. 每一頁各跑一次 —— 它量的是**當下這一頁**
 *
 * 最近一次的結果在 `docs/REVIEW-LOG.md` 第 8 輪（第三十六圈）那一筆。
 *
 * ## 一個踩過的坑
 *
 * **半透明的背景沒有 token 名字。** 頁首是
 * `color-mix(in srgb, var(--c-bg) 88%, transparent)`，
 * 所以它算出來是一個帶 alpha 的顏色，反查不到名字。
 * 那不是漏掉 —— `check:contrast` 有一整段在講半透明表面。
 * 這裡照樣把它印出來，但標成「（半透明）」，不要以為是新的一組。
 */
(() => {
  /* 這一頁看得到的所有 `--c-` token，值 → 名字 */
  const names = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; /* 跨來源的樣式表讀不到，跳過 */
    }
    for (const r of rules) {
      const style = /** @type {CSSStyleRule} */ (r).style;
      if (!style) continue;
      for (const p of style) if (p.startsWith('--c-')) names.add(p);
    }
  }
  const byValue = new Map();
  for (const n of names) {
    const el = document.createElement('div');
    el.style.color = `var(${n})`;
    document.body.appendChild(el);
    const v = getComputedStyle(el).color;
    el.remove();
    if (!byValue.has(v)) byValue.set(v, n);
  }
  const nameOf = (/** @type {string} */ v) => byValue.get(v) ?? v;

  /*
   * 「這個元素實際上畫在什麼底色上」—— 往上找到第一個不透明的背景。
   * 這是瀏覽器實際合成的方式，也是 `check:contrast` 假設的那一個。
   */
  const backdrop = (/** @type {Element} */ el) => {
    /** @type {Element | null} */
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      const bg = cs.backgroundColor;
      if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
        return { color: bg, image: cs.backgroundImage !== 'none' };
      }
      n = n.parentElement;
    }
    return { color: getComputedStyle(document.documentElement).backgroundColor, image: false };
  };

  const combos = new Map();
  for (const el of document.querySelectorAll('*')) {
    /* 只看**自己**有文字的元素 —— 不然每一個祖先都會被算一次 */
    const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim().length > 0);
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const bg = backdrop(el);
    const fgName = nameOf(cs.color);
    const bgName = nameOf(bg.color);
    const translucent = /\/\s*0?\.\d/.test(bg.color) || /rgba\([^)]*,\s*0?\.\d+\)/.test(bg.color);
    const key =
      `${fgName} on ${bgName}` +
      (translucent ? '（半透明）' : '') +
      (bg.image ? '（底下還有圖／漸層）' : '');
    const hit = combos.get(key) ?? { count: 0, sample: (el.textContent ?? '').trim().slice(0, 20) };
    hit.count += 1;
    combos.set(key, hit);
  }

  const rows = [...combos.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([組合, v]) => ({ 組合, 幾個元素: v.count, 例子: v.sample }));

  console.log('─'.repeat(64));
  console.log(`${location.pathname}　真的出現 ${rows.length} 種前景／背景組合`);
  console.table(rows);
  console.log('對照 scripts/check-contrast.mjs 的 PAIRS —— 表上沒有的那幾組就是沒有人算過的。');
  console.log('（帶「半透明」的那種算不出單一答案，check:contrast 有一整段在講它。）');
  console.log('');

  return rows;
})();
