/**
 * 語言路由。
 *
 * 全站的頁面都放在 src/pages/[...locale]/ 底下，靠這裡的 localePaths()
 * 一次產生三個語言版本：
 *
 *   { locale: undefined } → /poems      （zh-TW，預設語言不加前綴）
 *   { locale: 'en' }      → /en/poems
 *
 * 這樣每個頁面只要寫一次。以前常見的做法是 pages/ 底下複製三份，
 * 改一個地方要改三次，久了一定會漏。
 */
import { LOCALES, LOCALE_PATH, DEFAULT_LOCALE, type Locale } from '@config/site';

export interface LocalePathEntry {
  params: { locale: string | undefined };
  props: { locale: Locale };
}

/** 給 getStaticPaths 用 */
export function localePaths(): LocalePathEntry[] {
  return LOCALES.map((locale) => ({
    params: { locale: LOCALE_PATH[locale] || undefined },
    props: { locale },
  }));
}

/**
 * 把 localePaths() 跟另一組參數做笛卡兒積，給有 [slug] 的頁面用。
 *
 * @example
 * export const getStaticPaths = async () => {
 *   const poems = await getEntries('poems');
 *   return crossLocalePaths(poems, (p) => ({
 *     params: { slug: p.id },
 *     props: { entry: p },
 *   }));
 * };
 */
export function crossLocalePaths<T, P extends Record<string, unknown>>(
  items: T[],
  map: (item: T, locale: Locale) => { params: Record<string, string | undefined>; props: P },
) {
  return localePaths().flatMap(({ params: localeParams, props: localeProps }) =>
    items.map((item) => {
      const { params, props } = map(item, localeProps.locale);
      return {
        params: { ...localeParams, ...params },
        props: { ...localeProps, ...props },
      };
    }),
  );
}

export { DEFAULT_LOCALE, type Locale };

/**
 * 單篇內容的路由。
 *
 * 跟列表頁不同：一篇英文文章只會出現在 /en/writing/… 底下，不會在
 * 中文路徑下也生一份。同一篇的不同語言版本靠 translationKey 互相連結，
 * 而不是靠網址對稱。
 */
export function entryPaths<T extends { id: string; data: { lang: Locale } }>(
  entries: T[],
): Array<{ params: { locale: string | undefined; slug: string }; props: { entry: T; locale: Locale } }> {
  return entries.map((entry) => ({
    params: {
      locale: LOCALE_PATH[entry.data.lang] || undefined,
      slug: entry.id,
    },
    props: { entry, locale: entry.data.lang },
  }));
}
