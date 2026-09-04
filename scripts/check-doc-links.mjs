#!/usr/bin/env node
// @ts-check
/**
 * 文件裡的連結指得到東西嗎 —— `npm run check:doc-links`
 *
 *   node scripts/check-doc-links.mjs
 *   node scripts/check-doc-links.mjs --root=<某個目錄>   （測試用）
 *
 * ## 為什麼需要
 *
 * `check:links` 看的是**建置出來的網站**。倉庫裡的 markdown 文件
 * （README、AGENTS、docs/⋯⋯）互相連來連去，而那些連結**沒有任何東西在看**。
 *
 * 第 1 輪（第二十七圈）加了三個指向 `docs/A11Y.md` 的連結，
 * 打錯字不會有人擋 —— 當場記成待辦，這一輪（第 3 輪）補上。
 *
 * 這件事在「換一個人來做，做得到嗎」這一圈特別重要：
 * 接手的人是**照著文件的連結走**的。一個斷掉的連結不會讓任何東西壞掉，
 * 只會讓那個人走到一半停下來，然後開始猜。
 *
 * ## 兩條規則
 *
 *   doc-link-missing    連到的檔案不存在
 *   doc-anchor-missing  檔案在，但 #錨點 對不到任何一個標題
 *
 * 外部連結（http、https、mailto）不看 —— 那要打網路，而且別人的網站
 * 什麼時候搬家不是這個倉庫能控制的。
 *
 * ## 為什麼跳過 REVIEW-LOG.md
 *
 * 那份是歷史紀錄：裡面的連結記的是**當時**指得到什麼。
 * 讓建置因為一筆兩年前的紀錄而失敗是錯的。
 * `check:copy` 對同一個檔案也是同樣的處理。
 *
 * 但跳過要**說出來** —— 否則「沒有發現問題」會蓋掉「最大的那個檔案沒看」。
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg ? resolve(rootArg.slice('--root='.length)) : HERE;

/** 歷史紀錄。理由見檔頭。 */
const SKIP = new Set(['docs/REVIEW-LOG.md']);
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', '.astro']);

const RULE_IDS = ['doc-link-missing', 'doc-anchor-missing'];

if (process.argv.includes('--list-rules')) {
  console.log(RULE_IDS.join('\n'));
  process.exit(0);
}

/**
 * 每條規則這次實際判斷過幾個東西。
 * 0 也要看得見 —— 「沒有這種連結」跟「檢查過而且沒問題」是兩件事。
 * @type {Map<string, number>}
 */
const subjects = new Map();
const saw = (/** @type {string} */ id, /** @type {number} */ n) =>
  subjects.set(id, (subjects.get(id) ?? 0) + n);
for (const id of RULE_IDS) subjects.set(id, 0);

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith('.md')) yield p;
  }
}

/**
 * GitHub 產生標題錨點的規則（夠用的近似）：
 * 轉小寫、丟掉標點、空白換成連字號。中日韓文字會原樣留著。
 *
 * 標點用 Unicode 類別判斷而不是列舉 —— 這份文件裡的標題有全形的
 * 「」、、、：、（），列舉一定會漏。
 * @param {string} heading
 */
const anchorOf = (heading) =>
  heading
    .trim()
    .toLowerCase()
    /* 去掉行內的 markdown 記號，例如 `**粗體**`、`` `程式碼` `` */
    .replace(/[*`~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');

/** @type {{ file: string, line: number, id: string, target: string, why: string }[]} */
const problems = [];

/** 讀過的檔案的標題錨點，避免同一份讀兩次 @type {Map<string, Set<string>>} */
const anchorCache = new Map();

/** @param {string} abs */
async function anchorsOf(abs) {
  const hit = anchorCache.get(abs);
  if (hit) return hit;
  const set = new Set();
  if (existsSync(abs) && abs.endsWith('.md')) {
    const text = await readFile(abs, 'utf8');
    for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)) set.add(anchorOf(m[1]));
  }
  anchorCache.set(abs, set);
  return set;
}

const files = [];
for await (const f of walk(ROOT)) files.push(f);
files.sort();

let scanned = 0;
const skipped = [];

for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/');
  if (SKIP.has(rel)) {
    skipped.push(rel);
    continue;
  }
  scanned++;
  const text = await readFile(abs, 'utf8');
  const lines = text.split('\n');

  /*
   * 只看 `[文字](目標)` 這一種。參照式連結（`[文字][id]`）這個倉庫沒有用，
   * 真的出現了會安靜地不檢查 —— 這比誤報好，而且下面的主體數看得出來。
   *
   * 圖片 `![alt](path)` 也一起看：路徑打錯的後果一樣。
   */
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const raw = m[1];
      if (/^(https?:|mailto:|tel:|#!)/i.test(raw)) continue;

      const [pathPart, anchor] = raw.split('#');

      if (pathPart === '') {
        /* 同一份文件裡的錨點 */
        saw('doc-anchor-missing', 1);
        const anchors = await anchorsOf(abs);
        if (anchor && !anchors.has(anchor.toLowerCase())) {
          problems.push({
            file: rel,
            line: i + 1,
            id: 'doc-anchor-missing',
            target: raw,
            why: `這份文件裡沒有標題會產生 #${anchor} 這個錨點`,
          });
        }
        continue;
      }

      saw('doc-link-missing', 1);
      const target = resolve(dirname(abs), pathPart);
      if (!existsSync(target)) {
        problems.push({
          file: rel,
          line: i + 1,
          id: 'doc-link-missing',
          target: raw,
          why: `找不到 ${relative(ROOT, target).split('\\').join('/')}`,
        });
        continue;
      }
      if (anchor && target.endsWith('.md')) {
        saw('doc-anchor-missing', 1);
        const anchors = await anchorsOf(target);
        if (!anchors.has(anchor.toLowerCase())) {
          problems.push({
            file: rel,
            line: i + 1,
            id: 'doc-anchor-missing',
            target: raw,
            why: `${pathPart} 裡沒有標題會產生 #${anchor} 這個錨點`,
          });
        }
      }
    }
  }
}

console.log('\n文件連結檢查');
console.log('─'.repeat(64));

/*
 * 一份都沒掃到不是「沒問題」，是「什麼都沒檢查」——
 * 這個倉庫的其他檢查（a11y、內容、隱私）都踩過同一件事。
 */
if (scanned === 0) {
  console.log(
    `X 一份 markdown 都沒掃到 —— 這不是「沒問題」，是「什麼都沒檢查」。\n` +
      `  找的是 ${ROOT} 底下的 .md。\n` +
      `  改法：確認 --root= 指對了。\n`,
  );
  process.exit(1);
}

const total = [...subjects.values()].reduce((a, b) => a + b, 0);
console.log(`  ${scanned} 份文件、${total} 個連結`);

if (skipped.length > 0) {
  console.log(`  跳過 ${skipped.length} 份：${skipped.join('、')}`);
  console.log('  （歷史紀錄 —— 裡面的連結記的是當時指得到什麼，不該讓建置失敗）');
}

const idle = [...subjects.entries()].filter(([, n]) => n === 0).map(([id]) => id);
if (idle.length > 0) {
  console.log(`  這次沒有東西可看的規則：${idle.join('、')}`);
  console.log('  （綠的，但那是「沒有這種連結」，不是「檢查過而且沒問題」）');
}

if (problems.length === 0) {
  console.log('\n  ✓ 每一個都指得到。\n');
  process.exit(0);
}

console.log('');
for (const p of problems) {
  console.log(`  X [${p.id}] ${p.file}:${p.line}　${p.target}`);
  console.log(`      ${p.why}`);
}
console.log(
  `\n  ${problems.length} 個連結指不到東西。\n` +
    `  改法：連結的路徑是**相對於它所在的那份文件**的 ——\n` +
    `  docs/ 裡面連到同層寫 [X](X.md)，連到倉庫根目錄寫 [X](../X.md)。\n` +
    `  錨點對不上通常是標題改過字：錨點是標題轉小寫、去標點、空白換連字號。\n`,
);
process.exit(1);
