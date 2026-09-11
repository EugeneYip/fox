/**
 * 完整 RSS —— 站上的文章，加上各平台同步回來的外站文章。
 *
 * 這是「一次訂完狐狸所有東西」的入口。不想被外站洗版的人可以訂 /rss.xml。
 */
import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { site, DEFAULT_LOCALE, type Locale } from '@config/site';
import { getAllWriting, entryUrl } from '@lib/content';
import { getSyndication, externalKey } from '@lib/syndication';
import { localizePath, useTranslations } from '@i18n/utils';

export const GET: APIRoute = async (context) => {
  const base = context.site ?? new URL(site.url);

  /*
   * ── 站上已經有的那一篇，外站那一筆就不要再放一次 ──────────
   *
   * 九首詩接了她的 YouTube 短片，而 syndication 那一半也有同樣九支。
   * 2026-09-09 把詩頁的日期改成跟影片一致之後，兩筆在這份 feed 裡變成
   * **貼在一起**的：
   *
   *   Wed, 23 Oct 2024  杜甫〈月夜〉「今夜鄜州月⋯」（YouTube）
   *   Wed, 23 Oct 2024  〈月夜〉杜甫                （站內）
   *
   * 同一件作品、同一天、兩筆。訂閱的人看到的是重複。
   * 站內那一頁有原文、白話、注解、讀音，而且影片就嵌在上面 —— 它是比較完整的
   * 那一個，所以留它。（搜尋索引做的是同一件事，只是那邊還把影片的字併進去。）
   *
   * 認不出來的（`externalKey` 回 null）一律留著 —— 寧可多一筆。
   */
  const claimed = new Set<string>();
  for (const { entry } of await getAllWriting()) {
    const key = 'videoUrl' in entry.data ? externalKey(entry.data.videoUrl) : null;
    if (key) claimed.add(key);
  }

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

  /*
   * `.filter` 那一行是**底下那個排序的前提**，不是內容上的取捨。
   *
   * 第 3 輪（第五十一圈）實測：把一筆的 `publishedAt` 設成 null、再把這一行拿掉，
   * 建置當場死在 `TypeError: Cannot read properties of null (reading 'getTime')`
   * —— 噴在底下 `b.pubDate.getTime()` 那裡，不是在 rss 套件裡。
   *
   * 同一件事（「由新到舊」）這個 repo 有三份寫法，而它們對「沒有日期」的立場不同：
   *   lib/content.ts   `byNewest`                      schema 保證有日期，不用防
   *   lib/syndication.ts `?? 0`                        容忍，沒日期的排最後
   *   這裡            `b.pubDate.getTime()`            **不容忍** —— 所以要先濾
   *
   * 也就是說：沒有日期的同步項目在 /elsewhere 上看得到（排最後），
   * 在這份 feed 裡看不到。那是這一行決定的。
   * （今天 9 筆都有日期，所以這個差別還沒有真的發生過。）
   */
  const elsewhere = (await getSyndication())
    .filter((item) => item.publishedAt)
    .filter((item) => {
      const key = externalKey(item.url);
      return !(key && claimed.has(key));
    })
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
