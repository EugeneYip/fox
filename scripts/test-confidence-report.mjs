#!/usr/bin/env node
// @ts-check
/**
 * 目錄上的 confidence 對不對得上實測 —— `npm run test:confidence-report`
 *
 * 第 4 輪（第二十六圈）問「壞了誰會告訴我們」。`confidence: 'verified'`
 * 這一項的答案本來是：**只有人手動跑 `--patterns` 的時候**，
 * 而且跑完還要自己記得去另一個檔案對照那個欄位。
 *
 * 現在跑完會直接說出來。這一份守的是那句話不會說錯。
 */
import { confidenceReport } from './lib/confidence-report.mjs';

let failed = 0;
const check = (/** @type {string} */ label, /** @type {boolean} */ ok, /** @type {unknown} */ got) => {
  console.log(`  ${ok ? '✓' : 'X'} ${label}`);
  if (!ok) {
    failed++;
    if (got !== undefined) console.log('      實際：', String(got));
  }
};

/** @type {{id: string, confidence?: string, feedTemplate?: string, probeHandle?: string}[]} */
const PLATFORMS = [
  { id: 'a', confidence: 'verified', feedTemplate: 'https://{handle}/rss', probeHandle: 'x' },
  { id: 'b', confidence: 'verified', feedTemplate: 'https://{handle}/rss', probeHandle: 'y' },
  { id: 'c', confidence: 'lookup-required' },
  { id: 'd', confidence: 'documented' },
];
const none = new Set();

console.log('\nconfidence 與實測的對照\n' + '─'.repeat(56));

{
  const { lines, mismatches } = confidenceReport(PLATFORMS, { probed: ['a', 'b'], failed: [], flaky: none });
  const v = lines.find((l) => l.includes('verified')) ?? '';
  check('全部通過時說「真的打過 2 個，全部通過」', /真的打過 2 個，全部通過/.test(v), v);
  check('沒有不一致就不報', mismatches.length === 0, JSON.stringify(mismatches));
}

{
  /* 這是整支的重點：宣稱 verified、實測失敗 */
  const { lines, mismatches } = confidenceReport(PLATFORMS, { probed: ['a', 'b'], failed: ['b'], flaky: none });
  const v = lines.find((l) => l.includes('verified')) ?? '';
  check('有失敗時說「其中 1 個失敗」', /其中 1 個失敗/.test(v), v);
  check('而且點名那一個是不一致', mismatches.length === 1 && mismatches[0].startsWith('b：'), JSON.stringify(mismatches));
}

{
  /* 那個會一陣一陣回 404 的，要附上「先重跑一次」 */
  const { mismatches } = confidenceReport(PLATFORMS, { probed: ['a'], failed: ['a'], flaky: new Set(['a']) });
  check('會間歇性 404 的平臺附上「先重跑一次」', /先重跑一次/.test(mismatches[0] ?? ''), mismatches[0]);
}

{
  /* 反向：不是 flaky 的就不要附那句 */
  const { mismatches } = confidenceReport(PLATFORMS, { probed: ['a'], failed: ['a'], flaky: none });
  check('不是那一個的不附那句（反向案例）', !/先重跑一次/.test(mismatches[0] ?? ''), mismatches[0]);
}

{
  /*
   * 沒打過的那幾類要講清楚「這一輪一個都沒打」——
   * 否則 `lookup-required 9 個` 這一行讀起來像「9 個都查過了」。
   */
  const { lines } = confidenceReport(PLATFORMS, { probed: [], failed: [], flaky: none });
  const l = lines.find((x) => x.includes('lookup-required')) ?? '';
  check('沒打過的說「一個都沒打」', /一個都沒打/.test(l), l);
}

{
  /*
   * 反過來不算不一致：宣稱推導不出來、卻打通了。
   * 那是保守的宣稱，不會害人 —— 報它只會製造雜訊。
   */
  const { mismatches } = confidenceReport(
    [{ id: 'c', confidence: 'lookup-required', feedTemplate: 'https://{handle}/rss', probeHandle: 'z' }],
    { probed: ['c'], failed: [], flaky: none },
  );
  check('宣稱保守但打通了：不算不一致（反向案例）', mismatches.length === 0, JSON.stringify(mismatches));
}

console.log(failed === 0 ? '\n全部通過。\n' : `\n${failed} 項失敗。\n`);
process.exit(failed === 0 ? 0 : 1);
