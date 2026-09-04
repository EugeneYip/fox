#!/usr/bin/env node
// @ts-check
/**
 * 文件連結檢查的實測 —— `npm run test:doc-links`
 *
 * 每一條規則各一格正向、一格反向。反向那半是重點：
 * 一條「什麼都不報」的規則也會通過所有正向案例。
 */
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (/** @type {string} */ label, /** @type {boolean} */ ok, /** @type {unknown} */ got) => {
  console.log(`  ${ok ? '✓' : 'X'} ${label}`);
  if (!ok) {
    failed++;
    if (got !== undefined) console.log('      實際：', String(got));
  }
};

/**
 * 開一個假倉庫跑一次。
 * @param {Record<string, string>} files 相對路徑 → 內容
 */
async function inFixture(files) {
  const dir = await mkdtemp(join(tmpdir(), 'doc-links-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/check-doc-links.mjs'), `--root=${dir}`]);
    return { out: stdout, code: 0, dir };
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1, dir };
  }
}

console.log('\n文件連結檢查的判斷\n' + '─'.repeat(56));

/* 1. 指得到的檔案：綠 */
{
  const { out, code } = await inFixture({
    'README.md': '# 首頁\n\n看 [設定](docs/SETUP.md)。\n',
    'docs/SETUP.md': '# 設定\n',
  });
  check('連得到的檔案：✓ 而且 exit 0', /每一個都指得到/.test(out) && code === 0, `${out}（exit ${code}）`);
}

/* 2. 指不到的檔案：紅，而且點名是哪一行、找不到什麼 */
{
  const { out, code } = await inFixture({ 'README.md': '# 首頁\n\n看 [設定](docs/SETUP.md)。\n' });
  check(
    '檔案不存在：擋下來，點名行號與找不到的路徑',
    /doc-link-missing/.test(out) && /README\.md:3/.test(out) && /找不到 docs\/SETUP\.md/.test(out) && code === 1,
    `${out}（exit ${code}）`,
  );
}

/* 3. 相對路徑是相對於「連結所在的那份文件」，不是倉庫根目錄 */
{
  const { out, code } = await inFixture({
    'docs/A.md': '# A\n\n看 [B](B.md) 與 [根](../README.md)。\n',
    'docs/B.md': '# B\n',
    'README.md': '# 首頁\n',
  });
  check('相對路徑以所在文件為基準（同層與上一層都對）', /每一個都指得到/.test(out) && code === 0, `${out}（exit ${code}）`);
}

/* 4. 錨點對得到：綁的是「標題轉小寫、去標點、空白換連字號」 */
{
  const { out, code } = await inFixture({
    'README.md': '# 首頁\n\n看[「怎麼讓它上線」](#怎麼讓它上線)。\n\n## 怎麼讓它上線\n',
  });
  check('同一份文件裡的錨點對得到（標點會被去掉）', /每一個都指得到/.test(out) && code === 0, `${out}（exit ${code}）`);
}

/* 5. 錨點對不到：紅。標題改過字最容易出這個 */
{
  const { out, code } = await inFixture({
    'README.md': '# 首頁\n\n看 [上線](#怎麼讓它上線)。\n\n## 怎麼讓它真的上線\n',
  });
  check(
    '錨點對不到：擋下來（反向案例）',
    /doc-anchor-missing/.test(out) && code === 1,
    `${out}（exit ${code}）`,
  );
}

/* 6. 跨檔案的錨點也要看 */
{
  const { out, code } = await inFixture({
    'README.md': '# 首頁\n\n看 [那一節](docs/X.md#沒有這一節)。\n',
    'docs/X.md': '# X\n\n## 有的那一節\n',
  });
  check('別份文件裡的錨點也檢查（反向案例）', /doc-anchor-missing/.test(out) && code === 1, `${out}（exit ${code}）`);
}

/*
 * 7. 外部連結不看。
 *    要打網路才知道，而且別人的網站什麼時候搬家不是這個倉庫控制得了的。
 */
{
  const { out, code } = await inFixture({
    'README.md': '# 首頁\n\n[外面](https://example.com/絕對不存在) 與 [信](mailto:a@b.c)。\n',
  });
  check('外部連結不看（反向案例）', /每一個都指得到/.test(out) && code === 0, `${out}（exit ${code}）`);
}

/*
 * 8. 一份都沒掃到要擋。
 *    這個倉庫的其他檢查都踩過「0 個對象而關卡是綠的」。
 */
{
  const { out, code } = await inFixture({ 'notes.txt': '這不是 markdown' });
  check('一份 markdown 都沒有：擋下來，說「什麼都沒檢查」', /什麼都沒檢查/.test(out) && code === 1, `${out}（exit ${code}）`);
}

/*
 * 9. 歷史紀錄跳過，但要說出來。
 *    安靜地跳過，會讓「沒有發現問題」蓋掉「最大的那份沒看」。
 */
{
  const { out, code } = await inFixture({
    'README.md': '# 首頁\n',
    'docs/REVIEW-LOG.md': '# 紀錄\n\n[早就刪掉的](docs/GONE.md)\n',
  });
  check(
    '歷史紀錄跳過，而且明講跳過了哪一份',
    /跳過 1 份：docs\/REVIEW-LOG\.md/.test(out) && code === 0,
    `${out}（exit ${code}）`,
  );
}

/* 10. 圖片的路徑打錯後果一樣，也要看 */
{
  const { out, code } = await inFixture({ 'README.md': '# 首頁\n\n![一張圖](img/nope.png)\n' });
  check('圖片路徑也檢查', /doc-link-missing/.test(out) && code === 1, `${out}（exit ${code}）`);
}

console.log(failed === 0 ? '\n全部通過。\n' : `\n${failed} 項失敗。\n`);
process.exit(failed === 0 ? 0 : 1);
