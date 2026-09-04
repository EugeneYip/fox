#!/usr/bin/env node
// @ts-check
/**
 * 突變掃描的小工具 —— `npm run mutate`
 *
 * ## 為什麼這支腳本存在
 *
 * 這個 repo 每一輪自我檢查都會做**突變掃描**：故意把程式改壞一處，
 * 確認測試會紅。改壞的方式一直是隨手寫一段 `python3 -c` 或 `sed`。
 *
 * 而那有一個安靜的失敗模式：**字串沒配到的時候，`replace` 不會報錯，
 * 它只是什麼都不做**。於是那次「突變之後測試還是綠的」被讀成
 * 「這一格沒有守住」——**而其實突變壓根沒套用上去**。
 *
 * 第 1 輪（第二十二圈）第一次踩到，照著那個假訊號去改了測試。
 * 第 6 輪（第二十二圈）真的擋下一次：shell 把反斜線吃掉，
 * 這一行 `assert` 當場說了。連續六輪把它記成待辦，這一輪收進 repo。
 *
 * ## 用法
 *
 *   npm run mutate -- <檔案> --from '<原文>' --to '<新的>'   套用
 *   npm run mutate -- <檔案> --restore                      還原
 *
 * 套用之前會把原檔複製成 `<檔案>.orig`，`--restore` 就是把它換回來。
 * 找不到 `--from` 的內容就以離開碼 1 結束並說清楚 —— **那才是重點**。
 *
 * 這支腳本只在做檢查的時候用，不參與建置，也不在任何一個 workflow 裡。
 */
import { readFile, writeFile, copyFile, rm, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const flag = (/** @type {string} */ name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (!file) {
  console.error(
    '用法：\n' +
      "  npm run mutate -- <檔案> --from '<原文>' --to '<新的>'\n" +
      '  npm run mutate -- <檔案> --restore\n',
  );
  process.exit(1);
}

const path = resolve(process.cwd(), file);
const backup = path + '.orig';

if (argv.includes('--restore')) {
  const has = await access(backup).then(
    () => true,
    () => false,
  );
  if (!has) {
    console.error(`沒有 ${file}.orig —— 這個檔案沒有被這支腳本改過，不用還原。`);
    process.exit(1);
  }
  await copyFile(backup, path);
  await rm(backup);
  console.log(`已還原 ${file}`);
  process.exit(0);
}

const from = flag('from');
const to = flag('to');
if (from === undefined || to === undefined) {
  console.error('要有 --from 與 --to（--to 給空字串就是刪掉那一段）。');
  process.exit(1);
}

const text = await readFile(path, 'utf8');

/*
 * ── 這一段就是這支腳本存在的全部理由 ────────────────
 *
 * 配不到就停下來、講清楚、以離開碼 1 結束。
 * 不要「什麼都沒做但看起來成功了」——那會讓下一步的綠燈變成假的。
 */
if (!text.includes(from)) {
  console.error(`突變沒有套用：在 ${file} 裡找不到這一段 ——\n`);
  console.error('  ' + from.split('\n').slice(0, 4).join('\n  '));
  console.error('\n（配不到通常是引號或反斜線被 shell 吃掉了。）');
  process.exit(1);
}

const count = text.split(from).length - 1;
await copyFile(path, backup);
await writeFile(path, text.replace(from, to), 'utf8');
console.log(
  `已套用到 ${file}${count > 1 ? `（那一段出現 ${count} 次，只改第一次）` : ''}` +
    `　還原：npm run mutate -- ${file} --restore`,
);
