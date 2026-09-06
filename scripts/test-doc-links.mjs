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

/*
 * ── 11. 文件叫人跑的指令，還存在嗎 ──────────────────
 *
 * 第 3 輪（第三十八圈）：這一支已經在守「連結指不指得到」，
 * 而那些文件除了連結還會**叫人跑指令**。那是同一種宣稱。
 *
 * 量出來 8 份主要文件提到 42 個 `npm run`，當時一個都沒壞 ——
 * 所以這是預防性的。改個 script 名字，七份文件會同時指到不存在的指令，
 * 而**要等到有人真的去打它才會發現**；對站主來說那一刻多半是她想發文的時候。
 */
{
  const pkg = (/** @type {string[]} */ names) =>
    JSON.stringify({ scripts: Object.fromEntries(names.map((n) => [n, 'x'])) });

  const okCase = await inFixture({
    'package.json': pkg(['write', 'build']),
    'README.md': '# 首頁\n\n寫一篇：`npm run write`，然後 `npm run build`。\n',
  });
  check('指令都存在：✓ 而且 exit 0', /每一個都指得到/.test(okCase.out) && okCase.code === 0, `${okCase.out}（exit ${okCase.code}）`);

  const bad = await inFixture({
    'package.json': pkg(['build']),
    'README.md': '# 首頁\n\n寫一篇：`npm run write`。\n',
  });
  check(
    '指令不存在：紅，而且點名是哪一行、哪個 script',
    /\[doc-command-missing\] README\.md:3/.test(bad.out) && /沒有 "write" 這個 script/.test(bad.out) && bad.code === 1,
    `${bad.out}（exit ${bad.code}）`,
  );

  /* `--` 後面的旗標是傳給腳本的，不是 script 名字 */
  const flags = await inFixture({
    'package.json': pkg(['check:a11y']),
    'README.md': '# 首頁\n\n`npm run check:a11y -- --verbose`\n',
  });
  check('`-- --verbose` 那種旗標不會被當成 script 名字', flags.code === 0, `${flags.out}（exit ${flags.code}）`);

  /* 讀不到 package.json 時不比，而且要說出來 */
  const noPkg = await inFixture({ 'README.md': '# 首頁\n\n`npm run whatever`\n' });
  check(
    '沒有 package.json 時說「這次沒有比對」，不是安靜放行',
    /讀不到 package.json —— 文件裡的 npm run 指令這次沒有比對/.test(noPkg.out),
    noPkg.out,
  );

  /* 連結與指令要分開講 —— 合起來說「N 個連結」會把指令算成連結 */
  const split = await inFixture({
    'package.json': pkg(['build']),
    'README.md': '# 首頁\n\n[設定](docs/S.md) 然後 `npm run build`。\n',
    'docs/S.md': '# S\n',
  });
  check('摘要把連結與指令分開數', /1 個連結、1 處 npm run 指令/.test(split.out), split.out);
}

/*
 * ── 關卡自己的「改法」點名的檔案 ──────────────────────
 *
 * 第 2 輪（第四十一圈）加的。九支關卡的建議裡有 31 個檔案引用，
 * 而在這之前沒有東西在守它們 —— 第 2 輪（第四十圈）就撞過一次
 * （`check:perf` 叫人去改一個早就不存在的 prop）。
 *
 * 假倉庫裡放一支假的關卡腳本就驗得到：規則掃的是 `scripts/<關卡>.mjs`。
 */
{
  const bad = await inFixture({
    'README.md': '# 首頁\n',
    'scripts/check-a11y.mjs': "add('x', '出事了。　改法：去改 NoSuchThing.astro 就好。');\n",
  });
  check(
    '關卡的改法點名不存在的檔案：擋下來',
    /advice-target-missing/.test(bad.out) && /NoSuchThing\.astro/.test(bad.out) && bad.code === 1,
    `${bad.out}（exit ${bad.code}）`,
  );

  /* 反向：點名的檔案真的在，就不要出聲 */
  const ok = await inFixture({
    'README.md': '# 首頁\n',
    'scripts/check-a11y.mjs': "add('x', '出事了。　改法：去改 Real.astro 就好。');\n",
    'src/components/Real.astro': '<div />\n',
  });
  check(
    '點名的檔案存在：不出聲（反向案例）',
    !/advice-target-missing/.test(ok.out) && ok.code === 0,
    `${ok.out}（exit ${ok.code}）`,
  );
}

console.log(failed === 0 ? '\n全部通過。\n' : `\n${failed} 項失敗。\n`);
process.exit(failed === 0 ? 0 : 1);
