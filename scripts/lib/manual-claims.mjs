// @ts-check
/**
 * 散文裡點名的「這些平臺抓不到，只能手動登錄」，跟平臺目錄說的一樣嗎。
 *
 * ## 為什麼需要
 *
 * 第 6 輪（第二十四圈）數過：「完全沒有 feed／抓不到 RSS 的平臺
 * （Threads、Instagram、微信公眾號）」這句話寫在 **6 個地方** ——
 * 兩份文件、三處程式註解、一個範本檔。
 *
 * 而 `platforms.data.mjs` 說 `threads` 是 `bridge`
 * （有 `bridgeRoute: '/threads/{handle}'`）。真正的 `manual` 是
 * Instagram、微信公眾號、**Behance** —— 而 Behance 一次都沒被提到。
 *
 * 六份說法**完全一致，而且都跟資料不一樣**。一致不代表正確：
 * 它們是互相抄來的，抄的時候資料還沒長出 bridge 那條路。
 *
 * ## 判準
 *
 * 那一句裡點名的平臺，`feedKind` 必須真的是 `manual`。
 * **只點一部分可以** —— 那是舉例不是清單；但點到的不能是抓得到的。
 */

/*
 * 要求那一句**真的在點名**（同一行有一個全形左括號），而不是任何提到
 * 「手動」的句子 —— 後者會把「以手動的為準」這種沒有名單的句子也算進來，
 * 數字看起來很大，其實一個名字都沒查。
 *
 * 只要求左括號、不要求右括號：`content.config.ts` 那一句的名單**跨行**
 * （「（Instagram、微信公眾號、」在上一行，「Behance）」在下一行），
 * 要求成對就會漏掉它 —— 而它正是六處之一。
 */
export const MANUAL_CLAIM = /(完全沒有 feed|抓不到|只能手動|手動寫的)[^\n]*（[^\n]*/g;

/**
 * 平臺在散文裡會被叫的名字。兩種語言的顯示名，加上常見的簡稱。
 * @param {readonly {id: string, name: Record<string, string>, feedKind: string}[]} platforms
 */
export function platformAliases(platforms) {
  /** @type {Map<string, {id: string, feedKind: string}>} */
  const aliases = new Map();
  for (const p of platforms) {
    for (const n of [p.name['zh-TW'], p.name.en].filter(Boolean)) aliases.set(String(n), p);
    if (p.id === 'instagram') aliases.set('IG', p);
  }
  return aliases;
}

/**
 * @param {readonly {rel: string, text: string}[]} files
 * @param {readonly {id: string, name: Record<string, string>, feedKind: string}[]} platforms
 * @returns {{claims: number, wrong: {rel: string, alias: string, kind: string, line: string}[]}}
 */
export function manualClaimProblems(files, platforms) {
  const aliases = platformAliases(platforms);
  const wrong = [];
  let claims = 0;
  for (const { rel, text } of files) {
    for (const m of text.matchAll(MANUAL_CLAIM)) {
      claims++;
      for (const [alias, p] of aliases) {
        if (!m[0].includes(alias)) continue;
        if (p.feedKind === 'manual') continue;
        wrong.push({ rel, alias, kind: p.feedKind, line: m[0].trim().slice(0, 72) });
      }
    }
  }
  return { claims, wrong };
}
