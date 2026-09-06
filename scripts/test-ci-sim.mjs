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
 * @param {{ steps: string[], scripts: Record<string, string>, cname?: boolean, engines?: string }} o
 */
async function fakeRepo({ steps, scripts, cname = true, engines = '>=22.0.0' }) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-sim-'));
  await mkdir(join(dir, '.github', 'workflows'), { recursive: true });
  await writeFile(join(dir, '.github', 'workflows', 'deploy.yml'), deployYml(steps), 'utf8');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fake', version: '1.0.0', engines: { node: engines }, scripts }, null, 2),
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

/**
 * 在假 repo 裡多放幾份 workflow —— 給「沒有模擬到哪幾份」那一格用。
 * @param {string} dir @param {string[]} names
 */
async function addWorkflows(dir, names) {
  for (const n of names) {
    await writeFile(join(dir, '.github', 'workflows', n), 'name: x\non:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: echo x\n', 'utf8');
  }
}

/** @param {string} dir @param {string[]} [extra] */
async function sim(dir, extra = [], /** @type {Record<string, string|undefined>} */ envPatch = {}) {
  const env = { ...process.env, ...envPatch };
  for (const [k, v] of Object.entries(envPatch)) if (v === undefined) delete env[k];
  try {
    const { stdout } = await run('node', [resolve(ROOT, 'scripts/ci-sim.mjs'), `--root=${dir}`, ...extra], { env });
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
/*
 * ── 「不是 CI 那個版本」要說得出怎麼查是哪個版本 ──────────
 *
 * `.nvmrc` 是浮動的大版本，所以 CI 每次裝當時最新的 22.x。
 * 這句警告從第二十一圈就在印，而**沒有人查過那到底是哪一版** ——
 * 第 7 輪（第二十八圈）翻了 CI 的 log 才知道是 v22.23.2，
 * 而這台機器是 v22.15.1，差 8 個小版本。
 *
 * 一個「你驗的不是真的那個」的警告，如果不說怎麼知道真的是哪個，
 * 讀的人只能聳肩。這一格守的是那句指令還在。
 */
{
  const dir = await fakeRepo({
    steps: ['verify:all'],
    scripts: { 'verify:all': 'echo ok' },
    engines: '>=99.0.0',
  });
  const { out } = await sim(dir);
  const okHow = /低於 engines 的門檻/.test(out) && /gh run view/.test(out) && /node: v/.test(out);
  ok('版本不符時，說得出怎麼查 CI 實際裝哪一版', okHow, out.split('\n').slice(0, 8).join(' | '));
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 時間花在哪 ──────────────────────────────
 *
 * 第 7 輪（第二十九圈）問「第一次跑的人跟第一百次跑的人看到的是同一份
 * 東西嗎」。這裡本來印三個光禿禿的 ✓，沒有時間也沒有規模 ——
 * 而整條要跑十分鐘以上，「為什麼這麼久」正是第一次跑的人會問的。
 *
 * 第 7 輪（第二十七圈）在乾淨 clone 上特地量過一次（297／111／4 秒，
 * test:units 佔七成）。現在每一次跑都會自己說，不用特地量。
 *
 * 這一格不驗秒數（那會隨機器變），驗的是**那兩件事說得出來**：
 * 每一步有時間、而且點名最久的那一步與它的佔比。
 */
{
  /*
   * 兩步要**分得出快慢**，不然「最久的那一步」驗不到。
   *
   * 第一版兩步都是 `echo ok`，時間幾乎一樣 —— 於是把 `reduce` 的比較
   * 寫反（挑成最快的）之後測試照樣綠。這個 repo 這一組圈裡第七次踩到
   * 「判準能被別的東西滿足」。
   *
   * 用忙等而不是 `sleep`：不依賴外部指令，Windows 上也一樣。
   *
   * ── 為什麼是 3000ms 不是 700ms ──────────────────
   *
   * 700ms 是第一版寫的，而**兩步都要先經過一次 `npm run`**（起一個 node
   * 行程，這台機器上約 1.3 秒）。機器一有負載，兩邊都被墊高到同一個
   * 四捨五入的秒數，於是這一格紅 —— 紅的理由跟它要驗的事情無關。
   *
   * 第 7 輪（第四十三圈）就記過這條待辦，第 2 輪（第四十六圈）**當場抓到**：
   *
   *     X 說得出合計與最久的那一步（螢幕上最大的是 2 秒，而且不只一步）
   *       實際：兩步的秒數一樣（verify:all 2、beta 2）
   *
   * 那句「而且不只一步」是第 7 輪（第四十五圈）加的反貧化訊息 ——
   * 它把一個看不懂的紅燈變成一句說得出原因的話，這一輪才查得到。
   *
   * 改成 3000ms：`npm run` 的墊高兩邊都有，所以真正決定成敗的是**差值**。
   * 3 秒的差在四捨五入到秒之後仍然是 3 秒，負載再重也不會併成同一個數字。
   * 代價是這一格多花約 2.3 秒。
   */
  const dir = await fakeRepo({
    steps: ['verify:all', 'beta'],
    scripts: {
      'verify:all': 'node -e "const t=Date.now();while(Date.now()-t<3000);"',
      beta: 'echo ok',
    },
  });
  const { out } = await sim(dir);

  const okPerStep = /✓ verify:all\s+\d+ 秒/.test(out);
  ok('每一步都說得出花了幾秒', okPerStep, out.split('\n').filter((l) => l.includes('✓')).join(' | '));

  /*
   * ── 螢幕上那幾個數字要加得起來 ──────────
   *
   * 第 7 輪（第三十五圈）用第二種算法對 `ci:sim` 的數字，撞到這個：
   * 每一步印的是各自四捨五入的秒數，而合計是先加原始毫秒再四捨五入 ——
   * `68 + 20 + 1 = 89`，而那一行寫「合計 90 秒」。
   *
   * 差一秒不影響判斷，但讀的人會停下來重算（我就停了）。
   * 現在合計改用螢幕上那幾個數字算，所以**這一格可以直接驗加法**。
   */
  const steps = [...out.matchAll(/^\s+[✓X] \S+\s+(\d+) 秒$/gm)].map((m) => Number(m[1]));
  const totalShown = Number(/合計 (\d+) 秒/.exec(out)?.[1] ?? -1);
  const sum = steps.reduce((a, b) => a + b, 0);
  ok(
    `每一步印出來的秒數加起來就是合計（${steps.join(' + ')} = ${sum}，合計 ${totalShown}）`,
    steps.length > 0 && totalShown === sum,
    out.split('\n').filter((l) => /秒/.test(l)).join(' | '),
  );

  /*
   * ── 斷言不要跟「哪一步比較快」綁在一起 ──────────────
   *
   * 原本這一格寫死 `named[1] === 'verify:all' && Number(named[2]) >= 50`。
   * 慢的那一步是靠忙等 700ms 造出來的，而快的那一步 `echo ok` 也要經過
   * 一次 `npm run`（起一個 node 行程）—— 機器一有負載，那一邊超過 700ms
   * 不是不可能，於是這一格會紅，而紅的理由跟它要驗的事情無關。
   *
   * 第 7 輪（第四十三圈）就把這件事記進待辦了（「斷言的邊界有沒有跟
   * 量得到的耗時綁在一起」），第 7 輪（第四十五圈）逐條驗待辦時處理。
   *
   * 改成從**輸出自己**推：最久的那一步要真的是螢幕上秒數最大的那一個，
   * 而百分比要等於它自己的秒數除以合計。一個時間常數都不用。
   *
   * 反貧化那一半也要有：兩步的秒數如果一樣，「最大的」證明不了什麼 ——
   * 那時候要說出來，不是安靜地綠。
   */
  const rows = [...out.matchAll(/^\s+[✓X] (\S+)\s+(\d+) 秒$/gm)].map((m) => ({
    name: m[1],
    sec: Number(m[2]),
  }));
  const maxSec = Math.max(...rows.map((r) => r.sec));
  const tie = rows.filter((r) => r.sec === maxSec).length !== 1;
  const named = /合計 \d+ 秒，最久的是 (\S+)（(\d+)%）/.exec(out);
  const namedRow = named === null ? undefined : rows.find((r) => r.name === named[1]);
  const okTotal =
    named !== null &&
    !tie &&
    namedRow !== undefined &&
    namedRow.sec === maxSec &&
    totalShown > 0 &&
    Number(named[2]) === Math.round((namedRow.sec / totalShown) * 100);
  ok(
    `說得出合計與最久的那一步（螢幕上最大的是 ${maxSec} 秒${tie ? '，而且不只一步' : ''}）`,
    okTotal,
    tie
      ? `兩步的秒數一樣（${rows.map((r) => `${r.name} ${r.sec}`).join('、')}）—— 這一格證明不了「挑的是最久的那一個」`
      : out.split('\n').filter((l) => l.includes('合計') || l.includes('✓')).join(' | '),
  );

  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 沒有模擬到的是哪幾份 workflow ────────────────────
 *
 * 第 7 輪（第三十圈）：`check.yml` 在 GitHub 上跑過 0 次
 * （只在 pull_request 觸發，而這個 repo 一個 PR 都沒開過），
 * 而這支腳本只讀 deploy.yml —— 它的步驟沒有在任何地方執行過。
 * 不是漏洞（內容有 check:workflows 靜態守），但要說得出範圍。
 *
 * 名單從目錄讀，所以這兩格驗的是「真的去看了目錄」，
 * 不是「印了一句固定的話」。
 */
{
  const dir = await fakeRepo({ steps: ['verify:all'], scripts: { 'verify:all': 'echo ok' } });
  await addWorkflows(dir, ['check.yml', 'sync-feeds.yml']);
  const { out } = await sim(dir);
  const m = /範圍：這支腳本只模擬 deploy\.yml。另外 (\d+) 份沒有模擬到 —— (.+?)（/.exec(out);
  const ok = m !== null && Number(m[1]) === 2 && m[2].trim() === 'check.yml、sync-feeds.yml';
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 說得出沒有模擬到哪幾份 workflow（名單從目錄讀）`);
  if (!ok) console.log('        ' + (out.split('\n').find((l) => l.includes('範圍')) ?? '（那一行根本沒印）'));
  await rm(dir, { recursive: true, force: true });
}

/* 反向：只有 deploy.yml 的時候不要無中生有 */
{
  const dir = await fakeRepo({ steps: ['verify:all'], scripts: { 'verify:all': 'echo ok' } });
  const { out } = await sim(dir);
  const ok = /範圍：.github\/workflows\/ 底下只有 deploy\.yml。/.test(out) && !/沒有模擬到/.test(out);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : 'X'} 只有 deploy.yml 時說「只有它」（反向案例）`);
  if (!ok) console.log('        ' + (out.split('\n').find((l) => l.includes('範圍')) ?? '（那一行根本沒印）'));
  await rm(dir, { recursive: true, force: true });
}

/*
 * ── 「全部通過」不能蓋掉「這次沒有驗到身分規則」 ──────────
 *
 * 第 7 輪（第三十三圈）量到：這支腳本跑的是版控那一份，
 * 而 `identity.local.ts` 是 gitignore 的 —— 暫存工作樹裡不可能有它。
 * 沒有 `PRIVACY_NEEDLES` 時 `audit:privacy` 印「⚠ 身分規則沒有執行」
 * 然後照樣 exit 0，而這支腳本把子行程輸出收進 pipe、成功時丟掉。
 *
 * 差別是有後果的：真的 CI 上少了那個 secret 會 exit 1、整支 workflow 紅。
 * 也就是這一步的結論可能跟 CI **相反** —— 而這正是這支腳本存在的理由。
 *
 * 兩個方向都要驗：沒有 secret 時要說，有 secret 時不能亂說
 * （只驗前者的話，一句「永遠都印」也會過）。
 */
{
  /* 這一格要走「全部通過」那一條路，所以 verify:all 得真的產出 dist/CNAME */
  const dir = await fakeRepo({
    steps: ['verify:all'],
    scripts: { 'verify:all': 'mkdir -p dist && cp public/CNAME dist/CNAME' },
  });

  const without = await sim(dir, [], { PRIVACY_NEEDLES: undefined });
  ok('沒有 PRIVACY_NEEDLES 時，說得出「這次沒有驗到身分規則」', /身分規則這次沒有驗到/.test(without.out), without.out);
  ok(
    '那句話說得出本機怎麼驗、以及真的 CI 上會直接紅',
    /audit:privacy/.test(without.out) && /exit 1/.test(without.out),
    without.out,
  );

  const withNeedles = await sim(dir, [], { PRIVACY_NEEDLES: 'someone@example.com' });
  ok('有 PRIVACY_NEEDLES 時不會亂說', !/身分規則這次沒有驗到/.test(withNeedles.out), withNeedles.out);

  await rm(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
