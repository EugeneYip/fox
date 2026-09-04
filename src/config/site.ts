/**
 * 站台設定 —— 文案、網址、語言、導覽列的單一真相來源。
 * 想改站名、加語言、動選單，只改這一個檔案。
 */

/*
 * 這個站只有中文與英文。
 * 日文曾在早期規劃裡，後來確認不需要 —— 加語言只要在這裡多一個代碼，
 * 再把 LOCALE_PATH / LOCALE_LABEL / LOCALE_HREFLANG 補齊即可，其餘會自動跟上。
 */
export const LOCALES = ['zh-TW', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-TW';

/** URL 路徑用的短碼：zh-TW 是預設語言，不加前綴 */
export const LOCALE_PATH: Record<Locale, string> = {
  'zh-TW': '',
  en: 'en',
};

export const LOCALE_LABEL: Record<Locale, string> = {
  'zh-TW': '繁體中文',
  en: 'English',
};

/** <html lang> 與 hreflang 用的 BCP-47 標籤 */
export const LOCALE_HREFLANG: Record<Locale, string> = {
  'zh-TW': 'zh-Hant-TW',
  en: 'en',
};

type L10n = Record<Locale, string>;

export const site = {
  /** 正式網址，結尾不加斜線 */
  url: 'https://bellafoxy.com',

  /** 站名（筆名，不是本名 —— 本名受 privacy.ts 管控） */
  name: {
    'zh-TW': '狐說八道',
    en: 'Fox Says',
  } satisfies L10n,

  /** 一句話定位 */
  tagline: {
    'zh-TW': '一隻狐狸，說古人的話',
    en: 'A fox, retelling the old poems',
  } satisfies L10n,

  description: {
    'zh-TW':
      '朗誦經典詩詞曲，用今天的話說出其中的意思。日常的閱讀、書寫與翻譯，都收在這裡。',
    en: 'Reciting classical Chinese poetry and retelling it in plain language. Reading notes, writing, and translations, all kept in one place.',
  } satisfies L10n,

  /** 筆名 —— 任何情況下都能安全顯示 */
  penName: {
    'zh-TW': '狐狸',
    en: 'Fox',
  } satisfies L10n,

  /** 首頁 hero 引用的詩句 */
  epigraph: {
    text: '青青子衿，悠悠我心',
    source: '《詩經・鄭風・子衿》',
    /*
     * ⚠ `zh-TW` 這一半**永遠不會出現在畫面上**。
     *
     * `index.astro` 的條件是 `locale !== 'zh-TW' && <span class="hero__gloss">`，
     * 也就是只有英文首頁會畫這句白話。中文那一句留著是因為 `satisfies L10n`
     * 要求兩種語言都有 —— 型別上必要，畫面上到不了。
     *
     * 第 6 輪（第十二圈）順帶記下一個**設計上的問題**（沒有動它，那是站主的決定）：
     * 站上每一首詩都配白話，而 `site.webmanifest` 的描述也寫著
     * 「用今天的話說出其中的意思」—— 但首頁這句題詞的白話**只有英文讀者看得到**。
     * 對讀不懂〈子衿〉的中文讀者來說，那正好是反過來的。
     */
    gloss: {
      'zh-TW': '你衣領青青，我心裡念念不忘。',
      en: 'Blue, blue your collar; long, long my heart.',
    } satisfies L10n,
  },

  /** 建站年份，用於頁尾版權 */
  since: 2026,

  /** 預設社群分享圖 */
  ogImage: '/og/default.png',

  /*
   * 主題色 —— 手機網址列、PWA 啟動畫面、Safari 分頁列的底色。
   *
   * **必須跟 tokens.css 的 `--c-bg` 一模一樣。** 它畫的是頁面外框，
   * 對不上就會在內容上緣出現一條看得見的接縫。
   *
   * 第 8 輪（第二十四圈）量到過一次：這裡寫 #F7F2E8／#12110F，
   * 而 `--c-bg` 是 #faf6ee／#14120f —— 淺色差 3/4/6 個階，
   * 兩塊色之間的對比是 1:1.035。同一個顏色寫在兩個檔案裡，
   * 而 `check:contrast` 只讀 tokens.css，看不到這一份。
   * 現在 `check:contrast` 會比對兩邊。
   */
  themeColor: { light: '#faf6ee', dark: '#14120f' },
} as const;

export interface NavItem {
  href: string;
  label: L10n;
  /** 次要項目在手機版會收進「更多」 */
  secondary?: boolean;
}

export const nav: NavItem[] = [
  { href: '/poems', label: { 'zh-TW': '詩詞', en: 'Poems' } },
  { href: '/writing', label: { 'zh-TW': '文章', en: 'Writing' } },
  { href: '/notes', label: { 'zh-TW': '短札', en: 'Notes' } },
  { href: '/elsewhere', label: { 'zh-TW': '各處', en: 'Elsewhere' } },
  { href: '/about', label: { 'zh-TW': '關於', en: 'About' } },
];

export const footerNav: NavItem[] = [
  { href: '/archive', label: { 'zh-TW': '彙整', en: 'Archive' }, secondary: true },
  { href: '/tags', label: { 'zh-TW': '標籤', en: 'Tags' }, secondary: true },
  { href: '/search', label: { 'zh-TW': '搜尋', en: 'Search' }, secondary: true },
  { href: '/rss.xml', label: { 'zh-TW': 'RSS', en: 'RSS' }, secondary: true },
  { href: '/colophon', label: { 'zh-TW': '關於本站', en: 'Colophon' }, secondary: true },
  { href: '/privacy', label: { 'zh-TW': '隱私', en: 'Privacy' }, secondary: true },
];
