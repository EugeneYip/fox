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
import * as http from './lib/http.mjs';

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
 * ── 那份清單自己是完整的嗎 ────────────────────────
 *
 * 第 4 輪（第四十一圈）加的。這一圈問「這一課學過了，當時修乾淨了嗎？」——
 * 這一課（header 只能是 Latin-1）修得很乾淨：值集中在 `lib/http.mjs`、
 * 用真的 `new Headers()` 驗、還有對照組。
 *
 * 唯一沒守到的是**那份清單本身**：`ALL_USER_AGENTS` 是手寫的
 * `{ UA_SYNC, UA_VERIFY, UA_BROWSER }`。加第四個 UA 而忘了加進去的話，
 * 上面那個迴圈照樣全綠 —— 只是少驗一個。
 *
 * 而它守的那個 bug 是「整個同步流程從來沒成功過，而錯誤看起來像網路問題」。
 * 所以清單漏一個的代價不是小事。
 *
 * 判準用模組自己的匯出，不是再抄一份。
 */
{
  const exported = Object.keys(http).filter((k) => k.startsWith('UA_'));
  const listed = new Set(Object.keys(ALL_USER_AGENTS));
  const missing = exported.filter((k) => !listed.has(k));
  const ok = missing.length === 0 && exported.length > 0;
  if (!ok) failed++;
  console.log(
    `  ${ok ? '✓' : 'X'} ALL_USER_AGENTS 收齊了每一個 UA_*（${exported.length} 個）`,
  );
  if (missing.length > 0) {
    console.log(
      `      漏了：${missing.join('、')}\n` +
        '      這些 UA 沒有被上面那個迴圈驗過 —— 它們送不送得出去，今天沒有人知道。',
    );
  }
  if (exported.length === 0) {
    console.log('      一個 UA_* 都抽不到 —— 上面那個迴圈可能整個是空的。');
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
