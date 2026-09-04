#!/usr/bin/env node
// @ts-check
/**
 * `ci:sim` 的實測 —— `npm run test:ci-sim`
 *
 * ## 為什麼到現在才有
 *
 * 「`ci:sim` 沒有任何測試」這條待辦從第十三圈掛到第二十圈，
 * 理由一直是「它是跑起來就會做事的腳本，要測得先拆」。
 * 第 7 輪（第十八圈）拆出了比對那一塊（`lib/dist-diff.mjs`，有自己的測試），
 * 而剩下的「照 deploy.yml 的順序把步驟串起來跑」那一層，
 * 真正卡住的其實只有一行：根目錄寫死在腳本自己的位置上。
 * 第 7 輪（第二十圈）加了 `--root=`，這一支就測得動了。
 *
 * 做法：建一份**極小的假專案** —— 一個 `deploy.yml`、一個 `package.json`
 * （步驟只是 `echo`）、一個 `.nvmrc`、一個 git repo（`git archive` 要用）。
 * 零網路、不碰真的專案。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
/** @param {string} name @param {boolean} good @param {unknown} [detail] */
const ok = (name, good, detail) => {
  console.log(`  ${good ? '✓' : 'X'} ${name}`);
  if (!good) {
    failed++;
    if (detail !== undefined) console.log('      實際：', String(detail).slice(0, 700));
  }
};

const deployYml = (/** @type {string[]} */ steps) =>
  [
    'name: 部署',
    'on:',
    '  push:',
    'jobs:',
    '  build:',
    '    steps:',
    ...steps.map((s) => `      - run: npm run ${s}`),
    '      - name: 檢查 CNAME 有被帶進輸出',
    '        run: |',
    '          test -f dist/CNAME',
    '          echo "CNAME = $(cat dist/CNAME)"',
  ].join('\n');

/**
 * @param {{ steps: string[], scripts: Record<string, string>, cname?: boolean }} o
 */
async function fakeRepo({ steps, scripts, cname = true }) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-sim-'));
  await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.github', 'workflows', 'deploy.yml'), deployYml(steps), 'utf8');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fake', version: '1.0.0', engines: { node: '>=22.0.0' }, scripts }, null, 2),
    'utf8',
  );
  await writeFile(join(dir, '.nvmrc'), '22\n', 'utf8');
  if (cname) {
    await mkdir(join(dir, 'public'), { recursive: true });
    await writeFile(join(dir, 'public', 'CNAME'), 'example.test\n', 'utf8');
  }
  const q = { cwd: dir, stdio: /** @type {const} */ ('ignore') };
  execFileSync('git', ['init', '-q'], q);
  execFileSync('git', ['add', '-A'], q);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], q);
  return dir;
}

/** @param {string} dir @param {string[]} [extra] */
async function sim(dir, extra = []) {
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/ci-sim.mjs'), `--root=${dir}`, ...extra]);
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? ''), code: e?.code ?? 1 };
  }
}

console.log('\nCI 模擬的實測\n' + '─'.repeat(56));

/* 全部通過的那一條路 */
{
  const dir = await fakeRepo({
    /*
     * 步驟名要含 `verify:all` —— ci-sim 有一道自我檢查：抽出來的步驟裡
     * 沒有它就當場拋錯（「那是六道關卡，不可能不在部署路徑上」）。
     * 假專案也是在模擬部署，所以照樣要有。
     */
    steps: ['verify:all', 'beta'],
    scripts: { 'verify:all': 'mkdir -p dist && cp public/CNAME dist/CNAME', beta: 'echo beta ok' },
  });
  const { out, code } = await sim(dir);
  ok('步驟全過：兩個都印 ✓、離開碼 0', code === 0 && /✓ verify:all/.test(out) && /✓ beta/.test(out), out.slice(-400));
  ok('CNAME 那一道真的跑了 workflow 裡的 shell', out.includes('CNAME = example.test'), out.slice(-300));
  /*
   * 預設不真的裝，但要讓人知道有那條路。
   *
   * 第 7 輪（第二十七圈）之前，「npm ci 用 npm ls 代打」的理由是
   * 站主的開機碟很緊 —— 而那個限制早就不成立了（家目錄從 5.7 GB
   * 回到 77 GiB），只是沒有人回頭看。一個在限制下做的取捨，
   * 限制消失了而選項連提都沒提，等於沒有人會發現可以重新選。
   */
  ok('預設那條路會說「--real-install 可以真的裝」', /--real-install/.test(out), out.slice(-400));
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── --real-install 失敗時要說對死因 ──────────
 *
 * 這一格挑的是**失敗**那條路：假專案沒有 package-lock.json，
 * `npm ci` 會立刻拒絕。成功那條路要真的下載幾百 MB，
 * 不適合放進每次都跑的測試（實測 29 秒＋235 MB）。
 *
 * 而失敗那條才是這個模式存在的理由：CI 上 `npm ci` 一死，
 * 後面什麼都不會跑，所以訊息必須說出「停在這一步」。
 * 2026-09-04 第一次 CI 就是這樣死的（`.npmrc` 裡有一條只在
 * 站主那台機器上成立的 cache 路徑）—— 那種問題 `npm ls` 完全看不到。
 */
{
  const dir = await fakeRepo({ steps: ['verify:all'], scripts: { 'verify:all': 'echo ok' } });
  const { out, code } = await sim(dir, ['--real-install']);
  /*
   * 判準裡最重要的是**最後那一項**：後面的步驟一步都不能跑。
   *
   * 第一版只驗 `code === 1` ＋ 兩句訊息，而突變掃描當場抓到它太粗：
   * 把 `process.exitCode = 1; throw` 拿掉之後，訊息照樣印
   * （它們在被拿掉的那兩行**之前**），而 exit 1 是**後面 CNAME 那一步**
   * 給的 —— 那一格於是接住了完全不同的死因，還顯示成綠的。
   *
   * 「停在這一步」是一句可以驗字面的話：跑得到 `✓ verify:all`
   * 就表示沒有停。同一圈第 4 輪也踩過一次同樣形狀的（同一條規則的
   * 兩條分支，訊息不同而測試只比對規則 id）。
   */
  ok(
    '--real-install：npm ci 失敗時 exit 1、說「停在這一步」，而且真的停住',
    code === 1 && /npm ci 失敗/.test(out) && /停在這一步/.test(out) && !/✓ verify:all/.test(out),
    `${out.slice(-500)}（exit ${code}）`,
  );
  await rm(dir, { recursive: true, force: true });
}

/* 有步驟失敗 */
{
  const dir = await fakeRepo({
    /*
     * 第二步刻意**不建 dist** —— 建了的話 CNAME 那一道會走
     * 「只看檔案在不在」那條分支，測不到「沒有檢查」那一句。
     * （第一版就是這樣寫的，測試紅了才發現是我的預期寫錯，不是程式。）
     */
    steps: ['verify:all', 'beta'],
    scripts: { 'verify:all': 'echo 這一步壞了 && exit 1', beta: 'echo beta 也跑了' },
  });
  const { out, code } = await sim(dir);
  ok('有步驟失敗：離開碼 1', code === 1, `code=${code}`);
  ok('失敗的那一步印 X，而且帶著它的輸出', /X verify:all/.test(out) && out.includes('這一步壞了'), out.slice(-500));
  /*
   * 第一個失敗之後，CNAME 那一道不能再報紅 —— 那是連鎖反應。
   * 第 7 輪（第十二圈）四次故意弄壞的實測裡每一次都多出那句紅字。
   */
  ok(
    '前面失敗時，CNAME 那一道說「沒有檢查」而不是報紅',
    out.includes('沒有檢查') && !out.includes('X dist/CNAME 不見了'),
    out.slice(-500),
  );
  await rm(dir, { recursive: true, force: true });
}

/*
 * 前面失敗、但後面的步驟仍然把 dist/CNAME 建出來了 —— 那時不跑 workflow 的
 * shell（前面壞了，跑它沒意義），只看檔案在不在。
 *
 * 這一格是突變掃描逼出來的：拿掉那條分支，上面三格全綠 ——
 * 因為它們的 fixture 都沒有走到它。
 */
{
  const dir = await fakeRepo({
    steps: ['verify:all', 'beta'],
    scripts: {
      'verify:all': 'echo 這一步壞了 && exit 1',
      beta: 'mkdir -p dist && cp public/CNAME dist/CNAME',
    },
  });
  const { out } = await sim(dir);
  ok(
    '前面失敗但 dist/CNAME 還在：只看檔案在不在，不跑那段 shell',
    out.includes('只看檔案在不在') && !out.includes('CNAME = example.test'),
    out.slice(-400),
  );
  await rm(dir, { recursive: true, force: true });
}

/*
 * 步驟是從 deploy.yml 讀出來的，不是抄一份 —— workflow 改了，模擬要跟著改。
 * 這是第 7 輪（第十圈）那個決定的守衛。
 */
{
  const dir = await fakeRepo({
    steps: ['verify:all'],
    scripts: { 'verify:all': 'mkdir -p dist && cp public/CNAME dist/CNAME', beta: 'echo 不該被跑到' },
  });
  const { out } = await sim(dir);
  ok(
    '步驟真的從 deploy.yml 讀（package.json 裡有 beta，但 workflow 沒列，就不該跑）',
    /✓ verify:all/.test(out) && !/beta/.test(out),
    out.slice(-300),
  );
  await rm(dir, { recursive: true, force: true });
}

console.log('─'.repeat(56));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
