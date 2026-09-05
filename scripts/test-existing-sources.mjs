#!/usr/bin/env node
// @ts-check
/**
 * `existingSource()` —— 「這個平臺已經有來源了嗎」。
 *
 * 為什麼值得一支測試：它擋的是 `npm run handle` 遞出一段**貼下去會重複**的
 * 設定。那支工具只在一個時刻會被用到（站主剛問到一個帳號名），
 * 那一刻沒有人會回頭核對 `sources.mjs` —— 所以判斷必須是對的。
 */
import { existingSource } from './lib/existing-sources.mjs';
import { sources as real } from '../src/config/sources.mjs';

let failed = 0;
/** @param {string} name @param {boolean} pass @param {string} [detail] */
const ok = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : 'X'} ${name}`);
  if (!pass && detail) console.log(`        ${detail}`);
};

console.log('\nexistingSource()\n' + '─'.repeat(64));

const fake = [
  { id: 'youtube-foxpoetry', platform: 'youtube', handle: 'foxpoetry' },
  { id: 'medium-old', platform: 'medium' }, // 沒有 handle 的那種
];

const same = existingSource(fake, 'youtube', 'foxpoetry');
ok('同平臺同帳號 —— 認得出來，而且說得出是哪一筆', same?.sameHandle === true && same?.id === 'youtube-foxpoetry', JSON.stringify(same));

const other = existingSource(fake, 'youtube', 'someone-else');
ok('同平臺不同帳號 —— 不算重複（那是第二個帳號）', other !== null && other.sameHandle === false, JSON.stringify(other));

ok('沒有那個平臺 —— 回 null', existingSource(fake, 'bluesky', 'foxpoetry') === null);

/*
 * 大小寫：站主可能打 `FoxPoetry`（YouTube 上顯示的就是這個寫法），
 * 而 `sources.mjs` 裡存的是小寫。比不出來的話它會建議再貼一次。
 */
ok('帳號名不分大小寫', existingSource(fake, 'youtube', 'FoxPoetry')?.sameHandle === true);

/* 沒有 handle 的那一筆不能當成「同一個帳號」—— 不然任何名字都會被說成重複 */
ok('現有那筆沒寫 handle 時，不會被當成同一個帳號', existingSource(fake, 'medium', 'foxpoetry')?.sameHandle === false);

/*
 * ── 接到真的設定上 ──────────
 *
 * 上面五格用的都是假資料。判斷寫對、但接錯檔案的話，它們一格都不會紅。
 * 這一格確認 `sources.mjs` 裡真的有那筆 YouTube ——
 * 也就是 `npm run handle foxpoetry` 現在真的會說「已經有了」。
 */
const live = existingSource(real, 'youtube', 'foxpoetry');
ok(
  '真的 sources.mjs 裡的 YouTube 認得出來',
  live?.sameHandle === true,
  `sources.mjs 有 ${real.length} 筆：${real.map((s) => `${s.platform}/${s.handle ?? '（沒有 handle）'}`).join('、')}`,
);

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
