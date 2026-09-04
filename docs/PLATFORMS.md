# 平臺對照表

> 這份文件是產生的，不要手改。
> 改 `src/config/platforms.data.mjs`，然後執行 `node scripts/gen-platform-docs.mjs`。
>
> 內容最後變動：2026-09-03　共 24 個平臺

## 取得方式一覽

| 方式 | 數量 | 意思 |
|---|---|---|
| ✅ 官方 RSS | 14 | 有公開的 feed，直接抓，最理想 |
| ✅ 官方 RSS（+ API 備援） | 1 | 有公開 feed，但端點會間歇性掛掉，另備一條 API |
| 🔑 官方 API | 0 | 只能打官方 API，要金鑰 |
| 🔀 需橋接 | 6 | 官方沒有 RSS，靠 RSSHub 轉，可能不穩 |
| ✍️ 手動 | 3 | 抓不到，只能在 `src/content/external/` 手動登錄 |

「已實測」= 用一個公開的知名帳號實際打過，確認回來的是解析得動的 feed
（那個帳號記在 `probeHandle`，只用於驗證，不會出現在網站上，也不會被同步）。
隨時可以用 `npm run verify -- --patterns` 重驗，抓平臺改版或下架。
「依文件」= 平臺文件或長期慣例，但這次沒實測。
「需自行查」= 網址含內部 ID，無法由帳號名推導，要到個人頁面複製 RSS 連結。

## 全部平臺

| id | 名稱 | 地區 | 類型 | 取得方式 | handle 填什麼 | 可信度 | 本站狀態 |
|---|---|---|---|---|---|---|---|
| `medium` | Medium | 美國 | 文章 | ✅ 官方 RSS | 帳號名 | 已實測 | — |
| `substack` | Substack | 美國 | 文章 | ✅ 官方 RSS | 帳號名 | 已實測 | — |
| `note` | note（日本） | 日本 | 文章 | ✅ 官方 RSS | 帳號名 | 已實測 | — |
| `hatena` | はてなブログ | 日本 | 文章 | ✅ 官方 RSS | 帳號名 | 已實測 | — |
| `pixnet` | 痞客邦 | 臺灣 | 文章 | ✅ 官方 RSS | 帳號名 | 需自行查 | — |
| `blogger` | Blogger | 國際 | 文章 | ✅ 官方 RSS | 帳號名 | 已實測 | — |
| `wordpress` | WordPress | 國際 | 文章 | ✅ 官方 RSS | 完整網域 | 已實測 | — |
| `ghost` | Ghost | 國際 | 文章 | ✅ 官方 RSS | 完整網域 | 已實測 | — |
| `vocus` | 方格子 | 臺灣 | 文章 | ✅ 官方 RSS | 帳號名 | 需自行查 | — |
| `matters` | Matters | 臺灣 | 文章 | ✅ 官方 RSS | 帳號名 | 需自行查 | — |
| `sspai` | 少數派 | 中國 | 文章 | 🔀 需橋接 | 帳號名 | 需自行查 | — |
| `threads` | Threads | 國際 | 社群 | 🔀 需橋接 | 帳號名 | 需自行查 | — |
| `instagram` | Instagram | 國際 | 圖像 | ✍️ 手動 | 帳號名 | 依文件 | — |
| `x` | X | 國際 | 社群 | 🔀 需橋接 | 帳號名 | 需自行查 | — |
| `bluesky` | Bluesky | 國際 | 社群 | ✅ 官方 RSS | 帳號名 | 已實測 | — |
| `mastodon` | Mastodon | 國際 | 社群 | ✅ 官方 RSS | 站台/帳號 | 已實測 | — |
| `xiaohongshu` | 小紅書 | 中國 | 圖像 | 🔀 需橋接 | 帳號名 | 需自行查 | — |
| `zhihu` | 知乎 | 中國 | 文章 | 🔀 需橋接 | 帳號名 | 需自行查 | — |
| `douban` | 豆瓣 | 中國 | 文章 | 🔀 需橋接 | 帳號名 | 需自行查 | — |
| `weixin` | 微信公眾號 | 中國 | 文章 | ✍️ 手動 | 帳號名 | 依文件 | — |
| `youtube` | YouTube | 國際 | 影音 | ✅ 官方 RSS（+ API 備援） | 頻道 ID | 已實測 | **已啟用** |
| `podcast` | Podcast | 國際 | 聲音 | ✅ 官方 RSS | 帳號名 | 依文件 | — |
| `github` | GitHub | 國際 | 程式 | ✅ 官方 RSS | 帳號名 | 已實測 | — |
| `behance` | Behance | 國際 | 圖像 | ✍️ 手動 | 帳號名 | 依文件 | — |

## 怎麼新增一個平臺

1. 在 `src/config/platforms.data.mjs` 加一筆
2. 在 `src/config/sources.mjs` 加對應的來源，填 handle，`enabled: true`
3. `npm run verify` 確認抓得到
4. `npm run sync` 實際抓一次
5. `node scripts/gen-platform-docs.mjs` 更新這份文件

## feed 網址長什麼樣

要填 `sources.mjs` 的時候查這裡。`{handle}` 要代入什麼由右欄決定 ——
**YouTube 要的是 UC 開頭的頻道 ID，不是 @ 帳號名**，填錯會 404。

兩種 ⚠️ 意思不一樣：

- **樣板已失效** —— 照著填一定失敗。要自己到個人頁找 RSS 圖示，
  把實際網址填進 `feedUrl`
- **需要 `RSSHUB_BASE`** —— 路由本身是對的，但要有一個可用的 RSSHub 實例。
  沒設這個環境變數的話同步會直接略過這些來源

| id | feed 網址樣板 | {handle} 填什麼 |
|---|---|---|
| `medium` | `https://medium.com/feed/@{handle}` | 帳號名 |
| `substack` | `https://{handle}.substack.com/feed` | 帳號名 |
| `note` | `https://note.com/{handle}/rss` | 帳號名 |
| `hatena` | `https://{handle}.hatenablog.com/rss` | 帳號名 |
| `pixnet` | `https://{handle}.pixnet.net/blog/rss` ⚠️ **樣板已失效，見下方注意事項** | 帳號名 |
| `blogger` | `https://{handle}.blogspot.com/feeds/posts/default` | 帳號名 |
| `wordpress` | `https://{handle}/feed` | 完整網域 |
| `ghost` | `https://{handle}/rss/` | 完整網域 |
| `sspai` | RSSHub `/sspai/author/{handle}` ⚠️ 需要 `RSSHUB_BASE` | 帳號名 |
| `threads` | RSSHub `/threads/{handle}` ⚠️ 需要 `RSSHUB_BASE` | 帳號名 |
| `x` | RSSHub `/twitter/user/{handle}` ⚠️ 需要 `RSSHUB_BASE` | 帳號名 |
| `bluesky` | `https://bsky.app/profile/{handle}/rss` | 帳號名 |
| `mastodon` | `https://{handle}.rss` | 站台/帳號 |
| `xiaohongshu` | RSSHub `/xiaohongshu/user/{handle}/notes` ⚠️ 需要 `RSSHUB_BASE` | 帳號名 |
| `zhihu` | RSSHub `/zhihu/people/activities/{handle}` ⚠️ 需要 `RSSHUB_BASE` | 帳號名 |
| `douban` | RSSHub `/douban/people/{handle}/status` ⚠️ 需要 `RSSHUB_BASE` | 帳號名 |
| `youtube` | `https://www.youtube.com/feeds/videos.xml?channel_id={handle}` | 頻道 ID |
| `github` | `https://github.com/{handle}.atom` | 帳號名 |

推導不出樣板的：`vocus`、`matters`、`instagram`、`weixin`、`podcast`、`behance`。
這些平臺要自己到個人頁找 RSS 圖示，把實際網址填進 `sources.mjs` 的 `feedUrl`。

## 各平臺的注意事項

### Medium（`medium`）

feed 只有全文的前段摘要，圖片會帶 Medium 的 CDN 網址。

Feed 樣板：`https://medium.com/feed/@{handle}`

### note（日本）（`note`）

日本最大的寫作平臺，中文創作者也不少。RSS 穩定。

Feed 樣板：`https://note.com/{handle}/rss`

### 痞客邦（`pixnet`）

2026-09-02 用四個真實部落格實測 /blog/rss，全部回 200 但內容是 HTML 不是 feed，所以這個樣板已經失效或改版了。真的要用的話請到部落格頁面找 RSS 圖示，把實際網址填進 sources.mjs 的 feedUrl。另注意：痞客邦對不存在的子網域也回 200 導引頁，「打得通」不代表帳號存在。

Feed 樣板：`https://{handle}.pixnet.net/blog/rss`

### WordPress（`wordpress`）

handle 直接填網域，例如 example.com。

Feed 樣板：`https://{handle}/feed`

### 方格子（`vocus`）

2026-09-02 用真實文章頁反查到 salonId / publicationId / userId，試過 /api/rss/{user,salon,publication}/、/rss/、/{id}/rss 等八種路徑，全部 404，頁面 HTML 裡也沒有 <link rel=alternate>。從站外推導不出來。請登入後到個人沙龍頁找 RSS 圖示，複製實際網址填進 sources.mjs 的 feedUrl。


### Matters（`matters`）

Matters 官方公告過「即日起支援 RSS 訂閱」，但 2026-09-02 用真實帳號試過 /@{handle}/feed、/rss、/rss.xml、/feed/@{handle}、/api/rss/ 等，全部 404。推測是創作者要在後台自行開啟（可能綁 IPNS），開啟後才會有網址。另外它的速率限制很嚴 —— 連續打幾次就開始回 429，同步時要放慢。


### Threads（`threads`）

Meta 沒有給公開 RSS。官方 Threads API 需要 OAuth 且只能讀自己的貼文；短期建議手動挑幾則代表作放 external。


### Instagram（`instagram`）

無公開 feed，且嵌入會追蹤訪客。本站只放連結與自存的封面圖。


### Bluesky（`bluesky`）

handle 用完整網域式帳號，例如 fox.bsky.social。

Feed 樣板：`https://bsky.app/profile/{handle}/rss`

### Mastodon（`mastodon`）

handle 填 instance/@user，例如 mastodon.social/@fox。

Feed 樣板：`https://{handle}.rss`

### 小紅書（`xiaohongshu`）

反爬很兇，橋接常失效。建議當成 manual 用。


### 豆瓣（`douban`）

讀書筆記與影評的好地方，很適合中文系。


### 微信公眾號（`weixin`）

封閉生態，沒有可靠的自動化方式。只能手動貼連結。


### YouTube（`youtube`）

官方 Atom feed 可用，不需要金鑰，最近 15 支。但它會間歇性掛掉：2026-09-02 上午實測所有頻道（含 Google 自家的）都回 404，同日中午再測就恢復 200。所以同步腳本是「先 RSS，掛了才退回 Data API v3」。YOUTUBE_API_KEY 是選填的備援，也是想往回抓 15 支以外的歷史時才需要。

Feed 樣板：`https://www.youtube.com/feeds/videos.xml?channel_id={handle}`

### Podcast（`podcast`）

Podcast 本體就是一份 RSS。直接把節目的 feed 網址填進 feedUrl 即可，不必經過 Apple 或 Spotify。


## 沒有 RSS 的平臺怎麼辦

三個選項，由好到壞：

1. **手動登錄**（推薦）。在 `src/content/external/` 開一個檔案，
   附上一句「為什麼挑這篇」。機器搬得動標題，搬不動判斷。
2. **自架 RSSHub**。放到自己的伺服器上，設 `RSSHUB_BASE`。
   公用實例常常掛掉或被平臺封鎖，長期不建議依賴。
3. **只放連結**。平臺卡片會顯示，但不列出個別文章。
   Instagram 就是這樣處理的 —— 而且它的嵌入會追蹤訪客，本來就不該放。
