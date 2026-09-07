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
import { projectDay } from './lib/project-day.mjs';
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

/*
 * ── 這五份對照表漏一個鍵，會直接寫進文件裡 ──────────────
 *
 * 第 4 輪（第四十二圈）問「這份清單是誰維護的？漏一個會怎樣？」。
 *
 * `REGION`／`MEDIA`／`KIND`／`SHAPE`／`CONFIDENCE` 是五份**人手維護的**
 * 對照表，把資料裡的英文值翻成表格裡的中文 —— 而**沒有東西在比**。
 *（幾份表各蓋住幾個鍵，跑一次這支腳本就會印出來。原本這裡寫著
 * 那五組數字，那是一個寫下來就沒有人再算的數字。）
 *
 * 實測：把某個平臺的 `region` 改成表裡沒有的值，再跑一次產生器 ——
 *
 *   gen-platform-docs   離開碼 **0**
 *   docs/PLATFORMS.md   出現一格 **`| undefined |`**
 *   check:generated     過
 *   check:copy          過
 *   check:doc-links     過
 *
 * 也就是說那個 `undefined` 會安靜地印進**人會讀的那份文件**裡。
 * 所以查不到就停下來，並且說清楚是哪個平臺、哪個欄位、哪個值。
 */
/** @type {string[]} */
const unmapped = [];

/*
 * ── 反過來那一半：表裡有鍵，而沒有任何一筆資料用它 ──────────
 *
 * 上面守的是「資料有值而表裡沒有鍵」（會印出 `undefined`）。
 * 反過來沒有人看：**表裡多一個鍵，什麼事都不會發生。**
 *
 * 第 4 輪（第四十五圈）逐條驗待辦時量到的：`KIND` 有 5 個鍵，
 * 24 個平臺只用到 4 種 —— `api` 今天什麼都沒翻譯。那不是錯
 *（`feedKind: 'api'` 是合法的值，只是還沒有平臺是那樣），
 * 但寫在註解裡的「4／5」是一個沒有人在算的數字，
 * 而這一圈才剛因為同一個形狀改過兩支腳本。
 *
 * 所以讓它每次自己算一次。用到的鍵由 `label()` 順手記 ——
 * 不另外寫一份「哪份表對到哪個欄位」的對照，那正是上面那條規則
 * 已經在守的東西，寫第二份就會分岔。
 * （寫這一段的時候第一次就分岔了：我照著表名猜欄位叫 `kind`，
 * 而資料裡是 `feedKind`，於是量出「5 個鍵一個都沒用到」。）
 */
/** @type {Map<string, { table: Record<string, string>, used: Set<string> }>} */
const tableUse = new Map();
/**
 * @param {Record<string, string>} table
 * @param {string} tableName 出問題時要說得出是哪一份表
 * @param {string} id 哪一個平臺
 * @param {string} field 哪一個欄位
 * @param {string} value
 */
const label = (table, tableName, id, field, value) => {
  let rec = tableUse.get(tableName);
  if (rec === undefined) {
    rec = { table, used: new Set() };
    tableUse.set(tableName, rec);
  }
  const hit = table[value];
  if (hit === undefined) unmapped.push(`${id} 的 ${field} 是 \`${value}\`，而 ${tableName} 裡沒有這個鍵`);
  else rec.used.add(value);
  return hit ?? `（${value}？）`;
};

/** @param {import('../src/config/platforms.data.mjs').Platform} p */
function row(p) {
  const s = configured.get(p.id);
  const state = !s ? '—' : s.enabled ? '**已啟用**' : '已預留';
  const shape = p.handleShape ?? 'username';
  return (
    `| \`${p.id}\` | ${p.name['zh-TW']} | ${label(REGION, 'REGION', p.id, 'region', p.region)} | ` +
    `${label(MEDIA, 'MEDIA', p.id, 'media', p.media)} | ${label(KIND, 'KIND', p.id, 'feedKind', p.feedKind)} | ` +
    `${label(SHAPE, 'SHAPE', p.id, 'handleShape', shape)} | ` +
    `${label(CONFIDENCE, 'CONFIDENCE', p.id, 'confidence', p.confidence)}` +
    `${p.verifiedAt ? `（${p.verifiedAt}）` : ''} | ${state} |`
  );
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
> 內容最後變動：${projectDay()}　共 ${PLATFORMS.length} 個平臺

## 取得方式一覽

| 方式 | 數量 | 意思 |
|---|---|---|
| ✅ 官方 RSS | ${byKind('rss').length} | 有公開的 feed，直接抓，最理想 |
| ✅ 官方 RSS（+ API 備援） | ${byKind('hybrid').length} | 有公開 feed，但端點會間歇性掛掉，另備一條 API |
| 🔑 官方 API | ${byKind('api').length} | 只能打官方 API，要金鑰 |
| 🔀 需橋接 | ${byKind('bridge').length} | 官方沒有 RSS，靠 RSSHub 轉，可能不穩 |
| ✍️ 手動 | ${byKind('manual').length} | 抓不到，只能在 \`src/content/external/\` 手動登錄 |

「已實測（日期）」= 用一個公開的知名帳號實際打過，確認回來的是解析得動的 feed
（那個帳號記在 \`probeHandle\`，只用於驗證，不會出現在網站上，也不會被同步）。
隨時可以用 \`npm run verify -- --patterns\` 重驗，抓平臺改版或下架。
**那個日期是人手寫的**：跑完 \`--patterns\` 過了，由跑的人把當天日期填進
\`verifiedAt\`。所以它記的是「最後一次有人回來寫」，不是「最後一次真的通過」——
那支腳本自己會說最舊的宣稱是幾天前。
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
/*
 * ── 那個「23」原本是寫死的 ──────────
 *
 * 下面失敗訊息裡寫著「那 23 個中文字串」。23 是第 6 輪（第十四圈）數出來的，
 * 而**這支腳本手上就有那份資料** —— `PLATFORMS` 走一遍就數得出來。
 *
 * 第 4 輪（第三十四圈）：這一圈問「這個答案系統裡已經有了嗎」。
 * 有，就在同一個檔案的 import 上。而寫死的那一份只會在**檢查失敗的時候**
 * 被人看到 —— 也就是最不該給錯數字的那一刻。
 *
 * （順帶：這一輪重數過，資料裡確實還是 23 個，全部出現在 docs/PLATFORMS.md、
 * 一個都沒有出現在 dist/。當年那句話今天仍然成立。）
 */
/** @param {unknown} v @param {Set<string>} out */
function collectCjk(v, out) {
  if (typeof v === 'string') {
    if (/[\u4e00-\u9fff]/.test(v)) out.add(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collectCjk(x, out);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) collectCjk(x, out);
  }
}
/** @type {Set<string>} */
const cjkStrings = new Set();
collectCjk(PLATFORMS, cjkStrings);

/*
 * ── CLAUDE.md 也抄了一份那個數字 ──────────
 *
 * 「`platforms.data.mjs` 裡有 23 個中文字串一個都沒有出現在 dist/」——
 * 那句話寫在 CLAUDE.md 的「開發流程」那一節，用來說明
 * `check:generated` 不只是文件整潔的問題。
 *
 * 它是手抄的。而正確的數字這支腳本剛剛算出來了。
 * 抓不到那句說法時**不安靜跳過** —— 說出「這一格沒有在守」
 * （第 1 輪〔第三十四圈〕在 A11Y.md 上學到的）。
 */
let claudeDrift = false;
{
  const claudeAt = new URL('../CLAUDE.md', import.meta.url);
  const text = await readFile(claudeAt, 'utf8').catch(() => '');
  const m = /裡有 (\d+) 個中文字串/.exec(text);
  if (text === '') {
    console.log('⚠ 讀不到 CLAUDE.md —— 那句「N 個中文字串」沒有跟這裡對過。');
  } else if (!m) {
    console.log('⚠ CLAUDE.md 裡找不到「裡有 N 個中文字串」這句 —— 這一格沒有在守。');
    console.log('  文件換了寫法的話，這裡的樣式要跟著改。');
    claudeDrift = true;
  } else if (Number(m[1]) !== cjkStrings.size) {
    console.log(`X CLAUDE.md 說「裡有 ${m[1]} 個中文字串」，實際是 ${cjkStrings.size} 個。`);
    console.log('  那個數字這支腳本每跑一次就算一次 —— CLAUDE.md 裡那一份是手抄的。');
    console.log('  改法：把 CLAUDE.md「開發流程」那一節的數字換成上面這個。');
    claudeDrift = true;
  }
}

/*
 * ── README 也寫了平臺數，而那份沒有人在守 ──────────────
 *
 * 第 6 輪（第四十七圈）用「多久沒碰過、前提還在嗎」量到的：`README.md`
 * 196 個 commit 沒有人碰，而它裡面有**兩處**寫死「24 個平臺」，
 * 把它改成 99 之後 `check:copy`／`check:content`／`check:perf`
 * 與這支腳本**通通不出聲**。
 *
 * 今天那個數字是對的 —— 但同一個檔案裡的**鄰居**已經錯了 196 個 commit
 *（「全站只有四小段增強腳本」，實際是五段），所以「README 的數字會爛」
 * 不是假設，是這一輪剛量到的事。
 *
 * 兩處都比，因為它們是兩份手抄。
 */
{
  const readmeAt = new URL('../README.md', import.meta.url);
  const text = await readFile(readmeAt, 'utf8').catch(() => '');
  const hits = [...text.matchAll(/(\d+) 個平臺/g)];
  if (text === '') {
    console.log('⚠ 讀不到 README.md —— 那幾句「N 個平臺」沒有跟這裡對過。');
  } else if (hits.length === 0) {
    console.log('⚠ README.md 裡找不到「N 個平臺」這句 —— 這一格沒有在守。');
    console.log('  文件換了寫法的話，這裡的樣式要跟著改。');
    claudeDrift = true;
  } else {
    const wrong = hits.filter((h) => Number(h[1]) !== PLATFORMS.length);
    if (wrong.length > 0) {
      console.log(
        `X README.md 有 ${hits.length} 處寫「N 個平臺」，其中 ${wrong.length} 處說的是 ` +
          `${[...new Set(wrong.map((h) => h[1]))].join('／')}，實際是 ${PLATFORMS.length} 個。`,
      );
      console.log('  README 是第一次來的人看到的第一個具體數字。');
      claudeDrift = true;
    } else {
      console.log(`✓ README.md 那 ${hits.length} 處「${PLATFORMS.length} 個平臺」都對得上`);
    }
  }
}

/*
 * ── 「已實測」要帶著日期出現在表上 ────────────────────
 *
 * 第 4 輪（第三十七圈）加的。這一圈問「這個宣稱是誰要求的？寫在哪份
 * 文件裡？兩邊還一致嗎？」
 *
 * 資料裡每一個 `confidence: 'verified'` 都有 `verifiedAt`
 * （`confidence-report` 有一條在守這件事），而**這份給人讀的表上一個日期都沒有**
 * —— 讀者看到「已實測」，分不出那是昨天還是半年前。
 *
 * 那個差別是真的：`verifiedAt` 是**人手寫的**，跑完 `--patterns` 由跑的人
 * 填當天日期。沒有人回來寫的話，「已實測」會一直是「已實測」。
 *
 * 這一格守的是「別在改表格樣板的時候把日期悄悄弄不見」。
 */
const verifiedCount = PLATFORMS.filter((p) => p.confidence === 'verified').length;
const datedRows = (doc.match(/已實測（\d{4}-\d{2}-\d{2}）/g) ?? []).length;
let dateDrift = false;
if (datedRows !== verifiedCount) {
  dateDrift = true;
  console.log(`X 表上帶日期的「已實測」有 ${datedRows} 列，而資料裡 verified 的平臺有 ${verifiedCount} 個。`);
  console.log('  讀者看到「已實測」卻沒有日期的話，分不出那是昨天還是半年前。');
  console.log('  改法：表格那一列要印 verifiedAt；真的有 verified 卻沒填日期的話，');
  console.log('  npm run verify -- --patterns 會點名是哪一個。');
} else if (verifiedCount > 0) {
  console.log(`✓ ${verifiedCount} 個「已實測」都帶著日期（最舊：${PLATFORMS.filter((p) => p.confidence === 'verified').map((p) => p.verifiedAt).sort()[0]}）`);
}

  /*
   * 這一段要在「--check 還是重新產生」那個分岔**之前**。
   *
   * 第一版放在寫檔那一支裡，於是 `--check`（CI 跑的那個模式）走不到它 ——
   * 它只會說「文件跟資料對不上，重新產生一次」，而真正的原因
   *（某份對照表少一個鍵）要等人真的去跑產生器才看得到。
   * 同一個形狀在這個 repo 犯到第十三次了。
   */
  /*
   * 跟底下那一段一樣，要在 `--check` 的分岔**之前** ——
   * CI 跑的是那個模式，放在寫檔那一支裡的話它一輩子看不到。
   */
  {
    const idle = [...tableUse]
      .map(([name, rec]) => [name, Object.keys(rec.table).filter((k) => !rec.used.has(k))])
      .filter(([, keys]) => keys.length > 0);
    const totals = [...tableUse]
      .map(([name, rec]) => `${name} ${rec.used.size}／${Object.keys(rec.table).length}`)
      .join('、');
    if (idle.length > 0) {
      console.log(`· 對照表的鍵有沒有人用：${totals}`);
      for (const [name, keys] of idle) {
        console.log(`    ${name} 裡的 ${/** @type {string[]} */ (keys).join('、')} 這一輪什麼都沒翻譯到。`);
      }
      console.log('  不是錯（那些是合法的值，只是還沒有平臺是那樣）——');
      console.log('  但那幾行看起來像在守什麼，其實沒有，所以每次說一次。');
    } else if (tableUse.size > 0) {
      console.log(`✓ 對照表的鍵每一個都有人用到（${totals}）`);
    }
  }

  if (unmapped.length > 0) {
    console.error('\nX 對照表少了鍵，文件會寫出 undefined：');
    for (const line of unmapped) console.error(`    · ${line}`);
    console.error('  改法：在 gen-platform-docs.mjs 的那份表裡補上這個鍵（要有中文標籤）。');
    process.exit(1);
  }

if (process.argv.includes('--check')) {
  if (claudeDrift || dateDrift) process.exit(1);
  if (upToDate) {
    console.log(`✓ docs/PLATFORMS.md 是最新的（${PLATFORMS.length} 個平臺、${cjkStrings.size} 個中文字串，CLAUDE.md 的數字也對得上）`);
  } else {
    console.log('X docs/PLATFORMS.md 跟 platforms.data.mjs 對不上了。');
    console.log('  跑 `node scripts/gen-platform-docs.mjs` 重新產生。');
    console.log(`  這件事會影響的不只是文件：\`platforms.data.mjs\` 裡那 ${cjkStrings.size} 個中文字串`);
    console.log('  一個都沒有出現在 dist/ 裡，check:copy 是靠這份文件才校對到它們的。');
    process.exit(1);
  }
} else if (upToDate) {
  console.log(`· docs/PLATFORMS.md 內容沒有變動，保持原樣（${PLATFORMS.length} 個平臺）`);
} else {
  await writeFile(out, doc, 'utf8');
  console.log(`✓ docs/PLATFORMS.md（${PLATFORMS.length} 個平臺）`);
}
