#!/usr/bin/env node
// @ts-check
/**
 * 節流行為的實測 —— `npm run test:throttle`
 *
 * 這裡量的是**真的在跑的那份程式**（scripts/lib/throttle.mjs），
 * 不是一份長得很像的複製品。第 4 輪（第二圈）加節流時寫的：
 * 「等 1.2 秒」這種行為不實際跑一次，永遠不知道是不是真的等了。
 */
import { waitForHost, retryAfterMs, HOST_GAP_MS, _resetHosts } from './lib/throttle.mjs';

let failed = 0;
/**
 * @param {boolean} cond
 * @param {string} name
 * @param {string} [detail]
 */
const ok = (cond, name, detail = '') => {
  console.log(`  ${cond ? '✓' : 'X'} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failed++;
};

console.log('\n節流行為實測');
console.log('─'.repeat(64));

// 1. 同一台主機：第二次要被擋住
_resetHosts();
let t = Date.now();
await waitForHost('https://example.com/a');
const firstMs = Date.now() - t;
t = Date.now();
await waitForHost('https://example.com/b');
const secondMs = Date.now() - t;
ok(firstMs < 50, '同一主機第一次不等待', `${firstMs}ms`);
ok(secondMs >= HOST_GAP_MS - 60, `同一主機第二次等滿 ${HOST_GAP_MS}ms`, `${secondMs}ms`);

// 2. 不同主機之間不該互相拖累 —— 節流是 per-host，不是全域
_resetHosts();
await waitForHost('https://a.example/1');
t = Date.now();
await waitForHost('https://b.example/1');
const otherMs = Date.now() - t;
ok(otherMs < 50, '不同主機不互相等待', `${otherMs}ms`);

// 3. 網址不合法時不要爆掉（同步腳本不該因為一筆爛設定就整個停掉）
_resetHosts();
let threw = false;
try { await waitForHost('這不是網址'); } catch { threw = true; }
ok(!threw, '網址不合法時安靜略過');

// 4. Retry-After：秒數
/**
 * 假的 Response，只需要 headers.get 這一個方法
 * @param {string | null} v
 */
const hdr = (v) => ({
  headers: {
    /** @param {string} k */
    get(k) {
      return k === 'retry-after' ? v : null;
    },
  },
});
ok(retryAfterMs(hdr('5')) === 5000, 'Retry-After 秒數', '5 → 5000ms');

// 5. Retry-After：HTTP 日期。只認秒數的話這裡會拿到 NaN 然後靜悄悄退回自己的 backoff
const future = new Date(Date.now() + 8000).toUTCString();
const dateMs = retryAfterMs(hdr(future));
ok(dateMs !== null && dateMs > 6000 && dateMs <= 9000, 'Retry-After HTTP 日期', `${dateMs}ms`);

// 6. 上限 30 秒 —— 對方要求等一小時的話，那是明天再跑的事
ok(retryAfterMs(hdr('3600')) === 30_000, 'Retry-After 超過 30 秒時封頂', '3600s → 30000ms');

// 7. 沒有 header、或值是過去的時間
ok(retryAfterMs(hdr(null)) === null, '沒有 Retry-After 時回 null');
ok(retryAfterMs(hdr(new Date(Date.now() - 5000).toUTCString())) === null, '過去的時間視為沒有');

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
