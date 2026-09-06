#!/usr/bin/env node
// @ts-check
/**
 * `sourceHealth()` 與 `npm run sync:health`。
 *
 * 為什麼值得一支測試：它守的鏈子只有它在守。
 * 第 4 輪（第三十八圈）追出來的：來源全部失敗 → sync 離開碼 0 →
 * 資料沒變 → 不 commit → **不部署** → `check:content` 不跑 →
 * 「N 天沒成功」那個鬧鐘不會響。
 *
 * 也就是說**來源死掉的時候，正好是那個鬧鐘走不到的時候**。
 * 這一支就是給排程自己問一次用的 —— 它壞掉的話沒有第二個地方會發現。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sourceHealth, coldLine, SYNC_STALE_DAYS } from './lib/sync-health.mjs';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
/** @param {string} name @param {boolean} pass @param {string} [detail] */
const ok = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : 'X'} ${name}`);
  if (!pass && detail) console.log(`        ${detail}`);
};

console.log('\n同步來源健康檢查\n' + '─'.repeat(64));

const NOW = Date.parse('2026-09-06T00:00:00Z');
const ago = (/** @type {number} */ days) => new Date(NOW - days * 86_400_000).toISOString();

ok('全部都新：沒有冷掉的', sourceHealth({ sources: { a: { lastSuccessAt: ago(1) } } }, NOW).cold.length === 0);
ok(
  `超過 ${SYNC_STALE_DAYS} 天：算冷掉`,
  sourceHealth({ sources: { a: { lastSuccessAt: ago(10) } } }, NOW).cold[0]?.days === 10,
);
/* 剛好在門檻上不算 —— 邊界要釘住，不然「> 或 >=」改掉沒有人知道 */
ok(
  '剛好 3 天不算冷（邊界）',
  sourceHealth({ sources: { a: { lastSuccessAt: ago(SYNC_STALE_DAYS) } } }, NOW).cold.length === 0,
);
ok(
  'lastSuccessAt 是空的：算「從來沒有成功過」',
  sourceHealth({ sources: { a: { lastSuccessAt: null } } }, NOW).cold[0]?.days === null,
);
ok('一個來源都沒有：total 是 0', sourceHealth({}, NOW).total === 0);
ok('「從來沒成功」那一句寫得出來', coldLine({ id: 'a', days: null }).includes('從來沒有成功過'));

/* ── CLI ────────────────────────────────────────── */
const dir = await mkdtemp(join(tmpdir(), 'sync-health-'));
const at = join(dir, 'syn.json');
/*
 * 來源清單也要是 fixture 的。
 *
 * 第 4 輪（第四十三圈）讓 `sync:health` 多讀一份 `sources.mjs` 之後，
 * 不給 `--sources=` 的話這些案例會去比**真的**那一份 ——
 * 於是每一格都會多出一句「youtube-foxpoetry 宣告了但沒有紀錄」，
 * 而那跟這幾格要驗的事情無關。
 */
const srcAt = join(dir, 'sources.mjs');
await writeFile(
  srcAt,
  "export const sources = [{ id: 'a', platform: 'youtube', enabled: true }];\n" +
    'export function enabledSources() {\n  return sources.filter((s) => s.enabled);\n}\n',
  'utf8',
);
const cli = async (/** @type {object} */ data, /** @type {string[]} */ extra = []) => {
  await writeFile(at, JSON.stringify(data), 'utf8');
  const args = [resolve(ROOT, 'scripts/sync-health.mjs'), `--file=${at}`];
  if (!extra.some((a) => a.startsWith('--sources='))) args.push(`--sources=${srcAt}`);
  args.push(...extra);
  try {
    const { stdout } = await run('node', args);
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1 };
  }
};

const fresh = await cli({ sources: { a: { lastSuccessAt: new Date().toISOString() } } });
ok('都新的時候說得出幾個來源，而且 exit 0', /1 個來源，全部都在 3 天內成功過/.test(fresh.out) && fresh.code === 0, fresh.out);

const stale = await cli({ sources: { a: { lastSuccessAt: ago(30) } } });
ok('冷掉的時候點名，而且**預設不擋**（exit 0）', /1 個已經超過 3 天沒有成功過/.test(stale.out) && stale.code === 0, `exit ${stale.code}`);

const strict = await cli({ sources: { a: { lastSuccessAt: ago(30) } } }, ['--strict']);
ok('--strict 才擋（exit 1）', strict.code === 1, `exit ${strict.code}`);

/*
 * ── 宣告了、卻連紀錄都沒有 ──────────────────────
 *
 * `syncSources()` 有兩條路會跳過一個來源而且不寫紀錄（handle 是
 * `CHANGE_ME`、platform id 不存在）。實測直接呼叫它：兩個開著的來源，
 * `syndication.json` 記下的是「一個都沒有」，而 `failures` 只有 1 ——
 * `CHANGE_ME` 那條連失敗都不算。排程跑的又是沒有 `--strict` 的那一版。
 *
 * 所以「N 個來源，全部都在 3 天內成功過 ✓」的分母是**這份資料記了誰**，
 * 不是設定檔宣告了誰。
 */
{
  const twoAt = join(dir, 'sources-two.mjs');
  await writeFile(
    twoAt,
    "export const sources = [{ id: 'a', platform: 'youtube', enabled: true }," +
      " { id: 'b', platform: 'youtube', enabled: true, handle: 'CHANGE_ME' }," +
      " { id: 'off', platform: 'youtube', enabled: false }];\n" +
      'export function enabledSources() {\n  return sources.filter((s) => s.enabled);\n}\n',
    'utf8',
  );
  const fresh2 = { sources: { a: { lastSuccessAt: new Date().toISOString() } } };
  const gap = await cli(fresh2, [`--sources=${twoAt}`]);
  ok('宣告了卻沒有紀錄的來源會被點名', /· b —— sources.mjs 裡開著/.test(gap.out), gap.out);
  ok('而且沒有紀錄不等於冷掉（那句話分得開）', /從來沒有為它寫過任何東西/.test(gap.out), gap.out);
  ok('關掉的來源不算', !/· off/.test(gap.out), gap.out);
  ok('預設不擋（exit 0）', gap.code === 0, `exit ${gap.code}`);

  const gapStrict = await cli(fresh2, [`--sources=${twoAt}`, '--strict']);
  ok('--strict 的時候擋得住（exit 1）', gapStrict.code === 1, `exit ${gapStrict.code}`);

  /* 反向：兩邊對得上的時候不能亂說 */
  const agree = await cli({ sources: { a: { lastSuccessAt: new Date().toISOString() } } });
  ok('對得上時不亂報（反向案例）', !/一筆紀錄都沒有/.test(agree.out), agree.out);

  /* 讀不到就要說「沒有比對」，不能安靜地只看一半 */
  const blind = await cli(fresh2, [`--sources=${join(dir, 'nope.mjs')}`]);
  ok('讀不到來源清單時說「沒有比對」', /來源清單沒有比對/.test(blind.out), blind.out);
}

const empty = await cli({ sources: {} });
ok('一個來源都沒有：說「沒有東西可看」而不是「都正常」', /一個來源都沒有 —— 不是「都正常」/.test(empty.out), empty.out);

await rm(dir, { recursive: true, force: true });

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
