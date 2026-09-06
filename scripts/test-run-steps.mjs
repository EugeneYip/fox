#!/usr/bin/env node
// @ts-check
/**
 * `run-steps.mjs` —— 讓紅燈的**最後一行說實話**的那一支。
 *
 * 為什麼值得一支測試：它守的東西是「出事的時候看得到什麼」。
 * 第 7 輪（第三十八圈）實測過那個缺口：`test:tools` 用 `&&` 串的時候，
 * 離開碼 1、輸出 919 行，而失敗在 802–834 行 —— **後面還有 85 行 `✓`**。
 * `tail` 看到的全是勾。
 *
 * 這一支自己壞掉的話，下一個人又會回到「重跑碰運氣」。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
/** @param {string} name @param {boolean} pass @param {string} [detail] */
const ok = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : 'X'} ${name}`);
  if (!pass && detail) console.log(`        ${detail}`);
};

console.log('\nrun-steps\n' + '─'.repeat(64));

const dir = await mkdtemp(join(tmpdir(), 'run-steps-'));
/** @param {Record<string, string>} scripts @param {string[]} args */
const go = async (scripts, args) => {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts }), 'utf8');
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/run-steps.mjs'), `--root=${dir}`, ...args]);
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1 };
  }
};

const green = await go({ chain: 'npm run a && npm run b', a: 'node -e ""', b: 'node -e ""' }, ['chain']);
ok('全綠：最後一行說「N 步全部通過」', /2 步全部通過/.test(green.out) && green.code === 0, `${green.out}（exit ${green.code}）`);

/*
 * 這一格是重點：**失敗在中間**，而後面那一步不會跑。
 * 最後印的必須是「停在第幾步」，不是別的東西。
 */
const red = await go(
  { chain: 'npm run a && npm run b && npm run c', a: 'node -e ""', b: 'node -e "console.log(\'  X 壞了\');process.exit(1)"', c: 'node -e ""' },
  ['chain'],
);
ok('中間紅：最後一行說停在第幾步、哪一個 script', /X 停在第 2 步／共 3 步：npm run b/.test(red.out) && red.code === 1, `${red.out}（exit ${red.code}）`);
ok('把那一步「長得像失敗」的行撿出來當證據', /X 壞了/.test(red.out), red.out);
ok('告訴你怎麼只跑那一步', /只跑那一步：npm run b/.test(red.out), red.out);

/* 展開是遞迴的 —— test:tools 展成 test:units 與 test:built 底下每一格 */
const nested = await go(
  { top: 'npm run mid && npm run z', mid: 'npm run a && npm run b', a: 'node -e ""', b: 'node -e ""', z: 'node -e ""' },
  ['top'],
);
ok('巢狀的串會展開（3 步不是 2 步）', /3 步全部通過/.test(nested.out), nested.out);

/* 展不開的（不是純 npm run 串）就當成一步，不要硬拆 */
const shell = await go({ chain: 'node -e ""' }, ['chain']);
ok('不是純 npm run 串的就當成一步', /1 步全部通過/.test(shell.out), shell.out);

await rm(dir, { recursive: true, force: true });

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
