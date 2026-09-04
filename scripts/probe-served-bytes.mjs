#!/usr/bin/env node
// @ts-check
/**
 * 讀者實際下載到幾個位元組 —— `npm run probe:served`
 *
 * ## 為什麼需要這一支
 *
 * `check:perf` 用 `gzipSync(buf, { level: 9 })` 量大小，然後把那個數字
 * 印成「讀者實際下載」。那是**推測**，不是量測 —— 伺服器壓到幾級沒人知道。
 *
 * 第 2 輪（第二十六圈）問過同一件事，但那時 `bellafoxy.com` 還沒上線，
 * 只能拿**別人的站**（`pages.github.com`、`squidfunk.github.io`）代打，
 * 推論出「伺服器大約壓到 level 4–6，不是 9」，於是報告開始印
 * 「實際的伺服器壓得沒那麼用力⋯⋯比上面多 2.3%」。
 *
 * 站在 2026-09-04 上線之後，量自己的站，結果**方向是反的**：
 *
 *     level 4   11005
 *     level 9   10754
 *     實際送出  10655   ← 比本機最高等級還少 99 bytes
 *
 * 也就是說 GitHub Pages 壓得**比 Node 的 zlib 最高等級還用力**
 * （多半是 zopfli 之類的）。報告那句話每一次都在往錯的方向誤導讀者。
 *
 * **代打量出來的結論，沒有人在真的東西出現時回頭重量。**
 * 所以這一支存在的意義不只是那個數字，是讓「回頭重量」變成一個指令。
 *
 * ## 為什麼不放進 verify:all
 *
 * 它要打網路，而且要站已經上線。六道關卡得在乾淨的 runner 上、
 * 沒有網路也能跑完。跟 `npm run verify -- --patterns` 同一個道理：
 * 打真網路的東西是**人手動跑的**。
 *
 * ## 判準
 *
 * 只有一條：**伺服器送出的不能比本機 level 9 多**。
 * 成立的話，`check:perf` 印的 gzip 數字就是一個安全的**上界** ——
 * 預算要守的正是上界。哪天不成立了（換了 CDN、換了壓縮實作），
 * 這一支會紅，而報告裡那句話就要跟著改。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (/** @type {string} */ name, /** @type {string} */ fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const BASE = arg('base', 'https://bellafoxy.com').replace(/\/$/, '');
const DIST = resolve(ROOT, arg('dir', 'dist'));

/**
 * 量哪幾頁。挑的是最大的幾頁加上兩種語言 ——
 * 壓縮率跟內容有關，只量一頁看不出來是不是碰巧。
 */
const PAGES = [
  ['/', 'index.html'],
  ['/en/', 'en/index.html'],
  ['/en/elsewhere/', 'en/elsewhere/index.html'],
  ['/poems/', 'poems/index.html'],
  ['/about/', 'about/index.html'],
];

const md5 = (/** @type {Buffer} */ b) => createHash('md5').update(b).digest('hex');

if (!existsSync(DIST)) {
  console.log(`\nX 找不到 ${DIST} —— 先跑 npm run build。\n`);
  process.exit(1);
}

console.log(`\n讀者實際下載到幾個位元組　${BASE}`);
console.log('='.repeat(78));

let overBudget = 0;
let unreachable = 0;
let checked = 0;
let skipped = 0;
/**
 * 線上那一份跟本機 dist 不一樣的頁。
 *
 * **這不算失敗。** `identity.local.ts` 在 `.gitignore` 裡，CI 拿不到它，
 * 所以有那個檔案的機器上建出來的 `/about` 會多一段個資，線上那一份沒有。
 * 那是隱私設計要的結果 —— `ci:sim` 也是同樣的處理（「不一樣不算失敗」）。
 *
 * 但要說出來，而且要從壓縮率的統計裡排除掉：拿兩份不同的內容比壓縮率
 * 沒有意義。
 * @type {string[]}
 */
const mismatched = [];
/** @type {number[]} */
const ratios = [];

for (const [path, file] of PAGES) {
  const local = join(DIST, file);
  if (!existsSync(local)) {
    console.log(`  · ${path.padEnd(18)} 本機沒有 ${file}，跳過`);
    skipped++;
    continue;
  }
  const buf = await readFile(local);

  let res;
  try {
    /*
     * 明講只收 gzip。不指定的話 `fetch` 會自己送一串 Accept-Encoding，
     * 而我們要量的是「gzip 這條路上伺服器送幾個位元組」。
     */
    res = await fetch(BASE + path, { headers: { 'accept-encoding': 'gzip' }, redirect: 'follow' });
  } catch (err) {
    console.log(`  X ${path.padEnd(18)} 連不上：${err instanceof Error ? err.message : String(err)}`);
    unreachable++;
    continue;
  }

  const encoding = res.headers.get('content-encoding');
  const served = Number(res.headers.get('content-length') ?? 0);
  const body = Buffer.from(await res.arrayBuffer());

  /*
   * `fetch` 會自己解壓，所以拿到的 body 是解開後的。
   * 但如果它沒解（有些執行環境不解），就自己解一次 ——
   * 兩種情況都要能比對，否則這支腳本會在別人的 Node 版本上莫名其妙地紅。
   */
  let plain = body;
  if (encoding === 'gzip' && body.length === served) {
    try {
      plain = gunzipSync(body);
    } catch {
      /* 已經是解開的，維持原樣 */
    }
  }

  if (md5(plain) !== md5(buf)) {
    console.log(
      `  · ${path.padEnd(18)} 線上跟本機 dist 不一樣（線上 ${plain.length}、本機 ${buf.length} bytes）—— 這一頁不列入統計`,
    );
    mismatched.push(path);
    continue;
  }

  const level9 = gzipSync(buf, { level: 9 }).length;
  const ratio = served / level9 - 1;
  ratios.push(ratio);
  checked++;

  const verdict = served <= level9 ? '✓' : 'X';
  if (served > level9) overBudget++;
  console.log(
    `  ${verdict} ${path.padEnd(18)} 送出 ${String(served).padStart(6)}　本機 level 9 ${String(level9).padStart(6)}　` +
      `差 ${(ratio * 100).toFixed(1).padStart(5)}%`,
  );
}

console.log('-'.repeat(78));

if (mismatched.length > 0) {
  console.log(
    `\n  有 ${mismatched.length} 頁線上跟本機不一樣：${mismatched.join('、')}\n` +
      `  有 src/config/identity.local.ts 的話這是正常的 —— 那些值只在你的機器上，\n` +
      `  CI 拿不到，所以線上那一份少了它們（見 docs/PRIVACY.md）。\n` +
      `  **全部**都不一樣的話才要懷疑是部署還沒跑完。`,
  );
}

if (checked === 0) {
  console.log(
    `\nX 一頁都沒有量到 —— 這不是「沒問題」，是「什麼都沒量」。\n` +
      `  跳過 ${skipped} 頁（本機找不到）、連不上 ${unreachable} 頁、` +
      `內容不一樣 ${mismatched.length} 頁。\n` +
      `  改法：先 npm run build；站還沒上線的話用 --base= 指到別的地方。\n`,
  );
  process.exit(1);
}

const lo = Math.min(...ratios) * 100;
const hi = Math.max(...ratios) * 100;
console.log(`  量了 ${checked} 頁${skipped ? `（跳過 ${skipped} 頁）` : ''}　差距 ${lo.toFixed(1)}% ～ ${hi.toFixed(1)}%`);

if (overBudget === 0 && unreachable === 0) {
  console.log(
    `\n伺服器送出的都沒有比本機 level 9 多。\n` +
      `所以 check:perf 印的 gzip 數字是**上界** —— 預算要守的正是上界。\n` +
      `這個範圍變了就要回去改 check-perf.mjs 裡那一行說明。\n`,
  );
  process.exit(0);
}

if (unreachable > 0 && overBudget === 0) {
  console.log(`\nX ${unreachable} 頁連不上。量到的那幾頁沒有超過 level 9，但這一輪不算跑完。\n`);
  process.exit(1);
}

console.log(
  `\nX ${overBudget} 頁的實際下載量**超過**本機 level 9。\n` +
    `  那表示 check:perf 印的數字不再是上界，而是低估 ——\n` +
    `  報告會告訴讀者一個比實際小的量。\n` +
    `  改法：把 check-perf.mjs 裡那一行說明改成實測的範圍，\n` +
    `  必要時把預算門檻按同樣的比例調緊。\n`,
);
process.exit(1);
