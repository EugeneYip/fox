#!/usr/bin/env node
// @ts-check
/**
 * 突變小工具自己的測試 —— `npm run test:mutate`
 *
 * 這支工具的價值**全部在那一行「配不到就停下來」**。
 * 少了它，一個沒套用的突變會看起來跟「測試有洞」一模一樣 ——
 * 而那正是第 1 輪（第二十二圈）真的發生過的事。
 *
 * 所以這裡守的第一件事就是：**配不到的時候要以離開碼 1 結束，
 * 而且不能動到檔案。**
 */
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', String(detail).slice(0, 300));
  }
};

/** @param {string[]} args */
async function mutate(args) {
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/mutate.mjs'), ...args]);
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, stderr?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? '') + String(e?.stderr ?? ''), code: e?.code ?? 1 };
  }
}

console.log('\n突變小工具\n' + '─'.repeat(56));

const dir = await mkdtemp(join(tmpdir(), 'mutate-'));
const file = join(dir, 'thing.mjs');
const ORIGINAL = 'export const answer = 42;\nexport const other = "keep me";\n';
await writeFile(file, ORIGINAL, 'utf8');

/* 1. 正常套用 */
{
  const r = await mutate([file, '--from', 'answer = 42', '--to', 'answer = 0']);
  const now = await readFile(file, 'utf8');
  check('套用得了', r.code === 0 && now.includes('answer = 0') && now.includes('keep me'), now);
}

/* 2. 還原 */
{
  const r = await mutate([file, '--restore']);
  const now = await readFile(file, 'utf8');
  const gone = await access(file + '.orig').then(() => false, () => true);
  check('還原得回來，而且備份檔會清掉', r.code === 0 && now === ORIGINAL && gone, now);
}

/*
 * 3. 這一格是整支工具的理由。
 *    配不到的時候要**紅**，不是安靜地什麼都不做。
 */
{
  const before = await readFile(file, 'utf8');
  const r = await mutate([file, '--from', '這一段根本不在裡面', '--to', 'x']);
  const after = await readFile(file, 'utf8');
  check(
    '配不到：離開碼 1、說得出找不到什麼、而且不動檔案',
    r.code === 1 && /找不到/.test(r.out) && after === before,
    `code=${r.code}｜${r.out.split('\n')[0]}`,
  );
  const noBackup = await access(file + '.orig').then(() => false, () => true);
  check('配不到時也不會留下 .orig', noBackup);
}

/* 4. 出現多次時只改第一次，並且說出來 */
{
  await writeFile(file, 'const a = 1;\nconst a = 1;\n', 'utf8');
  const r = await mutate([file, '--from', 'const a = 1;', '--to', 'const a = 2;']);
  const now = await readFile(file, 'utf8');
  check(
    '出現多次：只改第一次並講明',
    r.code === 0 && now === 'const a = 2;\nconst a = 1;\n' && /2 次/.test(r.out),
    `${r.out.trim()}｜${JSON.stringify(now)}`,
  );
  await mutate([file, '--restore']);
}

/* 5. 沒有備份時要求還原：講清楚，不要假裝成功 */
{
  const r = await mutate([file, '--restore']);
  check('沒有備份時的 --restore：離開碼 1', r.code === 1 && /沒有/.test(r.out), r.out.trim());
}

/*
 * ── 同一個檔案套用兩次：`.orig` 不能被蓋掉 ──────────
 *
 * 第 1 輪（第三十三圈）踩到的：連續改 `docs/A11Y.md` 兩處再 `--restore`，
 * 印的是「已還原」，而第一次的改動**永遠留在檔案裡**了 ——
 * 備份被第二次套用時的（已經變質的）內容覆蓋掉。
 *
 * 上面第 3 格守的是「什麼都沒做但看起來成功了」。
 * 這一格守的是它的鏡像：**什麼都做了，但看起來還原了。**
 * 那個更糟 —— 前者讓這一輪的綠燈變假，後者讓之後每一輪的基準都是髒的。
 */
{
  const stackFile = join(dir, 'stacked.mjs');
  const START = 'const a = 1;\nconst b = 2;\n';
  await writeFile(stackFile, START, 'utf8');

  await mutate([stackFile, '--from', 'const a = 1;', '--to', 'const a = 9;']);
  const second = await mutate([stackFile, '--from', 'const b = 2;', '--to', 'const b = 9;']);
  const both = await readFile(stackFile, 'utf8');
  check(
    '第二次也套用得了（兩處都變了）',
    second.code === 0 && both.includes('a = 9') && both.includes('b = 9'),
    both,
  );

  check('第二次會說「--restore 會一次還原掉全部」', /第二次（含以上）突變/.test(second.out), second.out);

  const r = await mutate([stackFile, '--restore']);
  const now = await readFile(stackFile, 'utf8');
  check(
    '還原回**最初**那一份，不是回到第一次突變之後',
    r.code === 0 && now === START,
    now,
  );
}

/*
 * ── 反斜線被 shell 吃掉時，要說得出來而不是猜 ──────────
 *
 * `npm run mutate -- … --from '…\d…'` 會經過一次 `sh`，
 * 無引號的 `\d` 被讀成 `d`，腳本收到的字串裡反斜線已經不見了。
 * 第 1 輪與第 2 輪（第三十三圈）各踩一次，兩次都只看到
 * 「配不到通常是引號或反斜線被 shell 吃掉了」—— 那是猜的。
 *
 * 而這件事驗得出來：把檔案裡的反斜線拿掉再找一次，找得到就是它。
 * 兩個方向都要驗，不然「一律說是反斜線」也會過。
 */
{
  const reFile = join(dir, 'regex.mjs');
  await writeFile(reFile, 'const re = /(\\d+) 條規則/g;\n', 'utf8');

  const eaten = await mutate([reFile, '--from', '/(d+) 條規則/g', '--to', 'x']);
  check(
    '反斜線被吃掉：說得出「就是反斜線」，離開碼 1',
    eaten.code === 1 && /就是反斜線被吃掉了/.test(eaten.out),
    eaten.out,
  );

  const genuinely = await mutate([reFile, '--from', '完全不相干的一段', '--to', 'x']);
  check(
    '真的不在裡面時不會賴給反斜線',
    genuinely.code === 1 && !/就是反斜線被吃掉了/.test(genuinely.out),
    genuinely.out,
  );

  const untouched = await readFile(reFile, 'utf8');
  check('兩次都沒動到檔案', untouched === 'const re = /(\\d+) 條規則/g;\n', untouched);
}

await rm(dir, { recursive: true, force: true });

console.log('─'.repeat(56));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
