#!/usr/bin/env node
// @ts-check
/**
 * 「這份 feed 讀得出幾筆」的測試 —— `npm run test:count-items`
 *
 * 零網路：所有 feed 都是這個檔案裡的字串。
 *
 * ## 為什麼需要這個
 *
 * `countItems` 是 `verify --patterns` 用來判斷「這個綠燈到底證明了什麼」的
 * 那一步。它會分流：YouTube 的 feed 走專用剖析器，其他走通用的。
 *
 * 第 4 輪（第二十一圈）寫它的第一版**沒有分流**，於是一份完全正常的
 * YouTube feed 被報成「剖析失敗」—— 而那個錯誤看起來跟「YouTube 真的壞了」
 * 一模一樣。這裡把那個分岔釘住。
 */
import { countItems } from './lib/count-items.mjs';

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
}

/** 兩筆的 YouTube Atom —— 命名空間與 videoId 是分流的判準 */
const YT =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" ' +
  'xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">' +
  '<title>狐說八道</title>' +
  ['a', 'b']
    .map(
      (k) =>
        `<entry><id>yt:video:${k}</id><yt:videoId>${k}</yt:videoId>` +
        `<title>影片 ${k}</title><link rel="alternate" href="https://www.youtube.com/watch?v=${k}"/>` +
        `<published>2026-01-0${k === 'a' ? 1 : 2}T00:00:00+00:00</published>` +
        '<media:group><media:description>說明</media:description>' +
        '<media:thumbnail url="https://i.ytimg.com/vi/x/hq.jpg"/></media:group></entry>',
    )
    .join('') +
  '</feed>';

/** 三筆的一般 RSS 2.0 */
const RSS = (items = 3) =>
  '<?xml version="1.0"?><rss version="2.0"><channel><title>某個部落格</title>' +
  Array.from(
    { length: items },
    (_, i) => `<item><title>第 ${i + 1} 篇</title><link>https://example.test/${i + 1}</link>` +
      `<pubDate>Mon, 0${i + 1} Jan 2026 00:00:00 +0000</pubDate></item>`,
  ).join('') +
  '</channel></rss>';

console.log('\nfeed 筆數判讀\n' + '─'.repeat(56));

{
  /*
   * 這一格就是第一版錯的那個。通用剖析器對 YouTube 的 feed 會拋錯，
   * 沒有分流的話這裡會拿到 -1 —— 也就是把一份好好的 feed 報成壞的。
   */
  const r = countItems(YT);
  check('YouTube 的 feed：走專用剖析器，讀得出 2 筆', r.n === 2, r);
}

{
  /*
   * 反向：一般的 RSS 不能被送去 YouTube 剖析器。
   * 送錯的話讀出來會是 0 筆，而 0 筆在報告裡長得像「這個帳號沒在發文」——
   * 又是一個「工具錯了看起來像資料的問題」。
   */
  const r = countItems(RSS(3));
  check('一般的 RSS：走通用剖析器，讀得出 3 筆', r.n === 3, r);
}

{
  /*
   * note 的 probeHandle 實測就是這一種：200、合法的 RSS 2.0、
   * 1130 bytes、連一個 <item> 都沒有。
   * `0` 跟 `-1` 一定要分得開 —— 前者是「端點好好的，只是沒東西」，
   * 後者是「這根本讀不動」。兩者的下一步完全不同。
   */
  const r = countItems('<?xml version="1.0"?><rss version="2.0"><channel><title>空的</title></channel></rss>');
  check('合法但空的 feed：0 筆，不是剖析失敗', r.n === 0 && r.err === undefined, r);
}

{
  const r = countItems('<!DOCTYPE html><html><body>這是網頁不是 feed</body></html>');
  check('根本不是 feed：-1 並且說得出原因', r.n === -1 && Boolean(r.err), r);
}

{
  /* 空字串也不能讓整支腳本崩掉 —— 逾時或被截斷的回應會長這樣 */
  const r = countItems('');
  check('空字串：-1，不是拋出去', r.n === -1, r);
}

console.log('─'.repeat(56));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
