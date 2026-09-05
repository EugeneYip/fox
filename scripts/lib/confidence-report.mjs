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
 * @param {readonly {id: string, confidence?: string, feedTemplate?: string, probeHandle?: string, verifiedAt?: string}[]} platforms
 * @param {{ probed: readonly string[], failed: readonly string[], flaky: ReadonlySet<string>, today?: string }} run
 * @returns {{ lines: string[], mismatches: string[] }}
 */
export function confidenceReport(platforms, { probed, failed, flaky, today }) {
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
    /*
     * ── 沒打到的那些，理由要**加得起來** ──────────────
     *
     * 第 4 輪（第三十一圈）量到的：`lookup-required` 有 9 個，
     * 而這一行寫「這一輪一個都沒打（**8 個**沒有樣板）」——
     * 第 9 個是 `pixnet`，它**有樣板**，只是沒有 `probeHandle`。
     *
     * 8 解釋不了 9。而讀的人會把括號裡那句當成全部的理由，
     * 於是 pixnet 就消失在一個看起來完整的句子裡。
     *
     * 而它正好是最該被看見的那一種：它的樣板 2026-09-02 實測**已經失效**
     * （四個真實部落格全回 HTML 不是 feed），留在資料裡當紀錄 ——
     * 但沒有 probeHandle 就沒有任何一輪會再打它一次。
     * 「有樣板」在目錄上跟一個活著的樣板長得一模一樣。
     *
     * 所以拆成三種，而且加起來一定等於沒打到的總數：
     *   沒有樣板 —— 沒有東西可打
     *   有樣板但沒有 probeHandle —— 有東西可打，但沒有帳號打它
     *   兩個都有卻沒打到 —— 不該發生，發生了要說出來
     */
    const unprobed = list.filter((p) => !probedSet.has(p.id));
    const noTemplate = unprobed.filter((p) => !p.feedTemplate);
    const noHandle = unprobed.filter((p) => p.feedTemplate && !p.probeHandle);
    const unexplained = unprobed.filter((p) => p.feedTemplate && p.probeHandle);
    /** @type {string[]} */
    const why = [];
    if (noTemplate.length > 0) why.push(`${noTemplate.length} 個沒有樣板`);
    if (noHandle.length > 0) {
      why.push(`${noHandle.length} 個有樣板但沒有 probeHandle（${noHandle.map((p) => p.id).join('、')}）——沒有帳號可以打，等於這個樣板沒有人再驗過`);
    }
    if (unexplained.length > 0) {
      why.push(`**${unexplained.length} 個兩個都有卻沒打到**（${unexplained.map((p) => p.id).join('、')}）`);
    }

    let line = `  ${conf.padEnd(16)} ${String(list.length).padStart(2)} 個`;
    if (hit.length === 0) {
      line += `　這一輪一個都沒打（${why.join('、')}）`;
    } else if (bad.length === 0) {
      line += `　這一輪真的打過 ${hit.length} 個，全部通過`;
      if (why.length > 0) line += `；另外 ${unprobed.length} 個沒打（${why.join('、')}）`;
    } else {
      line += `　這一輪真的打過 ${hit.length} 個，其中 ${bad.length} 個失敗`;
      if (why.length > 0) line += `；另外 ${unprobed.length} 個沒打（${why.join('、')}）`;
    }
    /*
     * ── 這個宣稱是什麼時候成立的 ──────────
     *
     * 第 4 輪（第二十八圈）問「這件事是誰決定的，那個人還在嗎」。
     * `confidence: 'verified'` 的意思是「某一次有人跑了 --patterns 看到綠燈」——
     * 而目錄裡**沒有任何欄位記那是哪一天**。
     *
     * git 也答不出來：2026-09-04 為了隱私把 213 個 commit 壓成 1 個，
     * 每一行都 blame 到那一天。壓縮是對的決定，但它有一個沒人記下來的代價 ——
     * 「這一行是什麼時候寫的」對整個 repo 都不再答得出來。
     *
     * 所以日期改成寫在資料裡（`verifiedAt`）。
     * 沒寫的話這裡會點名 —— 一個沒有日期的「已驗證」，跟沒驗證的差別只在語氣。
     */
    if (conf === 'verified') {
      const undated = list.filter((p) => !p.verifiedAt).map((p) => p.id);
      const dates = list.map((p) => p.verifiedAt).filter(Boolean).sort();
      if (dates.length > 0) {
        const oldest = /** @type {string} */ (dates[0]);
        const days = today ? Math.round((Date.parse(today) - Date.parse(oldest)) / 86400000) : null;
        line += `\n  ${' '.repeat(18)}最舊的宣稱：${oldest}${days === null ? '' : `（${days} 天前）`}`;
      }
      for (const id of undated) {
        mismatches.push(
          `${id}：目錄上寫 confidence: 'verified'，但**沒有 verifiedAt** —— ` +
            '沒有日期的「已驗證」說不出它是什麼時候成立的。' +
            '　改法：跑一次 npm run verify -- --patterns，過了就把當天日期寫進 verifiedAt。',
        );
      }
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
