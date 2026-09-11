#!/usr/bin/env node
// @ts-check
/**
 * 產生 PNG 圖示與社群分享圖。
 *
 *   npm run icons
 *
 * （要 `--experimental-strip-types`，因為分享圖上的字是從 `src/config/site.ts`
 * 讀出來的 —— 見下面 import 那一行的說明。npm script 就是為了把那個旗標
 * 收在一個地方。）
 *
 * 用 sharp 把 SVG 轉成 PNG。sharp 本來就是 Astro 的相依套件，不必另外裝。
 * 產出的檔案會被 commit 進 repo —— 它們很少變動，沒必要每次 build 都重跑。
 *
 * 注意：分享圖上的中文要靠系統字型算出來。在 macOS 上沒問題；
 * 在 CI（Ubuntu）上可能缺中文字型而變成豆腐格，所以這個腳本設計成
 * 手動在本機跑，不放進 GitHub Actions。
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
/*
 * ── 分享圖上的三行字，本來是手抄的 ──────────────────
 *
 * 第 6 輪（第五十三圈）量到：`ogSvg({ title: '狐說八道', tagline: '一隻狐狸，說古人的話',
 * epigraph: '青青子衿，悠悠我心' })` —— 三個字串在 `src/config/site.ts` 裡都有
 * （`site.name['zh-TW']`、`site.tagline['zh-TW']`、`site.epigraph.text`），
 * 而這裡各抄了一份。今天三份都一樣，所以不是 bug，是一個等著發生的分岔。
 *
 * 為什麼這一份特別危險：改站名的時候，每一頁、兩份 feed、`site.webmanifest`
 * 都會跟著動（manifest 那一份還有 `manifest-drift` 在守），
 * **只有這一張 PNG 不會** —— 而且它是二進位，任何掃字串的檢查都看不進去。
 * 社群分享出去的那張圖會一直印著舊站名，沒有人會收到通知。
 *
 * 改成直接讀 `site.ts`。代價是這支腳本從此要 `--experimental-strip-types`
 * （`check:copy` 早就是這樣跑的），所以順手補了 `npm run icons`。
 */
import { site } from '../src/config/site.ts';
/*
 * 狐狸的幾何也是同一種情況 —— 2026-09-09 改設計之前，這幾條路徑在
 * 這裡、`FoxMark.astro`、`public/favicon.svg` 各抄了一份，三份都要手改。
 * 現在只有 `src/config/fox-mark.ts` 一份，而 favicon.svg 也由這支產生。
 */
import { FOX_HEAD, FOX_EYE_L, FOX_EYE_R, FOX_NOSE, FOX_VIEWBOX } from '../src/config/fox-mark.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(ROOT, 'public');

/*
 * ── 顏色也從 tokens.css 讀，不再手抄 ──────────────────
 *
 * 站名與狐狸的幾何已經各自收攏過（上面兩段註解），顏色是最後一份複本：
 * 六個值 —— 紙、狐火、墨、次要墨，加上深色的紙與狐火 —— 在這裡寫死，
 * 而它們就是 `tokens.css` 的 --c-bg／--c-flame／--c-ink／--c-ink-soft。
 * 第 6 輪（第五十三圈）收字串的時候沒有一起收，理由是「要從 CSS 剖析變數
 * 比 import 一個 .ts 麻煩」—— 但這支腳本本來就吃 --experimental-strip-types，
 * 而 tokens.css 的寫法規律到只要一行正則。
 *
 * 分享圖是**二進位**：改了 tokens.css 而這裡沒跟上，站上的顏色會換、
 * 社群卡片上的不會，而掃字串的檢查一個字都看不進去。
 *
 * 找不到 token 就直接拋 —— 安靜地退回一個預設色，正是這段要防的事。
 */
const TOKENS = await readFile(resolve(ROOT, 'src/styles/tokens.css'), 'utf8');

/**
 * 從 tokens.css 取一個顏色 token 的淺色與深色值。
 *
 * 認的是 `--name: light-dark(淺, 深);` 那一行（每個 token 上面還有一行
 * 單值 fallback，那一行只有淺色，所以一律讀 light-dark 這一行）。
 *
 * @param {string} name 例如 `--c-bg`
 * @returns {{ light: string, dark: string }}
 */
function token(name) {
  const m = new RegExp(
    `${name}:\\s*light-dark\\(\\s*(#[0-9a-fA-F]{3,8})\\s*,\\s*(#[0-9a-fA-F]{3,8})\\s*\\)`
  ).exec(TOKENS);
  if (!m) throw new Error(`tokens.css 裡找不到 ${name} 的 light-dark() 宣告`);
  return { light: m[1], dark: m[2] };
}

const PAPER = token('--c-bg').light;
const FLAME = token('--c-flame').light;
const INK = token('--c-ink').light;
const SOFT = token('--c-ink-soft').light;

const FOX_PATH = FOX_HEAD;
const EYE_L = FOX_EYE_L;
const EYE_R = FOX_EYE_R;
const NOSE = FOX_NOSE;
const INK_DARK = token('--c-bg').dark;
const FLAME_DARK = token('--c-flame').dark;

/**
 * public/favicon.svg —— 分頁上的那一個。
 *
 * 現代瀏覽器讀 SVG，所以這一份可以帶 `prefers-color-scheme`，
 * 深色分頁列上換成比較亮的火色。底下那段 `<style>` 靠屬性選擇器認顏色，
 * 所以填色一定要跟選擇器裡寫的字串一字不差。
 */
function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FOX_VIEWBOX} ${FOX_VIEWBOX}">
  <rect width="${FOX_VIEWBOX}" height="${FOX_VIEWBOX}" rx="12" fill="${PAPER}"/>
  <path d="${FOX_PATH}" fill="${FLAME}"/>
  <path d="${EYE_L}" fill="${PAPER}"/>
  <path d="${EYE_R}" fill="${PAPER}"/>
  <path d="${NOSE}" fill="${PAPER}"/>
  <style>
    @media (prefers-color-scheme: dark) {
      rect { fill: ${INK_DARK} }
      path[fill="${PAPER}"] { fill: ${INK_DARK} }
      path[fill="${FLAME}"] { fill: ${FLAME_DARK} }
    }
  </style>
</svg>
`;
}

/**
 * 方形圖示。padding 是內縮比例，maskable 版本要留安全區。
 * @param {{ size: number, padding?: number, background?: string, rounded?: boolean }} opts
 */
function iconSvg({ size, padding = 0.14, background = PAPER, rounded = true }) {
  const inner = size * (1 - padding * 2);
  const offset = size * padding;
  const radius = rounded ? size * 0.2 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${background}"/>
  <g transform="translate(${offset} ${offset}) scale(${inner / 64})">
    <path d="${FOX_PATH}" fill="${FLAME}"/>
    <path d="${EYE_L}" fill="${background}"/>
    <path d="${EYE_R}" fill="${background}"/>
    <path d="${NOSE}" fill="${background}"/>
  </g>
</svg>`;
}

/**
 * 社群分享圖 1200×630
 * @param {{ title: string, tagline: string, epigraph: string }} opts
 */
function ogSvg({ title, tagline, epigraph }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="24%" cy="0%" r="78%">
      <stop offset="0%" stop-color="#fbeee3"/>
      <stop offset="100%" stop-color="${PAPER}"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="1200" height="8" fill="${FLAME}"/>

  <g transform="translate(96 168) scale(2.1)">
    <path d="${FOX_PATH}" fill="none" stroke="${FLAME}" stroke-width="3" stroke-linejoin="round"/>
    <path d="${EYE_L}" fill="${FLAME}"/>
    <path d="${EYE_R}" fill="${FLAME}"/>
    <path d="${NOSE}" fill="${FLAME}"/>
  </g>

  <text x="300" y="270" font-family="Songti TC, Noto Serif TC, Source Han Serif TC, serif"
        font-size="104" font-weight="600" fill="${INK}" letter-spacing="10">${title}</text>
  <text x="300" y="336" font-family="PingFang TC, Noto Sans TC, sans-serif"
        font-size="34" fill="${SOFT}" letter-spacing="3">${tagline}</text>
  <text x="300" y="420" font-family="Songti TC, Noto Serif TC, serif"
        font-size="30" fill="#857c70" letter-spacing="8">${epigraph}</text>

  <text x="300" y="530" font-family="PingFang TC, Noto Sans TC, sans-serif"
        font-size="26" fill="${FLAME}" letter-spacing="2">bellafoxy.com</text>
</svg>`;
}

/**
 * SVG → PNG。
 *
 * 兩個壓縮上的決定，都是量出來的（見 docs/REVIEW-LOG.md 第 2 輪）：
 *
 * - flatten：這些圖都有不透明的底色，alpha 通道整張都是 255，純粹是浪費。
 *   去掉之後 og/default.png 從 45.2 KB 降到 24.9 KB，畫面完全沒變。
 * - effort: 10：sharp 的 PNG 最高壓縮努力度。建置時間多幾百毫秒，
 *   但這個腳本是手動跑的、產物進版控，所以慢一點無所謂。
 *
 * 試過但沒採用：
 * - palette 量化（256/128/64/32 色）→ 都是 27 KB，比不過單純去 alpha
 * - JPEG q82 → 22.8 KB，但中文字邊緣會出現振鈴
 * - WebP q85 → 17.3 KB，最小，但部分社群平臺與通訊軟體不吃 WebP 的 og:image
 */
/**
 * 把一張 PNG 包成真正的 ICO 容器。
 *
 * ── 為什麼要這一段 ────────────────────────────────
 *
 * `public/favicon.ico` 原本是**一張 PNG，只是副檔名叫 .ico**
 * （`file` 回報 "PNG image data, 32 x 32"）。現代瀏覽器會嗅探內容所以看得懂，
 * 但這個檔名對外宣告的是 ICO 格式，而瀏覽器在沒有 `<link>` 指路時
 * 會自己去要網站根目錄的 `/favicon.ico` —— 那條路上還有 Windows 的
 * 捷徑、部分 RSS 閱讀器、以及各種連結預覽機器人，它們不一定會嗅探。
 *
 * ICO 從 Vista 起就允許直接裝一張 PNG，所以包一層 22 位元組的頭就好，
 * 不必真的去產生 BMP。
 *
 * @param {Buffer} pngBuffer 32×32 的 PNG
 * @param {number} size
 * @returns {Buffer}
 */
function icoFromPng(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);  // 保留欄位，必須是 0
  header.writeUInt16LE(1, 2);  // 類型：1 = 圖示（2 是滑鼠游標）
  header.writeUInt16LE(1, 4);  // 這個檔案裡有幾張圖
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size % 256, 0);  // 寬（256 要寫成 0，這裡是 32）
  entry.writeUInt8(size % 256, 1);  // 高
  entry.writeUInt8(0, 2);           // 調色盤色數，0 = 不用調色盤
  entry.writeUInt8(0, 3);           // 保留欄位
  entry.writeUInt16LE(1, 4);        // 色彩平面數
  entry.writeUInt16LE(32, 6);       // 每像素位元數
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(6 + 16, 12);  // 影像資料從第 22 個位元組開始
  return Buffer.concat([header, entry, pngBuffer]);
}

/**
 * @param {string} svg
 * @param {string} outPath
 * @param {string} [background]
 */
async function png(svg, outPath, background) {
  let pipeline = sharp(Buffer.from(svg));
  if (background) pipeline = pipeline.flatten({ background });
  const buffer = await pipeline.png({ compressionLevel: 9, effort: 10 }).toBuffer();
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buffer);
  console.log(`  ✓ ${outPath.replace(ROOT + '/', '')}  ${(buffer.length / 1024).toFixed(1)} KB`);
}

/*
 * ── `--check`：有沒有人改了狐狸卻忘了重跑 ──────────────
 *
 * 2026-09-09 的事故：狐狸重畫那天，`FoxMark.astro` 換了新的，
 * 而 `favicon.svg` 還是舊的 —— 分頁上的小圖示跟站上的標記不一樣，
 * 而六道關卡與 `test:tools` **全綠**（PNG 是二進位，掃字串的檢查看不進去）。
 * 幾何後來收攏到 `src/config/fox-mark.ts` 一份了，但「忘記重跑」這件事
 * 仍然沒有人在守。這就是那道守門。
 *
 * **只比對 `favicon.svg`**，理由是它是這裡唯一**逐位元組確定**的產物：
 * 它是一串字，同一份輸入在任何機器上都一樣。
 *
 * PNG 與分享圖刻意不比：
 *   · PNG 由 sharp／libvips 編碼，換一個版本就可能換一組位元組
 *   · 分享圖上的中文要靠**系統字型**算出來，CI 的 Ubuntu 上會變豆腐格
 * 拿它們去比，CI 會紅在跟狐狸無關的事情上 —— 那種檢查會被學會忽略。
 *
 * 它證明的是「有人跑過 `npm run icons`」（六個檔案是同一支腳本
 * 一次寫出來的），不是「六個檔案都對」。這個分寸寫在這裡，不要誤讀。
 */
const CHECK = process.argv.includes('--check');

if (CHECK) {
  const want = faviconSvg();
  const have = await readFile(resolve(PUBLIC, 'favicon.svg'), 'utf8').catch(() => '');
  if (have === want) {
    console.log('✓ public/favicon.svg 跟 src/config/fox-mark.ts 對得上');
    process.exit(0);
  }
  console.error('X public/favicon.svg 跟 src/config/fox-mark.ts 對不上了。');
  console.error('  改法：跑 `npm run icons` 重新產生（六個圖示與分享圖會一起更新）。');
  console.error('  這不只是檔案整潔：分頁上的小圖示會一直是舊的那隻狐狸，');
  console.error('  而 PNG 是二進位，其他每一道檢查都看不進去。');
  process.exit(1);
}

console.log('\n產生圖示與分享圖\n' + '─'.repeat(40));

await writeFile(resolve(PUBLIC, 'favicon.svg'), faviconSvg(), 'utf8');
console.log('  favicon.svg');

await png(iconSvg({ size: 192 }), resolve(PUBLIC, 'icon-192.png'), PAPER);
await png(iconSvg({ size: 512 }), resolve(PUBLIC, 'icon-512.png'), PAPER);
// maskable：Android 會把圖示裁成各種形狀，內容要縮進安全區，背景填滿
await png(
  iconSvg({ size: 512, padding: 0.22, rounded: false }),
  resolve(PUBLIC, 'icon-maskable-512.png'),
  PAPER,
);
await png(iconSvg({ size: 180, padding: 0.1 }), resolve(PUBLIC, 'apple-touch-icon.png'), PAPER);

// favicon.ico：現代瀏覽器讀 SVG，這個是給舊瀏覽器與部分 RSS 閱讀器的備援。
// 包成真的 ICO 容器 —— 副檔名說什麼，檔案就該是什麼（見 icoFromPng 的說明）。
{
  const body = await sharp(Buffer.from(iconSvg({ size: 32, padding: 0.06 })))
    .flatten({ background: PAPER })
    .png({ compressionLevel: 9, effort: 10 })
    .toBuffer();
  const ico = icoFromPng(body, 32);
  await writeFile(resolve(PUBLIC, 'favicon.ico'), ico);
  console.log(`  ✓ public/favicon.ico  ${(ico.length / 1024).toFixed(1)} KB（真的 ICO 容器）`);
}

await png(
  ogSvg({
    title: site.name['zh-TW'],
    tagline: site.tagline['zh-TW'],
    epigraph: site.epigraph.text,
  }),
  resolve(PUBLIC, 'og/default.png'),
  PAPER,
);

console.log('\n完成。中文若變成方框，代表系統缺字型 —— 請在 macOS 本機執行。\n');
