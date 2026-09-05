/*
 * 版面相關的無障礙量測 —— 貼進瀏覽器 console 跑。
 *
 * ## 為什麼是這種形式
 *
 * `check:a11y` 掃的是 HTML 字串，量不到「這個東西在畫面上多大、離隔壁多遠」。
 * 要量那個得有排版引擎，也就是一個真的瀏覽器 —— 而這個專案刻意沒有那個
 * 相依套件。**那個決定的理由與有效期限**寫在
 * `docs/ARCHITECTURE.md` 的「檢查用的瀏覽器：這個決定的有效期限」。
 *
 * 所以量法不是一支 npm script，是一段**貼上去就能跑**的程式。
 * 沒有相依套件、不需要安裝、任何人打開 devtools 都能重跑一次。
 *
 * ## 怎麼用
 *
 *   1. `npm run dev`（或直接開 https://bellafoxy.com）
 *   2. devtools → 裝置模擬 → 寬度設成 **375**（量測基準寬度，見下）
 *   3. 把這整個檔案貼進 console，按 Enter
 *
 * 每一頁都要各跑一次 —— 它量的是**當下這一頁、當下這個寬度**。
 * 基準頁面與最近一次的數字在 `docs/A11Y.md`。
 *
 * ## 兩個踩過的坑，寫在這裡免得再踩
 *
 * **一、`getBoundingClientRect()` 不是可見性檢查。**
 * 語言選單是 `<details>`，關起來的時候裡面兩個連結**仍然回傳一個 134×43 的框**，
 * 而它們既不可見、也進不了 Tab 順序。第 1 輪（第二十七圈）第一版探針用
 * 「rect 有寬高」當作濾網，於是多算了 2 個元素，還因此報出 2 處「Tab 往回跳」——
 * 兩個都是假的。用 `checkVisibility()`。
 *
 * **二、「餘裕」是相對於 24 說的。**
 * WCAG 2.5.8 的間距例外是：在每個目標的外框中心放一個**直徑 24 的圓**，
 * 圓與圓不相交就算合格 —— 也就是圓心距 ≥ 24。
 * 所以這裡印的「餘裕」＝ **圓心距 − 24**，不是圓心距本身、也不是兩個框的間隙。
 * 第 1 輪（第二十七圈）為了重現舊紀錄的 17.9px 試了三種解讀才對上，
 * 因為當初只記了結論沒記量法。
 */
(() => {
  /*
   * 原生就可聚焦的東西，加上用 role／tabindex 自己變成可聚焦的。
   * `tabindex="-1"` 排除掉 —— 那種是「程式可以聚焦，但 Tab 走不到」。
   */
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[role=button]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  /** @param {Element} el */
  const visible = (el) =>
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });

  const targets = [...document.querySelectorAll(SELECTOR)]
    .filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { el, r, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });

  /*
   * 取名字用 `textContent` 不用 `innerText`：`innerText` 對「沒有被算繪的
   * 文字」回空字串，於是關著的選單裡的連結會顯示成 `A`，看起來像是
   * 「一個沒有名字的連結」—— 那是 link-name 違規的長相，會嚇到人。
   */
  /** @param {Element} el */
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 24);

  /* ── WCAG 2.5.8 目標尺寸 ────────────────────────── */
  const undersized = targets.filter((t) => t.r.width < 24 || t.r.height < 24);
  const rows = undersized.map((t) => {
    let nearest = Infinity;
    let neighbour = null;
    for (const other of targets) {
      if (other.el === t.el) continue;
      const d = Math.hypot(t.cx - other.cx, t.cy - other.cy);
      if (d < nearest) {
        nearest = d;
        neighbour = other.el;
      }
    }
    return {
      名稱: nameOf(t.el),
      尺寸: `${t.r.width.toFixed(1)}×${t.r.height.toFixed(1)}`,
      餘裕: Number((nearest - 24).toFixed(1)),
      最近的鄰居: neighbour ? nameOf(neighbour) : null,
      違規: nearest < 24,
    };
  });
  rows.sort((a, b) => a.餘裕 - b.餘裕);

  /* ── WCAG 2.4.3 焦點順序 ────────────────────────── */
  /*
   * 沒有 tabindex 的話 Tab 順序就是 DOM 順序，所以直接看 DOM 順序裡
   * 「下一個的位置比上一個高」的地方。8px 的容差是給同一列裡上下微差用的。
   *
   * **往回跳不等於違規。** 2.4.3 要的是「順序保住意義與可操作性」，
   * 不是「由上到下」。頁首在窄螢幕折成兩行時，導覽列在第二行、
   * 語言與主題在第一行右側 —— Tab 走完導覽才回到工具列，那一跳是
   * 「內容導覽 → 站臺工具」，語意連貫。所以這裡只報位置，判斷留給人。
   */
  const positiveTabindex = [...document.querySelectorAll('[tabindex]')]
    .map((el) => Number(el.getAttribute('tabindex')))
    .filter((n) => n > 0);
  const jumps = [];
  for (let i = 1; i < targets.length; i++) {
    const prev = targets[i - 1];
    const cur = targets[i];
    const prevTop = Math.round(prev.r.y + scrollY);
    const curTop = Math.round(cur.r.y + scrollY);
    if (curTop < prevTop - 8) jumps.push(`${nameOf(prev.el)}(y=${prevTop}) → ${nameOf(cur.el)}(y=${curTop})`);
  }

  console.log(`\n${location.pathname}　視窗寬 ${innerWidth}px`);
  console.log('─'.repeat(64));
  console.log(`可聚焦元素　　${targets.length} 個`);
  console.log(`小於 24×24　　${undersized.length} 個　其中真的違規 ${rows.filter((r) => r.違規).length} 個`);
  if (rows.length) {
    console.log(`最小餘裕　　　${rows[0].餘裕}px（${rows[0].名稱} 與 ${rows[0].最近的鄰居}）`);
    console.table(rows);
  }
  console.log(`正值 tabindex　${positiveTabindex.length} 個${positiveTabindex.length ? '　← 這個要修，check:a11y 的 positive-tabindex 也會擋' : '（Tab 順序＝DOM 順序）'}`);
  console.log(`視覺上往回跳　${jumps.length} 處${jumps.length ? '' : '（無）'}`);
  for (const j of jumps) console.log(`  ${j}`);
  console.log('');

  return { 可聚焦: targets.length, 小於24: undersized.length, 違規: rows.filter((r) => r.違規).length, 最小餘裕: rows.length ? rows[0].餘裕 : null, 往回跳: jumps.length };
})();
