# 寫東西的方法

> 這份是寫給 Bella 的。不用懂程式，照著複製貼上就好。

網站上的每一篇東西，都是一個檔案。檔案放在對的資料夾，網站就會自己長出那一頁。

```
src/content/
├── poems/      詩詞 —— 有原文、注、白話的那種
├── posts/      文章 —— 比較長的，讀書筆記、隨筆、翻譯
├── notes/      短札 —— 一兩段就講完的
└── external/   在別的平臺發表過、想收進來的
```

檔名就是網址。`poems/jing-ye-si.md` → `bellafoxy.com/poems/jing-ye-si`。
用英文或拼音，不要有空格。

---

## 最快的開始方式

```bash
npm run write
```

問幾個問題（要寫哪一種、標題、網址用的 slug、一句話說明、標籤、日期），
然後產生一個 frontmatter 正確的檔案。**預設是草稿**，網站上還看不到；
要發佈就把 `draft: true` 那一行刪掉。

下面幾節寫的是那個檔案裡每一個欄位的意思 —— 手寫也可以，
`npm run write` 只是省掉記格式。


## 每個檔案長什麼樣

上面兩條 `---` 中間的部分叫 **frontmatter**，是給網站看的資料。
下面才是正文，用 Markdown 寫。

```markdown
---
title: 標題
publishedAt: 2026-09-02
tags: [唐詩, 李白]
---

正文寫在這裡。空一行就是新的一段。
```

---

## 寫一首詩

複製 `src/content/poems/jing-ye-si.md`，改成你要的內容。

```markdown
---
title: 靜夜思                      # 這頁的標題
description: 二十個字，一個人，一地月光。   # 列表上顯示的一句話（選填）
lang: zh-TW
publishedAt: 2026-09-01           # 發表日期
featured: true                    # 想置頂就寫 true，不想就整行刪掉
tags: [唐詩, 李白, 五言絕句, 思鄉]

poem:
  title: 靜夜思                    # 詩題（不含書名號，網站會自己加）
  author: 李白
  dynasty: 唐                      # 選填
  form: 五言絕句                    # 選填
  source: 《全唐詩・卷一六五》        # 選填
  original: |                      # ← 這個 | 不能省
    床前明月光
    疑是地上霜
    舉頭望明月
    低頭思故鄉

plain: >-                          # 白話翻譯（選填）
  床前灑了一地月光，恍惚間還以為是霜。

annotations:                       # 逐詞注解（選填，可以寫很多條）
  - term: 床
    gloss: 一說是坐臥的床，一說是井欄。
  - term: 疑是
    gloss: 「好像是」。不是真的認錯，是恍惚。

videoUrl: https://www.youtube.com/watch?v=xxxxx   # 朗讀影片（選填）
vertical: true                     # 直排。想橫排就寫 false
---

這裡寫你自己的話。會顯示在「狐狸說」那一段。

可以分很多段，可以用 **粗體**，也可以

> 引用別人的話。
```

### 幾個容易踩到的地方

| 情況 | 怎麼寫 |
|---|---|
| 原文有很多句 | 一句一行，直接換行就好 |
| 原文要分段（例如律詩的兩聯） | 中間空一行，網站會自動拉開間距 |
| `original` 下面 | 一定要有 `|`，而且每一行都要縮排 |
| `plain` 很長 | 用 `>-` 開頭，後面的行都縮排，網站會接成一段 |
| 標題裡有冒號 | 用引號包起來：`title: "詩：一種說法"` |
| 還沒寫完 | 加一行 `draft: true`，就只有你在本機看得到 |

### 兩首詩放在一起

同一組唱和、同一個題目的兩種寫法、或者只是你覺得該一起讀的 ——
`related` 填另一首的**檔名**（不含 `.md`）：

```yaml
related:
  - wu-yi-xiang
  - pi-pa-xing-excerpt
```

詩頁最下面會多出一段「相關的詩」，列出這些連結。

填的名字必須真的有那個檔案，打錯的話 `npm run build` 會停下來說找不到。
單向就夠了 —— 你在這一首填了另一首，另一首不必回填。
（不過那樣的話，連結也只有這一邊有。）

---

## 寫一篇文章

放在 `src/content/posts/`。

```markdown
---
title: 把詩翻成白話的三個難處
description: 翻譯古詩最大的問題不是看不懂。
lang: zh-TW
publishedAt: 2026-08-30
tags: [翻譯, 詩詞]
series: 讀詩的方法            # 屬於某個系列（選填）
---

## 一、丟掉格律，還剩下多少

正文。

## 二、有些字不能翻
```

### 系列文章

同一個系列的文章，`series` 填一樣的名字，`seriesOrder` 填順序：

```yaml
series: 讀詩的方法
seriesOrder: 1
```

同系列有兩篇以上時，文章上方會出現一個小清單，列出整個系列並標出「你在這裡」。

`seriesOrder` 沒填也可以 —— 沒填的會排在有填的後面，彼此依日期。
所以寫到第三篇才想到「這是一個系列」的時候，
不用回頭幫前兩篇補編號也能運作。

### 如果這篇也發在別的平臺

```yaml
# 如果是「先」發在那邊，這裡是轉載 —— 告訴搜尋引擎那邊才是正本
canonicalUrl: https://medium.com/@你的帳號/文章網址

# 如果是同時發，只是想讓讀者知道別的地方也有
alsoOn:
  - platform: medium
    url: https://medium.com/@你的帳號/文章網址
  - platform: vocus
    url: https://vocus.cc/article/xxxxx
```

---

## 寫一則短札

放在 `src/content/notes/`。最簡單的一種。

```markdown
---
title: 為什麼要有一個自己的地方
publishedAt: 2026-09-02
tags: [雜記]
---

在 YouTube 上發了一陣子之後，慢慢覺得少了一個地方。
```

如果是讀到某個東西才寫的：

```yaml
inResponseTo:
  title: 那篇文章的標題
  url: https://example.com/那篇文章
```

---

## 收錄別的平臺的文章

大部分平臺會自動抓（Medium、方格子、note……）。
**抓不到的**（Instagram、微信公眾號、Behance）才需要手動加。

Threads、X、小紅書那幾個要靠 RSSHub 轉，沒有架的話也是手動加 ——
範本檔就是拿 Threads 當例子的。

放在 `src/content/external/`，範本是 `EXAMPLE-threads.md`。

```markdown
---
title: 讀《文心雕龍》讀到一半想到的事
publishedAt: 2026-08-20
platform: threads                              # 平臺代號，見下表
url: https://www.threads.net/@你的帳號/post/xxx  # 原文網址
excerpt: 貼文的開頭幾句。
why: 這則討論串下面有人補了很好的反駁，值得留著。   # ← 這句最有價值
tags: [文心雕龍]
---
```

`why` 是這種手動收錄唯一比機器強的地方。機器只能搬標題，
只有你知道為什麼這篇值得留下來。這句話會顯示在標題底下。

常用的平臺代號：`threads`、`instagram`、`medium`、`vocus`、`matters`、
`note`、`douban`、`weixin`、`xiaohongshu`、`youtube`。
完整清單見 [PLATFORMS.md](PLATFORMS.md)。

---

## 寫英文版

同一篇文章的不同語言版本，用 `translationKey` 串起來 —— **填一樣的值就好**。

```markdown
# src/content/posts/translating-poems.md
---
lang: zh-TW
translationKey: translating-poems
---

# src/content/posts/translating-poems.en.md
---
lang: en
translationKey: translating-poems
---
```

檔名不必對稱，資料夾也不用分開。只要 `translationKey` 一樣，網站就知道它們是同一篇。

只寫中文版完全沒問題 —— 網站不會因為缺英文版而壞掉。

---

## 標籤怎麼取

標籤會變成網址，也會變成 `/tags` 那頁的一個項目。幾個建議：

- **朝代、作者、體裁**：唐詩、李白、五言絕句 —— 這類最有用，方便一次讀完同一個人
- **主題**：思鄉、懷古、送別
- 不要太細。一個標籤如果只會用一次，那它不是標籤，是句子

幾件不用擔心的事：

- 前後多打了空白會自動去掉
- 同一篇裡重複寫了同一個標籤會自動去重
- 英文標籤的大小寫不影響 —— `Poetry` 和 `poetry` 會被當成同一個

---

## 改一篇已經發出去的

直接改那個檔案就好，不用做別的事。

如果這次改動大到你想讓人知道「這篇後來改過」，加一行 `updatedAt`：

```yaml
publishedAt: 2026-09-01
updatedAt: 2026-09-20
```

**但先知道它現在做得到什麼：頁面上看不到它。**
日期那一行仍然只顯示發表日；`updatedAt` 只會寫進網頁的隱藏資訊，
給搜尋引擎和社群卡片看。要不要在畫面上也顯示「更新於⋯」，
是版面的取捨，還沒決定。

所以：想讓讀者看到的話，現在的辦法是自己在文章裡寫一句
（例如結尾加「9月20日補：⋯⋯」）。

---

## 看看寫成什麼樣

```bash
npm run dev
```

然後打開 `http://localhost:4321`。存檔就會自動重新整理。

`draft: true` 的文章在這裡看得到，但不會出現在正式網站上。

### 文章多了以後

列表頁一頁放 30 篇，超過就自動分頁（`/poems`、`/poems/page/2`⋯⋯）。
你不用做任何事，寫就對了。

---

## 寫錯的時候會看到什麼

上面那些欄位寫錯的話，`npm run dev` 或 `npm run build` 會停下來，
並且**指名是哪個檔案的哪個欄位**。不用怕 —— 它不會把壞掉的東西送上網。

第 3 輪（第十二圈）把七種常見的寫錯各試了一次，訊息長這樣：

| 你寫了什麼 | 它會說 |
|---|---|
| 忘了 `title` | 每一篇都要有 title（標題）。 |
| `publishedAt: 昨天` | publishedAt 要寫成日期，像 `2026-09-03`（年-月-日）。 |
| `draft: 是` | draft 只能寫 true 或 false（不是「是」「否」，也不要加引號）。 |
| `tags: 唐詩, 李白` | tags 要寫成清單，像 `[唐詩, 李白]`，或每行一個前面加 `- `。 |
| 忘了 `poem.original` | 每首詩都要有 poem.original（原文）。用 `original: |` 之後每句一行。 |
| `videoUrl: 我的影片` | videoUrl 要是完整網址，像 `https://www.youtube.com/watch?v=…` |

**一個要特別知道的情況：欄位名打錯。**

如果你把 `publishedAt` 打成 `pubishedAt`，它會說「publishedAt 要寫成日期」——
指的是**那個拼對的名字**，而你在檔案裡找不到它。因為對程式來說，
「拼錯的欄位」跟「沒有寫那個欄位」是同一件事。

所以訊息裡多寫了一句提醒：「如果你覺得有寫，檢查一下欄位名有沒有打錯」。
看到這種訊息時，先確認欄位名，再確認值。

---

## 圖片

圖檔跟文章放在一起，在 frontmatter 寫相對路徑：

```yaml
cover: ./照片.jpg
coverAlt: 一張下著雨的窗邊照片，桌上放著一本翻開的書。
```

`coverAlt` 是給看不見畫面的人聽的描述。**留空的話會被當成純裝飾**，
螢幕閱讀器會直接跳過 —— 對純氣氛的圖片這樣是對的，
但如果圖裡有資訊（例如一張手寫的稿紙），就一定要寫。

網站會自動把圖轉成 WebP、產生 1x/2x 兩種尺寸，並且帶上寬高
（這樣圖片載入時不會把下面的文字推開）。你不用管這些。

**上傳前先跑一次：**

```bash
npm run clean-images
```

手機拍的照片會夾帶 GPS 座標和拍攝時間。這個指令會把那些清掉。
