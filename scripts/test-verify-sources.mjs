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
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<html><body>沒有這個東西</body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
const addr = /** @type {{ port: number }} */ (server.address());
const base = `http://127.0.0.1:${addr.port}`;

const tmp = await mkdtemp(join(tmpdir(), 'verify-src-'));

/** @param {any[]} sources */
async function verify(sources) {
  const file = join(tmp, `s-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(file, JSON.stringify(sources), 'utf8');
  try {
    const { stdout } = await run('node', [
      resolve(ROOT, 'scripts/verify-sources.mjs'),
      `--sources=${file}`,
    ]);
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
 * 6. 那個「會一陣一陣回 404」的平臺失敗時，要附上那句話。
 *
 * 沒有它的話，YouTube 偶發的 404 會被讀成「頻道下架了」——
 * 這個 repo 第一次就是這樣搞錯的，`--patterns` 模式早就有這句，
 * 一般模式沒有。
 */
{
  const { out, code } = await verify([
    { id: 'yt', platform: 'youtube', enabled: true, feedUrl: `${base}/gone` },
  ]);
  check(
    'YouTube 失敗時附上「會一陣一陣回 404」的提醒',
    /一陣一陣地回 404/.test(out) && code === 1,
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

server.close();
await rm(tmp, { recursive: true, force: true });

console.log(failed === 0 ? '\n全部通過。\n' : `\n${failed} 項失敗。\n`);
process.exit(failed === 0 ? 0 : 1);
