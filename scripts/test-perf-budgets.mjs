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
 * ── 那個「實測」的日期要說出多久以前 ──────────────
 *
 * 第 2 輪（第三十八圈）：這一行本來就說得出什麼時候量的、怎麼重量，
 * 缺的是**那是多久以前** ——「2026-09-04 實測」讀起來永遠像剛量過。
 *
 * 那一輪跑了一次 `probe:served`，結果是 **0 頁量到**（本機領先 origin
 * 105 個 commit，線上那一份比本機舊），也就是說這個宣稱現在重量不出來 ——
 * 而在這之前輸出不會透露這件事。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-days-'));
  await writeFile(join(dir, 'index.html'), page({ body: '<p>小</p>' }), 'utf8');
  const out = await check(dir);
  const m = /(\d{4}-\d{2}-\d{2})（(-?\d+) 天前）實測/.exec(out);
  const ok = m !== null && Number(m[2]) >= 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 那句「實測」帶著日期與天數` + (m ? `（${m[1]}，${m[2]} 天前）` : ''));
  if (!ok) console.log('        ' + (out.split('\n').find((l) => /實測 GitHub Pages/.test(l)) ?? '（那一行沒印）'));
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 架構文件說 JavaScript 有幾段，要跟產出對得上 ──────────────
 *
 * 第 2 輪（第三十七圈）：`docs/ARCHITECTURE.md` 在「決定性的因素是
 * 0 KB JavaScript」下面兩行寫著「目前全站的 JavaScript 只有四小段」，
 * 而產出裡**一直是五段** —— 少掉的那一段是 `Base.astro` 裡
 * 算繪前套用偏好的那個 script：641 B、每一頁都有、**跑在畫面出現之前**。
 * 講效能的人最想知道的就是那一段。
 *
 * 關卡預設只在量真的 `dist/` 時比（假站的段數本來就不一樣），
 * 所以這裡用 `--arch=` 指一份假文件才驗得到。
 *
 * 三個方向：對得上要出聲、對不上要擋、**文件換了寫法要說「這一格沒有在守」**。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-arch-'));
  /*
   * 兩段不一樣的 script，**一頁一段**，而且第一頁那段在兩頁上都有。
   *
   * 刻意不把兩段都放在第一頁：那樣的話「只掃第一頁」這種壞法
   * 仍然數得到 2 段，這一格就守不住走漏頁面。
   * （突變掃描抓到的：第一版就是兩段都在 index.html。）
   */
  await writeFile(join(dir, 'index.html'), page({ head: '<script>var a=1</script>', body: '<p>第一頁</p>' }), 'utf8');
  await writeFile(join(dir, 'two.html'), page({ head: '<script>var a=1</script>', body: '<script>var b=2</script>' }), 'utf8');

  const archAt = join(dir, 'arch.md');
  const withArch = async (/** @type {string} */ body) => {
    await writeFile(archAt, body, 'utf8');
    return check(dir, [`--arch=${archAt}`]);
  };

  const agree = await withArch('目前全站的 JavaScript 只有二小段：a 與 b。\n');
  const okAgree = /有 2 段，產出裡數到 2 段 ✓/.test(agree) && verdictOk(agree);
  if (!okAgree) failed++;
  console.log(`  ${okAgree ? '✓' : 'X'} 對得上的時候會出聲（不是沉默通過）`);
  if (!okAgree) console.log('        ' + agree.split('\n').filter((l) => /ARCHITECTURE|段/.test(l)).slice(0, 2).join(' ｜ '));

  const drift = await withArch('目前全站的 JavaScript 只有四小段：主題切換⋯⋯\n');
  const okDrift = /說全站的 JavaScript 有 4 段，產出裡是 2 段/.test(drift) && !verdictOk(drift);
  if (!okDrift) failed++;
  console.log(`  ${okDrift ? '✓' : 'X'} 數字漂掉時抓得到，而且擋得住`);
  if (!okDrift) console.log('        ' + drift.split('\n').filter((l) => /ARCHITECTURE|段/.test(l)).slice(0, 2).join(' ｜ '));

  const reworded = await withArch('這一份完全沒有講 JavaScript 有幾段。\n');
  const okLoud = /找不到「全站的 JavaScript 只有N小段」那句話 —— 這一格沒有在守/.test(reworded);
  if (!okLoud) failed++;
  console.log(`  ${okLoud ? '✓' : 'X'} 文件換了寫法時說「這一格沒有在守」`);
  if (!okLoud) console.log('        ' + reworded.split('\n').filter((l) => /ARCHITECTURE|沒有在守/.test(l)).slice(0, 2).join(' ｜ '));

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
 * ── 「讀者實際下載」那個數字要帶著怎麼重量 ──────────
 *
 * 這支腳本用 level 9。伺服器實際送幾個位元組，只有打真的網路才知道。
 *
 * 第 2 輪（第二十六圈）拿**別人的站**代打，推論「伺服器約 level 4–6」，
 * 於是報告印「比上面多 2.3%」。第 2 輪（第二十七圈）站上線之後量自己的站，
 * **方向是反的**：Pages 送出的比本機 level 9 還少 0.4–1.7%。
 *
 * 教訓不是「那個數字錯了」，是**那個數字沒有附上重量的方法**，
 * 所以真的東西出現時沒有人回去對。這一格守的就是那個方法還在：
 * 那一行必須同時有**實測的百分比**與**重量的指令**。
 *
 * 這裡不驗百分比是多少 —— 那要打網路，而這套測試不打網路
 * （`npm run probe:served` 才打）。驗的是那一行沒有退化成一句空話。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-level-'));
  await writeFile(join(dir, 'index.html'), page({ body: `<p>${noise(20_000)}</p>` }), 'utf8');
  const out = await check(dir);
  const line = out.split('\n').find((l) => l.includes('這個 gzip 數字是')) ?? '';
  const worst = Number(/最大單頁 HTML：([\d.]+) KB/.exec(out)?.[1] ?? 0);
  const ok1 = line !== '' && worst > 0;
  if (!ok1) failed++;
  console.log(`  ${ok1 ? '✓' : 'X'} 印得出「這個 gzip 數字是上界」那一行`);
  if (!ok1) console.log('        ' + (line || '（那一行完全沒印）'));

  /* 有日期、有實測範圍：不然它就只是一句沒有出處的宣稱 */
  const ok2 = /\d{4}-\d{2}-\d{2}/.test(line) && /少 [\d.]+%～[\d.]+%/.test(line);
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} 那一行有量測日期與實測範圍`);
  if (!ok2) console.log('        ' + line);

  /*
   * 有重量的指令。這一條是這一輪的核心 ——
   * 上一版之所以錯了兩圈沒人發現，就是因為沒有人知道怎麼重量。
   */
  const ok3 = line.includes('probe:served');
  if (!ok3) failed++;
  console.log(`  ${ok3 ? '✓' : 'X'} 那一行講了怎麼重量（probe:served）`);
  if (!ok3) console.log('        ' + line);

  /*
   * ── 關鍵路徑那條的理由要帶著它的量測 ──────────
   *
   * 第 2 輪（第二十八圈）問「這個數字是誰訂的、理由還在嗎」。
   * 那條原本寫「14 KB 附近是 TCP 初始壅塞視窗，超過就要多一個來回；
   * 已經越過了」—— 站上線之後量真的，那個框架用錯了：
   * HTML 與 CSS **從來不在同一趟裡**（CSS 是普通的 <link>，
   * 沒有 preload、GitHub Pages 也不送 Early Hints），
   * 所以在總和上省位元組不會少掉任何一個來回。
   *
   * 這一格守的是那個修正還在，而且**帶著怎麼重量** ——
   * 一個沒有出處的效能理由，下一個人只能選擇相信或重做一次。
   */
  /*
   * why 只有超標或 --verbose 才印，而這份 fixture 的關鍵路徑是通過的。
   *
   * **判準要對著那一段，不是對著整份輸出。** 第一版寫
   * `/\d{4}-\d{2}-\d{2}/.test(whole) && whole.includes('probe:served')`，
   * 而壓縮那一行本來就有日期跟 probe:served —— 兩個突變（拿掉日期、
   * 拿掉指令）都照樣綠。這個 repo 兩圈之內第四次踩到同一件事：
   * **判準能被別的東西滿足的時候，它證明的比它看起來的少。**
   */
  const whole = await check(dir, ['--verbose']);
  const from = whole.indexOf('首次造訪關鍵路徑');
  const nextLabel = whole.indexOf('全站 CSS 合計', from + 1);
  const section = from < 0 ? '' : whole.slice(from, nextLabel < 0 ? from + 2000 : nextLabel);
  const ok4 =
    section.includes('從來不在同一趟裡') &&
    /\d{4}-\d{2}-\d{2}/.test(section) &&
    section.includes('probe:served');
  if (!ok4) failed++;
  console.log(`  ${ok4 ? '✓' : 'X'} 關鍵路徑那條說明了「省位元組不會少掉來回」，並帶量測日期與重量指令`);
  if (!ok4) console.log('        ' + (section.slice(0, 400) || '（那一段完全沒印）'));
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

/*
 * ── 紅燈的時候也要說「下一個要爆的是誰」──────────────
 *
 * 第 2 輪（第二十九圈）加了「最接近上限的是⋯」，但只印在全綠那條路上；
 * `closest` 在另一條路上是**算完丟掉**的。
 *
 * 第 2 輪（第三十圈）量到代價：`inlineStylesheets` 改成 `always` 之後
 * 連讀 5 頁多 26%，而**一條預算都沒超標** —— 最大單頁 HTML 從 75% 跳到 98%。
 * 唯一紅的是不相干的一條，判決卻因此整段走到 else，那個 98% 沒人指。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-nextup-'));
  /*
   * 這份 fixture 要有**高低差**，不能只有「一條爆掉、其餘全 0%」。
   *
   * 第一版就是那樣：11 條裡 2 條超標、9 條並列 0%。
   * 於是突變「改成點名最不接近上限的那條」照樣全綠 ——
   * `reduce` 在全部相等時，取最大與取最小回的是**同一個**。
   * 判準沒問題，是**語料分不出來**（跟第 7 輪〔第二十九圈〕那次一樣）。
   *
   * 所以除了爆掉的那一頁，再放一份不好壓的 CSS，讓「全站 CSS 合計」
   * 停在中間 —— 這樣最大與最小才是兩條不同的預算。
   */
  await writeFile(join(dir, 'index.html'), page({ body: `<p>${noise(200_000)}</p>` }), 'utf8');
  await mkdir(join(dir, '_astro'), { recursive: true });
  await writeFile(join(dir, '_astro', 'spread.css'), `.a{content:"${noise(7_000)}"}`, 'utf8');
  const out = await check(dir);
  const m = /還沒超標的裡面最接近上限的是「(.+?)」（(\d+)%）。/.exec(out);
  /*
   * 判準要**自己算一次**，不能只驗「有印一行、而且不是超標的那條」。
   *
   * 第一版就是那樣寫的，於是突變「改成點名最**不**接近上限的那條」
   * 照樣全綠 —— 0% 那條同樣不是超標的、同樣 ≤ 100%。
   * 這是這一組圈裡第九次踩到「判準能被別的東西滿足」。
   *
   * 所以從表格把每一條的百分比讀回來，自己算出「沒超標的裡面最大的」，
   * 再比對點名的是不是它。
   */
  const rows = [...out.matchAll(/^\s*([✓X])\s+(.+?)\s{2,}.*?(\d+)%\s*$/gm)]
    .map((r) => ({ over: r[1] === 'X', label: r[2].trim(), pct: Number(r[3]) }));
  const under = rows.filter((r) => !r.over);
  const want = under.length > 0 ? under.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
  const ok =
    m !== null && want !== null && rows.some((r) => r.over) && m[1] === want.label && Number(m[2]) === want.pct;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 紅燈時也點名「還沒超標的裡面最接近上限的」，而且點名的真的是它`);
  if (!ok) {
    console.log(
      '        ' +
        (m
          ? `點名了「${m[1]}」（${m[2]}%），表上沒超標的裡面最大的是「${want?.label ?? '（讀不到）'}」（${want?.pct ?? '?'}%）`
          : '那一行根本沒印') +
        `　讀到 ${rows.length} 條、超標 ${rows.filter((r) => r.over).length} 條`,
    );
  }
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 每條預算的上限是推導出來的還是挑的 ──────────────
 *
 * 第 2 輪（第三十一圈）：`why` 說的是這條預算在守什麼，不是上限為什麼是
 * 這個數。量了一次，11 條的餘裕倍數從 1.50 到 17.14 —— 看起來像一套系統，
 * 實際是四種訂法混在一起。`basis` 一律以「推導：」或「挑的：」開頭。
 *
 * 這三格守的是：每一條都有 basis、開頭只有那兩種、而且結尾那句話的
 * 兩個數字跟實際的條數對得上（自己數一次，不是比對寫死的數字）。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-basis-'));
  await writeFile(join(dir, 'index.html'), page({ body: '<p>小</p>' }), 'utf8');
  /*
   * 搜尋索引那條預算只在 `search-index.json` 存在時才會進表。
   *
   * 第一版沒放它，於是表上只有 10 條 —— 而突變「把搜尋索引那條的 basis
   * 清空」照樣全綠：那一條連同它的 basis 一起從表上消失，兩邊都少一，
   * 數字還是對得上。判準沒問題，是**語料裡沒有那條預算**
   * （這一圈第四次踩到語料的問題）。
   */
  await writeFile(join(dir, 'search-index.json'), JSON.stringify([{ t: '烏衣巷', u: '/poems/x' }]), 'utf8');
  const out = await check(dir, ['--verbose']);
  const plain = await check(dir);

  /* 表格那幾行（`✓ 名稱` 後面接數字與百分比）就是預算的條數 */
  const budgetRows = [...out.matchAll(/^\s*[✓X]\s+\S/gm)].length;
  const bases = [...out.matchAll(/^\s*(推導：|挑的：)/gm)].map((m) => m[1]);
  const ok1 = budgetRows > 0 && bases.length === budgetRows;
  if (!ok1) failed++;
  console.log(`  ${ok1 ? '✓' : 'X'} 每一條預算都說得出上限是怎麼來的`);
  if (!ok1) console.log(`        ${budgetRows} 條預算，只有 ${bases.length} 條有 basis`);

  const derived = bases.filter((b) => b === '推導：').length;
  const m = /(\d+) 條預算裡，(\d+) 條說得出上限是怎麼推導的，(\d+) 條是挑的/.exec(plain);
  const ok2 =
    m !== null &&
    Number(m[1]) === budgetRows &&
    Number(m[2]) === derived &&
    Number(m[3]) === budgetRows - derived;
  if (!ok2) failed++;
  console.log(`  ${ok2 ? '✓' : 'X'} 結尾那句的兩個數字跟實際條數對得上`);
  if (!ok2) {
    console.log(
      '        ' +
        (m
          ? `說 ${m[1]} 條裡 ${m[2]} 條推導、${m[3]} 條挑的；實際 ${budgetRows} 條裡 ${derived} 條推導`
          : '那一行根本沒印'),
    );
  }

  /* 反向：不能兩種都不是 —— 開頭寫成別的字，上面兩格就會少數到它 */
  const ok3 = derived > 0 && derived < budgetRows;
  if (!ok3) failed++;
  console.log(`  ${ok3 ? '✓' : 'X'} 兩種 basis 都真的存在（不是全部推導、也不是全部挑的）`);

  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 「這條預算量的是空的東西」那句話要跟著數字走 ──────
 *
 * 第 2 輪（第三十二圈）量到的：那一段整段**沒有任何測試**，
 * 而它的條件是 `scripts === 0 || imgs === 0`，配一句斷定兩項的話。
 * 實測一份有兩張圖、沒有樣式表的假站，印出來是
 *
 *     stylesheet 0 個、script src 0 個、img src 2 個。
 *     三項裡只有 stylesheet 數得到東西，另外兩項從來沒有過主體。
 *
 * 兩個半句都跟它上一行的數字相反 —— 那句話是照著今天這個站寫死的。
 *
 * 這四格用四種不同的組合，因為**只放一種的話，寫死的那句話照樣會過**。
 */
{
  const CSS_LINK = '<link rel="stylesheet" href="/a.css">';
  /**
   * @param {string} label
   * @param {{ head?: string, body?: string }} parts
   * @param {(out: string) => boolean} want
   */
  const withBody = async (label, parts, want) => {
    const dir = await mkdtemp(join(tmpdir(), 'perf-bare-'));
    await writeFile(join(dir, 'index.html'), page(parts), 'utf8');
    const out = await check(dir);
    const ok = want(out);
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} ${label}`);
    if (!ok) {
      const said = out.split('\n').filter((l) => /單頁請求數 ——|一個主體都沒有|數得到東西的只有|什麼都沒量到/.test(l));
      console.log('        ' + (said.join(' ｜ ') || '（那一段完全沒印）'));
    }
    await rm(dir, { recursive: true, force: true });
  };

  await withBody(
    '有圖沒樣式表：點名 stylesheet 與 script src，不是照抄「只有 stylesheet」',
    { body: '<p>小</p><img src="/a.png" alt="a">' },
    (out) => /2 項這次一個主體都沒有：stylesheet、script src/.test(out) && /數得到東西的只有 img src/.test(out),
  );
  await withBody(
    '有樣式表沒圖沒 script：點名 script src 與 img src（真站的形狀）',
    { head: CSS_LINK, body: '<p>小</p>' },
    (out) => /2 項這次一個主體都沒有：script src、img src/.test(out) && /數得到東西的只有 stylesheet/.test(out),
  );
  await withBody(
    '三項都沒有：明講「什麼都沒量到」',
    { body: '<p>小</p>' },
    (out) => /3 項這次一個主體都沒有：stylesheet、script src、img src/.test(out) && /什麼都沒量到/.test(out),
  );
  /* 反向：三項都有東西的時候，整段不該出現 */
  await withBody(
    '三項都有東西：整段不印（反向案例）',
    { head: CSS_LINK, body: '<p>小</p><img src="/a.png" alt="a"><script src="/a.js"></script>' },
    (out) => !/一個主體都沒有/.test(out),
  );
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
  const saysGzip = /讀者[^\n]*下載[^\n]*gzip/.test(out);
  const noFalseClaim = !/brotli[^\n]*現代瀏覽器拿到的/.test(out);
  const stillShowsBrotli = /brotli/.test(out);

  for (const [name, ok] of [
    ['報告說得出「讀者⋯下載⋯gzip」', saysGzip],
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
 * ── 對著讀者說的那個數字，要是讀者的數字 ──────────
 *
 * 第 2 輪（第三十三圈）量到：那一行原本寫「最大單頁：**讀者實際下載**
 * 10.5 KB」，用的是 `worstPage.gzip` —— **只有 HTML**。
 * 讀者第一次到訪還要抓一支阻塞渲染的樣式表，真正的量是 14.1 KB，多 35%。
 *
 * 上面兩格早就在守這一行了，守的是**措辭**：有沒有說 gzip、有沒有帶重量的
 * 指令、有沒有把 brotli 講成讀者拿得到的。**沒有一格問過那個數字是誰的。**
 * 措辭釘得很牢，數字沒有人看。
 *
 * 所以這一格量的是關係，不是字：讀者那一行必須**大於**只有 HTML 的那一行，
 * 而且要**等於**「首次造訪關鍵路徑」那條預算 —— 那條算的就是它。
 *
 * fixture 要有一支外部樣式表，不然兩個數字會相等，這一格就變成
 * 「10.5 > 10.5」永遠假、或「隨便都相等」永遠真 —— 兩種都不是在守東西。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-reader-'));
  await writeFile(join(dir, 's.css'), `body{color:red}${'/*' + noise(4000) + '*/'}`, 'utf8');
  await writeFile(
    join(dir, 'index.html'),
    page({ head: '<link rel="stylesheet" href="/s.css">', body: `<p>${noise(3000)}</p>` }),
    'utf8',
  );
  const out = await check(dir);
  const num = (/** @type {RegExp} */ re) => Number(re.exec(out)?.[1] ?? NaN);
  const html = num(/最大單頁 HTML：([\d.]+) KB/);
  const reader = num(/讀者第一次到訪最多下載 ([\d.]+) KB/);
  const critical = num(/首次造訪關鍵路徑（gzip）\s+([\d.]+) KB/);

  const okBigger = reader > html;
  if (!okBigger) failed++;
  console.log(`  ${okBigger ? '\u2713' : 'X'} 讀者那一行比「只有 HTML」那一行大（${reader} > ${html}）`);
  if (!okBigger) console.log('        一樣大就表示它印的還是 HTML 那個數字 —— 那正是這一格要抓的。');

  const okSame = Number.isFinite(reader) && reader === critical;
  if (!okSame) failed++;
  console.log(`  ${okSame ? '\u2713' : 'X'} 讀者那一行就是「首次造訪關鍵路徑」那條預算（${critical} KB）`);
  if (!okSame) console.log(`        讀者 ${reader}、關鍵路徑 ${critical} —— 同一件事要有同一個數字。`);

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
/*
 * ── 「最大單一檔案」要說出它其實不含哪些 ──────────
 *
 * 第 2 輪（第三十五圈）用第二種算法查 dist 裡真正最大的檔案：`index.html`
 * 35.2 KB，而這一條說 24.9 KB。差的不是數字是**範圍** ——
 * `assets` 濾掉 HTML 與 text-like（那兩類各有自己的預算）。
 * 名字比量的東西大，拿 `ls -S dist` 對照的人會以為它算錯。
 *
 * 這一格守的是那句範圍說明還在。兩個方向：該有的字要在，
 * 而且那一條**仍然是綠的**（說明不該把一條通過的預算變成失敗）。
 */
{
  const { out, code } = await runPerf(['--verbose']);
  const line = out.split('\n').find((l) => l.includes('那兩類各有自己的預算')) ?? '';
  const okSays = line !== '';
  if (!okSays) failed++;
  console.log(`  ${okSays ? '\u2713' : 'X'} 「最大單一檔案」說得出它不含 HTML 與文字資源`);
  if (!okSays) {
    console.log('        ' + (out.split('\n').find((l) => l.includes('最大單一檔案')) ?? '（那一條沒印）'));
  }

  const okStillGreen = code === 0;
  if (!okStillGreen) failed++;
  console.log(`  ${okStillGreen ? '\u2713' : 'X'} 加了那句說明之後這一支仍然是綠的（exit ${code}）`);
}

/*
 * ── 請求數這條的邊界外面 ──────────
 *
 * 第 2 輪（第三十六圈）把產出裡所有會發出請求的寫法列了一次：
 * 這條預算算 stylesheet／script src／img src，而 `rel="icon"` 那一類（132 個）
 * 與 `rel="manifest"`（44 個）**也會發出請求，卻不在裡面**。
 * 平均每頁 4 個 —— 也就是「單頁請求數 2」不是那一頁請求的全部。
 *
 * 不改判準（圖示只抓一次、快取很久），但那句話要在。
 * 兩個方向：有那種連結時要說、沒有時不能亂說。
 */
{
  const withIcons = await mkdtemp(join(tmpdir(), 'perf-uncounted-'));
  await writeFile(
    join(withIcons, 'index.html'),
    page({
      head:
        '<link rel="icon" href="/favicon.ico">' +
        '<link rel="apple-touch-icon" href="/a.png">' +
        '<link rel="manifest" href="/site.webmanifest">',
      body: '<p>x</p>',
    }),
    'utf8',
  );
  const loud = await check(withIcons);
  const okLoud = /單頁請求數數不到的：1 頁合計還有 3 個/.test(loud);
  if (!okLoud) failed++;
  console.log(`  ${okLoud ? '\u2713' : 'X'} 圖示與 manifest 連結會被數出來說明（3 個）`);
  if (!okLoud) console.log('        ' + (loud.split('\n').find((l) => l.includes('數不到')) ?? '（那一行沒印）'));
  await rm(withIcons, { recursive: true, force: true });

  const without = await mkdtemp(join(tmpdir(), 'perf-uncounted-none-'));
  await writeFile(join(without, 'index.html'), page({ body: '<p>x</p>' }), 'utf8');
  const quiet = await check(without);
  const okQuiet = !/單頁請求數數不到的/.test(quiet);
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '\u2713' : 'X'} 沒有那種連結時不亂說`);
  await rm(without, { recursive: true, force: true });
}

  const clean = (await runPerf()).out;
  const okQuiet = !clean.includes('說明裡的數字過期');
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} 說明裡的數字沒過期時不報（反向案例）`);

  /*
   * ── 全部對得上時，也要說出「比了幾條」 ──────────
   *
   * 第 2 輪（第三十四圈）：這一段原本只在**有東西過期**時出聲，
   * 所以「說明裡的數字都是對的」跟「這道檢查一條都沒比到」在畫面上一模一樣。
   * 實際量到的就是後者的一半：11 條裡有 5 條寫了現值，而樣式只配得到 4 條
   * （「最大單一檔案」那句的檔名太長，超出 14 個字的視窗），配不到就 `continue`。
   *
   * 這裡不重算一次「應該有幾條」—— 那等於把抽取邏輯抄第二份（第三十二圈的教訓）。
   * 驗的是**它自己說的數字跟它自己列的名字對不對得上**，
   * 以及那個數字不是 0（0 的話這道檢查等於沒跑）。
   */
  /* 標籤自己就含全形括號（「最大單頁 HTML（gzip）」），所以靠行尾的「），其餘」收尾 */
  const cover = /說明裡的現值：比對了 (\d+) 條（(.*)），其餘/.exec(clean);
  const okCoverLine = cover !== null;
  if (!okCoverLine) failed++;
  console.log(`  ${okCoverLine ? '✓' : 'X'} 全部對得上時說得出「比對了幾條」`);
  if (!okCoverLine) {
    console.log('        ' + (clean.split('\n').find((l) => l.includes('說明裡的現值')) ?? '（那一行沒印）'));
  }

  if (cover) {
    const said = Number(cover[1]);
    const named = cover[2].split('、').filter(Boolean).length;
    const okConsistent = said > 0 && said === named;
    if (!okConsistent) failed++;
    console.log(`  ${okConsistent ? '✓' : 'X'} 那一行說的條數跟它列出來的名字一樣多（說 ${said}、列 ${named}）`);
  }

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
/*
 * ── 十一個綠勾裡，哪一個該盯 ──────────
 *
 * 第 2 輪（第二十九圈）問「第一次跑的人跟第一百次跑的人看到的是同一份
 * 東西嗎」。表格本身是自明的，但十一個綠勾長得一模一樣 ——
 * 老手知道 CSP 雜湊數那條是決策觸發點，第一次跑的人只看到十一個勾。
 *
 * 兩件事一起守：點名最接近上限的那一條，以及說得出 `--verbose`
 * （每條預算的數字是怎麼訂的只在那裡面）。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'perf-first-'));
  await writeFile(join(dir, 'index.html'), page({ body: '<p>短</p>' }), 'utf8');
  const out = await check(dir);

  /*
   * 判準要驗**它真的是最大的那一個**，不是「有這麼一句話」。
   *
   * 第一版只比對格式，而突變掃描把 `reduce` 的比較寫反（挑成最不接近的）
   * 之後照樣綠 —— 這個 repo 反覆踩到的同一件事：
   * **判準能被別的東西滿足的時候，它證明的比它看起來的少。**
   *
   * 表格每一列結尾都有 `NN%`，拿它們的最大值來對。
   */
  const named = /最接近上限的是「.+」（(\d+)%）/.exec(out);
  const allPct = [...out.matchAll(/ (\d+)%$/gm)].map((m) => Number(m[1]));
  const okClosest = named !== null && allPct.length > 1 && Number(named[1]) === Math.max(...allPct);
  if (!okClosest) failed++;
  console.log(`  ${okClosest ? '✓' : 'X'} 全綠時點名的真的是最接近上限的那一條`);
  if (!okClosest) {
    console.log(`        說的是 ${named ? named[1] + '%' : '（沒說）'}，表格裡最大的是 ${allPct.length ? Math.max(...allPct) + '%' : '（抓不到）'}`);
  }

  const okVerbose = /--verbose/.test(out);
  if (!okVerbose) failed++;
  console.log(`  ${okVerbose ? '✓' : 'X'} 全綠時說得出怎麼看「數字是怎麼訂的」（--verbose）`);
  if (!okVerbose) console.log('        ' + out.split('\n').slice(-4).join(' | '));

  /* --verbose 模式自己不再提示自己 */
  const verbose = await check(dir, ['--verbose']);
  const tailV = verbose.split('\n').slice(-4).join('\n');
  const okQuiet = !/要看每條預算的數字是怎麼訂的/.test(tailV);
  if (!okQuiet) failed++;
  console.log(`  ${okQuiet ? '✓' : 'X'} --verbose 模式不再提示自己（反向案例）`);
  if (!okQuiet) console.log('        ' + tailV.split('\n').join(' | '));

  await rm(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);

/** @param {string} dir */
async function check(dir, /** @type {string[]} */ extra = []) {
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/check-perf.mjs'), `--dir=${dir}`, ...extra]);
    return stdout;
  } catch (err) {
    return String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  }
}
