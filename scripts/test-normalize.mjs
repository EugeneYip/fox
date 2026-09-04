#!/usr/bin/env node
// @ts-check
/**
 * 正規化與合併的實測 —— `npm run test:normalize`
 *
 * 測兩段**壞掉不會拋錯**的程式碼：
 *
 * - `normalizeItem`：欄位對應錯了，同步照樣回報「抓到 9 筆」，只是資料是空的
 * - `mergeItems`：`firstSeenAt` 沒保留的話，每次同步都變成「今天第一次看到」——
 *   資料看起來完全正常，只是那個時間戳每天都不一樣
 */
import { normalizeItem, mergeItems } from './lib/normalize.mjs';

let failed = 0;
/** @param {boolean} cond @param {string} label @param {unknown} [got] */
const ok = (cond, label, got) => {
  if (!cond) { failed++; console.log(`  X ${label}${got !== undefined ? `  實際：${JSON.stringify(got)}` : ''}`); }
};

const source = { id: 'src-1', lang: 'en', tags: ['來源標籤'] };
const platform = { id: 'youtube', media: 'video' };

console.log('\n正規化與合併實測');
console.log('─'.repeat(64));

// ── normalizeItem ────────────────────────────────────
{
  console.log('  normalizeItem');
  const it = normalizeItem(
    { id: 'a', title: '標題', url: 'https://e.com/a', publishedAt: '2024-01-01T00:00:00.000Z', summary: '摘要', tags: ['項目標籤'] },
    source, platform,
  );
  ok(it.sourceId === 'src-1' && it.platform === 'youtube' && it.media === 'video', '    來源與平臺欄位', it);
  ok(it.lang === 'en', '    lang 取自 source', it.lang);
  ok(JSON.stringify(it.tags) === '["來源標籤","項目標籤"]', '    來源與項目的標籤合併', it.tags);

  // 沒有 lang 的 source → 預設中文
  const zh = normalizeItem({ id: 'b', title: 't', url: 'u' }, { id: 's' }, platform);
  ok(zh.lang === 'zh-TW', '    source 沒有 lang 時預設 zh-TW', zh.lang);

  /*
   * publishedAt 從 undefined 變成 null。
   * 這一步就是第 4 輪（第四圈）追過的那個橋：剖析器對解不出來的日期回
   * undefined，而 syndication.json 的型別寫的是 `string | null`。
   */
  ok(zh.publishedAt === null, '    undefined 的日期轉成 null', zh.publishedAt);
  ok(zh.summary === '', '    沒有摘要時是空字串不是 undefined', zh.summary);
  ok(zh.thumbnail === null && zh.externalId === null, '    縮圖與外部 id 預設 null');

  // 標籤去重與上限
  const many = normalizeItem(
    { id: 'c', title: 't', url: 'u', tags: ['來源標籤', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
    source, platform,
  );
  ok(many.tags.length === 8, '    標籤上限 8 個', many.tags.length);
  ok(new Set(many.tags).size === many.tags.length, '    標籤有去重（來源標籤只出現一次）', many.tags);

  // 鍵的順序固定 —— 註解說那是為了讓 git diff 只顯示真正的變動
  const keys = Object.keys(it).join(',');
  const keys2 = Object.keys(normalizeItem({ id: 'z', title: 'x', url: 'y' }, source, platform)).join(',');
  ok(keys === keys2, '    鍵的順序固定（git diff 才乾淨）', [keys, keys2]);
}

// ── mergeItems ───────────────────────────────────────
{
  console.log('  mergeItems');
  /** @type {Map<string, any>} */
  const byId = new Map();
  const item = { id: 'x', title: '第一版', url: 'https://e.com/x' };

  const r1 = mergeItems(byId, [item], source, platform, () => '2020-01-01T00:00:00.000Z');
  ok(r1.added === 1 && r1.updated === 0, '    第一次是新增', r1);
  ok(byId.get('x').firstSeenAt === '2020-01-01T00:00:00.000Z', '    記下第一次看到的時間');

  // 同樣的內容再跑一次 —— 不該算更新
  const r2 = mergeItems(byId, [item], source, platform, () => '2026-09-02T00:00:00.000Z');
  ok(r2.added === 0 && r2.updated === 0, '    內容沒變就不動', r2);
  ok(byId.get('x').firstSeenAt === '2020-01-01T00:00:00.000Z', '    firstSeenAt 沒有被改掉');

  // 標題改了 —— 要更新，但 firstSeenAt 要保留
  const r3 = mergeItems(byId, [{ ...item, title: '第二版' }], source, platform, () => '2026-09-02T00:00:00.000Z');
  ok(r3.updated === 1, '    內容變了就更新', r3);
  ok(byId.get('x').title === '第二版', '    內容真的換了');
  ok(
    byId.get('x').firstSeenAt === '2020-01-01T00:00:00.000Z',
    '    **更新時保留原本的 firstSeenAt**',
    byId.get('x').firstSeenAt,
  );

  // 只增不刪：這次沒抓到的舊項目要留著
  const r4 = mergeItems(byId, [{ id: 'y', title: '新的', url: 'https://e.com/y' }], source, platform, () => '2026-09-02T00:00:00.000Z');
  ok(r4.added === 1 && byId.has('x'), '    只增不刪 —— 這次沒抓到的舊項目留著', [...byId.keys()]);
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
