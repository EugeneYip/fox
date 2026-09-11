/**
 * 聚合層 —— 把「自動抓來的」和「手動登錄的」外站文章合成同一條時間軸。
 *
 * 資料有兩個來源，前端不該關心差別：
 *   1. src/data/syndication.json  —— sync-feeds.mjs 抓回來的（Medium、YouTube…）
 *   2. content collection "external" —— 手動寫的（Instagram、微信公眾號、Behance）
 *
 * 這裡把兩者正規化成同一個 SyndicatedItem，頁面只要處理一種形狀。
 *
 * ── 她在 YouTube 發一支影片，站上會動到哪裡 ──────────────
 *
 * 第 4 輪（第五十三圈）實測（先跑對照組：什麼都不改重建一次，0 個檔案不同）。
 * 在 `syndication.json` 加**一筆**，重新建置 —— **61 個產出檔裡 10 個**跟著變：
 *
 *   /elsewhere、/elsewhere/youtube          兩種語言共 4 個
 *   首頁                                    兩種語言共 2 個
 *   `/about`（← 這個容易漏掉）              兩種語言共 2 個
 *   rss-all.xml、search-index.json          2 個
 *
 * `/about` 那兩個容易漏掉：它**不畫項目清單**，它用 `getActivePlatforms()`
 * 拿每個平臺的「共 N 篇」，所以筆數一變它就變。
 * 沒有變的：`rss.xml`（那是站內內容的 feed，刻意不含外站）、
 * `sitemap-0.xml`（沒有 `lastmod`，見 `docs/TODO.md`）、`/colophon`。
 *
 * ── 而搜尋索引裡，站外的比站內的多一倍 ──────────────
 *
 * 同一次量到的：`dist/search-index.json` 共 15 筆 ——
 * **站內 5 筆（poems 3、notes 1、posts 1）、YouTube 10 筆**。
 * 也就是說搜尋框回的東西**三分之二會把人帶離這個站**，
 * 而那些字是她在 YouTube 上打的，中間沒有經過任何一次站上的編輯。
 *
 * 那條路本身是有人想過的：外站結果帶 `target="_blank"` ＋ `externalLinkRel`、
 * 標題後面有 `↗`、`.res__meta` 印平臺名、排序上站內比站外多 0.5 分。
 * 而 `check:copy` 會掃到那些標題（第 3 輪〔第三十六圈〕記過：
 * 在 YouTube 標題裡打一個「台」，這個 repo 的關卡會紅，而那行字在這裡改不掉）。
 */
import { sourceHealth } from '../../scripts/lib/sync-health.mjs';
import { getCollection } from 'astro:content';
import { platformOrFallback, type MediaKind, type Platform } from '@config/platforms';
import { sources as sourceList } from '@config/sources.mjs';
import raw from '@/data/syndication.json';
import type { Locale } from '@config/site';

export interface SyndicatedItem {
  id: string;
  platform: Platform;
  media: MediaKind;
  title: string;
  url: string;
  publishedAt: Date | null;
  summary: string;
  lang: Locale;
  tags: string[];
  thumbnail: string | null;
  /** 'auto' = 機器抓的；'manual' = 人挑的 */
  origin: 'auto' | 'manual';
  /** 只有手動登錄的才有：為什麼挑這篇 */
  why?: string;
}

export interface SourceStatus {
  status: 'ok' | 'error';
  platform: string;
  itemCount: number;
  lastSuccessAt: string | null;
  message: string | null;
}

interface RawItem {
  id: string;
  sourceId: string;
  platform: string;
  media?: string;
  title: string;
  url: string;
  publishedAt: string | null;
  summary?: string;
  lang?: string;
  tags?: string[];
  thumbnail?: string | null;
}

interface RawCache {
  generatedAt: string | null;
  itemCount: number;
  sources: Record<string, SourceStatus>;
  items: RawItem[];
}

const cache = raw as unknown as RawCache;

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 自動抓來的部分 */
function autoItems(): SyndicatedItem[] {
  return cache.items.map((item) => {
    const platform = platformOrFallback(item.platform);
    return {
      id: item.id,
      platform,
      media: (item.media as MediaKind) ?? platform.media,
      title: item.title,
      url: item.url,
      publishedAt: toDate(item.publishedAt),
      summary: item.summary ?? '',
      lang: (item.lang as Locale) ?? 'zh-TW',
      tags: item.tags ?? [],
      thumbnail: item.thumbnail ?? null,
      origin: 'auto',
    };
  });
}

/** 手動登錄的部分 */
async function manualItems(): Promise<SyndicatedItem[]> {
  /*
   * 這一行是「草稿過濾」的**第二份實作** —— 第一份在 lib/content.ts 的
   * `getEntries()`。check-content.mjs 的註解點名過這件事：兩份遲早會分岔。
   *
   * 第 3 輪（第十四圈）比對過，結論分兩半：
   *
   * - **草稿那一半逐字相同**，沒有分岔（`import.meta.env.DEV || !data.draft`）
   * - **語言那一半是刻意不同的**：`getEntries()` 會 `filter(e.data.lang === lang)`，
   *   這裡不過濾。理由是 `/elsewhere` 回答的是「她還在哪裡發表」，
   *   而那個答案跟讀者現在用哪種語言看網站無關 —— 第 6 輪（第十二圈）
   *   量過同一件事的另一面：`/en/elsewhere` 上那 1,224 個中文字是影片的
   *   原標題與說明，本來就是中文，不該因為讀者看英文版就消失。
   *
   * 之前這個差別沒有寫在任何地方，所以看起來像漏掉而不是決定。
   */
  const entries = await getCollection('external', ({ data }) => import.meta.env.DEV || !data.draft);
  return entries.map((entry) => {
    const platform = platformOrFallback(entry.data.platform);
    return {
      id: `manual--${entry.id}`,
      platform,
      media: platform.media,
      title: entry.data.title,
      url: entry.data.url,
      publishedAt: entry.data.publishedAt,
      summary: entry.data.excerpt ?? entry.data.description ?? '',
      lang: entry.data.lang,
      tags: entry.data.tags,
      thumbnail: null,
      origin: 'manual',
      why: entry.data.why,
    };
  });
}

/**
 * 合併後的完整時間軸，新的在前。
 * 同一個網址若同時被自動抓到又手動登錄，以手動的為準 —— 人寫的說明比較有價值。
 */
export async function getSyndication(options: {
  platform?: string;
  media?: MediaKind;
  lang?: Locale;
  limit?: number;
} = {}): Promise<SyndicatedItem[]> {
  const merged = new Map<string, SyndicatedItem>();
  for (const item of autoItems()) merged.set(item.url, item);
  for (const item of await manualItems()) merged.set(item.url, item);

  let items = [...merged.values()];
  if (options.platform) items = items.filter((i) => i.platform.id === options.platform);
  if (options.media) items = items.filter((i) => i.media === options.media);
  if (options.lang) items = items.filter((i) => i.lang === options.lang);

  items.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  return options.limit ? items.slice(0, options.limit) : items;
}

/** 有內容或有啟用來源的平台，給 /elsewhere 的平台卡片用 */
export async function getActivePlatforms(): Promise<
  Array<{ platform: Platform; count: number; homeUrl?: string; status?: SourceStatus }>
> {
  const items = await getSyndication();
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.platform.id, (counts.get(item.platform.id) ?? 0) + 1);

  const seen = new Map<string, { platform: Platform; count: number; homeUrl?: string; status?: SourceStatus }>();

  // 有啟用的來源 —— 就算還沒抓到東西也要顯示，讓人知道「這裡也有」
  for (const source of sourceList) {
    if (!source.enabled || source.handle === 'CHANGE_ME') continue;
    const platform = platformOrFallback(source.platform);
    const homeUrl =
      source.homeUrl || platform.homeTemplate?.replaceAll('{handle}', source.handle ?? '');
    seen.set(platform.id, {
      platform,
      count: counts.get(platform.id) ?? 0,
      homeUrl,
      status: cache.sources[source.id],
    });
  }
  // 只有手動登錄、沒設定來源的平台也要出現
  for (const [id, count] of counts) {
    if (!seen.has(id)) seen.set(id, { platform: platformOrFallback(id), count });
  }

  return [...seen.values()].sort((a, b) => b.count - a.count);
}

/**
 * 「上次同步」給讀者看的時間 —— **最後一次真的拿到資料**，不是最後一次跑。
 *
 * `generatedAt` 是這個檔案被寫出來的時刻，而失敗的那一次**也會寫檔**
 * （沿用快取、把 status 記成 error）。拿它當「上次同步」等於誇大新鮮度：
 * 2026-09-11 普查時，最後一次跑是當天 04:18（失敗），而最後一次真的
 * 抓到東西是前一天 16:15 —— 畫面上卻寫著今天。
 *
 * 兩個方向要一起修才誠實：這一行不要說得比實際新，
 * 而底下的來源狀態也不要因為一次沒跑成就喊失火（見 `syncHealth`）。
 *
 * 所有來源都沒有成功紀錄時退回 `generatedAt` —— 那是「跑過但從來沒成功」，
 * 總比什麼都不顯示好。
 */
export function lastSyncedAt(): Date | null {
  const successes = Object.values(cache.sources)
    .map((s) => toDate(s.lastSuccessAt))
    .filter((d): d is Date => d !== null);
  if (successes.length > 0) {
    return new Date(Math.max(...successes.map((d) => d.getTime())));
  }
  return toDate(cache.generatedAt);
}

/**
 * 同步來源的健康狀況 —— 顯示在 /colophon。
 *
 * ## 為什麼不看 `status`
 *
 * `status` 是**最後一次跑的結果**。而 YouTube 的 RSS 端點會一陣一陣地壞掉
 * （CLAUDE.md 記著實測：一分鐘內連打三次是 404、500、404），所以單獨一次
 * 沒跑成，完全不代表這個來源出事了。
 *
 * 2026-09-11 普查時量到的現場：
 *
 *     最後一次跑   2026-09-11 04:18  status = error（RSS 404，試了 7 次）
 *     最後一次成功 2026-09-10 16:15  ← 十二小時前
 *     站上的條目   9 筆，沿用快取，完全正常
 *
 * 而這一頁當時對**每一個讀者**寫著「0 healthy, 1 failing」。
 * 內容好好的，畫面上卻在喊失火。
 *
 * ## 現在跟誰共用同一個判準
 *
 * 改成問 `scripts/lib/sync-health.mjs` 的 `sourceHealth()` ——
 * 也就是 `npm run sync:health` 與 `check:content` 用的同一支。
 * 判準是「上一次真的拿到資料是多久以前」，超過 `SYNC_STALE_DAYS`（3 天，
 * 排程一天兩次 ＝ 連續六次沒跑成）才算冷掉。
 *
 * 那個模組的標頭自己就寫著「門檻只有一個常數，兩邊共用 ——
 * 不要變成『同一件事寫在兩個地方』」。這裡本來就是那第二個地方，
 * 而且是唯一一個讀者看得到的。
 */
export function syncHealth(): { ok: number; failed: string[] } {
  const { total, cold } = sourceHealth({ sources: cache.sources });
  return { ok: total - cold.length, failed: cold.map((c) => c.id) };
}
