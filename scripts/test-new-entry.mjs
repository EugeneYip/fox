#!/usr/bin/env node
// @ts-check
/**
 * `npm run write` 的實測 —— `npm run test:new-entry`
 *
 * 這支腳本是站主 2026-09-03 要的「Bella 自己就能發文」那條路。
 * 它會**寫檔案到 src/content/**，所以測試一律用 `--root=` 指到暫存目錄，
 * 絕不碰真的內容。零網路。
 */
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
/** @param {string} name @param {boolean} good @param {unknown} [detail] */
const ok = (name, good, detail) => {
  console.log(`  ${good ? '✓' : 'X'} ${name}`);
  if (!good) {
    failed++;
    if (detail !== undefined) console.log('      實際：', String(detail).slice(0, 500));
  }
};

/** @param {string} dir @param {string[]} flags */
async function write(dir, flags) {
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/new-entry.mjs'), `--root=${dir}`, ...flags]);
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, stderr?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? '') + String(e?.stderr ?? ''), code: e?.code ?? 1 };
  }
}

console.log('\n開新內容的實測\n' + '─'.repeat(56));

/* 短札：最單純的一種 */
{
  const dir = await mkdtemp(join(tmpdir(), 'write-'));
  const { code } = await write(dir, ['--collection=notes', '--title=測試短札', '--slug=test-note', '--description=一句話']);
  const md = await readFile(join(dir, 'src/content/notes/test-note.md'), 'utf8').catch(() => '');
  ok('短札：寫到 src/content/notes/<slug>.md', code === 0 && md.includes('title: 測試短札'), md.slice(0, 120));
  /*
   * 預設草稿是刻意的：沒有人會因為手滑而發佈。
   * 少了這一格，把預設改成 false 會靜靜通過。
   */
  ok('預設是草稿', md.includes('draft: true'), md.slice(0, 200));
  await rm(dir, { recursive: true, force: true });
}

/* 詩詞：多一整塊 poem */
{
  const dir = await mkdtemp(join(tmpdir(), 'write-'));
  await write(dir, ['--collection=poems', '--title=測試詩', '--slug=test-poem', '--author=某某', '--dynasty=唐']);
  const md = await readFile(join(dir, 'src/content/poems/test-poem.md'), 'utf8').catch(() => '');
  const good =
    md.includes('translationKey: test-poem') &&
    md.includes('poem:') &&
    md.includes('  author: 某某') &&
    md.includes('  dynasty: 唐') &&
    md.includes('original: |');
  ok('詩詞：poem 區塊與 translationKey 都在', good, md);
  await rm(dir, { recursive: true, force: true });
}

/*
 * slug 一定要壓成小寫。這個 repo 在標籤與 `related` 上各踩過一次
 * 大小寫的坑，而 macOS 的檔案系統不分大小寫 —— 本機看不出來。
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'write-'));
  await write(dir, ['--collection=notes', '--title=大小寫', '--slug=Test Note ABC']);
  const md = await readFile(join(dir, 'src/content/notes/test-note-abc.md'), 'utf8').catch(() => '');
  ok('slug 壓成小寫、空白換成連字號', md.includes('title: 大小寫'), md.slice(0, 80) || '（沒有那個檔案）');
  await rm(dir, { recursive: true, force: true });
}

/* 不覆蓋已經存在的 */
{
  const dir = await mkdtemp(join(tmpdir(), 'write-'));
  await mkdir(join(dir, 'src/content/notes'), { recursive: true });
  await writeFile(join(dir, 'src/content/notes/taken.md'), '原本就有的內容\n', 'utf8');
  const { code, out } = await write(dir, ['--collection=notes', '--title=撞名', '--slug=taken']);
  const kept = await readFile(join(dir, 'src/content/notes/taken.md'), 'utf8');
  ok('檔名已經存在：不覆蓋、離開碼 1', code === 1 && kept.includes('原本就有的內容'), `code=${code} ${out.slice(0, 120)}`);
  await rm(dir, { recursive: true, force: true });
}

/* 不認得的集合 */
{
  const dir = await mkdtemp(join(tmpdir(), 'write-'));
  const { code, out } = await write(dir, ['--collection=poem', '--title=打錯了', '--slug=x']);
  ok('集合名打錯：擋下來並說有哪幾種', code === 1 && out.includes('poems'), `code=${code} ${out.slice(0, 120)}`);
  await rm(dir, { recursive: true, force: true });
}

/* 明確說不要草稿 */
{
  const dir = await mkdtemp(join(tmpdir(), 'write-'));
  await write(dir, ['--collection=posts', '--title=直接發', '--slug=go-live', '--draft=n']);
  const md = await readFile(join(dir, 'src/content/posts/go-live.md'), 'utf8').catch(() => '');
  ok('--draft=n：沒有 draft 那一行（反向案例）', md.length > 0 && !md.includes('draft:'), md.slice(0, 160));
  await rm(dir, { recursive: true, force: true });
}

console.log('─'.repeat(56));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
