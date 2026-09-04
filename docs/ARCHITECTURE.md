# 架構

這份文件記的是**為什麼這樣做**，不是**做了什麼**。
「做了什麼」看程式碼比較快；「為什麼」如果不寫下來，半年後就沒人記得了。

---

## 一句話版本

一個純靜態網站，內容分成「自己寫的」和「別的平臺抓來的」兩條線，
在建置時合併成同一條時間軸。沒有後端，沒有資料庫，沒有追蹤。

---

## 三個核心決定

### 1. 為什麼是 Astro，不是 Next.js / Hugo / 手寫 HTML

需求裡有幾件事同時成立：內容為主、多語言、要能聚合外部平臺、
要能長期低成本維護、要放在 GitHub Pages（純靜態）。

- **手寫 HTML** — 三種語言 × 四種內容類型，很快就會變成複製貼上地獄
- **Hugo** — 夠快，但 Go template 寫複雜邏輯很痛苦，聚合層會難寫
- **Next.js** — 能做，但為了一個靜態網站扛整個 React 執行期不划算，
  而且預設會送一堆 JavaScript 到瀏覽器
- **Astro** — 預設送出 0 KB JavaScript、內建 content collections（有型別的
  內容結構）、內建 i18n 路由、官方支援 GitHub Pages

決定性的因素是 **0 KB JavaScript**。這個站是拿來讀字的，不該讓讀者的
瀏覽器先跑一套框架才看得到第一行詩。

目前全站的 JavaScript 只有四小段：主題切換、語言下拉、詩詞直橫排切換、
站內搜尋。每一段都是「沒有它也能用」的增強功能。

### 2. 為什麼外部文章在建置時抓，不是瀏覽時抓

如果在瀏覽器端 fetch Medium 或 YouTube，等於**每一個訪客的 IP 都會被
送到那些平臺**。一個宣稱不追蹤的網站這樣做是自打嘴巴。

而且 GitHub Pages 沒有後端，也沒地方藏 API 金鑰。

所以：GitHub Actions 定時跑 `scripts/sync-feeds.mjs`，抓回來的結果
存成 `src/data/syndication.json` 並 commit 進 repo。網站建置時讀那份 JSON。

把資料 commit 進 repo 有兩個額外好處：

- **平臺掛掉、改版、帳號被停用，網站照樣 build，歷史文章也不會消失。**
  RSS 通常只吐最近 10–20 篇；如果每次都直接覆蓋，舊的會被慢慢洗掉。
  所以同步是「合併」而不是「取代」。
- **可以看 git diff。** 哪天某個平臺開始亂改標題，一眼就看得到。

代價是 repo 會慢慢變大。但這是純文字，一年幾百 KB，可以接受。

### 3. 為什麼個資和開關要分開

`EugeneYip/fox` 是**公開** repo。

一開始的寫法是把本名、校名放在 `privacy.ts` 裡，用開關控制要不要顯示。
這是錯的 —— 就算開關關著、網站上一個字都不顯示，任何人到 GitHub 上
都讀得到那個檔案。閘門等於沒關。

現在的做法：

```
src/config/privacy.ts          只有開關（會被 commit）
src/config/identity.local.ts   只有值（在 .gitignore，不會被 commit）
```

`reveal()` 是唯一的取值入口，兩道關卡都要過才會回傳東西：
開關要開，而且本機檔案裡要真的有值。

檔案不存在時用 `import.meta.glob` 靜默略過（直接 `import` 會讓建置失敗），
所以 CI 上沒有那個檔案也能正常 build。

`scripts/audit-privacy.mjs` 負責抓「繞過閘門的人」，包括最重要的一項：
**檢查個資檔有沒有不小心被 git 追蹤**。CI 每次都跑。

---

## 目錄

```
src/
├── config/          設定。改網站行為基本上只要動這裡
│   ├── site.ts              站名、網址、語言、導覽列
│   ├── privacy.ts           隱私開關（沒有值）
│   ├── identity.local.ts    個資的值（gitignored，可有可無）
│   ├── platforms.data.mjs   平臺目錄（純資料，前端與腳本共用）
│   ├── platforms.ts         平臺目錄的 TypeScript 型別層
│   └── sources.mjs          「狐狸在哪些平臺有帳號」
│
├── content.config.ts   內容的結構定義（Zod schema）
├── content/            內容本體（Markdown）
├── data/               同步快取（機器產生，不要手改）
│
├── lib/             資料存取層。頁面不直接呼叫 getCollection
│   ├── content.ts           站內內容
│   ├── syndication.ts       外站內容（自動 + 手動合併）
│   ├── seo.ts               metadata 組裝
│   └── dates.ts             日期與閱讀時間
│
├── i18n/            多語言
│   ├── ui.ts                介面文案
│   ├── utils.ts             取字串、算網址
│   └── paths.ts             getStaticPaths 的語言路由
│
├── components/
│   ├── fox/         狐狸的視覺符號（標記、印章、狐火）
│   ├── layout/      頁首、頁尾、切換器
│   ├── ui/          通用元件
│   └── content/     內容專用（詩詞、影片、聚合列表）
│
├── layouts/         版型
├── pages/           路由
└── styles/          設計語彙
```

### 為什麼 `platforms` 拆成 `.data.mjs` + `.ts`

`scripts/sync-feeds.mjs` 要在**沒有任何編譯步驟**的純 Node 環境下讀平臺目錄。
Node 不能直接 import TypeScript（22.15 需要實驗性 flag，CI 上不可靠）。

選項是：(a) 前端和腳本各記一份 → 一定會不同步；(b) 加編譯步驟 → 多一層麻煩；
(c) 資料放 `.mjs`，型別放 `.ts` 薄包裝 → 一份資料，兩邊都有型別。

選了 (c)。

---

## 路由

全站的頁面都在 `src/pages/[...locale]/` 底下。
`localePaths()` 一次產生所有語言版本：

```
{ locale: undefined } → /poems       （zh-TW，預設語言不加前綴）
{ locale: 'en' }      → /en/poems
```

每個頁面只寫一次。常見的替代做法是 `pages/` 底下每個語言複製一份，
改一個地方要改好幾次，久了一定會漏掉。

目前只有中文與英文。要加語言的話，在 `src/config/site.ts` 的 `LOCALES`
多一個代碼，補齊 `LOCALE_PATH` / `LOCALE_LABEL` / `LOCALE_HREFLANG`，
其餘會自動跟上 —— 缺的文案會退回中文，不會壞掉。

**單篇文章是例外**：一篇英文文章只出現在 `/en/writing/…`，
不會在中文路徑下也生一份。同一篇的不同語言版本靠 frontmatter 的
`translationKey` 互相連結，而不是靠網址對稱。

`404.astro` 刻意放在 `src/pages/` 根目錄 —— GitHub Pages 只認
根目錄的 `/404.html`。

### 分頁的網址形狀

列表頁一頁 30 筆，第二頁以後是 `/poems/page/2`，而不是 Astro 內建
`paginate()` 產生的 `/poems/2`。

多這一層 `page/` 是必要的：單篇詩詞住在 `/poems/{slug}`，
如果分頁用 `/poems/2`，一首 slug 剛好叫「2」的詩就會跟第二頁撞在一起。
第一頁維持在乾淨的 `/poems`，所以之後就算再調整每頁筆數，
既有的連結也不會失效。

第二頁以後標 `noindex` —— 那些頁面只是同一批文章的另一段，
被搜尋引擎單獨收錄沒有意義，還會稀釋第一頁。

---

## 聚合層

```
                    src/config/sources.mjs
                     （狐狸在哪些平臺）
                              │
                              ▼
                  scripts/sync-feeds.mjs
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
      rss 策略             api 策略            bridge 策略
   （直接抓 feed）      （YouTube API）      （RSSHub 轉）
          │                   │                   │
          └───────────────────┼───────────────────┘
                              ▼
                  正規化 → 與舊快取合併 → 去重
                              │
                              ▼
                 src/data/syndication.json（commit）
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
      src/lib/syndication.ts        content collection "external"
       （自動抓來的）                    （手動登錄的）
              └───────────────┬───────────────┘
                              ▼
                        合併時間軸
                （同一個網址以手動的為準）
```

四種取得策略對應四種現實：

| 策略 | 什麼時候用 |
|---|---|
| `rss` | 平臺有公開 feed。最理想，14 個平臺屬於這類 |
| `hybrid` | 只有 YouTube。有公開 RSS（免金鑰），但端點會間歇性掛掉，所以備一條 Data API v3 的路 |
| `bridge` | 官方沒有 RSS，靠 RSSHub 轉。會壞，所以設計成壞了也不擋建置 |
| `manual` | 完全抓不到（Instagram、微信公眾號、Behance）。人手寫，但可以附上「為什麼挑這篇」 |

**手動登錄的價值不是備案，是升級。** 機器只能搬標題和摘要；
人可以寫一句「這則討論串下面有人補了很好的反駁」。所以合併時
同一個網址以手動的為準。

### 失敗處理

任何一個來源抓失敗：沿用上一次的快取、記一筆狀態、繼續跑下一個。
狀態顯示在網站的 `/colophon` 頁面 —— 網站自己知道自己壞在哪裡，
比等人發現好。

只有 `--strict` 才會讓流程失敗。GitHub Actions 刻意不加這個 flag：
某個平臺掛掉不該讓整條 pipeline 變紅燈。

---

## 設計

顏色取自兩個地方：宣紙與墨的溫度，以及狐狸的毛色。
刻意避開一般個人網站的冷灰藍 —— 這個站應該像一本書，不像一個 dashboard。

深色不是把淺色反轉，是另外調的一套。直接反轉會讓暖色變髒。

**字型全部用系統既有的。** 沒有 Google Fonts，沒有任何 CDN。
代價是不同裝置上長得不完全一樣；換來的是訪客的瀏覽器不會因為讀這個
網站而向第三方發出任何請求。對一個以文字為主的站，這個交換划算。

### 直排

詩詞預設直排（`writing-mode: vertical-rl`）。中文詩詞本來就是直著寫、
右起左行的，直排讀起來節奏對、斷句自然。

直排有兩個容易寫錯的地方，都踩過：

1. **軸向會反過來。** `inline-size` 變成「一行的長度（高度）」，
   `block-size` 變成「整體寬度」。所以限制的是 `max-inline-size`。
2. **flex 方向也跟著反。** 詩節之間要用 `flex-direction: column`
   才會由右往左排；用 `row` 的話詩節會往下疊，整首詩就散掉了。
   剛好這一行在橫排模式下也是對的，所以不用寫兩套。

48rem 以下自動切回橫排 —— 手機直排要側著頭看，不合理。

---

## 隱私

不是加上去的功能，是一開始就內建的限制。

| 做法 | 為什麼 |
|---|---|
| 零第三方請求 | 沒有分析、沒有字型 CDN、沒有外部圖片 |
| 影片按了才載入 | 一個 YouTube iframe 在頁面載入當下就會把訪客 IP 送給 Google |
| 外連加 `noreferrer` | 對方網站不會知道訪客是從哪裡點過去的 |
| 洗掉追蹤參數 | 同步回來的網址會被去掉 `utm_*`、`fbclid` 之類 |
| 圖片清 EXIF | 手機照片帶 GPS 座標 |
| robots 擋 AI 爬蟲 | 可設定，預設擋 |
| 個資與開關分離 | repo 是公開的 |

`localStorage` 只存兩個值（主題偏好、詩詞排版偏好），都不離開瀏覽器。

---

## 刻意沒做的事

| 沒做 | 為什麼 |
|---|---|
| 留言系統 | 都需要第三方服務或後端。要互動的話，各平臺本來就有 |
| 電子報訂閱 | 需要後端和第三方服務，而且要處理訂閱者的個資 |
| 全文搜尋引擎（Pagefind 等） | 幾百篇的規模用一份 JSON 就夠。真的長到幾千篇再換 |
| CMS 後台 | Markdown 檔案就是 CMS。少一層東西壞掉 |
| 圖片 CDN | Astro 內建的圖片最佳化夠用，而且不用把圖交給第三方 |

這些不是「以後再說」，是**現在不需要**。哪天真的需要了再加，
架構上沒有卡住任何一條路。
