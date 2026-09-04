/**
 * 聚合層 —— 把「自動抓來的」和「手動登錄的」外站文章合成同一條時間軸。
 *
 * 資料有兩個來源，前端不該關心差別：
 *   1. src/data/syndication.json  —— sync-feeds.mjs 抓回來的（Medium、YouTube…）
 *   2. content collection "external" —— 手動寫的（Instagram、微信公眾號、Behance）
 *
 * 這裡把兩者正規化成同一個 SyndicatedItem，頁面只要處理一種形狀。
 */
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

export function lastSyncedAt(): Date | null {
  return toDate(cache.generatedAt);
}

/** 同步是否有來源失敗 —— 顯示在 /colophon，讓維護者知道要修 */
export function syncHealth(): { ok: number; failed: string[] } {
  const entries = Object.entries(cache.sources);
  return {
    ok: entries.filter(([, s]) => s.status === 'ok').length,
    failed: entries.filter(([, s]) => s.status === 'error').map(([id]) => id),
  };
}
