#!/usr/bin/env node
// @ts-check
/**
 * 建置管線規則的實測 —— `npm run test:workflow-rules`
 *
 * 每一條規則做一份「該響」的假專案（假 workflow + 假 package.json + 假 .nvmrc），
 * 跑 check-workflows，確認擋下來的是**那一條**。另外做一份乾淨的，確認不誤報。
 *
 * ## 為什麼需要這個
 *
 * `check-workflows.mjs` 存在的理由是「三個 workflow 到現在一次都沒有在
 * GitHub 上跑過」—— 它是那三份檔案唯一的守門人。
 * 而到第 7 輪（第六圈）為止，**它自己的四條規則一個案例都沒有**。
 *
 * 更難看的是：第 3 輪（第六圈）我在紀錄裡寫「沒有一支檢查腳本是沒有測試的了」。
 * 那句話是錯的 —— 當時只數了 `scripts/test-*.mjs` 的清單，
 * 而 `check:workflows` 出現在 `test:units` 裡是因為**它自己被當成一項檢查跑**，
 * 不是因為有人測過它。「清單上有」跟「被測過」是兩件事。
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 一份最小但完整的假專案，個別案例再覆寫掉要壞的那一份 */
const base = () => ({
  'package.json': JSON.stringify({
    scripts: {
      'verify:all': 'npm run build && npm run check:a11y',
      'test:units': 'x', 'test:built': 'x', build: 'x', 'check:a11y': 'x',
    },
    engines: { node: '>=22.19.0' },
  }),
  '.nvmrc': '22\n',
  /*
   * base 的 check.yml 要跟得上**部署路徑上的每一件事**，不然新規則會在每個案例上都響。
   * 第 7 輪（第十五圈）把要求的清單從 deploy.yml 推出來之後，
   * 這裡也要有 test:units 與 test:built —— 真的 check.yml 本來就有這兩步。
   */
  '.github/workflows/check.yml': [
    'name: Check',
    'jobs:',
    '  ci:',
    '    steps:',
    '      - run: npm run build',
    '      - run: npm run check:a11y',
    '      - run: npm run test:units',
    '      - run: npm run test:built',
    '',
  ].join('\n'),
  '.github/workflows/deploy.yml': [
    'name: Deploy',
    'jobs:',
    '  build:',
    '    steps:',
    /*
     * ── 註解不是指令 ──────────────────────────────────
     *
     * 這兩行註解是第 7 輪（第十六圈）加的，放在 base 裡（也就是
     * 「正常的 workflow 不誤報」用的那一份），因為它們該證明的是**不響**：
     *
     *   · 第一行提到一個 package.json 裡不存在的 script（改名前的舊名字）
     *   · 第二行在建置**之前**提到一個需要 dist 的檢查
     *
     * 拿掉 check-workflows 的抹註解那一步，這兩行會分別讓
     * `unknown-script` 與 `needs-dist-before-build` 響 —— 突變掃描確認過。
     * 真的 deploy.yml 就有這種註解（「之前這裡只跑 npm run build」）。
     */
    '      # 以前這裡跑 npm run check:old-name，後來併進 verify:all 了',
    '      # 注意：npm run check:a11y 一定要排在 build 之後',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version-file: .nvmrc',
    '      - run: npm run test:units',
    '      - run: npm run verify:all',
    '      - run: npm run test:built',
    /*
     * ── 乾淨的那一份也要有區塊純量 ──────────────────
     *
     * `run: |` 裡面是 shell，不是 YAML，所以 check-workflows 有一段專門跳過它。
     * 第 7 輪（第十四圈）為此放了一個 heredoc，裡面兩行同縮排的 `name:` ——
     * **但放在 `duplicate-key` 的 hit fixture 裡**，而那一份本來就該響，
     * 所以拿掉跳過也看不出差別。第 7 輪（第十五圈）的突變掃描證實：
     * 把那段跳過刪掉，測試照樣全綠。
     *
     * 搬到 base（「正常的 workflow 不誤報」用的就是它）之後才有分辨力：
     * 少了跳過，這兩行 `name:` 會被當成重複鍵，那一格立刻紅。
     */
    '      - name: 寫一份摘要',
    '        run: |',
    '          cat > summary.yml <<EOF',
    '          name: $GITHUB_REF_NAME',
    '          name: $GITHUB_SHA',
    '          EOF',
    '',
  ].join('\n'),
});

/**
 * key 是規則 id；值是「要覆寫或新增哪些檔案」。
 * @type {Record<string, Record<string, string>>}
 */
const CASES = {
  /* YAML 不允許同一個區塊出現兩個相同的鍵，GitHub 會拒絕整份 workflow。 */
  'duplicate-key': {
    '.github/workflows/deploy.yml': [
      'name: Deploy',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: npm run verify:all',
      '        env:',
      '          A: 1',
      '        env:',
      '          B: 2',
      '      - run: npm run test:units',
      '      - run: npm run test:built',
      /*
       * base 裡刻意放一個 `run: |` 區塊，而且裡面有**看起來像 YAML 鍵**的行。
       *
       * 第 7 輪（第十四圈）之前，所有假 workflow 的每個 step 都是單行
       * `- run:` —— 而真的 `deploy.yml`、`sync-feeds.yml` 都有區塊純量。
       * `check-workflows.mjs` 有一段專門跳過區塊純量（「裡面是 shell，
       * 不是 YAML」），而那段程式**沒有任何案例走過**。
       *
       * 這個 heredoc 裡有兩行 `name:`，同一個縮排 —— 跳過那段壞掉的話，
       * 底下「正常的 workflow 不誤報」會當場變紅。
       */
      '      - name: 寫一份摘要',
      '        run: |',
      '          cat > summary.yml <<EOF',
      '          name: $GITHUB_REF_NAME',
      '          name: $GITHUB_SHA',
      '          EOF',
      '',
    ].join('\n'),
  },

  /* workflow 呼叫了一個 package.json 裡不存在的 script。 */
  /*
   * 覆寫 check.yml 時要**保留 base 的關卡**（build、check:a11y），
   * 不然 gate-missing-in-check 也會跟著響 —— 那樣這個案例證明不了
   * 是哪一條讓它綠的。第 7 輪（第九圈）量出來才發現。
   */
  'unknown-script': {
    '.github/workflows/check.yml': [
      'name: Check',
      'jobs:',
      '  ci:',
      '    steps:',
      '      - run: npm run build',
      '      - run: npm run check:a11y',
      '      - run: npm run test:units',
      '      - run: npm run test:built',
      '      - run: npm run check:this-does-not-exist',
      '',
    ].join('\n'),
  },

  /*
   * 關卡只加在 check.yml 裡 —— 那個 workflow 紅燈不會擋住 deploy。
   * 這是踩過兩次的坑，所以案例是「deploy.yml 少了 verify:all」。
   */
  'gate-not-on-deploy-path': {
    '.github/workflows/deploy.yml': [
      'name: Deploy',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: npm run test:units',
      // build 要在 test:built 之前，不然 needs-dist-before-build 也會響
      '      - run: npm run build',
      '      - run: npm run test:built',
      '',
    ].join('\n'),
  },

  /*
   * check.yml 沒跟上 verify:all —— 少了 check:a11y。
   * deploy.yml 跑的是複合的 verify:all，所以它自動有；check.yml 不會。
   */
  'gate-missing-in-check': {
    '.github/workflows/check.yml': [
      'name: Check',
      'jobs:',
      '  ci:',
      '    steps:',
      '      - run: npm run build',
      '',
    ].join('\n'),
  },

  /*
   * ── 註解裡提到 verify:all，不算「有跑」──
   *
   * 第 7 輪（第十五圈）之前這條是 `deploy.includes('npm run verify:all')`，
   * 也就是**註解會被當成有跑**。真的 deploy.yml 就有一行註解寫著
   * 「之前這裡只跑 npm run build」，所以這不是假想的情況。
   * 這一份 fixture 把 verify:all 那一步刪掉、只在註解裡留著它 ——
   * 字串比對的版本會安靜通過，那是最糟的一種綠燈。
   */
  'gate-not-on-deploy-path（只出現在註解裡）': {
    expect: 'gate-not-on-deploy-path',
    '.github/workflows/deploy.yml': [
      'name: Deploy',
      'jobs:',
      '  build:',
      '    steps:',
      '      # 之前這裡跑 npm run verify:all，後來拆開了',
      '      - run: npm run build',
      '      - run: npm run test:units',
      '      - run: npm run test:built',
      '',
    ].join('\n'),
  },

  /*
   * ── check.yml 少的不是六道關卡，是測試那兩步 ──
   *
   * 第 7 輪（第十五圈）把三份 workflow 的清單列出來比對，發現
   * `test:units` 與 `test:built` **沒有任何規則要求 check.yml 跑**：
   * 拿掉它們，PR 上就不再跑單元測試與產出測試，而三支檢查全部維持綠燈。
   * 這一份 fixture 的 check.yml 六道關卡都在、只少了那兩步。
   */
  'gate-missing-in-check（少的是 test:units／test:built）': {
    expect: 'gate-missing-in-check',
    '.github/workflows/check.yml': [
      'name: Check',
      'jobs:',
      '  ci:',
      '    steps:',
      '      - run: npm run build',
      '      - run: npm run check:a11y',
      '',
    ].join('\n'),
  },

  /*
   * 對稱的另一半：check.yml 那一側也不能把註解當成「有跑」。
   * 少了這一格，把 `ran` 換回字串比對會靜靜通過（突變掃描量到的）。
   */
  'gate-missing-in-check（check.yml 只在註解裡提到）': {
    expect: 'gate-missing-in-check',
    '.github/workflows/check.yml': [
      'name: Check',
      'jobs:',
      '  ci:',
      '    steps:',
      '      - run: npm run build',
      '      # 這裡本來有 npm run check:a11y',
      '      - run: npm run test:units',
      '      - run: npm run test:built',
      '',
    ].join('\n'),
  },

  /*
   * 需要 dist/ 的檢查排在建置之前。第 7 輪（第四圈）真的這樣弄壞過部署，
   * 而本機完全看不出來（本機一直有 dist/）。
   */
  'needs-dist-before-build': {
    '.github/workflows/check.yml': [
      'name: Check',
      'jobs:',
      '  ci:',
      '    steps:',
      '      - run: npm run test:built',
      '      - run: npm run build',
      // 保留部署路徑上的每一步，不然 gate-missing-in-check 也會響
      '      - run: npm run check:a11y',
      '      - run: npm run test:units',
      '',
    ].join('\n'),
  },

  /*
   * ── 設定檔裡有只在一台機器上成立的路徑 ──
   *
   * 2026-09-04 第一次推上 GitHub，第一個 workflow 就死在 npm ci：
   * 版控裡的 .npmrc 有一行 cache=<某台 Mac 的外接碟路徑>，
   * runner 上沒有那個路徑，連 npm 的 log 都寫不出去。
   * 本機看不出來，六道關卡也看不出來（它們不跑 npm ci）。
   */
  'machine-path-in-config': {
    '.npmrc': 'cache=/Volumes/SomeDisk/.npm-cache\nfund=false\n',
  },

  /*
   * ── 有測試檔，但沒有人跑它 ──
   *
   * 「這個專案有哪些測試」寫在檔案系統與 package.json 兩個地方。
   * 只動一邊不會有任何徵兆：檔案在那裡、看起來很完整、關卡全綠，
   * 它只是從來沒有跑過。
   */
  'test-file-not-run': {
    'package.json': JSON.stringify({
      scripts: {
        'verify:all': 'npm run build && npm run check:a11y',
        'test:units': 'x', 'test:built': 'x', build: 'x', 'check:a11y': 'x',
      },
      engines: { node: '>=22.19.0' },
    }),
    'scripts/test-nobody-runs-me.mjs': '// 沒有任何 npm script 指到這個檔案\n',
  },

  /* 反過來：npm script 指到一個不存在的測試檔 */
  'test-file-not-run（指到不存在的檔案）': {
    expect: 'test-file-not-run',
    'package.json': JSON.stringify({
      scripts: {
        'verify:all': 'npm run build && npm run check:a11y',
        'test:units': 'node scripts/test-vanished.mjs',
        'test:built': 'x', build: 'x', 'check:a11y': 'x',
      },
      engines: { node: '>=22.19.0' },
    }),
  },
};

/*
 * 規則的 id —— **問腳本自己**，不要在這裡抄一份。
 *
 * 原本這裡是一份手抄的清單，註解寫著「跟 check-workflows.mjs 的 RULE_IDS
 * 同一份」。第 7 輪（第二十四圈）加第六條規則的時候，那句話當場變成假的：
 * 檢查那邊六條，這邊五條，於是「每條規則都要講改法」只驗了五條 ——
 * 而它印出來的是「5 條規則都講了」，看起來完全正常。
 *
 * `--list-rules` 早就存在，就是為了這件事。
 */
const { stdout: ruleList } = await run('node', [
  resolve(ROOT, 'scripts/check-workflows.mjs'),
  '--list-rules',
]);
const RULE_IDS_FOR_TEST = ruleList.trim().split('\n').filter(Boolean);

let failed = 0;
const tmp = await mkdtemp(join(tmpdir(), 'fox-wf-'));

console.log('\n建置管線規則實測\n' + '─'.repeat(64));

try {
  for (const [label, entry] of Object.entries(CASES)) {
    /*
     * `expect` 讓同一條規則有第二個案例（key 取的是情境，比對的仍是規則 id）——
     * 跟 test-perf-budgets、test-content-rules 的做法一致。
     * 它不是檔案，要先拿掉再展開，不然會在假 repo 裡建一個叫 expect 的檔案。
     */
    const { expect, ...overrides } = /** @type {any} */ (entry);
    const id = expect ?? label;
    const out = await check(await build(`case-${label}`, { ...base(), ...overrides }));
    const hit = out.includes(`[${id}]`);
    console.log(`  ${hit ? '✓' : 'X'} ${label}`);
    /*
     * 順帶觸發到別條就算失敗。
     *
     * 第 7 輪（第九圈）量出五個案例裡有**三個**有連帶，而三個都是同一個原因：
     * fixture 整份覆寫 workflow，順手把 base 提供的東西弄丟了
     * （少了關卡 → `gate-missing-in-check` 響；少了 build → `needs-dist-before-build` 響）。
     * 三個都收窄了，所以這裡不需要宣告機制 —— 有連帶就是 fixture 寫壞了。
     */
    const allIds = [...new Set([...out.matchAll(/\[([a-z-]+)\]/g)].map((m) => m[1]))];
    const extra = allIds.filter((x) => x !== id);
    if (extra.length > 0) {
      failed++;
      console.log(`      這個 fixture 還順帶觸發了：${extra.join('、')}`);
      console.log('      同時響好幾條的案例證明不了是哪一條讓它綠的。把 fixture 收窄。');
    }
    if (!hit) {
      failed++;
      console.log('      這條規則沒有響。實際抓到：' +
        ([...new Set([...out.matchAll(/\[([a-z-]+)\]/g)].map((m) => m[1]))].join('、') || '（無）'));
    }
  }

  {
    const out = await check(await build('clean', base()));
    const ok = out.includes('沒有發現問題');
    console.log(`  ${ok ? '✓' : 'X'} 正常的 workflow 不誤報`);
    if (!ok) {
      failed++;
      console.log(out.split('\n').map((l) => '        ' + l).join('\n'));
    }
  }

  /*
   * 反向：那個路徑寫在**註解**裡不算 —— 那是在解釋這條規則。
   *
   * 這個 repo 第十一次撞到「解釋一條規則，就會需要寫出它禁止的東西」，
   * 而這一次是在出貨前看到的：`.npmrc` 的註解裡就有那個路徑。
   */
  {
    const dir = await build('machine-path-comment', {
      ...base(),
      '.npmrc': '# 不要在這裡設 cache=/Volumes/SomeDisk/.npm-cache\nfund=false\n',
    });
    const out = await check(dir);
    const ok = !out.includes('[machine-path-in-config]');
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : 'X'} 那個路徑寫在註解裡不算（反向案例）`);
    if (!ok) console.log('        ' + out.split('\n').filter((l) => l.includes('machine-path')).join('\n        '));
  }

  // 加規則沒加案例就失敗
  {
    /* 問腳本自己有哪些規則 —— 不從原始碼用正則抽（第一版就是那樣漏了兩條） */
    const ids = RULE_IDS_FOR_TEST;
    if (ids.length === 0) {
      failed++;
      console.log('\n  X --list-rules 什麼都沒印 —— 下面的比對會空過，那是假的綠燈');
    }
    const missing = ids.filter((i) => !(i in CASES));
    if (missing.length > 0) {
      failed += missing.length;
      console.log(`\n  X 這些規則沒有測試案例：${missing.join('、')}`);
      console.log('      加規則就要加案例 —— 沒有案例的規則等於沒有人確認過它會響。');
    }

    /*
     * ── 每條規則都要數得出主體 ────────────────────────
     *
     * 第 7 輪（第二十一圈）加的。這一支守的是三份**從來沒有在 GitHub 上
     * 跑過**的 workflow，所以「這條規則到底判斷過幾個東西」比別處更該問。
     *
     * 兩件事：主體數要印得出來（`--verbose`），而且**每一條都要在名單裡**
     * —— 一條規則因為整段沒跑而從名單裡消失，看起來就跟「沒有這種檢查」一樣
     * （第 5 輪〔第二十一圈〕在隱私稽核上量到的同一件事）。
     */
    /*
     * 這份 fixture 是**逐條湊出來**的，不是隨手挑一份假站：
     *
     *   duplicate-key / unknown-script　→ 有 YAML 鍵、有一個真的 npm run
     *   gate-not-on-deploy-path　　　　 → 沒有 deploy.yml，所以 saw(…, 0)
     *   gate-missing-in-check　　　　　 → 同上，要求清單是空的
     *   needs-dist-before-build　　　　 → **完全走不到那個 saw()**
     *
     * 最後那一條才是重點：`saw(id, 0)` 也會在名單裡建鍵，
     * 所以只有「一次都沒呼叫過 saw」的規則才驗得到補 0 那一行。
     *
     * 第一版沒想到這件事，用完整的 base()，於是「拿掉補 0」的突變
     * **靜靜通過**。第二版改成刪掉 deploy.yml，還是通過 ——
     * 因為那兩條走的是 `saw(…, 0)`。第三版才對。
     * （第十九圈記過同一件事：自己寫的格子看起來在測東西、其實什麼都沒測。）
     */
    const minimal = {
      'package.json': JSON.stringify({ scripts: { build: 'x' }, engines: { node: '>=22.19.0' } }),
      '.nvmrc': '22\n',
      '.github/workflows/check.yml': [
        'name: Check',
        'jobs:',
        '  ci:',
        '    steps:',
        '      - run: npm run build',
        '',
      ].join('\n'),
    };
    const dir = await build('subjects', minimal);
    const { stdout: verbose } = await run('node', [
      resolve(ROOT, 'scripts/check-workflows.mjs'),
      `--root=${dir}`,
      '--verbose',
    ]).catch((/** @type {any} */ e) => ({ stdout: String(e?.stdout ?? '') }));
    const rows = new Map(
      [...verbose.matchAll(/^\s*(\d+)\s+([a-z-]+)$/gm)].map((m) => [m[2], Number(m[1])]),
    );
    const notListed = ids.filter((i) => !rows.has(i));
    if (notListed.length > 0) {
      failed++;
      console.log(`\n  X 這些規則不在主體數名單裡：${notListed.join('、')}`);
    } else {
      console.log(`  ✓ ${ids.length} 條規則都數得出主體（--verbose）`);
    }

    /*
     * 反向：真的有語料的時候，數字不能全是 0。
     * 少了這一格，把 saw() 全部刪掉也會通過上面那格（補值會讓它們都變成 0）。
     */
    /*
     * 反向要**逐條**看，不能用 some()。
     * 第一版寫成「至少有一條大於 0」，於是「拿掉兩條規則的計數」
     * 也靜靜通過 —— 其他三條仍然大於 0。
     */
    const zeroed = ['duplicate-key', 'unknown-script'].filter((i) => (rows.get(i) ?? 0) === 0);
    if (zeroed.length > 0) {
      failed++;
      console.log(`\n  X 這幾條在有語料的情況下卻數到 0：${zeroed.join('、')}`);
      console.log('      假 workflow 裡本來就有 YAML 鍵與 npm run —— 計數沒有接上。');
    } else {
      console.log(
        `  ✓ 有語料的規則數得出東西（duplicate-key ${rows.get('duplicate-key')}、` +
          `unknown-script ${rows.get('unknown-script')}）`,
      );
    }

    /* 一次都沒被呼叫過的那一條，要靠補值才會出現在名單裡、而且是 0 */
    const never = 'needs-dist-before-build';
    const okBackfill = rows.get(never) === 0;
    if (!okBackfill) failed++;
    console.log(
      `  ${okBackfill ? '✓' : 'X'} 完全沒跑到的規則補成 0（${never}=${rows.get(never)}）`,
    );

    /* 沒有 deploy.yml 的那兩條也要是 0 —— 它們走的是另一條路（saw(…, 0)） */
    const gates = ['gate-not-on-deploy-path', 'gate-missing-in-check'];
    const notZero = gates.filter((i) => rows.get(i) !== 0);
    if (notZero.length > 0) {
      failed++;
      console.log(`\n  X 沒有 deploy.yml 時這幾條不是 0：${notZero.map((i) => `${i}=${rows.get(i)}`).join('、')}`);
    } else {
      console.log('  ✓ 沒有 deploy.yml 時那兩條是 0');
    }
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

/*
 * ── 每一處 add() 都要說得出「改法：」──────────────────
 *
 * 第十七圈問的是「站主照著做得到嗎」。第 7 輪（第十七圈）量到：
 * `gate-not-on-deploy-path` 與 `gate-missing-in-check` 本來就有建議，
 * 另外三條只講事實（「package.json 裡沒有這個 script」）。
 *
 * 判準用「改法：」當標記，跟 a11y／content／privacy 那幾支一樣。
 *
 * ## 為什麼從「有一處算過」改成「每一處都要有」
 *
 * 舊版是找規則 id 出現的每一個位置，看後面 500 字裡有沒有「改法：」，
 * **有一處就算過**（`spots.some(...)`）。第 7 輪（第二十四圈）的突變掃描
 * 當場戳破：`test-file-not-run` 有兩個 `add()`，把其中一個的「改法：」
 * 拿掉，這一格照樣印「6 條規則都講了改法」。
 *
 * 改成 `every` 不行 —— `RULE_IDS` 那一行本身就沒有「改法：」。
 * 真正要數的是 **`add()` 呼叫**，而那個檔案自己的註解就寫著
 * 拿正則抽 `add(...)` 曾經漏掉兩條多行呼叫。
 *
 * 所以這裡不用正則：從 `add(` 開始**數括號**找到對應的右括號，
 * 多行、巢狀、樣板字串都不影響。第 7 輪（第二十五圈）量出來是
 * 7 處呼叫、6 條規則（`test-file-not-run` 佔兩處），全部都有「改法：」——
 * 也就是說**現在沒有洞，補的是「以後也不會有」**。
 */
{
  const src = await readFile(resolve(ROOT, 'scripts/check-workflows.mjs'), 'utf8');

  /**
   * 每一個 `add(...)` 呼叫（不含 `Set.add(`），連同它的規則 id
   * @type {{ id: string, line: number, has: boolean }[]}
   */
  const calls = [];
  for (let i = 0; (i = src.indexOf('add(', i)) !== -1; ) {
    const before = src[i - 1] ?? ' ';
    if (/[.\w]/.test(before)) { i += 4; continue; } // `.add(`／`readd(` 之類的不算
    let depth = 0;
    let j = i + 3;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    const call = src.slice(i, j + 1);
    /* 第三個參數是規則 id：add(file, line, id, msg) */
    const id = RULE_IDS_FOR_TEST.find((r) => call.includes(`'${r}'`));
    if (id) calls.push({ id, line: src.slice(0, i).split('\n').length, has: call.includes('改法：') });
    i = j + 1;
  }

  const noCall = RULE_IDS_FOR_TEST.filter((id) => !calls.some((c) => c.id === id));
  const noFix = calls.filter((c) => !c.has);

  if (calls.length === 0) {
    failed++;
    console.log('\n  X 一個 add() 呼叫都抽不到 —— 下面的比對會空過，那是假的綠燈');
  } else if (noCall.length > 0 || noFix.length > 0) {
    failed += noCall.length + noFix.length;
    if (noCall.length > 0) console.log(`\n  X 這些規則在原始碼裡找不到 add() 呼叫：${noCall.join('、')}`);
    if (noFix.length > 0) {
      console.log(`\n  X 這幾處 add() 沒有講「改法：」：${noFix.map((c) => `${c.id}（行 ${c.line}）`).join('、')}`);
      console.log('      站主看到的是一句事實，不知道下一步要做什麼。');
      console.log('      同一條規則有好幾處 add() 時，只有一處寫了不算 —— 響的可能是另一處。');
    }
  } else {
    console.log(`  ✓ ${calls.length} 處 add() 都講了「改法：」（${RULE_IDS_FOR_TEST.length} 條規則）`);
  }
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);

/**
 * @param {string} name
 * @param {Record<string, string>} files
 */
async function build(name, files) {
  const dir = join(tmp, name);
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
}

/** @param {string} dir */
async function check(dir) {
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/check-workflows.mjs'), `--root=${dir}`]);
    return stdout;
  } catch (err) {
    return String(/** @type {{ stdout?: string }} */ (err)?.stdout ?? '');
  }
}
