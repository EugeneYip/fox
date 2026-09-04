// @ts-check
/**
 * 比對兩個目錄的內容 —— 給 `ci:sim` 回答一個問題：
 *
 *   **我在本機看到的那一份，跟讀者會拿到的那一份，是同一份嗎？**
 *
 * 這個專案的檢查全部跑在本機的 `dist/` 上，而讀者拿到的是 CI 從版控建的。
 * 兩者不同的來源只有一種：**沒有進版控的檔案影響了建置**。
 * 最典型的就是 `src/config/identity.local.ts` —— 它刻意不進版控，
 * 所以 `reveal()` 的值只會出現在她自己的機器上（第 7 輪〔第十八圈〕實測：
 * 有那個檔案時本機的 `/about` 會多一段「所在　臺灣」，版控建的沒有）。
 *
 * 那不是 bug，是刻意的設計；但**沒有人說出來**，而她照著文件做完會以為線上也有。
 * 所以這裡不擋，只把差異講清楚。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}  遞迴的產生器要明寫回傳型別，不然 tsc 推不出來
 */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** @param {string} dir */
async function listing(dir) {
  /** @type {string[]} */
  const out = [];
  for await (const f of walk(dir)) out.push(relative(dir, f));
  return out.sort();
}

/**
 * @param {string} a  本機建的
 * @param {string} b  從版控建的
 * @returns {Promise<{ onlyA: string[], onlyB: string[], differing: string[], same: number }>}
 */
export async function compareDirs(a, b) {
  const [la, lb] = await Promise.all([listing(a), listing(b)]);
  const sb = new Set(lb);
  const sa = new Set(la);
  const onlyA = la.filter((f) => !sb.has(f));
  const onlyB = lb.filter((f) => !sa.has(f));
  const both = la.filter((f) => sb.has(f));

  const differing = [];
  let same = 0;
  for (const f of both) {
    const [x, y] = await Promise.all([readFile(join(a, f)), readFile(join(b, f))]);
    if (x.equals(y)) same++;
    else differing.push(f);
  }
  return { onlyA, onlyB, differing, same };
}
