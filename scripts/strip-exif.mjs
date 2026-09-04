#!/usr/bin/env node
// @ts-check
/**
 * 清掉圖片的 EXIF。
 *
 *   node scripts/strip-exif.mjs [--dry-run]
 *
 * 手機拍的照片會帶 GPS 座標、拍攝時間、手機型號。這些東西一旦上傳，
 * 就等於把「這張照片在哪裡拍的」公開了。對一個希望保持低調的站來說，
 * 這是最容易出事又最容易忘記的地方。
 *
 * sharp 預設就不會複製 metadata，所以「重新寫出一次」就等於清乾淨了。
 * 順便把過大的圖縮到合理尺寸。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['src/assets', 'public'];
const EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff']);
const MAX_EDGE = 2400;
const DRY = process.argv.includes('--dry-run');

/** 這些是腳本自己產生的，本來就沒有 metadata，不用重複處理 */
const SKIP = /(favicon|icon-|apple-touch-icon|og\/)/;

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
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXT.has(extname(entry.name).toLowerCase())) yield full;
  }
}

console.log('\n清除圖片 metadata' + (DRY ? '（--dry-run，不寫檔）' : '') + '\n' + '─'.repeat(56));

let touched = 0;
let saved = 0;

for (const dir of DIRS) {
  for await (const file of walk(resolve(ROOT, dir))) {
    const rel = relative(ROOT, file);
    if (SKIP.test(rel)) continue;

    const input = await readFile(file);
    const image = sharp(input, { failOn: 'none' });
    const meta = await image.metadata();

    const sensitive = [];
    if (meta.exif) sensitive.push('EXIF');
    if (meta.icc) sensitive.push('ICC');
    if (meta.iptc) sensitive.push('IPTC');
    if (meta.xmp) sensitive.push('XMP');

    const tooBig = Math.max(meta.width ?? 0, meta.height ?? 0) > MAX_EDGE;
    if (sensitive.length === 0 && !tooBig) continue;

    const notes = [
      sensitive.length ? `含 ${sensitive.join('/')}` : null,
      tooBig ? `${meta.width}×${meta.height} → 長邊 ${MAX_EDGE}` : null,
    ].filter(Boolean).join('，');

    if (DRY) {
      console.log(`  · ${rel}  ${notes}`);
      touched++;
      continue;
    }

    let pipeline = sharp(input, { failOn: 'none' }).rotate(); // 依 EXIF 轉正之後再丟掉 EXIF
    if (tooBig) pipeline = pipeline.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });

    const output = await pipeline.toBuffer();
    await writeFile(file, output);

    const delta = input.length - output.length;
    saved += delta;
    touched++;
    console.log(`  ✓ ${rel}  ${notes}  (${delta > 0 ? '-' : '+'}${Math.abs(delta / 1024).toFixed(1)} KB)`);
  }
}

console.log('\n' + '─'.repeat(56));
console.log(
  touched === 0
    ? '所有圖片都是乾淨的。\n'
    : `處理了 ${touched} 個檔案${DRY ? '（未實際寫入）' : `，省下 ${(saved / 1024).toFixed(0)} KB`}。\n`,
);
