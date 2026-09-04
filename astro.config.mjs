// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

/**
 * bellafoxy.com
 *
 * 幾個關鍵設定的理由：
 *
 * - site 一定要正確，否則 sitemap、RSS、og:image 產出的絕對網址會是錯的。
 * - base 維持 '/'。repo 叫 fox，但因為綁自訂網域，網站是掛在網域根目錄，
 *   不是 /fox 底下。這是 GitHub Pages 最常見的踩雷點。
 * - 沒有任何分析或第三方腳本，這是刻意的（見 src/config/privacy.ts）。
 */
export default defineConfig({
  site: 'https://bellafoxy.com',
  base: '/',
  trailingSlash: 'never',
  output: 'static',

  i18n: {
    locales: ['zh-TW', 'en'],
    defaultLocale: 'zh-TW',
    routing: {
      // 預設語言不加前綴：中文是主語言，網址就該是 /poems 而不是 /zh-TW/poems
      prefixDefaultLocale: false,
    },
  },

  integrations: [
    mdx(),
    sitemap({
      i18n: {
        defaultLocale: 'zh-TW',
        locales: { 'zh-TW': 'zh-Hant-TW', en: 'en' },
      },
      // 草稿與純功能頁不需要進 sitemap
      filter: (page) => !/\/(search|404)\/?$/.test(page),
    }),
  ],

  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      wrap: true,
    },
    /*
     * 標點美化（smart punctuation）維持 Astro 預設的開啟。
     * 它只作用在 Markdown 內文，不會碰到 frontmatter —— 詩詞原文放在
     * frontmatter 的 poem.original，是逐字輸出的，不受影響。
     * 若哪天真的需要關掉：安裝 @astrojs/markdown-satteri，然後
     * processor: satteri({ features: { smartPunctuation: false } })
     */
  },

  build: {
    // 每頁一個資料夾 + index.html，配合 trailingSlash: 'never' 的乾淨網址
    format: 'directory',
    inlineStylesheets: 'auto',
  },

  image: {
    // 只允許自己站上的圖片被最佳化；不從外部網域抓圖，避免建置時被第三方牽著走
    domains: [],
    remotePatterns: [],
  },

  /*
   * Content-Security-Policy。
   *
   * 「零第三方請求」原本只是一個約定 —— 靠稽核腳本和自律。
   * 開了 CSP 之後它變成**瀏覽器強制執行**的規則：就算哪天有人不小心
   * 引進一段外部腳本，瀏覽器會直接拒絕載入，而不是安靜地送出請求。
   *
   * Astro 會自己算出所有 inline <script> 與 <style> 的 SHA-256 雜湊，
   * 所以不需要 'unsafe-inline'。靜態輸出會以 <meta http-equiv> 的形式送出
   * （GitHub Pages 沒辦法設 HTTP header）。
   *
   * 注意 meta 形式的限制：frame-ancestors、report-uri、sandbox 不生效。
   * 前者要靠 GitHub Pages 自己送的 X-Frame-Options，我們控制不了。
   */
  security: {
    csp: {
      algorithm: 'SHA-256',
      directives: [
        // 預設全部拒絕，下面逐項開白名單
        "default-src 'none'",
        // 圖片只有自家的；data: 是給內嵌的 SVG 圖示
        "img-src 'self' data:",
        // 目前完全沒有載入字型檔（全用系統字型），留 'self' 是為了以後放本地字型
        "font-src 'self'",
        // 搜尋頁要 fetch /search-index.json
        "connect-src 'self'",
        /*
         * 影片。VideoFacade 只有在使用者按下播放時才會建立這個 iframe，
         * 所以這一條不是「允許自動載入第三方」，是「允許使用者主動要求的那一次」。
         */
        "frame-src https://www.youtube-nocookie.com",
        "manifest-src 'self'",
        // 擋掉 <base> 注入與外送表單
        "base-uri 'none'",
        // 'self' 而不是 'none'：搜尋表單在沒有 JS 時會退回原生送出（帶 ?q=），
        // 那條路要留著
        "form-action 'self'",
        "object-src 'none'",
      ],

      /*
       * style 屬性要另外開。
       *
       * CSP 的雜湊機制**對 style 屬性無效**（只對 <style> 元素有效），
       * 所以設計系統裡那些「把動態值傳給 CSS 變數」的寫法會全部被擋：
       *   狐火每一點的位置、平臺標籤的品牌色、印章尺寸、標籤雲的字級。
       * 實測會噴十幾條 violation，畫面直接壞掉。
       *
       * 兩個選項：
       *   (a) 把所有動態值改成建置時產生的 class —— 要放棄「每個元素一組
       *       CSS 變數」這個很好用的模式，而且產生一堆一次性的 class
       *   (b) 只對 style **屬性**開 'unsafe-inline'，<style> **元素** 仍然鎖雜湊
       *
       * 選 (b)。真正重要的那道防線是 script-src ——
       * 它維持「只有雜湊對得上的 inline script 能跑，沒有 unsafe-inline」。
       * style 屬性能做的壞事有限（CSS 注入可以做一些側信道，但跟任意執行
       * JavaScript 不在同一個量級）。
       */
      styleDirective: {
        resources: [{ resource: "'unsafe-inline'", kind: 'attribute' }],
      },
    },
  },

  devToolbar: { enabled: false },

  vite: {
    build: {
      // 靜態站不需要 sourcemap，省 repo 空間
      sourcemap: false,
    },
  },
});
