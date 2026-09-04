#!/usr/bin/env node
// @ts-check
/**
 * `sync-feeds.yml` 裡那幾段 shell 的實測 —— `npm run test:workflow-shell`
 *
 * ## 為什麼需要這個
 *
 * `ci:sim` 只模擬 `deploy.yml`。`sync-feeds.yml` 的兩段 `run:` 到
 * 第 7 輪（第八圈）為止**一次都沒有被執行過** —— 而其中一段決定
 * **網站到底會不會更新**：
 *
 *     if git diff --quiet -- src/data/syndication.json; then
 *       echo "changed=false" >> "$GITHUB_OUTPUT"; exit 0
 *     fi
 *     … git commit / git push …
 *     echo "changed=true" >> "$GITHUB_OUTPUT"
 *
 * 下一步的 `if: steps.commit.outputs.changed == 'true'` 才會去叫 deploy。
 * 也就是說這幾行寫錯的話：同步抓回新影片、commit 進去了，
 * **但部署不會被觸發，而且完全沒有徵兆**（那正是那個 workflow 的註解
 * 花了十行在解釋的坑）。
 *
 * ## 怎麼測而不碰網路
 *
 * - `git push` 是真的跑的，但 remote 是本機的 bare repo
 * - 同步那一段把 `node scripts/sync-feeds.mjs` 換成一個記錄參數的假指令
 * - `$GITHUB_OUTPUT` 指到暫存檔
 *
 * ## 抽取的方式
 *
 * 從 workflow 裡按「step 名稱 → 該 step 的 `run: |` 區塊」取行，
 * 而且**取完先驗內容**（含不含預期的關鍵字）。抽錯的話直接失敗 ——
 * 這個 repo 用正則剖結構化資料踩過八次，不想有第九次。
 */
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runBlock } from './lib/workflow-shell.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YML = resolve(ROOT, '.github/workflows/sync-feeds.yml');

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
}


const yml = await readFile(YML, 'utf8');
const tmp = await mkdtemp(join(tmpdir(), 'wf-shell-'));

console.log('\nsync-feeds.yml 的 shell 實測\n' + '─'.repeat(64));

try {
  // ── 抽取本身要先驗過 ────────────────────────────────
  const syncBlock = runBlock(yml, '同步');
  const commitBlock = runBlock(yml, '有變動就 commit');
  /*
   * 抽不到的時候要**拋錯**，不能安靜回空字串。
   * 第 7 輪（第十四圈）的突變掃描指出來的：把那個 throw 改成 `return ''`，
   * 所有案例照樣綠 —— 因為每一個案例找的都是真的存在的 step。
   * 而安靜回空字串的後果是「跑了一段空的 shell，然後全部通過」。
   */
  {
    let threw = '';
    try { runBlock(yml, '這個 step 不存在'); } catch (e) { threw = /** @type {any} */ (e)?.message ?? String(e); }
    check('抽不到 step 時會拋錯，不是回空字串', /找不到 step/.test(threw), threw);
  }

  check(
    '抽取：同步那段含有 ONLY_SOURCE 的分支',
    /if \[ -n "\$ONLY_SOURCE" \]/.test(syncBlock) && syncBlock.includes('--only='),
    syncBlock.slice(0, 60),
  );
  check(
    '抽取：commit 那段含有 git diff 與兩個 changed 輸出',
    commitBlock.includes('git diff --quiet') &&
      commitBlock.includes('changed=false') &&
      commitBlock.includes('changed=true'),
    commitBlock.slice(0, 60),
  );

  // ── 同步那段：--only 有沒有正確傳下去 ────────────────
  for (const [label, only, expect] of /** @type {[string, string, string][]} */ ([
    ['有 --only 時會帶下去', 'youtube-foxpoetry', '--verbose --only=youtube-foxpoetry'],
    ['沒有 --only 時不帶', '', '--verbose'],
  ])) {
    const dir = join(tmp, `sync-${only || 'none'}`);
    await mkdir(join(dir, 'scripts'), { recursive: true });
    // 把真正的同步換成一個記錄參數的假指令
    await writeFile(join(dir, 'scripts/sync-feeds.mjs'), 'console.log(process.argv.slice(2).join(" "));\n');
    const out = execFileSync('bash', ['-e', '-c', syncBlock], {
      cwd: dir,
      env: { ...process.env, ONLY_SOURCE: only },
      encoding: 'utf8',
    }).trim();
    check(label, out === expect, out);
  }

  // ── commit 那段：三種情境 ───────────────────────────
  /**
   * 做一個能 push 的暫存 repo（remote 是本機 bare repo，不出網路）。
   * @param {string} name
   */
  async function repo(name) {
    const bare = join(tmp, `${name}.git`);
    const work = join(tmp, name);
    execFileSync('git', ['init', '--bare', '-q', bare]);
    execFileSync('git', ['init', '-q', work]);
    const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' });
    git(['config', 'user.email', 't@example.invalid']);
    git(['config', 'user.name', 'test']);
    await mkdir(join(work, 'src/data'), { recursive: true });
    await writeFile(join(work, 'src/data/syndication.json'), JSON.stringify({ itemCount: 9 }));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    git(['remote', 'add', 'origin', bare]);
    git(['push', '-q', '-u', 'origin', 'HEAD']);
    return { work, git };
  }

  /** 跑 commit 那段，回傳 GITHUB_OUTPUT 的內容 */
  async function runCommit(/** @type {string} */ work) {
    const outFile = join(work, '.gh-output');
    await writeFile(outFile, '');
    execFileSync('bash', ['-e', '-c', commitBlock], {
      cwd: work,
      env: { ...process.env, GITHUB_OUTPUT: outFile },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return await readFile(outFile, 'utf8');
  }

  {
    const { work, git } = await repo('unchanged');
    const before = git(['rev-parse', 'HEAD']).trim();
    const out = await runCommit(work);
    check('沒有變動：changed=false', out.includes('changed=false'), out.trim());
    check('沒有變動：不會多出 commit', git(['rev-parse', 'HEAD']).trim() === before);
  }

  {
    const { work, git } = await repo('changed');
    const before = git(['rev-parse', 'HEAD']).trim();
    await writeFile(join(work, 'src/data/syndication.json'), JSON.stringify({ itemCount: 12 }));
    const out = await runCommit(work);
    check('有變動：changed=true', out.includes('changed=true'), out.trim());
    check('有變動：真的多了一個 commit', git(['rev-parse', 'HEAD']).trim() !== before);
    /*
     * commit 訊息裡的筆數是用 `node -p require(...).itemCount` 取的。
     * 那一行如果壞掉，訊息會變成「共  筆」而沒有人會發現。
     */
    check(
      'commit 訊息帶著正確的筆數',
      /共 12 筆/.test(git(['log', '-1', '--pretty=%s'])),
      git(['log', '-1', '--pretty=%s']).trim(),
    );
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    check(
      '有變動：真的推上 remote 了',
      git(['rev-parse', `origin/${branch}`]).trim() === git(['rev-parse', 'HEAD']).trim(),
      { branch },
    );
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
