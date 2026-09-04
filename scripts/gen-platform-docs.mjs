#!/usr/bin/env node
// @ts-check
/**
 * 由 platforms.data.mjs 產生 docs/PLATFORMS.md。
 *
 *   node scripts/gen-platform-docs.mjs
 *
 * 手寫這張表的話，加平台時一定會忘記同步，久了文件就變成謊言。
 * 所以文件是產生的，資料只有一份。
 */
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS } from '../src/config/platforms.data.mjs';
import { sources } from '../src/config/sources.mjs';
import { manualClaimProblems } from './lib/manual-claims.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REGION = { global: '國際', tw: '臺灣', cn: '中國', jp: '日本', us: '美國' };
const MEDIA = { article: '文章', social: '社群', video: '影音', audio: '聲音', gallery: '圖像', code: '程式' };
const KIND = {
  rss: '✅ 官方 RSS',
  hybrid: '✅ 官方 RSS（+ API 備援）',
  api: '🔑 官方 API',
  bridge: '🔀 需橋接',
  manual: '✍️ 手動',
};
const CONFIDENCE = {
  verified: '已實測',
  documented: '依文件',
  'lookup-required': '需自行查',
};
const SHAPE = {
  username: '帳號名',
  domain: '完整網域',
  'instance-user': '站台/帳號',
  'channel-id': '頻道 ID',
};

const configured = new Map(sources.map((s) => [s.platform, s]));

/** @param {import('../src/config/platforms.data.mjs').Platform} p */
function row(p) {
  const s = configured.get(p.id);
  const state = !s ? '—' : s.enabled ? '**已啟用**' : '已預留';
  return `| \`${p.id}\` | ${p.name['zh-TW']} | ${REGION[p.region]} | ${MEDIA[p.media]} | ${KIND[p.feedKind]} | ${SHAPE[p.handleShape ?? 'username']} | ${CONFIDENCE[p.confidence]} | ${state} |`;
}

/** @param {string} kind */
const byKind = (kind) => PLATFORMS.filter((p) => p.feedKind === kind);

/*
 * feed 網址的樣板。
 *
 * 刻意**不放進上面那張表**：表已經有 8 欄，而樣板是長網址，
 * 塞進去會讓整張表在任何寬度下都要橫向捲動。
 * 那張表的用途是「掃過去看有哪些平臺」，樣板是「真的要填的時候才查」——
 * 兩件事，兩個位置。
 *
 * `{handle}` 代入什麼由 handleShape 決定（YouTube 要的是 UC 開頭的頻道 ID，
 * 不是 @ 帳號名 —— 第 4 輪〔第二圈〕就是在這裡出過錯）。
 */
const templates = PLATFORMS.filter((p) => p.feedTemplate || p.bridgeRoute)
  .map((p) => {
    const url = p.feedTemplate ? `\`${p.feedTemplate}\`` : `RSSHub \`${p.bridgeRoute}\``;
    const fills = SHAPE[p.handleShape ?? 'username'];
    /*
     * confidence: 'lookup-required' 其實混了兩種完全不同的情況，
     * 用同一句警語會誤導人：
     *
     *   feedKind: 'rss'    —— 樣板**本身就不對**（痞客邦：四個真實部落格
     *                         實測全部回 HTML 不是 feed）。照著填一定失敗
     *   feedKind: 'bridge' —— 路由是對的，只是需要一個可用的 RSSHub 實例
     *                         （RSSHub_BASE）。填法沒問題，是依賴的問題
     *
     * 只列出來而不區分的話，讀這一區的人會照著填痞客邦然後查半天，
     * 或者以為 RSSHub 那些也是壞的而放棄。
     */
    const warn =
      p.confidence !== 'lookup-required'
        ? ''
        : p.feedKind === 'bridge'
          ? ' ⚠️ 需要 `RSSHUB_BASE`'
          : ' ⚠️ **樣板已失效，見下方注意事項**';
    return `| \`${p.id}\` | ${url}${warn} | ${fills} |`;
  })
  .join('\n');

const noTemplate = PLATFORMS.filter((p) => !p.feedTemplate && !p.bridgeRoute)
  .map((p) => `\`${p.id}\``)
  .join('、');

const notes = PLATFORMS.filter((p) => p.note)
  .map((p) => `### ${p.name['zh-TW']}（\`${p.id}\`）\n\n${p.note}\n\n${p.feedTemplate ? `Feed 樣板：\`${p.feedTemplate}\`\n` : ''}`)
  .join('\n');

const doc = `# 平臺對照表

> 這份文件是產生的，不要手改。
> 改 \`src/config/platforms.data.mjs\`，然後執行 \`node scripts/gen-platform-docs.mjs\`。
>
> 內容最後變動：${new Date().toISOString().slice(0, 10)}　共 ${PLATFORMS.length} 個平臺

## 取得方式一覽

| 方式 | 數量 | 意思 |
|---|---|---|
| ✅ 官方 RSS | ${byKind('rss').length} | 有公開的 feed，直接抓，最理想 |
| ✅ 官方 RSS（+ API 備援） | ${byKind('hybrid').length} | 有公開 feed，但端點會間歇性掛掉，另備一條 API |
| 🔑 官方 API | ${byKind('api').length} | 只能打官方 API，要金鑰 |
| 🔀 需橋接 | ${byKind('bridge').length} | 官方沒有 RSS，靠 RSSHub 轉，可能不穩 |
| ✍️ 手動 | ${byKind('manual').length} | 抓不到，只能在 \`src/content/external/\` 手動登錄 |

「已實測」= 用一個公開的知名帳號實際打過，確認回來的是解析得動的 feed
（那個帳號記在 \`probeHandle\`，只用於驗證，不會出現在網站上，也不會被同步）。
隨時可以用 \`npm run verify -- --patterns\` 重驗，抓平臺改版或下架。
「依文件」= 平臺文件或長期慣例，但這次沒實測。
「需自行查」= 網址含內部 ID，無法由帳號名推導，要到個人頁面複製 RSS 連結。

## 全部平臺

| id | 名稱 | 地區 | 類型 | 取得方式 | handle 填什麼 | 可信度 | 本站狀態 |
|---|---|---|---|---|---|---|---|
${PLATFORMS.map(row).join('\n')}

## 怎麼新增一個平臺

1. 在 \`src/config/platforms.data.mjs\` 加一筆
2. 在 \`src/config/sources.mjs\` 加對應的來源，填 handle，\`enabled: true\`
3. \`npm run verify\` 確認抓得到
4. \`npm run sync\` 實際抓一次
5. \`node scripts/gen-platform-docs.mjs\` 更新這份文件

## feed 網址長什麼樣

要填 \`sources.mjs\` 的時候查這裡。\`{handle}\` 要代入什麼由右欄決定 ——
**YouTube 要的是 UC 開頭的頻道 ID，不是 @ 帳號名**，填錯會 404。

兩種 ⚠️ 意思不一樣：

- **樣板已失效** —— 照著填一定失敗。要自己到個人頁找 RSS 圖示，
  把實際網址填進 \`feedUrl\`
- **需要 \`RSSHUB_BASE\`** —— 路由本身是對的，但要有一個可用的 RSSHub 實例。
  沒設這個環境變數的話同步會直接略過這些來源

| id | feed 網址樣板 | {handle} 填什麼 |
|---|---|---|
${templates}

推導不出樣板的：${noTemplate}。
這些平臺要自己到個人頁找 RSS 圖示，把實際網址填進 \`sources.mjs\` 的 \`feedUrl\`。

## 各平臺的注意事項

${notes}
## 沒有 RSS 的平臺怎麼辦

三個選項，由好到壞：

1. **手動登錄**（推薦）。在 \`src/content/external/\` 開一個檔案，
   附上一句「為什麼挑這篇」。機器搬得動標題，搬不動判斷。
2. **自架 RSSHub**。放到自己的伺服器上，設 \`RSSHUB_BASE\`。
   公用實例常常掛掉或被平臺封鎖，長期不建議依賴。
3. **只放連結**。平臺卡片會顯示，但不列出個別文章。
   Instagram 就是這樣處理的 —— 而且它的嵌入會追蹤訪客，本來就不該放。
`;

const out = resolve(ROOT, 'docs/PLATFORMS.md');

/*
 * 內容沒變就完全不動這個檔案 —— 連日期都不換。
 *
 * 這一行原本無條件寫今天的日期，所以**每跑一次產生器，檔案就變一次**。
 * 第 6 輪（第十圈）量到那件事的後果：沒有辦法用 diff 判斷這份文件
 * 是不是過期的，因為它永遠都是「有差異」。
 *
 * 而這不只是整潔問題。`check:copy` 對 `platforms.data.mjs` 裡那
 * **23 個中文字串**的覆蓋，完全是靠這份產生出來的文件 ——
 * 那些字串一個都沒有出現在 `dist/` 裡（站上只有 YouTube 一個來源），
 * 所以文件過期 = 那些字沒有人校對。
 *
 * 改成冪等之後，「跑一次產生器、git 沒有變動」就等於「文件是最新的」，
 * 那句話可以放進 CI。日期的標籤也跟著改成「內容最後變動」，
 * 因為它現在真正記錄的是那個。
 */
const stripDate = (/** @type {string} */ t) =>
  t.replace(/(^> 內容最後變動：)\d{4}-\d{2}-\d{2}/m, '$1');
const previous = await readFile(out, 'utf8').catch(() => null);
const upToDate = Boolean(previous) && stripDate(String(previous)) === stripDate(doc);

/*
 * ── 散文裡點名的「抓不到的平臺」，跟資料說的一樣嗎 ──────────
 *
 * 上面那一段守的是**產生的**那份文件。這一段守的是**手寫的**那些句子。
 * 判準與理由都在 scripts/lib/manual-claims.mjs（抽出去才測得到）。
 */
{
  /** 這幾個檔案會用散文講「哪些平臺只能手動」 */
  const proseFiles = [
    'src/content.config.ts',
    'src/config/sources.mjs',
    'src/lib/syndication.ts',
    'src/content/external/EXAMPLE-threads.md',
    'docs/CONTENT.md',
    'docs/ARCHITECTURE.md',
  ];
  const files = await Promise.all(
    proseFiles.map(async (rel) => ({ rel, text: await readFile(resolve(ROOT, rel), 'utf8').catch(() => '') })),
  );
  const { claims, wrong } = manualClaimProblems(files, PLATFORMS);

  if (claims === 0) {
    console.log('· 沒有找到「抓不到的平臺是哪幾個」這種句子 —— 這一段沒有東西可查。');
  } else if (wrong.length > 0) {
    console.log(`\nX 散文裡點名的「抓不到的平臺」跟資料對不上（${claims} 句裡有 ${wrong.length} 處）：`);
    for (const w of wrong) {
      console.log(`    ${w.rel}：點名「${w.alias}」，但資料說它是 ${w.kind}`);
      console.log(`      ${w.line}`);
    }
    const manual = PLATFORMS.filter((p) => p.feedKind === 'manual').map((p) => p.name['zh-TW']);
    console.log(`    真正只能手動登錄的是：${manual.join('、')}`);
    console.log('    改法：把句子裡的名字改成上面這幾個（或不點名，只說「見 docs/PLATFORMS.md」）。');
    process.exitCode = 1;
  } else {
    console.log(`✓ 散文裡點名的「抓不到的平臺」都真的是 manual（${claims} 句）`);
  }
}

/*
 * `--check` 只比對、不寫檔，給 CI 用。
 *
 * 為什麼不是在 CI 裡跑產生器再看 `git diff`：那也可以，但這樣不依賴 git，
 * 本機有沒有未提交的改動都不影響結果，而且用的是**同一份產生邏輯** ——
 * 沒有第二份實作可以跟本體走鐘。
 */
if (process.argv.includes('--check')) {
  if (upToDate) {
    console.log(`✓ docs/PLATFORMS.md 是最新的（${PLATFORMS.length} 個平臺）`);
  } else {
    console.log('X docs/PLATFORMS.md 跟 platforms.data.mjs 對不上了。');
    console.log('  跑 `node scripts/gen-platform-docs.mjs` 重新產生。');
    console.log('  這件事會影響的不只是文件：`platforms.data.mjs` 裡那 23 個中文字串');
    console.log('  一個都沒有出現在 dist/ 裡，check:copy 是靠這份文件才校對到它們的。');
    process.exit(1);
  }
} else if (upToDate) {
  console.log(`· docs/PLATFORMS.md 內容沒有變動，保持原樣（${PLATFORMS.length} 個平臺）`);
} else {
  await writeFile(out, doc, 'utf8');
  console.log(`✓ docs/PLATFORMS.md（${PLATFORMS.length} 個平臺）`);
}
