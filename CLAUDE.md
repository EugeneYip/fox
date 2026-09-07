# CLAUDE.md

給之後在這個 repo 上工作的 Claude。

> **接手的入口是 [AGENTS.md](AGENTS.md)** —— 那一份是給任何人或 AI 的
> （ChatGPT、Cursor、Grok、人類都算），寫的是「讀什麼、照什麼順序、
> 這個專案怎麼運作」。Claude Code 會自動載入這一份，別的工具不會，
> 所以入口另外放了一份。
>
> **先讀 [docs/STATE.md](docs/STATE.md)** —— 那份寫的是「現在到哪了、接下來做什麼」。
> 這一份寫的是「在這裡寫程式的規矩」。
>
> 這個專案的所有狀態都在檔案裡，不在任何對話紀錄裡。
> 隨時可能換人（或換 AI）接手，所以任何做完的事都要留下痕跡：
> 改了東西就更新對應的文件，跑完一輪檢查就寫進 `docs/REVIEW-LOG.md`。

## 這是什麼

`bellafoxy.com` —— 一個中文古典詩詞的個人網站，站名「狐說八道」。
Astro 7 靜態站，部署在 GitHub Pages（repo：`EugeneYip/fox`，**公開**）。

站主是 Eugene，網站是做給女朋友的。她讀中文系，做詩詞短影音（YouTube
@FoxPoetry），喜歡狐狸。

## 開始之前一定要知道的三件事

### 1. repo 是公開的，個資不能進 repo

`src/config/privacy.ts` 只放**開關**。真實的本名、學歷、email 放在
`src/config/identity.local.ts`（在 `.gitignore`）。

取值一律透過 `reveal()`，不要在頁面裡硬寫。改完跑 `npm run audit:privacy`，
CI 也會跑。詳見 `docs/PRIVACY.md`。

**稽核腳本本身也不能有真值。** 第 5 輪（第二圈）踩過：四條身分規則
把本名、校名寫死在正則裡（`pattern: /本名/g`），而那個檔案在自己的
ALLOWLIST 裡 —— 唯一含有個資的檔案，剛好豁免於自己的檢查。
現在值從 `identity.local.ts` 或 `PRIVACY_NEEDLES` 環境變數取得。
兩個都沒有時，稽核會印出「身分規則沒有執行」而不是安靜地放行。

### 2. 零第三方請求是硬性限制，不是偏好

不要加 Google Fonts、分析工具、CDN、直接的 YouTube iframe。
影片一律用 `VideoFacade`（按了才載入）。稽核腳本會擋。

### 3. 只有中文與英文，**不要加日文**

站主 2026-09-02 明確說過這個專案不需要日文版，早期的 `ja` 已經全部移除。
`site.ts`、`ui.ts` 裡的文案是 `{ 'zh-TW', en }` 兩份。
缺的會自動退回 zh-TW，所以不會壞，但盡量補齊英文。

（日本的**發表平臺**（note、はてなブログ）仍留在平臺目錄裡 ——
那是「她可能在哪裡發文」，跟「網站介面要有幾種語言」是兩件事。）

## 改東西該去哪裡

| 想改 | 去 |
|---|---|
| 站名、標語、導覽列、語言 | `src/config/site.ts` |
| 隱私開關 | `src/config/privacy.ts` |
| 新增一個發表平臺 | `src/config/platforms.data.mjs` |
| 她在哪些平臺有帳號 | `src/config/sources.mjs` |
| 介面上的字 | `src/i18n/ui.ts` |
| 顏色、字級、間距 | `src/styles/tokens.css` |
| 內容的欄位結構 | `src/content.config.ts` |

**頁面不要直接呼叫 `getCollection`。** 走 `src/lib/content.ts`，
草稿過濾、語言過濾、排序的規則都寫在那裡。

## 已知的坑

- **Astro 的 scoped style 不會穿進子元件。**
  `<FoxMark class="x" />` + `.x { color: … }` 沒有用。要包一層容器，
  把 `color` 設在容器上讓它繼承。
- **直排的軸向是反的。** `writing-mode: vertical-rl` 之下，
  `inline-size` 是「一行的長度（高度）」，`block-size` 是整體寬度。
  flex 的 `column` 方向才是「由右往左」。見 `PoemBlock.astro` 的註解。
- **YouTube 的 RSS 會間歇性掛掉，但沒有停用。**
  2026-09-02 上午實測 `youtube.com/feeds/videos.xml` 對所有頻道都回 404
  （連 Google 自家頻道都是），同日中午再測就恢復 200。
  所以同步腳本是「先 RSS（免金鑰），掛了才退回 Data API v3」。
  **不要因為一次 404 就斷定它下架了** —— 我第一次就是這樣搞錯的。

  **它壞掉的樣子不只一種，2026-09-02 那次只是其中一種。**
  第 4 輪（第四十圈）實測到另外兩件事：

  - **不只 404，500 也算。** 同一個網址一分鐘內連打：404、500、404。
  - **它可能只壞一個頻道。** 同一時間 Google 自家頻道回 200、她的回 404 ——
    所以「別的頻道通不通」**不是判準**。`npm run verify -- --patterns` 打的是
    公開頻道，那一格綠燈**證明不了她的頻道沒事**。

  真的能用的判準是看**她的頻道頁還在不在**：`https://www.youtube.com/@FoxPoetry`
  回 200，而且 canonical 指到 `sources.mjs` 裡那個 channelId，
  就表示頻道好好的，壞的是 feed 那一端。（那次實測十分鐘後就自己恢復，抓到 9 筆。）
- **HTTP header 的值只能是 Latin-1。** User-Agent 裡放了一個全形破折號，
  結果 `fetch` 在送出前就拋 ByteString 錯誤，整個同步流程從來沒成功過，
  而錯誤訊息看起來卻像網路問題。header 一律用純 ASCII。
- **`base` 必須是 `/`。** repo 叫 `fox`，但綁了自訂網域，網站在網域根目錄。
  改成 `/fox` 會讓所有樣式和連結壞掉。
- **`public/CNAME` 不能刪。** 少了它 GitHub 會取消自訂網域。
  `deploy.yml` 有一道檢查擋這個。
- **`platforms` 拆成 `.data.mjs` + `.ts` 是刻意的。** Node 腳本要在
  沒有編譯步驟的情況下讀那份資料。不要合併回一個 `.ts`。

## 開發流程

```bash
npm run write           # 開一篇新的（問幾個問題，產生 frontmatter 正確的 md）
npm run dev             # 開發
npm run check           # 型別（0 errors 才算過）
npm run audit:privacy   # 隱私稽核（0 errors 才算過）
npm run build           # 建置
```

`npm run write` 是站主 2026-09-03 要的「她自己就能發文」那條路：
在她的電腦上跑、不需要登入、不碰第三方，產出的仍然是 `src/content/` 底下
的 markdown。預設寫成 `draft: true`，要發佈是另一個看得見的動作。

改了 `platforms.data.mjs` 之後要跑 `node scripts/gen-platform-docs.mjs`
更新 `docs/PLATFORMS.md`（那份是產生的，不要手改）。

**忘記的話 `npm run check:generated` 會擋**（它在 `test:built` 裡，兩個 workflow
都會跑）。那不只是文件整潔的問題：`platforms.data.mjs` 裡有 23 個中文字串
**一個都沒有出現在 `dist/`**（站上只有 YouTube 一個來源），
`check:copy` 是靠那份產生的文件才校對到它們的。

## 週期性檢查

這個專案用 `/loop` 做輪替式的自我檢查 —— 一次只深入一個面向（無障礙、效能、
內容結構、feed 實測⋯⋯），而不是每次都全掃一遍。

每一輪都會做**突變掃描**：故意把程式改壞一處，確認測試真的會紅。
用這支工具，不要隨手寫 `sed`：

```bash
npm run mutate -- <檔案> --from '<原文>' --to '<新的>'   # 套用
npm run mutate -- <檔案> --restore                      # 還原
```

**`--from` 裡有反斜線的話，改成直接跑 `node scripts/mutate.mjs …`** ——
`npm run` 會多經過一次 shell，無引號的 `\d` 會被讀成 `d`，於是永遠配不到。
（配不到時它會自己說是不是這個原因，不用猜。）

**同一個檔案連續突變兩次也可以**，備份留的是最初那一份，
所以 `--restore` 會一次還原掉全部 —— 它套用時會提醒你這件事。

**理由是那一行 `--from` 配不到就會停下來。** 隨手寫的 `replace` 配不到時
不會報錯，它只是什麼都不做 —— 於是「突變之後測試還是綠的」會被讀成
「這一格沒守住」，而其實突變壓根沒套用上去。第 1 輪（第二十二圈）
照著那個假訊號改過測試，第 6 輪真的被它擋下一次。

輪替順序、每一輪的規則、以及歷次紀錄都在 `docs/REVIEW-LOG.md`。
接手做某一輪之前先讀那份，看最後一筆是哪一項，接著下一項做。

## 帳號現況

**網站上只有 YouTube（@FoxPoetry / 狐說八道）一個來源。**
`src/config/sources.mjs` 只有一筆，這是事實不是待辦。
不要為了讓畫面「看起來完整」而編造帳號或加假的來源。

2026-09-04 更新：另一個平臺的帳號**是知道的**（整理網域 DNS 轉址時看到的），
但站主當天明確說不可以放上網站。那個帳號名**不寫進這個 repo** ——
repo 是公開的，寫進註解等於發佈它。清單上還是只有一筆，
但理由從「不知道」變成「知道，而且刻意不放」。

拿到帳號名之後可以用 `npm run handle <帳號名>` 一次確認它在哪些平臺存在，
輸出會直接給可貼進 `sources.mjs` 的片段。

## 語氣

網站上的中文用**臺灣繁體**，「臺」不用「台」（站名與正式文案）——
`check:copy` 的 `taiwan-tai` 在守這一條。

**標點用全形**（，。；：！？）。中文句子裡夾半形標點會被 `halfwidth-punct` 擋下來；
中英混排時兩側是拉丁字母的那種不算。

**中文與英文字母之間空一格**：

```
✗  用Astro建的站
✓  用 Astro 建的站
```

第 6 輪（第五圈）量過，全站與文件**一處例外都沒有**，所以是把既有的
習慣寫下來，不是新規定。

（反例放在框裡是刻意的 —— `check:copy` 掃之前會先拿掉程式碼區塊。
第 6 輪〔第二十八圈〕量到：這一份之所以整份被豁免，就是為了上面那一行。
換個寫法，整份文件就回到檢查範圍裡了。）

**數字不適用這一條**：日期寫「9月2日」不寫「9 月 2 日」——
那是中文的日期格式，中間本來就不空格。
（`check:copy` 的 `cjk-latin-space` 規則只看字母，不看數字，就是為了這個。）

**引號用「」與『』**，不用直的那種。`check:copy` 的 `straight-quotes`
擋的是「兩側都是漢字」的情況；中英混排時兩側是拉丁字母的那種不算，
所以引英文原句不會被擋。

**刪節號用 ⋯⋯ 或 ……**，不要用三個半形句點。
`check:copy` 的 `halfwidth-ellipsis` 同樣只看漢字後面那種 ——
英文句子後面的省略號是正常的。

（上面這兩條到第 6 輪〔第十四圈〕為止**只存在於 `check:copy` 裡**，
沒有寫在這一節。照文件寫的人會在 CI 上被擋下來卻不知道為什麼 ——
同一個約定有兩個地方在管，而兩邊的清單不一樣。）

文案風格是安靜、克制、有具體的東西 ——
不要寫「探索詩詞之美」這種話。

**同一份約定，給真的在寫文案的人看的版本在
[docs/CONTENT.md](docs/CONTENT.md) 的「用字的幾個約定」** ——
那裡有正反例的對照（反例放在程式碼框裡，那種框不會被 `check:copy` 掃）。

兩份都要有：`check:copy` 的 `rule-not-documented` 會同時要求
`CLAUDE.md` 與 `docs/CONTENT.md` 都提到每一條規則的 id，
所以清單不可能只更新一邊。第 6 輪（第二十七圈）之前五條**全部只寫在這裡**，
而這一份的第一行是「給之後在這個 repo 上工作的 Claude」——
真正在寫文案的人一條都看不到。

程式碼註解寫「為什麼」，不寫「做了什麼」。這個 repo 的註解密度偏高，
是刻意的：這是一個長期低頻維護的專案，半年後回來要看得懂。

## 進度要留得住

工作階段隨時可能中斷。所以：

- **做完一個段落就 `git commit`**（本機就好）。這是唯一能讓進度不消失的方式。
  commit 之前先跑這兩個，全綠再 commit：

  ```bash
  npm run verify:all && npm run test:tools
  ```

  **兩個都要。** `verify:all` 是六道關卡（型別、隱私、對比、建置、無障礙、效能），
  但**文案與內容管線的檢查不在裡面** —— `check:copy` 與 `check:content` 住在
  `test:tools` 的 `test:built` 那一半。第 6 輪（第七圈）就是只跑了 `verify:all`
  就 commit，把一個文案違規推進去，隔一輪才被 `ci:sim` 抓到。

  **改到 `test:units` 那條鏈、或改到 `.github/workflows/` 的時候，再加跑一個：**

  ```bash
  npm run ci:sim
  ```

  理由：那兩套關卡跑在**你的工作樹**上，而 CI 拿到的是**版控裡的檔案**，
  順序也不一樣。第 7 輪（第二十六圈）踩到一次 —— `test:units` 裡有一格
  需要真的 `dist/`，而 deploy.yml 的 `test:units` 跑在 build **之前**
  （那一步的名字就叫「不需要 dist 的那些」）。本機永遠有 dist，所以兩套關卡
  全綠；乾淨的 runner 上會停在第一步。**唯一會抓到它的是 `ci:sim`，
  而它只有人手動跑才會跑。**

  （`ci:sim` 跑的是 **HEAD**，不是工作樹 —— 那是刻意的，因為 CI 拿到的就是
  版控裡的東西。所以要驗自己剛改的東西，得先 commit。）
  （原本這裡寫「五道」，那是更早以前的數字。）
- **commit 完就推。** 站主 2026-09-06 授權可以直接 `git push`，
  而且要**融進 `/loop` 的流程** —— 每一輪跑完關卡、commit 之後就推上去。
  （在那之前這裡寫的是「不要 push，站主自己來 —— 這裡的帳號接不到 GitHub」，
  那句話兩件事都不對了：`gh` 是登入的，而站主要的是自動推。）

  **推之前一定要先 rebase。** 排程的 `sync-feeds` 每天自己 commit 兩次
  `src/data/syndication.json`，所以本機幾乎一定落後：

  ```bash
  git pull --rebase origin main && git push
  ```

  撞到的一定是 `syndication.json`（兩邊都只差時間戳）。那是
  `scripts/sync-feeds.mjs` 產生的，**取遠端那一份**（它比較新）：

  ```bash
  git checkout --theirs src/data/syndication.json && git add src/data/syndication.json && git rebase --continue
  ```
- **待辦寫進 [docs/TODO.md](docs/TODO.md)** —— 那是一份會被**編輯**的清單
  （做完就刪掉那一行，發現新的就加一行），不是在每一輪紀錄裡結轉一次。
  第四十六圈第 3 輪改的：在那之前它是每輪原封不動抄一份，抄到 60 條、
  而且沒有人回頭看它們還成不成立。
- **不要把狀態留在腦袋裡。** 決定了什麼、找到什麼問題、下一步是什麼，
  都要寫進 `docs/REVIEW-LOG.md`（逐輪的完整紀錄）或 `docs/STATE.md`
  （只放「現在到哪了、接下來做什麼」——**不要把輪次紀錄抄一份過去**，
  那份文件曾經因此長到 2,715 行）。
  判準很簡單：如果現在斷線，接手的人光看檔案能不能完全接得下去？
- 半成品也要 commit，但 commit message 要寫清楚哪裡沒做完。
  留下一個註明「未完成」的檢查點，比留下一堆沒有紀錄的改動好。

## 不要做的事

- 不要加留言系統、電子報、CMS —— 見 `docs/ARCHITECTURE.md` 的「刻意沒做的事」
- 不要把 `src/data/syndication.json` 手改，那是 `scripts/sync-feeds.mjs` 產生的
- 不要編造她的平臺帳號。不知道就是不知道，讓網站誠實地少一塊
