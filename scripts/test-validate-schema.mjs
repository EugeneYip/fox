#!/usr/bin/env node
// @ts-check
/**
 * `validate()` / `unsupported()` —— 拿 schema 驗 `syndication.json` 的那一支。
 *
 * 為什麼值得一支測試：它守的東西**只有它在守**。
 * 第 4 輪（第三十六圈）實測過，少一個必填欄的時候
 * `npm run build` 會成功、六道關卡全綠，而產出裡會多出
 * 一個沒有 href 的 `<a>`（6 個頁面上都有）。
 *
 * 所以這支自己壞掉的話，沒有第二個地方會發現 ——
 * 尤其是「安靜地什麼都不驗」那種壞法（回 0 個錯誤看起來跟通過一模一樣）。
 */
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, unsupported, SUPPORTED } from './lib/validate-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
/** @param {string} name @param {boolean} pass @param {string} [detail] */
const ok = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? '✓' : 'X'} ${name}`);
  if (!pass && detail) console.log(`        ${detail}`);
};

console.log('\nvalidate-schema\n' + '─'.repeat(64));

const schema = {
  type: 'object',
  required: ['a', 'b'],
  properties: {
    a: { type: 'string' },
    b: { type: 'integer', minimum: 0 },
    c: { enum: ['ok', 'error'] },
    d: { type: 'string', format: 'uri' },
    e: { type: ['string', 'null'] },
    list: { type: 'array', items: { type: 'string' } },
    bag: { type: 'object', additionalProperties: { type: 'object', required: ['s'], properties: { s: { type: 'string' } } } },
  },
};

const clean = { a: 'x', b: 1, c: 'ok', d: 'https://example.com/x', e: null, list: ['p'], bag: { one: { s: 'y' } } };
ok('乾淨的資料 —— 0 個錯誤', validate(clean, schema).errors.length === 0, JSON.stringify(validate(clean, schema).errors));

/* 這一格是重點：少一個必填欄正是實測會漏掉的那種壞法 */
const { a: _drop, ...missing } = clean;
ok('少了必填欄 —— 抓得到，而且說得出少哪一個', validate(missing, schema).errors.join()  .includes('少了必填的 a'), JSON.stringify(validate(missing, schema).errors));

ok('型別不對 —— 抓得到', validate({ ...clean, b: '1' }, schema).errors.some((e) => e.includes('型別')));
ok('integer 收不下小數', validate({ ...clean, b: 1.5 }, schema).errors.some((e) => e.includes('型別')));
ok('minimum 擋得住負數', validate({ ...clean, b: -1 }, schema).errors.some((e) => e.includes('不能小於')));
ok('enum 之外的值 —— 抓得到', validate({ ...clean, c: 'maybe' }, schema).errors.some((e) => e.includes('只能是')));
ok('format: uri 不是網址 —— 抓得到', validate({ ...clean, d: 'not-a-url' }, schema).errors.some((e) => e.includes('uri')));
ok('type 是陣列時，兩種都收', validate({ ...clean, e: 'str' }, schema).errors.length === 0);
ok('陣列裡的元素也驗', validate({ ...clean, list: ['p', 3] }, schema).errors.some((e) => e.includes('list[1]')));
ok('additionalProperties 當成子 schema 走下去', validate({ ...clean, bag: { one: {} } }, schema).errors.some((e) => e.includes('bag.one')));

/*
 * 路徑要說得出是**哪一筆**。9 筆長得很像，只說「少了 url」找不到人。
 */
const arr = { type: 'array', items: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } };
ok('錯誤訊息指得出是第幾筆', validate([{ url: 'a' }, {}], arr).errors.some((e) => e.startsWith('[1]')), JSON.stringify(validate([{ url: 'a' }, {}], arr).errors));

/*
 * ── 「看不懂就要說」──────────
 *
 * 這一格守的是最糟的那種綠燈：schema 寫了一條、驗證器看不懂、
 * 於是 0 個錯誤 —— 讀起來跟「合約有人在守」一模一樣。
 */
ok('沒實作的關鍵字會被指出來', unsupported({ type: 'object', properties: { x: { pattern: '^a' } } }).some((p) => p.includes('pattern')));
ok('沒實作的 format 也算', unsupported({ type: 'string', format: 'email' }).some((p) => p.includes('email')));
ok('required／enum 的值不會被誤認成關鍵字', unsupported({ required: ['pattern'], enum: ['oneOf'] }).length === 0, JSON.stringify(unsupported({ required: ['pattern'], enum: ['oneOf'] })));
ok('看得懂的關鍵字不會被報成看不懂', unsupported(schema).length === 0, JSON.stringify(unsupported(schema)));

/*
 * ── 接到真的檔案上 ──────────
 *
 * 上面每一格用的都是假 schema。判斷寫對、但接錯檔案的話它們一格都不會紅。
 * 這兩格確認今天 repo 裡那兩份真的檔案對得起來 ——
 * 而且確認這支**真的判斷過東西**（nodes 是 0 的話，0 個錯誤沒有意義）。
 */
const realSchema = JSON.parse(await readFile(resolve(ROOT, 'src/data/syndication.schema.json'), 'utf8'));
const realData = JSON.parse(await readFile(resolve(ROOT, 'src/data/syndication.json'), 'utf8'));
const live = validate(realData, realSchema);
ok('真的 syndication.json 通得過它自己的 schema', live.errors.length === 0, live.errors.join('；'));
ok('而且真的判斷過東西（不是空跑）', live.nodes > 50, `判斷過 ${live.nodes} 個節點`);
ok('真的那份 schema 沒有這支看不懂的東西', unsupported(realSchema).length === 0, unsupported(realSchema).join('、'));

console.log(`  （SUPPORTED 目前有 ${SUPPORTED.size} 個關鍵字；真資料判斷過 ${live.nodes} 個節點）`);
console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
