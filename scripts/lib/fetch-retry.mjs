// @ts-check
/**
 * 逾時 + 重試的 fetch —— 抽出來是為了能在**沒有網路**的情況下測。
 *
 * ## 為什麼值得抽
 *
 * 第 4 輪（第六圈）在這裡加了 `retryOn404`，理由是實測 YouTube 的 feed
 * 端點兩分鐘內回過 1 次 200、2 次 500、10 次 404 —— 對那個端點而言
 * 「4xx 重試無益」這條通則是錯的。那個改動讓同步成功率從 1／4 變成 3／4。
 *
 * 但那份證據是**真實網路的一次觀察，不可重現**。
 * 到第 4 輪（第七圈）為止，這個函式一行測試都沒有：
 * 把 `retryOn404` 的條件寫反、或把 429 從重試清單裡拿掉，
 * **什麼都不會說話** —— 同步只會安靜地失敗、沿用快取，
 * 而那正是它「設計上就該有的樣子」，所以連人也看不出來。
 *
 * ## 注入什麼
 *
 * `fetchImpl` 與 `sleep` 是注入的：前者讓測試造得出 404／429／500，
 * 後者讓退避不用真的等。`waitForHost`／`noteHostHit` 也可以換掉 ——
 * 它們是 per-host 節流，真的跑會讓測試多等好幾秒。
 */
import { sleep as realSleep } from './throttle.mjs';
import { waitForHost as realWait, noteHostHit as realNote, retryAfterMs as realRetryAfter } from './throttle.mjs';

/** 逾時 + 重試的 fetch。對方掛了就是掛了，不要卡住整個 build。 */
/**
 * @param {string} url
 * @param {{
 *   retries?: number, headers?: Record<string, string>, retryOn404?: boolean,
 *   userAgent?: string, timeoutMs?: number,
 *   log?: { debug: (...a: any[]) => void },
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   waitForHost?: (url: string, log?: any) => Promise<void>,
 *   noteHostHit?: (url: string) => void,
 *   retryAfterMs?: (res: Response) => number | null,
 * }} [opts]
 */
export async function fetchWithRetry(
  url,
  {
    retries = 2,
    headers = {},
    retryOn404 = false,
    userAgent = '',
    timeoutMs = 20_000,
    log = { debug: () => {} },
    fetchImpl = fetch,
    sleep = realSleep,
    waitForHost = realWait,
    noteHostHit = realNote,
    retryAfterMs = realRetryAfter,
  } = {},
) {
  let lastErr;
  let politeWait = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 對方講了要等多久就照做，沒講才用自己的指數退避
      const backoff = politeWait ?? 600 * 2 ** (attempt - 1);
      log.debug(
        `重試 ${attempt}/${retries}（等 ${backoff}ms${politeWait ? '，對方的 Retry-After' : ''}）`,
      );
      await sleep(backoff);
      politeWait = null;
    }
    await waitForHost(url, log.debug);
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': userAgent, accept: 'application/rss+xml, application/atom+xml, application/xml, application/json;q=0.9, */*;q=0.8', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      noteHostHit(url);
      if (!res.ok) {
        /*
         * 4xx 通常是我們的問題（網址錯、帳號沒了），重試沒有意義。
         *
         * **但 YouTube 的 feed 端點是例外**，所以有 retryOn404。
         * 第 4 輪（第六圈）在兩分鐘內對同一個網址打了 13 次：
         *
         *   1 次 200、2 次 500、10 次 404
         *
         * 三種 User-Agent 都試過（先懷疑是 UA 被擋，不是）——
         * 而 500 是伺服器端錯誤，這證明那個 404 不是「這個頻道不存在」。
         * 也就是說對這個端點而言，「4xx 重試無益」這條通則是錯的。
         *
         * 沒有放寬成「所有 404 都重試」：對真的不存在的網址那只是浪費時間。
         */
        const hopeless = res.status >= 400 && res.status < 500 && res.status !== 429
          && !(res.status === 404 && retryOn404);
        if (hopeless) {
          throw new Error(`HTTP ${res.status}（網址或帳號可能不對，重試無益）`);
        }
        if (res.status === 429 || res.status === 503) politeWait = retryAfterMs(res);
        throw new Error(`HTTP ${res.status}${politeWait ? `（對方要求等 ${politeWait}ms）` : ''}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (/重試無益/.test(String(/** @type {{ message?: string }} */ (err)?.message))) break;
    }
  }
  /*
   * ── 最後這一句是站主看得到的 ──────────────────────
   *
   * `fetch failed` 是 Node 的原文，對站主沒有任何意義（第 4 輪〔第十七圈〕
   * 量到的：那個字串會原封不動一路傳到 `npm run sync` 的輸出上）。
   * 這裡把它翻成人話，並且說出「試了幾次」—— 沒有次數的話，
   * 「HTTP 404」看起來像只打了一次，她會以為再跑一次就好。
   */
  const raw = String(/** @type {{ message?: string }} */ (lastErr)?.message ?? lastErr ?? '');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(raw)) {
    throw new Error(
      `連不上（${raw}）—— 試了 ${retries + 1} 次都一樣。` +
        '　改法：先確認自己有網路；有的話，可能是那個網域暫時擋住或掛掉了，過一陣子再試。',
    );
  }
  if (lastErr instanceof Error && !/重試無益/.test(raw)) {
    throw new Error(`${raw}（試了 ${retries + 1} 次）`);
  }
  throw lastErr ?? new Error('fetch 失敗');
}
