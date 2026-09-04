/**
 * 個人資料的本機檔案 —— 範本。
 *
 * 用法：
 *   cp src/config/identity.local.example.ts src/config/identity.local.ts
 *   然後把值填進去。
 *
 * identity.local.ts 已經寫在 .gitignore 裡，**不會**被推上 GitHub。
 * 這個 .example 檔案則會被 commit，所以裡面永遠只能放假資料。
 *
 * 沒有這個檔案時：reveal() 全部回傳 undefined，網站只顯示筆名，
 * 建置完全正常。所以 CI 上不需要它。
 *
 * ## 但這也表示：填了值，**線上也不會出現**
 *
 * 第 7 輪（第十八圈）實測：把這個範本複製成 identity.local.ts 之後，
 * 本機建出來的 /about 會多一段「所在　臺灣」，而從版控建的那一份沒有 ——
 * 因為這個檔案在 .gitignore 裡，CI 拿不到它。
 *
 * 那是刻意的設計（值進不了公開 repo，也就洩漏不了），不是 bug。
 * 要讓線上也顯示，只能走 docs/PRIVACY.md 寫的 secret 那條路。
 * `npm run ci:sim` 最後會把「本機的 dist」與「版控建的 dist」比一次，
 * 差在哪幾頁它會列出來。
 *
 * 提醒：就算填了值，也要 src/config/privacy.ts 對應的開關是 true，
 * 東西才會真的顯示出來。兩道關卡都要過。
 */
import type { Identity } from './privacy';

export const identity: Identity = {
  realName: {
    zh: '王小明',
    en: 'Ming Wang',
  },

  education: {
    zh: { school: '某某大學', dept: '某某學系', degree: '文學士', years: '2019–2023' },
    en: { school: 'Some University', dept: 'Department of Something', degree: 'B.A.', years: '2019–2023' },
  },

  location: {
    country: { zh: '臺灣', en: 'Taiwan' },
    region: { zh: '臺灣・北部', en: 'Northern Taiwan' },
    city: { zh: '某某市', en: 'Somewhere' },
  },

  email: 'hello@example.com',
};
