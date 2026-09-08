#!/usr/bin/env node
// @ts-check
/**
 * 效能預算 —— 量 dist/，超過門檻就讓檢查失敗。
 *
 *   npm run build && node scripts/check-perf.mjs
 *   node scripts/check-perf.mjs --verbose
 *
 * 這不是「讓網站更快」的工具，是「不要讓它慢下去」的工具。
 * 現在的數字很好（首頁 gzip 6.6 KB、CLS 0、零第三方請求），
 * 難的不是達到，是三年後還維持著。所以把它寫成會擋人的規則。
 *
 * 門檻都設在目前值的 1.5～2 倍：抓得到真正的回歸，又不會因為多寫幾篇文章就紅燈。
 * 每一條都寫了為什麼是這個數字 —— 以後要調整的人才知道自己在放寬什麼。
 *
 * 量的是 **gzip 之後**的大小。
 *
 * 嚴格說那不是「使用者實際下載的量」—— GitHub Pages 對支援的瀏覽器送
 * **brotli**，而 brotli 比 gzip 小一截。第 2 輪（第五圈）實測這個站：
 *
 *   HTML              小 19.5–20.2%
 *   search-index.json 小 14.4%
 *   RSS / sitemap     小 16–18%
 *   CSS               小 10–13%
 *
 * 所以這裡的數字是**保守值**：現代瀏覽器實際下載的比顯示的少約 15–20%。
 *
 * 刻意不改成量 brotli：gzip 是「有拿到壓縮的客戶端裡最差的那個」，
 * 而預算要守的是最差情況。改成 brotli 等於把每一條放寬 15–20%，
 * 卻沒有換到任何保障。輸出裡會同時印 brotli 的數字，讓人知道實際值。
 */
import { readdir, readFile } from 'node:fs/promises';
import { projectDay } from './lib/project-day.mjs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { dedupedInlineStyles } from './lib/site-css.mjs';
import { attrOf } from './lib/html-attrs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/*
 * 預設掃 dist/，`--dir=<路徑>` 可以指到別的地方。
 * 那個選項存在的唯一理由是 scripts/test-perf-budgets.mjs ——
 * 它產生「剛好超過每一條預算」的假 dist，確認每條預算真的會擋。
 */
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const DIST = dirArg ? resolve(dirArg.slice('--dir='.length)) : resolve(ROOT, 'dist');
const VERBOSE = process.argv.includes('--verbose');

/** @param {Buffer} buf */
const gz = (buf) => gzipSync(buf, { level: 9 }).length;
/** brotli 只用在「順便告訴你實際值」那一行，不參與任何預算判斷 @param {Buffer} buf */
const br = (buf) =>
  brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
/** @param {number} n */
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// ── 收集 ──────────────────────────────────────────────

/** @type {{ path: string, raw: number, gzip: number, buf: Buffer }[]} */
const files = [];
for await (const f of walk(DIST)) {
  const buf = await readFile(f);
  files.push({ path: relative(DIST, f), raw: buf.length, gzip: gz(buf), buf });
}

if (files.length === 0) {
  console.error('\ndist/ 是空的。先跑 npm run build。\n');
  process.exit(1);
}

const html = files.filter((f) => f.path.endsWith('.html'));
const css = files.filter((f) => f.path.endsWith('.css'));
const images = files.filter((f) => /\.(png|jpe?g|webp|avif|gif|ico|svg)$/.test(f.path));
const searchIndex = files.find((f) => f.path === 'search-index.json');

/*
 * ── 這些圖片裡，有幾張是頁面真的會載入的？ ──────────
 *
 * 第 2 輪（第十五圈）量到的：dist 裡有 7 個圖片檔，而**一張都不是內容圖** ——
 * 全部是 favicon、apple-touch-icon、PWA 圖示與 og:image，也就是瀏覽器外框
 * 與社群爬蟲會抓的東西。產出裡 `<img>` 標籤 **0 個**、CSS 的 `url()` **0 個**。
 *
 * 所以「圖片合計」與「最大單一檔案」這兩條現在量的是一組**不會隨內容成長
 * 的常數**。它們是綠的，但那不是「內容裡的圖片有節制」，是「還沒有內容圖」。
 * （`src/assets/` 是空的，記了好幾圈了。）
 *
 * 這一圈的問題就是這個：**綠燈是因為對，還是因為空？**
 * 第 1 輪在 `check:a11y` 補了同一件事（列出「沒有東西可看」的規則）。
 */
/** dist 裡的路徑沒有前導斜線，頁面裡的有 —— 比對前先對齊。 */
const norm = (/** @type {string} */ u) => u.trim().replace(/^\//, '').split(/[?#]/)[0];
const htmlTexts = html.map((f) => f.buf.toString('utf8'));
const referenced = new Set();
for (const text of htmlTexts) {
  for (const [tag] of text.matchAll(/<img\b[^>]*>/gi)) {
    for (const name of ['src', 'srcset']) {
      const v = attrOf(tag, name);
      // srcset 是「網址 描述子, 網址 描述子」，只要網址那一段。
      if (v) for (const part of v.split(',')) referenced.add(norm(part.trim().split(/\s+/)[0] ?? ''));
    }
  }
}
for (const text of [...htmlTexts, ...css.map((f) => f.buf.toString('utf8'))]) {
  for (const m of text.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/g)) referenced.add(norm(m[2]));
}
const rendered = images.filter((f) => referenced.has(norm(f.path)));

/** 每頁內嵌的 JavaScript（排除 JSON-LD，那是資料不是程式） */
/** @param {string} text */
function inlineScriptBodies(text) {
  return [...text.matchAll(/<script(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}
/** @param {string} text */
function inlineJsBytes(text) {
  return inlineScriptBodies(text).reduce((n, b) => n + b.length, 0);
}

/*
 * 這一頁真正會發出的請求數（不含 HTML 本身）。
 *
 * 為什麼不用 `/<img[^>]*\bsrc=/`：`\b` 會在 `-` 和 `s` 之間成立，
 * 所以 `data-src` 會被當成 `src` 數進來 —— 這個 repo 已經因為同一件事
 * 踩過兩次（`data-lang` 被讀成 `lang`）。第 2 輪（第十五圈）實測：
 * 舊寫法對 `<img data-src="/a.png">` 回報 1 個請求。
 * dist 裡目前沒有任何 `data-src`，所以它一直是**潛伏**的，量不出來。
 *
 * 順帶把 `rel="stylesheet"` 改成真的解析 rel —— `rel="stylesheet preload"`
 * 這種多值寫法舊的字串比對會漏掉。
 */
/** @param {string} text */
function requestParts(text) {
  const tagsOf = (/** @type {string} */ name) => [
    ...text.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi')),
  ].map((m) => m[0]);
  const links = tagsOf('link').filter((t) =>
    (attrOf(t, 'rel') ?? '').split(/\s+/).includes('stylesheet'),
  ).length;
  const scripts = tagsOf('script').filter((t) => attrOf(t, 'src') !== null).length;
  const imgs = tagsOf('img').filter((t) => attrOf(t, 'src') !== null).length;
  /*
   * ── 這條預算數不到的那幾種 ──────────
   *
   * 第 2 輪（第三十六圈）問「這道檢查的邊界外面是什麼、那裡有幾個」。
   * 把產出裡所有會發出請求的寫法列一次，44 頁合計：
   *
   *   算進來的：stylesheet 47、script src 0、img src 0
   *   **沒算的**：`rel="icon"` 那一類 132、`rel="manifest"` 44
   *   一個都沒有的：preload、modulepreload、preconnect、iframe、
   *                 video／audio／source、object／embed、SVG 的 `<use href>`、
   *                 CSS 裡的 `url()`、`@font-face`
   *
   * 圖示與 manifest 算不算「一次瀏覽的請求」是可以吵的
   * （瀏覽器只抓一次、而且快取很久），所以這裡**不改判準** ——
   * 但把數字說出來，不然「單頁請求數 2」讀起來像「這一頁只發 2 個請求」，
   * 而實際上每頁還有 3 個圖示連結與 1 個 manifest。
   */
  const uncountedLinks = tagsOf('link').filter((t) => {
    const rel = (attrOf(t, 'rel') ?? '').split(/\s+/);
    return (
      rel.includes('icon') ||
      rel.includes('apple-touch-icon') ||
      rel.includes('shortcut') ||
      rel.includes('manifest')
    );
  }).length;
  /*
   * ── 那句「一個都沒有」是第三十六圈的快照 ────────────────
   *
   * 第 2 輪（第四十二圈）問「這份清單是誰維護的？漏一個會怎樣？」。
   *
   * 上面那段註解把邊界列得很完整，但它是**寫死的**：`uncountedLinks`
   * （圖示與 manifest）每次跑都重算，而那九種「一個都沒有」的
   * **沒有人再數過**。今天重量，九種確實還是 0 ——
   * 而那正是問題：一個永遠對的句子跟一個沒有人在看的句子，讀起來一模一樣。
   *
   * 站上哪天放一支影片（`<video>`）、一張內容圖、或一個內嵌 iframe，
   * 這條預算就會安靜地少算 —— 而註解還會繼續說「一個都沒有」。
   */
  /*
   * ── 上面那八種全是**標記**寫的請求。JS 自己發的不在裡面 ──────────
   *
   * 第 2 輪（第五十二圈）問「名字跟它做的事一樣嗎」時量到的。
   * `requestParts()` 開頭那句寫的是「這一頁**真正會發出的請求數**」，
   * 而它數的是 stylesheet／script src／img src —— 三種都是標記宣告的。
   *
   * 站上有一個不是：`/search` 與 `/en/search` 的內嵌腳本會
   * `fetch('/search-index.json')`（gzip 5.8 KB）。**它不是每次載入都發** ——
   * 使用者打字、送出、或是**帶著 `?q=` 進站**才會。
   * 實測（本機 preview，瀏覽器的網路紀錄）：
   *
   *     /search          文件 ＋ 1 個 CSS          （沒有 JSON）
   *     /search?q=月     文件 ＋ 1 個 CSS ＋ search-index.json
   *
   * 所以它**不該**併進 `otherShapes` —— 那個清單一旦不是 0 就會印
   * 「這條預算漏數了」，而條件式的請求不是漏數，是另一種東西。
   * 它自己一行，數字每次重算（跟 `uncountedLinks` 同一個做法）。
   *
   * 只掃 `<script>` 裡面：文章正文寫到 `fetch(` 的話不算，那是在講它。
   */
  const runtimeFetch = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].reduce(
    (n, m) => n + (m[1].match(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bimport\s*\(/g) ?? []).length,
    0,
  );
  const otherShapes = {
    preload: (text.match(/<link\b[^>]*rel=["']?(?:module)?preload/gi) ?? []).length,
    preconnect: (text.match(/<link\b[^>]*rel=["']?(?:preconnect|dns-prefetch)/gi) ?? []).length,
    iframe: (text.match(/<iframe\b/gi) ?? []).length,
    media: (text.match(/<(?:video|audio|source)\b/gi) ?? []).length,
    embed: (text.match(/<(?:object|embed)\b/gi) ?? []).length,
    useHref: (text.match(/<use\b[^>]*\shref=/gi) ?? []).length,
    cssUrl: (text.match(/url\(\s*["']?(?!data:|#)/gi) ?? []).length,
    fontFace: (text.match(/@font-face/gi) ?? []).length,
  };
  return { links, scripts, imgs, uncountedLinks, runtimeFetch, otherShapes, total: links + scripts + imgs };
}

/*
 * 一次冷造訪真正要下載的量 = 這一頁的 HTML + 它必須先抓完才能畫的 CSS。
 *
 * 為什麼要另外算：下面「最大單頁 HTML」量的只有 HTML 檔本身。
 * 那個數字看起來是 74%，但使用者實際上還要再抓一份阻塞渲染的樣式表，
 * 加起來已經逼近上限 —— **關卡會在頁面早就變重之後才發現**。
 * 兩個數字都要有：HTML 那條看得出「這一頁塞了什麼」，
 * 這一條看得出「使用者要等多久才看得到字」。
 */
/** @param {string} text */
function criticalPathBytes(text) {
  let total = 0;
  for (const m of text.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)) {
    const asset = files.find((f) => f.path === m[1].replace(/^\//, ''));
    if (asset) total += asset.gzip;
  }
  return total;
}

/**
 * 這一頁的 CSP 裡列了幾個 SHA-256 雜湊。
 *
 * 為什麼要量它：`inlineStylesheets` 要不要從 `auto` 換成 `never`，
 * 第 2 輪（第三圈）把觸發條件從「重跑整套實驗」簡化成「數雜湊」——
 * 一個雜湊約 43 B（隨機字串，gzip 幾乎壓不動），而首頁 `auto` 的領先
 * 是 294 B，所以再多 7 個就翻轉。
 *
 * **但那個數字一直沒有真的被量。** 第 2 輪（第六圈）查的時候發現
 * 紀錄裡寫的「`check:perf` 的輸出裡看得到」並不成立：輸出裡的 34
 * 是說明文字裡寫死的字串，而當時實際已經是 35。
 * 一個「看起來是量測、其實是註解」的數字，正是這個 repo 反覆踩到的東西。
 *
 * ── 2026-09-07：那兩個數字第一次真的被量了 ──────────
 *
 * 第 2 輪（第五十圈）照著上面那句推導重走一次（那一圈問「照著文件做，
 * 做得完嗎」）：
 *
 *   一個雜湊值多少　把首頁 CSP 裡的一個雜湊拿掉再 gzip：10752 → 10711
 *                   ＝ **41 B**（上面寫 43）
 *   auto 的領先　　 首頁關鍵路徑（HTML gzip ＋ 它引用的 CSS gzip）：
 *                   auto 10752＋3736 ＝ 14488、never 8105＋6706 ＝ 14811
 *                   ＝ **323 B**（上面寫 294）
 *
 * 照這兩個新數字算：323 ÷ 41 ≈ **7.9 個**，也就是 35 ＋ 7.9 ≈ 42.9 才翻轉。
 * 上限訂在 41 **仍然在安全側**（比真的翻轉點早兩個雜湊），所以沒有動它。
 * 上面那兩個舊數字留著不改 —— 它們記的是當初怎麼推的。
 *
 * @param {string} text
 */
function cspHashCount(text) {
  const meta = /<meta[^>]*http-equiv="content-security-policy"[^>]*>/i.exec(text);
  if (!meta) return 0;
  const content = /content="([^"]*)"/i.exec(meta[0]);
  return content ? [...content[1].matchAll(/'sha256-/g)].length : 0;
}

const pageStats = html.map((f) => {
  const text = f.buf.toString('utf8');
  return {
    ...f,
    inlineJs: inlineJsBytes(text),
    requests: requestParts(text),
    critical: f.gzip + criticalPathBytes(text),
    cspHashes: cspHashCount(text),
  };
});

const worstHashes = pageStats.reduce((a, b) => (b.cspHashes > a.cspHashes ? b : a));

/**
 * 這條預算的上限。提成常數是因為 `limit` 與 `why` 裡的「還剩幾個」
 * 都要用它 —— 寫兩次遲早會分岔（這個 repo 記過很多次的同一件事）。
 */
const CSP_HASH_LIMIT = 41;

const worstCritical = pageStats.reduce((a, b) => (b.critical > a.critical ? b : a));

const worstPage = pageStats.reduce((a, b) => (b.gzip > a.gzip ? b : a));
const worstJs = pageStats.reduce((a, b) => (b.inlineJs > a.inlineJs ? b : a));
/*
 * 搜尋頁的 JS 本來就比別頁多一大截，混在一起算會讓門檻失去意義：
 * 要嘛設得太寬（放過真正的回歸），要嘛卡在 96% 每次都快紅燈。所以分開量。
 */
const ordinaryPages = pageStats.filter((p) => !/(^|\/)search\//.test(p.path));
/*
 * 種子必須是「空的一般頁面」，不能是 `pageStats[0]` ——
 * 那一筆**含搜尋頁**，於是它會參與比較：
 *
 *   - 沒有任何一般頁面時，這條預算量到的就是搜尋頁
 *   - 就算有，只要 `pageStats[0]` 剛好是搜尋頁而且 JS 比每個一般頁都多，
 *     reduce 會把它留下來 —— 而 dist 的走訪順序不保證
 *
 * 第 2 輪（第九圈）量「每個測試案例實際擋下哪幾條預算」時撞到：
 * 「最大單頁內嵌 JS」的 fixture 只放了 `search/index.html`，
 * 而「一般頁面內嵌 JS」也跟著響了 —— 那條明明該把 search 排除掉。
 *
 * 空集合的正確答案是 0，不是「隨便哪一頁」。
 * （同一支腳本的 `biggestAsset` 早就用這個寫法處理空集合了。）
 */
const worstOrdinaryJs = ordinaryPages.reduce(
  (a, b) => (b.inlineJs > a.inlineJs ? b : a),
  /** @type {typeof pageStats[number]} */ (
    /** @type {unknown} */ ({ path: '（沒有一般頁面）', inlineJs: 0 })
  ),
);
const worstReq = pageStats.reduce((a, b) => (b.requests.total > a.requests.total ? b : a));
/*
 * 「最大單一檔案」要排除已經有專屬預算的檔案。
 * 搜尋索引是按 gzip 量的（它是純文字，壓縮率極高），如果又被這條按原始大小
 * 算一次，會出現「搜尋索引 gzip 13 KB 通過、同一個檔案 raw 245 KB 不通過」
 * 這種自相矛盾的結果 —— 300 篇的規模測試就踩到了。
 */
/*
 * 有自己專屬預算的檔案，不參加「最大單一檔案」的比較。
 *
 * 為什麼要有這份名單：「最大單一檔案」按 **raw** 大小算，因為它防的是
 * 「有人塞了一張沒壓過的圖」—— 而圖片本來就壓不動，raw 就是實際下載量。
 * 但純文字檔（JSON、XML）壓縮率極高，用同一把尺會得出自相矛盾的結論：
 * 同一個檔案「gzip 13 KB 通過、raw 245 KB 不通過」。
 * 第 3 輪（第一圈）在搜尋索引上踩過，第 2 輪（第三圈）在 RSS 上又踩一次。
 *
 * 判準：**這個檔案的實際下載量是 gzip 後的量嗎？** 是的話就給它 gzip 預算。
 */
/*
 * 只有**真的有專屬預算**的檔案能列在這裡。
 *
 * 第 2 輪（第十六圈）踩過一次：把 rss.xml／rss-all.xml 留在這份名單裡，
 * 而它們其實沒有自己的預算 —— 於是新的「最大的文字資源」把它們排除掉，
 * 「最大單一檔案」又因為它們是文字而不收，**兩邊都不管了**。
 * 測試當場紅（那條預算的案例擋不下來），才發現我一邊修誤報一邊開了個洞。
 */
const OWN_BUDGET = new Set(['search-index.json']);
/*
 * sitemap 的檔名有 Astro 產生的編號（sitemap-0.xml、sitemap-index.xml），
 * 所以用樣式比對而不是逐一列名。
 *
 * 第 3 輪（第三圈）在 1,000 篇的規模測試裡撞到：sitemap-0.xml 78.8 KB
 * 破了「最大單一檔案」。這是**上一輪剛處理過的同一類問題** ——
 * 我當時寫了判準卻只套用到 RSS，沒想到 sitemap 也是 XML。
 * 它的壓縮率 8.7:1，跟圖片完全是兩回事。
 */
/*
 * ── 用「是不是純文字」分類，而不是逐一列檔名 ──────────
 *
 * 上面那份名單已經補過三次（搜尋索引 → RSS → sitemap），每一次都是
 * 同一個錯：**純文字檔被拿「量圖片的 raw 尺」去量**。
 * 第 2 輪（第十六圈）的誤報探針又抓到第四、第五次：
 *
 *   · 多一份 `rss-poems.xml`（100 KB 原始、壓完約 5 KB）→ 被「最大單一檔案」擋
 *   · 多一份 `llms.txt`（80 KB 原始、壓完更小）→ 同上
 *
 * 兩份都不是效能問題，使用者下載的是壓縮後的量。名單永遠追不上 ——
 * 所以改成問這個檔案的性質：**純文字的走 gzip 預算，二進位的走 raw**。
 * （判準本來就寫在上面：「這個檔案的實際下載量是 gzip 後的量嗎？」）
 */
/*
 * **第 2 輪（第四十三圈）：副檔名清單也是一份人挑的清單。**
 *
 * 上面那段說「改成問這個檔案的性質」，但實際問的是副檔名 ——
 * `TEXT_EXT` 有九個，而清單外的純文字檔會被當成二進位資源。
 * 實測一份 `feed.rss`（104 KB 原始、gzip 約 5 KB，`.rss` 不在清單裡）：
 *
 *     X 最大單一檔案　103.9 KB / 上限 60.0 KB　173%
 *       改法：⋯圖片改 WebP／AVIF，或把解析度降到實際顯示的尺寸
 *     這次少了 2 條預算：最大的文字資源（gzip）—— dist 裡沒有純文字資源可量
 *
 * 那正是這段註解在講的第六、第七次同一個錯，只是換了副檔名
 * （`.atom`、`.rss`、`.md` 都不在清單裡，而 `.xml`、`.txt` 在）。
 *
 * 現在問**檔案的位元組**：沒有 NUL 而且整份解得開 UTF-8 的就是純文字。
 * 這裡沒有清單可以漏 —— PNG／ICO／字型的位元組本來就不是合法的 UTF-8。
 *
 * ── 第 2 輪（第四十五圈）去線上量了那個前提 ──────────
 *
 * 這個判準假設「是純文字 → 伺服器會壓 → 用 gzip 尺量才對」。
 * 那一輪那條待辦寫的是「GitHub Pages 會不會壓 `.atom`／`.rss` 沒有人量過」，
 * 所以把站上**每一種**出貨的文字型別都打了一次（帶 `accept-encoding: gzip`）：
 *
 *   .xml  .txt  .json  .webmanifest  .svg  .css   → 全部 `content-encoding: gzip` ✓
 *   CNAME（沒有副檔名）                            → **沒有壓**，14 bytes 原樣送
 *
 * 差別不在「是不是文字」，在 **content-type**：`CNAME` 沒有副檔名，
 * GitHub Pages 送的是 `application/octet-stream`，而它不壓那個型別。
 *
 * 也就是說位元組判準答的是「這個檔案是不是文字」，而伺服器問的是
 * 「它的副檔名對到哪個型別」。**今天唯一對不上的是 `CNAME`，14 bytes** ——
 * 它永遠不會是「最大的文字資源」，所以不影響任何一條預算。
 * （`.atom`／`.rss` 仍然沒量到 —— 站上沒有那兩種檔案。）
 */
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
/** @param {Buffer} buf */
const isTextLike = (buf) => {
  if (buf.includes(0)) return false;
  try {
    utf8Strict.decode(buf);
    return true;
  } catch {
    return false;
  }
};
/*
 * 沒有任何非 HTML 資源時，這裡本來會 `reduce of empty array` 直接崩潰 ——
 * 而崩潰跟「檢查通過」在 CI 上長得不一樣，但在**只看有沒有紅字**的人眼裡
 * 很容易混過去（它連預算表都印不出來）。
 * 第 2 輪（第四圈）寫預算的實測時撞到的：假 dist 裡只放了一頁 HTML。
 */
const assets = files.filter((f) => !f.path.endsWith('.html') && !isTextLike(f.buf));
const biggestAsset = assets.length
  ? assets.reduce((a, b) => (b.raw > a.raw ? b : a))
  : { path: '（沒有非 HTML 的資源）', raw: 0, gzip: 0 };

/*
 * ── 全站的 CSS 有兩半，而這條預算原本只數了一半 ──
 *
 * `inlineStylesheets: auto` 會把夠小的樣式**內嵌進 HTML**，
 * 所以 `dist/**.css` 只是外部那一半。第 2 輪（第八圈）實測：
 *
 *   外部 .css 檔      2 個，gzip 5.2 KB   ← 原本這條預算量的
 *   內嵌 <style>      16 種不重複，gzip 3.7 KB   ← **完全沒算**
 *
 * 內嵌的 raw 是外部的 167%。而這條預算存在的理由是
 * 「CSS 應該一直很小，翻倍就該回頭看是不是有重複的規則」——
 * 偏偏**新增一個帶 scoped style 的元件時 Astro 會把它內嵌，
 * 這條預算一動也不動**。它偵測不到它存在要偵測的成長。
 *
 * 內嵌的部分按「不重複的區塊」算一次，跟外部檔案的算法一致 ——
 * 這條量的是「這個站有多少 CSS」，不是「使用者下載了幾次」
 * （後者是「最大單頁 HTML」與「首次造訪關鍵路徑」在守的）。
 */
/* 取內嵌區塊的做法抽進 lib/site-css.mjs 了 —— check:a11y 也要用同一份 */
const inlineStyles = dedupedInlineStyles(html.map((f) => f.buf.toString('utf8')));
const inlineCssGzip = inlineStyles.length ? gz(Buffer.from(inlineStyles.join(''), 'utf8')) : 0;
const totalCssGzip = css.reduce((n, f) => n + f.gzip, 0) + inlineCssGzip;
const totalImages = images.reduce((n, f) => n + f.raw, 0);

// ── 預算 ──────────────────────────────────────────────

const budgets = [
  {
    label: '最大單頁 HTML（gzip）',
    basis:
      '挑的：第 2 輪（第一圈）訂的，當時現值 6.7 KB —— 2.1 倍。**沒有推導。** 後來有人拿 TCP 初始壅塞視窗替這個 14 背書，而第 2 輪（第二十八圈）實測推翻了那個框架（見下一條的 ⚠）—— 推翻只套用在下一條上，這個 14 沒有跟著重訂。',
    subjects: pageStats.length,
    fix: '先量 CSP 雜湊佔了多少（下面「CSP 雜湊數」那條有數字），再看內容 —— 這條的成長主因一直是雜湊，不是文字。',
    value: worstPage.gzip,
    limit: 14 * 1024,
    detail: worstPage.path,
    why:
      '只量 HTML 檔本身，不含它要抓的 CSS —— 使用者的實際下載量看下面那一條。' +
      '第 2 輪時是 6.6 KB，現在約 10.4 KB，成長的**主因不是內容**：' +
      'CSP 的 meta 標籤佔了 gzip 後的 1.6 KB（首頁的 15.5%）。' +
      '那些雜湊是隨機字串，gzip 幾乎壓不動（壓縮比 0.77）。' +
      '而且 Astro 放進每一頁的雜湊**幾乎都是別頁的**（見 plugin-manifest.js）：' +
      '第 2 輪（第六圈）實測首頁列了 35 個，只有 3 個是這一頁自己的內嵌內容算得出來的。' +
      '（不是「全站聯集」—— 那句話被引用了四圈但不成立，實際是 11 種略有差異的集合、' +
      '每頁 34–36 個。確切數字看下面「CSP 雜湊數」那一條，那是量出來的。）' +
      '這條再逼近上限時，先量雜湊佔多少，不要直接怪內容。',
  },
  {
    label: '首次造訪關鍵路徑（gzip）',
    basis:
      '推導：訂的時候現值是 13.9 KB，取 1.5 倍。（這個 13.9 記的是**當時**，不是現在 —— 現在的值報告每次都會印。）',
    subjects: pageStats.length,
    fix: '已經越過 14 KB 那個門檻了，只能守住不再長：看上面兩條（HTML 本身、全站 CSS）哪一邊在長。',
    value: worstCritical.critical,
    limit: 21 * 1024,
    detail: `${worstCritical.path}（HTML ${kb(worstCritical.gzip)} + 阻塞的 CSS）`,
    why:
      '這才是「使用者要等多久才看得到字」的數字：HTML 加上必須先抓完的樣式表。' +
      '目前最重的一頁約 14.2 KB（本機 level 9）。上限取現值的 1.5 倍。' +
      '\n      ⚠ 這條原本寫「14 KB 附近有個實際意義 —— TCP 初始壅塞視窗大約就是那麼大，' +
      '超過就要多一個來回；已經越過了」。第 2 輪（第二十八圈）站上線之後量真的，' +
      '**那個框架用錯了**：實際送出 HTML 10655 B ＋ CSS 3731 B ＝ 14386 B，' +
      '比常見的 initcwnd（10×1460＝14600 B）還少 214 B —— 但那不是重點。' +
      '重點是**兩者從來不在同一趟裡**：CSS 是普通的 <link rel="stylesheet">，' +
      '沒有 preload、GitHub Pages 也不送 Early Hints（2026-09-05 實測只有一行 HTTP/2 200），' +
      '所以它一定是第二趟，跟大小無關。HTML 自己 10.4 KB 就穩穩在第一趟裡。' +
      '\n      也就是說：**在這個總和上省位元組，不會少掉任何一個來回。** ' +
      '真要少一趟得動請求結構（把 CSS 內嵌、或加 preload），不是減肥。' +
      '這條仍然有用 —— 它守的是「不要繼續往上長」，只是理由不是那個來回。' +
      '要重量送出的位元組：npm run probe:served。',
  },
  {
    label: '全站 CSS 合計（gzip）',
    basis:
      '挑的：當時現值 5.1 KB —— 2.7 倍。沒有記下為什麼是 14。',
    subjects: css.length,
    fix: '回頭找重複的規則。這個站沒有 UI 框架，CSS 不該長這麼快；--verbose 看得到內嵌與外部各佔多少。',
    value: totalCssGzip,
    limit: 14 * 1024,
    detail: `${css.length} 個檔案 ＋ ${inlineStyles.length} 種內嵌`,
    why:
      '外部檔案與內嵌 <style> 都算（第 2 輪〔第八圈〕之前只算外部，' +
      '而內嵌的 raw 是外部的 167% —— 加一個帶 scoped style 的元件時，' +
      'Astro 會內嵌它，這條預算原本一動也不動）。' +
      '這個站沒有 UI 框架，CSS 應該一直很小；翻倍就該回頭看是不是有重複的規則。',
  },
  {
    label: '一般頁面內嵌 JS',
    basis:
      '推導：訂的時候現值是 2.0 KB，取 1.5 倍。（同上，13.9 那條也是 —— 這幾個數字都是歷史。）',
    subjects: pageStats.length,
    fix: '把那段 JS 從共用版面移到真的需要它的那一頁 —— 每一段都要是「關掉也能用」的增強功能。',
    value: worstOrdinaryJs.inlineJs,
    limit: 3 * 1024,
    detail: worstOrdinaryJs.path,
    why:
      '不含 /search 的所有頁面（那幾段是主題切換、語言下拉、詩詞排版）。' +
      '這個站的立場是「零 JS 起步」，每一段都要是關掉也能用的增強功能。' +
      '這一條守的是「不要讓 JS 悄悄長到每一頁上」。',
  },
  {
    label: '最大單頁內嵌 JS',
    basis:
      '推導：訂的時候現值是 3.8 KB，取 1.5 倍後取整到 6。（這個 3.8 記的是**當時**，不是現在 —— 現在的值報告每次都會印。）',
    subjects: pageStats.length,
    fix: '把搜尋那段程式碼抽成獨立檔案，不要繼續內嵌。',
    value: worstJs.inlineJs,
    limit: 6 * 1024,
    detail: worstJs.path,
    why:
      '搜尋頁比較特別 —— 它多了一整套比對、排序與摘要標示的邏輯。' +
      '那段只內嵌在 /search 上，不會影響其他頁面，所以給它比較寬的額度。' +
      '真的超過 6 KB 的話，那段程式碼應該抽成獨立檔案而不是繼續內嵌。',
  },
  {
    label: '單頁請求數（不含 HTML）',
    basis:
      '挑的：現值 2 的兩倍。沒有記下為什麼是 4。',
    subjects: pageStats.length,
    fix: '先確認多出來的是不是第三方（那是硬性限制，不能有）。是自家資源的話，考慮合併或內嵌。',
    value: worstReq.requests.total,
    limit: 4,
    detail: worstReq.path,
    unit: 'count',
    why:
      '目前最多 2 個（都是 CSS）。零第三方請求是硬性限制，這條同時也在守那件事。' +
      '第 2 輪（第六圈）用瀏覽器的 Resource Timing 對過一次：詩詞頁實際發 2 個請求、' +
      '都是 CSS、第三方 0 個，跟這裡靜態算出來的一致。',
  },
  {
    /*
     * 這一條不是「多了會慢」，是**一個會自己響的決策提醒**。
     *
     * Astro 把幾乎整站的內嵌樣式雜湊放進每一頁的 CSP（見 plugin-manifest.js）。
     * 雜湊是隨機字串、gzip 壓不動，所以每多一種不重複的內嵌樣式區塊，
     * 每一頁就固定變重約 43 bytes。
     *
     * 第 2 輪（第三圈）算出首頁 `auto` 比 `never` 領先 294 B，
     * 也就是**再多 7 個雜湊（35 → 42）就該把 inlineStylesheets 換成 `never`**。
     * 上限設 41，就是讓這件事在該做的時候自己紅燈，而不是靠人記得去數。
     *
     * ── 這條預算是**全站共用**的，而花掉它的決定是**局部**的 ──────────
     *
     * 第 2 輪（第五十三圈）問「動這一處會牽動哪些地方」，實測了一次：
     * 在 `src/pages/[...locale]/privacy.astro`（只產生 2 頁、原本沒有
     * `<style>`）加**一個** `<style>` 區塊，重新建置 ——
     *
     *   每頁雜湊數   34/35/36 → **35/36/37**（44 頁**每一頁**都 +1）
     *   單頁最大     36 → 37，這條預算 88% → **90%**
     *   全站 HTML    gzip 合計 295,532 → 297,345 B（**+1,813 B**）
     *
     * 1,813 ÷ 44 ≈ 41 B／頁，跟第 2 輪（第五十圈）量到的「一個雜湊 41 B」對得上。
     *
     * 也就是說：**一個只用在兩頁的樣式，帳是 44 頁一起付的**，
     * 而付帳的那條預算是全站最接近上限的一條。
     * 加元件的人看不到這件事 —— 所以 `why` 裡把「還剩幾個」算出來說。
     * （量的是 `<style>`；內嵌 `<script>` 同一個機制，這一輪沒有另外量。）
     */
    label: 'CSP 雜湊數（單頁最多）',
    basis:
      '推導：一個雜湊約 43 B，而 auto 比 never 只領先 294 B —— 42 個就該換手，所以上限取 41。',
    subjects: pageStats.length,
    fix: '把 astro.config 的 inlineStylesheets 改成 never —— 這條紅燈就是那個時候到了。',
    value: worstHashes.cspHashes,
    limit: CSP_HASH_LIMIT,
    detail: worstHashes.path,
    unit: 'count',
    why:
      '一個雜湊約 43 B（gzip 幾乎壓不動），而首頁 auto 比 never 只領先 294 B。' +
      '到 42 個就該把 astro.config 的 inlineStylesheets 改成 never —— ' +
      '這條紅燈就是那個時候到了。第 2 輪（第六圈）實測：' +
      '每頁 34–36 個、全站聯集 44 個，**不是每頁都一樣**，所以取單頁最大值。' +
      `　**這條預算是全站共用的**：在任何一個元件或頁面加一個內嵌 <style>，` +
      `${pageStats.length} 頁**每一頁**的雜湊數都會 +1（第 2 輪〔第五十三圈〕實測，見原始碼註解）。` +
      `照現在的值算，還剩 **${CSP_HASH_LIMIT - worstHashes.cspHashes} 個**。`,
  },
  {
    label: '最大單一檔案',
    basis:
      '挑的：當時最大 24.9 KB —— 2.4 倍。沒有記下為什麼是 60。',
    subjects: assets.length,
    /*
     * ── 觸發的是不是 Astro 產的圖，建議完全不同 ──────────
     *
     * 第 2 輪（第二十圈）第一次讓 `cover` 真的有圖（`src/assets/` 一直是空的）。
     * 一張 1600×900 的照片進來，這一條就紅了 —— 而原本的建議是
     * 「圖片改 WebP／AVIF，或把解析度降到實際顯示的尺寸」。
     *
     * **那兩件事都已經做了**：觸發的檔案是 `_astro/⋯.webp`，
     * 是 `CoverImage` 用 `<Image>` 產的，解析度是元件的 `densities` 決定的。
     * 她照著做不到，而且那個路徑是建置產物、改不得 ——
     * 第十七圈整整一圈在修的就是這種訊息。
     *
     * 實測的數字（1600×900 的細節照片，**當時的 `densities={[1,2]}`**）：
     *   quality 82 → 1x 39.6 KB、**2x 272.9 KB**
     *   quality 50 → 1x  4.9 KB、**2x  94.1 KB**
     * 也就是說**光調品質救不回來，主因是最寬的那一張**。
     *
     * ── 那句建議過期了 ──────────────────────────
     *
     * 第 2 輪（第四十圈）發現的。`CoverImage` **早就不用 `densities` 了** ——
     * 同一圈（第二十圈）稍後就改成 `widths` ＋ `sizes`，元件自己的註解
     * 第 16 行寫著「用 `widths` ＋ `sizes`，不用 `densities`」。
     * 而這裡的建議還在叫人去改一個**不存在的 prop**，
     * 括號裡那句「現在是 1x ＋ 2x」也早就不是現在。
     *
     * 沒有人發現，是因為這句話**在站上一次都沒有印過** ——
     * 它要「最大單一檔案」超標而且觸發的是 `_astro/*.webp` 才會出現，
     * 而站上到今天 0 張內容圖。它唯一跑過的地方是測試，
     * 而測試斷言的是「訊息裡有 densities」—— 把過期的說法鎖住了。
     *
     * 現在的槓桿是 `widths`（最寬的是 1600w）。上面那組數字保留，
     * 但標明是舊設定下量的 —— 換算不過來的東西不要假裝換算得過來。
     */
    fix:
      biggestAsset.path.startsWith('_astro/') && /\.(webp|avif|jpe?g|png)$/i.test(biggestAsset.path)
        ? '這是 Astro 從 src/assets/ 產的圖，**已經是 WebP、解析度也是元件決定的** —— ' +
          '改不動那個檔案。兩條路：把來源圖匯出得小一點（或裁窄一點），' +
          '或者改 CoverImage.astro 的 widths（現在最寬的是 1600w，那一張就是最大的）。' +
          '參考：第二十圈在舊設定（densities 1x＋2x）下量過 1600×900 的細節照片，' +
          'quality 82 的 2x 是 273 KB，降到 50 也還有 94 KB —— 光調品質救不回來，主因是寬度。'
        : 'detail 那一行就是實際觸發的檔案。先問它能不能壓：圖片改 WebP／AVIF，或把解析度降到實際顯示的尺寸。',
    value: biggestAsset.raw,
    limit: 60 * 1024,
    /*
     * ── 「最大單一檔案」其實不含 HTML 與文字資源 ──────────
     *
     * 第 2 輪（第三十五圈）用第二種算法查 dist 裡真正最大的檔案，
     * 得到 `index.html` 35.2 KB，而這一條說 24.9 KB —— 差的不是數字，是**範圍**：
     * `assets` 濾掉了 HTML 與 text-like（那兩類各有自己的預算：
     * 「最大單頁 HTML」與「最大的文字資源」）。
     *
     * 三條加起來確實蓋得住，但**這一條的名字比它量的東西大**。
     * 拿 `ls -S dist` 對照的人會以為它算錯了 —— 我就是那樣以為的。
     * 名字有十幾處註解與歷史紀錄在引用，不改名；改成讓 detail 把範圍說出來。
     */
    detail: `${biggestAsset.path}（只比非 HTML、非文字的資源 —— 那兩類各有自己的預算）`,
    why:
      '不含 HTML 與搜尋索引（那兩個有自己的預算）。目前最大的是 og/default.png，24.9 KB。' +
      '超過 60 KB 的靜態資源該先問是不是能壓 —— 上面 detail 那一行就是實際觸發的檔案。',
  },
  {
    label: '圖片合計',
    basis:
      '挑的：當時 42.9 KB —— 7.0 倍，而那 42.9 KB 沒有一張是頁面會載入的。沒有記下為什麼是 300。',
    subjects: images.length,
    fix: '--verbose 會列出最大的幾個檔案。能壓就壓、能改 WebP／AVIF 就改；真的每一張都需要，再談調高門檻。',
    value: totalImages,
    limit: 300 * 1024,
    detail: `${images.length} 個檔案，其中頁面真的會載入的 ${rendered.length} 個`,
    why: '之後有文章配圖會長，但 300 KB 之內都還算克制。',
  },
];

/*
 * 純文字資源（feed、sitemap、CSS、robots.txt、webmanifest⋯⋯）統一按 gzip 量。
 * 有自己專屬預算的那幾個（搜尋索引）不重複算。
 */
/*
 * `.html` 要排掉：它自己有兩條預算（最大單頁、首次造訪），而位元組判準
 * 會把它算成純文字。改成問位元組的那一次就是這樣才被抓到的 ——
 * 「共 54 個文字檔」、最大的文字資源變成 index.html，
 * 而說明裡寫的現值對不上，`check:perf` 自己那一格紅了。
 */
const textFiles = files.filter(
  (f) => !f.path.endsWith('.html') && isTextLike(f.buf) && !OWN_BUDGET.has(f.path),
);
/*
 * ── 整條不見的預算，跟「全部在預算內」長得一樣 ──────────
 *
 * 這兩條是**有條件才加進來**的：沒有純文字資源就沒有那一條，
 * 沒有 `search-index.json` 就沒有那一條。
 *
 * 第 2 輪（第二十一圈）實測：把 `dist/search-index.json` 刪掉再跑，
 * 十一條變十條、結尾照樣印「全部在預算內」，**沒有任何一個字提到少了一條**。
 * 而那正是站內搜尋整個壞掉時的樣子（索引是 JS 抓的，`check:links`
 * 掃不到 `<script>` 裡的網址，所以也不會有人說話）。
 *
 * 第十五圈的判準是「綠得因為空要說出來」；這裡是它的上一層：
 * **綠得因為那條檢查根本不在**。一樣要說出來。
 */
/** @type {string[]} */
const skipped = [];

if (textFiles.length > 0) {
  const biggestFeed = textFiles.reduce((a, b) => (b.gzip > a.gzip ? b : a));
  budgets.push({
    label: '最大的文字資源（gzip）',
    basis:
      '推導：feed 的筆數有上限，滿載時推估 gzip 約 27 KB，留一點餘裕到 40。',
    subjects: textFiles.length,
    fix: '先看是哪一種：有人把 feed 的筆數上限拿掉了，還是單筆變肥了。不要直接調高門檻。',
    value: biggestFeed.gzip,
    limit: 40 * 1024,
    detail: `${biggestFeed.path}，未壓縮 ${kb(biggestFeed.raw)}（共 ${textFiles.length} 個文字檔）`,
    why:
      'feed、sitemap、CSS、robots.txt⋯⋯凡是純文字的都算在這裡 —— 它們壓縮率 3–13:1，' +
      '用「最大單一檔案」那把量圖片的 raw 尺去量會得到沒有意義的結論。' +
      'rss-all.xml 目前 14 筆、gzip 3.8 KB。feed 的筆數**有上限**（rss-all.xml.ts 的 ' +
      'slice(0, 100)、rss.xml 的 limit: 60），所以檔案不會無限長大 —— ' +
      '滿載時推估 gzip 約 27 KB。' +
      '這條線設在 40 KB，抓的是兩種情況：有人把上限拿掉了，' +
      '或者單筆變得很肥（現在單筆 678 bytes，其中描述佔 45%、標題佔 28%）。' +
      '碰到時先看是哪一種，不要直接調高門檻。',
  });
} else {
  skipped.push('最大的文字資源（gzip）—— dist 裡沒有純文字資源可量（feed、sitemap、CSS⋯）。');
}

if (searchIndex) {
  budgets.push({
    label: '搜尋索引（gzip）',
    basis:
      '推導：平均每筆 426 B（gzip），60 KB 約 144 筆。',
    subjects: 1,
    fix: '不要只是調高門檻，選一個：(a) 索引分片載入、(b) 縮短 search-index.json.ts 的 600 字摘要、(c) 影片只收標題不收描述。',
    value: searchIndex.gzip,
    limit: 60 * 1024,
    detail: `${searchIndex.path}，未壓縮 ${kb(searchIndex.raw)}`,
    why:
      '目前 14 筆約 5.8 KB，平均每筆 426 bytes（gzip），所以 60 KB 大約是 **144 筆**。' +
      '重點是這個索引**不需要任何人寫東西就會自己長**：14 筆裡有 9 筆是 ' +
      'sync-feeds 抓進來的 YouTube 影片。頻道目前是停更的（最後一支 2024-10-26），' +
      '所以短期內不會動；但一旦重新開始發，這條線會自己往上走，' +
      '而不是因為站主寫多了。碰到時不要只是調高門檻，選一個：' +
      '(a) 索引改成分片載入、(b) 縮短 search-index.json.ts 的 600 字摘要、' +
      '(c) 影片只收標題不收描述（影片的描述本來就不是可搜尋的正文）。',
  });
} else {
  skipped.push(
    '搜尋索引（gzip）—— dist 裡找不到 search-index.json。\n' +
      '      那個檔案是站內搜尋的全部，少了它搜尋就是壞的 ——\n' +
      '      而它是 JS 抓的，check:links 掃不到，所以只有這裡看得到。',
  );
}

// ── 輸出 ──────────────────────────────────────────────

/*
 * ── 說明裡寫的數字，跟現在量到的一樣嗎 ────────────────
 *
 * 每一條預算的 `why` 裡都會提到當時的實際值（「現在約 10.4 KB」）。
 * 那是**同一個事實的第二份說法** —— 而報告本身每次都會印出真的值。
 * 兩份不一致的時候，讀的人會相信寫在文字裡的那一份，因為它讀起來像結論。
 *
 * 第 2 輪（第二十四圈）逐條比對，七條有這種句子的預算裡：
 *
 *   最大單頁 HTML　　　10.4 → 10.5　　差 1%
 *   首次造訪關鍵路徑　 14.2 → 14.1　　差 1%
 *   **一般頁面內嵌 JS　 1.5 → 2.3　　 差 35%**
 *   最大單頁內嵌 JS　　 3.8 → 4.0　　 差 5%
 *   **圖片合計　　　　　68 → 42.9　　 差 59%**
 *   最大的文字資源　　  3.8 → 3.7　　 差 3%
 *   搜尋索引　　　　　  5.8 → 5.8　　 差 0%
 *
 * 兩條差了三成與六成 —— 那兩句（純粹只是數字的）拿掉了，
 * 剩下五條的數字帶著說理（「成長的主因不是內容」），留著有用。
 *
 * 這一條讓它們不能再安靜地漂走：差超過 10% 就擋下來。
 * 第十九圈的結論是「寫死的數字會過期」，那時只能靠人記得回來看；
 * 現在是這支腳本自己拿自己的說明去對自己量到的值。
 */
const DRIFT_LIMIT = 0.1;
/** 說明裡過期的數字有幾個 —— 跟超標分開算，但一樣會擋 */
let staleDocs = 0;
/*
 * **只在量真的 dist 的時候比。**
 *
 * 那些數字說的是「這個站現在多大」，拿去跟測試用的假站比沒有意義 ——
 * 假站只有一頁小 HTML，每一條都會差九成。第 2 輪（第二十四圈）第一版
 * 沒有這道條件，結果 `test-perf-budgets` 一次紅了 18 格。
 */
/*
 * ── 四支腳本都把 `inlineStylesheets: 'auto'` 當前提，而沒有人在比 ────
 *
 * 第 2 輪（第四十六圈）問「這一段如果拿掉，輸出會差在哪裡」，
 * 把建置層的設定一個一個換掉再量：
 *
 *     never   最大單頁 HTML（gzip）10.5 → 7.9 KB，但 stylesheet 連結 47 → 205
 *             （平均每頁 4.7 個）—— 單頁請求數那條預算會紅
 *     always  最大單頁 HTML（gzip）10.5 → 13.9 KB —— 那是上限 14.0 KB 的 **99%**，
 *             真的預算**沒有紅**，紅的只有「說明裡的數字過期」那一條
 *
 * 也就是說換掉它會被發現，但發現它的是一條**講文件的**檢查。
 * 而更安靜的是另一件事：`audit-privacy`、`check-a11y`、`check-content`、
 * `check-perf` 四支的註解都寫著「這個站的樣式是內嵌的（`auto`）」，
 * 而它們的**掃描範圍就是照那句話決定的**（要不要連 HTML 裡的 `<style>`
 * 一起讀）。設定改掉的話，那四支會安靜地少看或多看一整類東西。
 *
 * 判準不寫死 `'auto'` —— 去問那四支腳本自己的註解怎麼寫，
 * 跟 `astro.config.mjs` 真正的值比。抽不到就說「沒有比對」，不安靜放行。
 *
 * 跟旁邊那幾條「說明裡的數字」一樣只在量真的 dist 的時候跑：
 * 這問的是這個 repo 自己的一致性，拿測試的假 dist 來跑只會多印一行。
 */
if (!process.argv.some((a) => a.startsWith('--dir='))) {
  const cfg = await readFile(resolve(ROOT, 'astro.config.mjs'), 'utf8').catch(() => '');
  const actual = /inlineStylesheets:\s*'(\w+)'/.exec(cfg)?.[1] ?? null;
  const names = (await readdir(resolve(ROOT, 'scripts')).catch(() => []))
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('test-'));
  /** @type {Map<string, Set<string>>} 腳本 → 它註解裡假設的值 */
  const assumed = new Map();
  for (const f of names) {
    const t = await readFile(resolve(ROOT, 'scripts', f), 'utf8').catch(() => '');
    const vals = new Set([...t.matchAll(/inlineStylesheets:?\s*[`']?(auto|never|always)[`']?/g)].map((m) => m[1]));
    if (vals.size > 0) assumed.set(f, vals);
  }
  if (actual === null || assumed.size === 0) {
    console.log(
      '\n⚠ `inlineStylesheets` 沒有比對：' +
        (actual === null ? '讀不到 astro.config.mjs 裡的值。' : '沒有任何腳本提到它 —— 抽取的樣式可能壞了。'),
    );
    staleDocs += 1;
  } else {
    const wrong = [...assumed].filter(([, v]) => !v.has(actual));
    if (wrong.length === 0) {
      console.log(
        `\nastro.config 的 inlineStylesheets 是 '${actual}'，把它當前提的 ${assumed.size} 支腳本都這樣寫 ✓`,
      );
    } else {
      staleDocs += 1;
      console.log(
        `\n✗ astro.config 的 inlineStylesheets 是 '${actual}'，但這幾支腳本的註解假設的是別的值：\n` +
          wrong.map(([f, v]) => `      ${f}：${[...v].join('、')}`).join('\n') +
          '\n      那不只是註解過期 —— 那幾支的**掃描範圍**就是照那個前提決定的\n' +
          '      （樣式在 HTML 裡還是在 .css 檔裡，決定它們要讀哪一邊）。\n' +
          '      改法：設定改了就把那幾支一起看過一遍，不是只改註解。',
      );
    }
  }
}

if (!process.argv.some((a) => a.startsWith('--dir='))) {
  const selfSrc = await readFile(new URL(import.meta.url), 'utf8');
  /** @type {string[]} */
  const drifted = [];
  /** 說明裡真的有「現值」說法、因此這一輪比對過的那幾條 */
  const checkedLabels = [];
  for (const b of budgets) {
    if (b.unit === 'count') continue;
    /*
     * 這個 needle 刻意用串接組出來。
     *
     * `test-perf-budgets.mjs` 有兩道 meta 檢查，是用正則從原始碼抽
     * 「有哪幾條預算」的（樣式就是那個欄位名加單引號）。
     * 所以這裡**不能把那個樣式寫成字面值** —— 寫了的話這一行自己會被抽成
     * 一條假的預算，那兩道 meta 檢查就會報「這條預算沒有 fix／沒有測試案例」。
     * 第 2 輪（第二十四圈）第一版與第二版都踩到（第二版連 `'…' + "'"`
     * 那種串接也還是配得到）。改成直接找被引號包起來的標籤字串本身。
     *
     * 「解釋一條規則就會需要它禁止的東西」的近親：
     * **比對一個樣式，就會需要寫出那個樣式。**
     */
    const i = selfSrc.indexOf("'" + b.label + "'");
    if (i < 0) continue;
    const seg = selfSrc.slice(i, i + 2000);
    const whyM = /why:\s*((?:'[^']*'\s*\+?\s*)+)/.exec(seg);
    if (!whyM) continue;
    const why = whyM[1].replace(/'\s*\+\s*'/g, '').replace(/^'|',?\s*$/g, '');
    /*
     * ── 那個視窗原本是 14 個字 ──────────
     *
     * 第 2 輪（第三十四圈）逐條量：11 條預算的 `why` 裡，
     * 有三條寫著「目前／現在⋯⋯N KB」這種**現值**說法，而這個樣式只配得到兩條。
     * 漏掉的是「最大單一檔案」那一條：它的說法是「目前最大的是 ⋯⋯，N KB」，
     * 而中間夾著一個很長的檔名。
     *
     * （這裡刻意不把那句話原樣抄下來 —— 抄了的話這個檔案裡就有兩份一樣的字串，
     * 而突變掃描會配到前面那一份，改的不是你以為的那一個。這一圈問的正是這件事。）
     *
     * 「目前」到數字之間隔了 20 個字，超過 14 就配不到 ——
     * 而配不到的時候這裡是 `continue`，**安靜地跳過**。
     * 那個 24.9 這支腳本每跑一次就算一次，只是沒有拿去比。
     *
     * 放寬到 30 之後逐條驗過：只有那一條從「配不到」變成 24.9，
     * 其餘八條的結果一個字都沒變（沒有把上限之類的數字誤配進來）。
     */
    const claim = /(?:目前|現在)[^。；]{0,30}?([0-9][0-9.]*)\s*KB/.exec(why);
    if (!claim) continue;
    checkedLabels.push(b.label);
    const claimed = Number(claim[1]) * 1024;
    const drift = Math.abs(claimed - b.value) / b.value;
    if (drift > DRIFT_LIMIT) {
      drifted.push(
        `  X ${b.label}：說明裡寫「${claim[0].slice(0, 24)}」，現在量到的是 ${kb(b.value)}（差 ${Math.round(drift * 100)}%）`,
      );
    }
  }
  if (drifted.length > 0) {
    console.log('\n說明裡的數字過期了');
    console.log('='.repeat(76));
    for (const d of drifted) console.log(d);
    console.log(
      '  報告每次都會印真的值，所以說明裡不需要再寫一次 ——\n' +
        '  要嘛把那句數字拿掉（說理留著），要嘛更新它。',
    );
    /*
     * 不用 `process.exitCode` —— 檔案最後那一行 `process.exit(over > 0 ? 1 : 0)`
     * 會把它蓋掉。第 2 輪（第二十四圈）第一版就是那樣寫的：訊息印出來了、
     * 離開碼還是 0，而 `verify:all` 是 `a && b && c` 串起來的，等於沒擋。
     * （第 5 輪〔第二十三圈〕才剛記過同一種：規則對了，但它報的東西沒人看得到。）
     */
    staleDocs = drifted.length;
  }

  /*
   * ── 這一輪到底比了幾條 ──────────
   *
   * 原本這一段只有在**有東西過期**的時候才出聲。全部對得上的時候它一句話都不說 ——
   * 於是「說明裡的數字都是對的」跟「這道檢查一條都沒比到」在畫面上長得一模一樣。
   *
   * 第 2 輪（第三十四圈）就是這樣才發現漏掉一條的：從輸出上看不出來。
   * 所以把涵蓋範圍講出來，跟這支腳本其他幾段（「11 條預算裡 6 條說得出上限」）一致。
   */
  const wording = checkedLabels.length === 0 ? '**一條都沒比到**' : `比對了 ${checkedLabels.length} 條`;
  console.log(
    `\n說明裡的現值：${wording}（${checkedLabels.join('、') || '—'}）` +
      `，其餘 ${budgets.length - checkedLabels.length} 條的說明沒有寫現值，沒東西可比。`,
  );
}

/*
 * ── `docs/ARCHITECTURE.md` 說全站的 JavaScript 有幾段 ────────────
 *
 * 第 2 輪（第三十七圈）加的。這一圈問「這一條規則，是誰要求的？
 * 寫在哪份文件裡？兩邊還一致嗎？」
 *
 * 效能這一支的 11 條預算**沒有任何一份文件寫過** —— 它們只活在這個檔案裡
 * （這件事記進待辦，不在這一輪動）。但 `docs/ARCHITECTURE.md` 對 JavaScript
 * 講了一句**數得出來**的話：
 *
 *   「目前全站的 JavaScript 只有四小段：主題切換、語言下拉、
 *     詩詞直橫排切換、站內搜尋。」
 *
 * 那句話是整份架構文件裡**唯一一句可以被產出打臉的效能宣稱**，
 * 而且它就在「決定性的因素是 0 KB JavaScript」下面兩行 ——
 * 讀的人是拿它來理解這個站的取捨的。
 *
 * 量出來是 **5 段**，不是四段。第五段是 `Base.astro` 裡那一小段
 * 在算繪前套用已存主題與直橫排的 script（順便設 `dataset.js`）——
 * 它 641 B、**每一頁都有**、而且**跑在畫面出現之前**，
 * 正是講效能的人最會想知道的那一段。它不在那份清單上。
 *
 * 這裡比的是「幾段」，不是「哪幾段」：段落的名字是人寫的散文，
 * 而數量是產出算得出來的。
 */
const archOverride = process.argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length);
if (archOverride !== undefined || !process.argv.some((a) => a.startsWith('--dir='))) {
  const archPath = archOverride === undefined ? resolve(ROOT, 'docs/ARCHITECTURE.md') : resolve(archOverride);
  const arch = await readFile(archPath, 'utf8').catch(() => '');
  /** 產出裡**不重複**的內嵌 script（同一段會出現在很多頁上） */
  const distinct = new Set();
  for (const text of htmlTexts) {
    for (const body of inlineScriptBodies(text)) {
      const t = body.trim();
      if (t !== '') distinct.add(t);
    }
  }
  const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  /*
   * ── 同一句話，README 也寫了一份 ──────────────────────
   *
   * 第 6 輪（第四十七圈）用「多久沒碰過、前提還在嗎」量到的：
   * `README.md` 191 個 commit 沒有人碰，而它第 23 行寫著
   * 「零 JavaScript 起步 —— 全站只有**四**小段增強腳本」——
   * 而產出裡是 **5** 段，`docs/ARCHITECTURE.md` 也早就改成「五小段」了。
   *
   * 也就是說這件事一直有兩份，而只有一份有人在守。
   * README 是這個 repo 的門面，那句話是第一次來的人看到的第一個具體數字。
   *
   * 改成兩份一起比 —— 不是新的檢查，是把既有那一條的語料補齊。
   * README 的句子也改成同一個寫法，所以只需要一個樣式。
   */
  let readmeOk = false;
  const readmePath = archOverride === undefined ? resolve(ROOT, 'README.md') : null;
  const readme = readmePath === null ? '' : await readFile(readmePath, 'utf8').catch(() => '');
  if (readme !== '') {
    const rm = /JavaScript 只有([一二三四五六七八九十]|\d+)小段/.exec(readme);
    if (!rm) {
      staleDocs += 1;
      console.log(
        '\n⚠ README.md 裡找不到「全站的 JavaScript 只有N小段」那句話 —— 這一格沒有在守。\n' +
          '  它跟 docs/ARCHITECTURE.md 講的是同一件事，兩份都要用同一個寫法才比得到。',
      );
    } else {
      const rClaimed = CN[/** @type {keyof typeof CN} */ (rm[1])] ?? Number(rm[1]);
      /* 對得上也要出聲 —— 不然「對得上」跟「這一格沒在比」長得一樣 */
      if (rClaimed === distinct.size) readmeOk = true;
      if (rClaimed !== distinct.size) {
        staleDocs += 1;
        console.log(
          `\n✗ README.md 說全站的 JavaScript 有 ${rClaimed} 段，產出裡是 ${distinct.size} 段。\n` +
            '      README 是第一次來的人看到的第一個具體數字。\n' +
            '      改法：那一句與 docs/ARCHITECTURE.md 的同一句一起改。',
        );
      }
    }
  }

  const m = /JavaScript 只有([一二三四五六七八九十]|\d+)小段/.exec(arch);
  if (arch === '') {
    console.log('\n⚠ 讀不到 docs/ARCHITECTURE.md —— 那句「全站的 JavaScript 有幾段」沒有對過。');
  } else if (!m) {
    console.log(
      '\n⚠ docs/ARCHITECTURE.md 裡找不到「全站的 JavaScript 只有N小段」那句話 —— 這一格沒有在守。\n' +
        '  文件換了寫法的話這裡的樣式要跟著改（不然它會安靜地什麼都不比）。',
    );
    staleDocs += 1;
  } else {
    const claimed = CN[/** @type {keyof typeof CN} */ (m[1])] ?? Number(m[1]);
    /*
     * 對得上的時候也要出聲 —— 不然「對得上」跟「這一格沒在比」長得一樣。
     * 旁邊那條「說明裡的現值：比對了 N 條」是同一個道理。
     */
    if (claimed === distinct.size) {
      console.log(
        `\ndocs/ARCHITECTURE.md${readmeOk ? ' 與 README.md 都說' : ' 說'}全站的 JavaScript 有 ${claimed} 段，` +
          `產出裡數到 ${distinct.size} 段 ✓`,
      );
    }
    if (claimed !== distinct.size) {
      staleDocs += 1;
      console.log(
        `\n✗ docs/ARCHITECTURE.md 說全站的 JavaScript 有 ${claimed} 段，產出裡是 ${distinct.size} 段。\n` +
          '      那句話就在「決定性的因素是 0 KB JavaScript」下面兩行 ——\n' +
          '      讀的人是拿它來理解這個站的取捨的，數字不對等於那個取捨說不清楚。\n' +
          '      改法：把那一句的數字與清單改成現在真的有的幾段\n' +
          '      （`npm run check:perf -- --verbose` 會列出每一段多大、出現在幾頁）。',
      );
    }
  }
}

console.log('\n效能預算（量 gzip 後的大小，那才是實際下載量）');
console.log('='.repeat(76));

let over = 0;
for (const b of budgets) {
  const isCount = b.unit === 'count';
  /** @param {number} n */
  const fmt = (n) => (isCount ? String(n) : kb(n));
  const ok = b.value <= b.limit;
  if (!ok) over++;
  const pct = Math.round((b.value / b.limit) * 100);
  const bar = '█'.repeat(Math.min(20, Math.round(pct / 5))).padEnd(20, '·');

  if (ok && !VERBOSE) {
    console.log(`  ✓ ${b.label.padEnd(22)} ${fmt(b.value).padStart(9)} / ${fmt(b.limit).padStart(9)}  ${bar} ${pct}%`);
  } else {
    console.log(`\n  ${ok ? '✓' : 'X'} ${b.label}`);
    console.log(`      ${fmt(b.value)} / 上限 ${fmt(b.limit)}   ${bar} ${pct}%`);
    console.log(`      ${b.detail}`);
    /*
     * 「改法」印在 why 之前。
     *
     * 第 2 輪（第十七圈）量到：11 條預算的 why 是 37–358 字的**來歷與分析**，
     * 而下一步散在裡面（有的在第 4%，有的在第 84%，`圖片合計` 根本沒有）。
     * 站主看到紅燈時要的是「現在該做什麼」，來歷是給想追下去的人看的。
     * 所以拆成兩行：先講怎麼辦，再講為什麼是這樣。
     */
    console.log(`      改法：${b.fix}`);
    console.log(`      ${b.why}`);
    /*
     * ── 這個數字是推導出來的，還是挑的 ──────────────
     *
     * 第 2 輪（第三十一圈）問「是我們選的，還是它剛好長成這樣」。
     * `why` 說的是**這條預算在守什麼**，不是**上限為什麼是這個數**。
     * 量了一次：11 條的餘裕倍數從 1.50 到 17.14 —— 看起來像一套系統
     * （整數、對齊），實際上是四種不同的訂法混在一起。
     *
     * `basis` 一律以「推導：」或「挑的：」開頭，所以兩者在輸出上分得開，
     * 也 grep 得出來。挑的那幾條**不是錯** —— 一個門檻本來就可以是判斷。
     * 但「挑的」跟「算出來的」被讀成同一種東西的時候，
     * 調高門檻會顯得跟當初訂它一樣有根據，而那不成立。
     */
    console.log(`      ${b.basis}`);
    if (!ok) console.log('');
  }
}

console.log('\n' + '-'.repeat(76));
console.log(
  `  ${html.length} 頁　HTML 合計 ${kb(html.reduce((n, f) => n + f.raw, 0))}` +
    `（gzip ${kb(html.reduce((n, f) => n + f.gzip, 0))}）` +
    `　dist 總計 ${kb(files.reduce((n, f) => n + f.raw, 0))}`,
);
/*
 * ── brotli 是這台機器算得出來的，不是讀者拿得到的 ──────
 *
 * 上面所有預算都按 gzip 判斷（最差情況），這一行本來寫的是
 * 「brotli，**現代瀏覽器拿到的**」—— 而那句話對這個站是錯的。
 *
 * 第 2 輪（第二十二圈）實測：這個站要部署在 GitHub Pages 上，
 * 而 **GitHub Pages 不供應 brotli**。兩個確定是 Pages 的主機
 * （`server: GitHub.com`）都試過，帶著瀏覽器真正會送的
 * `Accept-Encoding: gzip, deflate, br, zstd`：
 *
 *   pages.github.com　→  content-encoding: gzip
 *   jekyllrb.com　　　→  content-encoding: gzip
 *
 * 只送 `Accept-Encoding: br` 的話它連壓都不壓（沒有 content-encoding）。
 * 對照組 sass-lang.com（Netlify）回的是 `br`，所以不是我的請求寫錯。
 *
 * 也就是說：**讀者拿到的是 gzip 那個數字，不是 brotli 那個。**
 * 那一行差 19%（10.5 KB vs 8.6 KB），而它原本掛著「現代瀏覽器拿到的」
 * 這幾個字 —— 一個看起來已經量過的、其實只在我的機器上成立的數字。
 *
 * 保留 brotli 的數字（換一個主機就有意義，而且它說明壓縮還有多少空間），
 * 但把「誰拿得到」講清楚。
 */
console.log(`  最大單頁 HTML：${kb(worstPage.gzip)}（gzip —— GitHub Pages 只供應這個）`);
console.log(
  `  　　　　　同一份用 brotli 是 ${kb(br(worstPage.buf))}，少 ${Math.round((1 - br(worstPage.buf) / worstPage.gzip) * 100)}%` +
    `　—— 這個站拿不到，換一個會供應 brotli 的主機才有`,
);

/*
 * ── 上面那個數字是 level 9，而伺服器不是 ──────────────
 *
 * 這支腳本用 `gzipSync(buf, { level: 9 })`，也就是本機壓得最小的等級。
 *
 * ## 這一段的結論被推翻過一次，值得留著
 *
 * 第 2 輪（第二十六圈）問「伺服器實際送幾個位元組」，那時
 * `bellafoxy.com` 還沒上線，只能拿**別人的站**（`pages.github.com`、
 * `squidfunk.github.io`）代打，推論出「伺服器大約壓到 level 4–6，不是 9」，
 * 於是這裡開始印「實際的伺服器壓得沒那麼用力⋯⋯比上面多 2.3%」。
 *
 * 第 2 輪（第二十七圈）站上線之後量自己的站，**方向是反的**：
 *
 *     level 4   11005
 *     level 9   10754
 *     實際送出  10655   ← 比本機最高等級還少 99 bytes（0.9%）
 *
 * 五頁量下來差 −0.4% ～ −1.7%，內容 md5 逐頁核對過。
 * GitHub Pages 壓得**比 Node 的 zlib 最高等級還用力**。
 *
 * 所以 level 9 不是「最好的情況」，是一個安全的**上界** ——
 * 而預算要守的正是上界，這比原本的說法更站得住。
 *
 * 代打量出來的結論，沒有人在真的東西出現時回頭重量。
 * `npm run probe:served` 就是為了讓「回頭重量」變成一個指令。
 */
/*
 * 這幾個數字是量出來的，不是猜的，所以要說清楚**什麼時候量的、怎麼重量**。
 * 上一版把一個從別人的站推論出來的等級寫成事實，而且方向還是反的。
 */
/*
 * 2026-09-06（第 2 輪，第四十四圈）重量過一次，四頁的差距**一字不差**
 * 還是 -1.7% ～ -0.4%。那一輪的問題是「這件事站主要自己做嗎」——
 * 這一格的待辦本來寫著「要重量得先推（→ 站主）」，
 * 而那天推的權限已經下放，所以它不再是他的事，就重量了。
 */
const MEASURED = { date: '2026-09-07', lo: -1.7, hi: -0.4, pages: 4, cmd: 'npm run probe:served' };
/*
 * ── 那個日期要說出「多久以前」──────────────────
 *
 * 第 2 輪（第三十八圈）加的。這一圈問「這件事現在靠誰記得？忘了會怎樣？」
 *
 * 這一行本來就已經做對了大半：它說得出**什麼時候量的**、**怎麼重量**。
 * 缺的是最後一步 —— **那是多久以前**。
 * 「2026-09-04 實測」讀起來永遠像剛量過，而它會一直是那個日期，
 * 直到有人想起來去跑 `probe:served`。
 *
 * 那一輪跑了一次，結果是 **0 頁量到** ——
 * 本機領先 origin 105 個 commit（12 個動到 src/），線上那一份根本比本機舊。
 * 也就是說這個宣稱現在**重量不出來**，而在這之前輸出不會透露這件事。
 */
const measuredDays = Math.round(
  (Date.parse(`${projectDay()}T00:00:00Z`) - Date.parse(`${MEASURED.date}T00:00:00Z`)) / 86_400_000,
);
console.log(
  `  　　　　　這個 gzip 數字是**上界**：${MEASURED.date}（${measuredDays} 天前）實測 GitHub Pages 對這個站送出的，` +
    `比它少 ${Math.abs(MEASURED.hi)}%～${Math.abs(MEASURED.lo)}%（${MEASURED.pages} 頁，內容 md5 逐頁核對）` +
    `　—— 要重量：${MEASURED.cmd}`,
);

/*
 * ── 那個數字不是「讀者實際下載」的量 ──────────
 *
 * 這一行原本寫「最大單頁：**讀者實際下載** 10.5 KB」。
 * 它是 `worstPage.gzip`，**只有 HTML**。而讀者第一次到訪還要再抓一支
 * 阻塞渲染的樣式表 —— 真正的量是 14.1 KB，多 34%。
 *
 * 諷刺的是這一支自己算得出來：上面「首次造訪關鍵路徑」那條預算就是它，
 * 就印在同一張表上兩行之前。**知道答案，只是這一行沒有用它。**
 *
 * 更值得記的是：這一行**修過一次「誰拿得到」**（見上面 brotli 那段的註解 ——
 * 第 2 輪〔第二十八圈〕把「現代瀏覽器拿到的」改成「這個站拿不到」）。
 * 那次修的是**壓縮法**，沒有回頭看**內容**。同一句話裡的兩個假設，
 * 只有一個被檢查過。
 *
 * 第 2 輪（第三十三圈）：這一圈問「這是給誰用的、那個人真的會走到這裡嗎」。
 * 整支關卡只有這一行是對著**讀者**說的 —— 而它說的不是讀者的數字。
 */
console.log(
  `  讀者第一次到訪最多下載 ${kb(worstCritical.critical)}（gzip）：${worstCritical.path} 的 HTML ` +
    `${kb(worstCritical.gzip)} ＋ 阻塞渲染的樣式表 ${kb(worstCritical.critical - worstCritical.gzip)}`,
);
/*
 * ── 上面那句的「最多」，有一個網址比它多 ────────────────
 *
 * 第 2 輪（第五十二圈）量到的。`worstCritical` 比的是**阻塞渲染**的位元組，
 * 那個定義是對的；但那句話對讀者說的是「最多**下載**」，而搜尋頁帶著 `?q=`
 * 進站時還會多抓一份搜尋索引（`search.astro` 自己的註解寫著
 * 「網址帶 ?q= 時直接搜（方便從別的地方連過來）」）。
 *
 * 實測：`/search` 的 HTML ＋ 阻塞的 CSS 是 10.6 KB，加上索引 5.8 KB ＝ **16.4 KB**，
 * 比首頁的 14.1 KB 多 16%（數字每次重算，這裡記的是 2026-09-08 的值）。
 * 索引不阻塞算繪（畫面先出來、結果後到），所以預算不動 ——
 * 動的是這句話：把那個網址也說出來，數字現算。
 */
{
  /* 取**最重**的那一頁，不是第一個 —— `find` 會拿到 en/search（比較小）。 */
  const searchPage = pageStats
    .filter((p) => p.requests.runtimeFetch > 0)
    .reduce((a, b) => (a === null || b.critical > a.critical ? b : a), /** @type {typeof pageStats[0] | null} */ (null));
  const indexFile = files.find((f) => f.path === 'search-index.json');
  if (searchPage && indexFile && searchPage.critical + indexFile.gzip > worstCritical.critical) {
    console.log(
      `  　　　　　但帶著 \`?q=\` 進 /search 的人會再多抓一份搜尋索引：` +
        `${kb(searchPage.critical)} ＋ ${kb(indexFile.gzip)} ＝ ` +
        `**${kb(searchPage.critical + indexFile.gzip)}**，比上面那個數字多 ` +
        `${Math.round(((searchPage.critical + indexFile.gzip) / worstCritical.critical - 1) * 100)}%。`,
    );
    console.log('  　　　　　（索引不阻塞算繪，所以不進「首次造訪關鍵路徑」那條預算。）');
  }
}
/*
 * ── 「在快取裡」有個 10 分鐘的期限 ──────────────────
 *
 * 原本這一行寫「第二頁起樣式表在快取裡，就只剩 HTML」。
 * 第 2 輪（第四十四圈）去線上量了 header，那句話只在**十分鐘內**成立：
 *
 *   cache-control: max-age=600     ← 連內容雜湊過的 /_astro/*.css 也是這個
 *   etag: "6a9da7b9-3396"
 *   帶 If-None-Match 再打一次 → 304，body 0 bytes、header 363 bytes
 *
 * GitHub Pages 不讓你設快取標頭，所以這個 600 是**改不動的** ——
 * 不是「還沒有人去改」，是這個主機上沒有那個開關。
 * 但代價比看起來小：超過十分鐘之後多的是一趟來回 ＋ 363 bytes，
 * 不是重新下載那 3.7 KB。這一行要說得出這件事，不然它太樂觀。
 */
console.log('  　　　　　第二頁起樣式表在快取裡，就只剩 HTML —— 也就是上面那個數字。');
console.log(
  '  　　　　　（快取只有 10 分鐘：GitHub Pages 一律送 `max-age=600`，連雜湊過的檔案也是。\n' +
    '  　　　　　　超過之後多一次條件式請求 —— 有 ETag，所以是 304、body 0 bytes、header 363，\n' +
    '  　　　　　　不是重新下載。2026-09-06 實測。）',
);

/*
 * ── 說出這些預算實際量到什麼 ──────────
 *
 * 通過的預算只印一行數字，`detail` 只有 --verbose 或超標時才看得到。
 * 所以「量到 7 個檔案」與「量到 0 個檔案」在畫面上長得一模一樣 —— 都是綠的。
 *
 * 第 1 輪（第十五圈）在 check:a11y 補過同一件事，理由也一樣：
 * 安靜地什麼都沒檢查，比明講檢查不了危險得多。
 */
const reqTotals = pageStats.reduce(
  (a, p) => ({
    links: a.links + p.requests.links,
    uncountedLinks: a.uncountedLinks + p.requests.uncountedLinks,
    runtimeFetch: a.runtimeFetch + p.requests.runtimeFetch,
    scripts: a.scripts + p.requests.scripts,
    imgs: a.imgs + p.requests.imgs,
    otherShapes: Object.fromEntries(
      Object.entries(p.requests.otherShapes).map(([k, v]) => [k, (a.otherShapes[k] ?? 0) + v]),
    ),
  }),
  /** @type {{ links: number, scripts: number, imgs: number, uncountedLinks: number, runtimeFetch: number, otherShapes: Record<string, number> }} */
  ({ links: 0, scripts: 0, imgs: 0, uncountedLinks: 0, runtimeFetch: 0, otherShapes: {} }),
);
/** @type {string[]} */
const empty = [];
if (images.length > 0 && rendered.length === 0) {
  /*
   * ── 「全是 favicon」原本是寫死的一句話 ────────────────
   *
   * 第 2 輪（第三十九圈）改的。那一圈在逐條驗待辦，
   * 而「那句『全是 favicon』是寫死的描述」驗出來**是活的**：
   * 今天那 7 個檔案確實全是 favicon／PWA 圖示／og:image，
   * 但那是**巧合**，不是那句話查過的結果。
   *
   * 有人往 `public/` 丟一張沒有任何頁面引用的內容圖，
   * `rendered.length === 0` **仍然成立**，於是這一段照樣說「全是 favicon」
   * —— 而那時候它是錯的，還剛好蓋掉唯一值得注意的東西
   * （一個會出貨、卻沒有任何頁面載入的檔案）。
   *
   * 改成照檔名分類，認不出來的**逐個列出來**。
   */
  const ICONISH = /^(favicon\.|apple-touch-icon|icon-\d|icon-maskable|og\/)/;
  const stray = images.map((f) => f.path).filter((p2) => !ICONISH.test(p2));
  empty.push(
    `圖片合計／最大單一檔案 —— ${images.length} 個圖片檔，頁面真的會載入的 0 個。\n` +
      (stray.length === 0
        ? `      ${images.length} 個全都是 favicon／PWA 圖示／og:image（照檔名認的：` +
          'favicon.*、apple-touch-icon*、icon-N*、icon-maskable*、og/*）——\n' +
          '      瀏覽器外框與社群爬蟲抓的，不隨內容成長。'
        : `      其中 ${stray.length} 個**不是** favicon／PWA 圖示／og:image：\n` +
          stray.map((p2) => `        · ${p2}`).join('\n') + '\n' +
          '      它們會出貨，而沒有任何頁面載入它們 —— 那通常是忘了刪的檔案。') +
      '\n      綠是因為還沒有內容圖，不是因為內容圖有節制。',
  );
}
/*
 * ── 這句話要跟著它上一行的數字走 ────────────────────
 *
 * 原本寫死一句「三項裡只有 stylesheet 數得到東西，另外兩項從來沒有過主體」，
 * 而條件是 `scripts === 0 || imgs === 0` —— **一個 OR，配一句斷定兩個的話**。
 *
 * 第 2 輪（第三十二圈）實測：一份有兩張圖、沒有樣式表的假站，印出來是
 *
 *     stylesheet 0 個、script src 0 個、img src 2 個。
 *     三項裡只有 stylesheet 數得到東西，另外兩項從來沒有過主體。
 *
 * **兩個半句都跟它上一行的數字相反。** 那句話是照著「今天的這個站」
 * 寫死的，而寫死的描述遇到別的狀態就會說謊。
 *
 * 改成從數字推：哪幾項是 0 就點名哪幾項。
 */
{
  const parts = [
    { name: 'stylesheet', n: reqTotals.links },
    { name: 'script src', n: reqTotals.scripts },
    { name: 'img src', n: reqTotals.imgs },
  ];
  const bare = parts.filter((p) => p.n === 0);
  if (bare.length > 0) {
    const live = parts.filter((p) => p.n > 0);
    empty.push(
      `單頁請求數 —— ${html.length} 頁合計：` +
        parts.map((p) => `${p.name} ${p.n} 個`).join('、') +
        '。\n' +
        `      三項裡 ${bare.length} 項這次一個主體都沒有：${bare.map((p) => p.name).join('、')}。\n` +
        (live.length > 0
          ? `      數得到東西的只有 ${live.map((p) => p.name).join('、')} —— 這條預算的綠燈只涵蓋那些。`
          : '      也就是說這條預算這次**什麼都沒量到**，綠燈不代表請求數有節制。'),
    );
  }

  /*
   * 邊界外面：`rel="icon"` 那一類與 `rel="manifest"` 這條預算不數它們。
   *
   * ── 原本這裡寫「也會發出請求」，而那句話是**推測** ──────────
   *
   * 第 2 輪（第四十八圈）拿真的瀏覽器對 **bellafoxy.com**（不是本機）量了兩頁：
   *
   *   /                    2 個請求：文件 ＋ 1 個 CSS
   *   /poems/wu-yi-xiang   3 個請求：文件 ＋ 2 個 CSS
   *
   * 兩頁都宣告了 4 個 `rel="icon"`／`rel="manifest"`，而**一個都沒有被抓**
   *（`performance.getEntriesByType('resource')` 與瀏覽器的網路紀錄兩邊都是）。
   * 瀏覽器不會在一般的頁面載入時抓宣告的圖示，manifest 也只在需要時才抓。
   *
   * 所以那句話改成說得出來的：**宣告了幾個**，而不是替瀏覽器決定它會不會抓。
   */
  if (reqTotals.uncountedLinks > 0) {
    empty.push(
      `單頁請求數數不到的：${html.length} 頁合計宣告了 ${reqTotals.uncountedLinks} 個 ` +
        '`rel="icon"`／`rel="manifest"` 連結（平均每頁 ' +
        `${(reqTotals.uncountedLinks / html.length).toFixed(1)} 個）。\n` +
        '      抓不抓由瀏覽器決定 —— 第 2 輪（第四十八圈）在 bellafoxy.com 上量兩頁，\n' +
        '      宣告的 4 個一個都沒被抓（一般載入時不會，manifest 要到安裝才會）。',
    );
  }

  /*
   * JS 自己發的請求：條件式的，不是漏數，所以自己一行。
   * 數字每次重算 —— 哪天有人在別的頁面加一個 fetch，這一行會自己變。
   */
  if (reqTotals.runtimeFetch > 0) {
    const pagesWith = pageStats.filter((p) => p.requests.runtimeFetch > 0);
    empty.push(
      `單頁請求數之外還有 JS 自己發的：${pagesWith.length} 頁的內嵌腳本裡有 ` +
        `${reqTotals.runtimeFetch} 個 fetch／XHR（${pagesWith.map((p) => p.path).join('、')}）。\n` +
        '      那是**條件式**的 —— 搜尋索引要等使用者打字、送出、或帶著 `?q=` 進站才抓，\n' +
        '      所以它不在「單頁請求數」裡，也不算這條預算漏數。\n' +
        '      搜尋索引本身有自己的預算（上面那條）。',
    );
  }

  /*
   * 那九種「還會發出請求、但這條預算不數」的寫法，每次重算一次。
   * 全是 0 也要說出口 —— 「今天沒有」跟「沒有人在看」在輸出上長得一樣。
   */
  const others = Object.entries(reqTotals.otherShapes).filter(([, n]) => n > 0);
  empty.push(
    others.length === 0
      ? `別種會發請求的寫法（preload、iframe、video／audio、object、\`<use href>\`、` +
          `CSS 的 url()、@font-face⋯共 ${Object.keys(reqTotals.otherShapes).length} 種）：` +
          `${html.length} 頁合計 **0 個**，所以這條預算今天沒有漏數。`
      : `**這條預算漏數了**：${others.map(([k, n]) => `${k} ${n} 個`).join('、')}。\n` +
          '    它們會發出請求，而「單頁請求數」只數 stylesheet／script src／img src。\n' +
          '    改法：把它算進 `requestParts()`，或說明為什麼不算（像圖示那樣）。',
  );
}
if (skipped.length > 0) {
  console.log(`\n  這次少了 ${skipped.length} 條預算（東西不在，所以沒得量）：`);
  for (const line of skipped) console.log(`    · ${line}`);
  console.log('    少一條預算跟「全部在預算內」在輸出上長得一樣，所以要說出來。');
}

if (empty.length > 0) {
  console.log(`\n  這些預算現在量的是空的或不變的東西（${empty.length} 項）：`);
  for (const line of empty) console.log(`    · ${line}`);
}

if (VERBOSE) {
  /*
   * ── 每條預算實際上量了幾個東西 ──────────────────────
   *
   * 第 2 輪（第二十一圈）加的，跟第 1 輪在 `check:a11y` 上做的是同一件事：
   * 第十五圈問過「有沒有東西可看」（0 或非 0），這一圈問**數量** ——
   * 一條只量到 1 個檔案的預算，跟量了 44 頁的，
   * 綠燈的意思完全不是同一回事。
   *
   * 「圖片合計」與「最大單一檔案」早就有一段自己的說明（那兩條量的是
   * 不隨內容成長的東西），這一段是把同樣的問題套到全部十一條上。
   */
  console.log('\n  每條預算實際上量了幾個東西：');
  for (const b of budgets) {
    console.log(`    ${String(b.subjects ?? 0).padStart(4)}  ${b.label}`);
  }

  console.log('\n  最大的 8 個檔案：');
  for (const f of [...files].sort((a, b) => b.raw - a.raw).slice(0, 8)) {
    console.log(`    ${kb(f.raw).padStart(9)} → gzip ${kb(f.gzip).padStart(9)}  ${f.path}`);
  }
}

/*
 * ── 十一個綠勾裡，哪一個該盯 ──────────
 *
 * 第 2 輪（第二十九圈）問「第一次跑的人跟第一百次跑的人看到的是同一份
 * 東西嗎」。表格本身是自明的（數值／上限／進度條／百分比），
 * 但**十一個綠勾長得一模一樣** —— 老手知道 CSP 雜湊數那條 88% 是
 * 一個決策觸發點（到 42 就該把 inlineStylesheets 換成 never），
 * 第一次跑的人只看到十一個勾。
 *
 * 掃一次表比較十一個百分比不難，但那是**讀的人要做的工作**，
 * 而這支腳本已經算過了。點名一句就好。
 */
const closest = budgets.reduce((a, b) => (b.value / b.limit > a.value / a.limit ? b : a));
const closestPct = Math.round((closest.value / closest.limit) * 100);

console.log('\n' + '='.repeat(76));
if (over === 0 && staleDocs === 0) {
  /*
   * 判決那一行要**單獨一行、一字不差**。
   *
   * `test-perf-budgets` 的 `verdictOk` 是 `/^全部在預算內。$/m` —— 錨定整行，
   * 而那是第 2 輪（第二十五圈）刻意收緊的：原本用 `includes`，
   * 於是「少了一條預算，其餘全部在預算內」也會被判成通過。
   *
   * 第 2 輪（第二十九圈）第一版把「最接近上限的是⋯」接在同一行上，
   * 三格當場紅 —— **測試守住了一個刻意的設計**。附註要另起一行。
   */
  console.log('全部在預算內。');
  console.log(`最接近上限的是「${closest.label}」（${closestPct}%）。`);
  /* 見上面 basis 那一段：「挑的」跟「算出來的」要分得開 */
  const derived = budgets.filter((b) => b.basis.startsWith('推導：')).length;
  console.log(
    `${budgets.length} 條預算裡，${derived} 條說得出上限是怎麼推導的，` +
      `${budgets.length - derived} 條是挑的（--verbose 看每一條）。`,
  );
  /* 這一行在紅燈那條路上也會印 —— 見底下 else 那一段的說明 */
  /*
   * ── 每條預算的數字從哪來，只有 --verbose 說得出來 ──────────
   *
   * 每一條都有 `why`（例如 CSP 雜湊數那條：一個雜湊約 43 B、
   * 首頁 auto 比 never 只領先 294 B，所以 42 個就該換），
   * 而那些只在**超標或 --verbose** 時才印。
   *
   * 第 1 輪（第二十九圈）量到：七支關卡裡六支有 --verbose 而輸出從來不提它。
   * 老手知道要打，第一次跑的人不知道那個東西存在。
   */
  if (!VERBOSE) {
    console.log('要看每條預算的數字是怎麼訂的：npm run check:perf -- --verbose\n');
  } else {
    console.log('');
  }
} else {
  console.log(
    `${over} 項超出預算${staleDocs > 0 ? `、${staleDocs} 條說明裡的數字過期` : ''}。`,
  );
  /*
   * ── 「最接近上限的是哪一條」在紅燈時也要說 ──────────────
   *
   * 第 2 輪（第二十九圈）加了這一句，但只印在**全綠那條路**上。
   * `closest` 是無條件算出來的，然後在另一條路上**算完丟掉**。
   *
   * 第 2 輪（第三十圈）量到它的代價：把 `inlineStylesheets` 從 `auto`
   * 改成 `always`（CSS 全部內嵌），連讀 5 頁的下載量從 43.6 KB 變成
   * 54.9 KB（**多 26%**），而**一條預算都沒有超標** ——
   * 「最大單頁 HTML」從 75% 跳到 98%，離上限只剩 2%。
   *
   * 那個數字就在表上，但**沒有任何一句話指著它**：那一輪唯一紅的是
   * 一條不相干的「說明裡的數字過期」，而它把整段判決推到了 else 這一邊。
   *
   * **最需要知道「誰快要爆了」的時候，正好是已經有東西壞了的時候。**
   *
   * 它自己就是超標的那一條時不印 —— 上面的 ✗ 已經指名過了，
   * 再說一次只是重複。
   */
  /*
   * 這裡要的是「**還沒超標的**裡面最接近的那條」，不是上面那個 `closest`
   * —— 有東西超標時 `closest` 就是它自己（比值 > 1），照著印會變成
   * 把 ✗ 已經指名過的那條再說一遍，而「下一個要爆的是誰」仍然沒人說。
   * 判準要跟訊息說的一樣（第 1 輪〔第二十四圈〕的教訓）。
   */
  const under = budgets.filter((b) => b.value <= b.limit);
  if (under.length > 0) {
    const next = under.reduce((a, b) => (b.value / b.limit > a.value / a.limit ? b : a));
    console.log(
      `還沒超標的裡面最接近上限的是「${next.label}」（${Math.round((next.value / next.limit) * 100)}%）。`,
    );
  }
  console.log('');
}
/*
 * ── 最後一行用 `process.exitCode`，不用 `process.exit()` ──────────
 *
 * `process.exit()` **不等 stdout 排空**。輸出接到終端機時是同步寫的，
 * 看不出來；接到**管線**時（CI 收集輸出、測試用 execFile 讀 stdout）
 * 是非同步的，排隊中的那一段就這樣被丟掉。
 *
 * 第 8 輪（第四十三圈）量到的：把 `--verbose` 的輸出接到管線跑 30 次，
 * **1 次被截斷** —— 停在第 74 行的中間，後面 30 行（含最後的判決）全沒了。
 * 而讀輸出的人看到的是「10 條預算，只有 9 條有 basis」，
 * 也就是**一個看起來像內容錯誤的假紅燈**。那正是記了好幾圈的偶發紅燈之一。
 *
 * 上面第 800 行那段註解說「不用 `process.exitCode`，會被最後這一行蓋掉」——
 * 那是對的，指的是**中間**那些地方。**最後一行**設 `exitCode` 沒有東西會蓋它，
 * 而且 node 會等 stdout 排空才真的離開。
 *
 * 這個檔案還有兩個早退的 `process.exit(1)`（dist 是空的那種），
 * 訊息都很短，先不動 —— 其餘七支關卡也都以 `process.exit()` 收尾，記在待辦。
 */
process.exitCode = over > 0 || staleDocs > 0 ? 1 : 0;
