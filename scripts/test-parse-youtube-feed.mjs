#!/usr/bin/env node
// @ts-check
/**
 * YouTube 官方 Atom feed 的剖析實測 —— `npm run test:parse-youtube-feed`
 *
 * 零網路：樣本是**真的抓回來的那一份**（2026-09-03 打
 * `youtube.com/feeds/videos.xml?channel_id=…`，HTTP 200，9 筆）取前兩則。
 *
 * ## 為什麼需要這個
 *
 * 第 4 輪（第十三圈）盤點時量到：`parseFeed`（RSS 2.0／Atom／RDF）有三份
 * 樣本、逐欄位比對，而**每天真正在跑的是 YouTube 那一段** ——
 * 全部 test-*.mjs 裡沒有任何一個檔案提到 `yt:videoId`、`media:group`
 * 或 `media:description`。測試蓋住的是「以後會用到」的那條路，
 * 沒蓋住「現在唯一在用」的那條。
 *
 * 抽出 `lib/parse-youtube-feed.mjs` 之後，這裡逐欄位比對，
 * 並補上真實 feed 裡**現在沒有、但合法**的幾種形狀
 * （只有一筆 entry、沒有 media:group、沒有 videoId、只有 updated）——
 * 那正是這一圈的問題：案例不能只長成一種樣子。
 */
import { parseYouTubeFeed, mapYouTubeApiItem } from './lib/parse-youtube-feed.mjs';

let failed = 0;
/** @param {string} name @param {boolean} okd @param {unknown} [got] */
function check(name, okd, got) {
  console.log(`  ${okd ? '✓' : 'X'} ${name}`);
  if (!okd) {
    failed++;
    if (got !== undefined) console.log('      實際：', JSON.stringify(got));
  }
}

const source = { id: 'youtube-foxpoetry' };

/** 把 entry 包成一份完整的 feed（namespace 宣告照真實的那一份） @param {string} entries */
const feed = (entries) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" ' +
  'xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">\n' +
  '<title>狐說八道</title>\n' + entries + '\n</feed>';

/*
 * ── 真實的兩則（原封不動貼進來）─────────────────────
 *
 * 這裡刻意不簡化。真實的形狀有幾件事是照文件想像不出來的：
 * 標題帶 emoji 與 hashtag、`<link rel="alternate">` 指向 `/shorts/`、
 * `<media:description>` 是多行的、`<updated>` 比 `<published>` 晚兩年。
 */
const REAL_ENTRIES = `<entry>
  <id>yt:video:UYor3t6HnzU</id>
  <yt:videoId>UYor3t6HnzU</yt:videoId>
  <yt:channelId>UCiCJBnqbS3ECSPEM7vSmrPw</yt:channelId>
  <title>🏹 王昌齡〈出塞〉「秦時明月漢時關，萬里長征人未還」邊塞征戰，壯志與悲愁交織。你是否也對長年戍守在外的戰士們心生敬意？ 🦊 #王昌齡 #出塞 #邊塞詩 #唐詩 #戰爭 #壯志</title>
  <link rel="alternate" href="https://www.youtube.com/shorts/UYor3t6HnzU"/>
  <author>
   <name>狐說八道</name>
   <uri>https://www.youtube.com/channel/UCiCJBnqbS3ECSPEM7vSmrPw</uri>
  </author>
  <published>2024-10-26T06:23:28+00:00</published>
  <updated>2026-05-28T20:40:25+00:00</updated>
  <media:group>
   <media:title>🏹 王昌齡〈出塞〉「秦時明月漢時關，萬里長征人未還」邊塞征戰，壯志與悲愁交織。你是否也對長年戍守在外的戰士們心生敬意？ 🦊 #王昌齡 #出塞 #邊塞詩 #唐詩 #戰爭 #壯志</media:title>
   <media:content url="https://www.youtube.com/v/UYor3t6HnzU?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i2.ytimg.com/vi/UYor3t6HnzU/hqdefault.jpg" width="480" height="360"/>
   <media:description>王昌齡的〈出塞〉是唐代邊塞詩的經典之作，首句情景交融，粗略地描寫邊疆景色，帶給人們一種孤寂與蒼涼。
詩裡流露了對久戍戰士的同情，面對胡人經常進犯，邊關經常戰事未斷，百姓亦難得安寧。
從前有李廣、衛青等驍勇善戰的將軍保家衛國，不使家國受到侵犯，多麼希望現世也能有這樣的將帥奮力抵禦外敵。</media:description>
   <media:community>
    <media:starRating count="5" average="5.00" min="1" max="5"/>
    <media:statistics views="288"/>
   </media:community>
  </media:group>
 </entry>
<entry>
  <id>yt:video:y4l9-5r7EgE</id>
  <yt:videoId>y4l9-5r7EgE</yt:videoId>
  <yt:channelId>UCiCJBnqbS3ECSPEM7vSmrPw</yt:channelId>
  <title>🌕 杜甫〈月夜〉「今夜鄜州月，閨中只獨看。」詩人戰亂中思念家人，月下情思更濃。中華文化總是對「月」有離不開的情思，你是否也曾在夜裡對月思念遠方的人？ 🦊 #杜甫 #月夜 #思念 #唐詩 #戰亂</title>
  <link rel="alternate" href="https://www.youtube.com/shorts/y4l9-5r7EgE"/>
  <author>
   <name>狐說八道</name>
   <uri>https://www.youtube.com/channel/UCiCJBnqbS3ECSPEM7vSmrPw</uri>
  </author>
  <published>2024-10-23T15:13:47+00:00</published>
  <updated>2026-05-24T02:14:38+00:00</updated>
  <media:group>
   <media:title>🌕 杜甫〈月夜〉「今夜鄜州月，閨中只獨看。」詩人戰亂中思念家人，月下情思更濃。中華文化總是對「月」有離不開的情思，你是否也曾在夜裡對月思念遠方的人？ 🦊 #杜甫 #月夜 #思念 #唐詩 #戰亂</media:title>
   <media:content url="https://www.youtube.com/v/y4l9-5r7EgE?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i2.ytimg.com/vi/y4l9-5r7EgE/hqdefault.jpg" width="480" height="360"/>
   <media:description>杜甫的〈月夜〉是難得的一首情誼綿長之作。不言自身，而是以妻子的角度描寫，卻表達了對妻子的深切思念。
「香霧雲鬟濕，清輝玉臂寒。」刻畫得非常細緻，因為看著月亮的同時也在思念著對方，時間不知不覺流逝，夜深露重的濕氣才會濕了秀髮，雙臂也因此而冰涼。
這首詩展現了戰亂時期的離愁傷懷與對妻兒的深厚情感。</media:description>
   <media:community>
    <media:starRating count="8" average="5.00" min="1" max="5"/>
    <media:statistics views="186"/>
   </media:community>
  </media:group>
 </entry>`;

console.log('\nYouTube Atom feed 剖析（零網路）\n' + '─'.repeat(64));

// ── 1. 真實樣本，逐欄位 ───────────────────────────────
{
  const items = parseYouTubeFeed(feed(REAL_ENTRIES), source);
  check('兩則都讀到了', items.length === 2, items.length);
  const [a = /** @type {any} */ ({})] = items;
  check('id 是穩定 id（帶來源前綴）', typeof a.id === 'string' && a.id.startsWith('youtube-foxpoetry'), a.id);
  check('externalId 是 videoId', a.externalId === 'UYor3t6HnzU', a.externalId);
  /*
   * 網址是**自己組的**，不是抄 <link href>。真實那一則的 link 指向
   * `/shorts/UYor3t6HnzU`，而站上的預覽卡是照 watch?v= 這個形狀處理的。
   */
  check('網址組成 watch?v=（不是 feed 裡的 /shorts/）', a.url === 'https://www.youtube.com/watch?v=UYor3t6HnzU', a.url);
  /*
   * 真實的標題長這樣：
   *   🏹 王昌齡〈出塞〉「秦時明月漢時關⋯⋯」⋯⋯心生敬意？ 🦊 #王昌齡 #出塞 #邊塞詩 #唐詩 #戰爭 #壯志
   * `tidyTitle` 會把 emoji 與尾巴那一串 hashtag 拿掉，只留正文 ——
   * 這是它存在的理由，而在拿到真實樣本之前**沒有任何案例在真的標題上驗過**。
   */
  check('emoji 被拿掉了', !/[\u{1F300}-\u{1FAFF}]/u.test(a.title), a.title);
  check('尾巴那串 hashtag 被拿掉了', !a.title.includes('#'), a.title);
  check('正文留著', a.title.startsWith('王昌齡〈出塞〉') && a.title.endsWith('心生敬意？'), a.title);
  check('日期取 published 轉 ISO', a.publishedAt === '2024-10-26T06:23:28.000Z', a.publishedAt);
  check('摘要來自 media:description 且併成一行', a.summary.startsWith('王昌齡的') && !a.summary.includes('\n'), a.summary?.slice(0, 40));
  check('縮圖只留網址', a.thumbnail === 'https://i2.ytimg.com/vi/UYor3t6HnzU/hqdefault.jpg', a.thumbnail);
  check('tags 是空陣列（YouTube 這條路不給標籤）', Array.isArray(a.tags) && a.tags.length === 0, a.tags);
}

// ── 2. 只有一則 entry ─────────────────────────────────
{
  /*
   * fast-xml-parser 在只有一個子元素時回**物件**而不是陣列。
   * `asArray` 就是為了這件事，但真實的 feed 有 9 則，所以這條路
   * 在真實資料上永遠走不到 —— 她剛開頻道發第一支片的時候才會走到。
   */
  const one = REAL_ENTRIES.slice(0, REAL_ENTRIES.indexOf('</entry>') + 8);
  const items = parseYouTubeFeed(feed(one), source);
  check('只有一則時也回陣列', Array.isArray(items) && items.length === 1, items.length);
}

// ── 3. 沒有 media:group ───────────────────────────────
{
  const bare = '<entry><id>yt:video:AAA</id><yt:videoId>AAA</yt:videoId>' +
    '<title>沒有 media 區塊的一則</title><published>2025-01-02T03:04:05+00:00</published></entry>';
  const [it = /** @type {any} */ ({})] = parseYouTubeFeed(feed(bare), source);
  check('沒有 media:group 不會爆', it.title === '沒有 media 區塊的一則', it.title);
  check('摘要是空字串而不是 undefined', it.summary === '', it.summary);
  check('縮圖是 undefined', it.thumbnail === undefined, it.thumbnail);
}

// ── 4. 沒有 yt:videoId ────────────────────────────────
{
  const noId = '<entry><id>tag:example,2025:1</id><title>沒有 videoId</title>' +
    '<link rel="alternate" href="https://www.youtube.com/watch?v=BBB&amp;utm_source=feed"/>' +
    '<published>2025-01-02T03:04:05+00:00</published></entry>';
  const [it = /** @type {any} */ ({})] = parseYouTubeFeed(feed(noId), source);
  check('沒有 videoId 時退回 link 的 href', it.url === 'https://www.youtube.com/watch?v=BBB', it.url);
  check('沒有 videoId 時 externalId 是 undefined', it.externalId === undefined, it.externalId);
  check('沒有 videoId 時 id 用 entry.id 也算得出來', typeof it.id === 'string' && it.id.length > 0, it.id);
}

// ── 5. 只有 updated，沒有 published ───────────────────
{
  const upd = '<entry><id>yt:video:CCC</id><yt:videoId>CCC</yt:videoId><title>只有 updated</title>' +
    '<updated>2025-06-07T08:09:10+00:00</updated></entry>';
  const [it = /** @type {any} */ ({})] = parseYouTubeFeed(feed(upd), source);
  check('沒有 published 時退回 updated', it.publishedAt === '2025-06-07T08:09:10.000Z', it.publishedAt);
}

// ── 6. 標題空白 ───────────────────────────────────────
{
  const blank = '<entry><id>yt:video:DDD</id><yt:videoId>DDD</yt:videoId><title>   </title>' +
    '<published>2025-01-02T03:04:05+00:00</published></entry>';
  const [it = /** @type {any} */ ({})] = parseYouTubeFeed(feed(blank), source);
  check('標題只有空白時給「(無標題)」', it.title === '(無標題)', it.title);
}

// ── 7. 一則都沒有要拋錯 ───────────────────────────────
{
  /*
   * 安靜地回空陣列的話，mergeItems 什麼都不做，而輸出會是
   * 「抓到 0 筆」看起來像同步成功。這條是那個假綠燈的擋牆。
   */
  let threw = '';
  try { parseYouTubeFeed(feed(''), source); } catch (e) { threw = /** @type {any} */ (e)?.message ?? String(e); }
  check('沒有 entry 時會拋錯', /沒有任何影片/.test(threw), threw);
}

// ── 9. 兩條路要產生同一個形狀 ────────────────────────
{
  /*
   * RSS 與 Data API 是同一件事的兩份實作，而它們的產物會進同一個
   * `mergeItems` —— 那個函式拿**整個項目的 JSON** 比對來判斷「有沒有更新」。
   * 只要有一個欄位對不齊，切換來源那天九支影片會全部被報成「更新」，
   * 而下一次 RSS 成功時又全部翻回來：一個永遠來回的假更新。
   *
   * 第 4 輪（第十四圈）逐欄位比對時真的找到一個：縮圖。
   * RSS 給的是 `hqdefault`，而 API 那邊原本 `maxres` 優先 ——
   * 而 `maxresdefault.jpg` 是真的存在的（實測 HEAD 200、68,558 bytes）。
   *
   * 這一格把「兩條路要一樣」變成會紅燈的東西。
   */
  const videoId = 'UYor3t6HnzU';
  /* 用真實的形狀：帶 emoji 與尾巴一串 hashtag —— 那正是 tidyTitle 存在的理由。
     兩條路都要過 tidyTitle，只有一邊過的話下面就會紅（突變掃描指出來的）。 */
  const title = '🏹 王昌齡〈出塞〉邊塞征戰 🦊 #王昌齡 #出塞 #唐詩';
  const description = '第一行\n第二行';
  const published = '2024-10-26T06:23:28+00:00';
  const thumb = `https://i2.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const entry =
    `<entry><id>yt:video:${videoId}</id><yt:videoId>${videoId}</yt:videoId>` +
    `<title>${title}</title><published>${published}</published>` +
    `<media:group><media:title>${title}</media:title>` +
    `<media:thumbnail url="${thumb}" width="480" height="360"/>` +
    `<media:description>${description}</media:description></media:group></entry>`;
  const [fromRss = /** @type {any} */ ({})] = parseYouTubeFeed(feed(entry), source);

  /* API 回的 `high` 就是 hqdefault —— 同一張圖 */
  const fromApi = mapYouTubeApiItem(source, {
    contentDetails: { videoId, videoPublishedAt: published },
    snippet: {
      title,
      description,
      thumbnails: {
        default: { url: `https://i.ytimg.com/vi/${videoId}/default.jpg` },
        medium: { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` },
        high: { url: thumb },
        maxres: { url: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` },
      },
    },
  });

  for (const f of ['id', 'title', 'url', 'publishedAt', 'summary', 'thumbnail', 'externalId']) {
    check(
      `同一支影片，兩條路的 ${f} 一樣`,
      JSON.stringify(fromRss[f]) === JSON.stringify(fromApi?.[f]),
      { rss: fromRss[f], api: fromApi?.[f] },
    );
  }
  check('tags 兩邊都是空陣列', JSON.stringify(fromRss.tags) === JSON.stringify(fromApi?.tags));
  check('沒有 videoId 時 API 那邊回 null（呼叫端會跳過）', mapYouTubeApiItem(source, { snippet: {} }) === null);
  check('API 的標題真的被 tidyTitle 修過（emoji 與 hashtag 都沒了）',
    !/[\u{1F300}-\u{1FAFF}]/u.test(fromApi?.title ?? '') && !String(fromApi?.title).includes('#'),
    fromApi?.title);
  /*
   * `contentDetails.videoPublishedAt` 不一定有 —— 那時候要退回
   * `snippet.publishedAt`。上面那一筆兩個都給了，所以這條路沒被走過
   * （突變掃描指出來的）。
   */
  check(
    'API 沒有 videoPublishedAt 時退回 snippet.publishedAt',
    mapYouTubeApiItem(source, {
      contentDetails: { videoId },
      snippet: { title, description, publishedAt: published, thumbnails: { high: { url: thumb } } },
    })?.publishedAt === fromRss.publishedAt,
  );
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
