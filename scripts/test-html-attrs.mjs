#!/usr/bin/env node
// @ts-check
/**
 * 開始標籤的屬性掃描 —— `npm run test:html-attrs`
 *
 * ## 為什麼需要這個
 *
 * 這支掃描器取代的是一行正則：`new RegExp('\\b' + name + '\\s*=\\s*"…"')`。
 * 那一行在 `check-a11y.mjs` 裡活了十二圈，而它把 `data-lang="zh"`
 * 當成 `lang="zh"`（`\b` 在連字號後面成立）。後果是兩種相反的錯同時存在：
 * 誤報 `positive-tabindex`／`aria-ref`，漏報 `html-lang`／`img-alt`／`blank-rel`。
 *
 * 規則測試（`test:a11y-rules`）抓不到，因為它的案例都是把屬性**整個拿掉**——
 * 從來沒有一頁同時「沒有 lang」又「有一個 data-lang」。所以這裡守的是
 * 「屬性名的邊界」本身，不是某一條規則。
 */
import { parseAttrs, attrOf } from './lib/html-attrs.mjs';

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
}

console.log('\n開始標籤的屬性掃描\n' + '─'.repeat(64));

// ── 1. 前綴不算（就是那個 bug）─────────────────────────
for (const [tag, name] of /** @type {[string, string][]} */ ([
  ['<html data-lang="zh-Hant-TW">', 'lang'],
  ['<img src="/x.png" data-alt="不是 alt">', 'alt'],
  ['<p data-tabindex="5">', 'tabindex'],
  ['<a data-href="/x">', 'href'],
  ['<a target="_blank" data-rel="x">', 'rel'],
  ['<span data-aria-labelledby="nope">', 'aria-labelledby'],
  ['<label data-for="x">', 'for'],
])) {
  check(`${name} 不會從 ${tag.match(/data-[a-z-]+/)?.[0]} 讀出來`, attrOf(tag, name) === null, attrOf(tag, name));
}

// ── 2. 真的有的時候要讀得到 ───────────────────────────
check('真的 lang 讀得到', attrOf('<html lang="en">', 'lang') === 'en');
check('前面有 data- 同名屬性也不影響', attrOf('<html data-lang="zh" lang="en">', 'lang') === 'en');
check('順序反過來也一樣', attrOf('<html lang="en" data-lang="zh">', 'lang') === 'en');

// ── 3. 無值屬性 = 空字串（不是 null）───────────────────
/*
 * HTML 規定無值屬性的值就是空字串，而 `<img alt>` 正是「這張圖是裝飾用的」
 * 的正確寫法 —— Astro 就是這樣輸出的。回 null 的話 img-alt 會誤報。
 */
check('<img alt> 的 alt 是空字串', attrOf('<img src="/x.png" alt>', 'alt') === '');
check('沒有那個屬性才是 null', attrOf('<img src="/x.png">', 'alt') === null);

// ── 4. 引號的三種寫法 ─────────────────────────────────
check('雙引號', attrOf('<a href="/x">', 'href') === '/x');
check('單引號', attrOf("<a href='/x'>", 'href') === '/x');
check('沒有引號', attrOf('<a target=_blank>', 'target') === '_blank');
check('= 前後有空白', attrOf('<a href = "/x">', 'href') === '/x');

// ── 5. 值裡面有特殊字元 ───────────────────────────────
check('值裡有 >', attrOf('<a title="a > b" href="/x">', 'title') === 'a > b');
check('值裡有單引號（外面是雙引號）', attrOf(`<a title="it's" href="/x">`, 'title') === "it's");
check('值是空字串', attrOf('<a href="">', 'href') === '');

// ── 6. 大小寫與自閉合 ─────────────────────────────────
check('屬性名大小寫不敏感', attrOf('<img SRC="/x.png" ALT="狐">', 'alt') === '狐');
check('查詢用大寫也可以', attrOf('<img alt="狐">', 'ALT') === '狐');
check('自閉合的斜線不會被當成屬性', attrOf('<img alt="狐" />', 'alt') === '狐');
/* 無值屬性緊接著自閉合的斜線：名字不能變成 `alt/`（突變掃描抓出這一格沒守到） */
check('<img alt/> 的斜線不會黏進屬性名', attrOf('<img src="/x.png" alt/>', 'alt') === '', attrOf('<img src="/x.png" alt/>', 'alt'));

// ── 7. 標籤名不能被當成屬性 ───────────────────────────
/* `<a href>` 裡的標籤名是 `a`；如果掃描從第 0 個字開始，`a` 會變成一個屬性 */
check('標籤名不會混進屬性表', !parseAttrs('<a href="/x">').has('a'), [...parseAttrs('<a href="/x">').keys()]);

// ── 8. 同名重複時第一個勝（瀏覽器的行為）──────────────
check('重複屬性取第一個', attrOf('<img alt="真的" alt="假的">', 'alt') === '真的');

// ── 9. 整張表 ─────────────────────────────────────────
{
  const m = parseAttrs('<a class="x y" href="/p" data-href="/q" target=_blank hidden>');
  check(
    '整張表：五個屬性、值都對',
    m.size === 5 && m.get('class') === 'x y' && m.get('href') === '/p' &&
      m.get('data-href') === '/q' && m.get('target') === '_blank' && m.get('hidden') === '',
    [...m],
  );
}

// ── 10. 壞掉的輸入不能讓它卡住或拋錯 ──────────────────
for (const bad of ['<a href="沒有收尾', '<', '<a', '<a =', '<a ="x">', '']) {
  let threw = '';
  try { parseAttrs(bad); } catch (e) { threw = /** @type {any} */ (e)?.message ?? String(e); }
  check(`壞輸入不拋錯：${JSON.stringify(bad)}`, threw === '', threw);
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
