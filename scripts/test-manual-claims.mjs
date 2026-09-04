#!/usr/bin/env node
// @ts-check
/**
 * 「哪些平臺只能手動登錄」這句話 —— `npm run test:manual-claims`
 *
 * 第 6 輪（第二十四圈）數到：同一句話寫在 6 個地方，6 份完全一致，
 * 而且都跟 `platforms.data.mjs` 不一樣（把 `bridge` 的 Threads 說成抓不到，
 * 又漏掉真正 manual 的 Behance）。
 *
 * **一致不代表正確** —— 它們是互相抄來的。所以這裡守的不是「六份要一樣」，
 * 而是「每一份都要跟資料一樣」。
 */
import { manualClaimProblems, platformAliases } from './lib/manual-claims.mjs';

let failed = 0;
const check = (/** @type {string} */ label, /** @type {boolean} */ ok, /** @type {unknown} */ got) => {
  console.log(`  ${ok ? '✓' : 'X'} ${label}`);
  if (!ok) {
    failed++;
    if (got !== undefined) console.log('      實際：', String(got));
  }
};

/** 假的平臺目錄 —— 三種 feedKind 各一個 */
const PLATFORMS = [
  { id: 'instagram', name: { 'zh-TW': 'Instagram', en: 'Instagram' }, feedKind: 'manual' },
  { id: 'behance', name: { 'zh-TW': 'Behance', en: 'Behance' }, feedKind: 'manual' },
  { id: 'threads', name: { 'zh-TW': 'Threads', en: 'Threads' }, feedKind: 'bridge' },
  { id: 'medium', name: { 'zh-TW': 'Medium', en: 'Medium' }, feedKind: 'rss' },
];

const one = (/** @type {string} */ text) => manualClaimProblems([{ rel: 'x.md', text }], PLATFORMS);

console.log('\n散文裡點名的「抓不到的平臺」\n' + '─'.repeat(56));

{
  const r = one('抓不到 RSS 的平臺（Threads、Instagram）用手動登錄。');
  check('點名一個 bridge 平臺就報', r.wrong.length === 1 && r.wrong[0].alias === 'Threads', JSON.stringify(r.wrong));
}

{
  const r = one('抓不到 RSS 的平臺（Instagram、Behance）用手動登錄。');
  check('點名的都是 manual 就不報', r.claims === 1 && r.wrong.length === 0, JSON.stringify(r));
}

{
  /* 只點一部分是舉例，不是清單 —— 不該因為「沒點滿」就報 */
  const r = one('抓不到的（Instagram）才需要手動加。');
  check('只點一部分不算錯（是舉例不是清單）', r.wrong.length === 0, JSON.stringify(r.wrong));
}

{
  /*
   * 沒有名單的句子不算一句「宣稱」。
   * 少了這一條，「有些平臺抓不到東西，只能手動登錄」這種**沒有名單**的
   * 句子會被算成一句宣稱 —— 數字看起來很大，其實一個名字都沒查。
   *
   * 第一版這一格放的是「以手動的為準」，那句話根本不含任何一個標記詞，
   * 所以它對「有沒有要求名單」完全不敏感 —— 突變掃描當場抓到。
   */
  const r = one('有些平臺抓不到東西，只能手動登錄。');
  check('沒有名單就不算一句宣稱', r.claims === 0, JSON.stringify(r));
}

{
  /*
   * 名單跨行的那一種。`src/content.config.ts` 就是這樣寫的，
   * 判準若要求左右括號成對，這一處會被漏掉 —— 而它正是六處之一。
   */
  const r = one('給抓不到 RSS 的平台（Threads、IG、\n *   微信公眾號）用；');
  check('名單跨行也抓得到', r.claims === 1 && r.wrong.length === 1, JSON.stringify(r));
}

{
  /* 「IG」是 Instagram 的簡稱，散文裡真的這樣寫 */
  const aliases = platformAliases(PLATFORMS);
  check('IG 對應到 Instagram', aliases.get('IG')?.id === 'instagram', aliases.get('IG')?.id);
}

{
  /* rss 平臺被點名同樣是錯的（不是只擋 bridge） */
  const r = one('完全沒有 feed 的平臺（Medium）不要加在這裡。');
  check('點名 rss 平臺也報', r.wrong.length === 1 && r.wrong[0].kind === 'rss', JSON.stringify(r.wrong));
}

console.log(failed === 0 ? '\n全部通過。\n' : `\n${failed} 項失敗。\n`);
process.exit(failed === 0 ? 0 : 1);
