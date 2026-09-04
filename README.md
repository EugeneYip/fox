<div align="center">

<img src="public/icon-192.png" width="72" alt="">

# 狐說八道

**[bellafoxy.com](https://bellafoxy.com)**

一隻狐狸，說古人的話。

</div>

---

朗誦經典詩詞曲，用今天的話說出其中的意思。
這裡放的是三十秒短片裝不下的部分：注解、版本、為什麼這一句要這樣讀。

## 這是什麼

一個純靜態網站，掛在 GitHub Pages 上。

- **零追蹤** — 沒有 cookie、沒有分析工具、沒有任何第三方請求
- **零 JavaScript 起步** — 全站只有四小段增強腳本，關掉也能讀
- **雙語** — 繁體中文（主）、English
- **多平臺聚合** — 24 個平臺的目錄，能自動抓的自動抓，抓不到的手動收
- **詩詞直排** — 中文詩詞用它本來的樣子排

## 快速開始

```bash
npm install
npm run dev        # http://localhost:4321
```

## 指令

| 指令 | 做什麼 |
|---|---|
| `npm run dev` | 開發伺服器 |
| `npm run build` | 建置到 `dist/` |
| `npm run preview` | 預覽建置結果 |
| `npm run verify:all` | **一次跑完五道關卡**（型別／隱私／對比／建置／無障礙／效能） |
| `npm run check` | TypeScript 型別檢查 |
| `npm run check:contrast` | WCAG 對比度（讀 tokens.css，深淺兩套） |
| `npm run check:a11y` | 無障礙靜態檢查（掃 dist/） |
| `npm run check:perf` | 效能預算（gzip 後的實際傳輸量） |
| `npm run audit:privacy` | 隱私稽核（推之前跑） |
| `npm run verify` | 檢查各平臺的 feed 通不通 |
| `npm run handle <帳號名>` | 查一個帳號名在哪些平臺上存在 |
| `npm run sync` | 手動抓一次外部平臺的文章 |
| `npm run sync:dry` | 同上，但不寫檔 |
| `npm run clean-images` | 清掉圖片的 EXIF（GPS、機型） |

## 文件

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | **接手入口** —— 人或 AI 都從這裡開始 |
| [CLAUDE.md](CLAUDE.md) | 在這裡寫程式的規矩、已知的坑、語氣約定 |
| [STATE.md](docs/STATE.md) | **現在到哪了** —— 接手的人先看這份 |
| [DEPLOY.md](docs/DEPLOY.md) | **上線步驟** —— DNS、GitHub Pages、金鑰設定 |
| [CONTENT.md](docs/CONTENT.md) | **怎麼寫東西** —— 給不寫程式的人看的 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 為什麼這樣設計 |
| [PRIVACY.md](docs/PRIVACY.md) | 隱私開關怎麼調 |
| [PLATFORMS.md](docs/PLATFORMS.md) | 24 個平臺的對照表（自動產生） |
| [REVIEW-LOG.md](docs/REVIEW-LOG.md) | 週期性自我檢查的輪替順序與紀錄 |

## 結構

```
src/
├── config/       設定（站台、隱私、平臺、來源）
├── content/      內容（詩詞、文章、短札、外站）
├── lib/          資料存取層
├── i18n/         多語言
├── components/   元件
├── pages/        路由
└── styles/       設計語彙
scripts/          同步、稽核、產圖
docs/             文件
```

## 技術

[Astro 7](https://astro.build) · TypeScript · 零框架 · GitHub Pages

## 授權

程式碼採 MIT。**文章、詩詞注解與翻譯保留所有權利** —— 那些是一個字一個字寫出來的。
