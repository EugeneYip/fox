/**
 * 全站 RSS —— 只含這個網站上自己寫的東西。
 * 想連外站文章一起訂的人請用 /rss-all.xml。
 */
import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { site, DEFAULT_LOCALE } from '@config/site';
import { getAllWriting, entryUrl } from '@lib/content';
import { localizePath } from '@i18n/utils';
import type { Locale } from '@config/site';

export const GET: APIRoute = async (context) => {
  const all = await getAllWriting({ limit: 60 });

  return rss({
    title: site.name[DEFAULT_LOCALE],
    description: site.description[DEFAULT_LOCALE],
    site: context.site ?? site.url,
    trailingSlash: false,
    customData: `<language>zh-Hant-TW</language>`,
    items: all.map(({ collection, entry }) => {
      const lang = entry.data.lang as Locale;
      const poem = 'poem' in entry.data ? entry.data.poem : undefined;
      return {
        title: poem ? `〈${poem.title}〉${poem.author}` : entry.data.title,
        link: localizePath(entryUrl(collection, entry), lang),
        pubDate: entry.data.publishedAt,
        description: entry.data.description ?? '',
        categories: entry.data.tags,
      };
    }),
  });
};
