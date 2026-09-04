#!/usr/bin/env node
// @ts-check
/**
 * HTTP header 值的實測 —— `npm run test:http-headers`
 *
 * 只測一件事，但那一件事曾經讓整個專案的同步管線靜悄悄壞掉一整天：
 * **header 的值只能是 Latin-1。**
 *
 * `sync-feeds.mjs` 的 User-Agent 裡曾有一個全形破折號（U+2014），
 * 於是 `fetch` 在**送出之前**就拋 `Cannot convert argument to a ByteString`，
 * 而那個錯誤看起來像網路問題。錯誤又被另一個「缺 API 金鑰」的訊息蓋住，
 * 所以沒有人發現「一個請求都沒送出去過」。
 *
 * 用**真的 `new Headers()`** 驗，不是用正則掃原始碼 ——
 * 掃描本身就不可靠（寫這支腳本的時候，我的正則就漏抓了兩個多行宣告）。
 */
import { ALL_USER_AGENTS } from './lib/http.mjs';

let failed = 0;
console.log('\nHTTP header 值的實測');
console.log('─'.repeat(64));

for (const [name, value] of Object.entries(ALL_USER_AGENTS)) {
  try {
    new Headers({ 'user-agent': value });
    console.log(`  ✓ ${name.padEnd(12)} ${value.slice(0, 48)}${value.length > 48 ? '…' : ''}`);
  } catch (err) {
    failed++;
    console.log(`  X ${name.padEnd(12)} 送不出去 —— ${String(err instanceof Error ? err.message : err).slice(0, 70)}`);
  }
}

/*
 * 對照組：確認這個測試真的抓得到問題。
 * 沒有這一段的話，`new Headers()` 哪天不再驗證了，上面全部會變成假的綠勾。
 */
let controlThrew = false;
try {
  new Headers({ 'user-agent': 'bellafoxy.com — respectful sync' });
} catch {
  controlThrew = true;
}
if (controlThrew) {
  console.log('  ✓ 對照組       含全形破折號的值確實會被擋下來');
} else {
  failed++;
  console.log('  X 對照組       含全形破折號的值竟然通過了 —— 這個測試本身失效了');
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
