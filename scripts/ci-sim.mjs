#!/usr/bin/env node
// @ts-check
/**
 * 在本機模擬 CI 跑一次 —— `npm run ci:sim`
 *
 * ## 為什麼需要
 *
 * 這個專案的三個 workflow **到現在沒有在 GitHub 上跑過一次**。
 * 而這一整個 session 已經兩次改壞部署路徑，兩次都是本機看不出來的：
 *
 * - 第 7 輪（第二圈）：`deploy.yml` 同一個 step 有兩個 `env:`（YAML 重複鍵）
 * - 第 7 輪（第四圈）：`check:content` 排在建置之前，而乾淨的 checkout 沒有 dist/
 *
 * `check:workflows` 靜態擋得住想得到的類型，擋不住想不到的。
 * 這支腳本則是**真的照 workflow 的順序跑一次**，而且只用**版控裡的檔案** ——
 * CI 拿到的就是那些，本機多出來的東西（`identity.local.ts`、`dist/`、
 * `.env`）在那裡都不存在。
 *
 * ## 為什麼 node_modules 用連結而不是 npm ci
 *
 * `npm ci` 要下載幾百 MB，而站主的開機碟很緊（第 7 輪〔第四圈〕
 * 就因為暫存區塞爆而讓 Bash 整個失敗過）。
 * lockfile 與 package.json 的一致性另外用 `npm ls` 驗，那才是 `npm ci` 會擋的東西。
 */
import { execFileSync, execSync } from 'node:child_process';
import { rmSync, mkdirSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatStepFailure } from './lib/step-failure.mjs';
import { deployStepsFrom, unextracted, stepKinds } from './lib/deploy-steps.mjs';
import { runBlock } from './lib/workflow-shell.mjs';
import { compareDirs } from './lib/dist-diff.mjs';

/*
 * `--root=<路徑>` 讓測試指到一份假的專案。
 *
 * 第 7 輪（第二十圈）加的。這支腳本「沒有任何測試」這條待辦掛了很多圈，
 * 理由一直是「它是跑起來就會做事的腳本」—— 而真正卡住的其實只有這一行：
 * 根目錄寫死在自己的位置上，沒辦法指到別的地方跑。
 * 第 7 輪（第十八圈）已經把比對那一塊拆成 lib 並測過，
 * 剩下的「串起來」這一層，只要能換根目錄就測得動。
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg
  ? resolve(rootArg.slice('--root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
/*
 * 暫存放在專案所在的磁碟，不要放 /tmp ——
 * 開機碟只剩幾百 MB，而這裡會放一份完整的原始碼。
 */
const TMP = resolve(ROOT, '..', `.ci-sim${rootArg ? '-test' : ''}`);

/*
 * deploy.yml 的步驟順序 —— **從 deploy.yml 讀出來的，不是抄一份**。
 *
 * 這裡原本是一個寫死的陣列，上面掛著一句「改 workflow 的時候這裡也要改」。
 * 第 7 輪（第十圈）量到的問題就是那句話：它是一條沒有人強制的規約，
 * 而這支腳本的整個價值建立在「它跑的跟 CI 跑的是同一串」之上。
 * 走鐘的時候不會有任何徵兆 —— 模擬照樣全綠，只是綠的是別的東西。
 *
 * 抽取完先驗過（見底下）：抽不到東西、或抽到的東西不含 verify:all，
 * 就當場拋錯而不是安靜地跑一個空清單。
 * 跟 test-workflow-shell 抽 sync-feeds.yml 的做法一致。
 */
const deployYml = readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const DEPLOY_STEPS = deployStepsFrom(deployYml);

if (DEPLOY_STEPS.length === 0) {
  throw new Error('deploy.yml 裡抽不到任何 `npm run` 步驟 —— 不是格式變了就是抽取寫錯了');
}
/*
 * 抽完自己驗一次：這份 YAML 提到的每一個 `npm run X`，抽取都抽到了嗎？
 *
 * 第 7 輪（第十三圈）實測：原本只認單行 `run:`，把 `test:built` 改寫成
 * `run: |` 區塊（完全合法、GitHub 照跑）之後，ci:sim 從三步變兩步，
 * 而且照樣印「全部通過」。少掉的剛好是 `verify:all` 蓋不到的那一半。
 * 下面那條只保護 verify:all，保護不到這種情況；這一條才是通用的。
 */
const missed = unextracted(deployYml, DEPLOY_STEPS);
if (missed.length > 0) {
  throw new Error(
    `deploy.yml 裡提到 npm run ${missed.join('、')}，但抽取沒抽到 —— ` +
      '抽取一定漏了某種寫法（單行、區塊純量都要認）。',
  );
}
if (!DEPLOY_STEPS.includes('verify:all')) {
  throw new Error(
    `deploy.yml 抽出來的步驟是 [${DEPLOY_STEPS.join(', ')}]，裡面沒有 verify:all —— ` +
      '那是六道關卡，不可能不在部署路徑上。抽取一定是錯的。',
  );
}

console.log('\nCI 模擬（只用版控裡的檔案）\n' + '─'.repeat(56));

/*
 * ── 先講清楚這次模擬是在哪個 Node 上跑的 ──
 *
 * 這支腳本的承諾是「照 deploy.yml 的順序跑一次」，但它用的是**這台機器的
 * Node**，而 CI 用的是 `.nvmrc` 指定的版本線裡最新的那一個。兩者不同的話，
 * 「全部通過」證明的就不是 CI 會發生的事。
 *
 * 第 7 輪（第六圈）量到的具體情況：本機 v22.15.1，而 package.json 的
 * engines 要求 >=22.19.0（來源是 undici 這個相依套件）。也就是說
 * **六圈以來每一次「六道全過」都是在一個被宣告為不支援的版本上驗的**。
 * `.npmrc` 沒有 engine-strict，所以 npm 只會在 install 時警告一次，
 * 而這個專案很少重跑 install —— 那句警告沒有人看過。
 *
 * 不擋（跑得起來就是跑得起來，而站主要不要升級 Node 是他的決定），
 * 但結論必須帶著這個條件。
 */
const nodeNow = process.versions.node;
const engineRange = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).engines?.node ?? '';
const floor = /(\d+)\.(\d+)\.(\d+)/.exec(engineRange);
let nodeMismatch = false;
if (floor) {
  const now = nodeNow.split('.').map(Number);
  const need = floor.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (now[i] !== need[i]) { nodeMismatch = now[i] < need[i]; break; }
  }
}
const nvmrc = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim();
console.log(`  Node：這台機器 v${nodeNow}　engines 要求 ${engineRange}　CI 裝 .nvmrc 的 ${nvmrc}.x 最新版`);
if (nodeMismatch) {
  console.log(`  ⚠ 這台機器低於 engines 的門檻 —— 下面的結果證明的是 v${nodeNow}，不是 CI 會跑的版本`);
}

/*
 * ── 這次模擬涵蓋 deploy.yml 的幾步 ──────────────────
 *
 * 第 7 輪（第二十一圈）量到的：`deploy.yml` 有 10 步，
 * 這支腳本跑得動的是其中 4 步（三個 npm script ＋ CNAME 那段 shell），
 * `npm ci` 用 `npm ls` 代打，剩下 5 步是 GitHub 的 action。
 *
 * 沒有這一行的話，「照 deploy.yml 的順序跑完，全部通過」讀起來像
 * 「部署會成功」—— 而**真正把東西送出去的那兩步（上傳、部署）
 * 正好在模擬不到的那一半**。這支腳本擋得住的是「建置與檢查會不會過」，
 * 擋不住「Pages 的設定對不對」。
 */
const kinds = stepKinds(deployYml);
const simulated = DEPLOY_STEPS.length + 1; // npm 的那幾步 ＋ CNAME 那段 shell
console.log(
  `  涵蓋：deploy.yml 共 ${kinds.total} 步 —— 這裡真的跑 ${simulated} 步` +
    `（${DEPLOY_STEPS.length} 個 npm script ＋ CNAME 那段 shell），` +
    `npm ci 用 npm ls 代打，其餘 ${kinds.uses} 步是 GitHub 的 action（含上傳與部署），本機跑不了`,
);

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

try {
  // git archive 給的正好是「CI 會拿到的東西」
  execSync(`git archive HEAD | tar -x -C "${TMP}"`, { cwd: ROOT });
  const count = execSync(`find "${TMP}" -type f | wc -l`, { encoding: 'utf8' }).trim();
  console.log(`  版控裡的檔案：${count} 個`);

  symlinkSync(resolve(ROOT, 'node_modules'), resolve(TMP, 'node_modules'));

  // npm ci 真正會擋的是這個
  try {
    execFileSync('npm', ['ls', '--depth=0'], { cwd: ROOT, stdio: 'ignore' });
    console.log('  ✓ package.json 與 lockfile 一致（npm ci 不會失敗）');
  } catch {
    console.log('  X package.json 與 lockfile 對不上 —— npm ci 會直接失敗');
    process.exitCode = 1;
  }

  let failed = 0;
  /*
   * 第一個失敗的步驟。GitHub Actions 會**停在這裡**，這支腳本則會把剩下的
   * 跑完 —— 多出來的資訊有用，但後面的 X 很可能只是連鎖反應
   * （建置沒過 → 沒有 dist → 檢查產出的那幾道當然也過不了）。
   * 不講清楚的話，一個型別錯誤看起來會像三件互不相干的事同時壞掉。
   */
  let firstFailure = '';
  for (const step of DEPLOY_STEPS) {
    try {
      execFileSync('npm', ['run', '--silent', step], {
        cwd: TMP,
        stdio: 'pipe',
        // CI 上有這個 secret；沒有的話身分規則不會跑，那是另一種情況
        env: { ...process.env, PRIVACY_NEEDLES: process.env.PRIVACY_NEEDLES ?? '' },
      });
      console.log(`  ✓ ${step}`);
    } catch (err) {
      failed++;
      if (!firstFailure) firstFailure = step;
      console.log(`  X ${step}`);
      console.log(formatStepFailure(err));
    }
  }

  /*
   * ── deploy.yml 的最後一道：**真的跑它那段 shell** ──
   *
   * 這裡本來是 `existsSync(resolve(TMP, 'dist/CNAME'))` —— 照著 workflow
   * 再寫一份 JS。第 7 輪（第十四圈）比對過兩份的差別：
   *
   *   通過／失敗的判斷　　一樣
   *   印出來的東西　　　　**不一樣** —— workflow 會 `echo "CNAME = $(cat …)"`，
   *                       也就是把實際的網域印出來；這裡不印
   *   以後 workflow 改了　模擬不會跟
   *
   * 第 7 輪（第十圈）把步驟清單從「抄一份」改成「從 deploy.yml 讀出來」，
   * 理由是「走鐘的時候不會有任何徵兆」。同一個理由套在這一步上。
   * 取法用的是 `test-workflow-shell.mjs` 已經驗過的那一套（現在共用）。
   */
  const cnameBlock = runBlock(deployYml, '檢查 CNAME 有被帶進輸出');
  if (!cnameBlock.includes('dist/CNAME')) {
    throw new Error('deploy.yml 的 CNAME step 抽出來不含 dist/CNAME —— 抽取一定是錯的');
  }
  if (!firstFailure) {
    try {
      const out = execFileSync('bash', ['-e', '-c', cnameBlock], { cwd: TMP, encoding: 'utf8' });
      console.log('  ✓ dist/CNAME 有被帶進輸出　' + out.trim().split('\n').pop());
    } catch (err) {
      failed++;
      console.log('  X deploy.yml 的 CNAME 檢查沒過');
      console.log(formatStepFailure(err));
    }
  } else if (existsSync(resolve(TMP, 'dist/CNAME'))) {
    console.log('  ✓ dist/CNAME 有被帶進輸出（前面有步驟失敗，只看檔案在不在）');
  } else if (firstFailure) {
    /*
     * 前面已經有步驟失敗 → dist 根本沒建起來，這一行的「不見了」是連鎖反應。
     * 第 7 輪（第十二圈）四次故意弄壞的實測裡**每一次**都多出這句紅字，
     * 而它指的是一個沒有發生的問題（自訂網域好好的）。
     */
    console.log(`  – dist/CNAME：沒有檢查（${firstFailure} 先失敗了，dist 沒有建起來）`);
  } else {
    failed++;
    console.log('  X dist/CNAME 不見了 —— GitHub 會取消自訂網域');
  }

  /*
   * ── 本機的那一份，跟讀者會拿到的那一份 ──────────────
   *
   * 這個專案的六道關卡全部跑在本機的 `dist/` 上，而讀者拿到的是 CI
   * 從版控建的。這一步把兩份真的比一次 —— 一樣的話，前面所有在本機
   * 量到的東西才真的是在講讀者拿到的東西。
   *
   * 不一樣**不算失敗**：`identity.local.ts` 刻意不進版控，有它的機器上
   * `/about` 會多一段「所在」。那是設計，不是 bug —— 但要說出來，
   * 因為文件教她建那個檔案的時候沒說「線上不會有」。
   */
  const localDist = resolve(ROOT, 'dist');
  const builtDist = resolve(TMP, 'dist');
  if (!firstFailure && existsSync(localDist) && existsSync(builtDist)) {
    const { onlyA, onlyB, differing, same } = await compareDirs(localDist, builtDist);
    const drift = onlyA.length + onlyB.length + differing.length;
    if (drift === 0) {
      console.log(`  ✓ 本機的 dist/ 跟這次從版控建的一模一樣（${same} 個檔案）`);
    } else {
      const show = (/** @type {string[]} */ xs) =>
        xs.slice(0, 4).join('、') + (xs.length > 4 ? ` 等 ${xs.length} 個` : '');
      console.log(`  · 本機的 dist/ 跟版控建的有 ${drift} 處不同（${same} 個一樣）`);
      if (differing.length) console.log(`      內容不同：${show(differing)}`);
      if (onlyA.length) console.log(`      只有本機有：${show(onlyA)}`);
      if (onlyB.length) console.log(`      只有版控建的有：${show(onlyB)}`);
      console.log(
        '      有 src/config/identity.local.ts 的話這是正常的 —— 那些值只在你的機器上，\n' +
          '      **讀者拿到的是版控這一份**。其他情況代表有沒進版控的檔案影響了建置。',
      );
    }
  }

  console.log('─'.repeat(56));
  if (failed > 1) {
    console.log(`  （CI 會停在第一個失敗的步驟「${firstFailure}」；後面的 X 有可能只是它的連鎖反應。）`);
  }
  console.log(
    failed > 0
      ? `${failed} 個步驟失敗。\n`
      : nodeMismatch
        ? `照 deploy.yml 的順序跑完，全部通過 —— **在 v${nodeNow} 上**。\n` +
          `  CI 用的是更新的版本，這次沒有驗到那個版本。\n`
        : '照 deploy.yml 的順序跑完，全部通過。\n',
  );
  if (failed > 0) process.exitCode = 1;
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
