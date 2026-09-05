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

/** @type {{id: string, confidence?: string, feedTemplate?: string, probeHandle?: string, verifiedAt?: string}[]} */
const PLATFORMS = [
  /* verified 要有 verifiedAt，不然新加的那條會（正確地）點名它們 */
  { id: 'a', confidence: 'verified', feedTemplate: 'https://{handle}/rss', probeHandle: 'x', verifiedAt: '2026-09-05' },
  { id: 'b', confidence: 'verified', feedTemplate: 'https://{handle}/rss', probeHandle: 'y', verifiedAt: '2026-09-05' },
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

/*
 * ── 這個宣稱是什麼時候成立的 ──────────
 *
 * 第 4 輪（第二十八圈）：`confidence: 'verified'` 的意思是「某一次有人
 * 跑了 --patterns 看到綠燈」，而目錄裡沒有欄位記那是哪一天。
 * git 也答不出來 —— 2026-09-04 為了隱私把 213 個 commit 壓成 1 個，
 * 每一行都 blame 到那一天。
 */
{
  /** @type {{id: string, confidence?: string, feedTemplate?: string, probeHandle?: string, verifiedAt?: string}[]} */
  const dated = [
    { id: 'a', confidence: 'verified', feedTemplate: 'x', probeHandle: 'x', verifiedAt: '2026-01-01' },
    { id: 'b', confidence: 'verified', feedTemplate: 'x', probeHandle: 'y', verifiedAt: '2026-03-01' },
  ];
  const { lines, mismatches } = confidenceReport(dated, {
    probed: ['a', 'b'], failed: [], flaky: none, today: '2026-09-05',
  });
  const v = lines.find((l) => l.includes('verified')) ?? '';
  /*
   * 「最舊的」這三個字是判準的一部分，不是修辭。
   *
   * 突變掃描抓到：把「最舊的宣稱：」改成「宣稱：」，這一格照樣綠 ——
   * 而兩者的意思差很多。兩個平臺各有日期時，「宣稱：2026-01-01」讀起來
   * 像那是唯一的日期；「最舊的宣稱」才說得出這是**最壞的情況**。
   */
  check('說出最舊的那個宣稱是哪一天（而且講明那是最舊的）', v.includes('2026-01-01') && v.includes('最舊'), v);
  check('而且說出那是幾天前', /247 天前/.test(v), v);
  check('都有日期就不點名', mismatches.length === 0, JSON.stringify(mismatches));
}

{
  /* verified 卻沒有日期 —— 一個沒有日期的「已驗證」跟沒驗證只差在語氣 */
  const { mismatches } = confidenceReport(
    [{ id: 'c', confidence: 'verified', feedTemplate: 'x', probeHandle: 'z' }],
    { probed: ['c'], failed: [], flaky: none, today: '2026-09-05' },
  );
  check(
    'verified 沒有 verifiedAt：點名，而且說怎麼補',
    mismatches.length === 1 && /沒有 verifiedAt/.test(mismatches[0]) && /--patterns/.test(mismatches[0]),
    JSON.stringify(mismatches),
  );
}

{
  /*
   * 反向：不是 verified 的不需要日期。
   * 少了這一格，把要求擴到所有 confidence 會靜靜通過，
   * 而 lookup-required 本來就沒有「驗過」這回事。
   */
  const { mismatches } = confidenceReport(
    [{ id: 'd', confidence: 'lookup-required' }, { id: 'e', confidence: 'documented' }],
    { probed: [], failed: [], flaky: none, today: '2026-09-05' },
  );
  check('不是 verified 的不要求日期（反向案例）', mismatches.length === 0, JSON.stringify(mismatches));
}

{
  /* 沒有傳 today 的時候不要印出「NaN 天前」 */
  const { lines } = confidenceReport(
    [{ id: 'f', confidence: 'verified', feedTemplate: 'x', probeHandle: 'x', verifiedAt: '2026-01-01' }],
    { probed: ['f'], failed: [], flaky: none },
  );
  const v = lines.find((l) => l.includes('verified')) ?? '';
  check('沒傳今天的日期時不印「NaN 天前」（反向案例）', v.includes('2026-01-01') && !/NaN/.test(v), v);
}

console.log(failed === 0 ? '\n全部通過。\n' : `\n${failed} 項失敗。\n`);
process.exit(failed === 0 ? 0 : 1);
