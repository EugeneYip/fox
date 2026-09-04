#!/usr/bin/env node
// @ts-check
/**
 * `compareDirs` 的實測 —— `npm run test:dist-diff`
 *
 * 這是 `ci:sim` 的第一個有測試的部分。那支腳本本身是「跑起來就會做事」的
 * （建置、跑六道關卡），要測得先拆；這一塊是拆得出來的那一塊，
 * 而它回答的正是這一圈的問題：**我在本機看到的，跟讀者拿到的，一樣嗎？**
 *
 * 零網路、零建置。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareDirs } from './lib/dist-diff.mjs';

let failed = 0;
/** @param {string} name @param {boolean} good @param {unknown} [detail] */
const ok = (name, good, detail) => {
  console.log(`  ${good ? '✓' : 'X'} ${name}`);
  if (!good) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
};

/** @param {Record<string, string>} files */
async function dir(files) {
  const d = await mkdtemp(join(tmpdir(), 'dist-diff-'));
  for (const [name, body] of Object.entries(files)) {
    const p = join(d, name);
    await mkdir(join(p, '..'), { recursive: true });
    await writeFile(p, body, 'utf8');
  }
  return d;
}

console.log('\ndist 比對的實測\n' + '─'.repeat(56));

{
  const a = await dir({ 'index.html': '<p>一樣</p>', 'a/b.css': 'x{}' });
  const b = await dir({ 'index.html': '<p>一樣</p>', 'a/b.css': 'x{}' });
  const r = await compareDirs(a, b);
  ok(
    '一模一樣：三個清單都是空的，same 是檔案數',
    r.onlyA.length === 0 && r.onlyB.length === 0 && r.differing.length === 0 && r.same === 2,
    r,
  );
  await rm(a, { recursive: true, force: true });
  await rm(b, { recursive: true, force: true });
}

{
  /* 這是 identity.local.ts 造成的那一種：同一個檔案，內容多一段 */
  const a = await dir({ 'about/index.html': '<p>所在 臺灣</p>', 'index.html': '<p>同</p>' });
  const b = await dir({ 'about/index.html': '<p></p>', 'index.html': '<p>同</p>' });
  const r = await compareDirs(a, b);
  ok(
    '內容不同：指名是哪一個檔案',
    r.differing.length === 1 && r.differing[0] === join('about', 'index.html') && r.same === 1,
    r,
  );
  await rm(a, { recursive: true, force: true });
  await rm(b, { recursive: true, force: true });
}

{
  /*
   * 方向要分得出來。兩邊合起來報一個數字的話，「本機多一頁」跟
   * 「版控多一頁」會長得一樣 —— 而那是兩件完全不同的事：
   * 前者是本機多了沒進版控的東西，後者是本機的產出過期了。
   */
  const a = await dir({ 'index.html': 'x', 'only-local.html': 'x' });
  const b = await dir({ 'index.html': 'x', 'only-built.html': 'x' });
  const r = await compareDirs(a, b);
  ok(
    '只有一邊有：兩個方向分開報',
    r.onlyA.length === 1 && r.onlyA[0] === 'only-local.html' &&
      r.onlyB.length === 1 && r.onlyB[0] === 'only-built.html',
    r,
  );
  await rm(a, { recursive: true, force: true });
  await rm(b, { recursive: true, force: true });
}

{
  /* 二進位檔要按位元組比，不要當文字 —— 圖片與 favicon 都是這一種 */
  const a = await mkdtemp(join(tmpdir(), 'dist-diff-'));
  const b = await mkdtemp(join(tmpdir(), 'dist-diff-'));
  await writeFile(join(a, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]));
  await writeFile(join(b, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]));
  const r = await compareDirs(a, b);
  ok('二進位檔按位元組比得出來', r.differing.length === 1 && r.same === 0, r);
  await rm(a, { recursive: true, force: true });
  await rm(b, { recursive: true, force: true });
}

console.log('─'.repeat(56));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
