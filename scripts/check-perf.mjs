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
import { resolve, dirname, relative, extname } from 'node:path';
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
function inlineJsBytes(text) {
  const scripts = [...text.matchAll(/<script(?![^>]*ld\+json)[^>]*>([\s\S]*?)<\/script>/gi)];
  return scripts.reduce((n, m) => n + m[1].length, 0);
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
  return { links, scripts, imgs, total: links + scripts + imgs };
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
const TEXT_EXT = new Set(['.xml', '.json', '.txt', '.css', '.js', '.mjs', '.svg', '.webmanifest', '.map']);
/** @param {string} path */
const isTextLike = (path) => TEXT_EXT.has(extname(path).toLowerCase());
/*
 * 沒有任何非 HTML 資源時，這裡本來會 `reduce of empty array` 直接崩潰 ——
 * 而崩潰跟「檢查通過」在 CI 上長得不一樣，但在**只看有沒有紅字**的人眼裡
 * 很容易混過去（它連預算表都印不出來）。
 * 第 2 輪（第四圈）寫預算的實測時撞到的：假 dist 裡只放了一頁 HTML。
 */
const assets = files.filter((f) => !f.path.endsWith('.html') && !isTextLike(f.path));
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
    subjects: pageStats.length,
    fix: '已經越過 14 KB 那個門檻了，只能守住不再長：看上面兩條（HTML 本身、全站 CSS）哪一邊在長。',
    value: worstCritical.critical,
    limit: 21 * 1024,
    detail: `${worstCritical.path}（HTML ${kb(worstCritical.gzip)} + 阻塞的 CSS）`,
    why:
      '這才是「使用者要等多久才看得到字」的數字：HTML 加上必須先抓完的樣式表。' +
      '目前最重的一頁約 14.2 KB。上限取現值的 1.5 倍。' +
      '注意 14 KB 附近有個實際意義 —— TCP 初始壅塞視窗大約就是那麼大，' +
      '超過就要多一個來回。已經越過了，所以這條的意義是「不要繼續往上長」。',
  },
  {
    label: '全站 CSS 合計（gzip）',
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
    subjects: pageStats.length,
    fix: '把搜尋那段程式碼抽成獨立檔案，不要繼續內嵌。',
    value: worstJs.inlineJs,
    limit: 6 * 1024,
    detail: worstJs.path,
    why:
      '搜尋頁比較特別 —— 它多了一整套比對、排序與摘要標示的邏輯，目前約 3.8 KB。' +
      '那段只內嵌在 /search 上，不會影響其他頁面，所以給它比較寬的額度。' +
      '真的超過 6 KB 的話，那段程式碼應該抽成獨立檔案而不是繼續內嵌。',
  },
  {
    label: '單頁請求數（不含 HTML）',
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
     */
    label: 'CSP 雜湊數（單頁最多）',
    subjects: pageStats.length,
    fix: '把 astro.config 的 inlineStylesheets 改成 never —— 這條紅燈就是那個時候到了。',
    value: worstHashes.cspHashes,
    limit: 41,
    detail: worstHashes.path,
    unit: 'count',
    why:
      '一個雜湊約 43 B（gzip 幾乎壓不動），而首頁 auto 比 never 只領先 294 B。' +
      '到 42 個就該把 astro.config 的 inlineStylesheets 改成 never —— ' +
      '這條紅燈就是那個時候到了。第 2 輪（第六圈）實測：' +
      '每頁 34–36 個、全站聯集 44 個，**不是每頁都一樣**，所以取單頁最大值。',
  },
  {
    label: '最大單一檔案',
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
     * 實測的數字（1600×900 的細節照片，`densities={[1,2]}`）：
     *   quality 82 → 1x 39.6 KB、**2x 272.9 KB**
     *   quality 50 → 1x  4.9 KB、**2x  94.1 KB**
     * 也就是說**光調品質救不回來，主因是 2 倍寬**。
     * 要嘛不出 2x、要嘛把這一條的上限拉高 —— 那是取捨，是站主的決定。
     */
    fix:
      biggestAsset.path.startsWith('_astro/') && /\.(webp|avif|jpe?g|png)$/i.test(biggestAsset.path)
        ? '這是 Astro 從 src/assets/ 產的圖，**已經是 WebP、解析度也是元件決定的** —— ' +
          '改不動那個檔案。兩條路：把來源圖匯出得小一點（或裁窄一點），' +
          '或者改 CoverImage.astro 的 densities（現在是 1x ＋ 2x，2x 是主因）。' +
          '實測 1600×900 的細節照片：quality 82 的 2x 是 273 KB，降到 50 也還有 94 KB。'
        : 'detail 那一行就是實際觸發的檔案。先問它能不能壓：圖片改 WebP／AVIF，或把解析度降到實際顯示的尺寸。',
    value: biggestAsset.raw,
    limit: 60 * 1024,
    detail: biggestAsset.path,
    why:
      '不含 HTML 與搜尋索引（那兩個有自己的預算）。目前最大的是 og/default.png，24.9 KB。' +
      '超過 60 KB 的靜態資源該先問是不是能壓 —— 上面 detail 那一行就是實際觸發的檔案。',
  },
  {
    label: '圖片合計',
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
const textFiles = files.filter((f) => isTextLike(f.path) && !OWN_BUDGET.has(f.path));
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
if (!process.argv.some((a) => a.startsWith('--dir='))) {
  const selfSrc = await readFile(new URL(import.meta.url), 'utf8');
  /** @type {string[]} */
  const drifted = [];
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
    const claim = /(?:目前|現在)[^。；]{0,14}?([0-9][0-9.]*)\s*KB/.exec(why);
    if (!claim) continue;
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
console.log(
  `  最大單頁：讀者實際下載 ${kb(worstPage.gzip)}（gzip —— GitHub Pages 只供應這個）`,
);
console.log(
  `  　　　　　同一份用 brotli 是 ${kb(br(worstPage.buf))}，少 ${Math.round((1 - br(worstPage.buf) / worstPage.gzip) * 100)}%` +
    `　—— 這個站拿不到，換一個會供應 brotli 的主機才有`,
);

/*
 * ── 上面那個數字是 level 9，而伺服器不是 ──────────────
 *
 * 這支腳本用 `gzipSync(buf, { level: 9 })`，也就是**壓到最小**。
 * 第 2 輪（第二十六圈）實測 GitHub Pages 真的送出去的大小 ——
 * 拿它們回應的 `content-length` 跟本機各個等級比對：
 *
 *     pages.github.com/           送 3844　最接近 level 4（3873）／level 6（3797）
 *     pages.github.com/versions/  送 2089　最接近 level 4（2093）
 *     squidfunk.github.io/        送 19242 落在 level 4 與 6 之間
 *
 * 也就是說伺服器大約壓到 **level 4–6**，不是 9。
 * 上面那句「讀者實際下載」因此是**最好的情況**：這個站量出來差 0.8–3.4%。
 *
 * 為什麼不乾脆改成 level 4：那也只是換一個猜測，而 level 9 至少是一個
 * 定義清楚的下界。改成印出來 —— 這樣哪天差距變大，報告裡看得到，
 * 而不是繼續把一個下界說成「讀者實際下載」。
 *
 * （這一圈問的是「壞了誰會告訴我們」。這一項本來的答案是「沒有人」：
 * 報告把 level 9 的數字說成事實，而沒有任何東西會去跟真的伺服器對。）
 */
const SERVER_LEVEL = 4;
const worstServer = gzipSync(worstPage.buf, { level: SERVER_LEVEL }).length;
console.log(
  `  　　　　　實際的伺服器壓得沒那麼用力（實測 Pages 約 level 4–6）：` +
    `level ${SERVER_LEVEL} 是 ${kb(worstServer)}，比上面多 ${((worstServer / worstPage.gzip - 1) * 100).toFixed(1)}%` +
    `　—— 預算量的是 level 9，也就是最好的情況`,
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
    scripts: a.scripts + p.requests.scripts,
    imgs: a.imgs + p.requests.imgs,
  }),
  { links: 0, scripts: 0, imgs: 0 },
);
/** @type {string[]} */
const empty = [];
if (images.length > 0 && rendered.length === 0) {
  empty.push(
    `圖片合計／最大單一檔案 —— ${images.length} 個圖片檔，頁面真的會載入的 0 個。\n` +
      '      全是 favicon、PWA 圖示與 og:image（瀏覽器外框與社群爬蟲抓的），\n' +
      '      不隨內容成長。綠是因為還沒有內容圖，不是因為內容圖有節制。',
  );
}
if (reqTotals.scripts === 0 || reqTotals.imgs === 0) {
  empty.push(
    `單頁請求數 —— ${html.length} 頁合計：stylesheet ${reqTotals.links} 個、` +
      `script src ${reqTotals.scripts} 個、img src ${reqTotals.imgs} 個。\n` +
      '      三項裡只有 stylesheet 數得到東西，另外兩項從來沒有過主體。',
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

console.log('\n' + '='.repeat(76));
console.log(
  over === 0 && staleDocs === 0
    ? '全部在預算內。\n'
    : `${over} 項超出預算${staleDocs > 0 ? `、${staleDocs} 條說明裡的數字過期` : ''}。\n`,
);
process.exit(over > 0 || staleDocs > 0 ? 1 : 0);
