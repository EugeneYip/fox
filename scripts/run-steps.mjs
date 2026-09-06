#!/usr/bin/env node
// @ts-check
/**
 * 照順序跑一串 npm script，**最後一行說實話**。
 *
 * ## 為什麼需要它
 *
 * `test:tools` 是 `npm run a && npm run b && …` 串起來的。
 * 那種串法有一個很難看的性質：**紅燈的輸出結尾是綠的**。
 *
 * 第 7 輪（第三十八圈）實測：故意讓 `check:copy` 的一條規則改名，
 * `npm run test:tools` 離開碼 1、輸出 919 行，
 * 而失敗在 **802–834 行** —— 後面還有 85 行 `✓`。
 * 也就是說 `tail` 看到的全是勾。要找到真正的失敗得往回捲一百多行，
 * 或者你得先知道要 `grep` 什麼。
 *
 * 那正是第三十七圈兩次「偶發紅燈」當下看不出原因的原因之一：
 * **我看的是結尾，而結尾在說謊。**
 *
 * 這一支不改任何一格檢查，只改「怎麼跑」與「最後印什麼」：
 * 停在哪一步、那是第幾步、以及那一步輸出裡長得像失敗的幾行。
 *
 * `test:units` 與 `test:built` 本身仍然是 package.json 裡那串 `&&` ——
 * **那串就是唯一的來源**，這裡只是把它展開來跑，不另外抄一份順序。
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

/* `--root=` 只給 scripts/test-run-steps.mjs 用 —— 它會做一份假的 package.json */
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg
  ? resolve(rootArg.slice('--root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scripts = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')).scripts ?? {};

/** 把 `npm run a && npm run b` 這種字串展開成 ['a', 'b']；展不開就當成一步 */
/** @returns {string[]} */
function expand(/** @type {string} */ name, /** @type {Set<string>} */ seen = new Set()) {
  const body = scripts[name];
  if (typeof body !== 'string' || seen.has(name)) return [name];
  const parts = body.split('&&').map((x) => x.trim());
  if (!parts.every((p) => /^npm run [a-z0-9:_-]+$/.test(p))) return [name];
  seen.add(name);
  return parts.flatMap((p) => expand(p.replace(/^npm run /, ''), seen));
}

const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (asked.length === 0) {
  console.log('用法：node scripts/run-steps.mjs <script 名稱> [更多…]');
  process.exit(1);
}
const steps = asked.flatMap((a) => expand(a));

/** 那一步的輸出裡，長得像「失敗」的行 —— 給結尾那段當證據用 */
const LOOKS_BAD = /^\s*X\s|項失敗|個問題|必須修正 [1-9]|✗|Error|error TS|Missing script/;

let failedAt = null;
/** @type {string[]} */
let evidence = [];

for (let i = 0; i < steps.length; i += 1) {
  const name = steps[i];
  /** @type {{ code: number, text: string }} */
  const out = await new Promise((done) => {
    /** @type {string[]} */
    const buf = [];
    const child = spawn('npm', ['run', name], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (/** @type {Buffer} */ b) => {
      const t = b.toString();
      process.stdout.write(t);
      buf.push(t);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => done({ code: code ?? -1, text: buf.join('') }));
  });
  if (out.code !== 0) {
    failedAt = { name, index: i };
    evidence = out.text.split('\n').filter((l) => LOOKS_BAD.test(l)).slice(0, 8);
    break;
  }
}

console.log('\n' + '='.repeat(60));
if (failedAt === null) {
  console.log(`${steps.length} 步全部通過（${asked.join('、')}）。\n`);
  process.exit(0);
}
console.log(`X 停在第 ${failedAt.index + 1} 步／共 ${steps.length} 步：npm run ${failedAt.name}`);
if (evidence.length > 0) {
  console.log('\n  那一步輸出裡長得像失敗的幾行：');
  for (const line of evidence) console.log('    ' + line.trim().slice(0, 100));
} else {
  console.log('\n  那一步的輸出裡找不到長得像失敗的行 —— 往上看它自己印了什麼。');
}
console.log(`\n  只跑那一步：npm run ${failedAt.name}\n`);
process.exit(1);
