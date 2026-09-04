# 現在到哪了

> **接手這個專案的人（不管是人還是 AI）先讀這一份。**
> （完整的接手指引在 [AGENTS.md](../AGENTS.md) —— 非 Claude 的工具不會自動
> 載入任何規則檔，那一份會告訴你要自己讀哪幾份。）
> 這裡只寫「現在的狀態」與「接下來做什麼」。設計理由在 [ARCHITECTURE.md](ARCHITECTURE.md)，
> 上線步驟在 [DEPLOY.md](DEPLOY.md)，寫作方式在 [CONTENT.md](CONTENT.md)。
>
> 最後更新：2026-09-04（第二十六圈走完；git 歷史已壓成一個乾淨的 commit；
> 這一份從 2,715 行瘦身到約 300 行 —— 200 筆輪次摘要搬回 REVIEW-LOG.md）

---

## 一分鐘理解

`bellafoxy.com` —— 一個中文古典詩詞的個人網站，站名「狐說八道」。
Astro 7 純靜態站，要部署到 GitHub Pages（repo `EugeneYip/fox`，**公開**）。

站主是 Eugene，網站是做給女朋友的。她讀中文系、做詩詞短影音、喜歡狐狸。

## 先確認專案是健康的

```bash
npm install    # 第一次
npm run verify:all
```

這一個指令會依序跑：型別檢查 → 隱私稽核 → 對比度 → 建置 → 無障礙 → 效能預算。
**六道全過才算健康。** 任何一道紅燈就先修那個，不要往下做新東西。

工具本身還有一組測試，不算在六道裡但 CI 會跑（部署前也會）：

```bash
npm run test:tools    # 全部 26 項，零網路請求
npm run test:units    # 不需要 dist 的那 22 項
npm run test:built    # 需要 dist 的那 4 項（要先 build）
```

想知道「內容變多會不會壞」的話：

```bash
npm run fixtures -- 500 --videos 400  # 灌 500 篇假內容 + 400 支假影片
npm run build && npm run check:perf # 量
npm run fixtures -- --clean         # 一定要清乾淨
```

`--clean` 會自己確認零殘留，有殘留會直接失敗。

跑不起來的話檢查 Node 版本。`package.json` 的 `engines` 要求 `>=22.19.0`
（那是相依套件 undici 的實際需求），`.nvmrc` 寫的是主版本線 `22`。

---

## 完成了什麼

網站本身是**完整可用**的，不是骨架。

- 44 個頁面，中文與英文兩種語言
- 四種內容類型：詩詞（有原文／注／白話／朗讀）、文章、短札、外站收錄
- 詩詞直排（`writing-mode: vertical-rl`），窄螢幕自動橫排
- 五個列表頁全部分頁（每頁 30 筆）、系列文章導覽、封面圖（自動轉 WebP 並帶尺寸）
- 24 個發表平臺的目錄與聚合層（建置時抓、結果進版控、平臺掛掉不影響網站）
- 站內搜尋、RSS（兩種）、sitemap、robots、深淺色主題
- 零第三方請求、零追蹤（由 Content Security Policy 強制，不只是約定）
- 六道自動檢查關卡，都接進 CI（無障礙 24 條規則、效能 11 條預算、
  對比度 42 組 + 列印的 color-scheme 覆蓋），
  外加工具的單元測試（`npm run test:tools`，26 項 —— 節流、HTTP header、
  剖析、正規化、同步編排、隱私規則、無障礙規則、效能預算、內容管線規則、
  文案慣例、建置管線規則、對比度，加上兩項需要 `dist/` 的。
  在 CI 與部署路徑上，但不算在六道內）
- **每一條規則與預算都有「會響」的測試案例。** 加規則沒加案例，測試會直接失敗
- 顏色用 `light-dark()` 定義，深淺兩套值寫在同一行 —— 不可能漂移

有 5 篇種子內容（3 首詩、1 篇文章、1 則短札），是真的寫過的，
可以直接留著，也可以當範本改。

## 沒完成什麼

| | 狀態 | 卡在哪 |
|---|---|---|
| **推上 GitHub** | ✅ 已推 | 2026-09-04 推上 `EugeneYip/fox`（先 private 檢查、再轉公開）。213 個 commit 壓成 1 個（`a67a0a0`），壓縮前後 tree hash 一致，私密檔案從未進過歷史。Pages 已啟用（`build_type=workflow`）、`cname=bellafoxy.com`，部署 workflow 綠燈。**「接不到 GitHub」那句是錯的，已實測推翻** |
| **DNS 切到 GitHub Pages** | ✅ 已完成 | 2026-09-04 做完。刪掉 apex 與 `www` 兩筆指向舊站的 URL 轉址（Porkbun 會連帶清掉它自己建的 ALIAS／CNAME，24 → 20 筆），新增 4 筆 A（`185.199.108–111.153`）＋ `www` CNAME → `eugeneyip.github.io`。**MX 2 筆與 SPF TXT 完好、五個 vanity 轉址（`ig`／`instagram`／`poetry`／`youtube`／`yt`）完好。** 實測：apex 回 200、`www` 301 導到 apex |
| **HTTPS** | ✅ 已上線 | 2026-09-04 18:48 UTC Let's Encrypt 簽出憑證（`CN=bellafoxy.com`，效期到 12月3日），`https_enforced=true` 已開。四條路徑都收斂到 `https://bellafoxy.com/`：apex HTTPS 200、`www` HTTPS 301、apex HTTP 301、`www` HTTP 301。**DNS 改完到憑證簽出約 15 分鐘** |
| **YouTube 影片同步** | ✅ 已在跑 | 走官方 Atom feed，**不需要金鑰**。已同步 9 支影片。⚠ 那個 feed 只回**最新 15 支**（第 4 輪〔第十一圈〕用大頻道實測），所以**第 16 支之後**更早的影片這條路就看不到了 —— 到時候才需要 `YOUTUBE_API_KEY` |
| **頻道本身** | ⏸ 停更中 | 最後一支影片 2024-10-26。**站主知道，是刻意的**（2026-09-04 確認）。同步到的 9 支全是短影音詩詞（王昌齡、杜甫、李白⋯），確認是他們自己的頻道。另外有一個長影片頻道是別人的，只是其中一支提到她 —— **那個不在來源清單裡，也不該加** |
| **她其他平臺的帳號** | ⏸ 刻意不放 | 網站上只有 YouTube 一個來源。2026-09-04 整理 DNS 轉址時看到**另一個平臺的帳號**，站主當天明確說不可以放上網站 —— 所以那個帳號名**不寫進這個公開 repo**（寫進註解等於發佈它）。理由從「不知道」變成「知道，而且刻意不放」，結果一樣是一筆 |
| **英文文案** | ✅ 已校 | 第 6 輪逐句校過。但英文版目前沒有**內容**，只有介面 |

---

---

## git 歷史：已經壓成一個乾淨的 commit（2026-09-04）

**做過了。** 原本的問題是：早期的 `scripts/audit-privacy.mjs` 把四條身分規則的
真值寫死在正則裡（`pattern: /她的本名/g`），而那個檔案自己在 ALLOWLIST 裡 ——
唯一含有個資的檔案剛好豁免於自己的檢查。第 5 輪（第二圈）修好了**程式**
（值改從 gitignore 的 `identity.local.ts` 或 `PRIVACY_NEEDLES` 取得），
**但已經進到 git 歷史的東西，改程式救不回來。**

2026-09-04 把 213 個 commit 壓成一個。選這個做法的理由：

- **不需要知道那些值就一定清得乾淨** —— 針對性重寫（`git filter-repo`）要先
  列舉出每一個字串，而這台機器上沒有 `identity.local.ts`，`check:history`
  跑不了（它會誠實地說「什麼都沒有檢查」並 exit 1）
- **連 commit message 一起清掉** —— 第三圈第 5 輪記過「commit message 裡的
  個資，檢查工具看不到」
- **輪次紀錄不靠 commit 歷史保存**，它在 `docs/REVIEW-LOG.md` 這個檔案裡

代價：失去 213 筆的 `git blame`／`bisect`。

### 還沒做完的最後一步

壓完之後，舊的 commit 物件**還在 `.git` 裡**（reflog 指得到），只是不再被
任何分支指到。正常的 `git push` 只會送出「指得到的」物件，所以推上去不會帶著它們。
但要真的從這台機器上刪掉，還要跑：

```bash
git reflog expire --expire=now --all && git gc --prune=now
```

**跑完就救不回來了**，所以留給你自己決定什麼時候跑。
（在那之前，如果發現壓錯了，`git reflog` 找得回舊的 HEAD。）

### 推之前的最後確認

```bash
npm run check:history                  # 需要 identity.local.ts 或 PRIVACY_NEEDLES 才跑得動
git ls-files -- src/config/identity.local.ts   # 要沒有輸出
                                              # （identity.local.example.ts 是刻意公開的範本，不算）
npm run verify:all && npm run test:tools
```

`check:history` 查**三個地方**：檔案內容（`git log -S`）、commit message、
以及 tag／branch 的名字。`-S` 看不到只寫在訊息或 ref 名字裡的字串，
第 5 輪（第三、四圈）實測確認過。沒有值可搜尋時它會 exit 1 並說
「什麼都沒有檢查」，不會給假的綠燈。

（那支腳本刻意不叫你自己下 `git log -S"名字"` —— 那會把本名留在 shell 的
歷史紀錄裡，為了查個資外洩而製造另一份個資。）

## 上線這條路走到哪了

完整步驟與疑難排解在 [DEPLOY.md](DEPLOY.md)。2026-09-04 的進度：

0. ✅ **清掉 git 歷史裡的個資** —— 213 個 commit 壓成 1 個。
   只剩一個選擇性的收尾（在 Eugene 那台機器上跑）：
   `git reflog expire --expire=now --all && git gc --prune=now`
1. ✅ **推上 GitHub** —— `EugeneYip/fox`，先 private 檢查、確認乾淨後轉公開。
   `PRIVACY_NEEDLES` secret 已設（Eugene 自己填的值），CI 上實測有生效：
   輸出寫「身分規則：8 個值，來自 PRIVACY_NEEDLES」
2. ✅ **開啟 GitHub Pages** —— `build_type=workflow`、`cname=bellafoxy.com`，
   部署 workflow 綠燈，站台實測回 200（36 KB，標題「狐說八道」）
3. ✅ **改 Porkbun 的 DNS** —— 見上面那張表。做法上有一個坑值得記：
   **不要直接刪 DNS 記錄，要刪「URL 轉址」設定本身**
   （`/api/domains/deleteDomainForwarding`）—— Porkbun 會連帶清掉它為那筆
   轉址建的 ALIAS 與萬用字元 CNAME。直接刪記錄會留下孤兒設定
4. ⏸ **勾 Enforce HTTPS** —— 要等 GitHub 簽出憑證才能開。
   現在 `https_enforced=false`，提早開會拿到「憑證還不存在」

每次改動之前都要跑 `npm run audit:privacy`，確認沒有個資外洩。

---

## 版控狀態

本機有 git 紀錄，remote 是 `EugeneYip/fox`，**2026-09-04 已經推上去了**。

```bash
git log --oneline    # 看目前的檢查點
git status           # 應該是乾淨的
```

Claude 只做本機 commit，不做 push —— 這是刻意的，見 CLAUDE.md。
每完成一輪檢查會留一個 commit，所以隨時中斷都不會掉進度。

**要推的時候：**

```bash
git remote add origin https://github.com/EugeneYip/fox.git
git push -u origin main
```

推完立刻確認個資檔沒被帶上去：

```bash
git ls-files | grep -c identity.local    # 必須是 0
```

---

## 週期性檢查（loop）現在跑到哪

**下一輪：第二十七圈第 1 輪 —— 無障礙。**

做法：一次只深入一個面向（八個面向輪流），每一圈換一個**問題**去問全站。
輪替順序、每一輪的規則、以及全部 210 筆逐輪紀錄都在
[REVIEW-LOG.md](REVIEW-LOG.md) —— 接手某一輪之前先讀那份的最後一筆。

> **這一節刻意只留索引。** 2026-09-04 之前這裡有 200 筆輪次摘要，
> 佔了 `STATE.md` 的 92%，而那 200 筆在 `REVIEW-LOG.md` 都有更完整的版本。
> 一份「現在到哪了」的文件長到 2,715 行，就不再是那份文件了。

### 每一圈問過什麼

| 圈 | 問的問題 |
|---|---|
| 第一圈 | 先把八個面向各走一次，建立基線 |
| 第二圈 | 不是找新問題，是回頭驗第一圈的結論站不站得住 |
| 第三圈 | 檢查本身是不是真的在檢查 |
| 第四圈 | 把第三圈那個問題做完 |
| 第五圈 | 每一個結論，是在什麼條件下量出來的 |
| 第六圈 | 有什麼是從來沒有真的被執行過的 |
| 第七圈 | 先問現有的東西守不守得住，再決定要不要動 |
| 第八圈 | 這個東西證明的，是不是它宣稱的東西 |
| 第九圈 | 這個案例證明的，是不是它宣稱的那一條 |
| 第十圈 | 這個工具結構上看不見什麼 |
| 第十一圈 | 拿真正跑起來的結果當對照組 |
| 第十二圈 | 用不是預設的方式走一次 |
| 第十三圈 | 每一支檢查的案例，是不是都長得太像 |
| 第十四圈 | 同一件事有兩個地方在守，答案一樣嗎 |
| 第十五圈 | 這個綠燈是因為對，還是因為空 |
| 第十六圈 | 這條規則會不會冤枉好人 |
| 第十七圈 | 站主照著這句話做得到嗎 |
| 第十八圈 | 讀者拿到的是什麼 |
| 第十九圈 | 內容變多之後，先壞的是什麼 |
| 第二十圈 | 那些從沒跟真資料跑過的路，走一次會怎樣 |
| 第二十一圈 | 這一條檢查，實際上判斷過多少東西？ |
| 第二十二圈 | 這件事只在我的機器上成立嗎？ |
| 第二十三圈 | 一整件事從頭走到尾，走得通嗎？ |
| 第二十四圈 | 同一件事，我們在幾個地方說過？那幾個地方說的一樣嗎？ |
| 第二十五圈 | 這一格綠燈，有沒有可能是它根本沒有跑？ |
| 第二十六圈 | 如果這件事今天壞了，我們多久之後會知道？是誰告訴我們的？ |

**第二十七圈（要開始）：這件事，換一個人來做，做得到嗎？**
不是「文件寫了沒」（第二十四圈問過），是**照著做會不會卡住** ——
第一次 clone 下來要跑什麼、缺哪個檔案會發生什麼、錯誤訊息看不看得懂、
`identity.local.ts` 這種「只有站主有」的東西擋住了哪些路、
以及她要發一篇文時，從第一步到看到它上線，說明夠不夠她一個人走完。

### 最近一圈（第二十六圈：壞了誰會告訴我們）

| 輪 | 問誰 | 答案 |
|---|---|---|
| 1 無障礙 | `prefers-reduced-motion` 的毯子被掀掉 | 沒有人，而且受影響的人不會回報 |
| 2 效能 | 「讀者實際下載」那個數字 | 沒有人 —— 它是 level 9，伺服器壓到 level 4–6 |
| 3 內容結構 | 同步的排程停掉 | 沒有人 —— `/colophon` 會永遠說「1 個正常」 |
| 4 feed | `confidence: 'verified'` 過期 | 只有人手動跑 `--patterns`，還要自己去對另一個檔案 |
| 5 隱私 | 私密檔 commit 過又清掉 | 沒有人 —— 而那是**不可逆**的 |
| 6 文案 | 35 個從沒被算繪的字 | **她** —— 第一個寫出那種內容的人 |
| 7 建置與 CI | `test:units` 需要還不存在的 `dist/` | 只有 `ci:sim`，而它當時就是紅的 |
| 8 視覺 | 直排消失 | 讀者，或者她 |

那一圈留下：三條新規則（`reduced-motion-blanket`、`vertical-lost`、
`private-file-in-history`）、兩則新的 note、一個修好的部署阻斷。

---

## 現在還沒解決的

分成兩種：**只有站主能決定的**，以及**迴圈自己會處理的**。

### 只有站主能決定或執行的

| | 事情 |
|---|---|
| 上線 | 推上 GitHub、DNS 切到 Pages（見 [DEPLOY.md](DEPLOY.md)） |
| 收尾 | `git reflog expire --expire=now --all && git gc --prune=now`（壓歷史之後的最後一步，跑完救不回來） |
| 個資檢查 | 本機建 `identity.local.ts` 或設 `PRIVACY_NEEDLES`，否則身分規則**一次都沒有真的跑過**（`identity-value` 永遠是 0） |
| 開關 | `reveal('email')` 有實作、接了開關，但沒有任何頁面畫出來 |
| 版面 | 首頁「在別處」佔頁面高度 42%，要不要少放幾筆 |
| 對比 | 頁首標語最壞情況 4.09:1（低於 4.5:1） |
| 內容 | 8 個 schema 欄位沒有任何一篇用過（`cover`／`related`／`videoUrl`／`updatedAt`⋯），背後 49 處消費者從來沒跟真資料跑過 |
| 環境 | 本機 Node v22.15.1 低於 `engines` 宣告的 `>=22.19.0` |

### 迴圈自己會處理的（記在各輪的「待辦」裡）

- `--patterns` 與 `ci:sim` 都只有人手動跑才會跑
- 16／26 條 a11y 規則沒有反向案例
- Tab 順序、螢幕閱讀器朗讀順序、互動目標尺寸：腳本自己說是人工的
- 建置時間沒有任何東西在量（實測 6.3–7.5 秒）
- `check:contrast` 讀不到檔案時丟的是 Node 原始堆疊
- `EXAMPLE-threads.md` 的檔名本身是一個舊誤解的化石
- 斷點 `34rem` 寫了九次（CSS 沒辦法只寫一次）

完整的、帶著當時量測的版本在 [REVIEW-LOG.md](REVIEW-LOG.md) 每一輪的「待辦」。

---

## 接手時最容易踩到的坑

這些在 [CLAUDE.md](../CLAUDE.md) 有完整清單，這裡挑三個最貴的：

1. **repo 是公開的。** 本名、學歷、email 只能放在 `src/config/identity.local.ts`
   （已 gitignore）。`privacy.ts` 裡只有開關，沒有值。取值一律走 `reveal()`。
2. **`astro.config.mjs` 的 `base` 必須是 `/`。** repo 叫 `fox` 但綁了自訂網域，
   網站在網域根目錄。改成 `/fox` 會讓所有樣式和連結壞掉。
3. **`public/CNAME` 不能刪。** 少了它 GitHub 會默默取消自訂網域。
   `deploy.yml` 有一道檢查擋這個。

---

## 有疑問時去哪找

| 想知道 | 看 |
|---|---|
| 為什麼要這樣設計 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 怎麼上線 | [DEPLOY.md](DEPLOY.md) |
| 怎麼寫文章（給不寫程式的人） | [CONTENT.md](CONTENT.md) |
| 隱私開關怎麼調 | [PRIVACY.md](PRIVACY.md) |
| 支援哪些平臺、handle 要填什麼 | [PLATFORMS.md](PLATFORMS.md) |
| 檢查過什麼、找到什麼 | [REVIEW-LOG.md](REVIEW-LOG.md) |
| 在這個 repo 上寫程式的規矩 | [CLAUDE.md](../CLAUDE.md) |

沒有任何知識只存在對話紀錄裡。上面這幾份就是全部。
