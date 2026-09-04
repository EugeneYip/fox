// @ts-check
/**
 * 對別人的伺服器有禮貌 —— 主機間隔與 Retry-After。
 *
 * 為什麼是獨立的檔案：這裡的行為（等多久、聽不聽對方的話）只有實際跑過
 * 才知道對不對，而 sync-feeds.mjs 是個一路 fetch 到底的腳本，沒辦法單獨驗。
 * 拆出來之後 scripts/test-throttle.mjs 測的就是**真正在跑的那份程式**，
 * 不是一份長得很像的複製品。
 */
/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * 同一台主機兩次請求之間至少隔這麼久。
 *
 * 為什麼需要：來源是一個一個依序抓的，所以「同時打爆對方」不會發生 ——
 * 但**多個來源可能共用同一台主機**。最明顯的是 feedKind: 'bridge' 的六個
 * 平臺（少數派、Threads、X、小紅書、知乎、豆瓣），它們全部走同一個 RSSHub。
 * 一旦啟用了好幾個，對 RSSHub 來說就是連續六個請求 —— 公開的 RSSHub
 * 實例對這種行為很敏感，Matters 也回過 429。
 *
 * 1.2 秒是「對別人的免費服務有禮貌」的量級，不是為了規避什麼。
 * 這個站一天只同步一次，多等幾秒完全無所謂。
 */
export const HOST_GAP_MS = 1200;
/** host → 上一次請求結束的時間 @type {Map<string, number>} */
const lastHitAt = new Map();

/**
 * @param {string} url
 * @param {(...args: unknown[]) => void} [debug]
 */
export async function waitForHost(url, debug = () => {}) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const last = lastHitAt.get(host);
  if (last !== undefined) {
    const wait = HOST_GAP_MS - (Date.now() - last);
    if (wait > 0) {
      debug(`${host}：距上次請求太近，等 ${wait}ms`);
      await sleep(wait);
    }
  }
  lastHitAt.set(host, Date.now());
}

/**
 * 對方在 429／503 上明講要等多久時，照做。
 *
 * Retry-After 有兩種寫法：秒數，或一個 HTTP 日期。兩種都要處理 ——
 * 只認秒數的話，遇到寫日期的伺服器會解析出 NaN，然後靜悄悄地退回
 * 自己的 backoff，等於沒有尊重對方的要求。
 *
 * 上限 30 秒：對方要求等一小時的話，那不是「等一下再試」能解決的，
 * 應該讓這次同步失敗、明天再跑。
 */
/**
 * @param {{ headers: { get(name: string): string | null } }} res
 * @returns {number | null}
 */
export function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  const ms = Number.isFinite(secs) ? secs * 1000 : new Date(raw).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(ms, 30_000);
}


/** 請求送出後記一筆 —— 間隔要從「上一次結束」算起，不是「上一次開始」 */
/** @param {string} url */
export function noteHostHit(url) {
  try {
    lastHitAt.set(new URL(url).host, Date.now());
  } catch { /* 網址不合法，前面已經處理過 */ }
}

/** 只給測試用：清掉主機的計時紀錄 */
export function _resetHosts() {
  lastHitAt.clear();
}
