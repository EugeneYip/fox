#!/usr/bin/env node
// @ts-check
/**
 * `npm run verify` 的實測 —— `npm run test:verify-sources`
 *
 * ## 為什麼到現在才有
 *
 * 「`verify-sources.mjs` 沒有任何測試」這條待辦掛了很多圈。
 * 卡住的地方是它**打真的網路**，而且來源清單是 `import` 進來的 ——
 * 不碰真設定就換不掉。
 *
 * 第 4 輪（第二十五圈）問「這一格綠燈，有沒有可能是它根本沒有跑」，
 * 而一支從來沒有測試的檢查腳本，它印的每一個 ✓ 都正是那個問題的極端形式：
 * **沒有人確認過那個判斷是對的。**
 *
 * 做法：`--sources=` 換成假的來源清單（跟 `--dir=`／`--content=`／`--guide=`
 * 同一個道理），`feedUrl` 指到**本機起的一台 HTTP 伺服器**。
 * 零外部網路、不碰真設定。
 *
 * ## 第一次跑就抓到的
 *
 * 結尾寫死 `process.exit(0)` —— 印著「1 個來源有問題」而離開碼是 0。
 * 同一個檔案的 `--patterns` 模式一直都是 `exit(realFailures > 0 ? 1 : 0)`。
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (/** @type {string} */ label, /** @type {boolean} */ ok, /** @type {unknown} */ got) => {
  console.log(`  ${ok ? '✓' : 'X'} ${label}`);
  if (!ok) {
    failed++;
    if (got !== undefined) console.log('      實際：', String(got));
  }
};

/** 一份最小但合法的 RSS 2.0 */
const FEED =
  '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>' +
  '<title>假的</title><link>http://127.0.0.1/</link><description>x</description>' +
  '<item><title>一篇</title><link>http://127.0.0.1/a</link></item>' +
  '</channel></rss>';

/*
 * 本機伺服器：`/ok` 回 feed、`/gone` 回 404。
 * 零外部請求 —— 這個專案的硬性限制是站上的產出，不是開發工具，
 * 但測試打真的平臺會讓結果取決於別人的伺服器，那就不是測試了。
 */
const server = createServer((req, res) => {
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(FEED);
    return;
  }
  if (req.url === '/empty') {
    /* 合法的 RSS 2.0，**一個 <item> 都沒有** —— 綠燈卻什麼都沒證明 */
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(
      '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>' +
        '<title>空的</title><link>http://127.0.0.1/</link><description>x</description>' +
        '</channel></rss>',
    );
    return;
  }
  if (req.url === '/boom') {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<html><body>伺服器出錯</body></html>');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<html><body>沒有這個東西</body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
const addr = /** @type {{ port: number }} */ (server.address());
const base = `http://127.0.0.1:${addr.port}`;

const tmp = await mkdtemp(join(tmpdir(), 'verify-src-'));

/** @param {any[]} sources @param {string} [scriptPath] 預設是版控裡那一份；只有副本那一格會傳別的 */
async function verify(sources, scriptPath = resolve(ROOT, 'scripts/verify-sources.mjs')) {
  const file = join(tmp, `s-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(sources), 'utf8');
  try {
    const { stdout } = await run('node', [scriptPath, `--sources=${file}`]);
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1 };
  }
}

console.log('\nnpm run verify 的判斷\n' + '─'.repeat(56));

/* 1. 抓得到就是綠的，而且離開碼 0 */
{
  const { out, code } = await verify([
    { id: 'good', platform: 'medium', enabled: true, feedUrl: `${base}/ok` },
  ]);
  check('feed 讀得到：✓ 而且 exit 0', /✓ good/.test(out) && /全部正常/.test(out) && code === 0, `${out}（exit ${code}）`);
}

/*
 * 2. 這一圈找到的那個：說了有問題就要擋。
 *    本來寫死 exit 0 —— 訊息說有問題、離開碼說一切正常。
 */
{
  const { out, code } = await verify([
    { id: 'gone', platform: 'medium', enabled: true, feedUrl: `${base}/gone` },
  ]);
  check(
    'feed 回 404：✗ 而且 exit 1（不是只印不擋）',
    /✗ gone/.test(out) && /1 個來源有問題/.test(out) && code === 1,
    `${out}（exit ${code}）`,
  );
}

/* 3. 沒啟用的預設不看；--all 才看 —— 這裡只驗預設那一半 */
{
  const { out, code } = await verify([
    { id: 'off', platform: 'medium', enabled: false, feedUrl: `${base}/gone` },
  ]);
  check('沒啟用的來源不檢查（而且不會因此變紅）', /沒有要檢查的來源/.test(out) && code === 0, `${out}（exit ${code}）`);
}

/*
 * 4. 一個來源都沒有：說「沒有要檢查的來源」，exit 0。
 *
 * 這一項**不改成擋下來**，跟第 1、3 輪的 a11y／內容不同：
 * 零來源是這個專案**現在就成立的事實**（除了 YouTube 其他帳號都還不知道），
 * 不是「路徑指錯」。擋下來會把一個正常狀態報成故障。
 */
{
  const { out, code } = await verify([]);
  check('一個來源都沒有：說出來，但不擋', /沒有要檢查的來源/.test(out) && code === 0, `${out}（exit ${code}）`);
}

/*
 * 5. handle 形式不對，在打網路之前就擋下來。
 *    第 4 輪（第二十三圈）加的那條 —— 這是它第一次有測試。
 *
 *    handle 用不帶斜線的裸名字（`instance-user` 要的是「站台/＠帳號」）。
 *    第一版填的是「帳號＠站台網域」那種寫法 —— 更接近真實的誤填，
 *    但那個形狀就是一個 email，`audit:privacy` 的 `email` 規則當場對這個
 *    檔案響了（第 5 輪〔第二十五圈〕發現的）。**測試的語料也在稽核的掃描
 *    範圍裡。**
 *
 *    而我第一次修的時候，把那個字串**寫進了這段註解**，於是規則改對著
 *    註解響 —— 這個 repo 第九次踩到「解釋一條規則，就會需要寫出它禁止的
 *    東西」，而且是在寫第八次的紀錄時踩的。所以這裡只描述形狀，不寫出來。
 */
{
  const { out, code } = await verify([
    { id: 'shape', platform: 'mastodon', enabled: true, handle: 'Mastodon' },
  ]);
  check(
    'handle 形式不對：指出形式，不是丟一句「連不上」',
    /✗ shape/.test(out) && /形式不對/.test(out) && code === 1,
    `${out}（exit ${code}）`,
  );
}

/*
 * 6. 那個「會一陣一陣壞掉」的平臺失敗時，要附上那句話。
 *
 * 沒有它的話，YouTube 偶發的失敗會被讀成「頻道下架了」——
 * 這個 repo 第一次就是這樣搞錯的，`--patterns` 模式早就有這句，
 * 一般模式沒有。
 *
 * ── 措辭本來只講 404，而那比實際行為窄 ──────────
 *
 * 判斷的邏輯看的是**來源 id** 不是狀態碼，所以 500 也會印那段提醒 ——
 * 但訊息只講 404。第 4 輪（第二十九圈）連打三次拿到 **404、404、500**
 * （一分鐘之內）。第一次跑的人看到 500、讀到一段只講 404 的說明，
 * 會合理地以為那段不適用，然後照結尾那句去改 `platforms.data.mjs`，
 * 把一個好好的平臺從目錄裡改掉。
 *
 * **邏輯對了不夠，措辭要跟得上邏輯。**
 */
{
  const { out, code } = await verify([
    { id: 'yt', platform: 'youtube', enabled: true, feedUrl: `${base}/gone` },
  ]);
  check(
    'YouTube 失敗時附上「會一陣一陣地壞掉」的提醒',
    /一陣一陣地壞掉/.test(out) && code === 1,
    `${out}（exit ${code}）`,
  );
  check(
    '而且那段提醒講的不只 404（500 也算）',
    /500 也算/.test(out),
    out.split('\n').filter((l) => l.includes('一陣一陣')).join(' | '),
  );
}

{
  /* 500 走同一條路：判斷看的是來源 id，不是狀態碼 */
  const { out, code } = await verify([
    { id: 'yt500', platform: 'youtube', enabled: true, feedUrl: `${base}/boom` },
  ]);
  check(
    'YouTube 回 500 時，同一段提醒照樣出現',
    /一陣一陣地壞掉/.test(out) && code === 1,
    `${out}（exit ${code}）`,
  );
}

/* 7. 別的平臺失敗時不要附那句 —— 那句話只對 YouTube 成立 */
{
  const { out } = await verify([
    { id: 'gone2', platform: 'medium', enabled: true, feedUrl: `${base}/gone` },
  ]);
  check('別的平臺失敗時不附那句（反向案例）', !/一陣一陣地回 404/.test(out), out);
}

/*
 * ── `--patterns` 那條路 ──────────────────────────────
 *
 * 第 4 輪（第三十二圈）量到：這條路**一個測試都沒有** ——
 * 它在這個檔案裡只被註解提到過兩次。而輪替檢查每一圈都在跑它，
 * 它印的每一句從來沒有人確認過那個判斷是對的。
 *
 * 卡住的地方跟 `--sources=` 當年一樣：平臺目錄是 import 進來的。
 * 這一輪替它開了 `--platforms=`。
 */
console.log('\nnpm run verify -- --patterns 的判斷\n' + '─'.repeat(56));

/**
 * `sources` 也給得進來：`--patterns` 那條路現在會拿啟用中的來源跟 probeHandle
 * 對一次（第 4 輪〔第五十二圈〕加的），不給的話用的是真的 sources.mjs。
 * @param {unknown[]} platforms
 * @param {unknown[]} [srcs]
 */
async function patterns(platforms, srcs) {
  const file = join(tmp, `p-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(platforms), 'utf8');
  /** @type {string[]} */
  const extra = [];
  if (srcs) {
    const sf = join(tmp, `s-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(sf, JSON.stringify(srcs), 'utf8');
    extra.push(`--sources=${sf}`);
  }
  try {
    const { stdout } = await run('node', [
      resolve(ROOT, 'scripts/verify-sources.mjs'),
      '--patterns',
      `--platforms=${file}`,
      ...extra,
    ]);
    return { out: stdout, code: 0 };
  } catch (err) {
    const e = /** @type {{ stdout?: string, code?: number }} */ (err);
    return { out: String(e?.stdout ?? ''), code: typeof e?.code === 'number' ? e.code : -1 };
  }
}

const plat = (/** @type {Record<string, unknown>} */ o) => ({
  id: 'p1', name: 'P1', region: 'x', media: 'text', feedKind: 'rss',
  homeTemplate: `${base}/{handle}`, confidence: 'verified', verifiedAt: '2026-09-05', ...o,
});

{
  const { out, code } = await patterns([plat({ feedTemplate: `${base}/ok`, probeHandle: 'h' })]);
  /*
   * 反面那一半原本寫 `!/一筆都沒有/` —— 而第 4 輪（第四十五圈）加了一行圖例，
   * 裡面本來就有那五個字，於是這一格紅了。判準要對準**那句總結**，
   * 不是對準一個在別處也會出現的詞。
   */
  check(
    'feed 有東西：✓ 而且沒有那句總結',
    /✓ p1/.test(out) && !/個平臺回了合法的 feed/.test(out) && code === 0,
    `${out}（exit ${code}）`,
  );
}

{
  /* 這一格是重點：200、合法的 feed、0 筆 —— 綠燈證明不了「讀得到東西」 */
  const { out, code } = await patterns([plat({ id: 'pe', feedTemplate: `${base}/empty`, probeHandle: 'h' })]);
  check(
    '合法的 feed 但一筆都沒有：說出來（而且不算失敗）',
    /1 個平臺回了合法的 feed 但\*\*一筆都沒有\*\*：pe/.test(out) && code === 0,
    `${out}（exit ${code}）`,
  );
  /*
   * 而且**那一列本身**不能是 ✓ —— 結尾那句話早就有了，
   * 掃過去的人看的是列。第 4 輪（第四十五圈）補的就是這件事。
   */
  check(
    '而且那一列不是 ✓（跟讀到東西的那種分得開）',
    !/✓ pe/.test(out) && /· +pe/.test(out),
    (out.split('\n').find((l) => l.includes('pe ')) ?? '（找不到那一列）').trim(),
  );
}

{
  const { out, code } = await patterns([plat({ id: 'pd', feedTemplate: `${base}/gone`, probeHandle: 'h' })]);
  check('樣板打不通：✗ 而且擋得住', /✗ pd/.test(out) && code === 1, `${out}（exit ${code}）`);
}

{
  /* pixnet 的形狀：有樣板、沒有 probeHandle —— 不該被打，也不該算成沒有樣板 */
  const { out, code } = await patterns([plat({ id: 'pn', feedTemplate: `${base}/ok`, confidence: 'lookup-required' })]);
  check(
    '有樣板但沒有 probeHandle：不打它，而且在統計裡被點名',
    !/✓ pn/.test(out) && /有樣板但沒有 probeHandle（pn）/.test(out) && code === 0,
    `${out}（exit ${code}）`,
  );
}

/*
 * ── FLAKY_ENDPOINT 裡的 id 打錯字會怎樣 ──────────────────
 *
 * 那份手寫的 Set 管的是「這個平臺的端點會一陣一陣壞掉，不要當成帳號沒了」
 * 那段提醒。id 打錯的話 `FLAKY_ENDPOINT.has(p.id)` 永遠是 false ——
 * feed 照樣間歇壞掉、腳本照樣紅燈，而那段提醒**永遠不會印**，
 * 而且不會有任何錯誤訊息。第 4 輪（第四十五圈）補的檢查守的就是這個。
 *
 * 測法跟 `test-perf-budgets` 那一格一樣：改的是**副本**不是版控裡那一份。
 * 副本放在同一個資料夾（那支腳本從自己的路徑推 ROOT），檔名帶 pid，
 * 跑完一定刪掉。傳進去的來源指到那台假伺服器 —— 萬一檢查沒有擋下來，
 * 它也只會去打 localhost，不會摸到真的網路。
 */
console.log('\nFLAKY_ENDPOINT 的 id\n' + '─'.repeat(56));
{
  const realPath = resolve(ROOT, 'scripts/verify-sources.mjs');
  const original = await readFile(realPath, 'utf8');
  const from = "new Set(['youtube'])";
  const src = [{ id: 'good', platform: 'medium', enabled: true, feedUrl: `${base}/ok` }];
  if (!original.includes(from)) {
    check('找得到 FLAKY_ENDPOINT 那一行（找不到的話底下幾格證明不了什麼）', false, from);
  } else {
    const copyPath = resolve(ROOT, `scripts/verify-sources.flaky-probe.${process.pid}.mjs`);
    /** @type {{ out: string, code: number }} */
    let r = { out: '', code: -1 };
    try {
      await writeFile(copyPath, original.replace(from, "new Set(['youtub'])"), 'utf8');
      r = await verify(src, copyPath);
    } finally {
      await rm(copyPath, { force: true });
    }
    check(
      'id 不是真的平臺 id 時說出來、而且擋得住',
      /FLAKY_ENDPOINT 裡的 youtub 不是/.test(r.out) && r.code === 1,
      `${r.out.split('\n')[0]}（exit ${r.code}）`,
    );

    /* 反向：沒改的那一份不能因為這條檢查就出聲 */
    const clean = await verify(src);
    check('沒改的時候這條檢查不出聲（反向案例）', !/FLAKY_ENDPOINT 裡的/.test(clean.out), clean.out.slice(0, 80));

    /* 跑完之後版控裡那一份必須一個字都沒變 —— 這才是「改副本」的真正保證 */
    check('跑完之後 scripts/verify-sources.mjs 沒有被動過', (await readFile(realPath, 'utf8')) === original, '被動過了');
  }
}

/*
 * ── 綠燈是誰的綠燈 ────────────────────────────────
 *
 * 第 4 輪（第五十二圈）：`CLAUDE.md` 寫著「`--patterns` 打的是公開頻道，
 * 那一格綠燈證明不了她的頻道沒事」，而**這支腳本自己不說**。
 * 那一輪跑的時候就是活的例子：這裡 `✓ youtube`，
 * 而 syndication.json 裡 `youtube-foxpoetry` 是 `error`。
 *
 * 判準不寫死平臺名，所以測試也用假的：來源的識別字串跟 probeHandle 不一樣
 * 就說出來，一樣就閉嘴。
 */
{
  const { out } = await patterns(
    [plat({ feedTemplate: `${base}/ok`, probeHandle: 'someone-else' })],
    [{ id: 's1', platform: 'p1', enabled: true, handle: 'her-own-handle' }],
  );
  check(
    'probeHandle 不是這個站的來源時說得出來',
    /這張表跟這個站的關係/.test(out) && /someone-else/.test(out) && /her-own-handle/.test(out),
    out,
  );
}

{
  const { out } = await patterns(
    [plat({ feedTemplate: `${base}/ok`, probeHandle: 'same-handle' })],
    [{ id: 's1', platform: 'p1', enabled: true, handle: 'same-handle' }],
  );
  check('打的就是這個站自己的帳號時不多嘴（反向案例）', !/這張表跟這個站的關係/.test(out), out);
}

{
  const { out } = await patterns(
    [plat({ feedTemplate: `${base}/ok`, probeHandle: 'someone-else' })],
    [{ id: 's1', platform: 'p1', enabled: false, handle: 'her-own-handle' }],
  );
  check('沒啟用的來源不算（反向案例）', !/這張表跟這個站的關係/.test(out), out);
}

/* 收尾搬到這裡 —— `--patterns` 那幾格用的是同一個假伺服器與同一個暫存目錄 */
server.close();
await rm(tmp, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通過。\n' : `\n${failed} 項失敗。\n`);
process.exit(failed === 0 ? 0 : 1);
