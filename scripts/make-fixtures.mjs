#!/usr/bin/env node
// @ts-check
/**
 * 規模測試用的假內容 —— 產生、然後刪掉。
 *
 *   node scripts/make-fixtures.mjs 300        # 產生
 *   node scripts/make-fixtures.mjs --clean    # 全部刪掉
 *   node scripts/make-fixtures.mjs 300 --videos 400
 *   node scripts/make-fixtures.mjs 300 --tags 300   # 額外 300 個相異標籤
 *
 * 走 npm 的話**要加 `--`**：`npm run fixtures -- 300 --videos 400`。
 * 少了它，npm 會把 `--videos 400` 吃掉，這支腳本只會產生內容、
 * **一支假影片都沒有**。輸出的第一行看得出來（有沒有「＋ N 支假影片」），
 * 但很容易略過 —— `docs/STATE.md` 裡那行指令就少了 `--`，
 * 也就是說「照文件跑一次規模測試」從來沒有測到平臺頁與影片那一半。
 * 第 2 輪（第十三圈）補上。
 *
 * 為什麼要有這個檔案：
 *
 * 第 3 輪（第一圈）做規模測試是「手寫一個 for 迴圈產檔案、看完再手動 rm」。
 * 那次抓到一個只有在 300 篇時才看得見的 bug（標籤大小寫會產生兩個一樣的頁面，
 * 因為 macOS 的檔案系統不分大小寫，本機根本看不出來）。
 * 這種 bug 只有規模測試抓得到，而如果每次都要重寫一遍腳本，實際上就不會做。
 *
 * 兩件事要特別小心，都寫進程式裡了：
 *
 * 1. **一定要刪得乾淨。** 假內容混進 repo 比不做測試糟糕得多。
 *    所有產生的檔名都有 `FIXTURE-` 前綴，--clean 只刪這個前綴的東西，
 *    絕不會碰到真的內容。結束時會印出剩幾個。
 * 2. **syndication.json 是同步腳本產生的，不是手寫的。**
 *    要灌假影片時先備份成 .fixture-backup，--clean 會還原。
 *    直接改壞它會讓 /elsewhere 整頁空掉，而且看起來像同步失敗。
 */
import { mkdir, writeFile, readdir, rm, readFile, copyFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = resolve(ROOT, 'src/content');
const SYND = resolve(ROOT, 'src/data/syndication.json');
const BACKUP = resolve(ROOT, 'src/data/syndication.fixture-backup.json');
const PREFIX = 'FIXTURE-';

const args = process.argv.slice(2);
const clean = args.includes('--clean');
const count = Number(args.find((a) => /^\d+$/.test(a)) ?? 300);
const videoIdx = args.indexOf('--videos');
const videoCount = videoIdx >= 0 ? Number(args[videoIdx + 1] ?? 0) : 0;
const tagIdx = args.indexOf('--tags');
const extraTags = tagIdx >= 0 ? Number(args[tagIdx + 1] ?? 0) : 0;

/*
 * 標籤刻意包含大小寫混用與前後空白的版本。
 * 第一圈就是靠這個抓到「唐詩」與「唐詩 」會產生兩個頁面。
 * 拿掉這些看起來髒的值，這個腳本就失去一半的價值。
 */
const FIXED_TAGS = ['唐詩', '宋詞', '樂府', 'Tang', 'tang', ' 唐詩 ', '李白', '白居易', '邊塞'];

/*
 * ── 為什麼要能加標籤數 ────────────────────────────────
 *
 * 上面那九個是**固定的**，因為它們在測正規化。但也因為固定，
 * 不管灌幾百篇，正規化之後的相異標籤永遠只有六個 ——
 * 「幾百個標籤時 /tags 會怎樣」這件事**量不了**。
 * 那條待辦從第十三圈掛到現在，第 3 輪（第十九圈）補上：`--tags N`。
 *
 * 真實的標籤會隨內容累積（她每讀一個新的詩人、新的詞牌就多一個），
 * 所以額外的標籤走「詞牌／詩人／主題」三種形狀，不是 tag-0001 這種。
 */
const TAG_STEMS = ['詞牌', '詩人', '主題', '朝代', '體裁'];
const TAGS = [
  ...FIXED_TAGS,
  ...Array.from({ length: Math.max(0, extraTags) }, (_, i) => `${TAG_STEMS[i % TAG_STEMS.length]}${i + 1}`),
];
const AUTHORS = ['李白', '杜甫', '白居易', '王維', '李商隱', '蘇軾'];

/**
 * @param {string[]} arr
 * @param {number} i
 */
const pick = (arr, i) => arr[i % arr.length];
/** @param {number} n */
const pad = (n) => String(n).padStart(4, '0');

/*
 * 假的中文內文。
 *
 * ## 為什麼不是隨便重複幾十個字就好
 *
 * 第一版用 35 個字的字池循環，結果那些文字的 **gzip 壓縮率是 23:1**，
 * 而真實內容只有 1.6:1 —— 差了十四倍。
 * 所有「量 gzip 之後的大小」的檢查（效能預算有一半是）在這種假資料下
 * 都會得出過度樂觀的數字。第 2 輪（第三圈）量 rss-all.xml 時就踩到：
 * 假資料說 5.9 KB，用真實比例推估是 27 KB。
 *
 * ## 現在的做法
 *
 * 先用字池組出一批「詞」，再用 Zipf 分佈（越前面的詞越常出現）把詞串成文章 ——
 * 那正是真實語言的結構：少數詞很常見、多數詞很罕見。
 * 實測壓縮率 1.9:1、不重複字元 136 個，落在真實內容的範圍。
 *
 * 亂數是**帶種子的**，所以同樣的參數每次產生完全一樣的內容 ——
 * 不然兩次量測之間的差異會分不清是改動造成的還是亂數造成的。
 */
const POOL =
  '的一是不了人我在有他這為之大來以個中上們到說國和地也子時道出而要於就下得可你年生自會那後能對著事其裡所去行過家十用發天如然作方成者多日都三小軍二無同麼經法當起與好看學進種將還分此心前面又定見只主沒公從山風花月雨雪春秋江河海雲霧星辰夜曉暮朝寒暑清明幽深遠近高低長短新舊';

/** 線性同餘亂數 —— 夠亂，而且同一個種子永遠給同一串 @param {number} seed */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 從一個中位數長出右偏的分佈。
 *
 * r=0 → 0.55×、r=0.5 → 0.96×、r=1 → 2.45×。少數幾篇特別長，
 * 那正是「最大單頁」這條預算需要被測到的形狀。
 *
 * @param {number} median
 * @param {() => number} rnd  帶種子的亂數（同樣的參數要給同樣的內容）
 */
const spread = (median, rnd) => Math.max(20, Math.round(median * (0.55 + 1.9 * Math.pow(rnd(), 2.2))));

/**
 * @param {number} charCount  大約幾個字
 * @param {number} seed
 */
function prose(charCount, seed) {
  const rnd = seeded(seed + 1);
  const words = Array.from({ length: 600 }, () =>
    Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => POOL[Math.floor(rnd() * POOL.length)]).join(''),
  );
  let out = '';
  while (out.length < charCount) {
    // 指數 2.2 讓分佈夠偏 —— 前 10% 的詞佔掉大部分出現次數，跟真實中文一樣
    out += words[Math.floor(Math.pow(rnd(), 2.2) * words.length)];
    if (rnd() < 0.12) out += '，';
    if (rnd() < 0.05) out += '。\n\n';
  }
  return out.slice(0, charCount);
}

async function makeContent() {
  const plan = [
    { dir: 'poems', n: Math.round(count * 0.6) },
    { dir: 'writing', n: 0 },
    { dir: 'posts', n: Math.round(count * 0.25) },
    { dir: 'notes', n: count - Math.round(count * 0.6) - Math.round(count * 0.25) },
  ].filter((p) => p.n > 0);

  /** 產生出來的形狀，最後印一次 —— 數量對不代表形狀對 */
  const shape = { bodies: /** @type {number[]} */ ([]), lines: /** @type {number[]} */ ([]), anns: /** @type {number[]} */ ([]) };

  for (const { dir, n } of plan) {
    await mkdir(resolve(CONTENT, dir), { recursive: true });
    for (let i = 0; i < n; i++) {
      const date = new Date(Date.UTC(2020 + (i % 6), i % 12, (i % 28) + 1)).toISOString();
      /*
       * ── 標籤要**偏斜**，不要平均 ──────────────────
       *
       * 平均分配（每個標籤都用差不多次數）是最不會出事的形狀，
       * 而真實的標籤是長尾的：幾個常用的佔掉一大半，剩下一堆只出現一次。
       * 標籤雲的字級是 `0.9 + (n / max) * 0.85`，**分母是最大值** ——
       * 長尾那一端會全部擠在下界，字級的訊號等於消失。
       * 用平均分配量不到這件事（第 3 輪〔第十九圈〕實測：
       * 平均分配下 46% 的標籤落在同一個字級，看起來很正常）。
       *
       * `u²` 讓低索引（也就是那九個固定標籤）被選中的機會高得多，
       * 形狀接近 Zipf。`sin` 那一段是常見的決定性偽隨機 ——
       * **不能用真的亂數**，這支腳本的每一次輸出都必須一樣。
       */
      const u = (/** @type {number} */ n) => {
        const x = Math.sin(n * 12.9898) * 43758.5453;
        return x - Math.floor(x);
      };
      const skewed = (/** @type {number} */ n) =>
        TAGS[Math.min(TAGS.length - 1, Math.floor(TAGS.length * u(n) ** 2))];
      const tags = [skewed(i + 1), skewed(i + 1000), skewed(i + 2000)];
      /*
       * 長度**不是常數，是分佈**。
       *
       * 第 2 輪（第十三圈）量到的：原本同一類型的每一篇長度完全一樣
       * （詩 130 字、文 700 字、札 175 字），於是 180 首假詩的頁面大小
       * 只有 75 種不同的值、最大／最小 **1.016×**，而且**每一首都比站上
       * 最小的那首真詩還小**（gzip 6572 vs 7253 bytes）。
       *
       * 「最大單頁 HTML」是一條**取最大值**的預算，而最大值對分佈的尾巴
       * 最敏感 —— 用等長的假資料去量，量到的是「典型」不是「最大」。
       *
       * 中位數對齊實際內容（2026-09-03 量的，單位是字不是 bytes）：
       *   詩的內文 133／230／256 → 中位 230（舊的常數 130 是更早以前量的，
       *                              那時候內容比較短，後來沒有人重量）
       *   文章內文 747
       *   短札內文 184
       *   description 19–35 → 中位 31
       * 右尾是刻意的：真實寫作就是少數幾篇特別長。
       */
      const shapeRnd = seeded(i * 7919 + 31);
      const bodyChars = spread(dir === 'poems' ? 230 : dir === 'posts' ? 747 : 184, shapeRnd);
      const fm = [
        '---',
        `title: 測試內容 ${pad(i)}`,
        `description: ${prose(spread(31, shapeRnd), i + 9001).replace(/\n/g, '')}`,
        'lang: zh-TW',
        `publishedAt: ${date}`,
        `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`,
      ];
      if (dir === 'poems') {
        /*
         * 原文與注解也**不是常數**。原本每一首都是同一段硬寫的兩行，
         * 而且 180 首**沒有一首有注解** —— 詩頁模板最重的那個區塊
         * （`.poem__annotations`）在規模測試裡從來沒有被畫過。
         * 站上三首真的詩是 4／10／4 句、3／3／4 條注解。
         *
         * 句數取偶數（絕句 4、律詩 8、古詩更長），字數取 5 或 7
         * （五言／七言）—— 這兩件事會直接決定直排時的版面寬度。
         */
        const lineCount = 4 + 2 * Math.floor(Math.pow(shapeRnd(), 3) * 10);
        const perLine = shapeRnd() < 0.5 ? 5 : 7;
        const lines = Array.from({ length: lineCount }, (_, k) =>
          Array.from({ length: perLine }, () => POOL[Math.floor(shapeRnd() * POOL.length)]).join(''),
        );
        const annCount = shapeRnd() < 0.85 ? 2 + Math.floor(shapeRnd() * 4) : 0;
        shape.lines.push(lineCount);
        shape.anns.push(annCount);
        /*
         * 每十首給一首影片 —— `videoUrl` 是**從來沒有跟真資料跑過**的欄位之一，
         * 而它背後是 `VideoFacade`（第 1 輪〔第二十圈〕之前，那個元件從來沒有
         * 出現在任何一份產出裡，所以 25 條無障礙規則沒有一條看過它）。
         * 有了這一行，規模測試就會順便走到那條路。
         * 網址用真的影片 id 形狀（11 個字元），facade 只拿它組網址、不會發請求。
         */
        if (i % 10 === 0) {
          fm.push(`videoUrl: https://www.youtube.com/watch?v=FIXTUREvid${pad(i)}`.slice(0, 60));
        }
        fm.push(
          'poem:',
          `  title: 測試詩 ${pad(i)}`,
          `  author: ${pick(AUTHORS, i)}`,
          '  dynasty: 唐',
          `  original: |`,
          ...lines.map((l) => '    ' + l),
          `plain: ${prose(spread(40, shapeRnd), i + 777).replace(/\n/g, '')}`,
        );
        if (annCount > 0) {
          fm.push('annotations:');
          for (let k = 0; k < annCount; k++) {
            // 注解的詞從這首詩自己的字裡挑，跟真實內容一樣
            const src = lines[k % lines.length];
            const at = Math.floor(shapeRnd() * (perLine - 1));
            fm.push(
              `  - term: ${src.slice(at, at + 1 + Math.floor(shapeRnd() * 2))}`,
              `    gloss: ${prose(spread(14, shapeRnd), i * 31 + k).replace(/\n/g, '')}`,
            );
          }
        }
      }
      // 每 7 篇給一個系列，讓 SeriesNav 在規模下也被實際渲染到
      if (dir === 'posts' && i % 7 === 0) fm.push('series: 測試系列', `seriesOrder: ${i}`);
      fm.push('---', '', prose(bodyChars, i));
      shape.bodies.push(bodyChars);
      await writeFile(resolve(CONTENT, dir, `${PREFIX}${pad(i)}.md`), fm.join('\n'), 'utf8');
    }
    console.log(`  ${dir}/  ${n} 筆`);
  }

  /*
   * 印出「這批假內容長什麼形狀」。
   *
   * 為什麼要印：第 2 輪（第十三圈）之前，同一類型的每一篇長度**完全一樣**、
   * 180 首詩沒有一首有注解 —— 而那件事從輸出上完全看不出來，
   * 因為腳本只印「幾筆」。數量是對的，形狀是平的，
   * 而所有「取最大值」的預算都是靠形狀說話的。
   *
   * 有人哪天把長度改回常數，這幾行會當場說出來。
   */
  const uniq = new Set(shape.bodies).size;
  const sorted = [...shape.bodies].sort((a, b) => a - b);
  console.log(
    `\n  形狀：內文 ${sorted[0]}–${sorted[sorted.length - 1]} 字（${uniq} 種不同的長度／${shape.bodies.length} 篇）`,
  );
  if (shape.lines.length > 0) {
    const ls = [...shape.lines].sort((a, b) => a - b);
    const as = [...shape.anns].sort((a, b) => a - b);
    console.log(
      `        詩 ${ls[0]}–${ls[ls.length - 1]} 句、注解 ${as[0]}–${as[as.length - 1]} 條` +
        `（${shape.anns.filter((x) => x > 0).length} 首有注解）`,
    );
  }
  if (shape.bodies.length >= 20 && uniq < shape.bodies.length / 4) {
    console.log('  ⚠ 長度太集中了 —— 「最大單頁」那幾條預算量到的會是「典型」而不是「最大」。');
  }
}

/** @param {number} n */
async function makeVideos(n) {
  const raw = JSON.parse(await readFile(SYND, 'utf8'));
  try { await access(BACKUP); } catch { await copyFile(SYND, BACKUP); }
  const real = raw.items.length;
  const extra = [];
  for (let i = 0; i < n; i++) {
    /*
     * 標題與摘要也是分佈，理由跟內容那邊一樣（第 2 輪〔第十三圈〕）。
     * 中位數對齊真實的九支影片（2026-09-03 量的）：
     * 標題 51–72 字（中位 57，扣掉「測試影片 0000 —— 」這 13 個字 → 44）、
     * 摘要 76–147 字（中位 83）。原本兩個都是常數，於是 400 支假影片的
     * 平臺頁與搜尋索引在規模下都只有一種形狀。
     */
    const vidRnd = seeded(i * 104729 + 17);
    extra.push({
      id: `${PREFIX}video-${pad(i)}`,
      sourceId: raw.items[0]?.sourceId ?? 'youtube-foxpoetry',
      platform: 'youtube',
      media: 'video',
      title: `測試影片 ${pad(i)} —— ${prose(spread(44, vidRnd), i).replace(/\n/g, '')}`,
      url: `https://www.youtube.com/watch?v=FIXTURE${pad(i)}`,
      publishedAt: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString(),
      summary: prose(spread(83, vidRnd), i + 4242).replace(/\n/g, ''),
      lang: 'zh-TW',
      tags: [],
      thumbnail: null,
      origin: 'auto',
    });
  }
  raw.items = [...raw.items, ...extra];
  raw.itemCount = raw.items.length;
  await writeFile(SYND, JSON.stringify(raw, null, 2), 'utf8');
  console.log(`  syndication.json  ${real} 真的 + ${n} 假的 = ${raw.items.length}`);
}

async function doClean() {
  let removed = 0;
  for (const dir of await readdir(CONTENT)) {
    const full = resolve(CONTENT, dir);
    for (const f of await readdir(full).catch(() => [])) {
      if (!f.startsWith(PREFIX)) continue;
      await rm(resolve(full, f));
      removed++;
    }
  }
  let restored = false;
  try {
    await access(BACKUP);
    await copyFile(BACKUP, SYND);
    await rm(BACKUP);
    restored = true;
  } catch { /* 沒灌過假影片 */ }
  console.log(`\n刪掉 ${removed} 個假內容檔${restored ? '，並還原了 syndication.json' : ''}。`);

  // 一定要確認真的乾淨了 —— 假內容留在 repo 裡比沒做測試糟糕
  let left = 0;
  for (const dir of await readdir(CONTENT)) {
    for (const f of await readdir(resolve(CONTENT, dir)).catch(() => [])) {
      if (f.startsWith(PREFIX)) left++;
    }
  }
  const syndLeft = JSON.parse(await readFile(SYND, 'utf8')).items.filter(
    /** @param {{ id: string }} i */ (i) =>
    i.id.startsWith(PREFIX),
  ).length;
  if (left || syndLeft) {
    console.error(`\n還有殘留！內容 ${left} 個、syndication ${syndLeft} 筆。手動檢查。`);
    process.exit(1);
  }
  console.log('確認乾淨：找不到任何 FIXTURE- 開頭的東西。\n');
}

if (clean) {
  await doClean();
} else {
  console.log(`\n產生 ${count} 筆假內容${videoCount ? ` + ${videoCount} 支假影片` : ''}：`);
  await makeContent();
  if (videoCount) await makeVideos(videoCount);
  console.log(`\n量完之後一定要跑：node scripts/make-fixtures.mjs --clean\n`);
}
