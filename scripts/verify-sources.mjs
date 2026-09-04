#!/usr/bin/env node
// @ts-check
/**
 * 來源檢查 —— 實際去打每個來源的網址，回報能不能用。
 *
 *   node scripts/verify-sources.mjs            只檢查已啟用的來源
 *   node scripts/verify-sources.mjs --all      連沒啟用的一起檢查
 *   node scripts/verify-sources.mjs --patterns 檢查平台目錄裡的 feed 樣板是否還有效
 *
 * 跟 sync-feeds 的差別：這個不寫入任何東西，只診斷。
 * 新增一個平台或改了帳號名之後先跑這個，比直接跑同步再看哪裡爆掉快。
 */
import { sources as realSources } from '../src/config/sources.mjs';
import { readFile } from 'node:fs/promises';
import { PLATFORMS, getPlatform, fillTemplate } from '../src/config/platforms.data.mjs';
import { sourceFeedUrl } from './lib/source-feed-url.mjs';
import { UA_VERIFY } from './lib/http.mjs';
import { waitForHost, noteHostHit } from './lib/throttle.mjs';
import { countItems } from './lib/count-items.mjs';
import { confidenceReport } from './lib/confidence-report.mjs';

/**
 * 端點會間歇性回 404 的平臺。
 * 目前只有 YouTube —— 那是實測過的（見底下失敗訊息的註解）。
 */
const FLAKY_404 = new Set(['youtube']);

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const PATTERNS = argv.includes('--patterns');

/*
 * `--sources=<json>` 只給測試用，跟 `--dir=`／`--content=`／`--guide=` 同一個道理。
 *
 * 這一支到第 4 輪（第二十五圈）為止**一個測試都沒有** —— 它印的每一個 ✓
 * 都沒有人確認過那個判斷是對的。而它讀的來源清單是 `import` 進來的，
 * 沒有辦法在不碰真設定的情況下換掉，所以先開這個口。
 */
const sourcesArg = argv.find((a) => a.startsWith('--sources='));
/** @type {typeof realSources} */
const sources = sourcesArg
  ? JSON.parse(await readFile(sourcesArg.slice('--sources='.length), 'utf8'))
  : realSources;

const UA = UA_VERIFY;
const TIMEOUT = 15_000;

/**
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number, kind: string, ms: number,
 *   items?: number, parseErr?: string }>}
 */
async function probe(url) {
  /*
   * 這裡也要走 lib/throttle.mjs 的主機間隔。
   *
   * `--patterns` 一次會打 10 個平臺。目前它們剛好都是不同主機，所以沒有
   * 實際影響 —— 但這是「同一件事寫在兩個地方」，而這個專案在第 4 輪（第二圈）
   * 就因為那個吃過虧（verify 與 sync 對同一個來源組出不同的網址）。
   *
   * 加平臺是常態；哪天有兩個平臺共用一台主機，這裡不會有人記得回來補。
   */
  await waitForHost(url);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, */*' },
      signal: AbortSignal.timeout(TIMEOUT),
      redirect: 'follow',
    });
    const body = await res.text();
    const head = body.slice(0, 900);
    noteHostHit(url);
    const ms = Date.now() - started;

    let kind = '？';
    if (/<rss[\s>]/i.test(head)) kind = 'RSS 2.0';
    else if (/<feed[\s>][^>]*atom/i.test(head) || /<feed[\s>]/i.test(head)) kind = 'Atom';
    else if (/<rdf:RDF/i.test(head)) kind = 'RSS 1.0';
    else if (/^\s*[{[]/.test(head)) kind = 'JSON';
    else if (/<!DOCTYPE html|<html/i.test(head)) kind = 'HTML（不是 feed）';

    const ok = res.ok && !kind.startsWith('HTML') && kind !== '？';

    /*
     * ── 真的剖析一次，不要只看開頭像不像 ──────────────
     *
     * 第 4 輪（第二十一圈）量到的：這支腳本用兩條正則看開頭 900 字，
     * 「像 feed」就算過。而站上真正在同步的只有 YouTube，
     * **走的是它自己的剖析器** —— 也就是說通用的 `parseFeed`
     * 在真實資料上的主體數是 **0**：它只跑過測試 fixture。
     *
     * 那份 fixture 是我們自己寫的，而真實世界的 feed 有各種形狀。
     * 拿現成的 11 個公開 feed 真的剖析一次，兩件事一起解決：
     * 這個綠燈變成「讀得到」而不只是「開頭像」，
     * 而通用剖析器第一次有真的主體。
     */
    const parsed = ok ? countItems(body) : null;
    return { ok, status: res.status, kind, ms, items: parsed?.n, parseErr: parsed?.err };
  } catch (err) {
    noteHostHit(url);
    return { ok: false, status: 0, kind: /** @type {{ name?: string }} */ (err)?.name === 'TimeoutError' ? '逾時' : '連不上', ms: Date.now() - started };
  }
}

/**
 * 剖析出幾筆。`-1` 是剖析拋錯，`0` 是「看起來像 feed 但一筆都讀不出來」——
 * 兩種都要說出來，那正是 `sync` 到時候會踩到的東西。
 * @param {{ items?: number, parseErr?: string }} r
 */
const itemsText = (r) =>
  r.items === undefined
    ? ''
    : r.items < 0
      ? `**剖析失敗：${r.parseErr}**`
      : r.items === 0
        ? '**0 筆**'
        : `${r.items} 筆`;

/**
 * @param {boolean} ok
 * @param {string} label
 * @param {string} detail
 */
function line(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(30)} ${detail}`);
}

if (PATTERNS) {
  console.log('\n平臺 feed 樣板檢查\n' + '─'.repeat(70));
  console.log('有 probeHandle 的用真實公開帳號實測；推導不出網址的標成「查不準」。\n');

  let realFailures = 0;
  /** 哪幾個失敗了 —— 底下要判斷是不是「那個會一陣一陣回 404 的」 */
  const failedIds = [];
  /** 回了合法的 feed，但裡面一筆都沒有 —— 綠燈，卻什麼都沒證明 */
  const emptyIds = [];
  /** 這一輪真的打過的（拿真實帳號那種）—— 底下要跟 confidence 對照 */
  const probedIds = [];

  for (const p of PLATFORMS) {
    // 取成區域常數：TypeScript 對「迴圈變數的選用屬性」的窄化保不住，
    // 底下兩個 fillTemplate 呼叫都會被判成 string | undefined
    const template = p.feedTemplate;
    if (!template) {
      console.log(`  – ${p.id.padEnd(14)} 無樣板（${p.feedKind}）`);
      continue;
    }

    /*
     * 有 probeHandle 就做「真的」驗證：打一個公開的知名帳號，
     * 確認回來的是解析得動的 feed。
     *
     * 這才抓得到最難察覺的失效 ——「端點還在、也回 200，但內容不是 feed 了」。
     * 痞客邦就是這樣：/blog/rss 四個真實部落格全部回 200 HTML。
     * 用假帳號的結構檢查完全看不出這件事。
     */
    if (p.probeHandle) {
      const url = fillTemplate(template, p.probeHandle);
      const r = await probe(url);
      probedIds.push(p.id);
      line(r.ok, p.id, `${r.status} ${r.kind} ${itemsText(r)}  ${r.ms}ms  ${url}`);
      if (!r.ok) {
        realFailures++;
        failedIds.push(p.id);
      } else if (r.items === 0) {
        emptyIds.push(p.id);
      }
      continue;
    }

    // handle 是完整網域或站台位址的平台，用假值探測沒有意義（根本解析不到主機）
    if (p.handleShape === 'domain' || p.handleShape === 'instance-user') {
      console.log(`  – ${p.id.padEnd(14)} handle 是${p.handleShape === 'domain' ? '完整網域' : '站台/帳號'}，需用真實值才能檢查`);
      continue;
    }

    /*
     * confidence: 'lookup-required' 的意思就是「這個平臺的 feed 網址推導不出來」。
     * 對它做結構檢查是**問一個不可能有答案的問題** ——
     * 痞客邦對不存在的子網域也回 200 導引頁，所以打了也分不出
     * 「樣板還有效」和「樣板早就失效」。
     *
     * 之前這裡印的是 ✗，跟真的失敗長得一模一樣。第 4 輪（第二圈）就記下
     * 「這個 ✗ 跟真失敗分不出來」。紅色的記號會讓人去查一個查不出結果的東西，
     * 或者更糟 —— 讓人學會忽略紅色的記號。
     *
     * 改成不打、直接說明。這跟 check-handle.mjs 對 Threads／Instagram 的
     * 處理方式一致：**查不準就說查不準，不要給一個假的綠勾，也不要給一個
     * 沒有意義的紅叉。**
     */
    if (p.confidence === 'lookup-required') {
      console.log(
        `  ? ${p.id.padEnd(14)} 查不準 —— 這個平臺的 feed 網址推導不出來` +
          `（confidence: lookup-required）。要用的話到個人頁複製 RSS 網址，` +
          `填進 sources.mjs 的 feedUrl。`,
      );
      if (p.note) console.log(`      ${p.note.slice(0, 96)}…`);
      continue;
    }

    const url = fillTemplate(template, '__probe__');
    const r = await probe(url);
    // 沒有 probeHandle 時只證明得了「網址形狀還在」：假帳號本來就該回 404 或 400
    const structural = r.status === 404 || r.status === 400 || r.ok;
    line(structural, p.id, `${r.status} ${r.kind} ${itemsText(r)}  ${r.ms}ms  ${url}  ← 結構檢查`);
  }

  console.log('');
  if (realFailures > 0) {
    /*
     * ── 404 不等於下架 ────────────────────────────────
     *
     * 這個 repo 最貴的一課（CLAUDE.md 的「已知的坑」第三條）：
     * YouTube 的 feed 端點會**一陣一陣地**對存在的頻道回 404 ——
     * 2026-09-02 上午對所有頻道都回 404、連 Google 自家的都是，
     * 同日中午再測就恢復 200。
     *
     * 那一課寫在 `sync` 的失敗訊息裡（第 4 輪〔第十七圈〕補的），
     * **但這一支沒有** —— 而這一支正是拿公開帳號去打那個端點的地方。
     * 第 4 輪（第二十一圈）跑一次就撞到：youtube 回 404，
     * 而結尾那句話叫她「可能改版或下架，請更新 platforms.data.mjs」。
     * 照著做就會把一個好好的平臺從目錄裡改掉。
     */
    const flaky = failedIds.filter((id) => FLAKY_404.has(id));
    console.log(`${realFailures} 個平臺的 feed 樣板實測失敗 —— 可能改版或下架，請更新 platforms.data.mjs。`);
    if (flaky.length > 0) {
      console.log(
        `  但先等一下：${flaky.join('、')} 的端點**會一陣一陣地回 404**（實測同一天上午全 404、中午全 200）。`,
      );
      console.log('  不要因為這一次就斷定它下架了 —— 過幾分鐘再跑一次 `npm run verify -- --patterns`。');
    }
    console.log('');
  }

  /*
   * ── 綠燈，但什麼都沒證明 ──────────────────────────
   *
   * 第 4 輪（第二十一圈）實測 note：`note_official` 的 RSS 回 200、
   * 是合法的 RSS 2.0、**裡面一筆都沒有**（1130 bytes，連一個 <item> 都沒有）。
   * 而目錄裡對 note 寫的是 `confidence: 'verified'`、「RSS 穩定」——
   * 那個「verified」靠的就是這一次探測。
   *
   * 樣板本身沒壞（同日換一個有在發文的帳號實測，同一個樣板讀得出 7 筆），
   * 壞的是**探測用的帳號**：它證明得了「端點還在」，證明不了「讀得到東西」。
   * 這種綠燈比紅燈危險 —— 它看起來已經有人在守了。
   *
   * 不在這裡自動換帳號：拿別人的私人帳號當永久測試樣本不妥，
   * 而隨手挑一個看起來活著的，只是把同一個問題往後推。
   */
  if (emptyIds.length > 0) {
    console.log(
      `${emptyIds.length} 個平臺回了合法的 feed 但**一筆都沒有**：${emptyIds.join('、')}`,
    );
    console.log('  樣板不見得壞了 —— 更可能是 probeHandle 那個帳號本身沒在發文。');
    console.log('  這種情況下這一格的綠燈只證明「端點還在」，證明不了「讀得到東西」。\n');
  }
  /*
   * ── 目錄上的 confidence，這一輪證明了什麼 ──────────────
   *
   * `confidence: 'verified'` 是某一次有人跑完這支腳本、看到綠燈就寫上去的。
   * 從那之後沒有任何東西再確認過它 —— 而跑完看到的是 24 列，
   * 要自己記得「另一個檔案裡有個 confidence 欄位」再去對。沒有人會這樣做。
   *
   * 所以直接說出來：這一輪打了哪幾類、證明了什麼、哪一類根本沒打。
   * （第 4 輪〔第二十四圈〕記的待辦，第 4 輪〔第二十六圈〕做掉。）
   */
  const { lines, mismatches } = confidenceReport(PLATFORMS, {
    probed: probedIds,
    failed: failedIds,
    flaky: FLAKY_404,
  });
  console.log('目錄上的 confidence，這一輪對得上嗎');
  for (const l of lines) console.log(l);
  if (mismatches.length > 0) {
    console.log('');
    for (const m of mismatches) console.log(`  X ${m}`);
    console.log('  改法：確認那個平臺的樣板還在不在；真的失效了就把 confidence 改掉。');
  }
  console.log('');

  process.exit(realFailures > 0 ? 1 : 0);
}

const targets = sources.filter((s) => ALL || s.enabled);

console.log('\n來源檢查\n' + '─'.repeat(70));
if (targets.length === 0) {
  console.log('  沒有要檢查的來源。\n');
  process.exit(0);
}

let bad = 0;
/** 哪幾個來源出問題 —— 結尾要判斷是不是「那個會一陣一陣回 404 的」 */
const badIds = [];

for (const source of targets) {
  const platform = getPlatform(source.platform);
  const label = `${source.id}${source.enabled ? '' : '（未啟用）'}`;

  if (!platform) {
    line(false, label, `platforms.data.mjs 裡沒有 "${source.platform}"`);
    bad++;
    badIds.push(source.id);
    continue;
  }

  if (source.handle === 'CHANGE_ME') {
    console.log(`  – ${label.padEnd(30)} handle 還沒填`);
    continue;
  }

  if (platform.feedKind === 'manual') {
    console.log(`  – ${label.padEnd(30)} 手動登錄，沒有 feed 可檢查`);
    continue;
  }

  if (platform.feedKind === 'api') {
    const hasKey = Boolean(process.env.YOUTUBE_API_KEY?.trim());
    line(hasKey, label, hasKey ? '有 YOUTUBE_API_KEY，同步時才會實際驗證' : '缺 YOUTUBE_API_KEY，同步時會被略過');
    if (!hasKey) { bad++; badIds.push(source.id); }
    continue;
  }

  if (platform.feedKind === 'bridge') {
    const base = (process.env.RSSHUB_BASE ?? '').replace(/\/+$/, '');
    if (!base) {
      line(false, label, '缺 RSSHUB_BASE，同步時會被略過');
      bad++;
      badIds.push(source.id);
      continue;
    }
    const url = base + fillTemplate(platform.bridgeRoute, source.handle ?? '');
    const r = await probe(url);
    line(r.ok, label, `${r.status} ${r.kind} ${itemsText(r)}  ${r.ms}ms`);
    if (!r.ok) { bad++; badIds.push(source.id); }
    continue;
  }

  /*
   * ── handle 的形式對不對 ──────────────────────────────
   *
   * 第 4 輪（第二十三圈）把「從她給我一個帳號名，到站上出現那個平臺」
   * 整條走了一次，在這一步撞到：Mastodon 的 handle 填成很自然的
   * 帳號與站台之間用 @ 連起來的那種寫法，得到的是
   *
   *     ✗ probe-mastodon    0 連不上   https://Mastodon%40mastodon.social.rss
   *
   * 那個網址三個地方都不對，而訊息只說「連不上」——
   * **看不出是網路問題還是自己填錯了**。
   *
   * 資訊其實早就有：平臺目錄上寫著 `handleShape: 'instance-user'`
   * 與 `note: 'handle 填 instance/@user⋯'`。但那在另一個檔案裡，
   * 而她是在這一步才知道有問題的。所以在打網路之前先比對形式，
   * 把目錄裡那句話帶到出錯的地方。
   *
   * 判準刻意寬鬆 —— 只認**明顯錯**的那幾種，不猜對錯邊界：
   * 誤報會讓人學會忽略整道檢查（這個 repo 記過很多次）。
   */
  const shape = platform.handleShape ?? 'username';
  const handle = source.handle ?? '';
  /** @type {string | null} */
  let shapeProblem = null;
  if (handle) {
    if (shape === 'instance-user' && !handle.includes('/')) {
      shapeProblem = `這個平臺的 handle 要填「站台/＠帳號」的形式（例如 ${platform.probeHandle ?? 'mastodon.social/@fox'}）`;
    } else if (shape === 'domain' && (handle.includes('/') || handle.startsWith('@'))) {
      shapeProblem = '這個平臺的 handle 要填網域（例如 example.com），不要帶路徑或 @';
    } else if (shape === 'username' && (handle.includes('/') || handle.includes('@'))) {
      shapeProblem = '這個平臺的 handle 只要帳號名，不要帶網域、@ 或路徑';
    }
  }
  if (shapeProblem) {
    line(false, label, `handle「${handle}」的形式不對 —— ${shapeProblem}${platform.note ? `　（目錄上的說明：${platform.note}）` : ''}`);
    bad++;
    badIds.push(source.id);
    continue;
  }

  // 組網址的規則只有 lib/source-feed-url.mjs 知道 —— 這裡跟 sync-feeds 必須一致
  const url = sourceFeedUrl(source, platform);
  if (!url) {
    line(false, label, `${platform.name['zh-TW']} 需要手動填 feedUrl（到個人頁複製 RSS 網址）`);
    bad++;
    badIds.push(source.id);
    continue;
  }

  const r = await probe(url);
  line(r.ok, label, `${r.status} ${r.kind} ${itemsText(r)}  ${r.ms}ms  ${url}`);
  if (!r.ok) { bad++; badIds.push(source.id); }
}

console.log('\n' + '─'.repeat(70));
console.log(bad === 0 ? '全部正常。\n' : `${bad} 個來源有問題。\n`);

/*
 * ── 說了有問題，就要擋 ────────────────────────────────
 *
 * 第 4 輪（第二十五圈）量到的：這裡本來寫死 `process.exit(0)`。
 * 把來源的 channelId 改成一個不存在的頻道再跑一次：
 *
 *     ✗ youtube-foxpoetry   404 HTML（不是 feed）
 *     1 個來源有問題。
 *     exit 0
 *
 * 訊息說有問題、離開碼說一切正常。任何用 `&&` 串起來或看離開碼的呼叫端
 * 都會當成過。**同一個檔案的 `--patterns` 模式一直都是
 * `exit(realFailures > 0 ? 1 : 0)`** —— 兩個模式一個對一個錯。
 *
 * 這是這個 repo 第三次踩到「報了但不擋」（第二十二圈的對比、
 * 第二十四圈的效能說明數字，都是同一種）。
 */
if (bad > 0) {
  const flakyBad = badIds.filter((id) => {
    const p = getPlatform(sources.find((/** @type {any} */ s) => s.id === id)?.platform ?? '');
    return p && FLAKY_404.has(p.id);
  });
  if (flakyBad.length > 0) {
    console.log(
      `  等一下：${flakyBad.join('、')} 的端點**會一陣一陣地回 404**（實測同一天上午全 404、中午全 200）。\n` +
        '  不要因為這一次就斷定它下架了 —— 過幾分鐘再跑一次。\n',
    );
  }
}
process.exit(bad > 0 ? 1 : 0);
