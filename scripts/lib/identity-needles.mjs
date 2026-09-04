// @ts-check
/**
 * 要在原始碼裡搜尋的個資字串 —— 從**不在版控裡的地方**取得。
 *
 * ## 為什麼會有這個檔案
 *
 * 第 5 輪（第二圈）發現：`audit-privacy.mjs` 的四條身分規則把真實的本名、
 * 校名、城市直接寫死在正則裡 ——
 *
 *     pattern: /她的本名/g
 *     pattern: /她的校名|Xxxxx\s+University/g
 *
 * 而這個檔案在自己的 ALLOWLIST 裡，所以**唯一含有個資的檔案，剛好豁免於
 * 自己的檢查**。整套隱私架構（privacy.ts 只放開關、值放在 gitignore 的
 * identity.local.ts、一律走 reveal()）的目的就是不讓這些字串進 repo，
 * 結果偵測器本身把它們帶了進去，而且從第一個 commit 就在裡面。
 *
 * ## 值從哪裡來
 *
 * 兩個來源，都不在版控裡：
 *
 * 1. `src/config/identity.local.ts` —— 本機開發用（.gitignore 裡）
 * 2. `PRIVACY_NEEDLES` 環境變數 —— CI 用，一行一個值，設成 repo secret
 *
 * ## 兩個都沒有的時候
 *
 * 身分規則**不會**執行。這時候一定要大聲講出來 ——
 * 否則 audit 印出「乾淨」，而讀的人以為本名有被檢查過，其實沒有。
 * 「安靜地什麼都沒檢查」比「明講檢查不了」危險得多。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * 只有這些欄位算個資。
 *
 * 刻意**不含** country、region、degree、years —— privacy.ts 的預設就允許
 * 顯示到國家層級，把「臺灣」當成要防的字串只會製造滿螢幕的誤報。
 */
const SENSITIVE_KEYS = ['realName', 'school', 'dept', 'city', 'email'];

/**
 * @param {string} root  專案根目錄
 * @returns {{ needles: string[], source: 'local-file'|'env'|'none', detail: string }}
 */
export function readIdentityNeedles(root) {
  const env = process.env.PRIVACY_NEEDLES?.trim();
  if (env) {
    const needles = env
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    return { needles, source: 'env', detail: `PRIVACY_NEEDLES（${needles.length} 個值）` };
  }

  const file = resolve(root, 'src/config/identity.local.ts');
  if (!existsSync(file)) {
    return { needles: [], source: 'none', detail: '找不到 identity.local.ts，也沒有 PRIVACY_NEEDLES' };
  }

  /*
   * 用純文字取值，不 import。
   *
   * identity.local.ts 是 TypeScript，Node 沒辦法直接載入（要開實驗性旗標）。
   * 而這裡要的東西很單純 —— 設定物件裡的字串字面值 —— 用不著剖析器。
   *
   * 巢狀不影響：`school: '…'` 不管包在 zh 還是 en 底下都一樣配得到。
   */
  const text = readFileSync(file, 'utf8');
  const needles = extractValues(text);

  /*
   * ── 還是範本的值，那就不是她的個資 ────────────────
   *
   * 第 5 輪（第二十圈）走這條路時量到的：把 `identity.local.example.ts`
   * 複製成 `identity.local.ts`、還沒填真值就跑稽核，會得到 **15 個
   * identity-value 錯誤**，而它們全部落在三個地方：範本檔自己、
   * 用同一組假值當 fixture 的測試、以及紀錄裡引用過的那一行。
   *
   * 三個都是**應該**含有那些字串的檔案。而訊息說的是
   * 「這是 identity.local.ts 裡的個資，不能出現在會進版控的檔案裡」——
   * 照著做的話她會去改範本跟測試，兩個都會壞。
   *
   * 更重要的是：那時候身分規則**其實什麼都沒在守** ——
   * 它在找一組假名字。那正是「綠得因為空」換一個樣子。
   * 所以把這種情況說出來，而不是報一堆錯。
   */
  const examplePath = resolve(root, 'src/config/identity.local.example.ts');
  /* 兩份用**同一個**抽法 —— 不然範本比對會漏掉巢狀的那幾個 */
  const exampleValues = existsSync(examplePath)
    ? extractValues(readFileSync(examplePath, 'utf8'))
    : new Set();
  const stillExample = [...needles].filter((n) => exampleValues.has(n));
  const real = [...needles].filter((n) => !exampleValues.has(n));

  if (real.length === 0) {
    return {
      needles: [],
      source: 'none',
      detail:
        'identity.local.ts 裡還是範本的值（' +
        stillExample.slice(0, 2).join('、') +
        '⋯）—— 那不是你的資料，身分規則等於在找一組假名字。先把值填成真的。',
    };
  }

  /*
   * 填了一部分的情況：真的值照常守，**範本值不當成 needle** ——
   * 不然它們會去撞範本檔與測試的 fixture，而那兩個本來就該含有那些字串。
   */
  return {
    needles: real,
    source: 'local-file',
    detail:
      `identity.local.ts（${real.length} 個值）` +
      (stillExample.length > 0
        ? `，另外 ${stillExample.length} 個還是範本的值（沒有拿來比對）`
        : ''),
  };
}

/**
 * 從一份 identity 檔裡抽出所有敏感值（`identity.local.ts` 與範本共用）。
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function extractValues(text) {
  const out = new Set();
  for (const key of SENSITIVE_KEYS) {
    const re = new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
    for (const m of text.matchAll(re)) {
      const v = m[1].trim();
      if (v.length >= 2) out.add(v);
    }
    for (const v of blockValues(text, key)) if (v.length >= 2) out.add(v);
  }
  return out;
}

/**
 * `key: { … }` 這種**巢狀**寫法底下的字串值。
 *
 * ## 為什麼需要這個
 *
 * 第 5 輪（第二十圈）第一次真的建了 `identity.local.ts` 再看抽出來的
 * needles，只有三種：`school`、`dept`、`email`。
 * **`realName` 與 `city` 一個都沒有** —— 因為它們在檔案裡長這樣：
 *
 *     realName: { zh: '王小明', en: 'Ming Wang' },
 *     city: { zh: '某某市', en: 'Somewhere' },
 *
 * 而原本的樣式要求冒號後面**直接**是引號。也就是說五個敏感鍵裡有兩個
 * 從來沒有作用過，其中一個是**本名** —— 而稽核的說明寫著
 * 「沒有這一步的話，本名／校名有沒有被貼進頁面，這支腳本查不到」，
 * 讀起來像是有了這一步就查得到。查不到。
 *
 * 用數大括號深度的方式取那一段，不用巢狀正則。
 *
 * @param {string} text
 * @param {string} key
 * @returns {string[]}
 */
function blockValues(text, key) {
  const out = [];
  const open = new RegExp(`\\b${key}\\s*:\\s*\\{`, 'g');
  for (let m; (m = open.exec(text)); ) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    const block = text.slice(m.index + m[0].length, i - 1);
    for (const q of block.matchAll(/['"`]([^'"`\n]+)['"`]/g)) out.push(q[1].trim());
  }
  return out;
}

const escapeRe = (/** @type {string} */ c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 把一個值變成「它在檔案裡實際會長成的各種樣子」都對得上的樣式。
 *
 * ## 為什麼不是直接比字串
 *
 * 第 5 輪（第十三圈）拿三個假值、十種寫法各種一次，量到：
 * **十種裡只有三種被抓到，而那三種都是原樣。**
 *
 *   抓到  原樣的名字／email／中文校名
 *   漏掉  全大寫、全小寫、email 的網域大寫
 *   漏掉  被 markdown 手動折行拆成兩行（中文與英文都是）
 *   漏掉  中間多一個空白
 *   漏掉  網址裡的百分比編碼（空白變成 %20、中文變成一串 %E7%…）
 *
 * 而測試那三條斷言用的字串**跟針一模一樣**，所以十三圈以來
 * 沒有任何東西問過「同一個值換個寫法還抓不抓得到」。
 *
 * ## 現在允許什麼
 *
 * - 大小寫不分（`i`）—— 名字與校名在標題、句首、全大寫的橫幅裡都會變形
 * - 值裡的空白可以是任意空白（含換行）
 * - **字元之間可以夾一個換行** —— 這個 repo 的文件是手動折行的，
 *   中文更會在詞中間斷開。只允許換行、不允許空白，是為了不製造誤報：
 *   要湊出誤報得剛好出現整串字元、而且只被換行隔開
 * - 引號前面可以有反斜線（`'O\\'Brien'` 這種寫在字串字面值裡的情況）
 * - 另外比對一份**百分比編碼**的版本（網址裡的樣子）
 *
 * 刻意沒做：HTML 實體與 JSON 逃脫。身分規則只掃版控裡的原始碼，
 * 不掃 `dist/`，那兩種在原始碼裡幾乎不會出現（記進待辦）。
 *
 * @param {string} value
 */
function flexiblePattern(value) {
  /* 只允許被「換行」拆開，不允許被空白拆開 —— 見上面的理由 */
  const BREAK = '(?:[ \\t]*\\r?\\n[ \\t]*)?';
  const parts = [...value].map((c) => {
    if (/\s/.test(c)) return '\\s+';
    if (c === "'" || c === '"') return '\\\\?' + escapeRe(c);
    return escapeRe(c);
  });
  return parts.join(BREAK);
}

/**
 * 把值變成規則。跟其他規則同一個形狀，audit 那邊不用特別處理。
 *
 * @param {string[]} needles
 * @returns {import('./privacy-rules.mjs').PrivacyRule[]}
 */
export function identityRules(needles) {
  if (needles.length === 0) return [];
  /*
   * 每個值兩種樣式：原樣（放寬過的）與百分比編碼過的。
   * 編碼過的那份不需要再放寬 —— 網址裡不會有換行。
   */
  const alts = needles.flatMap((n) => {
    const encoded = encodeURIComponent(n);
    return encoded === n ? [flexiblePattern(n)] : [flexiblePattern(n), escapeRe(encoded)];
  });
  return [
    {
      id: 'identity-value',
      level: 'error',
      pattern: new RegExp(alts.join('|'), 'gi'),
      why: '這是 identity.local.ts 裡的個資，不能出現在會進版控的檔案裡。請改用 reveal()。',
    },
  ];
}
