// @ts-check
/**
 * 同步的**編排層** —— 抽出來是為了能在沒有網路的情況下測。
 *
 * ## 為什麼值得抽
 *
 * `sync-feeds.mjs` 的每一塊零件都有測試了：剖析（`test-parse-feed`）、
 * 正規化與合併（`test-normalize`）、節流（`test-throttle`）、
 * User-Agent（`test-http-headers`）。**只有把它們串起來的那一層沒有** ——
 * 到第 4 輪（第六圈）為止，驗證方式一直是「跑一次 `npm run sync:dry` 看輸出」。
 * 那個做法有兩個問題：要有網路，而且只走得到「成功」那條路。
 *
 * 而這一層負責的正好是這個站的招牌性質：
 * **「平臺掛掉不影響網站」**（STATE.md 寫在完成清單裡）。
 * 那句話成不成立，取決於這裡的 catch 有沒有把快取留住、
 * 有沒有把 `lastSuccessAt` 保住 —— 而那條路只在真的失敗時才會走到。
 *
 * 第 4 輪（第五圈）曾經**意外**驗到一次：抽模組時漏了一個 import，
 * 同步報「來源失敗 1」，而網站確實沒受影響。那是運氣，不是測試。
 *
 * ## 注入什麼
 *
 * `runStrategy` 與 `now` 是注入的，所以測試可以造出
 * 「這個來源會拋錯」「這個來源回三筆」而完全不碰網路。
 */
import { mergeItems } from './normalize.mjs';

/**
 * @typedef {object} SourceStatus
 * @property {'ok' | 'error'} status
 * @property {string} platform
 * @property {number} itemCount
 * @property {string | null} lastSuccessAt
 * @property {string | null} message
 */

/**
 * 什麼都不印的 log，測試用。
 * @typedef {(...a: any[]) => void} Say
 * @type {{ step: Say, ok: Say, warn: Say, fail: Say, info: Say }}
 */
const SILENT = {
  step: () => {},
  ok: () => {},
  warn: () => {},
  fail: () => {},
  info: () => {},
};

/**
 * 把一組來源抓回來、合併進既有的快取。
 *
 * @param {object} o
 * @param {any[]} o.targets 這次要處理的來源
 * @param {{ items: any[], sources: Record<string, any> }} o.previous 上一次的產出
 * @param {(id: string) => any} o.getPlatform
 * @param {(source: any, platform: any) => Promise<any[]>} o.runStrategy
 * @param {Partial<typeof SILENT>} [o.log]
 * @param {() => string} [o.now]
 */
export async function syncSources({ targets, previous, getPlatform, runStrategy, log = {}, now = () => new Date().toISOString() }) {
  const say = { ...SILENT, ...log };

  /*
   * ── 快取裡沒有網址的那幾筆，這次一併丟掉 ──
   *
   * 新抓回來的東西下面有 `raw.filter(i => i.url)` 擋著，**快取沒有**。
   * 也就是說第 4 輪（第十圈）加那道過濾之前，若已經有一筆沒有網址進了
   * syndication.json，它會**永遠留在裡面** —— 每次同步都原封不動搬過去。
   *
   * 那一筆的後果在 parse-feed.mjs 寫過：id 會跟其他無網址的項目撞在一起，
   * 而站上畫出來是 `<a href target="_blank">`，空的 href 指向當前頁。
   *
   * 第 4 輪（第十五圈）實測：現在快取 9 筆**全部都有網址**，
   * 所以這道過濾今天丟掉 0 筆 —— 它守的是一個還沒發生過的狀態。
   * 記了好幾圈的待辦，補起來只要一行。
   */
  const usablePrevious = previous.items.filter((/** @type {any} */ i) => i.url);
  const staleDropped = previous.items.length - usablePrevious.length;
  if (staleDropped > 0) {
    say.warn(`快取裡有 ${staleDropped} 筆沒有網址，這次一併丟掉（舊版留下的，沒有網址就沒有去處）`);
  }
  const byId = new Map(usablePrevious.map((/** @type {any} */ i) => [i.id, i]));
  /** @type {Record<string, SourceStatus>} */
  const sourceStatus = { ...previous.sources };

  let added = 0;
  let updated = 0;
  let failures = 0;

  for (const source of targets) {
    const platform = getPlatform(source.platform);
    say.step(`${source.label ?? source.id}（${platform?.name['zh-TW'] ?? source.platform}）`);

    if (!platform) {
      say.fail(`platforms.data.mjs 裡沒有 "${source.platform}" 這個平臺`);
      failures++;
      continue;
    }
    /*
     * 範本裡的預留值。這不是錯誤，是「還沒填」——
     * 算成失敗會讓 --strict 在正常狀態下就紅燈。
     */
    if (source.handle === 'CHANGE_ME') {
      say.warn('handle 還是 CHANGE_ME，略過');
      continue;
    }

    try {
      const raw = await runStrategy(source, platform);
      const limited = raw.filter((/** @type {any} */ i) => i.url).slice(0, source.limit ?? 30);

      const merged = mergeItems(byId, limited, source, platform, now);
      added += merged.added;
      updated += merged.updated;

      sourceStatus[source.id] = {
        status: 'ok',
        platform: platform.id,
        itemCount: limited.length,
        lastSuccessAt: now(),
        message: null,
      };
      say.ok(`抓到 ${limited.length} 筆`);
    } catch (err) {
      /*
       * ── 這裡就是「平臺掛掉不影響網站」的實作 ──
       *
       * 三件事一件都不能少：
       *   1. 不重新拋出 —— 一個來源掛掉不該讓整條管線停下來
       *   2. `byId` 不動 —— 上一次抓到的東西留著，網站照常有內容
       *   3. `lastSuccessAt` 沿用舊值 —— 不然「上次成功是什麼時候」會被抹掉，
       *      而那正是判斷「這個來源是暫時掛掉還是真的沒了」唯一的依據
       */
      failures++;
      const message = /** @type {{ message?: string }} */ (err)?.message ?? String(err);
      const kept = usablePrevious.filter((/** @type {any} */ i) => i.sourceId === source.id).length;
      sourceStatus[source.id] = {
        status: 'error',
        platform: platform.id,
        itemCount: kept,
        lastSuccessAt: sourceStatus[source.id]?.lastSuccessAt ?? null,
        message,
      };
      say.warn(message);
      if (kept > 0) say.info(`沿用快取裡的 ${kept} 筆，網站不受影響`);
    }
  }

  return { byId, sourceStatus, added, updated, failures, staleDropped };
}

/**
 * 排序 + 組出要寫進 syndication.json 的東西。
 *
 * 排序抽進來一起測是因為它有一個安靜的邊界：**沒有 `publishedAt` 的項目**
 * 會被當成 0，也就是永遠排到最後。那是刻意的（來源沒給日期的東西不該
 * 佔住列表頂端），但它從來沒有被寫下來過。
 *
 * @param {object} o
 * @param {Map<string, any>} o.byId
 * @param {Record<string, any>} o.sourceStatus
 * @param {() => string} [o.now]
 */
export function buildPayload({ byId, sourceStatus, now = () => new Date().toISOString() }) {
  const items = [...byId.values()].sort((a, b) => {
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });

  return {
    $schema: './syndication.schema.json',
    generatedAt: now(),
    itemCount: items.length,
    /*
     * ── 這裡的排序不能用 localeCompare ──────────────────
     *
     * 不給語言的 `localeCompare()` 用的是**執行環境的預設語言**，
     * 而那個語言跟著 `LANG`／`LC_ALL` 走。第 7 輪（第二十二圈）實測：
     *
     *   en-US　→  aa-x  ab-x  chat-a  china-blog  cukr
     *   cs-CZ　→  aa-x  ab-x  cukr  chat-a  china-blog　← ch 在捷克語是一個字母
     *   da-DK　→  ab-x  …  cukr  aa-x　　　　　　　　　　← aa 在丹麥語排最後
     *
     * 而這份結果會寫進 `src/data/syndication.json`，**那個檔案要進版控**。
     * 也就是說同步跑在不同機器上，會產生只有鍵順序不同的假 diff ——
     * 甚至兩台機器輪流把它改來改去。
     *
     * 來源 id 是給機器看的字串（`youtube-foxpoetry`），不是要給人排的名單，
     * 所以用最單純的碼位比較：不需要語言，而且在哪裡都一樣。
     */
    sources: Object.fromEntries(
      Object.entries(sourceStatus).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    items,
  };
}

/**
 * 這次算出來的東西，除了時間戳之外跟上一次一模一樣，而且**今天已經寫過了**嗎？
 *
 * ── 為什麼需要這個 ──────────────────────────────────
 *
 * 第 7 輪（第二十三圈）跑了一次真的 `npm run sync`：結果是
 * 「新增 0、更新 0、來源失敗 0」——**什麼都沒變**，而 `git diff` 有兩行
 * （`generatedAt` 與 `lastSuccessAt`）。
 *
 * `sync-feeds.yml` 的那一步叫「**有變動就 commit**」，守衛是
 * `git diff --quiet -- src/data/syndication.json` —— 而這個檔案每次都會變。
 * 一天兩次、永遠：commit 一筆、push 一次、觸發一次完整部署，
 * 而網站內容一個字都沒有不同。一年約 730 筆。
 *
 * ## 為什麼不是「完全不寫」
 *
 * `generatedAt` 有在畫面上（/elsewhere 與 /colophon 的「上次同步：<日期>」）。
 * 完全不寫的話那會變成「上次**有新東西**的日期」—— 頻道安靜三個月，
 * 頁面就顯示三個月前，看起來像壞掉了，而其實每天都同步成功。那比 churn 更糟。
 *
 * ## 折衷：跟著畫面的精度走
 *
 * 畫面只顯示到「日」。所以內容有變就寫；內容沒變、而且上一次已經是
 * **臺北的同一天**，就不寫。一天最多一筆，而那一筆帶著真的資訊。
 *
 * 「今天」用臺北時間 —— 畫面上那個日期就是用臺北算的（src/lib/dates.ts）。
 * 用執行機器的時區會讓「同一天」跟著同步跑在哪裡變，那正是第 3 輪
 * （第二十二圈）修掉的那一類問題。
 *
 * @param {any} previous  上一次的內容（讀不到就傳 null）
 * @param {any} next      這次算出來的
 * @returns {boolean} true 表示「不用寫」
 */
export function sameAndAlreadyToday(previous, next) {
  if (!previous || !next) return false;

  /** 把每次都會變的時間戳拿掉之後比 */
  const strip = (/** @type {any} */ o) => {
    const copy = JSON.parse(JSON.stringify(o));
    delete copy.generatedAt;
    for (const s of Object.values(copy.sources ?? {})) {
      delete (/** @type {any} */ (s)).lastSuccessAt;
    }
    return JSON.stringify(copy);
  };
  if (strip(previous) !== strip(next)) return false;

  const day = (/** @type {unknown} */ iso) => {
    const d = new Date(/** @type {string} */ (iso));
    return Number.isNaN(d.getTime())
      ? ''
      : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
  };
  const before = day(previous.generatedAt);
  const now = day(next.generatedAt);
  return Boolean(before) && before === now;
}
