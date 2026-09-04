#!/usr/bin/env node
// @ts-check
/**
 * 重試策略的測試 —— `npm run test:fetch-retry`
 *
 * 零網路請求：`fetchImpl` 是假的，`sleep` 也是假的（不然退避真的會等）。
 *
 * ## 為什麼需要這個
 *
 * 第 4 輪（第六圈）在 `fetchWithRetry` 裡加了 `retryOn404`，
 * 依據是實測 YouTube 的 feed 端點兩分鐘內回過 1 次 200、2 次 500、10 次 404。
 * 那個改動把同步成功率從 1／4 拉到 3／4。
 *
 * 但那份證據是**真實網路的一次觀察，不可重現**。而如果有人把
 * `retryOn404` 的條件寫反、或把 429 從重試清單裡拿掉，
 * **不會有任何東西說話** —— 同步只會安靜地失敗、沿用快取，
 * 而那正是它設計上該有的降級行為，所以連人也看不出來。
 *
 * 這裡把那些分支變成可重現的斷言。
 */
import { readFile } from 'node:fs/promises';
import { fetchWithRetry } from './lib/fetch-retry.mjs';

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
}

/**
 * 預期會成功的呼叫。
 *
 * 為什麼要包一層：第 4 輪（第八圈）做突變掃描時發現，
 * 把「5xx 可重試」「429 可重試」「拋錯要重試」弄壞之後，
 * `await fetchWithRetry(...)` 會直接把例外丟出來，**整個測試腳本崩潰** ——
 * exit 1、CI 會紅，所以不是靜靜通過，但輸出是一段堆疊而不是
 * 「哪一條期望沒被滿足」。包起來之後那些突變會變成具名的失敗。
 *
 * @param {string} name
 * @param {Promise<any>} p
 */
async function expectOk(name, p) {
  try {
    return await p;
  } catch (e) {
    check(name, false, `不該拋卻拋了：${/** @type {any} */ (e)?.message}`);
    return undefined;
  }
}

/**
 * 造一個照順序回傳指定狀態碼的假 fetch，並記錄被呼叫幾次。
 * @param {(number | 'throw')[]} codes
 * @param {Record<string, string>} [headers]
 */
function fakeFetch(codes, headers = {}) {
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const calls = [];
  /** @type {any} */
  const impl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const code = codes[Math.min(calls.length - 1, codes.length - 1)];
    if (code === 'throw') throw new Error('network down');
    return {
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: (/** @type {string} */ k) => headers[k.toLowerCase()] ?? null },
    };
  };
  impl.calls = calls;
  return impl;
}

/** 共用的注入：不睡、不節流 */
const quiet = {
  sleep: async () => {},
  waitForHost: async () => {},
  noteHostHit: () => {},
};

console.log('\n重試策略（零網路）\n' + '─'.repeat(64));

// ── 1. 一次就成功 ─────────────────────────────────────
{
  const f = fakeFetch([200]);
  const res = await expectOk('200：一次就回，不重試', fetchWithRetry('https://x.test/a', { ...quiet, fetchImpl: f }));
  check('200：一次就回，不重試', res?.status === 200 && f.calls.length === 1, f.calls.length);
}

// ── 2. 404 預設不重試 ─────────────────────────────────
{
  const f = fakeFetch([404]);
  /** @type {any} */
  let err;
  try {
    await fetchWithRetry('https://x.test/b', { ...quiet, fetchImpl: f, retries: 4 });
  } catch (e) {
    err = e;
  }
  check('404 預設：只打一次就放棄', f.calls.length === 1, f.calls.length);
  check('404 預設：錯誤訊息說「重試無益」', /重試無益/.test(String(err?.message)), err?.message);
}

// ── 3. retryOn404 —— 第 4 輪（第六圈）加的那條 ─────────
{
  const f = fakeFetch([404, 404, 200]);
  const res = await expectOk('retryOn404：404 之後會重試，救得回 200', fetchWithRetry('https://x.test/c', {
    ...quiet, fetchImpl: f, retryOn404: true, retries: 4,
  }));
  /*
   * 這一條就是那個改動的全部價值：實測四次同步裡有兩次是靠重試才成功的。
   * 條件寫反的話這裡會拿到 404 而不是 200。
   */
  check('retryOn404：404 之後會重試，救得回 200', res?.status === 200 && f.calls.length === 3, f.calls.length);
}
{
  const f = fakeFetch([404]);
  /** @type {any} */
  let err;
  try {
    await fetchWithRetry('https://x.test/d', { ...quiet, fetchImpl: f, retryOn404: true, retries: 2 });
  } catch (e) { err = e; }
  check('retryOn404：一直 404 的話用完次數就停（1 + 2）', f.calls.length === 3, f.calls.length);
  check('retryOn404：訊息不再說「重試無益」', !/重試無益/.test(String(err?.message)), err?.message);
}

// ── 4. 其他 4xx 不受 retryOn404 影響 ───────────────────
{
  const f = fakeFetch([403]);
  try { await fetchWithRetry('https://x.test/e', { ...quiet, fetchImpl: f, retryOn404: true, retries: 4 }); } catch {}
  /* 放寬的是 404，不是整個 4xx —— 403 仍然該立刻放棄 */
  check('403：就算開了 retryOn404 也只打一次', f.calls.length === 1, f.calls.length);
}

// ── 5. 429 一直都要重試，而且照對方說的等 ──────────────
{
  const f = fakeFetch([429, 200], { 'retry-after': '2' });
  /** @type {number[]} */
  const waits = [];
  const res = await expectOk('429：會重試並成功', fetchWithRetry('https://x.test/f', {
    ...quiet, fetchImpl: f, sleep: async (/** @type {number} */ ms) => { waits.push(ms); },
  }));
  check('429：會重試並成功', res?.status === 200 && f.calls.length === 2, f.calls.length);
  check('429：等的是對方的 Retry-After（2 秒）而不是自己的退避', waits[0] === 2000, waits);
}

// ── 6. 5xx 要重試 ─────────────────────────────────────
{
  const f = fakeFetch([500, 503, 200]);
  const res = await expectOk('5xx：會重試（500 → 503 → 200）', fetchWithRetry('https://x.test/g', { ...quiet, fetchImpl: f, retries: 4 }));
  check('5xx：會重試（500 → 503 → 200）', res?.status === 200 && f.calls.length === 3, f.calls.length);
}

// ── 7. 指數退避 ───────────────────────────────────────
{
  const f = fakeFetch([500, 500, 500, 200]);
  /** @type {number[]} */
  const waits = [];
  await fetchWithRetry('https://x.test/h', {
    ...quiet, fetchImpl: f, retries: 4, sleep: async (/** @type {number} */ ms) => { waits.push(ms); },
  });
  check('退避是 600 / 1200 / 2400', waits.join(',') === '600,1200,2400', waits);
}

// ── 7b. 用過的 Retry-After 不能留著 ───────────────────
{
  /*
   * 第 4 輪（第八圈）的突變掃描裡**唯一一個靜靜通過**的：
   * 把 `politeWait = null` 拿掉，所有斷言照樣全綠。
   *
   * 後果是：吃過一次對方的 Retry-After 之後，那個值會一直被重用，
   * 指數退避形同失效 —— 對方說「等 2 秒」，之後每一次都等 2 秒，
   * 而不是 600 / 1200 / 2400。原本的 429 案例只重試一次，看不到這件事。
   */
  const f = fakeFetch([429, 500, 500, 200], { 'retry-after': '2' });
  /** @type {number[]} */
  const waits = [];
  await expectOk('（429 → 500 → 500 → 200）', fetchWithRetry('https://x.test/k', {
    ...quiet, fetchImpl: f, retries: 4,
    sleep: async (/** @type {number} */ ms) => { waits.push(ms); },
  }));
  check(
    '用過的 Retry-After 要歸零（2000 之後回到指數退避）',
    waits.join(',') === '2000,1200,2400',
    waits,
  );
}

// ── 8. 網路整個拋錯也會重試 ───────────────────────────
{
  const f = fakeFetch(['throw', 'throw', 200]);
  const res = await expectOk('fetch 直接拋錯：也會重試', fetchWithRetry('https://x.test/i', { ...quiet, fetchImpl: f, retries: 3 }));
  check('fetch 直接拋錯：也會重試', res?.status === 200 && f.calls.length === 3, f.calls.length);
}

// ── 8b. 放棄的時候，站主看得懂那句話嗎 ────────────────
/*
 * 第 4 輪（第十七圈）量到：`fetch failed` 是 Node 的原文，會原封不動一路
 * 傳到 `npm run sync` 的輸出上 —— 對站主沒有任何意義。
 * 而「HTTP 404」少了次數，看起來像只打了一次，她會以為再跑一次就好。
 */
{
  const f = fakeFetch(['throw', 'throw', 'throw']);
  let err;
  try {
    await fetchWithRetry('https://x.test/j', { ...quiet, fetchImpl: f, retries: 2 });
  } catch (e) {
    err = /** @type {Error} */ (e);
  }
  const msg = String(err?.message ?? '');
  check('網路錯誤翻成人話，而且說了試幾次', /連不上/.test(msg) && /3 次/.test(msg), msg);
  check('網路錯誤有講改法', /改法/.test(msg), msg);
}
{
  const f = fakeFetch([404, 404, 404]);
  let err;
  try {
    await fetchWithRetry('https://x.test/k', { ...quiet, fetchImpl: f, retries: 2, retryOn404: true });
  } catch (e) {
    err = /** @type {Error} */ (e);
  }
  const msg = String(err?.message ?? '');
  check('重試過的 404 會說試了幾次', /404/.test(msg) && /3 次/.test(msg), msg);
  /* 反向：沒重試的那種不要多加「試了幾次」—— 它本來就只打一次 */
  const g = fakeFetch([404]);
  let err2;
  try {
    await fetchWithRetry('https://x.test/l', { ...quiet, fetchImpl: g, retries: 2 });
  } catch (e) {
    err2 = /** @type {Error} */ (e);
  }
  check('沒重試的 404 維持原本那句話', /重試無益/.test(String(err2?.message)) && !/試了/.test(String(err2?.message)), err2?.message);
}

// ── 9. User-Agent 一定要送出去 ────────────────────────
{
  /*
   * 第一圈踩過：UA 裡放了一個全形破折號，fetch 在送出前就拋 ByteString 錯誤，
   * 整條管線從來沒成功過。test-http-headers 守的是「UA 的值合不合法」，
   * 這裡守的是「它真的有被放進 headers」。
   */
  const f = fakeFetch([200]);
  await fetchWithRetry('https://x.test/j', { ...quiet, fetchImpl: f, userAgent: 'fox-test/1.0' });
  check('headers 裡真的有 user-agent', f.calls[0].headers['user-agent'] === 'fox-test/1.0', f.calls[0].headers);
}

// ── 11. YouTube 那條路的重試視窗要蓋得過壞段 ─────────
{
  /*
   * 這一格守的不是 `fetchWithRetry`，是**呼叫端給的次數**。
   *
   * 第 4 輪（第二十一圈）量到：YouTube 的 feed 端點壞起來是**連成一段**的
   * （兩次取樣分別是 22 秒與約 32 秒），不是每次獨立地擲骰子。
   * 所以「重試幾次」本身不是重點，**重試涵蓋多長的時間**才是 ——
   * 五次嘗試擠在 9 秒內，會整批落在同一個壞段裡。
   *
   * 次數是寫在 sync-feeds.mjs 裡的一個數字，改小了不會有任何徵兆：
   * 同步只會安靜地失敗、沿用快取，而那正是它設計上該有的降級行為。
   * 所以這裡把那個數字讀出來，實際算一次退避總和。
   */
  const src = await readFile(new URL('./sync-feeds.mjs', import.meta.url), 'utf8');
  const m = src.match(/fetchWithRetry\(url, \{ retryOn404: true, retries: (\d+) \}\)/);
  const retries = m ? Number(m[1]) : -1;

  /** @type {number[]} */
  const waits = [];
  const f = fakeFetch(Array(retries + 1).fill(404));
  try {
    await fetchWithRetry('https://x.test/m', {
      ...quiet, fetchImpl: f, retryOn404: true, retries,
      sleep: async (/** @type {number} */ ms) => { waits.push(ms); },
    });
  } catch {}
  const spread = waits.reduce((a, b) => a + b, 0);

  check('sync 的 YouTube 呼叫讀得到重試次數', retries > 0, retries);
  check(
    `重試視窗蓋得過量到的最長壞段（32 秒）—— 現在是 ${(spread / 1000).toFixed(1)} 秒`,
    spread >= 32_000,
    { retries, waits, spread },
  );
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
