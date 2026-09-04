/**
 * SEO / metadata 組裝。
 *
 * 有一條原則貫穿整個檔案：**meta 標籤不能洩漏 privacy.ts 擋下來的東西**。
 * 很多網站前台藏得好好的，結果 og:description 或 JSON-LD 把本名吐出去。
 * 所以這裡的作者一律用筆名。
 */
import { site, DEFAULT_LOCALE, LOCALE_HREFLANG, type Locale } from '@config/site';
import { privacy } from '@config/privacy';
import { pick } from '@i18n/utils';

export interface SeoInput {
  title?: string;
  description?: string;
  locale: Locale;
  pathname: string;
  /** 'website' 給列表頁，'article' 給單篇 */
  type?: 'website' | 'article';
  image?: string;
  publishedAt?: Date;
  updatedAt?: Date;
  tags?: string[];
  /** 這篇的正本在別的平台時填 */
  canonicalOverride?: string;
  noindex?: boolean;
}

export interface SeoOutput {
  title: string;
  description: string;
  canonical: string;
  ogImage: string;
  robots: string;
  siteName: string;
  htmlLang: string;
  type: 'website' | 'article';
  publishedAt?: string;
  updatedAt?: string;
  tags: string[];
}

export function buildSeo(input: SeoInput): SeoOutput {
  const siteName = pick(site.name, input.locale) ?? site.name[DEFAULT_LOCALE];
  const baseDescription = pick(site.description, input.locale) ?? '';

  const title = input.title ? `${input.title} — ${siteName}` : siteName;

  // 去掉結尾斜線讓 canonical 一致；根目錄 replace 完會變空字串，退回 site.url
  const canonical =
    input.canonicalOverride ??
    (new URL(input.pathname, site.url).toString().replace(/\/$/, '') || site.url);

  const robotsParts: string[] = [];
  if (input.noindex || privacy.indexing === 'noindex') {
    robotsParts.push('noindex', 'nofollow');
  } else {
    robotsParts.push('index', 'follow');
    // 不要讓搜尋結果直接展開整段內容 —— 想讀請進來讀
    robotsParts.push('max-snippet:180', 'max-image-preview:large');
  }

  return {
    title,
    description: (input.description || baseDescription).slice(0, 200),
    canonical,
    ogImage: new URL(input.image ?? site.ogImage, site.url).toString(),
    robots: robotsParts.join(', '),
    siteName,
    htmlLang: LOCALE_HREFLANG[input.locale],
    type: input.type ?? 'website',
    publishedAt: input.publishedAt?.toISOString(),
    updatedAt: input.updatedAt?.toISOString(),
    tags: input.tags ?? [],
  };
}

/**
 * JSON-LD 結構化資料。
 * 作者永遠是筆名 —— 就算 privacy.showRealName 打開，結構化資料也不放本名，
 * 因為這是被 Google 直接抓進知識圖譜的欄位，一旦進去就很難撤回。
 */
export function buildJsonLd(seo: SeoOutput, locale: Locale) {
  const penName = pick(site.penName, locale) ?? site.penName[DEFAULT_LOCALE];

  const author = {
    '@type': 'Person',
    name: penName,
    url: site.url,
  };

  if (seo.type === 'article') {
    return {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: seo.title,
      description: seo.description,
      inLanguage: seo.htmlLang,
      datePublished: seo.publishedAt,
      dateModified: seo.updatedAt ?? seo.publishedAt,
      author,
      publisher: { '@type': 'Organization', name: seo.siteName, url: site.url },
      mainEntityOfPage: seo.canonical,
      keywords: seo.tags.length ? seo.tags.join(', ') : undefined,
    };
  }

  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: seo.siteName,
    description: seo.description,
    url: site.url,
    inLanguage: seo.htmlLang,
    author,
  };
}
