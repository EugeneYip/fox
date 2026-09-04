# 隱私設定

網站上要出現哪些真實資訊，全部在這裡控制。

---

## 兩個檔案，兩件事

| 檔案 | 放什麼 | 會被推上 GitHub 嗎 |
|---|---|---|
| `src/config/privacy.ts` | **開關** —— 要不要顯示 | ✅ 會（公開 repo，任何人都看得到） |
| `src/config/identity.local.ts` | **值** —— 本名、學歷、email | ❌ 不會（在 `.gitignore` 裡） |

**為什麼要分開：** `EugeneYip/fox` 是公開 repo。如果本名寫在
`privacy.ts` 裡，就算開關關著、網站上一個字都不顯示，任何人到 GitHub 上
還是讀得到。那道閘門等於沒關。

所以 repo 裡永遠不會有真實個資。想顯示的話，本機建一個
`identity.local.ts` —— 那個檔案只存在你的電腦上。

---

## 要顯示本名該怎麼做

**兩道關卡都要過**，缺一不可。

### 第一道：本機建立個資檔

```bash
cp src/config/identity.local.example.ts src/config/identity.local.ts
```

打開新檔案，把假資料換成真的：

```ts
export const identity: Identity = {
  realName: { zh: '真實姓名', en: 'Real Name' },
  education: {
    zh: { school: '某某大學', dept: '某某學系', degree: '文學士', years: '2019–2023' },
    // en 可以只填要用的
  },
  location: {
    country: { zh: '臺灣', en: 'Taiwan' },
    city: { zh: '某某市', en: 'Somewhere' },
  },
  email: 'hello@example.com',
};
```

### 第二道：打開對應的開關

`src/config/privacy.ts`：

```ts
export const privacy: PrivacyConfig = {
  showRealName: true,     // ← 從 false 改成 true
  showEducation: true,
  showLocation: 'city',   // 'none' | 'country' | 'region' | 'city'
  // ...
};
```

### ⚠️ 但這樣會有一個問題

`identity.local.ts` 不會被推上 GitHub，所以 **GitHub Actions 上沒有那個檔案**，
建置出來的網站還是不會顯示本名。

三個選擇：

1. **不要顯示本名**（推薦，也是預設）。筆名「狐狸 / Fox」就夠了。
2. **接受它只在本機看得到**。開關打開，但線上版本仍顯示筆名。
3. **把個資檔放進 GitHub Secret**。在 workflow 裡於建置前寫出這個檔案。
   這代表個資會存在 GitHub 的 Secret 裡（加密，但 GitHub 保管）。
   要這樣做的話，在 `deploy.yml` 的「安裝相依套件」之後加一步：

   ```yaml
   - name: 還原本機身分檔
     if: ${{ secrets.IDENTITY_LOCAL != '' }}
     run: printf '%s' "${{ secrets.IDENTITY_LOCAL }}" > src/config/identity.local.ts
   ```

   > 提醒：這一步等於把個資交給 GitHub 保管，而且任何有 repo 寫入權限的人
   > 都可能透過 workflow 把它印出來。除非真的必要，否則不建議。

---

## 開關一覽

「⚠ 這個開關沒有接上」的意思是：**改它不會有任何效果**。
那幾個記錄的是一個決定，不是一道閘門 —— 真正在守那件事的是誰，寫在同一格裡。
（以 `privacy.ts` 的 `UNWIRED_SWITCHES` 為準，`npm run audit:privacy` 會兩邊對。）

### 身分

| 開關 | 預設 | 影響 |
|---|---|---|
| `showRealName` | `false` | 關於頁的本名 |
| `showEducation` | `false` | 校名、科系、學位 |
| `showTimelineYears` | `false` | 就學年份（年份能反推年齡） |
| `showLocation` | `'country'` | 地點粒度：`none` / `country` / `region` / `city` |
| `showEmail` | `false` | 可點擊的 email |
| `showBirthday` | `false` | ⚠ 這個開關沒有接上 —— 改成 `true` 不會有任何效果。`Identity` 裡沒有生日這個欄位。真的有人把生日寫進頁面時，擋住他的是稽核的身分規則 |
| `showRelationship` | `false` | ⚠ 這個開關沒有接上 —— 同上，沒有任何程式碼讀它 |

即使結構化資料（JSON-LD）也**永遠只用筆名**，
不管 `showRealName` 是什麼。那個欄位會被 Google 抓進知識圖譜，一旦進去很難撤回。

### 追蹤與第三方

| 開關 | 預設 | 影響 |
|---|---|---|
| `analytics` | `'none'` | 型別上只允許 `'none'` —— 要加分析工具得先改型別，逼你想清楚 |
| `allowThirdPartyEmbeds` | `false` | `false` = YouTube 按了才載入 |
| `allowRemoteFonts` | `false` | ⚠ 這個開關沒有接上。「只用系統字型」是由 `tokens.css`（只寫系統字型堆疊）與稽核的 `google-fonts` 規則守的 |

### 爬蟲

| 開關 | 預設 | 影響 |
|---|---|---|
| `indexing` | `'allow'` | 改成 `'noindex'` 可整站不被搜尋引擎收錄 |
| `allowAiCrawlers` | `false` | `false` = `robots.txt` 擋掉 GPTBot、ClaudeBot 等 13 種訓練爬蟲，另外放行 5 種檢索／引用爬蟲 |
| `strictReferrerPolicy` | `true` | 外連加 `rel="noreferrer"` |
| `stripImageExif` | `true` | ⚠ 這個開關沒有接上。EXIF 是 Astro 的圖片管線清掉的（重新編碼成 WebP 時就沒了），改成 `false` 也不會保留。`npm run clean-images` 是另外一支手動工具，它不讀這個開關 |

> `robots.txt` 只是「請求」，守規矩的爬蟲會遵守，不守規矩的不會。
> 這是一個態度宣示，不是技術防護。

---

## 稽核

```bash
npm run audit:privacy
```

會檢查：

- 有沒有人把本名、校名**直接寫死**在頁面裡（繞過 `reveal()`）
- 有沒有引進 Google Fonts、分析工具、第三方 CDN
- 有沒有直接嵌入 YouTube iframe（應該用 `VideoFacade`）
- 外連有沒有漏掉 `rel`
- **`identity.local.ts` 或 `.env` 有沒有不小心被 git 追蹤** ← 最重要的一項

CI 每次 push 都會跑。有 error 就擋下來。

### 那些「本名、校名」的字串從哪來

**不在 repo 裡。** 這一點是第 5 輪（第二圈）修的 ——
在那之前，四條身分規則把真值寫死在正則裡：

```js
pattern: /她的本名/g        // ← 這裡原本是真的名字。為了檢查本名有沒有進 repo，把本名寫進了 repo
```

而 `scripts/audit-privacy.mjs` 在自己的 ALLOWLIST 裡，所以它是
**唯一含有個資、卻剛好不會被檢查到的檔案**。從第一個 commit 就在裡面。

現在值有兩個來源，都不在版控裡：

| 情境 | 來源 |
|---|---|
| 本機開發 | `src/config/identity.local.ts`（在 `.gitignore`） |
| CI | `PRIVACY_NEEDLES` secret，一行一個值 |

只取這幾個欄位：`realName`、`school`、`dept`、`city`、`email`。
**刻意不含** `country`、`region`、`degree`、`years` —— `privacy.ts` 的
預設本來就允許顯示到國家層級，把「臺灣」當成要防的字串只會製造滿螢幕的誤報。

兩個來源都沒有的時候，稽核會印：

```
⚠ 身分規則沒有執行 —— 找不到 identity.local.ts，也沒有 PRIVACY_NEEDLES
```

這一行很重要。「乾淨」如果是因為「根本沒檢查」，那是最危險的一種綠燈。

### 改規則之前

```bash
npm run test:privacy-rules
```

每一條規則都測「該抓到的有抓到」與「不該抓到的沒抓到」。
第二個方向同樣重要：**把隱私規則改寬鬆是有風險的動作**，
改過頭會漏掉真的洩漏，而且不會有任何地方報錯。
加新規則而沒加測試案例的話，這支測試會直接失敗。

---

## 萬一個資已經推上去了

推上公開 repo 之後，光刪檔案是不夠的 —— git 歷史紀錄裡還在，
而且 GitHub 可能已經被鏡像或被爬過。

```bash
# 1. 先從追蹤中移除
git rm --cached src/config/identity.local.ts
git commit -m "移除個資檔"

# 2. 確認 .gitignore 有擋住
grep identity.local .gitignore

# 3. 歷史紀錄要另外處理
```

第 3 步的選項：

- **最乾淨**：刪掉整個 repo，重新建一個，重新推（這個專案還很新，成本很低）
- **改寫歷史**：`git filter-repo --path src/config/identity.local.ts --invert-paths`
  然後 force push。但 fork 和快取可能還留著
- **當作已經公開**：如果洩漏的只是本名這類本來也查得到的資訊，
  評估一下是不是真的需要處理

以現在這個階段（repo 還是空的），第一個選項最實際。

---

## 為訪客做的事

這些不是設定，是這個網站的固定行為：

- 沒有 cookie
- 沒有分析工具、沒有像素、沒有指紋辨識
- 沒有外部字型、外部 CDN、外部圖片
- `localStorage` 只存兩個值：主題偏好、詩詞排版偏好。都不離開瀏覽器
- 影片按下播放才載入，而且用 `youtube-nocookie.com`
- 外連一律 `rel="noopener noreferrer"`

伺服器層級的存取紀錄由 GitHub Pages 保管，這部分不在控制範圍內 ——
`/privacy` 頁面上有誠實說明這一點。
