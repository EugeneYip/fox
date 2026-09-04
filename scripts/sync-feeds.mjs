#!/usr/bin/env node
// @ts-check
/**
 * 外部平台同步 —— 把散落各處的文章抓回來，存成一份 JSON。
 *
 *   node scripts/sync-feeds.mjs [--dry-run] [--strict] [--only=<source-id>] [--verbose]
 *
 * 設計上的幾個決定，寫在這裡免得以後忘記為什麼：
 *
 * 1. 建置時抓，不是瀏覽時抓。
 *    GitHub Pages 是純靜態，沒有後端。而且就算有，也不該讓每個訪客
 *    的瀏覽器去打 Medium／YouTube —— 那等於把訪客的 IP 送給那些平台。
 *
 * 2. 結果 commit 進 repo。
 *    src/data/syndication.json 是會被版控的。好處是：某個平台掛掉、
 *    改版、或帳號被停用，網站還是 build 得起來，歷史文章也不會消失。
 *    壞處是 repo 會慢慢變大，但這是文字，一年也就幾百 KB。
 *
 * 3. 只增不刪（除非明確指定）。
 *    RSS 通常只吐最新 10～20 篇。如果每次同步都直接覆蓋，舊文章會被
 *    洗掉。所以這裡做的是「合併」：新的蓋掉同 id 的舊的，沒出現的保留。
 *
 * 4. 失敗不擋建置。
 *    任何一個來源抓失敗，就沿用上一次的快取、記一筆警告、繼續跑。
 *    只有加了 --strict 才會讓整個流程失敗（CI 想要嚴格時再開）。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sources } from '../src/config/sources.mjs';
import { getPlatform, fillTemplate } from '../src/config/platforms.data.mjs';
import { sourceFeedUrl } from './lib/source-feed-url.mjs';
import { UA_SYNC } from './lib/http.mjs';
import { syncSources, buildPayload, sameAndAlreadyToday } from './lib/sync-core.mjs';

/**
 * 一筆來源的形狀。用結構化的 typedef 而不是從 sources.mjs 推導 ——
 * 那份是資料檔，型別由使用它的人宣告比較清楚。
 *
 * @typedef {object} Source
 * @property {string} id
 * @property {string} platform
 * @property {boolean} [enabled]
 * @property {string} [handle]
 * @property {string} [channelId]
 * @property {string} [feedUrl]
 * @property {string} [label]
 * @property {string} [lang]
 * @property {string[]} [tags]
 * @property {number} [limit]
 * @property {boolean} [featured]
 */

/** @typedef {import('../src/config/platforms.data.mjs').Platform} Platform */
import { fetchWithRetry as rawFetchWithRetry } from './lib/fetch-retry.mjs';
import { fetchYouTubeSource as rawFetchYouTubeSource } from './lib/youtube-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_FILE = resolve(ROOT, 'src/data/syndication.json');

const argv = process.argv.slice(2);
const FLAGS = {
  dryRun: argv.includes('--dry-run'),
  strict: argv.includes('--strict'),
  verbose: argv.includes('--verbose'),
  only: argv.find((a) => a.startsWith('--only='))?.slice('--only='.length),
};

const ENV = {
  youtubeKey: process.env.YOUTUBE_API_KEY?.trim() || '',
  rsshubBase: (process.env.RSSHUB_BASE?.trim() || '').replace(/\/+$/, ''),
};

/*
 * HTTP header 的值只能是 Latin-1（ByteString）。
 * 這裡原本用了全形破折號「—」（U+2014），fetch 會直接拋
 * "Cannot convert argument to a ByteString"，而且是在送出請求之前就爆，
 * 所以看起來像網路錯誤。整個同步流程因此從來沒成功送出過任何一個請求。
 * 一律用純 ASCII。
 */
const USER_AGENT = UA_SYNC;
const TIMEOUT_MS = 20_000;

// ── 小工具 ────────────────────────────────────────────────

const log = {
  /** @param {...unknown} a */ info: (...a) => console.log('  ', ...a),
  /** @param {...unknown} a */ step: (...a) => console.log('\n▸', ...a),
  /** @param {...unknown} a */ ok: (...a) => console.log('   ✓', ...a),
  /** @param {...unknown} a */ warn: (...a) => console.warn('   ! ', ...a),
  /** @param {...unknown} a */ fail: (...a) => console.error('   ✗', ...a),
  /** @param {...unknown} a */ debug: (...a) => FLAGS.verbose && console.log('   ·', ...a),
};

/*
 * 實作在 lib/fetch-retry.mjs（抽出去是為了能在沒有網路的情況下測，
 * 見 test-fetch-retry.mjs）。這裡只負責把這支腳本的 log 與常數綁上去。
 */
/**
 * @param {string} url
 * @param {{ retries?: number, headers?: Record<string, string>, retryOn404?: boolean }} [opts]
 */
const fetchWithRetry = (url, opts = {}) =>
  rawFetchWithRetry(url, { ...opts, userAgent: USER_AGENT, timeoutMs: TIMEOUT_MS, log });

import {
  toPlainText,
  tidyTitle,
  stableId,
  toIso,
  asArray,
  textOf,
  parser,
  parseFeed,
} from './lib/parse-feed.mjs';
import { parseYouTubeFeed, mapYouTubeApiItem } from './lib/parse-youtube-feed.mjs';


// ── 各種取得策略 ──────────────────────────────────────────

/** 一般 RSS/Atom */
/** @param {Source} source @param {Platform} platform */
async function fetchRssSource(source, platform) {
  const url = sourceFeedUrl(source, platform);
  if (!url) {
    throw new Error(
      platform.confidence === 'lookup-required'
        ? `${platform.name['zh-TW']} 的 feed 網址沒辦法由帳號名推導，請到個人頁複製 RSS 網址填進 sources.mjs 的 feedUrl`
        : `${platform.name['zh-TW']} 推導不出 feed 網址 —— 到那個平臺的個人頁找 RSS 連結，填進 sources.mjs 這一筆的 feedUrl`,
    );
  }
  log.debug('GET', url);
  const res = await fetchWithRetry(url);
  return parseFeed(await res.text(), source, { log });
}

/**
 * YouTube。
 *
 * 先試官方 RSS，抓不到才退回 Data API。
 *
 * 為什麼要兩條路：2026-09-02 上午實測
 * `youtube.com/feeds/videos.xml?channel_id=…` 對所有頻道都回 404，
 * 連 Google 自家的頻道也是；同一天中午再測就恢復 200 了。
 * 也就是說那個端點會間歇性掛掉，但沒有被下架。
 *
 * 所以：平常走 RSS（不需要金鑰、不吃配額），
 * RSS 掛掉而且有設 YOUTUBE_API_KEY 時才退回 API。
 *
 * 兩者的差別：RSS 只給最近 15 支，API 可以往回抓完整清單。
 * 但同步是「只增不刪」的合併，長期跑下來 RSS 也會累積出完整歷史。
 */
/** @param {Source} source @param {Platform} [_platform] */
/*
 * 實作在 lib/youtube-source.mjs（抽出去是為了能在沒有網路的情況下測那三條路，
 * 見 test-youtube-source.mjs）。這裡只負責把兩個策略與金鑰綁上去。
 */
/** @param {Source} source @param {Platform} [_platform] */
async function fetchYouTubeSource(source, _platform) {
  return rawFetchYouTubeSource(source, {
    fetchRss: fetchYouTubeRss,
    fetchApi: fetchYouTubeApi,
    apiKey: ENV.youtubeKey,
    log,
  });
}

/** 官方 Atom feed。免金鑰、不吃配額，最近 15 支。 */
/** @param {Source} source @param {string} channelId */
async function fetchYouTubeRss(source, channelId) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  log.debug('GET', url);
  /*
   * 這個端點會對存在的頻道回 404，而且是一陣一陣的（實測見 fetchWithRetry 的註解：
   * 兩分鐘內同一個網址 1 次 200、2 次 500、10 次 404）。
   *
   * 所以這裡是全站唯一一個「404 也要重試」的地方，而且多給幾次機會。
   * 成本只在失敗時付出，成功的話第一次就回來了 —— 而失敗的代價是
   * 整個來源當掉、只能沿用快取。
   *
   * ── 為什麼是 6 不是 4 ──────────────────────────────
   *
   * 第 4 輪（第二十一圈）第一次量了「壞的時候會壞多久」，而不只是
   * 「壞的比例是多少」。兩次取樣，失敗都是**連成一段**的，不是隨機散落：
   *
   *   24 次（間隔 2.5 秒）：XXXXXXXXXXXXX·······XX  →  最長壞段約 32 秒
   *   45 次（間隔 2 秒）　：XXXXXXXXXXX··············  →  最長壞段 22 秒
   *
   * 而 `retries: 4` 的退避是 600+1200+2400+4800 = **9 秒**。
   * 也就是說五次嘗試全部落在同一個壞段裡 —— 同一天實測到最直接的一次：
   * `sync:dry` 五次全 404，一分鐘後 `verify` 第一次就 200。
   *
   * 重試的視窗要比壞段長才有意義。6 次的退避是
   * 600+1200+2400+4800+9600+19200 ≈ **38 秒**，蓋得過量到的兩段。
   * 代價只在真的不通的時候付：一天兩次的排程，多等半分鐘。
   */
  const res = await fetchWithRetry(url, { retryOn404: true, retries: 6 });

  /*
   * 這個 feed 是一個**視窗，不是完整目錄**。
   *
   * 第 4 輪（第十一圈）實測：Google Developers 那種上千支影片的頻道，
   * 這個端點回的是 **15 筆**；她的頻道 9 支，所以現在全部都看得到。
   *
   * 兩個後果，到第 16 支影片的時候才會開始成立：
   *
   *   1. 「這次的 feed 沒有這一筆」**不能當成影片被刪掉的證據** ——
   *      它可能只是掉出視窗了。這也是 mergeItems 只增不刪的理由之一。
   *   2. 更早的影片這條路看不到，要往回抓完整清單得走 Data API
   *      （下面那個函式），而那需要 YOUTUBE_API_KEY。
   *
   * 欄位怎麼對應在 lib/parse-youtube-feed.mjs —— 抽出去是為了能零網路測試
   * （第 4 輪〔第十三圈〕：那一段每天在跑，而它一個案例都沒有）。
   */
  return parseYouTubeFeed(await res.text(), source);
}

/**
 * Data API v3。需要金鑰，可以往回抓完整清單。
 *
 * 技巧：頻道 ID 的 UC 換成 UU 就是「所有上傳影片」的播放清單 ID，
 * 用 playlistItems 讀它一次只花 1 unit 配額，比 search.list 的 100 unit 便宜得多。
 */
/** @param {Source} source @param {string} channelId */
async function fetchYouTubeApi(source, channelId) {
  const uploads = 'UU' + channelId.slice(2);
  const wanted = source.limit ?? 50;
  const items = [];
  let pageToken = '';

  while (items.length < wanted) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.searchParams.set('part', 'snippet,contentDetails');
    url.searchParams.set('playlistId', uploads);
    url.searchParams.set('maxResults', String(Math.min(50, wanted - items.length)));
    url.searchParams.set('key', ENV.youtubeKey);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetchWithRetry(url.toString());
    const data = await res.json();
    if (data.error) throw new Error(`YouTube API：${data.error.message}`);

    /*
     * 欄位對應抽進 lib/parse-youtube-feed.mjs 了 —— 跟 RSS 那一半放在一起，
     * 因為它們必須產生**同一個形狀**（第 4 輪〔第十四圈〕：只要有一個欄位
     * 對不齊，切換來源那天九支影片會全部被報成「更新」）。
     */
    for (const it of data.items ?? []) {
      const mapped = mapYouTubeApiItem(source, it);
      if (mapped) items.push(mapped);
    }
    pageToken = data.nextPageToken ?? '';
    if (!pageToken) break;
  }
  return items;
}

/** 沒有官方 RSS 的平台，透過 RSSHub 橋接 */
/** @param {Source} source @param {Platform} platform */
async function fetchBridgeSource(source, platform) {
  if (!ENV.rsshubBase) {
    throw new Error(
      `${platform.name['zh-TW']} 沒有官方 RSS，需要設定 RSSHUB_BASE 才能橋接（略過）`,
    );
  }
  const route = fillTemplate(platform.bridgeRoute, source.handle ?? '');
  if (!route) {
    /*
     * 這一則跟上面幾則不一樣：它其實是給改 `platforms.data.mjs` 的人看的。
     * 第 4 輪（第十二圈）逐則讀過站主會看到的訊息，這是唯一一則
     * 讀完不知道該做什麼的 —— 補上該去哪裡。
     */
    throw new Error(
      `${platform.name['zh-TW']} 在 platforms.data.mjs 裡沒有填 bridgeRoute，所以橋接組不出網址。` +
        '要嘛把那一筆補上，要嘛把這個來源的 enabled 改成 false。',
    );
  }
  const url = `${ENV.rsshubBase}${route}`;
  log.debug('GET(bridge)', url);
  const res = await fetchWithRetry(url);
  return parseFeed(await res.text(), source, { log });
}

const STRATEGIES = {
  rss: fetchRssSource,
  // hybrid = 有公開 RSS，但那個端點會間歇性掛掉，所以內部先 RSS 後 API。
  // 目前只有 YouTube 屬於這類。
  hybrid: fetchYouTubeSource,
  api: fetchYouTubeSource,
  bridge: fetchBridgeSource,
  manual: async () => [],
};

// ── 合併與輸出 ────────────────────────────────────────────

async function readExisting() {
  if (!existsSync(OUT_FILE)) return { items: [], sources: {} };
  try {
    const raw = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    return { items: raw.items ?? [], sources: raw.sources ?? {} };
  } catch (err) {
    /*
     * 第 4 輪（第十二圈）把快取檔弄壞跑了一次，看站主會看到什麼。
     * 訊息本身沒問題，但它沒說「全新開始」的**代價**：所有項目的
     * `firstSeenAt` 會被重設成今天（那一次實測報「新增 9」）。
     * 那個欄位一旦丟了就補不回來，所以要說出來。
     */
    log.warn(
      '舊的快取讀不起來，這次當作全新開始（每一筆的 firstSeenAt 會重設成今天，那個補不回來）：',
      /** @type {{ message?: string }} */ (err)?.message,
    );
    return { items: [], sources: {} };
  }
}


async function main() {
  console.log('\n狐狸的文章同步 —— 把各平臺的東西抓回來\n' + '─'.repeat(52));

  const previous = await readExisting();

  const targets = sources.filter(
    (s) => s.enabled && (!FLAGS.only || s.id === FLAGS.only),
  );

  if (targets.length === 0) {
    log.warn('沒有任何啟用中的來源。到 src/config/sources.mjs 把 enabled 改成 true。');
  }

  /*
   * 抓取與合併的邏輯在 lib/sync-core.mjs。抽出去的理由不是「檔案太長」，
   * 是**那一層沒有辦法測**：它要有網路，而且只走得到成功那條路。
   * 「平臺掛掉不影響網站」是這個站的招牌性質，而它整個實作在那個 catch 裡。
   * 見 test-sync-core.mjs。
   */
  const { byId, sourceStatus, added, updated, failures } = await syncSources({
    targets,
    previous,
    getPlatform,
    runStrategy: (source, platform) =>
      STRATEGIES[/** @type {keyof typeof STRATEGIES} */ (platform.feedKind)](source, platform),
    log,
  });

  const payload = buildPayload({ byId, sourceStatus });
  const items = payload.items;

  console.log('\n' + '─'.repeat(52));
  console.log(`總計 ${items.length} 筆（新增 ${added}、更新 ${updated}、來源失敗 ${failures}）`);

  if (FLAGS.dryRun) {
    console.log('（--dry-run：沒有寫入檔案）\n');
  } else {
    /*
     * ── 沒有變的時候不要動檔案 ──────────────────────────
     *
     * 第 7 輪（第二十三圈）把「同步的那一天」整條走了一次：跑一次真的
     * `npm run sync`，結果是「新增 0、更新 0、來源失敗 0」——**什麼都沒變**，
     * 而 `git diff` 有兩行：
     *
     *     -  "generatedAt": "…09-02T16:53:37.689Z"
     *     +  "generatedAt": "…09-04T07:28:00.851Z"
     *     -      "lastSuccessAt": …（同上）
     *
     * `sync-feeds.yml` 的守衛是 `git diff --quiet -- src/data/syndication.json`，
     * 那一步的名字叫「**有變動就 commit**」—— 而這個檔案**每一次都會變**。
     * 也就是說：一天兩次、永遠，commit 一筆、push 一次、觸發一次完整部署，
     * 而網站的內容一個字都沒有不同。一年約 730 筆這樣的 commit。
     *
     * ## 為什麼不是「完全不寫」
     *
     * `generatedAt` **有在畫面上**：/elsewhere 與 /colophon 顯示
     * 「上次同步：<日期>」。完全不寫的話，那個日期會變成「上次**有新東西**的
     * 日期」—— 頻道安靜三個月，頁面就顯示三個月前，看起來像壞掉了，
     * 而其實每天都同步成功。那比 churn 更糟。
     *
     * ## 折衷：跟著畫面的精度走
     *
     * 畫面上只顯示到「日」（`formatDate` 不顯示時間）。所以：
     * 內容有變就寫；內容沒變、而且上一次的 `generatedAt` 已經是**臺北的同一天**，
     * 就不寫。一天最多一筆，而那一筆帶著真的資訊（「今天有查，而且成功」）。
     */
    /** 讀檔那一層留在這裡，判斷本身在 lib 裡（那樣才測得動） */
    let previous = null;
    try {
      previous = JSON.parse(await readFile(OUT_FILE, 'utf8'));
    } catch {
      previous = null;
    }
    const same = sameAndAlreadyToday(previous, payload);
    if (same) {
      console.log('內容沒有變，而且今天已經同步過了 —— 不動檔案。\n');
    } else {
      await mkdir(dirname(OUT_FILE), { recursive: true });
      await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      console.log(`已寫入 ${OUT_FILE.replace(ROOT + '/', '')}\n`);
    }
  }

  if (failures > 0 && FLAGS.strict) {
    console.error('--strict：有來源失敗，以錯誤結束。\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n同步腳本自己爆了：', err);
  process.exit(1);
});
