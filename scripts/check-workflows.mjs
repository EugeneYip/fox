#!/usr/bin/env node
// @ts-check
/**
 * 建置管線的靜態檢查 —— `npm run check:workflows`
 *
 * 兩件事：GitHub Actions 的 workflow 檔案本身，以及跑它的 Node 版本。
 *
 * ## 為什麼需要
 *
 * 第二圈第 5 輪我在 `deploy.yml` 的同一個 step 上加了第二個 `env:` ——
 * YAML 的重複鍵。那份檔案在本機**完全沒有任何東西會檢查它**，
 * 而 GitHub 那邊很可能直接拒絕整個 workflow。
 * 也就是說：部署流程壞掉了，而且要等到真的 push 上去才會知道。
 *
 * 2026-09-04 之前，這個專案的三個 workflow **一次都沒有在 GitHub 上跑過**。
 * 那天推上去，`deploy.yml` 第一次跑就死在一個只在 CI 上成立的路徑
 * （`.npmrc` 裡的 `/Volumes/⋯`）—— 本機六道關卡全綠，靜態檢查也全綠。
 *
 * 到現在（2026-09-04）跑過的仍然只有 `deploy.yml`：
 * `check.yml` 只在 PR 上跑而還沒有 PR，`sync-feeds.yml` 的 cron 還沒到。
 * 所以「push 之後就會發現」對後兩支仍然不是一個安全的假設。
 *
 * ## 為什麼不用 YAML 剖析器
 *
 * `js-yaml` 不是這個專案的相依套件，而站主的磁碟空間很緊。
 * 這裡要抓的東西很具體（重複鍵、關卡有沒有接上、指令拼錯），
 * 用行為單位的掃描就夠了，不需要完整剖析。
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployStepsFrom, withoutComments } from './lib/deploy-steps.mjs';
import { documentationDuty } from './lib/copy-rules.mjs';

/*
 * `--root=<路徑>` 只給 scripts/test-workflow-rules.mjs 用 —— 它會做一份
 * 假的專案（假 workflow + 假 package.json + 假 .nvmrc），確認每條規則
 * 真的會在該響的時候響。第 7 輪（第六圈）之前這四條規則一個案例都沒有。
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg
  ? resolve(rootArg.slice('--root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, '.github/workflows');

/** @type {{ file: string, line: number, id: string, msg: string }[]} */
const problems = [];

/** @type {string[]} */
const notes = [];

/* ↑ 第 7 輪（第三十一圈）從第 572 行搬上來：部署路徑那一段要用它，而那一段在更前面。 */
/**
 * 這支腳本認得的規則。
 *
 * 為什麼要有這份明列：測試需要知道「有哪幾條規則」才能檢查每條都有案例，
 * 而從原始碼用正則去抽 `add(...)` 的第三個參數會漏掉多行寫法的呼叫
 * （第 7 輪〔第六圈〕第一版就漏了兩條，還「只抽到 2 個」地通過了一半）。
 * 拿正則剖結構化資料是這個 repo 反覆踩到的坑，所以改成讓腳本自己說。
 *
 * 下面的 add() 會擋住沒登記的 id，兩邊不可能默默分岔。
 */
const RULE_IDS = [
  'duplicate-key',
  'unknown-script',
  'gate-not-on-deploy-path',
  'gate-missing-in-check',
  'needs-dist-before-build',
  'test-file-not-run',
  'machine-path-in-config',
  'dispatch-target-missing',
  'step-output-unset',
  'gate-count-stale',
  'rule-undocumented',
];

if (process.argv.includes('--list-rules')) {
  console.log(RULE_IDS.join('\n'));
  process.exit(0);
}

/**
 * 每條規則這次實際判斷過幾個東西。
 *
 * 第二十一圈的問題：一條只判斷過 3 個東西的規則，跟判斷過幾百個的，
 * 綠燈的意思完全不一樣。這一支尤其值得問。
 *
 * ── 那句「三份都沒跑過」已經過期了 ──────────
 *
 * 寫這一段的時候三份 workflow 一次都沒在 GitHub 上跑過，所以這支腳本
 * 是它們唯一的守門人。第 7 輪（第三十六圈）用 `gh run list` 實際數過：
 *
 *   deploy.yml       跑過（每推一次就多一次）
 *   sync-feeds.yml   跑過（排程）
 *
 * （這裡原本寫「8 次」「2 次」。第 7 輪〔第四十圈〕同一天再數是 9 與 3 ——
 *   那種數字寫下來的那一刻就開始爛，所以只留「有沒有跑過」。）
 *   check.yml        不會自己跑（只在 PR 與手動觸發上啟動）
 *                    —— 第 7 輪（第四十四圈）手動觸發過一次，12 步全綠
 *
 * 前兩份現在有真的執行紀錄可以對照了。`check.yml` 沒有 ——
 * 它只在 `pull_request` 與 `workflow_dispatch` 上觸發，而這個專案
 * 是站主直接推 main，不開 PR。所以它到今天仍然只有這支腳本在守。
 *
 * @type {Map<string, number>}
 */
const subjects = new Map();
/** 這條規則這次看了 n 個東西（0 也要看得見） */
const saw = (/** @type {string} */ id, /** @type {number} */ n) =>
  subjects.set(id, (subjects.get(id) ?? 0) + n);

/**
 * @param {string} file
 * @param {number} line  0 表示「整份檔案」，不指向特定行
 * @param {string} id
 * @param {string} msg
 */
const add = (file, line, id, msg) => {
  if (!RULE_IDS.includes(id)) throw new Error(`規則 id "${id}" 沒有登記在 RULE_IDS 裡`);
  problems.push({ file, line, id, msg });
};

const files = (await readdir(DIR)).filter((f) => /\.ya?ml$/.test(f));

/**
 * 每一份 workflow 抹掉註解之後的內容。
 *
 * 新加的兩條規則要**跨檔案**看（A 呼叫 B，B 有沒有讓自己被呼叫的入口），
 * 所以先全部讀進來，不能邊讀邊判斷。
 * @type {Map<string, string>}
 */
const bareTexts = new Map();
for (const n of files) {
  bareTexts.set(n, withoutComments(await readFile(resolve(DIR, n), 'utf8')));
}

/** package.json 裡真的存在的 script 名稱 */
const scripts = new Set(
  Object.keys(JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')).scripts ?? {}),
);

for (const name of files) {
  const path = resolve(DIR, name);
  const rel = relative(ROOT, path);
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n');

  /*
   * ── 重複鍵 ──────────────────────────────────────
   *
   * 一個 mapping 裡不能有兩個一樣的鍵。用縮排追蹤區塊：
   * 縮排變深就進入新區塊、變淺就把比它深的區塊全部關掉。
   * 遇到 `- ` 開頭表示新的陣列元素，同層的鍵要重新開始算。
   */
  /** @type {Map<number, Set<string>>} */
  const keysAtIndent = new Map();
  let inBlockScalar = false;
  let blockScalarIndent = 0;

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) return;

    const indent = line.length - line.trimStart().length;

    // `run: |` 之類的區塊純量裡面是 shell，不是 YAML，整段跳過
    if (inBlockScalar) {
      if (indent > blockScalarIndent) return;
      inBlockScalar = false;
    }

    for (const [ind] of keysAtIndent) if (ind > indent) keysAtIndent.delete(ind);

    const body = line.trimStart();
    const isItem = body.startsWith('- ');
    if (isItem) for (const [ind] of keysAtIndent) if (ind >= indent) keysAtIndent.delete(ind);

    const m = body.replace(/^-\s+/, '').match(/^([A-Za-z_][\w.-]*)\s*:(\s|$)/);
    if (!m) return;
    const key = m[1];
    const effIndent = isItem ? indent + 2 : indent;

    if (/:\s*[|>][-+]?\s*$/.test(line)) {
      inBlockScalar = true;
      blockScalarIndent = effIndent;
    }

    /* 主體是「在某個縮排層看到的鍵」—— 每一個都跟同層的既有鍵比過一次 */
    saw('duplicate-key', 1);
    let set = keysAtIndent.get(effIndent);
    if (!set) keysAtIndent.set(effIndent, (set = new Set()));
    if (set.has(key)) {
      add(
        rel,
        i + 1,
        'duplicate-key',
        `同一個區塊裡出現兩個 "${key}:"。YAML 不允許，GitHub 會拒絕整份 workflow。` +
          '　改法：留一個、刪一個 —— 兩個都要的話，多半是縮排寫錯了（本來應該是不同層）。',
      );
    }
    set.add(key);
  });

  /*
   * ── run: npm run <name> 指的 script 真的存在嗎 ──
   *
   * 掃的是**抹掉註解之後**的同一份文字（行數不變，所以行號還是對的）。
   * 第 7 輪（第十六圈）的誤報探針量到：註解裡寫「以前這裡跑 npm run 舊名字」
   * 會被報成「package.json 裡沒有這個 script」—— 那是在講它，不是在跑它。
   * `run: |` 區塊裡的 shell 註解同理。
   */
  const bare = withoutComments(text).split('\n');
  for (const [idx, raw] of bare.entries()) {
    for (const m of raw.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      saw('unknown-script', 1);
      if (!scripts.has(m[1])) {
        add(
          rel,
          idx + 1,
          'unknown-script',
          `package.json 裡沒有 "${m[1]}" 這個 script。` +
            '　改法：對照 package.json 的 scripts 把名字打對；' +
            '如果那個 script 是被改名或刪掉的，這一步也要跟著改。',
        );
      }
    }
  }

  /*
   * ── gh workflow run X.yml：X 讓不讓人這樣叫 ──────────
   *
   * `sync-feeds.yml` 的最後一步是 `gh workflow run deploy.yml`。
   * 那一步**不能省**：用 GITHUB_TOKEN 做的 push 不會觸發別的 workflow，
   * 所以同步抓回來的新影片只會躺在 repo 裡（那個 workflow 自己的註解
   * 花了八行在解釋這件事）。
   *
   * 而 `gh workflow run` 只在目標 workflow 宣告了 `workflow_dispatch` 時
   * 才成立。有人把 deploy.yml 的 `workflow_dispatch:` 拿掉
   * （「反正 push 就會部署，留這個做什麼」）——
   * 六道關卡、兩套測試、七條靜態規則**全部照樣綠**，
   * 而網站從此不會因為同步而更新。
   *
   * 第 4 輪（第二十七圈）加。那天量到：`sync-feeds.yml` 到當時為止
   * 在 GitHub 上跑過 **0 次**，所以這個相依從來沒有被真的執行驗證過。
   */
  for (const [idx, raw] of bare.entries()) {
    for (const m of raw.matchAll(/gh workflow run\s+([\w.-]+\.ya?ml)/g)) {
      saw('dispatch-target-missing', 1);
      const target = m[1];
      const targetText = bareTexts.get(target);
      if (targetText === undefined) {
        add(
          rel,
          idx + 1,
          'dispatch-target-missing',
          `這一步要叫 ${target}，但 .github/workflows/ 底下沒有這個檔案。` +
            '　改法：把檔名打對，或者那支 workflow 被刪掉的話這一步也要跟著處理。',
        );
        continue;
      }
      if (!/^\s*workflow_dispatch:/m.test(targetText)) {
        add(
          rel,
          idx + 1,
          'dispatch-target-missing',
          `${target} 沒有宣告 workflow_dispatch，gh workflow run 叫不動它。` +
            '　改法：在 ' + target + ' 的 on: 底下加回 workflow_dispatch:，' +
            '或者改用別的方式觸發（但 GITHUB_TOKEN 的 push 不會觸發 workflow）。',
        );
      }
    }
  }

  /*
   * ── if: steps.<id>.outputs.<名字> 指得到東西嗎 ──────────
   *
   * 這一條守的是**安靜的**那一種壞法。
   *
   * `sync-feeds.yml` 的「觸發部署」是 `if: steps.commit.outputs.changed == 'true'`。
   * 上一步的 `id: commit` 被改名、或者那段 shell 不再寫 `changed=` 進
   * `$GITHUB_OUTPUT` —— GitHub **不會報錯**，它把讀不到的 output 當成空字串，
   * 條件為假，那一步直接跳過。
   *
   * 結果：同步成功、commit 進去了、workflow 整支**綠燈**，
   * 而網站永遠不更新。連紅燈都沒有。
   */
  /*
   * 每個有 id 的 step，是 shell（`run:`）還是現成的 action（`uses:`）。
   *
   * 這個分別是第一版漏掉的：`deploy.yml` 讀
   * `steps.deployment.outputs.page_url`，而那是 `actions/deploy-pages`
   * **自己宣告的 output** —— action 的 output 不會出現在 workflow 檔案裡，
   * 拿「有沒有 echo 進 $GITHUB_OUTPUT」去要求它，是必然的誤報。
   * 第一次跑就報了那一個，關卡當場擋下來。
   *
   * 所以：id 存不存在對兩種都問，output 寫沒寫只對 shell 問。
   * @type {Map<string, { hasRun: boolean }>}
   */
  const stepInfo = new Map();
  {
    /** @type {{ id: string | null, hasRun: boolean } | null} */
    let cur = null;
    const flush = () => {
      if (cur?.id) stepInfo.set(cur.id, { hasRun: cur.hasRun });
    };
    for (const raw of bare) {
      if (/^\s*-\s+\S/.test(raw)) {
        flush();
        cur = { id: null, hasRun: false };
      }
      if (!cur) continue;
      const idm = raw.match(/^\s*-?\s*id:\s*([\w-]+)\s*$/);
      if (idm) cur.id = idm[1];
      if (/^\s*-?\s*run:\s*/.test(raw)) cur.hasRun = true;
    }
    flush();
  }
  for (const [idx, raw] of bare.entries()) {
    for (const m of raw.matchAll(/steps\.([\w-]+)\.outputs\.([\w-]+)/g)) {
      saw('step-output-unset', 1);
      const [, stepId, output] = m;
      const info = stepInfo.get(stepId);
      if (!info) {
        add(
          rel,
          idx + 1,
          'step-output-unset',
          `這裡讀 steps.${stepId}.outputs.${output}，但這份 workflow 裡沒有 id: ${stepId} 的 step。` +
            '　改法：把 id 打對。讀不到的 output 是空字串，條件會靜靜地變成假，不會報錯。',
        );
        continue;
      }
      /* action 的 output 是它自己宣告的，workflow 檔案裡看不到，不能要求 */
      if (!info.hasRun) continue;
      /*
       * 有那個 id、而且是 shell，再問那段 shell 到底寫不寫這個名字。
       * 只看 `名字=` 出現在同一份文字裡就算 —— 精確追到「哪一個 step 寫的」
       * 需要真的剖 YAML，而這裡要抓的是「整份檔案裡根本沒人寫過它」那一種。
       */
      if (!new RegExp(`${output}=[^\\s]*"?\\s*>>\\s*"?\\$GITHUB_OUTPUT`).test(bare.join('\n'))) {
        add(
          rel,
          idx + 1,
          'step-output-unset',
          `這裡讀 steps.${stepId}.outputs.${output}，但這份 workflow 裡沒有任何一行把 ${output}= 寫進 $GITHUB_OUTPUT。` +
            '　改法：在那個 step 的 shell 裡 echo "' + output + '=…" >> "$GITHUB_OUTPUT"。' +
            '讀不到的 output 是空字串，條件會靜靜地變成假，整支 workflow 還是綠的。',
        );
      }
    }
  }
}

/*
 * ── 部署路徑上該有的關卡 ────────────────────────
 *
 * 這一條守的是一個踩過兩次的坑：關卡加在 check.yml 裡，
 * 但那個 workflow 跟 deploy.yml 互相獨立 —— 紅燈擋不住部署。
 */
const deploy = await readFile(resolve(DIR, 'deploy.yml'), 'utf8').catch(() => '');
/*
 * 「這份 workflow 真的會跑哪幾個 npm script」統一走 deployStepsFrom() ——
 * 它會剝掉 YAML 註解與行尾註解，也認得區塊純量。
 *
 * 為什麼不用 `yml.includes('npm run X')`：deploy.yml 現在就有一行註解寫著
 * 「之前這裡只跑 npm run build」。用字串比對的話，**註解會被當成有跑** ——
 * 對這一條來說那是**假的綠燈**：真的把 verify:all 那一步刪掉、
 * 而註解裡還提到它，這條規則會安靜通過。
 * （第 7 輪〔第十五圈〕實測：那一行註解讓「部署路徑上會跑什麼」多算了一個
 * build —— 我自己新寫的那段就先踩到了。）
 */
/*
 * package.json 讀一次就好。第 7 輪（第三十一圈）之前這個檔案讀了三次
 * （行 115、481、512），而那時候只有它們用得到；現在部署路徑的必跑清單
 * 也要從它推，再讀第四次就太多了。
 */
const pkgJson = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));

const deploySteps = deployStepsFrom(deploy);
/*
 * ── 部署路徑上非跑不可的那幾個，從 package.json 推出來 ──────
 *
 * 這裡本來寫死 `['verify:all', 'test:units', 'test:built']`。
 * 那份清單今天是對的 —— 而它剛好等於「`verify:all` ＋ `test:tools` 的成員」。
 *
 * 第 7 輪（第三十一圈）實測那個「剛好」的代價：把
 * `test:tools` 改成 `test:units && test:built && check:workflows`，
 * 而 deploy.yml 沒有跑第三個 —— `check:workflows` 說**「沒有發現問題」**。
 *
 * 而且會連鎖：底下的 `gate-missing-in-check` 是從 deploy.yml 推的，
 * 所以 deploy 漏掉的那一道，check.yml 也不會被要求。
 * **一條沒有人選過的清單，安靜地決定了整條部署路徑蓋到哪裡。**
 *
 * `CLAUDE.md` 寫的規矩是「commit 之前跑 verify:all 與 test:tools」——
 * 那才是這條規則真正的來源，所以從那裡推。
 * 隔壁的 `gate-missing-in-check` 第 7 輪（第十五圈）就已經改成推導了，
 * 這一條是那次沒跟上的那一半。
 */
/*
 * ── 展開的時候要認得這個 repo 自己的跑法 ──────────
 *
 * 這裡本來只認 `npm run X`。而 `test:tools` 後來改成
 * `node scripts/run-steps.mjs test:units test:built`（那支跑完會印
 * 「44 步全部通過」），**一個 `npm run` 都沒有** —— 於是 `toolMembers`
 * 是空的，這條規則退回只要求 `verify:all`。
 *
 * 它有把話說出口（「那不是『都有跑』，是沒有比對到」），但那句話混在
 * 一堆 ⚠ 裡，而底下印的仍然是「沒有發現問題」。
 * 第 7 輪（第四十三圈）量到的：必跑清單從 3 條縮成 1 條，
 * 也就是 deploy.yml 拿掉 `test:built` 不會有人說話。
 *
 * 測試沒抓到是因為**假語料寫的是舊寫法**（`test:tools` 在 fixture 裡
 * 仍然是 `npm run …`），所以那條規則在假的 repo 上一直是活的。
 */
/** @param {string} name 把複合 script 展開成它呼叫的那幾個 */
const membersOf = (name) => {
  const body = String(pkgJson.scripts?.[name] ?? '');
  const viaNpm = [...body.matchAll(/npm run ([a-z0-9:@-]+)/g)].map((m) => m[1]);
  /* `run-steps.mjs a b c` —— 後面那幾個 token 就是要一步一步跑的 script 名 */
  const runner = /run-steps\.mjs\s+([^&|;]+)/.exec(body);
  const viaRunner = runner
    ? runner[1]
        .trim()
        .split(/\s+/)
        /* 開頭是 `-` 的是旗標不是 script 名 —— 收進去的話這條規則會去要求
           deploy.yml 跑一個不存在的 `npm run --something`（假紅燈）。
           突變掃描抓到的：第一版只寫了字元類，而 `--quiet` 整串都在那個類裡。 */
        .filter((t) => !t.startsWith('-') && /^[a-z0-9:@-]+$/.test(t))
    : [];
  return [...new Set([...viaNpm, ...viaRunner])];
};
const toolMembers = membersOf('test:tools');
const DEPLOY_MUST_RUN = ['verify:all', ...toolMembers];
if (toolMembers.length === 0) {
  notes.push(
    '部署路徑的必跑清單推不出來：package.json 沒有 `test:tools`，' +
      '或者它沒有呼叫任何 npm script。這一條退回只要求 `verify:all` —— ' +
      '**那不是「都有跑」，是沒有比對到。**',
  );
}
/* deploy.yml 讀不到的話這一條是 0 —— 那才是實話 */
saw('gate-not-on-deploy-path', deploy ? DEPLOY_MUST_RUN.length : 0);
for (const required of DEPLOY_MUST_RUN) {
  /* 跑複合的那一個也算數 —— deploy.yml 現在是逐一列，但列成 test:tools 一樣對 */
  const covered = deploySteps.includes(required) || (toolMembers.includes(required) && deploySteps.includes('test:tools'));
  if (deploy && !covered) {
    add(
      '.github/workflows/deploy.yml',
      0,
      'gate-not-on-deploy-path',
      `deploy.yml 沒有跑 npm run ${required}。加在 check.yml 裡是不夠的 —— ` +
        '那個 workflow 紅燈不會擋住部署。' +
        `　改法：在 deploy.yml 的部署步驟之前加一步 \`run: npm run ${required}\`。`,
    );
  }
}

/*
 * ── check.yml 有沒有跟上 verify:all ────────────────
 *
 * `check.yml` 把六道關卡**逐一列成獨立的 step**，而不是跑一次 `verify:all`。
 * 那是刻意的：GitHub 的介面上看得出是哪一道紅了，而不是「verify:all ✗」。
 *
 * 代價是同一份清單存在兩個地方。加第七道關卡的時候：
 * `deploy.yml` 會自動跟上（它跑的是複合的 `verify:all`），
 * 而 `check.yml` **不會** —— 於是 push 之後看到的是一個少跑一道的綠勾。
 *
 * 第 7 輪（第七圈）實測當下兩份是一致的（六道、順序也一樣），
 * 所以這條規則加的是「以後也不會分岔」。
 */
/*
 * ── 設定檔裡有沒有「只在一台機器上成立」的絕對路徑 ──────
 *
 * 2026-09-04 第一次把這個 repo 推上 GitHub，第一個 workflow 就死在
 * `npm ci`：
 *
 *     npm error EACCES: permission denied, mkdir '/Volumes'
 *     npm error ⋯ /Volumes/Projects/.npm-cache/_logs
 *
 * 版控裡的 `.npmrc` 有一行 `cache=<站主那台 Mac 的外接碟路徑>` ——
 * 那是為了解決他家目錄磁碟很緊才設的，完全正確，但它**不該進版控**。
 * runner 上沒有那個路徑，而且 npm 連寫 log 都寫不出去。
 *
 * 本機看不出來（路徑當然存在），六道關卡也看不出來（它們不跑 npm ci）。
 * 只有真的在別人的機器上跑才會現形 —— 而這個專案的 workflow 在那之前
 * 一次都沒跑過。
 *
 * ## 判準
 *
 * 只看**會被執行的設定檔**，而且**跳過註解行**。
 * 註解裡寫出那個路徑是為了解釋這條規則本身 —— 這個 repo 已經第十一次
 * 撞到「解釋一條規則，就會需要寫出它禁止的東西」，這次在出貨前就看到了。
 */
{
  const CONFIGS = [
    '.npmrc',
    '.nvmrc',
    'package.json',
    ...files.map((f) => `.github/workflows/${f}`),
  ];
  /** `/Volumes/x`、`/Users/x`、`/home/x` —— 都是某一台機器才有的 */
  const MACHINE_PATH = /(?:^|[\s=:'"(])(\/(?:Volumes|Users|home)\/[A-Za-z0-9._-]+)/;

  saw('machine-path-in-config', CONFIGS.length);
  for (const rel of CONFIGS) {
    const text = await readFile(resolve(ROOT, rel), 'utf8').catch(() => null);
    if (text === null) continue;
    for (const [i, raw] of text.split('\n').entries()) {
      /* 註解不是設定 —— 在註解裡講那個路徑是可以的 */
      const line = raw.trim();
      if (line.startsWith('#') || line.startsWith('//') || line.startsWith('*')) continue;
      const m = MACHINE_PATH.exec(raw);
      if (!m) continue;
      add(
        rel,
        i + 1,
        'machine-path-in-config',
        `這一行有一個只在一台機器上成立的絕對路徑：\`${m[1]}\`。\n` +
          '      設定檔會被別的機器執行 —— CI 上那個路徑不存在，通常整步直接失敗。\n' +
          '      改法：機器專屬的設定放 ~/.npmrc（或對應的使用者層設定），' +
          '專案的設定檔只放在任何機器上都成立的東西。',
      );
    }
  }
}

/*
 * ── scripts/test-*.mjs 有沒有人跑 ────────────────────
 *
 * 「這個專案有哪些測試」寫在兩個地方：**檔案系統**（scripts/test-*.mjs）
 * 與 **package.json**。加一個測試檔要動兩邊，而只動一邊不會有任何徵兆 ——
 * 檔案在那裡、看起來很完整、六道關卡全綠，它只是從來沒有跑過。
 *
 * 第 7 輪（第二十四圈）數的時候是 **30 個檔案、30 個都有人跑**，沒發現問題。
 * 加這條規則不是因為現在有洞，是因為那個洞不會叫 ——
 * 同一輪之前我自己加了兩個測試檔，兩次都是靠記得去改 package.json。
 *
 * 反方向（npm script 指到不存在的檔案）也一起看：那個至少會在跑的時候爆，
 * 但爆在 CI 上比爆在這裡貴。
 */
{
  const pkg = pkgJson;
  const allScripts = Object.values(pkg.scripts ?? {}).join(' && ');
  const testFiles = (await readdir(resolve(ROOT, 'scripts')).catch(() => [])).filter((f) =>
    /^test-.*\.mjs$/.test(f),
  );
  saw('test-file-not-run', testFiles.length);
  for (const f of testFiles) {
    if (allScripts.includes('scripts/' + f)) continue;
    add(
      'scripts/' + f,
      0,
      'test-file-not-run',
      '這個測試檔沒有任何 npm script 會跑到它 —— 它存在、看起來很完整、' +
        '而六道關卡全綠，因為沒有人執行它。\n' +
        '      改法：在 package.json 加一個 script，並串進 test:units。',
    );
  }
  const referenced = [...new Set([...allScripts.matchAll(/scripts\/(test-[\w-]+\.mjs)/g)].map((m) => m[1]))];
  for (const r of referenced) {
    if (testFiles.includes(r)) continue;
    add(
      'package.json',
      0,
      'test-file-not-run',
      `有 npm script 指到 scripts/${r}，但那個檔案不存在。\n` +
        '      改法：把檔案補回來，或把那個 script 拿掉。',
    );
  }
}

{
  const pkg = pkgJson;
  const gates = String(pkg.scripts?.['verify:all'] ?? '')
    .split(' && ')
    .map((/** @type {string} */ s) => s.replace('npm run ', '').trim())
    .filter(Boolean);
  const checkYml = await readFile(resolve(DIR, 'check.yml'), 'utf8').catch(() => '');
  /*
   * ── 要求的清單從 deploy.yml 推出來，不要再寫一份 ──
   *
   * 原本這裡只比對 `verify:all` 展開的六道。第 7 輪（第十五圈）把三份
   * workflow 的清單實際列出來比對，發現 **`test:units` 與 `test:built`
   * 沒有任何規則要求 check.yml 跑**：把它們從 check.yml 拿掉，
   * PR 上就不再跑單元測試與產出測試，而三支檢查全部維持綠燈
   * （deploy.yml 仍然會跑，但那是**合併之後**才發生的事）。
   *
   * 所以清單改成從 deploy.yml 自己抽：部署路徑上會擋的每一件事，
   * PR 上都要先擋一次。`verify:all` 展開成它的六道，其餘照原樣。
   * 這樣加第七道關卡的時候不必記得回來改這裡。
   */
  const requiredInCheck = [
    ...new Set(deploySteps.flatMap((g) => (g === 'verify:all' ? gates : [g]))),
  ];
  saw('gate-missing-in-check', checkYml ? requiredInCheck.length : 0);
  if (checkYml && requiredInCheck.length > 0) {
    const ran = deployStepsFrom(checkYml);
    for (const gate of requiredInCheck) {
      if (ran.includes(gate)) continue;
      add(
        '.github/workflows/check.yml',
        0,
        'gate-missing-in-check',
        `部署路徑上會跑 npm run ${gate}，但 check.yml 沒有跑它。` +
          'check.yml 是逐一列出關卡的（為了在 GitHub 上看得出哪一道紅），' +
          '不然 PR 上看到的是一個少跑一道的綠勾，而真正擋下來會晚到合併之後。' +
          `　改法：在 check.yml 的 steps 裡加一步 \`run: npm run ${gate}\`。`,
      );
    }
  }
}

/*
 * ── Node 版本 ──────────────────────────────────────
 *
 * `engines` 寫 >=22.19.0（那是 undici 的實際需求，第一圈第 7 輪查過）。
 * 但本機跑的版本沒有任何地方會擋 —— `.npmrc` 沒有開 engine-strict，
 * 開了的話 `npm ci` 會直接失敗，對站主太粗暴。
 *
 * 所以這裡只是講出來。「works on my machine」最常見的成因就是
 * 沒有人知道 my machine 跟宣告的不一樣。
 */
const required = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')).engines?.node;
const minMatch = /(\d+)\.(\d+)\.(\d+)/.exec(required ?? '');

if (minMatch) {
  const min = minMatch.slice(1, 4).map(Number);
  const cur = process.versions.node.split('.').map(Number);
  const older =
    cur[0] < min[0] ||
    (cur[0] === min[0] && cur[1] < min[1]) ||
    (cur[0] === min[0] && cur[1] === min[1] && cur[2] < min[2]);
  if (older) {
    notes.push(
      `目前的 Node 是 v${process.versions.node}，低於 package.json 宣告的 ${required}。\n` +
        `      那個下限來自 undici（Astro 工具鏈的傳遞相依）。現在還能跑，但屬於「宣告與實際不一致」，\n` +
        `      CI 用 .nvmrc 的「22」會解析成最新的 22.x，所以 CI 上跟本機不是同一個版本。\n` +
        `      要對齊的話：nvm install 22.19.0 && nvm use 22.19.0`,
    );
  }
}

/*
 * ── 需要 dist/ 的檢查不能排在建置前面 ──────────────
 *
 * 第 3 輪（第四圈）把 check:content 加進 test:tools，而 deploy.yml 把
 * test:tools 排在 verify:all（含建置）**之前** —— 乾淨的 checkout 沒有 dist/，
 * 所以部署每次都會失敗。
 *
 * 而這種錯本機看不出來（本機永遠有 dist/），要等 CI 上乾淨的 checkout
 * 才會出現 —— 那正是這支腳本存在的理由。
 *
 * （原本這裡寫的是「三個 workflow 到現在沒有在 GitHub 上跑過一次」。
 * 2026-09-05 起那句話不成立了：deploy 7 次、sync-feeds 1 次。
 * 只有 check.yml 還是 0 —— 它只在 pull_request 上觸發，而這個 repo
 * 到目前為止一個 PR 都沒有開過。）
 */
/*
 * `audit:privacy` 是第 7 輪（第四十一圈）加進來的。
 *
 * 它跟別的不一樣：**沒有 dist/ 也跑得動**，只是那 10 條讀產出的規則
 * （`built-third-party-request`、四條 CSP、`cookie-promised-none`⋯）
 * 會安靜地一條都不判斷 —— 而其中一條守的正是這個專案最硬的承諾。
 *
 * 那一課是第二十六圈的：「需要 dist 的東西排在 build 之前，本機永遠有 dist
 * 所以兩套關卡全綠，乾淨的 runner 上才會壞」。當時修的是 `test:units`，
 * 而 `audit:privacy` 在**兩份 workflow 上**都排在建置之前，一直沒有人看到 ——
 * 因為它不會紅，它只是少驗 10 條。
 */
/**
 * 需要 `dist/` 的步驟 → 沒有 dist 的時候會怎樣。
 *
 * 兩種後果差很多，而訊息要說對哪一種：多數會**當場失敗**，
 * `audit:privacy` 不會 —— 它照跑，只是那 10 條讀產出的規則一條都不判斷。
 * @type {Map<string, string>}
 */
const NEEDS_DIST_WHY = new Map([
  ['check:content', 'fail'],
  ['check:copy', 'fail'],
  ['check:a11y', 'fail'],
  ['check:perf', 'fail'],
  ['test:built', 'fail'],
  ['audit:privacy', 'quiet'],
]);
const NEEDS_DIST = [...NEEDS_DIST_WHY.keys()];
const BUILDS = ['build', 'verify:all'];
for (const name of files) {
  const text = await readFile(resolve(DIR, name), 'utf8');
  const rel = `.github/workflows/${name}`;
  /** 依出現順序記下每個 `npm run X` */
  /* 同樣抹掉註解 —— 註解裡提到某個需要 dist 的檢查，不代表 workflow 會跑它 */
  const scanned = withoutComments(text);
  const calls = [...scanned.matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => ({
    script: m[1],
    line: scanned.slice(0, m.index).split('\n').length,
  }));
  const firstBuild = calls.findIndex((c) => BUILDS.includes(c.script));
  for (const [i, c] of calls.entries()) {
    if (!NEEDS_DIST.includes(c.script)) continue;
    /* 主體是「需要 dist 的那些呼叫」，不是全部的 npm run */
    saw('needs-dist-before-build', 1);
    if (firstBuild !== -1 && i > firstBuild) continue;
    add(
      rel,
      c.line,
      'needs-dist-before-build',
      `\`npm run ${c.script}\` 需要 dist/，但它排在建置之前` +
        (firstBuild === -1 ? '（這個 workflow 裡根本沒有建置）' : '') +
        '。乾淨的 checkout 沒有 dist/，' +
        (NEEDS_DIST_WHY.get(c.script) === 'quiet'
          ? '**而這一步不會因此失敗** —— 它照跑，只是讀產出的那幾條規則一條都不判斷。' +
            '本機永遠有 dist，所以兩套關卡全綠，沒有人會發現。'
          : '這一步在 CI 上一定會失敗。') +
        '　改法：把這一步移到建置之後' +
        (firstBuild === -1 ? '，而這個 workflow 還得先加一步 `run: npm run build`。' : '。'),
    );
  }
}

console.log('\n建置管線檢查\n' + '─'.repeat(56));

/*
 * ── 每條規則判斷過多少東西 ──────────────────────────
 *
 * 零的那幾條要看得見：它們的綠燈是「沒有東西可判斷」，
 * 不是「判斷過而且沒問題」。跟另外四支檢查同一個作法。
 */
/*
 * ── 「六道關卡」這個數字寫在四份文件裡 ────────────────────
 *
 * 第 7 輪（第三十七圈）加的。這一圈問「這一條規則，是誰要求的？
 * 寫在哪份文件裡？兩邊還一致嗎？」
 *
 * `verify:all` 有幾道關卡這件事，人會讀的文件裡寫了**四次**：
 * `CLAUDE.md`、`docs/DEPLOY.md`、`AGENTS.md`、`docs/STATE.md`。
 * 加一道關卡，四份同時變成錯的。
 *
 * 而這不是假想 —— `CLAUDE.md` 自己就留著一行：
 * 「（原本這裡寫「五道」，那是更早以前的數字。）」
 * **它已經過期過一次了**，而那次是靠人記得回來改。
 *
 * 這裡不判斷「幾道才對」，只比 `package.json` 的 `verify:all` 真的有幾步。
 * 那是這個數字唯一的事實來源。
 *
 * `docs/REVIEW-LOG.md` 不比：那是歷史紀錄，裡面每一筆寫的是**當時**的數字。
 *
 * 這一段要在「補 0」那一行**之前** —— 它自己會 `saw()`，
 * 排在後面的話那條規則會被補成 0，而 `--verbose` 印的是補完的那一份
 * （第一版就是這樣，明明比了 4 句卻印 0）。第十次犯同一個形狀。
 */
{
  const CLAIM_DOCS = ['CLAUDE.md', 'AGENTS.md', 'docs/DEPLOY.md', 'docs/STATE.md'];
  const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const pkgRaw = await readFile(resolve(ROOT, 'package.json'), 'utf8').catch(() => null);
  /** `verify:all` 真的有幾步 */
  let actual = null;
  if (pkgRaw !== null) {
    try {
      const line = JSON.parse(pkgRaw).scripts?.['verify:all'];
      if (typeof line === 'string') actual = line.split('&&').filter((x) => x.trim()).length;
    } catch {
      /* package.json 壞掉的話下面會說「沒有比對」 */
    }
  }
  let claims = 0;
  /*
   * ── 「N 道關卡」不一定是在數關卡 ──────────────────
   *
   * 第 7 輪（第三十九圈）踩到的：上一輪在 `STATE.md` 寫了一句
   * 「⋯而沒有一道關卡說過話」，這一條當場把那個「一」讀成宣稱，
   * 說文件寫「一道關卡」而實際有 6 步。那句話不是在數關卡。
   *
   * 反過來也一樣糟。改寫成「六道關卡裡沒有一道」之後它就過了 ——
   * 因為 6 剛好對。可是那是**敘述**，寫的是當時的事實：哪天真的加到七道，
   * 這一條會叫人去改那句話，而改完會變成一句**假的**歷史。
   *
   * 分界線量出來很乾淨：三處真的宣稱，距離最近的 `verify:all` 是
   * 13、14、15 個字元（都在同一行）；那句敘述是 **1,811** 個字元。
   * 所以判準用「同一行要提到 `verify:all`」—— 不是抓字面，是抓
   * **它有沒有在講那個指令**。
   *
   * 沒過線的不是安靜跳過，底下會說有幾處、在哪裡 ——
   * 不然哪天真的宣稱換了寫法（比方拆成兩行），這一格會安靜地少比一份。
   */
  /** 看到了「N 道關卡」但那一行沒提 `verify:all` —— 沒有比，但要說得出來 */
  const prose = [];
  for (const rel of CLAIM_DOCS) {
    const body = await readFile(resolve(ROOT, rel), 'utf8').catch(() => null);
    if (body === null) continue;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/([零一二三四五六七八九十]|\d+)\s*道關卡/g)) {
        if (!lines[i].includes('verify:all')) {
          prose.push(`${rel}:${i + 1}`);
          continue;
        }
        claims += 1;
        if (actual === null) continue;
        const said = CN.indexOf(m[1]) >= 0 ? CN.indexOf(m[1]) : Number(m[1]);
        if (said === actual) continue;
        add(
          rel,
          i + 1,
          'gate-count-stale',
          `這裡寫「${m[1]}道關卡」，而 package.json 的 verify:all 有 ${actual} 步。\n` +
            `      同一個數字在 ${CLAIM_DOCS.length} 份文件裡各寫了一次 —— 加一道關卡就會同時錯四份，\n` +
            '      而它已經過期過一次了（CLAUDE.md 自己還留著「原本這裡寫五道」那一行）。\n' +
            `      改法：把那句話的數字改成 ${actual}，四份都要改（這一條會把沒改到的都點出來）。`,
        );
      }
    }
  }
  saw('gate-count-stale', claims);
  if (actual === null) {
    notes.push('讀不到 package.json 的 verify:all —— 「幾道關卡」那個數字沒有比對。');
  } else if (claims === 0) {
    notes.push(
      '四份文件裡一句「N 道關卡」都抽不到 —— **這一格沒有在守**。\n' +
        '      那句話換了寫法的話，這裡的樣式要跟著改（不然它會安靜地什麼都不比）。',
    );
  }
  if (prose.length > 0) {
    notes.push(
      `另外 ${prose.length} 處寫了「N 道關卡」但那一行沒提 \`verify:all\` —— **沒有比**：\n` +
        `      ${prose.join('、')}\n` +
        '      當成敘述看待（敘述寫的是當時的事實，不該被改成今天的數字）。\n' +
        '      如果那其實是宣稱，把 `verify:all` 寫進同一行，這一條才看得到它。',
    );
  }
}

/*
 * ── 這十一條規則，改 workflow 的人看得到嗎 ────────────────
 *
 * 第 7 輪（第三十九圈）加的。這一圈問「這條待辦還活著嗎？」——
 * 「`check:workflows` 的 10 條規則文件提到 0 條」量下去還活著，
 * 而且比記的更乾脆：十條的 id **全部只出現在 `docs/REVIEW-LOG.md` 裡**，
 * 那是歷史紀錄，不是給人查的文件。
 *
 * 這件事在這個 repo 已經有兩個先例了：`check:copy` 的 `rule-not-documented`
 * 要求每條規則的 id 同時寫進 `CLAUDE.md` 與 `docs/CONTENT.md`，
 * `check:content` 的 `rule-not-in-guide` 要求寫進 `docs/CONTENT.md`。
 * 兩條的理由都一樣：**照文件做的人會被 CI 擋下來，卻不知道為什麼。**
 *
 * 這一支沒有排除任何一條。`check:copy` 把自己那條排除掉（自我指涉），
 * 這裡不排除 —— 「加規則要一起加一列」正是改 workflow 的人需要知道的事，
 * 寫進表裡是有用的，不是繞圈子。排除清單空著也是一個決定，所以照樣印出來。
 *
 * 這一段要在「補 0」那一行**之前** —— 它自己會 `saw()`。
 * 排在後面的話這條規則會被補成 0，而 `--verbose` 印的是補完的那一份。
 * （同一個形狀在這個 repo 犯過十一次了，所以這句話每次都留著。）
 */
{
  const DOC = 'docs/DEPLOY.md';
  /** 空的也是一個決定：十一條都是改 workflow 的人會撞到的 @type {Map<string, string>} */
  const NOT_A_MAINTAINER_RULE = new Map();
  const body = await readFile(resolve(ROOT, DOC), 'utf8').catch(() => null);
  if (body === null) {
    notes.push(`讀不到 ${DOC} —— 「這些規則有沒有文件」這一格**沒有在守**。`);
    saw('rule-undocumented', 0);
  } else {
    const { required, excluded, unknown } = documentationDuty(RULE_IDS, NOT_A_MAINTAINER_RULE);
    saw('rule-undocumented', required.length);
    if (unknown.length > 0) {
      notes.push(
        `排除清單裡有不存在的規則：${unknown.join('、')} —— ` +
          '那會讓「要寫的 ＋ 不用寫的 ＝ 總數」看起來成立，而其實在數不存在的東西。',
      );
    }
    notes.push(
      `文件要求：${RULE_IDS.length} 條規則裡 **${required.length} 條**要寫進 ${DOC}；` +
        `${excluded.length} 條不用${excluded.length === 0 ? '（沒有排除任何一條）' : '：\n      ' + excluded.map((id) => `· ${id}：${NOT_A_MAINTAINER_RULE.get(id)}`).join('\n      ')}`,
    );
    for (const id of required) {
      if (body.includes(id)) continue;
      add(
        DOC,
        0,
        'rule-undocumented',
        `\`check:workflows\` 有 ${id} 這條規則，但 ${DOC} 沒有寫到它 —— \n` +
          '      改 workflow 的人會被它擋下來，而查不到那個名字是什麼意思。\n' +
          `      改法：在「改 workflow 之前」那張表裡加一列（id ＋ 它擋的是什麼）。或者把規則拿掉。`,
      );
    }
  }
}

for (const id of RULE_IDS) if (!subjects.has(id)) subjects.set(id, 0);
if (process.argv.includes('--verbose')) {
  console.log('\n每條規則實際判斷過的東西：');
  for (const [id, n] of [...subjects.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${id}`);
  }
}
for (const n of notes) console.log(`\n  ⚠ ${n}`);

/*
 * ── 綠燈要說得出「判斷過什麼」與「看不到什麼」 ────────────
 *
 * 第 7 輪（第三十六圈）加的。這一支原本的綠燈只有一句
 * 「3 份 workflow，沒有發現問題」—— 三個檔案，然後沒了。
 * 沒說幾條規則、沒說判斷過幾個東西、沒說 `--verbose` 存在，
 * 也沒說**它是靜態檢查**。
 *
 * 另外六支從第二十一圈到第二十九圈陸續補齊了這件事，這一支是漏掉的那一支。
 * 而它偏偏是最需要講的：它守的東西**沒有第二個人在看**
 * （`ci:sim` 只模擬 `deploy.yml`，另外兩份它明講沒有模擬到）。
 *
 * 邊界那一句要講清楚差別：這支讀的是**抹掉註解之後的 YAML 文字**。
 * 它判斷得出「這個 script 名字在 package.json 裡不存在」，
 * 判斷不出「這份 workflow 在 GitHub 上跑起來會不會過」——
 * 那兩件事之間隔著 runner、快取、secret、與網路。
 */
const total = [...subjects.values()].reduce((n, v) => n + v, 0);
const idle = [...subjects.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
if (problems.length === 0) {
  console.log(
    `\n${files.length} 份 workflow（${files.join('、')}）、` +
      `${RULE_IDS.length} 條規則、這次判斷過 ${total} 個東西 —— 沒有發現問題。`,
  );
  if (idle.length > 0) {
    console.log(
      `\n這次沒有東西可判斷的規則（${idle.length} 條）：${idle.join('、')}\n` +
        '  它們是綠的，但那不是「判斷過而且沒問題」，是「沒有這種寫法」。',
    );
  }
  if (!process.argv.includes('--verbose')) {
    console.log('要看每條規則判斷過幾個東西：npm run check:workflows -- --verbose');
  }
  console.log(
    '\n這是**靜態**檢查：讀的是抹掉註解之後的 YAML。\n' +
      '  它看不到的是「這份 workflow 在 GitHub 上跑起來會不會過」——\n' +
      '  中間隔著 runner、Node 版本、快取、secret 與網路。\n' +
      `  真的跑過幾次要問 GitHub：gh run list --repo EugeneYip/fox --workflow <檔名>\n` +
      /*
       * 這裡原本印「2026-09-06 數過：deploy.yml 8 次、sync-feeds.yml 2 次」。
       * 第 7 輪（第四十圈）**同一天**再數一次：9 次與 3 次 ——
       * 那兩個數字每推一次、每排程跑一次就變，寫下來的那一刻就開始爛。
       *
       * `check.yml` 原本寫死 0，理由是「它是 0 **因為沒有人開 PR**，
       * 不是因為還沒輪到 —— 那是結構性的事實，值得寫死」。
       *
       * **第 7 輪（第四十四圈）把它變成 1。** 那一圈問「這件事站主要自己做嗎」，
       * 而「這份 workflow 從來沒跑過」聽起來像在等他決定要不要用 PR ——
       * 其實不用等：它有 `workflow_dispatch`，手動觸發一次就知道它會不會過。
       * 跑了：**12 個步驟全綠、88 秒**，`audit:privacy` 那一步也讀到了
       * 「身分規則：8 個值，來自 PRIVACY_NEEDLES」。
       *
       * 所以那個 0 也是會爛的數字，只是爛得比別的慢。改成寫**性質**：
       * 它不會自己跑（沒有人開 PR），要跑得手動觸發。
       */
      '  （`check.yml` **不會自己跑** —— 它只在 PR 與手動觸發上啟動，\n' +
      '   而這個專案是直接推 main。2026-09-06 手動觸發過一次，12 個步驟全綠。\n' +
      '   要自己跑一次：gh workflow run check.yml --repo EugeneYip/fox\n' +
      '   另外兩份都會自己跑；次數每推一次就變，要看就用上面那個指令。）\n',
  );
  process.exit(0);
}
for (const p of problems) {
  console.log(`\n  X [${p.id}] ${p.msg}`);
  console.log(`      ${p.file}${p.line ? ':' + p.line : ''}`);
}
console.log('\n' + '─'.repeat(56));
console.log(`${problems.length} 個問題。\n`);
process.exit(1);
