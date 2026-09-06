#!/usr/bin/env node
// @ts-check
/**
 * 同步來源健康檢查 —— `npm run sync:health`
 *
 * ## 為什麼要有這一支
 *
 * 「某個來源已經 N 天沒有成功過」這個鬧鐘本來只在 `check:content` 裡，
 * 而那一支只在**部署路徑**上跑。第 4 輪（第三十八圈）追出來的鏈子：
 *
 *   來源全部失敗 → `sync-feeds.mjs` 沿用快取、離開碼 **0**（沒加 --strict）
 *   → `syndication.json` 沒有變動 → 「有變動就 commit」那一步 `changed=false`
 *   → 「觸發部署」那一步的 `if:` 不成立 → **deploy.yml 不跑**
 *   → `check:content` 不跑 → **鬧鐘不會響**
 *
 * 也就是說：**來源死掉的時候，正好是那個鬧鐘走不到的時候。**
 * 排程那一次是綠的、而且安靜的 —— 在 Actions 上跟「今天沒有新影片」長得一模一樣。
 *
 * 這一支就是給排程自己問一次用的。判斷與門檻都在 `lib/sync-health.mjs`，
 * 跟 `check:content` 共用同一份。
 *
 * ## 為什麼預設不擋
 *
 * 這個 repo 對這件事早就有立場：`sync-feeds.yml` 的註解寫著
 * 「某個平臺掛掉不該讓整個流程變紅燈」，而 `check:content` 那一段也寫著
 * 「一樣只說話、不擋」。這一支照著同一個立場：**只說**。
 * 要擋的話加 `--strict`（跟 `sync-feeds.mjs` 同一個旗標名）。
 *
 * 在 GitHub Actions 裡會多寫一份到 `$GITHUB_STEP_SUMMARY` ——
 * 那是排程跑完之後真的會被看到的地方。
 */
import { readFile, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { sourceHealth, coldLine, missingLine, SYNC_STALE_DAYS } from './lib/sync-health.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (/** @type {string} */ n) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const FILE = arg('file') ? resolve(String(arg('file'))) : resolve(ROOT, 'src/data/syndication.json');
const SOURCES = arg('sources') ? resolve(String(arg('sources'))) : resolve(ROOT, 'src/config/sources.mjs');
const STRICT = process.argv.includes('--strict');

/** @type {string[]} */
const lines = [];
const say = (/** @type {string} */ s) => {
  lines.push(s);
  console.log(s);
};

const raw = await readFile(FILE, 'utf8').catch(() => null);
if (raw === null) {
  console.log(`X 讀不到 ${FILE} —— 這不是「都正常」，是什麼都沒看。`);
  process.exit(1);
}
let data;
try {
  data = JSON.parse(raw);
} catch {
  console.log(`X ${FILE} 不是合法的 JSON —— 什麼都沒看。`);
  process.exit(1);
}

say('\n同步來源健康檢查');
say('─'.repeat(56));

/*
 * ── 設定檔宣告了誰，這份資料就該記得誰 ──────────
 *
 * 理由寫在 lib/sync-health.mjs 那段：同步有兩條路會跳過一個來源而且
 * 不留紀錄，於是它在這裡等於不存在。`sources.mjs` 刻意是 `.mjs`，
 * 就是為了讓 node 腳本可以直接 import。
 *
 * `enabledSources()` 本來就在那個檔案裡 —— 第 3 輪（第四十三圈）的報告
 * 還把它列進「4 個沒有人用的具名匯出」。答案早就在系統裡了。
 */
/** @type {string[] | null} */
let declared = null;
try {
  const mod = await import(pathToFileURL(SOURCES).href);
  const list = typeof mod.enabledSources === 'function' ? mod.enabledSources() : (mod.sources ?? []);
  declared = list.map((/** @type {{ id: string }} */ s2) => s2.id);
} catch {
  declared = null;
}

const { total, cold, missing } = sourceHealth(data, Date.now(), declared);
if (declared === null) {
  say(`  來源清單沒有比對：讀不到 ${SOURCES}。`);
  say('    「這份資料記了誰」看得到，「設定檔宣告了誰」看不到 —— 少一半。');
}
if (missing.length > 0) {
  say(`  **${missing.length} 個來源宣告了，但這份資料一筆紀錄都沒有**：`);
  for (const id of missing) say(`    · ${missingLine(id)}`);
  say('');
  say('  它們不是「冷掉了」，是從來沒進過這份資料 —— 下面那個數字看不到它們。');
  say('  改法：npm run sync -- --verbose 跑一次，看那個來源那一行說了什麼。');
  say('');
}
if (total === 0) {
  say('  這份資料裡一個來源都沒有 —— 不是「都正常」，是沒有東西可看。');
} else if (cold.length === 0) {
  say(`  ${total} 個來源，全部都在 ${SYNC_STALE_DAYS} 天內成功過 ✓`);
} else {
  say(`  ${total} 個來源裡，**${cold.length} 個已經超過 ${SYNC_STALE_DAYS} 天沒有成功過**：`);
  for (const c of cold) say(`    · ${coldLine(c)}`);
  say('');
  say('  網站不會壞（沿用快取），但顯示的東西會停在那一天。');
  say('  改法：npm run verify -- --patterns 實際打一次；真的持續不通再考慮設 YOUTUBE_API_KEY。');
}

/* 排程跑完之後真的會被看到的地方 */
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8').catch(() => {});
}

process.exit(STRICT && (cold.length > 0 || missing.length > 0) ? 1 : 0);
