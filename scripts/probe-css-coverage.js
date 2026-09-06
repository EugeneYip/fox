/*
 * 站上有哪些 CSS 選擇器**從來沒有配到任何元素** —— 貼進瀏覽器 console 跑。
 *
 * ## 為什麼是這種形式
 *
 * 跟 `probe-a11y-layout.js`、`probe-contrast-pairs.js` 同一個理由：
 * 要判斷「這條規則配不配得到」需要一個真的 DOM，而這個專案刻意沒有那個
 * 相依套件（見 `docs/ARCHITECTURE.md` 的「檢查用的瀏覽器：這個決定的有效期限」）。
 *
 * ## 為什麼這一支存在（第 8 輪〔第四十圈〕）
 *
 * 第四十圈問的是「這段東西，站上真的跑過嗎？」。CSS 是最難回答的一塊：
 * `check:contrast` 會說哪些 **token** 沒人用，但沒有人說哪些**規則**沒配到東西。
 * 那一輪當場量出來是 **335 條選擇器裡 106 條（32%）**一條都沒配到 ——
 * 而那個程式如果不留下來，下次又要重打一次。
 *
 * ## 讀法：32% 不等於「32% 是死的」
 *
 * 這支腳本用 `DOMParser` 靜態剖析每一頁，所以有三種「配不到」它分不出來，
 * 底下的分類就是為了這件事：
 *
 *   還沒有內容    `img`、`table`、`pre code`、`.prose h3` ⋯
 *                 markdown 裡還沒寫過那種東西。不是死的，是還沒用到。
 *   要跑起來才有  `:focus-visible`、`:root[data-theme="dark"]`、`.lang[open] ⋯`
 *                 需要互動或 JS 設好屬性 —— **靜態剖析永遠看不到，不代表沒用**。
 *   元件沒算繪過  `.facade*`（VideoFacade）、`.cover*`（CoverImage）、
 *                 `.pager*`、`.series*` ⋯ 那些元件在站上一次都沒有出現過。
 *
 * 只有第三類值得追，而且多半不是「刪掉」，是「還沒有那種內容」。
 *
 * ## 怎麼跑
 *
 *   npm run preview          （或 npm run dev）
 *   開 http://localhost:4322/ ，F12 → Console，把整支貼進去
 */
(async () => {
  /*
   * 站上每一頁 —— **要爬，不能只讀當前這一頁的連結**。
   *
   * 第一版只取首頁上的 `a[href^="/"]`，抓到 33 條，而站上是 44 頁 ——
   * 少掉的正好是整個 `/en` 那一半（首頁只連到 `/en` 本身）。
   * 而 `/en` 那半邊是空狀態唯一算繪得出來的地方（第 6 輪〔第四十圈〕），
   * 也就是**最需要量的那一半剛好在外面**。
   */
  const seen = new Set();
  /* `/404` 沒有人連得到（那正是它存在的理由），所以要自己排進去 */
  const queue = ['/', '/404'];
  const isPage = (/** @type {string} */ p) => !/\.[a-z0-9]+$/i.test(p);
  const docsByPath = new Map();
  while (queue.length > 0 && seen.size < 300) {
    const p = queue.shift();
    if (p === undefined || seen.has(p) || !isPage(p)) continue;
    seen.add(p);
    const res = await fetch(p).catch(() => null);
    if (!res || !res.ok) continue;
    const d = new DOMParser().parseFromString(await res.text(), 'text/html');
    docsByPath.set(p, d);
    for (const a of d.querySelectorAll('a[href^="/"]')) {
      const href = a.getAttribute('href');
      if (href === null) continue;
      const next = new URL(href, location.origin).pathname;
      if (!seen.has(next) && isPage(next)) queue.push(next);
    }
  }

  /*
   * 偽類與偽元素要剝掉再測。`:hover`、`::before` 在 `querySelector` 下
   * 永遠配不到，那不代表沒有元素用到那條規則。
   */
  const strip = (/** @type {string} */ s) =>
    s
      .replace(/::[a-z-]+(\([^)]*\))?/gi, '')
      .replace(
        /:(hover|focus|focus-visible|focus-within|active|visited|target|checked|disabled|open|placeholder-shown|autofill)\b(\([^)]*\))?/gi,
        '',
      )
      .trim();

  /*
   * 走規則樹的時候**先看 selectorText，再遞迴**。
   *
   * 第一版寫成「有 cssRules 就當成容器、遞迴完就 continue」，結果一條都抽不到：
   * CSS 巢狀上線之後 `CSSStyleRule` 自己也有 `cssRules`（空的，但是 truthy），
   * 於是每一條樣式規則都被當成容器跳過了。
   */
  const sels = new Set();
  const walk = (/** @type {any} */ rules) => {
    for (const r of rules) {
      if (r.selectorText) {
        for (const one of r.selectorText.split(',')) {
          const t = one.trim();
          if (t) sels.add(t);
        }
      }
      if (r.cssRules && r.cssRules.length) walk(r.cssRules);
    }
  };

  /** @type {Document[]} */
  const docs = [];
  const hrefs = new Set();
  for (const d of docsByPath.values()) {
    docs.push(d);
    for (const l of d.querySelectorAll('link[rel="stylesheet"]')) hrefs.add(l.getAttribute('href'));
    /* 內嵌的 <style> 每頁可能不同，逐頁收 */
    for (const st of d.querySelectorAll('style')) {
      const sheet = new CSSStyleSheet();
      await sheet.replace(st.textContent);
      walk(sheet.cssRules);
    }
  }
  for (const href of hrefs) {
    const sheet = new CSSStyleSheet();
    await sheet.replace(await (await fetch(href)).text());
    walk(sheet.cssRules);
  }

  /** @type {string[]} */
  const unmatched = [];
  for (const raw of sels) {
    const s = strip(raw);
    if (!s) continue;
    let hit = false;
    for (const d of docs) {
      try {
        if (d.querySelector(s)) { hit = true; break; }
      } catch { hit = true; break; }
    }
    if (!hit) unmatched.push(raw);
  }

  /* 分類 —— 判準寫在上面「讀法」那一節 */
  const CONTENT = /^(img|table|td|th|tr|thead|tbody|pre|code|kbd|samp|small|b|i|em|strong|h[4-6]|video|picture|select|textarea|blockquote|hr)\b|^\.prose\b/;
  const RUNTIME = /:(hover|focus|active|visited|target|checked|open|has\()|\[data-theme|\[data-theme-pref|\[data-poem-orientation|\[data-orientation|\[data-print-overflows|^:focus-visible/;
  /** @type {Record<string, string[]>} */
  const bucket = { '還沒有內容': [], '要跑起來才有': [], '元件沒算繪過': [] };
  for (const s of unmatched.sort()) {
    if (RUNTIME.test(s)) bucket['要跑起來才有'].push(s);
    else if (CONTENT.test(s)) bucket['還沒有內容'].push(s);
    else bucket['元件沒算繪過'].push(s);
  }

  console.log(`掃了 ${docs.length} 頁、${sels.size} 條選擇器 —— ${unmatched.length} 條一個元素都沒配到（${Math.round((unmatched.length / sels.size) * 100)}%）`);
  for (const [k, v] of Object.entries(bucket)) {
    console.log(`\n${k}：${v.length} 條`);
    console.log('  ' + (v.join('\n  ') || '（無）'));
  }
  console.log('\n只有「元件沒算繪過」那一組值得追 —— 而且多半不是刪掉，是還沒有那種內容。');
  return { pages: docs.length, selectors: sels.size, unmatched: unmatched.length, bucket };
})();
