#!/usr/bin/env node
// @ts-check
/**
 * 失敗步驟的輸出整理 —— `npm run test:step-failure`
 *
 * ## 為什麼需要這個
 *
 * 這幾行只在 **CI 紅燈的時候**才會執行，而十二圈以來 `ci:sim` 一次都沒紅過。
 * 也就是說：它壞掉的時候，剛好就是沒有人有餘裕發現它壞掉的時候 ——
 * 你正在找「哪裡壞了」，而它給你的答案是空白，你會以為是自己的問題。
 *
 * 第 7 輪（第十二圈）故意弄壞四樣東西實測，最嚴重的一條是
 * **stderr 整個被丟掉**：詩的日期打錯時，唯一印出來的是一句進度訊息。
 * 所以第一條案例守的就是「stderr 一定要出現」。
 */
import { formatStepFailure } from './lib/step-failure.mjs';

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
}

console.log('\n失敗步驟的輸出整理\n' + '─'.repeat(64));

// ── 1. stderr 不能被丟掉（實測到的那個 bug）─────────────
{
  /* Astro 的建置錯誤長這樣：全部在 stderr，stdout 只有進度訊息 */
  const out = formatStepFailure({
    stdout: '05:58:10 [content] Syncing content\n',
    stderr: '[InvalidContentEntryDataError] poems → jing-ye-si data does not match collection schema.\n\n  publishedAt: 要寫成日期\n',
  });
  check('stderr 的內容有出現', out.includes('InvalidContentEntryDataError'), out);
  check('連欄位那一行也有', out.includes('publishedAt'), out);
  check('stdout 也還在', out.includes('Syncing content'), out);
  check(
    'stderr 排在 stdout 前面（人只看緊接著的那幾行）',
    out.indexOf('InvalidContentEntryDataError') < out.indexOf('Syncing content'),
    out,
  );
}

// ── 2. 只有 stdout 的步驟（astro check 就是）───────────
{
  const out = formatStepFailure({ stdout: 'src/lib/content.ts:250:7 - error ts(2322)\nResult: 1 error\n' });
  check('只有 stdout 時照樣印得出來', out.includes('error ts(2322)'), out);
  check('不會硬生出一個空的 stderr 區塊', !out.includes('stderr'), out);
}

// ── 3. 兩邊都空 —— 要明講，不要印一行空白 ──────────────
{
  const out = formatStepFailure({});
  check('兩邊都空時說「沒有留下任何輸出」', /沒有留下任何輸出/.test(out), out);
  check('兩邊都空時不會只印出空白', out.trim().length > 0, JSON.stringify(out));
  /* undefined / null 進來也不能炸 —— 這裡本來就是在處理「出事」的路徑 */
  check('傳 undefined 不會爆', /沒有留下任何輸出/.test(formatStepFailure(undefined)));
}

// ── 4. 尾端的空行不可以吃掉視窗 ────────────────────────
{
  /*
   * 實測「日期打錯」那次：stdout 是 3 行內容 ＋ 好幾行空行，
   * 舊的做法直接 slice(-8)，於是視窗裡有一半是空的。
   */
  const out = formatStepFailure({ stdout: '第一行\n第二行\n重要的最後一行\n\n\n\n\n\n\n\n' }, { lines: 3 });
  check('尾端空行被去掉，視窗裡是真的內容', out.includes('重要的最後一行') && out.includes('第一行'), out);
}

// ── 5. 太長的輸出要截，而且要說截了 ───────────────────
{
  const long = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 行`).join('\n');
  const out = formatStepFailure({ stdout: long }, { lines: 5 });
  check('留下最後 5 行', out.includes('第 50 行') && out.includes('第 46 行'), out);
  check('前面的不留', !out.includes('第 45 行'), out);
  check('有講清楚「共 50 行」', /共 50 行/.test(out), out);
}

// ── 6. 每一行都要縮排（不然跟步驟名混在一起）───────────
{
  const out = formatStepFailure({ stderr: 'a\nb' }, { indent: '>>' });
  check('每一行都帶著縮排', out.split('\n').every((l) => l.startsWith('>>')), out);
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
