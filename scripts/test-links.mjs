#!/usr/bin/env node
// @ts-check
/**
 * 站內連結檢查的實測 —— `npm run test:links`
 *
 * 每個案例做一份假的 dist，跑 check-links，確認它在該擋的時候擋、
 * 不該擋的時候不要誤報。零網路。
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
/** @param {string} name @param {boolean} good @param {unknown} [detail] */
function ok(name, good, detail) {
  console.log(`  ${good ? '✓' : 'X'} ${name}`);
  if (!good) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
}

const page = (/** @type {string} */ body) =>
  `<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title></head><body>${body}</body></html>`;

/**
 * @param {string} label
 * @param {Record<string, string>} files
 * @param {{ exit: number, needle?: string, notNeedle?: string, args?: string[] }} want
 */
async function check(label, files, want) {
  const dir = await mkdtemp(join(tmpdir(), 'links-'));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body, 'utf8');
  }
  let out = '';
  let exit = 0;
  try {
    ({ stdout: out } = await run('node', [resolve(ROOT, 'scripts/check-links.mjs'), `--dir=${dir}`, ...(want.args ?? [])]));
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    out = String(e?.stdout ?? '');
    exit = typeof e?.code === 'number' ? e.code : -1;
  }
  await rm(dir, { recursive: true, force: true });

  const problems = [];
  if (exit !== want.exit) problems.push(`離開碼：預期 ${want.exit}，實際 ${exit}`);
  if (want.needle && !out.includes(want.needle)) problems.push(`輸出裡找不到「${want.needle}」`);
  /* 反向：這句話不該出現。少了它，「一律印」的版本會靜靜通過 */
  if (want.notNeedle && out.includes(want.notNeedle)) {
    problems.push(`輸出裡不該有「${want.notNeedle}」，但它出現了`);
  }
  ok(label, problems.length === 0, problems.length ? { problems, tail: out.split('\n').slice(-6) } : undefined);
}

console.log('\n站內連結檢查的實測\n' + '─'.repeat(64));

await check(
  '每個連結都指到存在的檔案：過',
  { 'index.html': page('<a href="/about">關於</a>'), 'about/index.html': page('關於') },
  { exit: 0 },
);

await check(
  '指到不存在的頁：擋',
  { 'index.html': page('<a href="/en/about">English</a>') },
  { exit: 1, needle: 'about/index.html' },
);

/* 有副檔名的直接當檔案看，不要去找 rss.xml/index.html */
await check(
  '有副檔名的當檔案：過',
  { 'index.html': page('<a href="/rss.xml">RSS</a>'), 'rss.xml': '<rss/>' },
  { exit: 0 },
);

/*
 * ── 建得出來但誰都到不了 ──────────────────────────
 *
 * 第 4 輪（第十八圈）真的踩到的形狀：`/rss-all.xml` 產出來了，
 * 但整個 dist/ 裡沒有一處指得到。
 */
await check(
  '沒有人指得到的 feed：擋',
  { 'index.html': page('首頁'), 'rss-all.xml': '<rss/>' },
  { exit: 1, needle: '訂閱的人找不到' },
);

/*
 * 「拿網址去 src/ 搜」對這一種問題沒有意義（沒有出處可以搜，要做的是加連結）。
 * 這是第 7 輪（第十七圈）那個「一段對所有壞法都說的話」的第二例。
 */
await check(
  '只有 feed 沒人指得到時：不要說「去 src/ 搜那個網址」',
  { 'index.html': page('首頁'), 'rss-all.xml': '<rss/>' },
  { exit: 1, needle: '訂閱的人找不到', notNeedle: '拿去搜' },
);

/*
 * 反向：`<head>` 的 autodiscovery 就算數。閱讀器靠的正是那一條，
 * 不能因為畫面上看不到就說它到不了。
 */
await check(
  '只有 <head> 的 autodiscovery 指得到：過',
  {
    'index.html':
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title>' +
      '<link rel="alternate" type="application/rss+xml" href="/rss-all.xml"></head><body>x</body></html>',
    'rss-all.xml': '<rss/>',
  },
  { exit: 0 },
);

/*
 * 反向的另一半：sitemap 不歸這條規則管（它走 robots.txt）。
 * 少了這一格，把判斷放寬成「所有 .xml」也會全綠。
 */
await check(
  'sitemap 沒有頁面指得到也不算問題：過',
  { 'index.html': page('首頁'), 'sitemap-0.xml': '<urlset/>', 'sitemap-index.xml': '<sitemapindex/>' },
  { exit: 0 },
);

/*
 * ── 自家網域從 hreflang 讀，不從 canonical 讀 ──────────
 *
 * 第 4 輪（第二十圈）走 `canonicalUrl` 這條沒人走過的路時發現的：
 * 那個欄位存在的唯一理由就是「這篇先發在別的平臺」，填了它，
 * 那一頁的 canonical 指向別人家 —— 舊的做法會把那個平臺當成自家網域，
 * 於是每一個指向它的外部連結都被當成站內檔案去找，報出假的 404。
 */
await check(
  'canonical 指向別的平臺：那個平臺不算自家網域',
  {
    'index.html':
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title>' +
      '<link rel="alternate" hreflang="zh-Hant-TW" href="https://bellafoxy.com/">' +
      '<link rel="canonical" href="https://matters.town/@fox/abc">' +
      '</head><body><a href="https://matters.town/@fox/abc">原文</a></body></html>',
  },
  { exit: 0 },
);

/* 反向：真正的自家網域（hreflang 指的那個）仍然要當成站內連結檢查 */
await check(
  '自家網域的絕對網址：照樣要找得到檔案',
  {
    'index.html':
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title>' +
      '<link rel="alternate" hreflang="zh-Hant-TW" href="https://bellafoxy.com/">' +
      '</head><body><a href="https://bellafoxy.com/nope">壞的</a></body></html>',
  },
  { exit: 1, needle: '/nope' },
);

/* 沒有 hreflang 的時候（測試的假 dist 常常這樣）退回 canonical */
await check(
  '沒有 hreflang 時退回 canonical',
  {
    'index.html':
      '<!DOCTYPE html><html lang="zh-Hant-TW"><head><title>x</title>' +
      '<link rel="canonical" href="https://bellafoxy.com/">' +
      '</head><body><a href="https://bellafoxy.com/nope">壞的</a></body></html>',
  },
  { exit: 1, needle: '/nope' },
);

/*
 * ── 同一個壞網址出現在很多頁 ──────────────────────
 *
 * 第 7 輪（第十九圈）在 600 頁下量到：頁尾清單裡打錯一個字，
 * 這支腳本印 600 筆、1819 行。收「出處」那一層，不收網址那一層 ——
 * 同一個壞網址是一件事，不同的壞網址是不同件事。
 */
{
  /** @type {Record<string, string>} */
  const many = {};
  for (let i = 0; i < 8; i++) many[`p${i}/index.html`] = page('<a href="/nope">壞的</a>');
  await check('同一個壞網址出現在 8 頁：只列 3 頁', many, {
    exit: 1,
    needle: '…另外 5 頁也有',
  });
  await check('總數照實說（8 個有問題）', many, { exit: 1, needle: '8 個有問題' });
  /*
   * needle 要挑**只有全印時才會出現**的東西：第 8 頁的路徑。
   * 第一版用的是「不要有『另外 N 頁』」，而 --verbose 本來就不印那一行 ——
   * 把收合套進 verbose 的突變照樣全綠。突變掃描抓到的。
   */
  await check('--verbose 把 8 頁都印出來', many, {
    exit: 1,
    args: ['--verbose'],
    needle: 'p7/index.html',
  });
}

/*
 * 反向：**不同的**壞網址不能被收掉 —— 那是三件各自要改的工作。
 */
/*
 * needle 要夠長才分得出來：第一版用 `/c`，而輸出裡的建議句子本來就有
 * 斜線與字母，只印第一則的突變照樣全綠。改成三個都查。
 */
{
  const three = {
    'index.html': page('<a href="/aaa">1</a><a href="/bbb">2</a><a href="/ccc">3</a>'),
  };
  await check('三個不同的壞網址：第一則要印', three, { exit: 1, needle: 'X /aaa' });
  await check('三個不同的壞網址：第二則也要印', three, { exit: 1, needle: 'X /bbb' });
  await check('三個不同的壞網址：第三則也要印', three, { exit: 1, needle: 'X /ccc' });
}

/* 中文標籤的網址是 percent-encoded，要先解碼才找得到目錄 */
await check(
  'percent-encoded 的中文網址：過',
  {
    'index.html': page('<a href="/tags/%E5%94%90%E8%A9%A9">唐詩</a>'),
    'tags/唐詩/index.html': page('唐詩'),
  },
  { exit: 0 },
);

/* 靜態主機的 404.html 住在根目錄，不是 404/index.html */
await check(
  '<路徑>.html 也算數（404 的 canonical 指向 /404）：過',
  { '404.html': page('<a href="/404">自己</a>') },
  { exit: 0 },
);

/* 搜尋頁的樣板字串在 <script> 裡，不該被當成連結 */
await check(
  '<script> 裡的樣板不算連結：過',
  { 'index.html': page('<script>const x = `<a href="${u(e.u)}">x</a>`;</script>') },
  { exit: 0 },
);

await check(
  '相對連結：擋',
  { 'index.html': page('<a href="about">關於</a>'), 'about/index.html': page('關於') },
  { exit: 1, needle: '相對連結' },
);

/*
 * ── 建議要對得上壞法 ────────────────────────────────
 *
 * 第 7 輪（第十七圈）量到：`availableLocales` 那段建議本來是**無條件印**的 ——
 * 一個內容裡打錯的連結（跟語言完全無關）也會看到它。
 * 那不只是沒用，是把人帶去查一個不相干的地方。
 *
 * 兩個方向都要守：一般的壞連結不要提語言，有語言前綴的才提。
 */
await check(
  '一般的壞連結：不提 availableLocales',
  { 'index.html': page('<a href="/poems/nope/">壞掉</a>') },
  { exit: 1, notNeedle: 'availableLocales' },
);
await check(
  '有語言前綴的壞連結：要提 availableLocales',
  { 'index.html': page('<a href="/en/poems/nope/">English</a>') },
  { exit: 1, needle: 'availableLocales' },
);
await check(
  '壞連結一律要說「出處在 src/」',
  { 'index.html': page('<a href="/poems/nope/">壞掉</a>') },
  { exit: 1, needle: '連結的出處在 src/' },
);

/* dist 是空的時候不能安靜地說「全過」 */
await check('一頁都沒有：擋（不能安靜通過）', {}, { exit: 1, needle: '一頁都沒掃到' });

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
