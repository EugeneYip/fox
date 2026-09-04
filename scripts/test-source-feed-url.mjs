#!/usr/bin/env node
// @ts-check
/**
 * feed 網址怎麼組 —— `npm run test:source-feed-url`
 *
 * ## 為什麼需要這個
 *
 * `lib/source-feed-url.mjs` 開頭那段寫著：verify 與 sync 曾經對同一個來源
 * 組出**不同的網址**，而修法是「讓它只有一個地方」。
 *
 * 第 4 輪（第二十三圈）走「加一個新平臺」那條路時，發現那個病還有第二個版本：
 * 這一支用 `encodeURIComponent`，而 `--patterns` 那條路走的
 * `fillTemplate()` **根本不編碼**。handle 裡沒有特殊字元時兩邊一樣，
 * 有的時候就分岔 —— Mastodon 的 handle 是 `站台/@帳號`，兩個字元都是結構的一部分：
 *
 *     https://mastodon.social%2F%40Mastodon.rss   ← 組出來的
 *     https://mastodon.social/@Mastodon.rss       ← 對的
 *
 * 而這個檔案在那之前**一格測試都沒有**。
 */
import { sourceFeedUrl } from './lib/source-feed-url.mjs';
import { PLATFORMS, getPlatform, fillTemplate } from '../src/config/platforms.data.mjs';

/**
 * `getPlatform` 回的是 `Platform | undefined` —— 這裡的平臺都是目錄裡有的，
 * 找不到就是目錄壞了，直接停下來比讓型別檢查一路紅有用。
 * @param {string} id
 */
const platform = (id) => {
  const p = getPlatform(id);
  if (!p) throw new Error(`平臺目錄裡沒有 ${id} —— 這個測試的前提壞了`);
  return p;
};

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [got] */
const check = (name, ok, got) => {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (got !== undefined) console.log('      實際：', String(got));
  }
};

console.log('\nfeed 網址怎麼組\n' + '─'.repeat(56));

/* instance-user：`/` 與 `@` 都要留著 */
{
  const p = platform('mastodon');
  const url = sourceFeedUrl({ handle: 'mastodon.social/@Mastodon' }, p);
  check('instance-user：斜線與 @ 不能被編碼', url === 'https://mastodon.social/@Mastodon.rss', url);
}

/*
 * 而且要跟 `--patterns` 那條路組出**一模一樣**的網址。
 * 這一格守的是那個病的根：同一件事兩條路。
 *
 * 第 4 輪（第二十四圈）把它從「一個平臺」擴成「每一個 --patterns 真的會打的
 * 平臺」。原本只有 mastodon 一格 —— 而 `--patterns` 實際上打 11 個，
 * 也就是這道防線蓋到的是它守備範圍的十一分之一。
 * 現在是照資料跑的：平臺目錄加一個有 probeHandle 的，這裡自動多守一個。
 */
{
  const probed = PLATFORMS.filter((p) => p.feedTemplate && p.probeHandle);
  const diff = probed.filter((p) => {
    const handle = /** @type {string} */ (p.probeHandle);
    return (
      fillTemplate(p.feedTemplate ?? '', handle) !==
      sourceFeedUrl({ handle, channelId: handle }, p)
    );
  });
  check(
    `兩條路組出來的網址一致（--patterns 會打的 ${probed.length} 個平臺）`,
    probed.length > 0 && diff.length === 0,
    diff.map((p) => p.id).join('、'),
  );
}

/* channel-id：用 channelId 不是 handle（第 4 輪〔第二圈〕那個 bug） */
{
  const p = platform('youtube');
  const url = sourceFeedUrl({ handle: 'FoxPoetry', channelId: 'UCabc123' }, p);
  check('channel-id：用 channelId，不是顯示用的帳號名', url.includes('UCabc123') && !url.includes('FoxPoetry'), url);
}

/* username：奇怪的字元還是要編碼（不能因為上面那個修法就全部放行） */
{
  const p = platform('substack');
  const url = sourceFeedUrl({ handle: 'a b/c' }, p);
  check('username：斜線與空白仍然要編碼', url.includes('a%20b%2Fc'), url);
}

/* 手填的 feedUrl 最優先 */
{
  const p = platform('mastodon');
  const url = sourceFeedUrl({ handle: 'x/@y', feedUrl: 'https://example.com/f.xml' }, p);
  check('手填的 feedUrl 優先', url === 'https://example.com/f.xml', url);
}

/* 沒有 handle 也沒有 feedUrl：回空字串，不要組出一個壞網址 */
{
  const p = platform('mastodon');
  check('什麼都沒有時回空字串', sourceFeedUrl({}, p) === '', sourceFeedUrl({}, p));
}

console.log('─'.repeat(56));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
