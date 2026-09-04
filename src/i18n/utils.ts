/**
 * i18n 工具 —— 取字串、算網址、判斷目前語言。
 *
 * 兩個刻意的設計：
 * 1. 缺翻譯時退回 zh-TW，而不是顯示 key 或空白。翻一半的網站還是能用。
 * 2. 網址一律由 localizePath() 產生，不手寫。加語言時不用回頭改連結。
 */
import { DEFAULT_LOCALE, LOCALES, LOCALE_PATH, type Locale } from '@config/site';
import { ui, type UiKey } from './ui';

/** 從網址路徑判斷語言，判斷不出來就回預設語言 */
export function localeFromPath(pathname: string): Locale {
  const seg = pathname.split('/').filter(Boolean)[0];
  const hit = LOCALES.find((l) => l !== DEFAULT_LOCALE && LOCALE_PATH[l] === seg);
  return hit ?? DEFAULT_LOCALE;
}

/**
 * 產生某個語言版本的路徑。
 * 預設語言不加前綴（/poems），其他語言加（/en/poems）。
 */
export function localizePath(path: string, locale: Locale = DEFAULT_LOCALE): string {
  const clean = '/' + path.replace(/^\/+|\/+$/g, '');
  const prefix = LOCALE_PATH[locale];
  if (!prefix) return clean === '/' ? '/' : clean;
  return clean === '/' ? `/${prefix}` : `/${prefix}${clean}`;
}

/** 把目前路徑換成另一個語言的對應路徑（語言切換器用） */
export function switchLocalePath(pathname: string, target: Locale): string {
  const current = localeFromPath(pathname);
  const currentPrefix = LOCALE_PATH[current];
  const bare = currentPrefix
    ? pathname.replace(new RegExp(`^/${currentPrefix}(?=/|$)`), '') || '/'
    : pathname;
  return localizePath(bare, target);
}

/**
 * 取 UI 文案。回傳一個綁定語言的函式，元件裡用起來比較短。
 *
 * @example
 * const t = useTranslations(locale);
 * t('nav.menu')                        // → '選單'
 * t('list.count', { n: 12 })           // → '共 12 篇'
 */
export function useTranslations(locale: Locale) {
  return function t(key: UiKey, vars?: Record<string, string | number>): string {
    /*
     * 英文有單複數，中文沒有。所以帶 n 的文案可以另外定義一個 `key_one`，
     * n 剛好是 1 的時候用它。沒有定義 _one 的話就照常用主鍵 ——
     * 中文只要寫一份，英文才需要寫兩份。
     *
     * 沒有這個機制的話，「1 entries」這種東西會一直冒出來。
     */
    const table = ui as Record<string, Record<string, string | undefined> | undefined>;
    const singular = vars?.n === 1 ? table[`${key}_one`] : undefined;
    const entry = (singular ?? table[key]) ?? {};
    let value = entry[locale] ?? entry[DEFAULT_LOCALE] ?? String(key);
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        value = value.replaceAll(`{${k}}`, String(v));
      }
    }
    return value;
  };
}

/** 取多語欄位的值，缺的話退回 zh-TW */
export function pick<T>(
  field: Partial<Record<Locale, T>> | undefined,
  locale: Locale,
): T | undefined {
  if (!field) return undefined;
  return field[locale] ?? field[DEFAULT_LOCALE];
}

/** 給 <head> 用的 hreflang 替代連結清單 */
export function alternateLinks(pathname: string, siteUrl: string) {
  return LOCALES.map((locale) => ({
    locale,
    href: new URL(switchLocalePath(pathname, locale), siteUrl).toString(),
  }));
}

/** 依語言選日期格式 */
export function localeTag(locale: Locale): string {
  return { 'zh-TW': 'zh-TW', en: 'en-US' }[locale];
}
