#!/usr/bin/env node
// @ts-check
/**
 * 帳號名比對 —— 拿一個已知的帳號名，看它在哪些平臺上開得起來。
 *
 *   node scripts/check-handle.mjs foxpoetry
 *   node scripts/check-handle.mjs foxpoetry bellafoxy        # 一次比幾個
 *   node scripts/check-handle.mjs foxpoetry --region=tw,jp   # 只看特定地區
 *
 * 用途：問到帳號名之後，不用一個一個平臺手動開來看。
 *
 * 這個工具最有用的輸出不是「有／沒有」，是**頁面標題**。
 * 同名的人很多，標題通常一眼就能判斷是不是她 ——
 * 例如 FoxPoetry.blogspot.com 是存在的，但標題叫「Walt & Emily」，
 * 那顯然是別人的英文詩部落格。
 *
 * 有些平臺天生查不準，腳本會直接說明原因而不是給一個假的綠勾：
 *   - Threads / Instagram / X：一律導去登入頁，看不到內容
 *   - Bluesky：前端是 SPA，任何網址都回 200 —— 改打官方的 handle 解析 API
 *   - 痞客邦 / 自架站：不存在的名字也回 200 導引頁
 */
import { PLATFORMS, fillTemplate } from '../src/config/platforms.data.mjs';
import { sourceFeedUrl } from './lib/source-feed-url.mjs';
import { handleTargets } from './lib/handle-targets.mjs';
import { pageParts, decodeEntities } from './lib/page-title.mjs';
import { UA_BROWSER } from './lib/http.mjs';

const argv = process.argv.slice(2);
const handles = argv.filter((a) => !a.startsWith('--'));
const regionArg = argv.find((a) => a.startsWith('--region='))?.slice('--region='.length);
const regions = regionArg ? new Set(regionArg.split(',')) : null;

if (handles.length === 0) {
  /*
   * 用法要寫**站主真的會打的那一行**。
   *
   * 第 4 輪（第十七圈）量到：這裡寫的是 `node scripts/check-handle.mjs ⋯`，
   * 而 CLAUDE.md 教的、她會打的是 `npm run handle ⋯`。
   * 照著錯的抄不會壞，但那是多餘的一步 —— 而且加選項時 npm 需要 `--`，
   * 那件事不寫出來的話她會踩到。
   */
  console.error(
    '\n用法：npm run handle <帳號名> [更多帳號名…]\n' +
      '  要加選項的話，npm 需要一個 --：\n' +
      '      npm run handle -- <帳號名> --region=tw,cn,jp,us,global\n',
  );
  process.exit(1);
}

const UA = UA_BROWSER;
const TIMEOUT = 12_000;

/** 導到這些路徑代表「被擋在登入牆外」，查不出東西 */
const LOGIN_WALL = /\/(login|accounts\/login|signin|sign_in)\b/i;

/** 頁面內文出現這些字，代表帳號不存在（有些平臺照樣回 200） */
const NOT_FOUND_MARKERS = [
  /blog not found/i,
  /page not found/i,
  /user not found/i,
  /找不到.{0,6}(頁面|使用者|用戶|作者)/,
  /此(帳號|用戶|使用者)不存在/,
  /该用户不存在/,
  /このページはありません/,
  /doesn['’]t exist/i,
  /no longer available/i,
];

/** 對任何名字都回 200 的平臺 —— 結果不可信 */
const ALWAYS_200 = new Set(['pixnet']);

/**
 * 平臺對「不存在的帳號」回傳的通用頁長什麼樣。
 * 光靠「標題等於平臺名」判斷不夠 —— 少數派的標題是簡體的「少数派」，
 * 平臺目錄裡記的是繁體，字串比不出來。所以這裡明列。
 */
/** @type {Record<string, RegExp>} */
const GENERIC_TITLES = {
  sspai: /^少数派/,
  medium: /^medium$/i,
  threads: /^threads/i,
  instagram: /^instagram/i,
  xiaohongshu: /^(小红书|小紅書)/,
  zhihu: /^(知乎|发现)/,
  douban: /^豆瓣$/,
  matters: /^matters/i,
  vocus: /^(方格子|vocus)/i,
};

/*
 * `body` 只留開頭 —— 底下的「找不到」字樣是拿整頁掃的，而 SPA 的
 * JS 內容裡到處都有 `page not found` 這種字串，掃全文會把在的帳號報成不在。
 *
 * 但**標題要從全文找**。第 4 輪（第二十四圈）量過 `<title>` 落在第幾個字元：
 *
 *     blogger 264　sspai 1082　x 1111　medium 3063　github 17197　youtube 755061
 *
 * 差 2800 倍。原本兩件事共用同一份切過的字串，於是 YouTube 的標題
 * （「狐說八道 - YouTube」）永遠找不到，結果印成「看不出帳號在不在」——
 * 頁面上明明就寫著。切給誰看要分開決定。
 */
/**
 * @param {string} url
 * @param {string} [accept]
 */
async function get(url, accept = 'text/html,*/*') {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
    });
    const { head, title } = pageParts(await res.text());
    return { status: res.status, body: head, title, finalUrl: res.url };
  } catch (err) {
    return { status: 0, body: '', title: '', finalUrl: url, error: /** @type {{ name?: string }} */ (err)?.name === 'TimeoutError' ? '逾時' : '連不上' };
  }
}

/**
 * 標題只是平臺自己的名字（例如 Medium 對不存在的帳號回一個通用頁，
 * 標題就叫 "Medium"），那等於什麼都沒查到。
 */
/**
 * @param {string} title
 * @param {{ id: string, name: Record<string, string> }} platform
 */
function isGenericTitle(title, platform) {
  if (!title) return true;
  const rule = GENERIC_TITLES[platform.id];
  if (rule && rule.test(title)) return true;
  const t = title.toLowerCase().replace(/\s+/g, '');
  const names = [platform.name['zh-TW'], platform.name.en, platform.id].map((n) =>
    String(n).toLowerCase().replace(/\s+/g, ''),
  );
  // 標題就是平臺名，或平臺名加一句標語（少數派的「少数派-高效工作，品质生活」）
  return names.some((n) => n && (t === n || t.startsWith(n + '-') || t.startsWith(n + '·')));
}

/** @param {string} body */
function looksLikeFeed(body) {
  return /<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(body);
}

/** 從 feed 取頻道／部落格名稱 —— 比網頁 <title> 更能說明「這是誰的」 */
/** @param {string} body */
function feedTitle(body) {
  const m = body.match(/<title[^>]*>(?:<!\[CDATA\[)?([^<\]]{0,140})/i);
  return m ? decodeEntities(m[1]) : '';
}

/**
 * 每個平臺回傳 { state, detail }。
 *   state: 'hit' 有東西 ／ 'miss' 沒有 ／ 'unknown' 查不準
 *
 * 順序很重要：**有 feed 的平臺先打 feed**。
 * 個人頁對不存在的帳號常常回 200 加一個通用頁（Medium、少數派都是這樣），
 * 但 feed 端點通常老實回 404。所以 feed 是準確得多的存在性檢查，
 * 而且順便拿得到部落格名稱。
 */
/**
 * @param {import('../src/config/platforms.data.mjs').Platform} platform
 * @param {string} handle
 */
async function check(platform, handle) {
  // homeTemplate 是選用的；沒有的話用平臺 id 當佔位，讓後面的流程照常走
  const url = fillTemplate(platform.homeTemplate ?? '', handle) || `（${platform.id} 沒有 homeTemplate）`;

  // Bluesky 的網頁是 SPA，任何路徑都回 200。改用官方的 handle 解析 API。
  if (platform.id === 'bluesky') {
    const api = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
    const r = await get(api, 'application/json');
    if (r.error) return { url, state: 'unknown', detail: r.error };
    if (r.status === 200 && r.body.includes('did:')) return { url, state: 'hit', detail: 'DID 解析成功' };
    return {
      url,
      state: 'miss',
      detail: handle.includes('.') ? '沒有這個 handle' : 'handle 要帶網域，例如 name.bsky.social',
    };
  }

  /*
   * 有 feed 樣板的先打 feed。
   *
   * 網址走 `sourceFeedUrl()` 而不是自己套樣板 —— 那支才知道 `handleShape`
   * 的意思。YouTube 是 channel-id，手上只有顯示用的帳號名時它回空字串，
   * 於是這裡直接跳過 feed 去看個人頁；自己套樣板的話會組出
   * `?channel_id=FoxPoetry`，回 404，被讀成「沒有這個帳號」。
   */
  const feedUrl = platform.confidence === 'lookup-required' ? '' : sourceFeedUrl({ handle }, platform);
  if (feedUrl) {
    const r = await get(feedUrl, 'application/rss+xml, application/atom+xml, application/xml, */*');
    if (!r.error) {
      if (r.status === 404 || r.status === 410) return { url, state: 'miss', detail: '沒有這個帳號（feed 回 404）' };
      if (r.status === 200 && looksLikeFeed(r.body)) {
        return { url: feedUrl, state: 'hit', detail: feedTitle(r.body) || '有 feed' };
      }
      if (r.status === 200 && ALWAYS_200.has(platform.id)) {
        return { url, state: 'unknown', detail: '這個平臺對任何名字都回 200' };
      }
    }
    // feed 打不通就退回去看個人頁
  }

  const r = await get(url);

  if (r.error) return { url, state: 'unknown', detail: r.error ?? '連不上' };
  if (LOGIN_WALL.test(r.finalUrl)) return { url, state: 'unknown', detail: '被導到登入頁，看不到' };
  if (r.status === 404 || r.status === 410) return { url, state: 'miss', detail: '沒有這個帳號' };
  if (r.status >= 400) return { url, state: 'miss', detail: `HTTP ${r.status}（可能是被擋，不是不存在）` };
  if (NOT_FOUND_MARKERS.some((re) => re.test(r.body))) return { url, state: 'miss', detail: '頁面說找不到' };
  if (ALWAYS_200.has(platform.id)) return { url, state: 'unknown', detail: '這個平臺對任何名字都回 200' };

  const title = r.title;
  if (isGenericTitle(title, platform)) {
    return { url, state: 'unknown', detail: '只拿到平臺通用頁，看不出帳號在不在' };
  }
  return { url, state: 'hit', detail: title };
}

const targets = handleTargets(PLATFORMS, regions ?? null);

/** @type {Record<string, string>} */
const MARK = { hit: '✓', miss: ' ', unknown: '?' };

console.log(`\n比對 ${handles.length} 個帳號名 × ${targets.length} 個平臺`);
console.log('─'.repeat(88));

for (const handle of handles) {
  console.log(`\n▸ ${handle}`);
  /** @type {{ platform: import('../src/config/platforms.data.mjs').Platform, url: string, title: string }[]} */
  const hits = [];

  // 同時打，但一次只放 5 個，不要把人家的伺服器當靶場
  for (let i = 0; i < targets.length; i += 5) {
    const batch = targets.slice(i, i + 5);
    const results = await Promise.all(batch.map((p) => check(p, handle)));
    batch.forEach((p, j) => {
      const r = results[j];
      console.log(`  ${MARK[r.state]} ${(p.name['zh-TW'] ?? p.id).padEnd(14)} ${r.detail.slice(0, 44).padEnd(46)} ${r.url}`);
      if (r.state === 'hit') hits.push({ platform: p, url: r.url, title: r.detail ?? '' });
    });
  }

  if (hits.length === 0) {
    console.log('\n  沒有明確的命中。');
    continue;
  }

  console.log(`\n  ${hits.length} 個有東西。看標題判斷是不是她，確認之後貼進 src/config/sources.mjs：\n`);
  for (const { platform, url, title } of hits) {
    console.log(`    // ${platform.name['zh-TW']}：${title}`);
    console.log(`    {`);
    console.log(`      id: '${platform.id}-main',`);
    console.log(`      platform: '${platform.id}',`);
    console.log(`      enabled: true,`);
    console.log(`      handle: '${handle}',`);
    console.log(`      lang: 'zh-TW',`);
    console.log(`      limit: 20,`);
    /*
     * channel-id 的平臺光有 handle 抓不到東西 —— feed 端點吃的是 UC 開頭的
     * 頻道 ID，而這支腳本查的是個人頁，手上只有顯示用的帳號名。
     * 不寫這一行的話，貼進去之後 sourceFeedUrl() 回空字串，
     * 同步**安靜地什麼都不做**，而畫面上沒有任何地方會說為什麼。
     */
    if (platform.handleShape === 'channel-id') {
      console.log(`      channelId: '', // ← 必填。到 ${url} 看原始碼搜 "channelId"，或用 YouTube 的頻道網址（/channel/UC…）`);
    }
    if (platform.confidence === 'lookup-required') {
      console.log(`      feedUrl: '', // ← 到 ${url} 點 RSS 圖示複製網址`);
    }
    if (platform.feedKind === 'manual' || platform.feedKind === 'bridge') {
      console.log(`      // 注意：這個平臺${platform.feedKind === 'manual' ? '沒有 feed，只會顯示連結' : '需要 RSSHUB_BASE 才抓得到'}`);
    }
    console.log(`    },`);
  }
}

console.log('\n' + '─'.repeat(88));
console.log('「有東西」只代表網址開得起來。同名的人很多 —— 請看標題，並且跟本人確認過再填。\n');
