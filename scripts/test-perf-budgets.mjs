#!/usr/bin/env node
// @ts-check
/**
 * 效能預算的實測 —— `npm run test:perf-budgets`
 *
 * 每一條預算做一份「剛好超過它」的假 dist，跑 check-perf，確認那條會擋。
 * 另外做一份小的，確認不誤報。
 *
 * ## 為什麼需要這個
 *
 * 第 2 輪（第三圈）發現「最大單一檔案」用 raw 去量壓縮率 12.8:1 的 XML，
 * 結論完全沒有意義；第 3 輪（第三圈）發現假資料太好壓，
 * 所有 gzip 相關的規模數字都樂觀。兩件事的共同點是：
 * **預算看起來在運作，實際上量錯了東西。**
 *
 * 「這條預算會不會在該擋的時候擋」跟「這條預算存在」是兩件事。
 * 第 1 輪（第四圈）已經對 22 條無障礙規則做過同樣的事，這裡是效能版。
 *
 * ## 假資料為什麼要用亂數
 *
 * 大部分預算量的是 gzip 之後的大小。重複的內容壓縮率可以到 20:1，
 * 那樣要塞很大的檔案才會超標，測起來又慢又不像真的。
 * 用亂數產生的內容幾乎壓不動，1 KB 就是 1 KB。
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * 幾乎壓不動的文字，長度以 bytes 計。
 *
 * **用 base64 不用 hex。** 第一版用 hex，而 hex 只有 16 種字元，
 * gzip 還是壓得掉一半（實測 1.9:1）—— 於是好幾個 gzip 預算的假資料
 * 根本沒超標，測試報「這條沒擋」，但問題在假資料不在預算。
 *
 * 這跟第 3 輪（第三圈）踩的是同一個錯：**對假資料的壓縮率想當然耳。**
 * base64 有 64 種字元，實測 1.33:1，接近壓不動。
 */
const noise = (/** @type {number} */ n) =>
  randomBytes(Math.ceil((n * 3) / 4)).toString('base64').slice(0, n);

/** @param {{ head?: string, body?: string }} [o] */
const page = ({ head = '', body = '' } = {}) =>
  `<!DOCTYPE html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><title>x</title>${head}</head><body>${body}</body></html>`;

/*
 * 「這一份 fixture 全部在預算內嗎」—— 只認**結尾那一行**。
 *
 * 第 2 輪（第二十五圈）量到的：原本三格寫的是 `out.includes('全部在預算內')`，
 * 而 check-perf.mjs 在「少了一條預算」時會印
 *
 *     少一條預算跟「全部在預算內」在輸出上長得一樣，所以要說出來。
 *
 * 那句**解釋**裡就有那七個字。於是把整支腳本改成「每一條都超標」之後，
 * 結尾印的是「9 項超出預算」，而那三格**照樣是綠的** ——
 * 它們比對到的是那句解釋，不是判決。
 *
 * 這是這個 repo 第八次踩到同一個形狀：解釋一條規則，就會需要寫出它禁止的東西。
 * 前七次都是規則誤報自己的文件，這次是**測試被自己的說明餵飽了**。
 *
 */
const verdictOk = (/** @type {string} */ out) => /^全部在預算內。$/m.test(out);

/**
 * 每條預算一份假 dist。key 是 label 的一部分，用來確認擋的是**那一條**。
 *
 * 值可以是「檔案表」，也可以是 `{ files, expect }` —— `expect` 用來覆寫
 * 要比對的預算標籤，讓同一條預算能有第二個案例（案例名取的是情境）。
 *
 * @type {Record<string, Record<string, string> | { expect?: string, files: Record<string, string>, mustNotBlock?: string, coBlocks?: string[] }>}
 */
const CASES = {
  '最大單頁 HTML': {
    expect: '最大單頁 HTML',
    /*
     * 「首次造訪關鍵路徑」＝ HTML ＋ 阻塞渲染的 CSS，所以它**必然 ≥ HTML**。
     * HTML 超標的話那一條一定跟著超 —— 這是結構性的，不是 fixture 太粗。
     */
    coBlocks: ['首次造訪關鍵路徑'],
    files: { 'index.html': page({ body: noise(60_000) }) },
  },
  /*
   * 這一條的價值在於「HTML 與 CSS **各自都沒超標**，但加起來超了」——
   * 那正是第 2 輪（第二圈）加它的理由：只看 HTML 的話，
   * 關卡會在頁面早就變重之後才發現。
   *
   * 所以 fixture 要刻意讓兩邊都待在各自的門檻底下。
   * 第 2 輪（第九圈）之前是 24 KB + 24 KB，兩條單獨的預算也一起響 ——
   * 那樣它證明不了自己獨有的東西。
   */
  '首次造訪關鍵路徑': {
    'index.html': page({ head: '<link rel="stylesheet" href="/_astro/a.css">', body: noise(16_000) }),
    '_astro/a.css': `/*${noise(16_000)}*/`,
  },
  '全站 CSS 合計': { 'index.html': page(), '_astro/a.css': `/*${noise(30_000)}*/` },
  /*
   * 內嵌 <style> 也算 CSS。第 2 輪（第八圈）之前這條只數 dist/**.css，
   * 所以「加一個帶 scoped style 的元件」不會讓它動 —— 而那正是它要守的東西。
   * 這個案例沒有任何 .css 檔，全部的量都在 HTML 裡。
   */
  '全站 CSS 合計（內嵌的也要算）': {
    expect: '全站 CSS 合計',
    /*
     * 分散在多頁，每頁都很小 —— 那才是真實的情況
     * （加元件 → Astro 內嵌它的 scoped style → 每頁多一點點）。
     * 第 2 輪（第九圈）之前是單頁 30 KB，連「最大單頁 HTML」也一起響。
     */
    files: Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        i === 0 ? 'index.html' : `p${i}/index.html`,
        page({ head: `<style>/*${noise(4_000)}*/</style>` }),
      ]),
    ),
  },
  '一般頁面內嵌 JS': { 'index.html': page({ body: `<script>/*${noise(5_000)}*/</script>` }) },
  '最大單頁內嵌 JS': { 'search/index.html': page({ body: `<script>/*${noise(9_000)}*/</script>` }) },
  /*
   * 反向案例：只有搜尋頁的時候，「一般頁面內嵌 JS」**不該**響。
   *
   * 第 2 輪（第九圈）之前它會響 —— reduce 的種子是 `pageStats[0]`（含搜尋頁），
   * 所以那條預算量到的就是被它排除掉的那一頁。
   * 這裡用 `mustNotBlock` 宣告「這條不該擋」。
   */
  '一般頁面內嵌 JS（只有搜尋頁時不該響）': {
    expect: '最大單頁內嵌 JS',
    mustNotBlock: '一般頁面內嵌 JS',
    files: { 'search/index.html': page({ body: `<script>/*${noise(9_000)}*/</script>` }) },
  },
  /*
   * `rel="preload stylesheet"` 是合法寫法，瀏覽器會抓。
   * 舊的判斷是找字串 `rel="stylesheet"`，這種多值寫法一個都數不到。
   */
  '單頁請求數（rel 多值也算）': {
    expect: '單頁請求數',
    files: {
      'index.html': page({
        head: Array.from(
          { length: 5 },
          (_, i) => `<link rel="preload stylesheet" href="/${i}.css">`,
        ).join(''),
      }),
    },
  },
  '單頁請求數': {
    'index.html': page({
      head: '<link rel="stylesheet" href="/a.css">',
      body: '<img src="/1.png"><img src="/2.png"><img src="/3.png"><img src="/4.png"><script src="/x.js"></script>',
    }),
  },
  /*
   * 42 個雜湊 = 觸發點。這條預算擋的不是「變慢」，是「該換 inlineStylesheets 了」，
   * 所以案例就是把 CSP 塞到剛好超過門檻。
   */
  'CSP 雜湊數': {
    'index.html': page({
      head:
        '<meta http-equiv="content-security-policy" content="script-src ' +
        Array.from({ length: 42 }, (_, i) => `'sha256-${'a'.repeat(42)}${i}='`).join(' ') +
        '">',
    }),
  },
  '最大單一檔案': { 'index.html': page(), 'big.bin': noise(70_000) },
  '圖片合計': Object.fromEntries([
    ['index.html', page()],
    ...Array.from({ length: 8 }, (_, i) => [`img/${i}.png`, noise(45_000)]),
  ]),
  '最大的文字資源（gzip）': { 'index.html': page(), 'rss-all.xml': `<rss>${noise(80_000)}</rss>` },
  /*
   * 同一條預算的第二個案例：**CSS 也是純文字**。
   *
   * 第 2 輪（第十六圈）之前，`.css` 走的是「最大單一檔案」那把量圖片的 raw 尺 ——
   * 而站上兩份 CSS 的壓縮率是 3.5:1 與 4.9:1。名單補過三次（搜尋索引、RSS、
   * sitemap）都還是漏，所以改成依副檔名分類；這一格證明 CSS 真的走到了新那條。
   */
  '最大的文字資源（CSS 也算）': {
    expect: '最大的文字資源（gzip）',
    coBlocks: ['全站 CSS 合計'],
    files: { 'index.html': page(), '_astro/big.css': noise(80_000) },
  },
  '搜尋索引': { 'index.html': page(), 'search-index.json': `{"n":1,"items":"${noise(120_000)}"}` },
};

let failed = 0;
console.log('\n效能預算實測');
console.log('─'.repeat(64));

/*
 * ── 誤報探針：壓得動的大文字檔不該被擋 ──────────────
 *
 * 第 2 輪（第十六圈）的誤報探針量到兩個：多一份 `rss-poems.xml`
 * （100 KB 原始、壓完約 5 KB）與一份 `llms.txt`（80 KB 原始）
 * 都會被「最大單一檔案」擋下來 —— 而使用者下載的是壓縮後的量，
 * 那兩份都不是效能問題。
 *
 * 這裡用**重複性高**的內容（真的 feed 與說明檔就長這樣），壓縮率很高；
 * 上面那些案例刻意用亂數，是為了「壓不動」才超標 —— 兩種都要有。
 */
{
  const repeated = '<item><title>靜夜思</title><link>https://example.com/x</link></item>\n'.repeat(1400);
  const dir = await mkdtemp(join(tmpdir(), 'perf-textfp-'));
  await writeFile(join(dir, 'index.html'), page({ body: '<p>小</p>' }), 'utf8');
  await writeFile(join(dir, 'rss-poems.xml'), repeated, 'utf8');
  await writeFile(join(dir, 'llms.txt'), repeated, 'utf8');
  const out = await check(dir);
  const ok = verdictOk(out);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 壓得動的大文字檔不算超標`);
  if (!ok) {
    console.log(out.split('\n').filter((l) => l.includes('X ')).map((l) => '      ' + l).join('\n'));
  }
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 每一條預算都要說得出「改法」──────────────────────
 *
 * 第 2 輪（第十七圈）量到：11 條預算的 `why` 是 37–358 字的來歷與分析，
 * 而「現在該做什麼」散在裡面（有的在開頭、有的在最後、`圖片合計` 根本沒有）。
 * 站主看到紅燈時要的是下一步。
 *
 * 這一格守兩件事：每條預算都有 `fix`，而且超標時真的印出來。
 */
{
  const src = await readFile(resolve(ROOT, 'scripts/check-perf.mjs'), 'utf8');
  const labels = [...src.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
  /*
   * `fix` 不一定是字串字面值 —— 第 2 輪（第二十圈）之後，「最大單一檔案」
   * 的改法會依觸發的是不是 Astro 產的圖而不同，寫成三元運算式。
   * 所以這裡只問「這個 label 後面有沒有 fix:」，內容由下面那一格驗
   * （它會真的跑一次、要求「改法：」後面有字）。
   */
  const withFix = [...src.matchAll(/label:\s*'([^']+)',[\s\S]{0,1600}?\n\s*fix:/g)].map((m) => m[1]);
  const missing = labels.filter((l) => !withFix.includes(l));
  if (missing.length > 0) {
    failed += missing.length;
    console.log(`\n  X 這些預算沒有寫 fix：${missing.join('、')}`);
    console.log('      超標的時候站主只會看到一段來歷，不知道下一步要做什麼。');
  } else {
    console.log(`  ✓ ${labels.length} 條預算都寫了「改法」`);
  }

  /* 真的超標時要印出來 —— 有欄位但沒印等於沒有 */
  const dir = await mkdtemp(join(tmpdir(), 'perf-fix-'));
  await writeFile(join(dir, 'index.html'), page({ body: `<p>${noise(20_000)}</p>` }), 'utf8');
  const out = await check(dir);
  /*
   * 要求「改法：」後面**真的有字**。只比對前綴的話，
   * 印成空字串的版本會通過 —— 突變掃描量到的。
   */
  const line = out.split('\n').find((l) => l.includes('改法：')) ?? '';
  const printed = line.split('改法：')[1]?.trim().length >= 10;
  if (!printed) failed++;
  console.log(`  ${printed ? '✓' : 'X'} 超標時真的印出改法（而且不是空的）`);
  if (!printed) console.log(`        實際：${line.trim() || '（完全沒有那一行）'}`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── Astro 產的圖，改法要不一樣 ──────────────────────
 *
 * 第 2 輪（第二十圈）第一次讓 `cover` 真的有圖之後量到的：
 * 觸發「最大單一檔案」的是 `_astro/⋯.webp`，而原本的建議是
 * 「改成 WebP／降解析度」—— 兩件事都已經做了，而且那個路徑改不動。
 *
 * 兩格一起：是 Astro 產的圖時要說新的，不是的時候要維持舊的。
 */
{
  const gen = await mkdtemp(join(tmpdir(), 'perf-astroimg-'));
  await mkdir(join(gen, '_astro'), { recursive: true });
  await writeFile(join(gen, 'index.html'), page(), 'utf8');
  await writeFile(join(gen, '_astro', 'cover.abc123_x.webp'), noise(70_000));
  const out = await check(gen);
  const ok = out.includes('densities') && out.includes('已經是 WebP');
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 觸發的是 Astro 產的圖：改法講來源圖與 densities`);
  if (!ok) console.log(`        實際：${out.split('\n').find((l) => l.includes('改法：'))?.trim() ?? '（沒有改法那一行）'}`);
  await rm(gen, { recursive: true, force: true });

  const plain = await mkdtemp(join(tmpdir(), 'perf-plainfile-'));
  await writeFile(join(plain, 'index.html'), page(), 'utf8');
  await writeFile(join(plain, 'big.bin'), noise(70_000));
  const out2 = await check(plain);
  const ok2 = out2.includes('先問它能不能壓') && !out2.includes('densities');
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} 觸發的不是 Astro 產的圖：維持原本的改法（反向案例）`);
  await rm(plain, { recursive: true, force: true });
}

/*
 * ── 整條不見的預算要說出來 ──────────────────────────
 *
 * 第 2 輪（第二十一圈）實測：把 dist/search-index.json 刪掉，
 * 十一條預算變十條、結尾照樣印「全部在預算內」，一個字都沒提。
 * 那正是站內搜尋整個壞掉時的樣子。
 *
 * 兩格：不在的時候要說、在的時候不要多話。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-missing-'));
  await writeFile(join(dir, 'index.html'), page(), 'utf8');
  await writeFile(join(dir, 'rss.xml'), '<rss><channel><title>x</title></channel></rss>', 'utf8');
  const out = await check(dir);
  const ok1 = out.includes('少了 1 條預算') && out.includes('search-index.json');
  if (!ok1) failed++;
  console.log(`  ${ok1 ? '✓' : 'X'} 沒有 search-index.json：說「少了一條預算」`);
  if (!ok1) console.log(`        實際：${out.split('\n').filter((l) => l.includes('預算')).slice(0, 3).join(' / ')}`);
  await rm(dir, { recursive: true, force: true });

  const full = await mkdtemp(join(tmpdir(), 'perf-full-'));
  await writeFile(join(full, 'index.html'), page(), 'utf8');
  await writeFile(join(full, 'rss.xml'), '<rss><channel><title>x</title></channel></rss>', 'utf8');
  await writeFile(join(full, 'search-index.json'), JSON.stringify([{ t: '一' }]), 'utf8');
  const out2 = await check(full);
  const ok2 = !out2.includes('少了') && out2.includes('搜尋索引');
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} 索引在的時候不說那句話（反向案例）`);
  await rm(full, { recursive: true, force: true });
}

/*
 * ── 「讀者實際下載」那一行說的是最好的情況 ──────────
 *
 * 這支腳本用 level 9（壓到最小）。第 2 輪（第二十六圈）拿 GitHub Pages
 * 真的送出去的 `content-length` 比對過：伺服器大約壓到 level 4–6，不是 9。
 *
 * 所以報告要同時印出「伺服器比較像的那個等級」的數字 ——
 * 否則一個下界會被當成事實，而**沒有任何東西會去跟真的伺服器對**。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-level-'));
  await writeFile(join(dir, 'index.html'), page({ body: `<p>${noise(20_000)}</p>` }), 'utf8');
  const out = await check(dir);
  const line = out.split('\n').find((l) => l.includes('壓得沒那麼用力')) ?? '';
  const nums = [...line.matchAll(/([\d.]+) KB/g)].map((m) => Number(m[1]));
  const worst = Number(/讀者實際下載 ([\d.]+) KB/.exec(out)?.[1] ?? 0);
  const ok1 = line !== '' && nums.length > 0 && worst > 0;
  if (!ok1) failed++;
  console.log(`  ${ok1 ? '✓' : 'X'} 印得出「伺服器壓得沒那麼用力」那一行`);
  if (!ok1) console.log('        ' + (line || '（那一行完全沒印）'));

  /*
   * 那一行講的等級必須**比 9 小**，否則它等於什麼都沒說。
   *
   * 第一版是比「那個數字要比 level 9 的大」，結果紅了 —— 而那是**語料的錯**：
   * 測試用的 `noise()` 是隨機 base64，壓不動，level 4 跟 9 一樣大；
   * 換成高度重複的文字也一樣（兩邊都壓到極限）。
   * 真實頁面才分得開（實測首頁 10.50 vs 10.75 KB）。
   * 所以這裡守的是**判準的形狀**，不是某一份語料的數字。
   */
  /*
   * 抓的是「level N **是**」那一個，不是同一行裡「實測 Pages 約 level 4–6」
   * 那個**說明**。第一版寫 `/level (\d+)/`，配到的是說明裡的 4 ——
   * 於是把 SERVER_LEVEL 改成 9 這個突變照樣綠。
   * 這個 repo 第十次踩到「解釋一件事，就會需要寫出它要比對的東西」。
   */
  const level = Number(/level (\d+) 是/.exec(line)?.[1] ?? 9);
  const ok2 = level < 9;
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} 那一行講的等級比 9 小（不然等於沒說）`);
  if (!ok2) console.log(`        那一行說的是 level ${level}`);
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── verdictOk 分不分得出「判決」與「說明」──────────
 *
 * 上面三格靠 verdictOk 判斷「這份 fixture 沒有超標」。那個判準要有意義，
 * 前提是**真的超標時它會是 false**。
 *
 * 沒有這一格的話，把 verdictOk 寫回 `includes('全部在預算內')` 不會有人紅 ——
 * 而那正是第 2 輪（第二十五圈）之前的狀態：三格全綠，而它們比對到的是
 * 「少一條預算跟『全部在預算內』在輸出上長得一樣」那句**解釋**。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-verdict-'));
  await writeFile(join(dir, 'index.html'), page({ body: `<p>${noise(200_000)}</p>` }), 'utf8');
  const out = await check(dir);
  const ok = !verdictOk(out) && /超出預算/.test(out);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 真的超標時 verdictOk 是 false（判準分得出判決與說明）`);
  if (!ok) console.log('        ' + out.split('\n').slice(-3).join('\n        '));
  await rm(dir, { recursive: true, force: true });
}

// 乾淨的一份：一頁小 HTML，什麼都不該超標
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-clean-'));
  await writeFile(join(dir, 'index.html'), page({ body: '<p>小</p>' }), 'utf8');
  const out = await check(dir);
  const ok = verdictOk(out);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 小網站不誤報`);
  if (!ok) console.log(out.split('\n').filter((l) => l.includes('X ')).map((l) => '      ' + l).join('\n'));
  await rm(dir, { recursive: true, force: true });
}

/*
 * `data-src` 不是請求。
 *
 * 這份 fixture 一條預算都不該擋：真正的請求只有 1 個（那份樣式表），
 * 另外 5 個是 `data-src` / `data-srcset`，瀏覽器不會去抓。
 *
 * 為什麼要專門測：舊的寫法是 `/<img[^>]*\bsrc=/`，而 `\b` 在 `-` 與 `s`
 * 之間成立，所以 `data-src` 會被數成 `src`，這份 fixture 會報 6 個請求而超標。
 * 這個 repo 已經因為同一個 `\b` 踩過兩次（`data-lang` 被讀成 `lang`），
 * 而 dist 裡沒有任何 `data-src`，靠實際輸出永遠量不到 —— 只能靠這裡。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-datasrc-'));
  await writeFile(
    join(dir, 'index.html'),
    page({
      head: '<link rel="stylesheet" href="/a.css">',
      /*
       * 5 個而不是 3 個：上限是 4，而判斷是 `value <= limit`。
       * 第一版只放 3 個 data-src，突變版算出來剛好 4/4 —— **通過**，
       * 於是這個案例證明不了任何事。案例的規模要能真的越過門檻。
       */
      body:
        '<img data-src="/1.png" alt=""><img data-src="/2.png" alt=""><img data-src="/3.png" alt="">' +
        '<img data-src="/4.png" alt=""><img data-srcset="/5.png 2x" alt=""><img data-src="/6.png" alt="">' +
        '<script data-src="/a.js"></script><script data-src="/b.js"></script>' +
        '<script data-src="/c.js"></script><script data-src="/d.js"></script>' +
        '<script data-src="/e.js"></script>',
    }),
    'utf8',
  );
  await writeFile(join(dir, 'a.css'), 'p{color:#000}', 'utf8');
  const out = await check(dir);
  const ok = verdictOk(out);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} data-src 不算成請求`);
  if (!ok) {
    console.log(out.split('\n').filter((l) => l.includes('X ')).map((l) => '      ' + l).join('\n'));
  }
  await rm(dir, { recursive: true, force: true });
}

/*
 * 「頁面真的會載入的圖片」數得對不對。
 *
 * 這條不是預算，是第 2 輪（第十五圈）加的說明行：dist 裡有 7 個圖片檔，
 * 但一個都不是頁面載入的（全是 favicon 與 og:image），於是「圖片合計」
 * 是綠的卻什麼都沒在守。要讓那行話可信，它得會因為有沒有 `<img>` 而改變。
 */
{
  const png = 'x'.repeat(200);
  for (const [name, body, css, wantNote] of /** @type {[string, string, string, boolean][]} */ ([
    ['沒有 <img> 時說得出「0 個」', '<p>小</p>', '', true],
    ['有 <img src> 時就不說了', '<img src="/og/default.png" alt="">', '', false],
    ['<img srcset> 也算', '<img srcset="/og/default.png 2x" alt="">', '', false],
    ['CSS 的 url() 也算', '<p>小</p>', '.a{background:url(/og/default.png)}', false],
    ['引到別的檔案不算', '<img src="/nope.png" alt="">', '', true],
  ])) {
    const dir = await mkdtemp(join(tmpdir(), 'perf-rendered-'));
    await mkdir(join(dir, 'og'), { recursive: true });
    await writeFile(join(dir, 'og', 'default.png'), png, 'utf8');
    await writeFile(
      join(dir, 'index.html'),
      page({ head: css ? '<link rel="stylesheet" href="/a.css">' : '', body }),
      'utf8',
    );
    if (css) await writeFile(join(dir, 'a.css'), css, 'utf8');
    const out = await check(dir);
    const ok = out.includes('頁面真的會載入的 0 個') === wantNote;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} ${name}`);
    await rm(dir, { recursive: true, force: true });
  }
}

for (const [key, value] of Object.entries(CASES)) {
  /*
   * 值可以是「檔案表」，也可以是 `{ files, expect }` ——
   * `expect` 讓同一條預算有第二個案例（案例名取情境，比對的仍是那條預算的標籤）。
   * 第 2 輪（第八圈）加「全站 CSS 合計」的內嵌案例時需要的。
   */
  const files = /** @type {any} */ (value).files ?? value;
  const label = /** @type {any} */ (value).expect ?? key;
  const mustNotBlock = /** @type {any} */ (value).mustNotBlock;
  const coBlocks = /** @type {string[]} */ (/** @type {any} */ (value).coBlocks ?? []);
  const dir = await mkdtemp(join(tmpdir(), 'perf-one-'));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }
  const out = await check(dir);
  // 擋下來的那幾條裡有沒有這一條
  const blocked = out.split('\n').filter((l) => l.trim().startsWith('X ')).join('\n');
  const fired = blocked.includes(label);
  if (!fired) failed++;
  if (mustNotBlock && blocked.includes(mustNotBlock)) {
    failed++;
    console.log(`      「${mustNotBlock}」不該被這份 fixture 擋下來，但它擋了。`);
  }
  /*
   * 順帶擋到別條要先宣告。**一份同時撞破好幾條預算的 fixture，
   * 證明不了是哪一條讓它綠的** —— 而且通常代表那條預算獨有的價值沒被測到
   * （第 2 輪〔第九圈〕就是這樣發現「首次造訪關鍵路徑」的案例
   * 連 HTML 與 CSS 兩條也一起撞破，於是它證明不了「各自都沒超、加起來超了」）。
   */
  const alsoBlocked = blocked
    .split('\n')
    .map((l) => l.replace(/^\s*X\s*/, '').trim())
    .filter(Boolean)
    .filter((l) => !l.includes(label) && !coBlocks.some((c2) => l.includes(c2)));
  if (alsoBlocked.length > 0) {
    failed++;
    console.log(`      這份 fixture 還順帶擋下了沒宣告的預算：${alsoBlocked.map((l) => l.split(' ')[0]).join('、')}`);
    console.log('      要嘛把 fixture 收窄，要嘛在 coBlocks 裡寫出來。');
  }
  console.log(`  ${fired ? '✓' : 'X'} ${key}`);
  if (!fired) console.log(`      實際擋下的是：${blocked.replace(/\s+/g, ' ').trim() || '（一條都沒擋）'}`);
  await rm(dir, { recursive: true, force: true });
}

// 有沒有預算漏了案例
{
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(resolve(ROOT, 'scripts/check-perf.mjs'), 'utf8'),
  );
  const labels = [...source.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
  const missing = labels.filter((l) => !Object.keys(CASES).some((k) => l.includes(k)));
  if (missing.length > 0) {
    failed += missing.length;
    console.log(`\n  X 這些預算沒有測試案例：${missing.join('、')}`);
    console.log('      加預算就要加案例 —— 沒有案例的預算等於沒有人確認過它會擋。');
  }
}

/*
 * ── 不要再說 brotli 是「讀者拿到的」──────────────────
 *
 * 第 2 輪（第二十二圈）實測：這個站要部署在 GitHub Pages 上，
 * 而 **Pages 不供應 brotli**（兩個 `server: GitHub.com` 的主機都回 gzip，
 * 帶著瀏覽器真正會送的 `Accept-Encoding: gzip, deflate, br, zstd`）。
 *
 * 那一行原本寫「brotli，現代瀏覽器拿到的」—— 一個看起來已經量過、
 * 其實只在我的機器上成立的數字，而且差 19%。
 *
 * 這一格守的是措辭：報告要說得出「讀者拿到的是 gzip」，
 * 而且不能把 brotli 講成讀者拿得到的東西。措辭會漂，所以用兩個方向釘：
 * 該有的字要在，不該有的字不能回來。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-brotli-'));
  await writeFile(join(dir, 'index.html'), page({ body: '<p>小</p>' }), 'utf8');
  const out = await check(dir);
  const saysGzip = /讀者實際下載.*gzip/.test(out);
  const noFalseClaim = !/brotli[^\n]*現代瀏覽器拿到的/.test(out);
  const stillShowsBrotli = /brotli/.test(out);

  for (const [name, ok] of [
    ['報告說得出「讀者實際下載⋯gzip」', saysGzip],
    ['沒有再把 brotli 說成「現代瀏覽器拿到的」', noFalseClaim],
    ['brotli 的數字仍然印得出來（換主機才有意義）', stillShowsBrotli],
  ]) {
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  }
  if (!saysGzip) {
    console.log('      ' + out.split('\n').filter((l) => /下載|brotli/.test(l)).join(' ｜ '));
  }
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 說明裡的數字不能安靜地過期 ────────────────────────
 *
 * 每條預算的 `why` 裡都會提到當時的實際值，而報告本身每次都會印真的值 ——
 * **同一個事實的兩份說法**。第 2 輪（第二十四圈）逐條比對，
 * 七條裡有兩條差了 35% 與 59%。
 *
 * 這一格守的是那個比對本身：它要抓得到、而且要**擋得住**
 * （第一版只印訊息、離開碼還是 0，等於沒擋）。
 */
{
  /*
   * 這一組**要跑真的 dist**（不給 `--dir=`）—— 那些數字說的是這個站現在多大，
   * 拿去跟假站比沒有意義。第一版用假站跑，一次紅了 18 格。
   */
  /** @param {string[]} args */
  const runPerf = async (args = []) => {
    try {
      const r = await run('node', [resolve(ROOT, 'scripts/check-perf.mjs'), ...args]);
      return { out: r.stdout, code: 0 };
    } catch (err) {
      const e = /** @type {{ stdout?: string, code?: number }} */ (err);
      return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1 };
    }
  };

  /*
   * ── 這兩格需要真的 dist/，而 test:units 不一定有 ──────────
   *
   * 第 7 輪（第二十六圈）跑 `npm run ci:sim` 紅了一格。原因是這兩格
   * 呼叫 `runPerf()` **不帶 `--dir=`** —— 它量的是真的 `dist/`。
   * 而 `deploy.yml` 的順序是
   *
   *     test:units  →  verify:all（裡面才 build）  →  test:built
   *
   * 那一步的名字就叫「工具的單元測試（**不需要 dist 的那些**）」。
   * 在乾淨的 runner 上跑到這裡時 `dist/` 還不存在，於是：
   *
   *   - 「抓得到而且擋得住」那一格**紅**（真的部署會停在這裡）
   *   - 「沒過期時不報」那一格**綠**，而它是空的 —— 輸出裡本來就沒有那句話
   *
   * 一紅一假綠，而且是同一個原因。
   *
   * 這裡不改成「用假站測」（第 2 輪〔第二十四圈〕記過：漂移檢查刻意只在
   * 量真的 dist 時才跑，拿假站比一次紅了 18 格）。改成**沒有就明講沒查**。
   * CI 上真正在守這件事的是 `verify:all` 裡的 `check:perf` 本身 ——
   * 它在 build 之後跑，漂移超過門檻就擋。
   */
  const hasDist = await readFile(resolve(ROOT, 'dist/index.html'), 'utf8').then(
    () => true,
    () => false,
  );
  if (!hasDist) {
    console.log('  · 說明數字的漂移檢查：沒有 dist/，這兩格沒有檢查');
    console.log('      （CI 上 test:units 跑在 build 之前。真正在守它的是 verify:all 裡的 check:perf。）');
  } else {
  const clean = (await runPerf()).out;
  const okQuiet = !clean.includes('說明裡的數字過期');
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} 說明裡的數字沒過期時不報（反向案例）`);

  /*
   * 然後把腳本自己的一句說明改成過期的值，確認它抓得到 —— 而且離開碼是 1。
   * 用 scripts/mutate.mjs 那一套的做法：改完一定要還原。
   */
  const perfPath = resolve(ROOT, 'scripts/check-perf.mjs');
  const original = await readFile(perfPath, 'utf8');
  const from = '現在約 10.4 KB';
  const okHasAnchor = original.includes(from);
  if (!okHasAnchor) failed++;
  console.log(`  ${okHasAnchor ? '✓' : 'X'} 找得到那句要改的說明（找不到的話下一格什麼都沒測）`);

  if (okHasAnchor) {
    await writeFile(perfPath, original.replace(from, '現在約 3.2 KB'), 'utf8');
    const { out, code } = await runPerf();
    await writeFile(perfPath, original, 'utf8');

    const okCatch = /說明裡的數字過期/.test(out) && code === 1;
    if (!okCatch) failed++;
    console.log(`  ${okCatch ? '✓' : 'X'} 數字過期時抓得到而且擋得住（exit ${code}）`);
    if (!okCatch) console.log('        ' + out.split('\n').filter((l) => /過期|預算內/.test(l)).join(' ｜ '));
  }
  }
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);

/** @param {string} dir */
async function check(dir) {
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/check-perf.mjs'), `--dir=${dir}`]);
    return stdout;
  } catch (err) {
    return String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  }
}
