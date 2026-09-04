/**
 * 內容存取層 —— 頁面一律透過這裡拿資料，不直接呼叫 getCollection。
 *
 * 這樣做的好處：草稿過濾、語言過濾、排序這些規則只寫一次。
 * 以後想改「草稿在 preview 環境也要看得到」之類的規則，改一個地方就好。
 */
import { getCollection, type CollectionEntry } from 'astro:content';
import type { Locale } from '@config/site';
import { DEFAULT_LOCALE } from '@config/site';
import { readingMinutes, year } from './dates';

export type WritingCollection = 'posts' | 'poems' | 'notes';
export type AnyEntry =
  | CollectionEntry<'posts'>
  | CollectionEntry<'poems'>
  | CollectionEntry<'notes'>;

/** 草稿只在 dev 看得到 */
const visible = ({ data }: { data: { draft: boolean } }) => import.meta.env.DEV || !data.draft;

function byNewest(a: AnyEntry, b: AnyEntry) {
  return b.data.publishedAt.getTime() - a.data.publishedAt.getTime();
}

/** 置頂的排前面，其餘按時間 */
function byFeaturedThenNewest(a: AnyEntry, b: AnyEntry) {
  if (a.data.featured !== b.data.featured) return a.data.featured ? -1 : 1;
  return byNewest(a, b);
}

export async function getEntries<C extends WritingCollection>(
  collection: C,
  options: { lang?: Locale; tag?: string; limit?: number; featuredFirst?: boolean } = {},
): Promise<CollectionEntry<C>[]> {
  let entries = (await getCollection(collection, visible)) as CollectionEntry<C>[];

  if (options.lang) {
    entries = entries.filter((e) => e.data.lang === options.lang);
  }
  if (options.tag) {
    const needle = options.tag.toLowerCase();
    entries = entries.filter((e) => e.data.tags.some((t) => t.toLowerCase() === needle));
  }

  entries.sort(options.featuredFirst ? byFeaturedThenNewest : byNewest);
  return options.limit ? entries.slice(0, options.limit) : entries;
}

/** 三種內容混在一起的時間軸，給首頁和 /archive 用 */
export async function getAllWriting(
  options: { lang?: Locale; limit?: number } = {},
): Promise<Array<{ collection: WritingCollection; entry: AnyEntry }>> {
  const [posts, poems, notes] = await Promise.all([
    getEntries('posts', { lang: options.lang }),
    getEntries('poems', { lang: options.lang }),
    getEntries('notes', { lang: options.lang }),
  ]);

  const merged = [
    ...posts.map((entry) => ({ collection: 'posts' as const, entry: entry as AnyEntry })),
    ...poems.map((entry) => ({ collection: 'poems' as const, entry: entry as AnyEntry })),
    ...notes.map((entry) => ({ collection: 'notes' as const, entry: entry as AnyEntry })),
  ].sort((a, b) => byNewest(a.entry, b.entry));

  return options.limit ? merged.slice(0, options.limit) : merged;
}

/** 找同一篇文章的其他語言版本 */
export async function getTranslations(
  collection: WritingCollection,
  entry: AnyEntry,
): Promise<Array<{ lang: Locale; id: string }>> {
  const key = entry.data.translationKey;
  if (!key) return [];
  const all = await getEntries(collection);
  return all
    .filter((e) => e.data.translationKey === key && e.id !== entry.id)
    .map((e) => ({ lang: e.data.lang as Locale, id: e.id }));
}

/**
 * 標籤的網址形式。
 *
 * 一律小寫。中文不受影響（沒有大小寫），英文標籤則因此不會出現
 * `/tags/Poetry` 與 `/tags/poetry` 兩個內容相同的頁面。
 * 顯示時仍然用原本的寫法，只有網址被統一。
 */
export function tagSlug(tag: string): string {
  return tag.trim().toLowerCase();
}

export interface TagEntry {
  /** 顯示用，保留原本的大小寫 */
  tag: string;
  /** 網址用，小寫 */
  slug: string;
  count: number;
}

/**
 * 全站標籤與出現次數，多到少排序。
 *
 * 依 slug 分組，所以 `Poetry` 與 `poetry` 會被算成同一個（次數相加）。
 * 顯示用哪一種寫法？取出現次數最多的那個；一樣多的話取字典序第一個，
 * 這樣每次建置的結果才會一致。
 */
export async function getTagCloud(lang?: Locale): Promise<TagEntry[]> {
  const all = await getAllWriting({ lang });
  const groups = new Map<string, { count: number; forms: Map<string, number> }>();

  for (const { entry } of all) {
    for (const tag of entry.data.tags) {
      const slug = tagSlug(tag);
      if (!slug) continue;
      const g = groups.get(slug) ?? { count: 0, forms: new Map<string, number>() };
      g.count += 1;
      g.forms.set(tag, (g.forms.get(tag) ?? 0) + 1);
      groups.set(slug, g);
    }
  }

  return [...groups.entries()]
    .map(([slug, g]) => {
      const tag = [...g.forms.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-TW'),
      )[0]![0];
      return { tag, slug, count: g.count };
    })
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-TW'));
}

/** 依年份分組，給 /archive 用 */
export async function groupByYear(lang?: Locale) {
  const all = await getAllWriting({ lang });
  const groups = new Map<number, typeof all>();
  for (const item of all) {
    /* 用臺北時間的年份 —— `getFullYear()` 讀的是建置機器的時區，見 dates.ts */
    const y = year(item.entry.data.publishedAt);
    groups.set(y, [...(groups.get(y) ?? []), item]);
  }
  return [...groups.entries()].sort(([a], [b]) => b - a);
}

/** 這篇文章的網址 */
export function entryUrl(collection: WritingCollection, entry: AnyEntry): string {
  const segment = { posts: 'writing', poems: 'poems', notes: 'notes' }[collection];
  return `/${segment}/${entry.id}`;
}

/** 詩詞用原文估閱讀時間會嚴重低估，所以把白話跟注也算進去 */
export function estimateReadingTime(entry: AnyEntry, body: string | undefined): number {
  const extra =
    'poem' in entry.data
      ? [entry.data.poem.original, entry.data.plain ?? ''].join(' ')
      : '';
  return readingMinutes(`${body ?? ''} ${extra}`);
}

/** 上一篇／下一篇 */
export async function getNeighbors<C extends WritingCollection>(
  collection: C,
  entry: CollectionEntry<C>,
  lang?: Locale,
) {
  const all = await getEntries(collection, { lang: lang ?? (entry.data.lang as Locale) });
  const index = all.findIndex((e) => e.id === entry.id);
  return {
    newer: index > 0 ? all[index - 1] : undefined,
    older: index >= 0 && index < all.length - 1 ? all[index + 1] : undefined,
  };
}

export { DEFAULT_LOCALE };

/**
 * 同一個系列的所有文章，依 seriesOrder 排好。
 *
 * 沒填 seriesOrder 的排在有填的後面，彼此依日期。這樣做的理由是：
 * 系列常常是寫到第三篇才發現「這是一個系列」，回頭補編號時
 * 不該逼人把所有既有文章都補上數字。
 */
export async function getSeries(
  series: string,
  lang?: Locale,
): Promise<CollectionEntry<'posts'>[]> {
  const all = await getEntries('posts', { lang });
  return all
    .filter((e) => e.data.series === series)
    .sort((a, b) => {
      const oa = a.data.seriesOrder;
      const ob = b.data.seriesOrder;
      if (oa != null && ob != null) return oa - ob;
      if (oa != null) return -1;
      if (ob != null) return 1;
      return a.data.publishedAt.getTime() - b.data.publishedAt.getTime();
    });
}

// ─────────────────────────────────────────────────────────
// 分頁
// ─────────────────────────────────────────────────────────

/** 一頁放幾筆。30 筆大約是 5～6 個螢幕高度，還在「可以捲完」的範圍 */
export const PAGE_SIZE = 30;

/*
 * 同步回來的項目每一筆都帶標題與說明（YouTube 的說明有一兩百字），
 * 所以同樣的筆數比自己寫的文章重得多。
 *
 * 第 4 輪（第十九圈）實測：平臺頁第 1 頁放 30 筆是 gzip **14.9 KB**，
 * 超過「最大單頁 HTML」14 KB 的預算；`/elsewhere` 那一頁早就因為同樣的
 * 理由把上限調成 20（那次是量出來的，20 筆 12.7 KB／90%），
 * 但**平臺頁一直沿用共用的 30，沒有人量過**。
 */
export const SYNDICATION_PAGE_SIZE = 20;

export interface Page<T> {
  items: T[];
  current: number;
  total: number;
  /** 這一頁的第一筆是全部裡的第幾筆（1 起算），用於「第 31–60 篇」這種說法 */
  from: number;
  to: number;
  totalItems: number;
  prevUrl?: string;
  nextUrl?: string;
}

/**
 * 把一個列表切成第 n 頁。
 *
 * 網址的形狀刻意是 `/poems` 與 `/poems/page/2`，而不是 Astro 內建
 * paginate() 產生的 `/poems/2` —— 因為單篇詩詞就住在 `/poems/{slug}`，
 * 兩者會撞在一起（一首 slug 叫「2」的詩就會蓋掉第二頁）。
 * 多一層 `page/` 是最省事的隔離方式，第一頁也維持在乾淨的 `/poems`。
 */
export function paginate<T>(items: T[], current: number, basePath: string, size = PAGE_SIZE): Page<T> {
  const total = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(Math.max(1, current), total);
  const start = (page - 1) * size;

  const url = (n: number) => (n === 1 ? basePath : `${basePath}/page/${n}`);

  return {
    items: items.slice(start, start + size),
    current: page,
    total,
    from: items.length === 0 ? 0 : start + 1,
    to: Math.min(start + size, items.length),
    totalItems: items.length,
    prevUrl: page > 1 ? url(page - 1) : undefined,
    nextUrl: page < total ? url(page + 1) : undefined,
  };
}

/** 給 getStaticPaths 用：第 2 頁以後的頁碼（第 1 頁在 index.astro） */
export function extraPageNumbers(count: number, size = PAGE_SIZE): number[] {
  const total = Math.ceil(count / size);
  return Array.from({ length: Math.max(0, total - 1) }, (_, i) => i + 2);
}
