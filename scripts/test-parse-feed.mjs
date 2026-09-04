#!/usr/bin/env node
// @ts-check
/**
 * Feed 剖析的實測 —— `npm run test:parse-feed`
 *
 * 三種格式（RSS 2.0 / Atom / RDF）各一份樣本，確認每個欄位都對應到位。
 *
 * ## 為什麼特別要測「欄位」而不只是「不會爆」
 *
 * 這段程式碼壞掉的方式分兩種：
 *
 * - **認不出格式** → 拋錯 → 同步紅燈 → 有人會發現
 * - **欄位對應壞掉** → **不會拋錯** → 同步照樣回報「抓到 9 筆」，
 *   只是日期全是 null、摘要全是空字串。網站上就是一排沒有日期的空項目，
 *   而所有檢查都是綠的
 *
 * 第二種才是危險的那種，所以這裡逐欄位比對，不只看有沒有回傳東西。
 */
import { execFileSync } from 'node:child_process';
import { parseFeed, tidyTitle, toIso } from './lib/parse-feed.mjs';

let failed = 0;
/** @param {boolean} cond @param {string} label @param {unknown} [got] */
const ok = (cond, label, got) => {
  if (!cond) { failed++; console.log(`  X ${label}${got !== undefined ? `  實際：${JSON.stringify(got)}` : ''}`); }
  return cond;
};

const source = { id: 'test-source' };

console.log('\nFeed 剖析實測');
console.log('─'.repeat(64));

// ── RSS 2.0（痞客邦這一類） ──────────────────────────
{
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>某個部落格</title>
    <item>
      <title>第一篇 &amp; 標點</title>
      <link>https://example.com/a?utm_source=rss&amp;utm_medium=feed</link>
      <guid>https://example.com/a</guid>
      <pubDate>Mon, 26 Oct 2024 06:23:28 +0000</pubDate>
      <description>&lt;p&gt;摘要裡有 &lt;b&gt;HTML&lt;/b&gt;。&lt;/p&gt;</description>
      <category>唐詩</category><category>樂府</category>
    </item>
  </channel></rss>`;
  /*
   * `= {}` 的預設值不是裝飾。第 4 輪（第十圈）做突變掃描時，把剖析改成
   * 「什麼都不回」會讓下面每一行 `it.xxx` **整個腳本崩潰** —— CI 會紅，
   * 但輸出是一段堆疊而不是「哪一條期望沒被滿足」。
   * 給個空物件，那些斷言就會各自具名地失敗。
   */
  const [it = /** @type {any} */ ({})] = parseFeed(xml, source);
  console.log('  RSS 2.0');
  ok(it.title === '第一篇 & 標點', '    標題解了實體字元', it.title);
  ok(it.url === 'https://example.com/a', '    網址去掉了 utm 追蹤參數', it.url);
  ok(Boolean(it.publishedAt?.startsWith('2024-10-26')), '    日期轉成 ISO', it.publishedAt);
  ok(it.summary === '摘要裡有 HTML。', '    摘要去掉了 HTML 標籤', it.summary);
  ok(JSON.stringify(it.tags) === '["唐詩","樂府"]', '    多個 category 都收到', it.tags);
  ok(typeof it.id === 'string' && it.id.length > 0, '    有穩定 id', it.id);
}

// ── Atom（Blogger、YouTube 這一類） ──────────────────
{
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <title>某個頻道</title>
    <entry>
      <id>tag:example.com,2024:post-1</id>
      <title>Atom 的一篇</title>
      <link rel="edit" href="https://example.com/edit/1"/>
      <link rel="alternate" href="https://example.com/post/1"/>
      <published>2024-03-03T17:10:22+00:00</published>
      <updated>2024-04-01T00:00:00+00:00</updated>
      <summary>Atom 的摘要。</summary>
      <category term="詩詞"/>
    </entry>
  </feed>`;
  const [it = /** @type {any} */ ({})] = parseFeed(xml, source);
  console.log('  Atom');
  ok(it.title === 'Atom 的一篇', '    標題', it.title);
  ok(it.url === 'https://example.com/post/1', '    挑的是 rel=alternate 不是 rel=edit', it.url);
  ok(Boolean(it.publishedAt?.startsWith('2024-03-03')), '    優先用 published 而不是 updated', it.publishedAt);
  ok(it.summary === 'Atom 的摘要。', '    摘要', it.summary);
  ok(JSON.stringify(it.tags) === '["詩詞"]', '    category 取的是 @term', it.tags);
}

// ── RSS 1.0（RDF） ──────────────────────────────────
{
  const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <item rdf:about="https://example.com/rdf/1">
      <title>RDF 的一篇</title>
      <link>https://example.com/rdf/1</link>
      <dc:date>2024-05-05T12:00:00+08:00</dc:date>
      <description>RDF 摘要。</description>
      <dc:subject>宋詞</dc:subject>
    </item>
  </rdf:RDF>`;
  const [it = /** @type {any} */ ({})] = parseFeed(xml, source);
  console.log('  RSS 1.0（RDF）');
  ok(it.title === 'RDF 的一篇', '    標題', it.title);
  ok(it.url === 'https://example.com/rdf/1', '    網址', it.url);
  ok(Boolean(it.publishedAt?.startsWith('2024-05-05')), '    dc:date 轉成 ISO', it.publishedAt);
  ok(it.summary === 'RDF 摘要。', '    摘要', it.summary);
  ok(JSON.stringify(it.tags) === '["宋詞"]', '    dc:subject 當標籤', it.tags);
}

// ── 標題的清洗：只做明確安全的兩件事 ──────────────────
{
  console.log('  標題清洗');
  /*
   * `tidyTitle` 的規則是「結尾**連續兩個以上**的 hashtag 才拿掉」，
   * 理由寫在它自己的註解裡：一個 hashtag 可能是正文的一部分。
   *
   * 第 4 輪（第十六圈）的突變掃描量到那個「兩個以上」**沒有測試在守** ——
   * 改成一個就拿掉，所有案例照樣綠。少了下面第一格，
   * 「王昌齡的邊塞詩 #出塞」會被砍成「王昌齡的邊塞詩」。
   */
  ok(tidyTitle('王昌齡的邊塞詩 #出塞') === '王昌齡的邊塞詩 #出塞', '    只有一個 hashtag 時不動它', tidyTitle('王昌齡的邊塞詩 #出塞'));
  ok(tidyTitle('王昌齡〈出塞〉 #唐詩 #邊塞') === '王昌齡〈出塞〉', '    兩個以上才拿掉', tidyTitle('王昌齡〈出塞〉 #唐詩 #邊塞'));
  ok(tidyTitle('狐狸🦊與月亮') === '狐狸🦊與月亮', '    句中的表情符號留著', tidyTitle('狐狸🦊與月亮'));
  ok(tidyTitle('🦊 靜夜思 🌙') === '靜夜思', '    頭尾的表情符號拿掉', tidyTitle('🦊 靜夜思 🌙'));
}

// ── 網址的清洗：該洗的洗、不該動的別動 ──────────────
{
  console.log('  網址清洗');
  const withUtm = parseFeed(
    `<rss><channel><item><title>一</title><link>https://e.com/a?id=7&amp;utm_source=rss</link></item></channel></rss>`,
    source,
  );
  ok(withUtm[0]?.url === 'https://e.com/a?id=7', '    utm 拿掉、真的參數留著', withUtm[0]?.url);

  /*
   * ── 錨點要留著 ──
   *
   * 第 4 輪（第十六圈）的誤報探針量到：`cleanUrl()` 本來一律 `u.hash = ''`，
   * 於是指向文章某一節的連結被默默改成指向整篇。
   * 而拿掉錨點在隱私上沒有任何好處 —— **片段識別碼不會送到伺服器**。
   * 站主連到自己在別處的文章時，錨點就是她指的地方。
   */
  const withHash = parseFeed(
    `<rss><channel><item><title>一</title><link>https://e.com/a#chapter-2</link></item></channel></rss>`,
    source,
  );
  ok(withHash[0]?.url === 'https://e.com/a#chapter-2', '    錨點不會被洗掉', withHash[0]?.url);

  /* 兩者同時：追蹤參數拿掉，錨點留著 */
  const both = parseFeed(
    `<rss><channel><item><title>一</title><link>https://e.com/a?utm_medium=x#note</link></item></channel></rss>`,
    source,
  );
  ok(both[0]?.url === 'https://e.com/a#note', '    追蹤參數拿掉、錨點留著', both[0]?.url);
}

// ── 邊界情況 ────────────────────────────────────────
{
  console.log('  邊界');
  const one = parseFeed(`<rss><channel><item><title>只有一筆</title><link>https://e.com/1</link></item></channel></rss>`, source);
  ok(one.length === 1, '    單筆時不會被當成非陣列而漏掉', one.length);

  const none = parseFeed(`<rss><channel><title>空的</title></channel></rss>`, source);
  ok(none.length === 0, '    沒有項目時回空陣列而不是爆掉', none.length);

  const noTitle = parseFeed(`<rss><channel><item><link>https://e.com/2</link></item></channel></rss>`, source);
  ok(noTitle[0]?.title === '(無標題)', '    沒有標題時給預設值', noTitle[0]?.title);

  /*
   * 沒有連結的一筆會被丟掉。
   *
   * 上面那條「沒有標題給預設值」存在很久了，網址卻沒有對應的保險 ——
   * 第 4 輪（第十圈）量到那個不對稱。兩個後果都不會拋錯：
   *
   *   id  = stableId(source.id, guid || link)，兩者都空 → 每一筆同一個 id，
   *         而 mergeItems 用 id 當 key，所以第二筆會被第一筆蓋掉
   *   站上 = `<a href target="_blank">`，空的 href 指向當前頁 ——
   *         點下去是「在新分頁重新開啟這一頁」
   *
   * 這幾個案例刻意各自只壞一件事，混在一起就證明不了是哪一條讓它綠的。
   */
  const noLink = parseFeed(`<rss><channel><item><title>沒有連結</title></item></channel></rss>`, source);
  ok(noLink.length === 0, '    沒有連結的一筆會被丟掉', noLink.length);

  const emptyLink = parseFeed(`<rss><channel><item><title>空的連結</title><link></link></item></channel></rss>`, source);
  ok(emptyLink.length === 0, '    空的 <link> 也算沒有連結', emptyLink.length);

  /* 有 guid 就有 id，但仍然沒有地方可去 —— id 算得出來不等於這一筆能用 */
  const guidOnly = parseFeed(
    `<rss><channel><item><title>只有 guid</title><guid>tag:x:1</guid></item></channel></rss>`, source);
  ok(guidOnly.length === 0, '    只有 guid 沒有連結也不算數', guidOnly.length);

  /* 壞的丟掉、好的留著 —— 證明它丟的是那一筆，不是整個 feed */
  const mixed = parseFeed(
    `<rss><channel><item><title>好的</title><link>https://e.com/ok</link></item>` +
    `<item><title>壞的</title></item></channel></rss>`, source);
  ok(mixed.length === 1 && mixed[0].title === '好的', '    同一個 feed 裡好的留著、壞的丟掉',
     mixed.map((i) => i.title));

  /* 丟掉這件事要說出來，不然就變成另一種安靜的資料遺失 */
  /** @type {string[]} */
  const warns = [];
  const twoBad = parseFeed(
    `<rss><channel><item><title>丙</title></item><item><title>丁</title></item></channel></rss>`,
    source, { log: { warn: (/** @type {string} */ m) => warns.push(m) } });
  ok(twoBad.length === 0, '    兩筆都沒有連結時兩筆都丟掉（以前會塌成同一個 id）', twoBad.length);
  ok(warns.length === 1 && /2 筆沒有連結/.test(warns[0]) && /丙/.test(warns[0]) && /丁/.test(warns[0]),
     '    警告帶著筆數與標題', warns);

  /* 沒有傳 log 也不能爆 —— test-parse-feed 以外的呼叫點不一定有 logger */
  let noLogThrew = '';
  try {
    parseFeed(`<rss><channel><item><title>沒有連結</title></item></channel></rss>`, source);
  } catch (e) { noLogThrew = String(/** @type {Error} */ (e)?.message); }
  ok(noLogThrew === '', '    沒有傳 log 時不會爆', noLogThrew);

  /*
   * 解不出來的日期回 `undefined`（不是 null，也不是 Invalid Date）。
   *
   * 第一版這裡寫 `=== null` 而失敗 —— **那是測試的預期錯了，不是程式錯了**。
   * `undefined` 經過 JSON.stringify 會讓整個 key 消失，而下游
   * （lib/syndication.ts 的 toDate）對「key 不存在」回傳 null，
   * 排序也用 `?? 0` 擋著。兩邊接得上。
   *
   * 真正要防的是**無效的日期字串流進資料裡** —— 那會讓頁面上出現
   * 「Invalid Date」而所有檢查都是綠的。所以這裡斷言它是 falsy，
   * 而且不是一個看起來像日期卻無效的字串。
   */
  const badDate = parseFeed(`<rss><channel><item><title>x</title><link>https://e.com/3</link><pubDate>不是日期</pubDate></item></channel></rss>`, source);
  /*
   * 用 `?.` 與 `?? {}` 而不是直接取 [0]：第 4 輪（第十圈）做突變掃描時，
   * 把過濾條件改成「全部丟掉」會讓這幾行**整個腳本崩潰** —— CI 會紅，
   * 但輸出是一段堆疊而不是「哪一條期望沒被滿足」。
   * 跟 test-fetch-retry 的 expectOk 是同一件事。
   */
  ok(!badDate[0]?.publishedAt, '    日期解不出來時是 falsy（不會是 Invalid Date 字串）', badDate[0]?.publishedAt);
  const roundTrip = JSON.parse(JSON.stringify(badDate[0] ?? {}));
  ok(badDate.length === 1 && roundTrip.publishedAt === undefined,
     '    JSON 往返後那個欄位不存在，下游會當成 null', roundTrip.publishedAt);

  let threw = false;
  try { parseFeed('<html><body>這不是 feed</body></html>', source); } catch { threw = true; }
  ok(threw, '    認不出來的格式會拋錯（而不是安靜回空）');

  /*
   * 同一筆內容兩次剖析要得到同一個 id —— 不然「只增不刪」的合併會一直重複。
   *
   * 這三個 fixture 原本**沒有 `<link>`**（作者只在意 guid），
   * 第 4 輪（第十圈）加了「沒有連結就丟掉」之後它們就變成空陣列了。
   * 補上 link，測的東西完全沒變（guid 優先於 link，所以 id 仍然來自 guid），
   * 只是 fixture 從「現實中不存在的一筆」變成一筆正常的項目。
   */
  const stable = (/** @type {{ id: string }} */ src) =>
    parseFeed(
      `<rss><channel><item><title>x</title><guid>g1</guid><link>https://e.com/s</link></item></channel></rss>`,
      src,
    )[0];
  const a = stable(source);
  const b = stable(source);
  ok(Boolean(a) && a?.id === b?.id, '    同一筆兩次剖析得到同一個 id', [a?.id, b?.id]);
  const other = stable({ id: 'another' });
  ok(Boolean(a) && a?.id !== other?.id, '    不同來源的同一個 guid 不會撞 id');
  ok(Boolean(a?.id?.includes('g1')), '    id 來自 guid 而不是 link（兩者都在時 guid 優先）', a?.id);
}

// ── YouTube 的 feed 要當場擋下來 ─────────────────────
{
  /*
   * 它是合法的 Atom，所以通用剖析器**讀得動** —— 只是答得幾乎全錯
   * （第 4 輪〔第十四圈〕逐欄位比過：七個裡只有 publishedAt 一樣）。
   * 兩支的簽名一模一樣，叫錯了不會有任何徵兆，所以要擋。
   * 第 4 輪（第十一圈）真的踩過一次。
   */
  const yt =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" ' +
    'xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">' +
    '<yt:channelId>UCxxxxxxxxxxxxxxxxxxxxxx</yt:channelId>' +
    '<entry><id>yt:video:AAA</id><yt:videoId>AAA</yt:videoId><title>x</title></entry></feed>';
  let threw = '';
  try {
    parseFeed(yt, source);
  } catch (e) {
    threw = /** @type {any} */ (e)?.message ?? String(e);
  }
  console.log('  YouTube 的 feed');
  ok(/parse-youtube-feed/.test(threw), '    擋下來而且指名該用哪一支', threw);
  ok(/id/.test(threw), '    訊息說得出後果（id 算法不同）', threw);
}

/*
 * ── 沒帶時區的日期，不能跟著機器跑 ────────────────────
 *
 * 第 4 輪（第二十二圈）實測：`new Date('2026-01-01 00:00:00')` 用的是
 * **跑這段程式的機器**的時區，所以同一份 feed 存進 `syndication.json` 的
 * 日期會因為「同步跑在哪裡」而差一天（CI 在 UTC、站主在美東、她在臺北）。
 *
 * 178 個真實 feed 的日期裡目前**一個都沒有**缺時區的（七個公開 feed 實測），
 * 所以這一條守的是「哪天遇到一個不合規格的 feed 也不會出事」。
 */
{
  console.log('  日期與時區');
  const noZone = ['2026-01-01 00:00:00', 'Mon, 01 Jan 2026 00:00:00', '2026-01-01T00:00:00'];
  const withZone = ['Mon, 01 Jan 2026 00:00:00 +0900', '2026-01-01T00:00:00Z', 'Sun, 03 May 2026 10:00:37 GMT'];

  ok(
    noZone.every((s) => String(toIso(s)).startsWith('2026-01-01T00:00:00')),
    '沒帶時區的日期一律當成 UTC',
    noZone.map((s) => `${s} → ${toIso(s)}`).join(' ｜ '),
  );
  ok(
    toIso(withZone[0]) === '2025-12-31T15:00:00.000Z',
    '有帶時區的照它說的算（+0900 的元旦午夜是 UTC 的 12/31）',
    toIso(withZone[0]),
  );
  ok(
    withZone.slice(1).every((s) => String(toIso(s)).startsWith('2026-01-01') || String(toIso(s)).startsWith('2026-05-03')),
    'Z 與 GMT 都認得',
    withZone.slice(1).map((s) => `${s} → ${toIso(s)}`).join(' ｜ '),
  );
  ok(toIso('2026-01-01') === '2026-01-01T00:00:00.000Z', '只有日期的照舊（規格上本來就是 UTC）', toIso('2026-01-01'));

  /*
   * 真的換一個時區跑一次 —— 上面那幾格都在同一台機器上，
   * 而這一條要守的正是「換一台機器會不會不一樣」。
   */
  const probe = `
    import { toIso } from '${new URL('./lib/parse-feed.mjs', import.meta.url).pathname}';
    console.log(JSON.stringify(${JSON.stringify(noZone)}.map(toIso)));
  `;
  /** @param {string} tz */
  const inTz = (tz) =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
        encoding: 'utf8',
        env: { ...process.env, TZ: tz },
      }).trim(),
    );
  const a = inTz('Asia/Taipei');
  const b = inTz('America/New_York');
  const c = inTz('UTC');
  ok(
    JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c),
    '三個時區底下算出來的一模一樣',
    JSON.stringify({ 臺北: a[0], 美東: b[0], UTC: c[0] }),
  );
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
