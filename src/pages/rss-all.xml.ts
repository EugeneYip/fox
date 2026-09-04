/**
 * 完整 RSS —— 站上的文章，加上各平台同步回來的外站文章。
 *
 * 這是「一次訂完狐狸所有東西」的入口。不想被外站洗版的人可以訂 /rss.xml。
 */
import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { site, DEFAULT_LOCALE, type Locale } from '@config/site';
import { getAllWriting, entryUrl } from '@lib/content';
import { getSyndication } from '@lib/syndication';
import { localizePath } from '@i18n/utils';

export const GET: APIRoute = async (context) => {
  const base = context.site ?? new URL(site.url);

  const own = (await getAllWriting()).map(({ collection, entry }) => {
    const lang = entry.data.lang as Locale;
    const poem = 'poem' in entry.data ? entry.data.poem : undefined;
    return {
      title: poem ? `〈${poem.title}〉${poem.author}` : entry.data.title,
      link: new URL(localizePath(entryUrl(collection, entry), lang), base).toString(),
      pubDate: entry.data.publishedAt,
      description: entry.data.description ?? '',
      categories: entry.data.tags,
    };
  });

  const elsewhere = (await getSyndication())
    .filter((item) => item.publishedAt)
    .map((item) => ({
      title: `${item.title}（${item.platform.name['zh-TW']}）`,
      link: item.url,
      pubDate: item.publishedAt!,
      description: item.summary,
      categories: item.tags,
    }));

  const items = [...own, ...elsewhere]
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime())
    .slice(0, 100);

  return rss({
    title: `${site.name[DEFAULT_LOCALE]}（含各平臺）`,
    description: `${site.description[DEFAULT_LOCALE]}　這份 feed 同時包含在其他平臺發表的文章。`,
    site: base,
    trailingSlash: false,
    customData: `<language>zh-Hant-TW</language>`,
    items,
  });
};
