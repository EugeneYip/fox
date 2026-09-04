/**
 * 站內搜尋索引。
 *
 * 為什麼自己做而不是用 Pagefind 之類的：
 *   - 這個站的內容量在可預見的未來都是幾百篇的等級，一份 JSON 就夠了
 *   - 不需要額外的二進位檔或建置步驟
 *   - 沒有任何搜尋請求會離開瀏覽器 —— 跟「不追蹤」的立場一致
 *
 * 內容量真的長到幾千篇再換方案，那時候再說。
 */
import type { APIRoute } from 'astro';
import { getAllWriting, entryUrl } from '@lib/content';
import { getSyndication } from '@lib/syndication';
import { localizePath } from '@i18n/utils';
import type { Locale } from '@config/site';

interface IndexItem {
  t: string;   // title
  u: string;   // url
  /*
   * lang。**目前沒有任何東西讀它。**
   *
   * 第 3 輪（第十一圈）真的去搜了一次才量清楚：站上的列表是照語言過濾的
   * （`/poems` 3 筆、`/en/poems` **0 筆**，`/en/archive` 直接是空狀態），
   * 而搜尋不過濾 —— `/en/search` 打「李白」會拿到 2 筆中文結果。
   *
   * 兩邊沒有對齊，而這個欄位的存在說明本來是想對齊的。沒有動它，理由是：
   * 現在所有內容都是 zh-TW，真的按語言過濾的話 `/en/search` 會**永遠是空的**，
   * 對讀者更糟。哪天有了英文內容，這個欄位就是要用的東西，決定寫在那一輪的紀錄裡。
   */
  l: string;   // lang
  k: string;   // kind
  d?: string;  // description
  g?: string;  // tags, 空白分隔
  b?: string;  // body 摘要
  x?: 1;       // 外站
}

export const GET: APIRoute = async () => {
  const items: IndexItem[] = [];

  for (const { collection, entry } of await getAllWriting()) {
    const lang = entry.data.lang as Locale;
    const poem = 'poem' in entry.data ? entry.data.poem : undefined;

    items.push({
      t: poem ? `${poem.title}・${poem.author}` : entry.data.title,
      u: localizePath(entryUrl(collection, entry), lang),
      l: lang,
      k: collection,
      d: entry.data.description,
      g: entry.data.tags.join(' ') || undefined,
      // 只放前 600 字：索引檔要小，而且搜尋命中後本來就會進去讀全文
      b: [
        poem?.original,
        'plain' in entry.data ? entry.data.plain : undefined,
        entry.body,
      ]
        .filter(Boolean)
        .join(' ')
        .replace(/[#*`>_\[\]()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600),
    });
  }

  for (const item of await getSyndication()) {
    items.push({
      t: item.title,
      u: item.url,
      l: item.lang,
      k: item.platform.id,
      d: item.summary.slice(0, 200) || undefined,
      g: item.tags.join(' ') || undefined,
      x: 1,
    });
  }

  return new Response(JSON.stringify({ n: items.length, items }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};
