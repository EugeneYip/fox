#!/usr/bin/env node
// @ts-check
/**
 * 產生 PNG 圖示與社群分享圖。
 *
 *   node scripts/make-icons.mjs
 *
 * 用 sharp 把 SVG 轉成 PNG。sharp 本來就是 Astro 的相依套件，不必另外裝。
 * 產出的檔案會被 commit 進 repo —— 它們很少變動，沒必要每次 build 都重跑。
 *
 * 注意：分享圖上的中文要靠系統字型算出來。在 macOS 上沒問題；
 * 在 CI（Ubuntu）上可能缺中文字型而變成豆腐格，所以這個腳本設計成
 * 手動在本機跑，不放進 GitHub Actions。
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = resolve(ROOT, 'public');

const PAPER = '#faf6ee';
const FLAME = '#d2622a';
const INK = '#1f1c18';
const SOFT = '#55504a';

const FOX_PATH =
  'M10 3 L7.5 25 C7.5 36 13 44 32 62 C51 44 56.5 36 56.5 25 L54 3 L38.5 19.5 L25.5 19.5 Z';
const EYE_L = 'M17 29 L25.5 32.5 L19.5 36 Z';
const EYE_R = 'M47 29 L38.5 32.5 L44.5 36 Z';
const NOSE = 'M32 47 L28.5 51.5 L35.5 51.5 Z';

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

console.log('\n產生圖示與分享圖\n' + '─'.repeat(40));

await png(iconSvg({ size: 192 }), resolve(PUBLIC, 'icon-192.png'), PAPER);
await png(iconSvg({ size: 512 }), resolve(PUBLIC, 'icon-512.png'), PAPER);
// maskable：Android 會把圖示裁成各種形狀，內容要縮進安全區，背景填滿
await png(
  iconSvg({ size: 512, padding: 0.22, rounded: false }),
  resolve(PUBLIC, 'icon-maskable-512.png'),
  PAPER,
);
await png(iconSvg({ size: 180, padding: 0.1 }), resolve(PUBLIC, 'apple-touch-icon.png'), PAPER);

// favicon.ico：現代瀏覽器讀 SVG，這個是給舊瀏覽器與部分 RSS 閱讀器的備援
await png(iconSvg({ size: 32, padding: 0.06 }), resolve(PUBLIC, 'favicon.ico'), PAPER);

await png(
  ogSvg({ title: '狐說八道', tagline: '一隻狐狸，說古人的話', epigraph: '青青子衿，悠悠我心' }),
  resolve(PUBLIC, 'og/default.png'),
  PAPER,
);

console.log('\n完成。中文若變成方框，代表系統缺字型 —— 請在 macOS 本機執行。\n');
