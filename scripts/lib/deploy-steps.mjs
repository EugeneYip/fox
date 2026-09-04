// @ts-check
/**
 * 從 `deploy.yml` 抽出「這個 workflow 會跑哪些 `npm run`」—— 抽出來是為了能測。
 *
 * ## 為什麼要小心
 *
 * `ci:sim` 的整個價值建立在「它跑的跟 CI 跑的是同一串」之上。
 * 第 7 輪（第十圈）把寫死的陣列改成從 `deploy.yml` 讀出來，理由是
 * 「走鐘的時候不會有任何徵兆 —— 模擬照樣全綠，只是綠的是別的東西」。
 *
 * 第 7 輪（第十三圈）發現那句話對抽取本身也成立。原本的抽取是
 * `/^\s*run:\s*npm run ([\w:-]+)\s*$/gm` —— **只認單行**。把
 * `run: npm run test:built` 改寫成
 *
 *     run: |
 *       npm run test:built
 *
 * （完全合法，GitHub 照跑），`ci:sim` 就從三步變兩步，
 * 而且照樣印「照 deploy.yml 的順序跑完，全部通過」——
 * 綠燈的是一個**少跑一道關卡**的模擬。少掉的那道剛好是 `test:built`，
 * 也就是 `verify:all` 蓋不到的那一半（`check:copy` 與 `check:content`）。
 *
 * 這一圈的問題是「案例是不是都長得太像了」：
 * `test-workflow-rules.mjs` 的假 workflow **每一個 step 都是單行 `- run:`**，
 * 而真的 `deploy.yml` 裡本來就有一個 `run: |` 區塊（CNAME 那道）。
 */

/**
 * 把註解的部分抹成空白，**行數與行號完全不變**。
 *
 * 為什麼需要「行號不變」：`check-workflows.mjs` 的 `unknown-script` 與
 * `needs-dist-before-build` 要回報行號，所以不能整行刪掉。
 *
 * 為什麼需要它：第 7 輪（第十六圈）的誤報探針量到三個 ——
 * 註解裡提到一個已經改名的 script、註解在建置之前提到需要 dist 的 script、
 * `run: |` 區塊裡的 shell 註解。三個都不是錯，**都是在講那件事**。
 *
 * 引號要認：`run: echo "tag #1"` 裡的井號不是註解。只認前面是行首或空白的
 * 那種（YAML 與 shell 都是這個規矩）。
 *
 * @param {string} yml
 */
export function withoutComments(yml) {
  return yml
    .split('\n')
    .map((line) => {
      let quote = '';
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = '';
          continue;
        }
        if (c === '"' || c === "'") {
          quote = c;
          continue;
        }
        if (c === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/**
 * @param {string} yml  deploy.yml 的內容
 * @returns {string[]} 照出現順序的 script 名稱（可能重複，重複也是事實）
 */
export function deployStepsFrom(yml) {
  /** @type {string[]} */
  const steps = [];
  /** 目前在區塊純量裡的話，記著開頭那一行的縮排；不在的話是 -1 */
  let blockIndent = -1;

  for (const raw of yml.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trimStart();

    if (blockIndent >= 0) {
      if (indent > blockIndent) {
        // 區塊純量裡面是 shell —— 註解用 #，跟 YAML 一樣
        if (!body.startsWith('#')) {
          for (const m of body.matchAll(/npm run ([\w:-]+)/g)) steps.push(m[1]);
        }
        continue;
      }
      blockIndent = -1;
    }

    /*
     * 這裡不需要跳過 YAML 的註解行。突變掃描量過：把這個判斷拿掉，
     * 十六個案例一個都不會變 —— 因為註解行的開頭是 `#`，
     * 下面兩個樣式（`run: npm run X` 與區塊開頭）本來就都配不到它。
     * 留一個沒有作用的判斷會讓下一個人以為它擋著什麼。
     */
    /*
     * 行尾的註解要先剝掉。YAML 裡「空白 ＋ #」之後是註解，所以
     * `run: npm run test:built  # 只有這裡跑得動` 的值仍然是那一行指令，
     * GitHub 照跑 —— 而只認到行尾的樣式會漏掉它。
     * （這一格是突變掃描逼出來的：把 `$` 放寬的突變靜靜通過，
     * 追下去才發現放寬之後反而比較對。）
     */
    const single = body.replace(/\s+#.*$/, '').match(/^-?\s*run:\s*npm run ([\w:-]+)\s*$/);
    if (single) {
      steps.push(single[1]);
      continue;
    }
    /* `run: |`、`run: >`、`run: |-` 都是區塊純量的開頭 */
    if (/^-?\s*run:\s*[|>][-+]?\s*$/.test(body)) blockIndent = indent;
  }
  return steps;
}

/**
 * 抽完自己驗一次。
 *
 * 不比對一份寫死的清單（那就又是「同一件事寫在兩個地方」），
 * 而是問：**這份 YAML 裡提到的每一個 `npm run X`，抽取都抽到了嗎？**
 * 抽取漏掉某種寫法時，這裡會當場說出來。
 *
 * @param {string} yml
 * @param {string[]} steps  deployStepsFrom() 的結果
 * @returns {string[]} 提到了但沒被抽到的名字
 */
export function unextracted(yml, steps) {
  const withoutComments = yml
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  const mentioned = [...withoutComments.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
  return [...new Set(mentioned)].filter((n) => !steps.includes(n));
}

/**
 * `deploy.yml` 有幾步、其中幾步本機模擬得了。
 *
 * ── 為什麼需要這個 ──────────────────────────────────
 *
 * 第 7 輪（第二十一圈）問「這個檢查實際上判斷過多少東西」，
 * 而 `ci:sim` 的答案是：**deploy.yml 的十步裡，它跑的是其中五步**。
 * 另外五步是 GitHub 的 action（checkout、setup-node、設定 Pages、
 * 上傳、部署）—— 本機沒有那個環境，模擬不了。
 *
 * 沒有這個數字的話，「照 deploy.yml 的順序跑完，全部通過」讀起來像
 * 「部署會成功」。而**真正把東西送出去的那兩步，正好在模擬不到的那一半**。
 *
 * 判準只看 step 的第一個鍵（`- run:` 或 `- uses:`），不解析整份 YAML ——
 * 這個 repo 拿正則剖結構化資料踩過很多次，所以這裡只認 step 的開頭那一行，
 * 認不出來的算進 `other` 而不是硬歸類。
 *
 * **已知的界線**：`run: |` 區塊裡如果有一行本身就長成 `- uses: …`
 * （不是包在引號或 echo 裡），會被多算一步。測試涵蓋了
 * `echo "- uses: …"` 那種，裸的那種沒有 —— 那要真的剖 YAML 才分得開。
 * 這個數字是**說明用的**（校正「全部通過」該怎麼讀），不是關卡，
 * 所以停在這裡；哪天它變成會擋人的東西，就得換成真的剖析器。
 *
 * @param {string} yml
 * @returns {{ run: number, uses: number, other: number, total: number }}
 */
export function stepKinds(yml) {
  let run = 0;
  let uses = 0;
  let other = 0;
  /** step 的開頭是 `- ` 開頭的那一行；它的第一個鍵決定這一步是什麼 */
  const lines = yml.split('\n');
  for (const [i, raw] of lines.entries()) {
    const m = /^(\s*)-\s+(\w+):/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    let kind = m[2];
    /*
     * `- name: …` 是最常見的寫法，真正的種類在下一個同層的鍵上。
     * 往下找到縮排比 `- ` 深、而且還在這一步裡面的第一個 run/uses。
     */
    if (kind === 'name') {
      kind = 'other';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (!next.trim() || next.trimStart().startsWith('#')) continue;
        const ind = next.length - next.trimStart().length;
        if (ind <= indent) break; // 已經是下一步（或上一層）了
        const k = /^\s*(\w+):/.exec(next)?.[1];
        if (k === 'run' || k === 'uses') {
          kind = k;
          break;
        }
      }
    }
    if (kind === 'run') run++;
    else if (kind === 'uses') uses++;
    else other++;
  }
  return { run, uses, other, total: run + uses + other };
}
