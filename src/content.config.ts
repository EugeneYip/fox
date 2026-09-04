/**
 * 內容結構定義 —— 網站上所有「東西」的形狀。
 *
 * 四種內容，刻意分開而不是全塞進一個 blog：
 *
 *   poems     詩詞。有原文、注、白話、朗讀連結 —— 這是「狐說八道」的本體，
 *             結構跟一般文章完全不同，硬塞在一起會兩邊都難用。
 *   posts     長文。讀書筆記、隨筆、翻譯。
 *   notes     短札。一兩段的想法，不值得開一篇文章，但值得留下來。
 *   external  外站文章的手動登錄。給抓不到 RSS 的平台（Instagram、微信公眾號、
 *             Behance）用；自動抓得到的走 src/data/syndication.json。
 *             Threads 是 bridge 不是 manual —— 它有 RSSHub 路由，
 *             只是沒設 RSSHUB_BASE 的時候抓不到，那時也走這裡。
 *
 * 多語言用 translationKey 串起來：同一篇文章的中／英／日版本填一樣的
 * translationKey，頁面就能自動互相連結。不需要平行的資料夾結構。
 */
import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const LOCALE = z.enum(['zh-TW', 'en']).default('zh-TW');

/** 每種內容都有的欄位 */
/*
 * 錯誤訊息用中文寫，而且直接說「要寫成什麼樣子」。
 *
 * 第 3 輪（第十二圈）把七種常見的寫錯各建了一次，看站主會看到什麼。
 * 預設訊息長這樣：`publishedAt: Expected type "date", received "object"` ——
 * 對一個把日期寫成「昨天」的人來說是天書。更糟的是**欄位名打錯**
 * （`pubishedAt`）產生的訊息一模一樣，於是它指著一個她根本沒寫的欄位。
 *
 * 所以下面這些 `error` 都在做同一件事：說出**該寫成什麼**，
 * 而不是說出型別對不上。
 */
const base = z.object({
  title: z.string({ error: '每一篇都要有 title（標題）。' }).min(1, 'title 不能是空的。'),
  /** 列表與 <meta description> 用的短描述 */
  description: z.string().max(300).optional(),
  lang: LOCALE,
  publishedAt: z.coerce.date({
    error:
      'publishedAt 要寫成日期，像 2026-09-03（年-月-日）。' +
      '如果你覺得有寫，檢查一下欄位名有沒有打錯 —— 打錯的話這裡看起來會跟「沒寫」一樣。',
  }),
  /*
   * 改過的日期。
   *
   * **它只會變成 `<meta property="article:modified_time">`，畫面上看不到。**
   * 第 6 輪（第二十圈）第一次填它才發現這件事：日期那一行仍然只有發表日，
   * 沒有任何一個字提到更新過。要不要在畫面上也顯示是版面的取捨，還沒決定 ——
   * 在那之前，填它只影響搜尋引擎與社群卡片。
   */
  updatedAt: z.coerce.date().optional(),
  /** true 的話只在 dev 看得到，不會被 build 出去 */
  draft: z.boolean({ error: 'draft 只能寫 true 或 false（不是「是」「否」，也不要加引號）。' }).default(false),
  /*
   * 解析時就正規化：去掉前後空白、丟掉空字串、去重。
   * 大小寫**保留**（顯示時要照原樣），但網址會走 tagSlug() 統一成小寫 ——
   * 否則 `Poetry` 與 `poetry` 會產生兩個內容一模一樣的頁面。
   * 這在 macOS 上還看不出來（檔案系統不分大小寫，兩個目錄會塌成一個），
   * 但部署到 Linux 就會變成兩份重複內容。
   */
  tags: z
    .array(z.string(), { error: 'tags 要寫成清單，像 [唐詩, 李白]，或每行一個前面加 `- `。' })
    .default([])
    .transform((tags) => [...new Set(tags.map((t) => t.trim()).filter(Boolean))]),
  /** 置頂到列表最前面 */
  featured: z.boolean({ error: 'featured 只能寫 true 或 false。' }).default(false),
  /** 同一篇文章的不同語言版本填同一個 key，頁面會自動互連 */
  translationKey: z.string().optional(),
});

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.{md,mdx}' }),
  schema: ({ image }) =>
    base.extend({
      cover: image().optional(),
      /** 留空代表這張圖是裝飾用的，螢幕閱讀器會跳過 */
      coverAlt: z.string().optional(),
      /** 屬於哪個系列，例如「唐詩三百首慢讀」 */
      series: z.string().optional(),
      /** 同一個系列裡的順序。沒填的排在最後，並依日期排 */
      seriesOrder: z.number().int().optional(),
      /**
       * 如果這篇先發在別的平台，填那邊的網址。
       * 會輸出 rel="canonical"，讓搜尋引擎知道哪邊是正本，避免被判重複內容。
       */
      canonicalUrl: z.url().optional(),
      /** 這篇同時也發在哪些平台（顯示「也在這些地方讀得到」） */
      alsoOn: z
        .array(z.object({ platform: z.string(), url: z.url() }))
        .default([]),
    }),
});

const poems = defineCollection({
  loader: glob({ base: './src/content/poems', pattern: '**/*.{md,mdx}' }),
  schema: ({ image }) =>
    base.extend({
      /** 詩本身的資料，跟「這篇貼文」的資料分開 */
      poem: z.object({
        /**
         * 詩題，**不含書名號** —— 寫 `靜夜思`，不要寫〈靜夜思〉。
         *
         * 多數地方會自己補上〈〉，自己再加一層就會變成〈〈靜夜思〉〉。
         * 第 3 輪（第十圈）實測過：這樣寫，四道檢查沒有一個會說話，
         * 而產出裡有 8 處是雙層的。
         * （這一行的註解本來寫著「例如〈靜夜思〉」，就是那個坑的來源。）
         *
         * **「多數」不是「全部」。** 第 3 輪（第十四圈）逐一數過，
         * 程式裡有 14 個地方會印 `poem.title`：
         *
         *   補〈〉的 9 處　　詩頁大標、RSS 兩份、彙整頁、相關詩、上下篇、
         *                    朗讀卡、meta description、`poem.region` 的字串本身
         *   不補的 5 處　　　頁面 `<title>` 與搜尋索引（那兩個用的是
         *                    「詩名・作者」這種 entry title 的形狀，合理）、
         *                    關掉的 iframe 那條路、**以及 `EntryCard`**
         *
         * `EntryCard` 是列表卡片，也就是首頁、`/poems`、`/notes`、標籤頁上
         * 看到的那個 —— 它印的是**沒有書名號**的詩名。所以同一個站上
         * `/archive` 顯示〈靜夜思〉、`/poems` 顯示靜夜思，首頁上更明顯：
         * 自己的詩名沒有書名號，旁邊 YouTube 影片的標題卻有（那是她自己打的）。
         *
         * 底下那條 `poem-title-bracketed` 規則守的是**作者這一側**
         * （不要自己寫），而畫面那一側沒有任何東西在守 —— 這是第十四圈
         * 反覆看到的形狀：同一個約定有兩個地方在遵守，而只有一邊被檢查。
         * 要不要讓 `EntryCard` 也補上，是版面與語氣的取捨，留給站主。
         *
         * 底下的 `source` 相反：那個要自己寫《…》，程式不補。
         */
        title: z.string(),
        author: z.string(),
        /** 唐、宋、元… */
        dynasty: z.string().optional(),
        /** 五言絕句、七律、小令… */
        form: z.string().optional(),
        /** 出處，例如《全唐詩・卷一六五》 */
        source: z.string().optional(),
        /** 原文。換行就是斷句，前端會依此排版 */
        original: z
          .string({ error: '每首詩都要有 poem.original（原文）。用 `original: |` 之後每句一行。' })
          .min(1, 'poem.original 不能是空的。'),
      }),
      /** 白話翻譯 */
      plain: z.string().optional(),
      /** 逐詞注解 */
      annotations: z
        .array(z.object({ term: z.string(), gloss: z.string() }))
        .default([]),
      /** 朗讀影片（YouTube 網址）。不會直接嵌入，會用點擊才載入的預覽卡 */
      videoUrl: z.url({ error: 'videoUrl 要是完整網址，像 https://www.youtube.com/watch?v=…' }).optional(),
      /** 預設直排 —— 詩詞直排比較好看，也比較接近原本的閱讀方式 */
      vertical: z.boolean().default(true),
      cover: image().optional(),
      /** 留空代表這張圖是裝飾用的，螢幕閱讀器會跳過 */
      coverAlt: z.string().optional(),
      /** 相關的詩，例如同一組唱和 */
      related: z.array(reference('poems')).default([]),
    }),
});

const notes = defineCollection({
  loader: glob({ base: './src/content/notes', pattern: '**/*.{md,mdx}' }),
  schema: base.extend({
    /** 短札如果是因為讀到某個東西而寫的，記下來源 */
    inResponseTo: z.object({ title: z.string(), url: z.url() }).optional(),
  }),
});

const external = defineCollection({
  loader: glob({ base: './src/content/external', pattern: '**/*.{md,mdx}' }),
  schema: base.extend({
    /** 必須對應 src/config/platforms.data.mjs 裡的 id */
    platform: z.string(),
    url: z.url(),
    /** 這個平台的貼文沒有標題時（Threads、IG），用開頭幾句當摘要 */
    excerpt: z.string().optional(),
    /** 為什麼把這篇挑出來放在站上 —— 手動登錄的價值就在這句話 */
    why: z.string().optional(),
  }),
});

export const collections = { posts, poems, notes, external };
