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
import { localizePath, useTranslations } from '@i18n/utils';

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

  /*
   * 後綴走 `rss.allSuffix`，不要在這裡再寫一次。
   *
   * 第 6 輪（第四十八圈）量到：這一行本來寫死「（含各平臺）」，
   * 而 `ui.ts` 的 `rss.allSuffix` 是**一模一樣的字**（Base.astro 的
   * `<link title>` 走那一條）。同一個字兩份，其中一份沒有人在看 ——
   * `check:copy` 掃 `dist/` 的時候只掃 `.html`，而這個檔案輸出的是
   * `.xml`；它掃 `src/` 的時候只掃 `ui.ts` 與 `site.ts`，不含頁面檔。
   * 實測：把這裡的「平臺」改成「平台」建置出去，`check:copy` 離開碼 0；
   * 同一個字改在 `ui.ts` 裡，`taiwan-tai` 當場紅。
   */
  const t = useTranslations(DEFAULT_LOCALE);

  return rss({
    title: `${site.name[DEFAULT_LOCALE]}${t('rss.allSuffix')}`,
    description: `${site.description[DEFAULT_LOCALE]}　這份 feed 同時包含在其他平臺發表的文章。`,
    site: base,
    trailingSlash: false,
    customData: `<language>zh-Hant-TW</language>`,
    items,
  });
};
