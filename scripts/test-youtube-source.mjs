#!/usr/bin/env node
// @ts-check
/**
 * YouTube 降級層的測試 —— `npm run test:youtube-source`
 *
 * 零網路：兩個策略都是假的。
 *
 * ## 為什麼需要這個
 *
 * 這一層只有十幾行，但它決定的是**同步失敗時使用者看到什麼**。
 * 三條路裡有一條在真實世界從來沒有發生過：
 *
 *   RSS 成功               天天在跑
 *   RSS 失敗 ＋ **有金鑰**   **一次都沒有發生過**（站主還沒設 YOUTUBE_API_KEY）
 *   RSS 失敗 ＋ 沒有金鑰     很常見（那個端點會一陣一陣地 404）
 *
 * 中間那條是整個降級設計的重點 —— 它是「平臺掛掉不影響網站」的第二層
 * （第一層是快取）。而它一次都沒被執行過。
 */
import { fetchYouTubeSource } from './lib/youtube-source.mjs';

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
}

const SOURCE = { id: 'yt', channelId: 'UCabcdefghijklmnopqrstuv' };
/** 記錄哪個策略被呼叫過 */
function spies({ rssFails = false } = {}) {
  const calls = { rss: 0, api: 0, warns: /** @type {string[]} */ ([]) };
  return {
    calls,
    fetchRss: async (/** @type {any} */ _s, /** @type {string} */ id) => {
      calls.rss++;
      if (rssFails) throw new Error('HTTP 404（網址或帳號可能不對，重試無益）');
      return [{ id: 'rss-1', channelId: id }];
    },
    fetchApi: async (/** @type {any} */ _s, /** @type {string} */ id) => {
      calls.api++;
      return [{ id: 'api-1', channelId: id }];
    },
    log: { warn: (/** @type {string} */ m) => calls.warns.push(m) },
  };
}

console.log('\nYouTube 降級層（零網路）\n' + '─'.repeat(64));

// ── 1. RSS 成功就不該碰 API ───────────────────────────
{
  const s = spies();
  const out = await fetchYouTubeSource(SOURCE, s);
  check('RSS 成功：回傳 RSS 的結果', out[0]?.id === 'rss-1', out);
  check('RSS 成功：**完全不呼叫 API**（那要金鑰、要配額）', s.calls.api === 0, s.calls);
}

// ── 2. RSS 失敗 ＋ 有金鑰 → 退回 API ──────────────────
{
  /*
   * 這一條就是「一次都沒有發生過」的那條。
   * 站主哪天設了 YOUTUBE_API_KEY，走的就是這裡。
   */
  const s = spies({ rssFails: true });
  const out = await fetchYouTubeSource(SOURCE, { ...s, apiKey: 'fake-key' });
  check('RSS 失敗 ＋ 有金鑰：退回 API', out[0]?.id === 'api-1', out);
  check('RSS 失敗 ＋ 有金鑰：先試過 RSS 才退回', s.calls.rss === 1 && s.calls.api === 1, s.calls);
  check(
    'RSS 失敗 ＋ 有金鑰：警告裡帶著原因',
    s.calls.warns.length === 1 && /HTTP 404/.test(s.calls.warns[0]) && /改用 Data API/.test(s.calls.warns[0]),
    s.calls.warns,
  );
}

// ── 3. RSS 失敗 ＋ 沒有金鑰 → 拋錯，而且不要打 API ────
{
  const s = spies({ rssFails: true });
  /** @type {any} */
  let err;
  try {
    await fetchYouTubeSource(SOURCE, s);
  } catch (e) { err = e; }
  check('RSS 失敗 ＋ 沒金鑰：會拋錯', Boolean(err));
  /*
   * 訊息裡要保留 RSS 失敗的原因 —— 那是站主在 sync:dry 的輸出裡
   * 唯一看得到的線索。只寫「沒有金鑰」會把真正的原因擠掉。
   */
  check(
    'RSS 失敗 ＋ 沒金鑰：訊息同時有原因與「沒有金鑰可以退回」',
    /HTTP 404/.test(err?.message) && /沒有 YOUTUBE_API_KEY/.test(err?.message),
    err?.message,
  );
  check('RSS 失敗 ＋ 沒金鑰：**不要去打 API**（只會多一個 401 把原因擠掉）', s.calls.api === 0, s.calls);

  /*
   * ── 這是站主最可能看到的一句話 ──────────────────────
   *
   * 她沒有設 YOUTUBE_API_KEY，所以 RSS 一失敗就走到這裡。
   * 而這個專案**最貴的一課**就在這個端點上：那個 404 是間歇性的，
   * 不是「頻道下架了」（CLAUDE.md：「我第一次就是這樣搞錯的」）。
   *
   * 第 4 輪（第十七圈）之前，那一課只寫在文件裡，而她看到的是終端機。
   */
  check(
    'RSS 失敗 ＋ 沒金鑰：404 的時候要說「不要當成帳號沒了」與重驗的指令',
    /不要當成帳號沒了/.test(err?.message) && /verify -- --patterns/.test(err?.message),
    err?.message,
  );
}

/* 反向：**不是 404** 的失敗不要講那段間歇性的話 —— 那會把人帶錯方向 */
{
  const s = spies({ rssFails: true });
  s.fetchRss = async () => {
    throw new Error('連不上（fetch failed）—— 試了 3 次都一樣。');
  };
  /** @type {any} */
  let err;
  try {
    await fetchYouTubeSource(SOURCE, s);
  } catch (e) { err = e; }
  check(
    'RSS 失敗（不是 404）：不要說「間歇性 404」那一段',
    !/不要當成帳號沒了/.test(err?.message) && /改法/.test(err?.message),
    err?.message,
  );
}

// ── 4. channelId 的檢查 ───────────────────────────────
for (const [label, channelId] of /** @type {[string, any][]} */ ([
  ['沒有 channelId', undefined],
  ['空字串', ''],
  ['不是 UC 開頭', 'FoxPoetry'],
])) {
  const s = spies();
  /** @type {any} */
  let err;
  try {
    await fetchYouTubeSource({ id: 'yt', channelId }, s);
  } catch (e) { err = e; }
  check(
    `channelId ${label}：拋錯而且一個策略都不呼叫`,
    /UC 開頭/.test(err?.message) && s.calls.rss === 0 && s.calls.api === 0,
    { message: err?.message, calls: s.calls },
  );
}

{
  const s = spies();
  /*
   * 用 try/catch 而不是直接 await —— 不然 `trim()` 被拿掉時這裡會拋錯、
   * 整個測試腳本崩潰，輸出變成一段堆疊而不是「哪一條期望沒被滿足」。
   * 第 4 輪（第八圈）在 test-fetch-retry 上處理過同一件事。
   */
  let threw = '';
  try {
    await fetchYouTubeSource({ id: 'yt', channelId: '  UCabcdefghijklmnopqrstuv  ' }, s);
  } catch (e) {
    threw = /** @type {any} */ (e)?.message ?? String(e);
  }
  check('channelId 前後的空白會被去掉', s.calls.rss === 1 && !threw, { calls: s.calls, threw });
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
