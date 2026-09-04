#!/usr/bin/env node
// @ts-check
/**
 * deploy.yml 的步驟抽取 —— `npm run test:deploy-steps`
 *
 * ## 為什麼需要這個
 *
 * `ci:sim` 的整個價值是「它跑的跟 CI 跑的是同一串」。第 7 輪（第十圈）
 * 把寫死的陣列改成從 `deploy.yml` 讀出來；第 7 輪（第十三圈）發現
 * **那個讀法本身只認一種寫法**。
 *
 * 實測：把 `run: npm run test:built` 改寫成
 *
 *     run: |
 *       npm run test:built
 *
 * （完全合法、GitHub 照跑），`ci:sim` 就從三步變成兩步 ——
 * 而且照樣印「照 deploy.yml 的順序跑完，全部通過」。
 * 少掉的剛好是 `test:built`，也就是 `verify:all` 蓋不到的那一半。
 *
 * 抽取寫錯的時候沒有任何徵兆，所以案例要涵蓋 YAML 真的允許的各種寫法，
 * 不是只涵蓋今天那份檔案剛好長成的樣子 —— 這一圈的問題就是這個。
 */
import { readFileSync } from 'node:fs';
import { deployStepsFrom, unextracted, withoutComments, stepKinds } from './lib/deploy-steps.mjs';

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [got] */
function check(name, ok, got) {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (got !== undefined) console.log('      實際：', JSON.stringify(got));
  }
}

/** @param {string[]} a @param {string[]} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\ndeploy.yml 的步驟抽取\n' + '─'.repeat(64));

// ── 1. 單行寫法（今天那份檔案的樣子）─────────────────
{
  const yml = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: 測試',
    '        run: npm run test:units',
    '      - run: npm run verify:all',
    '',
  ].join('\n');
  const got = deployStepsFrom(yml);
  check('單行 run：兩種縮排都認得', same(got, ['test:units', 'verify:all']), got);
}

// ── 2. 區塊純量（實測會漏掉的那種）───────────────────
{
  const yml = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: 產出的檢查',
    '        run: |',
    '          npm run test:built',
    '      - run: npm run verify:all',
    '',
  ].join('\n');
  const got = deployStepsFrom(yml);
  check('run: | 區塊裡的 npm run 也算', same(got, ['test:built', 'verify:all']), got);
}

// ── 3. 一個區塊裡好幾行 ──────────────────────────────
{
  const yml = [
    '    steps:',
    '      - run: |',
    '          npm ci',
    '          npm run test:units',
    '          npm run test:built',
    '      - run: npm run verify:all',
    '',
  ].join('\n');
  const got = deployStepsFrom(yml);
  check('一個區塊裡的多行都收，順序照原樣', same(got, ['test:units', 'test:built', 'verify:all']), got);
}

// ── 4. 區塊的其他寫法 ───────────────────────────────
for (const [label, marker] of /** @type {[string, string][]} */ ([
  ['run: >', '>'],
  ['run: |-', '|-'],
  ['run: >-', '>-'],
  ['run: |+', '|+'],
])) {
  const yml = ['    steps:', `      - run: ${marker}`, '          npm run test:built', ''].join('\n');
  const got = deployStepsFrom(yml);
  check(`${label} 也是區塊純量`, same(got, ['test:built']), got);
}

// ── 5. 註解不算 ─────────────────────────────────────
{
  const yml = [
    '    steps:',
    '      # 不要在這裡加 npm run sync —— 那是另一個 workflow 的事',
    '      - run: npm run test:units',
    '      - run: |',
    '          # npm run test:built 先拿掉，等 dist 有東西再開',
    '          npm run verify:all',
    '',
  ].join('\n');
  const got = deployStepsFrom(yml);
  check('YAML 的註解不算', !got.includes('sync'), got);
  check('區塊純量裡被註解掉的那行也不算', !got.includes('test:built'), got);
  check('註解旁邊真的步驟還是抽得到', same(got, ['test:units', 'verify:all']), got);
}

// ── 6. 區塊結束之後要回到正常模式 ────────────────────
{
  const yml = [
    '    steps:',
    '      - run: |',
    '          npm run test:built',
    '      - name: 下一步',
    '        run: npm run verify:all',
    '',
  ].join('\n');
  const got = deployStepsFrom(yml);
  check('區塊結束後接著的單行 run 沒有被吞掉', same(got, ['test:built', 'verify:all']), got);
}

// ── 5b. 行尾的註解 ──────────────────────────────────
{
  /*
   * YAML 裡「空白 ＋ #」之後是註解，所以下面第一行的值仍然是那一行指令，
   * GitHub 會照跑。只認到行尾的樣式會漏掉它 —— 突變掃描逼出來的一格。
   */
  const yml = [
    '    steps:',
    '      - run: npm run test:units  # 只有這一步不需要 dist',
    '      - run: npm run verify:all',
    '',
  ].join('\n');
  const got = deployStepsFrom(yml);
  check('單行 run 後面接註解也抽得到', same(got, ['test:units', 'verify:all']), got);
}

// ── 6b. 區塊結束之後，別的地方提到 npm run 不算步驟 ──
{
  /*
   * 這一格是突變掃描逼出來的：拿掉「區塊結束就重設」之後，
   * 上面第 6 格照樣綠 —— 因為後面那行剛好也是真的步驟。
   * 要分辨得出來，後面那行必須是**提到 npm run 但不是步驟**的東西。
   */
  const yml = [
    '    steps:',
    '      - run: |',
    '          npm run test:built',
    '      - name: 留個訊息',
    '        with:',
    '          text: 跑完 npm run deploy:notify 就結束',
    '',
  ].join('\n');
  const got = deployStepsFrom(yml);
  check('區塊結束後，with: 裡提到的 npm run 不算步驟', same(got, ['test:built']), got);
}

// ── 7. 什麼都沒有 ───────────────────────────────────
{
  check('沒有任何 npm run 時回空陣列', same(deployStepsFrom('jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n'), []));
  check('空字串不會爆', same(deployStepsFrom(''), []));
}

// ── 8. unextracted：抽取漏掉時要說得出來 ─────────────
{
  const yml = [
    '    steps:',
    '      - run: |',
    '          npm run test:built',
    '      - run: npm run verify:all',
    '',
  ].join('\n');
  check('抽得完整時 unextracted 是空的', same(unextracted(yml, deployStepsFrom(yml)), []));
  /* 假裝抽取只認單行 —— 那正是這一輪修掉的 bug */
  const onlySingleLine = ['verify:all'];
  check(
    '抽取漏掉區塊裡的步驟時，unextracted 會點名它',
    same(unextracted(yml, onlySingleLine), ['test:built']),
    unextracted(yml, onlySingleLine),
  );
  /* 註解裡的 npm run 不該讓 unextracted 誤報 */
  const withComment = '      # 以前這裡有 npm run sync\n' + yml;
  check(
    '註解裡的 npm run 不會讓 unextracted 誤報',
    same(unextracted(withComment, deployStepsFrom(withComment)), []),
    unextracted(withComment, deployStepsFrom(withComment)),
  );
}

/*
 * ── withoutComments：抹註解，但不能抹掉別的 ──────────
 *
 * `check-workflows.mjs` 的 `unknown-script` 與 `needs-dist-before-build`
 * 靠它才不會把註解裡的 `npm run` 當成指令（第 7 輪〔第十六圈〕的誤報探針）。
 * 而它們要回報行號，所以**行數不能變**。
 */
{
  console.log('\n  withoutComments');
  const one = withoutComments('  - run: npm run build  # 建置\n');
  check('行尾註解抹掉、指令留著', one.trim() === '- run: npm run build', one);

  const many = withoutComments('a\n# 註解\nb\n');
  check('行數不變（行號才會對）', many.split('\n').length === 4, many.split('\n').length);

  /*
   * 引號裡的井號不是註解。不認引號的話這一行會被切成
   * `- run: echo "第 ` —— 後面若還有指令就被抹掉了，變成漏報。
   */
  const quoted = withoutComments('  - run: echo "第 #1 步" && npm run test:units\n');
  check('引號裡的井號不算註解', quoted.includes('npm run test:units'), quoted);

  const noSpace = withoutComments('  - run: npm run build#notacomment\n');
  check('沒有前置空白的井號不算註解（shell 與 YAML 都是這規矩）', noSpace.includes('build#notacomment'), noSpace);
}

/*
 * ── 這份 workflow 有幾步、幾步是 GitHub 的 action ──────
 *
 * 第 7 輪（第二十一圈）加的。`ci:sim` 用它講清楚自己涵蓋了多少 ——
 * deploy.yml 十步裡它跑四步，而**真正把東西送出去的兩步在模擬不到的那一半**。
 *
 * 數錯的後果是那一行會說謊，而它正是用來校正「全部通過」該怎麼讀的那一行。
 */
{
  const deploy = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - name: 取出原始碼',
    '        uses: actions/checkout@v5',
    '      - name: 準備 Node',
    '        uses: actions/setup-node@v5',
    '        with:',
    '          node-version-file: .nvmrc',
    '      - name: 安裝',
    '        run: npm ci',
    '      - name: 建置',
    '        run: npm run verify:all',
    '      - name: CNAME',
    '        run: |',
    '          test -f dist/CNAME',
    '      - uses: actions/deploy-pages@v4',
    '',
  ].join('\n');
  const k = stepKinds(deploy);
  check(
    `六步：三個 run、三個 uses（實際 ${k.run}／${k.uses}／共 ${k.total}）`,
    k.run === 3 && k.uses === 3 && k.total === 6,
    k,
  );

  /*
   * `with:` 底下的鍵不能被當成新的一步 —— 它們也長得像 `key:`。
   * 上面那份已經有一個 `with:`；這一格把它變成清單形式再驗一次，
   * 因為 `- name: x` 這種**清單項目**才是 stepKinds 認步驟的樣子。
   */
  const withList = [
    '    steps:',
    '      - uses: actions/upload-pages-artifact@v4',
    '        with:',
    '          path: dist',
    '          name: 產出',
    '',
  ].join('\n');
  const k2 = stepKinds(withList);
  check(`with: 底下的鍵不算一步（實際共 ${k2.total} 步）`, k2.total === 1 && k2.uses === 1, k2);

  /*
   * `run: |` 區塊裡的 shell 不是 YAML。裡面寫 `- uses: 別的東西`
   * （例如 echo 一段說明）不能被算成一步。
   */
  const shellBlock = [
    '    steps:',
    '      - name: 說明',
    '        run: |',
    '          echo "- uses: actions/checkout@v5"',
    '          echo "- run: 假的"',
    '',
  ].join('\n');
  const k3 = stepKinds(shellBlock);
  check(`run: | 區塊裡的假步驟不算數（實際共 ${k3.total} 步）`, k3.total === 1 && k3.run === 1, k3);

  /* 真的那一份：數字要跟 ci:sim 印出來的那一行一致 */
  const real = stepKinds(readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8'));
  check(
    `真的 deploy.yml：${real.total} 步（run ${real.run}、uses ${real.uses}）`,
    real.total > 0 && real.run > 0 && real.uses > 0 && real.other === 0,
    real,
  );
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
