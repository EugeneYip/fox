# 上線步驟

從現在（本機有一份完整的網站）到 `https://bellafoxy.com` 能打開，總共四步。
每一步都標了「誰做」與「大概多久」。

> 目前狀態（2026-09-04 實際做完）
> - `github.com/EugeneYip/fox` 已建立、**公開**，網站已推上去，部署 workflow 綠燈
> - `bellafoxy.com` 註冊在 **Porkbun**，DNS 已切到 GitHub Pages（A ×4、AAAA ×4、`www` CNAME）
> - GitHub Pages 已啟用（Source ＝ GitHub Actions），`cname=bellafoxy.com`
> - **只剩 Enforce HTTPS**，要等 Let's Encrypt 簽出憑證
>
> 底下第 0～3 步都做完了，留著是給日後換網域或重做的人看。

---

## 第 0 步：先確認一件事 —— repo 是公開的

這代表**原始碼裡的所有東西都會被看到**，包括設定檔。

本專案已經為此做了設計：本名、學歷、email 這類資料**不在 repo 裡**，
而是放在 `src/config/identity.local.ts`，那個檔案在 `.gitignore` 中。

推之前跑一次稽核，確認沒有東西漏出去：

```bash
npm run audit:privacy
```

出現「乾淨」才往下走。詳見 [PRIVACY.md](PRIVACY.md)。

> 如果之後想改成私有 repo：GitHub Pages 對私有 repo 需要付費方案（Pro 以上）。
> 免費帳號要維持公開。以現在這個架構，公開是安全的。

---

## 第 1 步：推上 GitHub

**誰做：你（Eugene）**　**時間：2 分鐘**

```bash
cd /Volumes/Projects/bella
git init -b main
git add .
git commit -m "feat: 狐說八道網站初版"
git remote add origin https://github.com/EugeneYip/fox.git
git push -u origin main
```

推完之後檢查一件事：

```bash
git ls-files | grep -c identity.local
```

**必須輸出 `0`。** 如果不是 0，代表個資檔被推上去了，停下來先處理
（`git rm --cached src/config/identity.local.ts`，並且注意歷史紀錄裡也會留存）。

---

## 第 2 步：開啟 GitHub Pages

**誰做：你**　**時間：1 分鐘**　**只需做一次**

1. 到 `https://github.com/EugeneYip/fox/settings/pages`
2. **Build and deployment → Source** 選 **GitHub Actions**
   （不要選 "Deploy from a branch"，本專案用的是 Actions）
3. 存檔

存檔後，`.github/workflows/deploy.yml` 會自動跑。
到 `https://github.com/EugeneYip/fox/actions` 看有沒有綠燈，大約 1–2 分鐘。

跑完之後 `https://eugeneyip.github.io/fox/` 應該能打開（樣式可能會壞掉，
因為 `base` 設定的是根目錄 —— 這是預期的，接上自訂網域後就正常了）。

---

## 第 3 步：改 Porkbun 的 DNS

**誰做：你**　**時間：3 分鐘設定 + 最多幾小時生效**

### 3a. 先關掉現有的轉址

`bellafoxy.com` 原本是 Porkbun 的「URL Forwarding」轉到 `eugeneyip.com/fox.html`。
**這個一定要先關掉**，不然它會蓋過下面設定的 A 記錄。

Porkbun → `bellafoxy.com` → **URL Forwarding** → 刪掉現有的轉址規則。

> **要刪的是「轉址設定」，不是 DNS 記錄。** 2026-09-04 實際做的時候學到：
> 每建一筆 URL 轉址，Porkbun 會自己生兩筆 DNS ——
> 一筆 `ALIAS 主機名 → uixie.porkbun.com`，一筆萬用字元
> `CNAME *.主機名 → uixie.porkbun.com`。在 DNS 頁面把它們刪掉，
> **轉址設定本身還在**，下次它可能又長回來；從 URL Forwarding 頁面刪，
> 那兩筆會一起清掉（實測 24 筆 → 20 筆）。
>
> **只刪該刪的那幾筆。** 這個網域上還有別的轉址（`ig`、`instagram`、
> `poetry`、`youtube`、`yt` 五個），以及**信件用的 MX ×2 與 SPF TXT** ——
> 那些一筆都不能動。刪之前先把整張表列出來對過一次。

### 3b. 設定 DNS 記錄

Porkbun → `bellafoxy.com` → **DNS Records**。刪掉舊的 A / ALIAS 記錄，改成：

| 類型 | 主機（Host） | 值 | 說明 |
|---|---|---|---|
| A | （留空 = 根網域） | `185.199.108.153` | GitHub Pages |
| A | （留空） | `185.199.109.153` | |
| A | （留空） | `185.199.110.153` | |
| A | （留空） | `185.199.111.153` | |
| AAAA | （留空） | `2606:50c0:8000::153` | IPv6，建議一起設 |
| AAAA | （留空） | `2606:50c0:8001::153` | |
| AAAA | （留空） | `2606:50c0:8002::153` | |
| AAAA | （留空） | `2606:50c0:8003::153` | |
| CNAME | `www` | `eugeneyip.github.io` | 結尾不要加路徑 |

> 以上 IP 於 2026-09-04 再次實測確認（`dig eugeneyip.github.io` 的 A 與 AAAA
> 跟這張表完全一致），而且就是照這張表設下去的。
> GitHub 極少更動，但若日後連不上，先回頭核對這一組。
>
> 剛設完的頭幾分鐘，`dig` 有可能只回三筆 AAAA —— 那是四臺權威伺服器
> 還沒同步完，不是漏設。分別問 `maceio`／`salvador`／`fortaleza`／`curitiba`
> 四臺，四臺都回四筆就是好了。

**Porkbun 的替代做法**：Porkbun 支援 `ALIAS` 記錄，可以用一筆
`ALIAS  （留空）  eugeneyip.github.io` 取代上面八筆 A/AAAA。
好處是 GitHub 換 IP 時會自動跟著走。兩種都可以，ALIAS 比較省事。

### 3c. 檢查

DNS 生效後（通常幾分鐘，最久 24 小時）：

```bash
dig +short bellafoxy.com A
dig +short www.bellafoxy.com CNAME
```

第一行應該出現那四個 `185.199.x.153`，第二行應該是 `eugeneyip.github.io.`。

---

## 第 4 步：在 GitHub 綁定網域

**誰做：你**　**時間：1 分鐘 + 等憑證**

> ✅ 2026-09-04 做完。DNS 改完約 **15 分鐘** 後 Let's Encrypt 就簽出憑證
> （`CN=bellafoxy.com`），接著 `https_enforced` 才開得起來 ——
> 太早開會拿到「The certificate does not exist yet」。
> 用指令的話是 `gh api -X PUT repos/EugeneYip/fox/pages -F https_enforced=true`。

1. 回到 `https://github.com/EugeneYip/fox/settings/pages`
2. **Custom domain** 填 `bellafoxy.com` → Save
3. 等 GitHub 顯示 DNS check successful（DNS 沒生效前會顯示錯誤，等一下再試）
4. **勾選 Enforce HTTPS**
   （憑證由 Let's Encrypt 自動簽發，通常 15 分鐘內，偶爾要等一小時）

> `public/CNAME` 這個檔案已經幫你放好了，內容是 `bellafoxy.com`。
> 它會被複製到建置輸出，GitHub Pages 靠它認得自訂網域。
> `deploy.yml` 裡有一道檢查，這個檔案不見的話會直接讓建置失敗 ——
> 因為少了它，GitHub 會默默把自訂網域取消掉，很難察覺。

---

## 完成之後

### 設定同步用的金鑰（選填）

沒有這些，網站照樣運作，只是自動抓文章的功能會少幾個平臺。

到 `https://github.com/EugeneYip/fox/settings/secrets/actions`：

| Secret | 用途 | 怎麼拿 |
|---|---|---|
| `YOUTUBE_API_KEY` | 同步「狐說八道」頻道的影片 | [Google Cloud Console](https://console.cloud.google.com/) → 建立專案 → 啟用 *YouTube Data API v3* → 憑證 → 建立 API 金鑰 |
| `RSSHUB_BASE` | 橋接 Threads、小紅書等沒有 RSS 的平臺 | 自架 [RSSHub](https://docs.rsshub.app/)，或填公用實例（不穩定） |

> **YouTube 不需要金鑰也能同步。** 官方的 Atom feed
> （`youtube.com/feeds/videos.xml?channel_id=…`）可以直接用，會給最近 15 支影片。
>
> 那為什麼還列 `YOUTUBE_API_KEY`？因為那個端點**會間歇性掛掉** ——
> 2026-09-02 上午實測所有頻道都回 404，同日中午就恢復了。
> 有金鑰的話，RSS 掛掉時會自動退回 Data API；沒有的話那次同步就跳過，
> 下次再抓（歷史資料不會掉，同步是只增不刪的合併）。
>
> 另外，API 可以往回抓 15 支以外的完整歷史，RSS 不行。
> 免費配額每天 10,000 units，一次同步只花 1–2 units。

設好之後可以手動觸發一次：
Actions → 「同步各平臺文章」 → Run workflow。

### 日常怎麼運作

```
   每天 08:00 / 20:00（臺北時間）
            │
            ▼
   ┌─────────────────────┐
   │ sync-feeds.yml      │  去各平臺抓新文章
   └─────────┬───────────┘
             │ 有變動 → commit + push
             │ 然後「明確地」呼叫一次 deploy
             ▼  （gh workflow run）
   ┌─────────────────────┐
   │ deploy.yml          │  verify:all → 建置 → 部署
   └─────────┬───────────┘
             ▼
        bellafoxy.com
```

> **為什麼要多那一步「明確呼叫」？**
> GitHub 規定：用 `GITHUB_TOKEN` 做的 push **不會**觸發其他 workflow
> （那是防止 workflow 互相觸發成無限迴圈的機制），只有 `workflow_dispatch`
> 與 `repository_dispatch` 是例外。
>
> 少了那一步，同步抓回來的新影片會躺在 repo 裡、網站永遠不更新，
> 而且完全沒有錯誤訊息 —— 兩個 workflow 都是綠燈。

寫新文章的話，只要 push 到 `main` 就會自動部署。
部署前會跑完整的六道關卡（`npm run verify:all`），任何一道紅燈就不會發佈 ——
網站會停在上一個好的版本。

### GitHub Pages 這台主機會做什麼、不會做什麼

第 2 輪（第二十二圈）實測的兩件事。都不是我們改得動的，
但**不知道的話會把本機的數字當成讀者拿到的數字**。

**一、不供應 brotli。** 兩個確定跑在 Pages 上的主機
（回應標頭 `server: GitHub.com`）都試過，帶著瀏覽器真正會送的
`Accept-Encoding: gzip, deflate, br, zstd`，回來的都是 `content-encoding: gzip`。
只送 `Accept-Encoding: br` 的話它連壓都不壓。
（對照組：Netlify 的站回的是 `br`，所以不是請求寫錯。）

所以 `npm run check:perf` 印的 gzip 數字**就是讀者付的代價**，
brotli 那個數字只有換主機才拿得到（差 19%）。

**二、所有東西的快取都是 10 分鐘。** `cache-control: max-age=600`，
HTML 與帶內容雜湊的 CSS 一視同仁：

```
$ curl -sI https://<某個 Pages 站>/css/screen.css | grep cache-control
cache-control: max-age=600
```

也就是說 Astro 產出的 `_astro/Base.<雜湊>.css` 那種**永遠不會變的檔名**，
在這裡也只快取十分鐘 —— 回訪的讀者每十分鐘要重新驗證一次
（有 `etag`，所以多半是 304，不用重新下載整份）。
Pages 不能自訂回應標頭，要改只能換主機。

### Node 版本

`.nvmrc` 寫的是 `22`（主版本線），CI 會裝最新的 22.x。

`package.json` 的 `engines` 要求 `>=22.19.0` —— 那是相依套件（undici）的實際需求。
本機 Node 比這舊的話，`npm install` 會出現 EBADENGINE 警告。
目前實測在 22.15.1 上建置仍然正常，但那是運氣不是保證；有空的話升上去。

---

## 出問題時

| 症狀 | 通常是什麼 |
|---|---|
| 網站顯示 404 | Pages 的 Source 沒選 GitHub Actions；或 deploy workflow 還沒跑完 |
| 網址跳回 `eugeneyip.com/fox.html` | Porkbun 的 URL Forwarding 沒刪掉 |
| 自訂網域自己消失 | `public/CNAME` 沒被建置出來。`deploy.yml` 有擋這個，檢查 Actions log |
| HTTPS 一直無法啟用 | DNS 還沒完全生效。等到 `dig` 四個 IP 都對了再回去勾 |
| 樣式全壞、圖片 404 | `astro.config.mjs` 的 `base` 被改成 `/fox` 了。綁自訂網域時 `base` 必須是 `/` |
| Actions 跑不動 | 檢查 Settings → Actions → General 有沒有允許 workflow |
| 同步沒抓到東西 | 到網站的 `/colophon` 看來源狀態，或本機跑 `npm run verify` |

---

## 本機開發

```bash
npm install        # 第一次
npm run dev        # http://localhost:4321
npm run build      # 產生 dist/
npm run preview    # 預覽 dist/
npm run check      # 型別檢查
npm run audit:privacy   # 隱私稽核（推之前跑）
npm run verify     # 檢查各來源的 feed 通不通
npm run sync       # 本機手動同步一次
```
