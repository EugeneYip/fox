#!/usr/bin/env node
// @ts-check
/**
 * git 歷史裡有沒有個資 —— `npm run check:history`
 *
 * 為什麼要有這支：第 5 輪（第二圈）發現本名與校名從第一個 commit 就在
 * `scripts/audit-privacy.mjs` 裡（身分規則把真值寫死在正則）。
 * 改程式救得了現在的檔案，**救不了已經進到 git 歷史的東西**。
 *
 * 為什麼不是叫人自己下 `git log -S"名字"`：那樣要把本名打進終端機，
 * 會留在 shell 的歷史紀錄裡 —— 為了檢查個資有沒有外洩而製造另一份個資，
 * 跟那一輪修的是同一種錯。這支腳本從 identity.local.ts 或
 * PRIVACY_NEEDLES 讀值，不需要任何人打字。
 *
 * ## 為什麼不只查 `-S`
 *
 * `git log -S` 只看**檔案內容**的變化。第 5 輪（第三圈）實測確認：
 * 只出現在 commit message 裡的字串，`-S` 完全找不到（三個案例都是 0）。
 *
 * 也就是說，如果有人在 commit message 裡寫了她的本名，
 * 這支腳本會回報「乾淨」，而那個名字會永遠留在歷史裡。
 * 所以現在**三邊都查**：檔案內容（`-S`）、commit message（`--format=%B`），
 * 以及 **ref 的名字**（tag 與 branch）。
 *
 * ref 名字那一項是第 5 輪（第四圈）補的。`git tag -a v1-給某某某` 這種東西
 * 前兩項都看不到，而 tag 是會被 push 上去的。
 */
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readIdentityNeedles } from './lib/identity-needles.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { needles, detail } = readIdentityNeedles(ROOT);

console.log('\ngit 歷史的個資檢查\n' + '─'.repeat(52));

if (needles.length === 0) {
  /*
   * 這裡故意 exit 1。
   *
   * 這支腳本的用途是「push 之前確認歷史裡沒有個資」。
   * 沒有值可搜尋時它什麼也沒證明 —— 而 exit 0 會讓人以為過了。
   * 這個專案已經在第 5 輪（第二圈）踩過一次「安靜的綠燈」：
   * 稽核印出「乾淨」，但身分規則根本沒執行。
   */
  console.log('\n⚠ 沒有可以搜尋的值 —— ' + detail);
  console.log('  這代表**什麼都沒有檢查**，不是「乾淨」。');
  console.log('  本機：cp src/config/identity.local.example.ts src/config/identity.local.ts 並填值');
  console.log('  或：PRIVACY_NEEDLES="值1\\n值2" npm run check:history\n');
  process.exit(1);
}

console.log(`用 ${detail} 的 ${needles.length} 個值搜尋所有 commit。\n`);

/** commit message 全文，一次取出來重複用 */
let messages = '';
try {
  messages = execFileSync('git', ['log', '--all', '--format=%H%n%B%n---8<---'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
} catch {
  /* 還沒有 commit */
}
const messageBlocks = messages.split('---8<---').filter((b) => b.trim());

/** 所有 ref 的名字（tag 與 branch）—— 它們會跟著 push 上去 */
let refNames = '';
try {
  refNames = execFileSync('git', ['for-each-ref', '--format=%(refname:short)'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
} catch {
  /* 還沒有 commit */
}

let hits = 0;
for (const needle of needles) {
  // ── 檔案內容 ──
  let out = '';
  try {
    // -S 找的是「這個字串的出現次數有變化」的 commit —— 加入與刪除都算
    out = execFileSync('git', ['log', '--oneline', '-S', needle, '--all'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    /* 還沒有 commit */
  }
  if (out) {
    const commits = out.split('\n');
    hits += commits.length;
    // 只印 commit，不印值本身 —— 印出來就等於又寫進一份紀錄
    console.log(`  ✗ 檔案內容：有 ${commits.length} 個 commit 動過其中一個值`);
    for (const c of commits.slice(0, 6)) console.log(`      ${c}`);
    if (commits.length > 6) console.log(`      …還有 ${commits.length - 6} 個`);
  }

  // ── ref 的名字 ──
  const inRefs = refNames.split('\n').filter((r) => r.includes(needle));
  if (inRefs.length > 0) {
    hits += inRefs.length;
    console.log(`  ✗ ref 名字：有 ${inRefs.length} 個 tag／branch 的名字含其中一個值`);
    for (const r of inRefs.slice(0, 6)) console.log(`      ${r.slice(0, 8)}…`);
  }

  // ── commit message ──
  const inMessages = messageBlocks.filter((b) => b.includes(needle));
  if (inMessages.length > 0) {
    hits += inMessages.length;
    console.log(`  ✗ commit message：有 ${inMessages.length} 個訊息含其中一個值`);
    for (const b of inMessages.slice(0, 6)) {
      console.log(`      ${b.trim().split('\n')[0].slice(0, 12)} …`);
    }
  }
}

console.log('\n' + '─'.repeat(52));
if (hits === 0) {
  console.log('乾淨。git 歷史裡找不到這些值。\n');
  process.exit(0);
}
console.log(`歷史裡還有個資。**push 之前**處理掉 —— 做法見 docs/STATE.md 開頭。

沒有 remote 的話最簡單的是壓成一個 commit：

  git checkout --orphan clean-main && git add -A
  git commit -m "初版" && git branch -D main && git branch -m main
`);
process.exit(1);
