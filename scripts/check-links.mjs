#!/usr/bin/env node
// @ts-check
/**
 * 站內連結檢查 —— `npm run check:links`
 *
 *   node scripts/check-links.mjs
 *   node scripts/check-links.mjs --dir=<某個 dist>   （測試用）
 *
 * ## 為什麼需要這個
 *
 * 第 7 輪（第十一圈）掃出**21 個指向不存在頁面的站內連結**，全部來自語言鈕：
 * 內容衍生的頁面（詩／文章／短札的內頁、標籤頁）只有中文一種，
 * 而語言鈕與 `<link rel="alternate" hreflang>` 都是機械地把路徑改寫成
 * `/en/...`，不管那一頁在不在。從〈靜夜思〉按下「English」會落到**中文的
 * 404 頁**上 —— 對一個剛按下 English 的人來說是雙重的糟糕。
 *
 * 那個 bug 活了十一圈，因為沒有任何一道關卡在看「連結指到的東西存不存在」。
 *
 * ## 網址怎麼對應到檔案
 *
 * `trailingSlash: 'never'` ＋ `build.format: 'directory'`：
 *
 *   /            → index.html
 *   /about       → about/index.html
 *   /rss.xml     → rss.xml           （有副檔名就是檔案本身）
 *   /tags/唐詩   → tags/唐詩/index.html（網址是 percent-encoded，要先解碼）
 *
 * 只看以 `/` 開頭的絕對路徑 —— 這個站不用相對連結，真的出現了也該被看見，
 * 所以底下會另外報出來。
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const DIST = dirArg ? resolve(dirArg.slice('--dir='.length)) : resolve(ROOT, 'dist');

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * 網址 → dist 底下**可能的**檔案路徑（依序試）。
 *
 * `<路徑>.html` 那一條不是裝飾：`404.html` 就住在根目錄而不是 `404/index.html`
 * （靜態主機把它當錯誤頁），而 404 頁自己的 canonical 指向 `/404`。
 * 少了這一條，這支檢查會把那一個報成壞連結。
 *
 * @returns {string[] | null}
 */
function targetFiles(/** @type {string} */ href) {
  let p;
  try {
    p = decodeURIComponent(href.replace(/^\//, ''));
  } catch {
    return null; // 壞掉的 percent-encoding，下面會報出來
  }
  if (p === '') return ['index.html'];
  if (/\.[a-z0-9]+$/i.test(p)) return [p];
  const bare = p.replace(/\/$/, '');
  return [`${bare}/index.html`, `${bare}.html`];
}

/*
 * 自己家的網域。
 *
 * 第一版只看以 `/` 開頭的路徑，結果**漏掉 `<link rel="alternate" hreflang>`**
 * —— 那些是絕對網址。突變驗證時把 `availableLocales` 的過濾拿掉，
 * 產出裡又出現了指向不存在頁面的 hreflang，而檢查照樣說「全過」。
 *
 * 網域從產出自己的 `<link rel="canonical">` 讀，不從設定檔 import ——
 * 這支腳本只看 dist，測試才餵得進假的 dist。
 */
/*
 * ── 為什麼不從 canonical 讀 ────────────────────────
 *
 * 原本是從每一頁的 `<link rel="canonical">` 取 host。第 4 輪（第二十圈）
 * 走 `canonicalUrl` 這條沒人走過的路時發現：那個欄位存在的**唯一理由**
 * 就是「這篇先發在別的平臺」—— 填了它，那一頁的 canonical 指向的是
 * matters.town 之類的地方，於是那個平臺被當成「自家網域」，
 * 之後每一個指向它的外部連結都會被當成站內檔案去找 → 假的 404。
 *
 * `hreflang` 的替代連結是 `Base.astro` 從 `site.url` 產的，**內容改不動它**，
 * 所以拿它當來源。實測 44 頁全部都有。
 * canonical 留作沒有 hreflang 時的退路（測試的假 dist 多半只有 canonical）。
 */
/** @type {Set<string>} */
const ownHosts = new Set();
for await (const file of walk(DIST)) {
  if (!file.endsWith('.html')) continue;
  const text = await readFile(file, 'utf8');
  const hrefs = [...text.matchAll(/<link[^>]*rel="alternate"[^>]*hreflang="[^"]*"[^>]*href="(https?:\/\/[^"]+)"/gi)].map(
    (m) => m[1],
  );
  if (hrefs.length === 0) {
    const m = /<link[^>]*rel="canonical"[^>]*href="(https?:\/\/[^"]+)"/i.exec(text);
    if (m) hrefs.push(m[1]);
  }
  for (const href of hrefs) {
    try {
      ownHosts.add(new URL(href).host);
    } catch {
      /* 壞掉的網址不是這條規則要管的 */
    }
  }
}

/** @type {{ href: string, from: string, why: string }[]} */
const problems = [];
let pages = 0;
let checked = 0;
/** 被任何一頁指到過的站內路徑（含 `<link rel=alternate>` 那種看不見的） */
const reached = new Set();

for await (const file of walk(DIST)) {
  if (!file.endsWith('.html')) continue;
  pages++;
  const raw = await readFile(file, 'utf8');
  const from = relative(DIST, file);
  /*
   * 先把 `<script>` 與 `<style>` 拿掉。
   *
   * 搜尋頁的結果是 JS 現組的，樣板裡有 `href="${u(e.u)}"` —— 那是一段
   * **樣板不是連結**，解析不出檔案。真正的網址來自搜尋索引，而索引裡的
   * `u` 跟頁面本身是同一條產生路徑（`entryUrl` ＋ `localizePath`），
   * 所以那些網址跟著頁面一起被這個檢查涵蓋到。
   *
   * （拿掉 `<script>` 是有代價的 —— 第 6 輪〔第十一圈〕那個「訊息到不了
   * 畫面上」的 bug 就住在這種地方。這裡拿掉是對的，因為樣板字串沒有可以
   * 對應到檔案的值；但要記得這道關卡看不到腳本裡的邏輯。）
   */
  const html = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  for (const m of html.matchAll(/\b(?:href|src)\s*=\s*"([^"]+)"/gi)) {
    const value = m[1];
    if (/^(mailto:|tel:|data:|javascript:|#)/i.test(value)) continue;

    let href = value;
    if (/^https?:/i.test(value)) {
      /* 別人家的網址不歸這裡管；自己家的絕對網址要當成站內連結檢查 */
      let u;
      try {
        u = new URL(value);
      } catch {
        continue;
      }
      if (!ownHosts.has(u.host)) continue;
      href = u.pathname;
    }
    href = href.split('#')[0].split('?')[0];
    if (!href) continue;

    if (!href.startsWith('/')) {
      problems.push({ href: value, from, why: '相對連結。這個站一律用絕對路徑，相對路徑在分頁的網址下容易指錯。' });
      continue;
    }

    checked++;
    reached.add(decodeURIComponent(href));
    const targets = targetFiles(href);
    if (targets === null) {
      problems.push({ href: value, from, why: '網址的 percent-encoding 解不開。' });
      continue;
    }
    if (!targets.some((t) => existsSync(resolve(DIST, t)))) {
      problems.push({
        href,
        from,
        why: `對應的檔案不存在（試過 ${targets.join(' 與 ')}）—— 這個連結會 404。`,
      });
    }
  }
}

/*
 * ── 建得出來，但誰都到不了 ──────────────────────────
 *
 * 第 4 輪（第十八圈）量到：`/rss-all.xml` 有 14 筆（其中 9 筆是她的影片，
 * 也就是站上現在真正在更新的東西），**而整個 dist/ 裡 0 處指得到它**。
 * 訂閱的人只找得到 /rss.xml 的 5 篇文章。東西都在，只是讀者拿不到。
 *
 * 上面那個迴圈問的是「連結指到的檔案在不在」；這一段問的是反過來的問題。
 *
 * ## 為什麼只看 feed
 *
 * 因為只有 feed 是「靠 HTML 指過去才找得到」的產出。sitemap 走 robots.txt、
 * 搜尋索引由腳本 fetch、favicon 與 manifest 有自己的 `<link>` ——
 * 各有各的入口機制，一起要求就是第十六圈那種誤報。
 */
const feeds = [];
for await (const file of walk(DIST)) {
  const rel = relative(DIST, file);
  if (/^[^/]*(rss|feed)[^/]*\.xml$/i.test(rel)) feeds.push('/' + rel);
}
for (const feed of feeds) {
  if (reached.has(feed)) continue;
  problems.push({
    href: feed,
    from: '（沒有任何一頁）',
    why:
      '這份 feed 建出來了，但站上沒有一處指得到它 —— 訂閱的人找不到。' +
      '　改法：在 src/layouts/Base.astro 的 <head> 裡加一條 ' +
      '`<link rel="alternate" type="application/rss+xml">`（閱讀器靠這個自動發現），' +
      '需要人看得見的話再在相關頁面放一條連結。不要它的話就把 src/pages/ 底下的路由刪掉。',
  });
}

console.log('\n站內連結檢查\n' + '─'.repeat(64));
console.log(`  ${pages} 頁、${checked} 個站內連結、${feeds.length} 份 feed`);

if (pages === 0) {
  console.log('  X 一頁都沒掃到 —— dist 還沒建，或 --dir 指錯了。');
  process.exit(1);
}

if (problems.length === 0) {
  console.log('  ✓ 每一個都指到真的存在的檔案');
  /* 反過來那一問也要說出口 —— 綠燈要說清楚它在保證什麼 */
  console.log(
    feeds.length > 0
      ? `  ✓ ${feeds.length} 份 feed 都有頁面指得到（${feeds.join('、')}）\n`
      : '  · dist 裡沒有 feed，所以「沒有人指得到」那一問這次沒有檢查\n',
  );
  process.exit(0);
}

console.log(`\n  ${problems.length} 個有問題：\n`);

/*
 * ── 同一個壞網址出現在幾百頁時，收成一則 ──────────────
 *
 * 第 7 輪（第十九圈）在 600 頁下量到：`site.ts` 的頁尾清單裡**打錯一個字**，
 * 這支腳本印出 **600 筆、1819 行** —— 頁尾在每一頁上。
 * 第 1、5、6 輪已經在 a11y、privacy、copy 上各修過一次，這是第四支。
 *
 * 這裡的分組單位跟那三支不同：**同一個壞網址 = 一件事**（改一個地方就好），
 * 而**不同的壞網址 = 不同件事**（各自要改）。所以只收「出處」那一層，
 * 不收網址那一層 —— 十六個壞網址就是十六件工作，收起來會藏掉真的工作。
 */
const VERBOSE = process.argv.includes('--verbose');
/** @type {Map<string, { p: typeof problems[number], from: string[] }>} */
const byHref = new Map();
for (const p of problems) {
  const key = `${p.href}\u0000${p.why}`;
  const g = byHref.get(key) ?? { p, from: /** @type {string[]} */ ([]) };
  g.from.push(p.from);
  byHref.set(key, g);
}
for (const { p, from } of byHref.values()) {
  console.log(`  X ${p.href}`);
  for (const f of VERBOSE ? from : from.slice(0, 3)) console.log(`      來自 ${f}`);
  if (!VERBOSE && from.length > 3) {
    console.log(`      …另外 ${from.length - 3} 頁也有（--verbose 看全部）`);
  }
  console.log(`      ${p.why}`);
}
/*
 * ── 建議要看是哪一種壞法 ────────────────────────────
 *
 * 第 7 輪（第十七圈）量到：底下這段 `availableLocales` 的建議本來是
 * **無條件印**的 —— 一個內容裡打錯的連結（跟語言完全無關）也會看到它。
 * 那不只是沒用，是把人帶去查一個不相干的地方。
 *
 * 所以先看壞掉的連結長什麼樣：帶語言前綴的（`/en/⋯`）才是語言鈕那一族。
 */
const localeish = problems.some((p) => /^\/(en)(\/|$)/.test(p.href) || /hreflang/.test(p.why));
/*
 * 底下那段「拿網址去 src/ 搜」只對**壞掉的連結**成立 —— 那種問題的出處
 * 真的在 src/ 的某一行。而「沒有人指得到的 feed」沒有出處可以搜，
 * 要做的是加一條連結。無條件印就是把人帶去查一個查不到的東西。
 * 上面 `localeish` 那一段是同一個形狀（第 7 輪〔第十七圈〕修的），這裡是它的第二例。
 */
const hasBadLink = problems.some((p) => p.from !== '（沒有任何一頁）');
console.log(
  (localeish
    ? '\n  有語言前綴的那幾筆：語言鈕與 hreflang 指到不存在的頁時，' +
      '把那一頁真的有的語言用\n  `availableLocales` 傳給 Base（內容衍生的頁面只有一種語言）。\n'
    : '') +
    (hasBadLink
      ? '\n  改法：上面的路徑是 dist/ 底下的**建置產物**，連結的出處在 src/。\n' +
        '  把那個網址拿去搜，例如 grep -rn "/poems/⋯" src/；\n' +
        '  是內容裡的連結（related、正文的 markdown 連結）的話，去 src/content/ 改。\n'
      : '\n'),
);
process.exit(1);
