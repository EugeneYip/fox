/**
 * 圖示網址上的版本記號。
 *
 * ── 為什麼需要它 ──────────────────────────────────
 *
 * 站主 2026-09-11 回報「favicon 仍然是舊版狐狸」。當天實測過：
 * `bellafoxy.com` 供應的 `favicon.svg`／`favicon.ico`／`icon-192.png`／
 * `apple-touch-icon.png` 四個檔案跟版控裡的**逐位元組相同**，而版控裡的
 * 就是 2026-09-09 重畫過的那隻。也就是說**伺服器這一端是對的**，
 * 舊的那隻活在瀏覽器裡。
 *
 * 分頁圖示是所有資源裡被快取得最兇的一種：瀏覽器把它存在自己的
 * favicon 資料庫，而那個資料庫的鍵是**圖示的網址**，不是一般的
 * HTTP 快取規則 —— 所以重新整理、甚至 hard reload 都不一定換得掉。
 * 唯一穩定換得掉的方法是**換一個網址**。
 *
 * 所以這裡拿實際出貨的那幾個檔案算一個短雜湊，接在網址後面。
 * 檔案沒變，雜湊就不變（不會每次建置都讓人重抓）；
 * 哪天狐狸再改一次，網址自己就換了，不必有人記得做這件事。
 *
 * ── 為什麼是檔案內容，不是狐狸的路徑 ──────────────
 *
 * 拿 `fox-mark.ts` 的路徑去算比較省事，但那會說謊：改了幾何卻忘了跑
 * `npm run icons` 的時候，網址會換而檔案還是舊的 —— 讓大家重抓一份
 * 一模一樣的舊圖。要的是「出貨的東西變了沒有」，那就得看檔案本身。
 * （「忘了跑 icons」是另一道守門：`npm run icons -- --check`，
 * 在 `check:generated` 裡。）
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 掛在 <link rel="icon"> 上的那幾個檔案。順序固定，雜湊才穩定 */
const FILES = ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'];

/*
 * ── 為什麼用 process.cwd() 而不是 import.meta.url ──────
 *
 * 先寫成 `new URL('../../public/…', import.meta.url)`，建置當場就爆了：
 *
 *   ENOENT: no such file or directory, open 'dist/public/favicon.svg'
 *
 * 打包之後這個模組住在 `dist/.prerender/chunks/`，`import.meta.url`
 * 指的是**那裡**，往上兩層自然就跑到 `dist/public/` 去了。
 *
 * `astro build` 的工作目錄就是專案根目錄（`ci:sim` 在臨時複本裡跑，
 * 那裡也一樣有 `public/`）。找不到檔案就直接拋 —— 安靜地算出一個
 * 錯的雜湊，等於讓所有人重抓一次圖示而且沒有人知道為什麼。
 */
const hash = createHash('sha256');
for (const name of FILES) {
  const path = resolve(process.cwd(), 'public', name);
  try {
    hash.update(readFileSync(path));
  } catch {
    throw new Error(
      `算不出圖示的版本記號：讀不到 ${path}。` +
        '（這個模組假設建置的工作目錄是專案根目錄 —— 見 src/lib/icons.ts 的說明。）',
    );
  }
}

/** 8 個十六進位字元，夠分辨又不會把網址撐長 */
export const ICON_VERSION = hash.digest('hex').slice(0, 8);

/**
 * 給圖示網址加上版本記號。
 * @param path 例如 `/favicon.svg`
 */
export const iconHref = (path: string): string => `${path}?v=${ICON_VERSION}`;
