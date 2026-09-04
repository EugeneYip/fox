#!/usr/bin/env node
// @ts-check
/**
 * `npm run handle` 該問哪些平臺 —— `npm run test:handle-targets`
 *
 * 第 4 輪（第二十四圈）的實測：`npm run handle FoxPoetry` 掃了 18 個平臺，
 * **YouTube 不在裡面**。唯一已知她真的有帳號的那個平臺，這支工具沒問過。
 *
 * 那個排除規則沒有測試，所以它從第一天起就是這樣，而且看不出來 ——
 * 輸出裡不會有一行說「我跳過了 YouTube」，只會少一列。
 */
import { handleTargets } from './lib/handle-targets.mjs';
import { PLATFORMS } from '../src/config/platforms.data.mjs';
import { sourceFeedUrl } from './lib/source-feed-url.mjs';
import { pageParts, HEAD_CHARS } from './lib/page-title.mjs';

let failed = 0;
const check = (/** @type {string} */ label, /** @type {boolean} */ ok, /** @type {unknown} */ got) => {
  console.log(`  ${ok ? '✓' : 'X'} ${label}`);
  if (!ok) {
    failed++;
    if (got !== undefined) console.log('      實際：', String(got));
  }
};

console.log('\nnpm run handle 該問哪些平臺\n' + '─'.repeat(56));

const ids = handleTargets(PLATFORMS).map((p) => p.id);

check('YouTube 要問（homeTemplate 吃的就是顯示用的帳號名）', ids.includes('youtube'), ids.join('、'));

/*
 * 這三個的 homeTemplate 是 `https://{handle}` —— handle 本身就是主機名。
 * 填一個裸帳號名進去會組出 `https://FoxPoetry`，問了也沒有意義。
 */
for (const id of ['wordpress', 'ghost', 'mastodon']) {
  check(`${id} 不問（handle 本身就是主機名）`, !ids.includes(id), ids.join('、'));
}

/* 沒有 homeTemplate 的（純手動登錄的平臺）本來就問不了 */
{
  const noHome = PLATFORMS.filter((p) => !p.homeTemplate).map((p) => p.id);
  check(
    '沒有 homeTemplate 的一個都不問',
    noHome.every((id) => !ids.includes(id)),
    noHome.filter((id) => ids.includes(id)).join('、'),
  );
}

/* --region 還是要能收窄 */
{
  const tw = handleTargets(PLATFORMS, new Set(['tw'])).map((p) => p.id);
  check('regions 有給就只留那幾個地區', tw.length > 0 && tw.length < ids.length, `${tw.length} / ${ids.length}`);
}

/*
 * ── 問了之後，feed 那一側不能用顯示用的帳號名去填 ──
 *
 * 這是把 YouTube 放回名單的代價：它有 feedTemplate，而那個端點吃的是
 * UC 開頭的頻道 ID。自己套樣板會組出 `?channel_id=FoxPoetry` 然後回 404，
 * 被讀成「沒有這個帳號」—— 就是第 4 輪（第二圈）那個 bug 換一個地方再來一次。
 * `sourceFeedUrl()` 讀 handleShape，手上只有帳號名時回空字串，於是直接看個人頁。
 */
{
  const yt = PLATFORMS.find((p) => p.id === 'youtube');
  const url = sourceFeedUrl({ handle: 'FoxPoetry' }, /** @type {any} */ (yt));
  check('channel-id 平臺：只有帳號名時組不出 feed 網址（所以不會去打）', url === '', url);
}

/*
 * ── 抓回來的頁面：切給誰看要分開 ──
 *
 * 把 YouTube 放回名單之後，它走的是「個人頁」那條路，而它的 `<title>`
 * 在第 755061 個字元（實測）。掃「找不到」字樣的那份必須切短
 * （SPA 的 JS 內容裡到處都是 `page not found`），標題那份不能切。
 */
{
  const far = '<html><head>' + '<!-- ' + 'x'.repeat(HEAD_CHARS * 2) + ' -->' + '<title>狐說八道 - YouTube</title></head><body>ok</body></html>';
  const { head, title } = pageParts(far);
  check('標題在很後面也抓得到', title === '狐說八道 - YouTube', title);
  check('掃字樣用的那份有切短', head.length === HEAD_CHARS, head.length);
}

{
  /* 切短的那份是為了這個：JS 內容裡的 `page not found` 不該被當成答案 */
  const spa = '<html><head><title>某某人的頁</title></head><body>' + 'y'.repeat(HEAD_CHARS) + 'page not found</body></html>';
  const { head } = pageParts(spa);
  check('切短之後掃不到深處的「page not found」', !/page not found/i.test(head), head.slice(-40));
}

console.log(failed === 0 ? '\n全部通過。\n' : `\n${failed} 項失敗。\n`);
process.exit(failed === 0 ? 0 : 1);
