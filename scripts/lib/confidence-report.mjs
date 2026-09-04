// @ts-check
/**
 * 平臺目錄上的 `confidence`，跟剛剛實測的結果對得上嗎。
 *
 * ## 為什麼需要
 *
 * `confidence: 'verified'` 是**寫在資料裡的宣稱**。它是怎麼來的？
 * 某一次有人跑了 `npm run verify -- --patterns`，看到綠燈，就寫上去。
 * 從那之後**沒有任何東西再確認過它**。
 *
 * 第 4 輪（第二十六圈）問「壞了誰會告訴我們」，這一項的答案是：
 * 只有人手動跑 `--patterns` 的時候。而跑完看到的是 24 列，
 * 要自己記得「另一個檔案裡有個 confidence 欄位」再去對 —— 沒有人會這樣做。
 *
 * 所以把那個對照做成輸出的一部分：跑完直接說「這一輪證明了什麼、沒證明什麼」。
 *
 * 第 4 輪（第二十六圈）量到的現況：`verified` 11 個，**11 個都真的打過**；
 * `lookup-required` 9 個與 `documented` 4 個都沒有樣板可打。宣稱與實測一致。
 */

/**
 * @param {readonly {id: string, confidence?: string, feedTemplate?: string, probeHandle?: string}[]} platforms
 * @param {{ probed: readonly string[], failed: readonly string[], flaky: ReadonlySet<string> }} run
 * @returns {{ lines: string[], mismatches: string[] }}
 */
export function confidenceReport(platforms, { probed, failed, flaky }) {
  const probedSet = new Set(probed);
  const failedSet = new Set(failed);

  /** @type {Map<string, typeof platforms[number][]>} */
  const groups = new Map();
  for (const p of platforms) {
    const key = p.confidence ?? '（沒寫）';
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const lines = [];
  const mismatches = [];

  for (const [conf, list] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hit = list.filter((p) => probedSet.has(p.id));
    const bad = hit.filter((p) => failedSet.has(p.id));
    const noTemplate = list.filter((p) => !p.feedTemplate).length;

    let line = `  ${conf.padEnd(16)} ${String(list.length).padStart(2)} 個`;
    if (hit.length === 0) {
      line += `　這一輪一個都沒打（${noTemplate} 個沒有樣板）`;
    } else if (bad.length === 0) {
      line += `　這一輪真的打過 ${hit.length} 個，全部通過`;
    } else {
      line += `　這一輪真的打過 ${hit.length} 個，其中 ${bad.length} 個失敗`;
    }
    lines.push(line);

    /*
     * 只有「宣稱通過、實測失敗」算不一致。
     *
     * 反過來（宣稱推導不出來、卻打通了）不報 —— 那一種本來就不會被打，
     * 而且它是「保守的宣稱」，不會害人。
     */
    if (conf === 'verified' && bad.length > 0) {
      for (const p of bad) {
        mismatches.push(
          `${p.id}：目錄上寫 confidence: 'verified'，而這一輪實測失敗` +
            (flaky.has(p.id) ? '（不過這個端點會一陣一陣地回 404，先重跑一次再說）' : ''),
        );
      }
    }
  }

  return { lines, mismatches };
}
