#!/usr/bin/env node
// @ts-check
/**
 * `itemsText()` —— `verify -- --patterns` 那一格「幾筆」的文字。
 *
 * 為什麼值得一支測試：它最重要的那條路在真的執行時**跑不到**。
 * 第 4 輪（第三十九圈）加的「第二種算法」對照，只在剖析器與標籤數
 * 不一樣的時候說話 —— 而真實的 feed 幾乎永遠一樣
 * （那一輪實測 11 個平臺，**11／11 一模一樣**）。
 *
 * 也就是說：那個對照存在的理由是「有一天會不一樣」，
 * 而那一天之前，只有這支測試走得到它。
 */
import { itemsText } from './lib/items-text.mjs';

let failed = 0;
/** @param {string} name @param {boolean} pass @param {string} [detail] */
const ok = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : 'X'} ${name}`);
  if (!pass && detail) console.log(`        ${detail}`);
};

console.log('\nitemsText()\n' + '─'.repeat(64));

ok('沒打過就不印東西', itemsText({}) === '');
ok('剖析拋錯：說「剖析失敗」並帶訊息', itemsText({ items: -1, parseErr: '壞了' }) === '**剖析失敗：壞了**');
ok('0 筆要標起來（那是 sync 會踩到的）', itemsText({ items: 0 }) === '**0 筆**');
ok('一般情況只印筆數', itemsText({ items: 10, naive: 10 }) === '10 筆', itemsText({ items: 10, naive: 10 }));

/*
 * 這一格是重點：剖析器少數了，兩邊就會不一樣。
 * 沒有這一句的話，剖析器哪天開始漏掉項目，這一格的數字只會變小 ——
 * 而「變小」跟「那個平臺今天少發幾篇」長得一模一樣。
 */
ok(
  '剖析器比標籤數少：把差說出來',
  itemsText({ items: 9, naive: 10 }) === '9 筆（標籤數 10）',
  itemsText({ items: 9, naive: 10 }),
);
ok('剖析器比標籤數多也一樣說', itemsText({ items: 11, naive: 10 }) === '11 筆（標籤數 10）');
/* 沒有第二個數字的時候不要亂加括號 */
ok('沒有標籤數時不加括號', itemsText({ items: 10 }) === '10 筆');

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
