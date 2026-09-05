#!/usr/bin/env node
// @ts-check
/**
 * 文案慣例的檢查 —— `npm run check:copy`
 *
 * 掃**建置產出**與**人會讀到的文件**，不掃程式碼註解。
 *
 * ## 為什麼分這條界線
 *
 * 「平台／平臺」在第 6 輪（第一圈）修過一次，只改了使用者看得到的 5 處；
 * 第 6 輪（第三圈）又在文件與工具輸出裡找到一批。犯兩次就該交給工具擋。
 *
 * 但**沒有連程式碼註解一起管**：那是幾十處的改動、零功能價值，
 * 而且註解的讀者是在改這份程式的人，不是網站的讀者。
 * 把界線寫在這裡，下一輪就不用再重新判斷一次。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * `--root=<路徑>` 讓 scripts/test-copy-rules.mjs 指到一份假的專案，
 * 每條規則放一個剛好違反它的檔案，確認那條真的會響。
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg
  ? resolve(rootArg.slice('--root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/*
 * 只抓**特定的詞**，不是所有的「台」。
 *
 * 第一版寫成 /台/g，結果 7 個發現裡多數是誤報 —— 「後台」「站台」「舞台」
 * 裡的台本來就是對的，臺灣的用字慣例只換特定幾個詞。
 * 一條會誤報的規則比沒有規則糟：它會讓人學會忽略這個檢查。
 */
/**
 * markdown 的程式碼區塊要先拿掉再掃。
 *
 * `docs/CONTENT.md` 裡有 YAML 範例 `tags: [唐詩, 李白]` —— 那個半形逗號
 * 是**對的**（它是程式碼，不是文案）。不拿掉的話，半形標點那條規則
 * 一加上去就有 5 個誤報，而**一條會誤報的規則比沒有規則糟**
 * （第 6 輪〔第三圈〕已經為了同一件事重寫過一次）。
 *
 * 圍欄式（```）與行內（`code`）兩種都拿掉。
 *
 * @param {string} t
 */
const stripCode = (t) =>
  t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

import { RULES, documentationDuty } from './lib/copy-rules.mjs';

/**
 * 不是逐行掃語料的那幾條 —— 它們各自有自己的主體
 * （`ui.ts` 的鍵、兩份文件、`<time>` 標籤），所以不在 `RULES` 裡。
 * 抽出來是為了範圍那一行、底下的補零、以及「哪幾條要寫進文件」
 * 共用同一份清單，不會分岔。
 *
 * 宣告在這裡而不是檔案底部：第 6 輪（第三十一圈）之前它在第 707 行，
 * 而用它的那一段在第 580 行 —— 那時候還用不到它，於是那一段只看得到
 * `RULES`。同一個 repo 第 3 輪（第三十一圈）才在 `check-content.mjs`
 * 踩過「區塊排在它的消費者後面」。
 */
const EXTRA_RULE_IDS = ['unused-i18n-key', 'rule-not-documented', 'date-wrong-language'];

/**
 * 這些檔案會**引用問題本身**（歷史紀錄、以及訂下這條規則的地方），
 * 不該被自己的規則抓。
 *
 * `docs/STATE.md` **刻意不在這裡** —— 那份是給接手的人讀的正式文件，
 * 真的寫錯字必須被抓到。要描述這條規則的時候換個說法就好
 * （「臺／台的用字」而不是直接寫出被禁的那個詞）。
 *
 * 這個「解釋一條規則就會想引用它禁止的東西」的模式，在這個專案已經
 * 出現**五次**了：第 5 輪（第二圈）把本名寫進文件 7 次、第 6 輪（第二圈）
 * 抄了測試信箱、第 5 輪（第三圈）又抄一次、第 7 輪（第三圈）這一次，
 * 然後第 6 輪（第七圈）在 STATE.md 裡寫「註解裡有 30 個〔那個字〕」——
 * **就在描述這條規則的那一句裡踩到它**。
 * **描述它，不要引用它。**
 */
/*
 * 只剩歷史紀錄。
 *
 * `CLAUDE.md` 原本也在這裡，理由是「這些檔案會引用問題本身」——
 * 第 6 輪（第二十八圈）逐條量過：它整份被豁免，**只為了一行**
 * （`cjk-latin-space` 的反例）。而第 6 輪（第二十七圈）已經有解法了：
 * 反例放進程式碼區塊，掃之前就會被拿掉。
 *
 * 換個寫法之後這條豁免就不需要了 —— 一份 200 行的規矩文件，
 * 從「完全不檢查」回到「跟其他文件一樣被檢查」。
 *
 * `docs/REVIEW-LOG.md` 留著：那是歷史紀錄，裡面 6 處違規記的是當時的事實。
 */
const SKIP = new Set(['docs/REVIEW-LOG.md']);

/** @type {{ file: string, line: number, id: string, text: string, why: string }[]} */
const problems = [];

/*
 * 掃了多少東西。
 *
 * 第 6 輪（第十五圈）拿一個空的 root 跑了一次，這支腳本回報
 * 「沒有發現問題」並且 exit 0 —— 它一個字都沒看過。
 * 那正是這一圈在追的東西：**綠燈是因為對，還是因為空？**
 * `check:content` 早就有「dist 是空的，先跑 build」那道擋，這裡沒有。
 */
const scanned = { files: 0, lines: 0, cjkLines: 0 };

/** @type {Map<string, number>} */
const subjects = new Map();
/** 這條規則這次真的有東西可判斷的次數（0 也要看得見） */
const saw = (/** @type {string} */ id, /** @type {number} */ n) =>
  subjects.set(id, (subjects.get(id) ?? 0) + n);

/**
 * @param {string} rel
 * @param {string} text  已經去掉標籤的可見文字，或整份 markdown
 * @param {{ realLines?: boolean }} [o]  行號對不對得上真的檔案
 *
 * ── 為什麼要有 realLines ──────────────────────────
 *
 * 第 6 輪（第十七圈）量到：產出那一半印出來的是 `dist/⋯/index.html:10`，
 * 而那個 10 是**去掉標籤之後那份文字的第 10 行** —— 原始檔可能只有一行。
 * 站主照著開檔案、找第 10 行，那裡什麼都沒有。
 *
 * 行號對不上就不要印行號。假的精確比沒有精確更糟：
 * 它會讓人相信自己找對了地方。
 */
function scan(rel, text, { realLines = true } = {}) {
  if (SKIP.has(rel)) return;
  const lines = stripCode(text).split('\n');
  scanned.files++;
  scanned.lines += lines.length;
  /*
   * 五條語料規則裡有四條要求行上有漢字，所以「含漢字的行」才是它們的分母。
   * 拿總行數當分母會把百分比稀釋成看不出意思的小數 ——
   * 掃過的行有一大半是英文頁與標記。
   */
  for (const l of lines) if (/[一-鿿]/.test(l)) scanned.cjkLines++;
  for (const rule of RULES) {
    for (const [i, line] of lines.entries()) {
      /* 前提不成立的行，這條規則沒有東西可判斷 —— 不算進主體數 */
      if (!rule.subject.test(line)) continue;
      saw(rule.id, 1);
      rule.bad.lastIndex = 0;
      const m = rule.bad.exec(line);
      if (!m) continue;
      const at = Math.max(0, m.index - 8);
      problems.push({
        file: rel,
        line: realLines ? i + 1 : 0,
        id: rule.id,
        text: line.slice(at, m.index + 10).trim(),
        why: rule.why,
      });
    }
  }
}

// ── 建置產出的可見文字 ──────────────────────────────
/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/*
 * ── 標籤要換成空白還是換成「什麼都沒有」？ ──────────
 *
 * 原本每一個標籤都換成一個空白。那對大部分規則沒差，但對
 * `cjk-latin-space` 是致命的 —— 那條規則抓的正是「該有空白而沒有」。
 *
 * 第 6 輪（第十三圈）實測：在內文裡寫「這個站是用**Astro**建的」，
 * 產出是 `這個站是用<strong>Astro</strong>建的`，
 * 瀏覽器算繪出來的文字是「這個站是用Astro建的」（違規，量到 2 處），
 * 而 `check:copy` 說「沒有發現問題」—— 因為標籤被換成了空白。
 * 這一圈所有案例的中英交界都在**同一個文字節點裡**，所以沒有人走過這條路。
 *
 * 現在的做法：**只有純文字級的排版標籤**換成什麼都沒有，其餘換成換行。
 *
 * 為什麼 `span` 與 `a` 不算「文字級」：這個站用 span 當版面盒子
 * （`.pgrid__name` 與 `.pgrid__count` 就是相鄰的兩個 span，中間靠 flex 的
 * gap 分開）。把它們當成無間隙會製造誤報，而誤報會讓人學會忽略整道關卡。
 * 代價是「用<a>Astro</a>建的」這種寫法仍然抓不到 —— 記在待辦裡。
 *
 * 真正的判準是 CSS，靜態掃不出來（第 8 輪〔第十一圈〕就是為了這個
 * 才改用瀏覽器量算繪後的顏色）。這裡取的是「不製造誤報」那一邊。
 */
const TEXT_LEVEL = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'mark', 'small',
  'sub', 'sup', 'code', 'kbd', 'samp', 'var', 'abbr', 'cite', 'dfn',
  'q', 'ruby', 'rt', 'rp', 'rb', 'bdi', 'bdo', 'wbr', 'time', 'data',
]);

/*
 * ── 引用的原文不是這個站的文案 ──────────────────────
 *
 * 第 6 輪（第十六圈）的誤報探針：一句古典詩「樓台南望」被 `taiwan-tai`
 * 報成用了「台南」——那個地名根本不在句子裡，是兩個字剛好相鄰。
 * 「亭台中有客」同理。**這是一個詩詞網站**，這種相鄰遲早會出現。
 *
 * 更根本的是：CLAUDE.md 的約定寫得很清楚，「臺」不用「台」指的是
 * **站名與正式文案**。引用別人的詩，原文的字就是原文的字 ——
 * 標點、用字都不該被這個站的書寫慣例改寫。
 *
 * 所以掃描前先把「引用原文」那一塊整個拿掉。目前只有 `poem__original`
 * （`PoemBlock.astro` 畫原文的那個容器）。註解、標題、白話翻譯都是
 * 站主自己寫的，照樣要掃。
 *
 * 代價：原文裡真的打錯字，這支不會說話。它本來也不是校對工具。
 */
const QUOTED = ['poem__original'];

/**
 * 把 class 含 QUOTED 的元素連同內容整個拿掉。
 *
 * 用開合標籤數深度，不用非貪婪的 `[\s\S]*?</div>` ——
 * 那種寫法碰到巢狀的同名標籤會在第一個結尾就停，切在半路上。
 * （這個 repo 用正則剖析結構化資料踩過很多次了。）
 *
 * @param {string} html
 */
function stripQuoted(html) {
  let out = html;
  for (const cls of QUOTED) {
    const open = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'i');
    for (;;) {
      const m = open.exec(out);
      if (!m) break;
      const tag = m[1].toLowerCase();
      const openRe = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, 'gi');
      openRe.lastIndex = m.index;
      let depth = 0;
      let end = out.length;
      for (let t; (t = openRe.exec(out)); ) {
        depth += t[0].startsWith('</') ? -1 : 1;
        if (depth === 0) {
          end = t.index + t[0].length;
          break;
        }
      }
      out = out.slice(0, m.index) + '\n' + out.slice(end);
    }
  }
  return out;
}

/** @param {string} html */
const toVisibleText = (html) =>
  stripQuoted(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_, name) =>
      TEXT_LEVEL.has(String(name).toLowerCase()) ? '' : '\n',
    )
    /* 註解、DOCTYPE 之類剩下的角括號 */
    .replace(/<[^>]+>/g, '\n');

const DIST = resolve(ROOT, 'dist');

/** 不算問題、但必須說出口的事（說了不擋） */
/** @type {string[]} */
const notes = [];

/** 所有頁面的原始 HTML —— 底下要問「哪些介面字串從來沒進到產出」 */
let renderedHtml = '';
/** ui.ts／site.ts 裡的固定字串（不含帶佔位符的與單字元的） */
/** @type {{ rel: string, value: string }[]} */
const uiStrings = [];
/*
 * 被跳過的那些（單字、帶 `{佔位符}` 的）要數 —— 第 6 輪（第三十五圈）用第二種
 * 算法對這兩個數字時量到：那兩個檔案裡一共 236 個字串值，跳掉 45 個（19%）。
 * 「191 個裡有 35 個沒被算繪」不說分母哪來的話，會被讀成 35／236。
 */
let uiSkipped = 0;
/**
 * 每一組「帶 'zh-TW' 的文案物件」，以及它有沒有 `en`。
 *
 * 第 6 輪（第三十圈）量到的不對稱：
 *   `site.ts`  `satisfies L10n`（`Record<Locale, string>`）—— **兩種語言都是必填**
 *   `ui.ts`    `Partial<Record<Locale, string>>` —— **en 是選填**
 *
 * 兩個檔案裝的是同一種東西（畫在畫面上的字），而少掉英文的後果不一樣：
 * `site.ts` 少一個 `npm run check` 就紅；`ui.ts` 少一個**什麼都不會發生** ——
 * `pick()` 會安靜地退回中文，英文讀者看到的是中文，沒有任何一道關卡出聲。
 *
 * 那個 `Partial` 是刻意的（`CLAUDE.md`：「缺的會自動退回 zh-TW，所以不會壞，
 * 但盡量補齊英文」）。所以這裡**不擋**，只把覆蓋率說出來 ——
 * 今天是 100%，而 100% 掉下來的時候要有人看得見。
 *
 * @type {{ rel: string, path: string, hasEn: boolean }[]}
 */
const l10nPairs = [];

/*
 * ── 產出比原始檔舊的話，先說 ────────────────────────
 *
 * 這一支拿 `dist/` 跟原始檔一起掃，所以有個特有的困惑：改完 `src/` 的字
 * 沒有重新 build 就跑，產出那半**照樣報舊的違規**，而下面那段建議會叫她
 * 「拿那段字去 grep src/」—— 她會搜到自己剛改好的樣子，然後懷疑人生。
 *
 * `check:content` 早就有這道提醒（第 3 輪〔第十四圈〕加的），這一支沒有。
 * 第 6 輪（第十七圈）記進待辦，第 6 輪（第十八圈）補上。
 *
 * 兩支各有一份實作，沒有共用：`check:content` 的「原始檔」是
 * `src/content/` 的 md，這一支是整個 `src/`（字可能來自元件、i18n、設定）。
 * 而且那邊的 mtime 是在它本來就要走的那趟 walk 裡順手收的。
 * 共用會讓兩邊都多走一趟。
 */
let newestSrc = 0;
for await (const f of walk(resolve(ROOT, 'src'))) {
  newestSrc = Math.max(newestSrc, (await stat(f)).mtimeMs);
}
let newestBuilt = 0;

/*
 * ── 日期有沒有用對語言 ──────────────────────────────
 *
 * 畫在頁面上的日期不是我們寫的字，是 `Intl.DateTimeFormat` **在建置那台
 * 機器上**產生的。而它產出什麼語言，取決於那台機器的 Node 帶的是完整的 ICU
 * 還是精簡的 —— 精簡版沒有中文資料，`Intl.DateTimeFormat('zh-TW', …)`
 * 會**安靜地退回英文**：中文頁上會出現「September 2, 2026」。
 *
 * 第 6 輪（第二十二圈）量到：這台機器是 Node 22.15.1、ICU 76.1、CLDR 46，
 * 完整 ICU，所以現在是對的。而 CI 裝的是「最新的 22.x」——**不是同一個**。
 * 沒有任何一道檢查在看這件事：`check:copy` 找的是用字違規，
 * 不會問「這段字怎麼變成英文了」。
 *
 * 判準用**形狀**不用字面：中文頁的 `<time>` 要長成「N年N月N日」或「N月N日」，
 * 英文頁要長成「Month N, N」。實測 44 頁 82 個 `<time>`，
 * 兩邊各自只有那一種形狀。
 */
const ZH_DATE = /^\d{1,4}年\d{1,2}月\d{1,2}日$|^\d{1,2}月\d{1,2}日$/;
const EN_DATE = /^[A-Z][a-z]+ \d{1,2}, \d{4}$/;
let timeSeen = 0;

for await (const f of walk(DIST)) {
  if (!f.endsWith('.html')) continue;
  newestBuilt = Math.max(newestBuilt, (await stat(f)).mtimeMs);
  const html = await readFile(f, 'utf8');
  const visible = toVisibleText(html);
  /*
   * 這裡累積的是**原始 HTML**，不是可見文字。
   *
   * 第一版接的是 `visible`，量出來 84／191（44%）—— 而例子裡有
   * `Menu`、`切換深淺色`、`上下篇`，那些每一頁都在。原因是它們活在
   * `aria-label` 屬性裡，而 `toVisibleText()` 把標籤連同屬性一起剝掉了。
   * 「有沒有被算繪出來」要問的是「有沒有進到產出」，不是「看不看得見」。
   */
  renderedHtml += html + '\n';
  const rel = relative(ROOT, f);
  scan(rel, visible, { realLines: false });

  const isEn = /(^|\/)dist\/en\//.test(rel.replace(/\\/g, '/'));
  for (const m of html.matchAll(/<time[^>]*>([^<]*)<\/time>/g)) {
    const text = m[1].trim();
    if (!text) continue;
    timeSeen++;
    saw('date-wrong-language', 1);
    const good = isEn ? EN_DATE.test(text) : ZH_DATE.test(text);
    if (good) continue;
    problems.push({
      file: rel,
      line: 0,
      id: 'date-wrong-language',
      text,
      why:
        `這一頁是${isEn ? '英文' : '中文'}頁，而日期畫出來是「${text}」——` +
        `${isEn ? '應該長成「September 2, 2026」' : '應該長成「2026年9月2日」'}。` +
        '　日期是 `Intl.DateTimeFormat` 在建置那台機器上產生的：' +
        '那台機器的 Node 如果是精簡版 ICU（沒有中文資料），中文會安靜地退回英文。' +
        '　改法：先確認建置用的 Node 有完整 ICU（`node -p "process.versions.icu"` 有值），' +
        '再看 src/lib/dates.ts 的 locale 有沒有被改掉。',
    });
  }
}

// ── 人會讀的文件與 workflow 名稱 ────────────────────
for (const f of await readdir(resolve(ROOT, 'docs')).catch(() => [])) {
  if (!f.endsWith('.md')) continue;
  scan(`docs/${f}`, await readFile(resolve(ROOT, 'docs', f), 'utf8'));
}
for (const f of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
  await readFile(resolve(ROOT, f), 'utf8')
    .then((t) => scan(f, t))
    .catch(() => {});
}

/*
 * ── 內容檔 frontmatter 裡的註解 ────────────────────
 *
 * 那些 `#` 開頭的行是**寫給她看的**，而且就在她打字的地方：
 * 「如果這篇先發在別的平臺，把正本網址填在這裡」「複製這個檔案、改個檔名」。
 * 論「人會讀的文字」，它們比 docs/ 底下任何一句都更近。
 *
 * 第 3 輪（第二十八圈）量到兩處違規，其中一處在**已發佈**的文章裡，
 * 另一處在**她被告知要複製的範本**裡 —— 而 `check:copy` 說「沒有發現問題」，
 * 因為它的範圍是「產出、文件、介面字串」，YAML 註解三者皆非。
 *
 * ## 為什麼只掃註解行，不掃整個內容檔
 *
 * 量過：整包掃 `src/content/**` 是 14 處，其中 **12 處是誤報** ——
 * `tags: [唐詩, 李白]` 的半形逗號是 YAML 語法，不是文章裡的標點。
 * 只掃註解行是 2 處、0 誤報。
 *
 * 正文不需要在這裡掃：發佈之後它會進 `dist/`，那本來就在範圍裡。
 * 沒發佈的草稿正文則還在改，現在擋它沒有意義。
 *
 * 做法是把非註解行**清成空字串但保留行數**，再交給同一個 `scan()` ——
 * 行號仍然對得上真的檔案。
 */
{
  const CONTENT = resolve(ROOT, 'src/content');
  for await (const full of walk(CONTENT)) {
    if (!full.endsWith('.md')) continue;
    const rel = relative(ROOT, full).split('\\').join('/');
    const lines = (await readFile(full, 'utf8')).split('\n');
    let fences = 0;
    const onlyComments = lines.map((line) => {
      if (line.trim() === '---') {
        fences++;
        return '';
      }
      /* 只有第一段 `---` 到第二段之間、而且以 # 開頭的才算 */
      return fences === 1 && line.trimStart().startsWith('#') ? line : '';
    });
    if (onlyComments.some((l) => l !== '')) scan(rel, onlyComments.join('\n'));
  }
}
// ── 還沒被算繪出來的介面字串 ────────────────────────
/*
 * `dist/` 只涵蓋**這一次建置真的畫出來的字**。
 *
 * 第 6 輪（第六圈）數過：`ui.ts` 與 `site.ts` 合計 160 個字串，
 * **其中 36 個（22.5%）從來沒有出現在任何一頁裡** ——
 * 空狀態（「洞還是空的」）、分頁（站上還沒有任何列表超過 30 筆）、
 * 404 的英文版、VideoFacade 的字（沒有詩填 videoUrl）。
 *
 * （第 6 輪〔第十八圈〕更正一項：404 現在是雙語的，英文的正文與三個連結
 * 都畫得出來了，只剩英文標題還沒有。那個 36／22.5% 是第六圈量的，
 * 之後沒有重量過。）
 *
 * 也就是說：**出事時才會看到的那些字，正好是從來沒有人校對過的。**
 * 那次量下來 36 個一個違規都沒有，所以這裡加的是「以後也不會有」。
 *
 * 只掃字串的**值**，不掃程式碼與註解 —— 註解不在範圍內是既有的刻意決定。
 * 直接 import .ts 需要 --experimental-strip-types，旗標寫在 package.json。
 */
for (const rel of ['src/i18n/ui.ts', 'src/config/site.ts']) {
  /** @type {Record<string, unknown>} */
  let mod;
  try {
    mod = await import(pathToFileURL(resolve(ROOT, rel)).href);
  } catch {
    continue; // 測試用的假專案可能沒有這些檔案
  }
  /** @type {string[]} */
  const values = [];
  /** @param {unknown} node */
  const collect = (node) => {
    if (typeof node === 'string') values.push(node);
    else if (node && typeof node === 'object') for (const v of Object.values(node)) collect(v);
  };
  collect(mod);

  /*
   * 順便記下語言對。判準是「這個物件有 'zh-TW' 這個鍵」——
   * 不挑特定的 export 名字，所以 ui.ts 與 site.ts 用同一套。
   * `LOCALE_PATH` 之類的對照表也會被算進來，它們型別上就兩種都必填，
   * 所以只會讓分母大一點，不會蓋掉問題。
   */
  /** @param {unknown} node @param {string} path */
  const pairs = (node, path) => {
    if (!node || typeof node !== 'object') return;
    const obj = /** @type {Record<string, unknown>} */ (node);
    if (typeof obj['zh-TW'] === 'string') {
      l10nPairs.push({ rel, path, hasEn: typeof obj.en === 'string' && obj.en !== '' });
      return;
    }
    for (const [k, v] of Object.entries(obj)) pairs(v, path ? `${path}.${k}` : k);
  };
  pairs(mod, '');

  /*
   * 把每個字串放回它在原始檔裡的那一行，行號才對得上。
   *
   * 第一版直接 `values.join('\n')` 送進 scan()，結果報出來的是「拼起來之後
   * 的第幾行」—— 實測報 `ui.ts:89`，而那個字串其實在第 106 行，89 行是空的。
   * 一個點下去找不到東西的行號比沒有行號更糟。
   */
  const raw = await readFile(resolve(ROOT, rel), 'utf8');
  const srcLines = raw.split('\n');
  const placed = new Array(srcLines.length).fill('');
  for (const v of values) {
    const at = srcLines.findIndex((l) => l.includes(v));
    // 找不到的（跨行樣板字串、含跳脫字元）就補在最後，仍然掃得到
    if (at >= 0) placed[at] = placed[at] ? placed[at] + ' ' + v : v;
    else placed.push(v);
  }
  scan(rel, placed.join('\n'));

  /*
   * 順便記下來，底下要問「這些字有幾個從來沒有出現在任何一頁上」。
   *
   * 跳過兩種：帶 `{佔位符}` 的（算繪之後長得不一樣，比不到）、
   * 只有一個字的（那種一定比得到，比了也沒有意義）。
   */
  for (const v of values) {
    if (v.length > 1 && !v.includes('{')) uiStrings.push({ rel, value: v });
    else uiSkipped++;
  }
}

/*
 * ── 沒有人用的 i18n 鍵 ──────────────────────────────
 *
 * 這不是「文案寫錯」，是「文案沒有主人」—— 但它造成的傷害是文案的：
 * **一個沒有人用的字串，就是下一次借錯的來源。**
 *
 * 實際發生過：詩詞頁的「相關的詩」區塊借用了 `home.latestPoems`
 * （「最近讀的詩」），於是〈烏衣巷〉在〈靜夜思〉頁上被標成「最近讀的詩」——
 * 而那個鍵從頭到尾沒有任何區塊在用，首頁的區塊叫「最近」（`home.latest`）。
 * 第 3 輪（第七圈）修好誤用，第 6 輪（第七圈）把那個鍵刪掉並加了這條檢查。
 *
 * ## `key_one` 的例外
 *
 * `i18n/utils.ts` 在 `n === 1` 時會去找 `${key}_one`，那是**動態組出來的**，
 * 原始碼裡搜不到。第一版沒處理這件事，3 個「沒人用」裡有 2 個是誤報。
 * 主鍵有人用，`_one` 就算有人用。
 */
{
  const uiPath = resolve(ROOT, 'src/i18n/ui.ts');
  /** @type {Record<string, unknown> | undefined} */
  let uiMod;
  try {
    uiMod = /** @type {any} */ (await import(pathToFileURL(uiPath).href)).ui;
  } catch {
    uiMod = undefined;
  }
  if (uiMod) {
    let code = '';
    for await (const f of walk(resolve(ROOT, 'src'))) {
      if (!/\.(astro|ts|mjs)$/.test(f) || f === uiPath) continue;
      code += await readFile(f, 'utf8');
    }
    const used = (/** @type {string} */ k) => code.includes(`'${k}'`) || code.includes(`"${k}"`);
    /* 主體是 ui.ts 裡的每一個鍵 —— 這一項是唯一一條主體不是「行」的 */
    saw('unused-i18n-key', Object.keys(uiMod).length);
    for (const key of Object.keys(uiMod)) {
      if (used(key)) continue;
      const base = key.replace(/_one$/, '');
      if (base !== key && used(base)) continue;
      problems.push({
        file: 'src/i18n/ui.ts',
        line: (await readFile(uiPath, 'utf8')).split('\n').findIndex((l) => l.includes(`'${key}'`)) + 1,
        id: 'unused-i18n-key',
        text: key,
        why: '這個字串沒有任何地方用到。沒有主人的文案會被別的地方借去用錯 —— 用不到就刪掉。',
      });
    }
  }
}

/*
 * ── 每一條文案規則，兩份文件都要寫 ────────────
 *
 * 第 6 輪（第十四圈）量到的：`straight-quotes` 與 `halfwidth-ellipsis`
 * **只存在於這支腳本裡**，CLAUDE.md 的「語氣」一節沒有寫。
 * 也就是說照文件寫的人會在 CI 上被擋下來，而且不知道為什麼 ——
 * 同一個約定有兩個地方在管（一份給人讀、一份會擋人），
 * 而兩邊的清單不一樣。
 *
 * 這一條把「兩邊要一致」變成會紅燈的東西。判準只要求**規則 id 出現在
 * 文件裡**，不要求怎麼寫 —— 措辭是人的事，存在與否才是機器該管的。
 *
 * ## 第 6 輪（第二十七圈）：讀者搞錯了
 *
 * 那一圈問「換一個人來做，做得到嗎」，而量到的是：五條規則
 * **全部只寫在 `CLAUDE.md`**，那份的第一行是「給之後在這個 repo 上
 * 工作的 Claude」。真正在寫文案的人讀的是 `docs/CONTENT.md`
 * （「這份是寫給 Bella 的」），那裡一條都沒有 ——
 * 而且有三條規則的錯誤訊息還寫著「見 CLAUDE.md」，等於把她指回一份
 * 寫給 AI 的文件。
 *
 * 這一條檢查把「要寫下來」制度化了，而它指定的讀者是錯的。
 *
 * 改成**兩份都要有**：寫的人看得到，而且兩邊的清單不可能分岔 ——
 * 加一條新規則會同時要求兩個地方。
 *
 * `unused-i18n-key` 不在此列：它管的是 `ui.ts` 的衛生，不是寫作約定，
 * 寫進那兩節反而讓人困惑。
 */
{
  /*
   * ── 哪幾條**不是**寫作約定，以及為什麼 ──────────────
   *
   * 第 6 輪（第三十一圈）量到的：這個集合原本只有 `unused-i18n-key`，
   * 而它是拿去過濾 `RULES` 的 —— **`unused-i18n-key` 從來就不在 `RULES` 裡**
   * （它在 `EXTRA_RULE_IDS`）。也就是說那個過濾器**一條都沒濾掉**。
   *
   * 結果是對的（它確實不該被要求寫進那兩節），但**理由跟程式做的事不是同一件**：
   * 註解說「因為它是 ui.ts 的衛生」，程式其實是「因為它不在那份清單裡」。
   * 兩邊得到同一個輸出，所以沒有人會發現這件事。
   *
   * 改成作用在**全部 8 條**上，一條一句為什麼不算寫作約定 ——
   * 這樣排除就是一個決定，而不是一個副作用。
   */
  const NOT_A_WRITING_RULE = new Map([
    ['unused-i18n-key', '管的是 ui.ts 的衛生，不是寫作約定'],
    ['rule-not-documented', '它自己就是這條檢查，寫進文件會變成自我指涉'],
    ['date-wrong-language', '守的是 <time> 標籤算繪出來的語言，那是程式的事不是寫法'],
  ]);
  /** 全部 8 條，不是只有逐行掃語料的那 5 條 */
  const ALL_RULE_IDS = [...RULES.map((r) => r.id), ...EXTRA_RULE_IDS];
  /** 一份給在這裡寫程式的人（含 AI），一份給真的在寫文案的人 */
  const DOCS = ['CLAUDE.md', 'docs/CONTENT.md'];
  /** @type {Map<string, string>} */
  const docTexts = new Map();
  for (const d of DOCS) {
    const body = await readFile(resolve(ROOT, d), 'utf8').catch(() => '');
    if (body) docTexts.set(d, body);
  }
  if (docTexts.size > 0) {
    const { required: writingRules, excluded, unknown } = documentationDuty(ALL_RULE_IDS, NOT_A_WRITING_RULE);
    /* 主體是「規則 × 讀得到的文件」—— 一份都讀不到的話是 0，那也是實話 */
    saw('rule-not-documented', writingRules.length * docTexts.size);
    /*
     * ── 排除是一個決定，要說得出口 ────────────────────
     *
     * 「哪幾條規則必須寫進那兩份文件」是加規則的人第一個會撞到的問題，
     * 而在這之前它只存在於程式裡。兩個數字要**加得起來** ——
     * 5 ＋ 3 ＝ 8，不然就是有一條既沒被要求也沒被排除。
     */
    if (unknown.length > 0) {
      notes.push(
        `排除清單裡有不存在的規則：${unknown.join('、')} —— ` +
          '那會讓「要寫的 ＋ 不用寫的 ＝ 總數」看起來成立，而其實在數不存在的東西。',
      );
    }
    notes.push(
      `文件要求：${ALL_RULE_IDS.length} 條規則裡 **${writingRules.length} 條**` +
        `要同時寫進 ${[...docTexts.keys()].join(' 與 ')}；${excluded.length} 條不用 ——\n` +
        excluded.map((id) => `      · ${id}：${NOT_A_WRITING_RULE.get(id)}`).join('\n'),
    );
    for (const id of writingRules) {
      const missing = [...docTexts.entries()].filter(([, body]) => !body.includes(id)).map(([d]) => d);
      if (missing.length === 0) continue;
      problems.push({
        file: missing[0],
        line: 0,
        id: 'rule-not-documented',
        text: id,
        why:
          `\`check:copy\` 會擋這條，但 ${missing.join(' 與 ')} 沒有寫到它 —— ` +
          '照文件寫的人會被 CI 擋下來卻不知道為什麼。\n' +
          '      改法：CLAUDE.md 寫給在這裡寫程式的人（「語氣」那一節），' +
          'docs/CONTENT.md 寫給真的在寫文案的人（「用字的幾個約定」那一節）。' +
          '兩份都要有，不然清單會分岔。或者把規則拿掉。',
      });
    }
  }
}

for (const f of await readdir(resolve(ROOT, '.github/workflows')).catch(() => [])) {
  const text = await readFile(resolve(ROOT, '.github/workflows', f), 'utf8');
  /*
   * 只看 name: 那一行 —— workflow 的名字會出現在 GitHub 的介面上。
   *
   * 不是 name 的行換成空行而不是濾掉，這樣行號才對得回原始檔
   * （跟 ui.ts 那邊的 `placed` 同一個做法）。第 6 輪（第十七圈）之前
   * 這裡是 `filter().join()`，報出來的是「第幾個 name」而不是「第幾行」。
   */
  const names = text.split('\n').map((l) => (/^\s*(?:name|-\s*name):/.test(l) ? l : ''));
  scan(`.github/workflows/${f}`, names.join('\n'));
}

/*
 * ── 有幾個介面字串，從來沒有被算繪出來 ──────────────
 *
 * 這一段的註解（上面收集 ui 字串的那裡）寫著第 6 輪（第六圈）量到
 * 「160 個字串裡有 36 個從未出現在任何一頁」，並且註明「之後沒有重量過」。
 *
 * 第 6 輪（第二十六圈）問「壞了誰會告訴我們」，這一項的答案很具體：
 * **她**。空狀態、分頁、VideoFacade 的字 —— 那些字第一個看到的人，
 * 會是第一個寫出那種內容的人，也就是她。
 *
 * 所以把那個數字從註解裡搬到報告上：每次跑都重量，不用有人記得回來對。
 * **不擋** —— 那些字是為了還沒發生的狀態寫的，本來就不該出現在產出裡。
 */
{
  const rendered = renderedHtml;
  if (uiStrings.length === 0 || rendered === '') {
    notes.push(
      '介面字串的算繪情況沒有檢查：' +
        (uiStrings.length === 0 ? '一個介面字串都沒收到。' : 'dist/ 裡沒有可讀的文字。'),
    );
  } else {
    const never = uiStrings.filter((u) => !rendered.includes(u.value));
    if (never.length > 0) {
      const pct = Math.round((never.length / uiStrings.length) * 100);
      const sample = never.slice(0, 6).map((u) => u.value.slice(0, 14)).join('、');
      notes.push(
        `${uiStrings.length} 個介面字串裡，**${never.length} 個（${pct}%）從來沒有被算繪出來**。\n` +
          `    （分母是 \`ui.ts\` 與 \`site.ts\` 的字串值，另外跳過 ${uiSkipped} 個` +
          '單字或帶 `{佔位符}` 的 —— 那種算繪之後長得不一樣，比不到。）\n' +
          `    例如：${sample}${never.length > 6 ? '⋯' : ''}\n` +
          '    多數是為了還沒發生的狀態寫的（空狀態、分頁、影片預覽卡⋯），\n' +
          '    慣例檢查掃得到它們，但**沒有人看過它們長在頁面上的樣子** ——\n' +
          '    第一個看到的人，會是第一個寫出那種內容的人。\n' +
          '    但這個數字裡混著另一種：**掛在沒有人 import 的元件上的字，永遠不會出現**。\n' +
          '    這一支分不出那兩種（它只看字有沒有進 dist）——\n' +
          '    分得出來的是 `npm run check:content` 的「走不到的元件」那一段。',
      );
    }
  }
}

/*
 * ── 英文少一句，誰會發現 ────────────────────────────
 *
 * 見 l10nPairs 的說明：ui.ts 的 `en` 型別上是選填，少掉不會有任何東西響。
 * 這裡不擋，只說覆蓋率 —— 100% 掉下來的時候要看得見。
 */
if (l10nPairs.length > 0) {
  const missing = l10nPairs.filter((p) => !p.hasEn);
  const pct = Math.round(((l10nPairs.length - missing.length) / l10nPairs.length) * 100);
  if (missing.length === 0) {
    notes.push(
      `英文覆蓋：${l10nPairs.length} 組文案全部都有 en（100%）。\n` +
        '    （數的是 `ui.ts` 與 `site.ts` 裡每一個有 `zh-TW` 的物件 —— 不只 `ui.ts`。）\n' +
        '    這一項不擋 —— `ui.ts` 的 `en` 型別上是選填（`Partial`），少一句只會安靜地退回中文。\n' +
        '    所以數字寫在這裡：它從 100% 掉下來的時候，要有人看得見。',
    );
  } else {
    notes.push(
      `英文覆蓋：${l10nPairs.length} 組文案裡 **${missing.length} 組沒有 en**（${pct}%）：\n` +
        missing.slice(0, 6).map((p) => `      · ${p.rel}　${p.path}`).join('\n') +
        (missing.length > 6 ? `\n      …另外 ${missing.length - 6} 組` : '') +
        '\n    英文讀者看到的會是中文（`pick()` 會安靜地退回），而沒有任何一道關卡會響 ——\n' +
        '    `ui.ts` 的 `en` 型別上是選填，`site.ts` 的則是必填（`satisfies L10n`）。',
    );
  }
}

console.log('\n文案慣例檢查\n' + '─'.repeat(56));

/*
 * 筆記印在**問題之前**，而且在兩條路上都會印。
 *
 * 第一版寫在「沒有發現問題」那一段裡，於是有違規的時候整段消失 ——
 * 而那正是這個 repo 記過的錯誤位置（第 5 輪〔第二十三圈〕：
 * 區塊插在 findings 被分割之後，主體數印得出來、發現卻印不出來）。
 * 一則「有 N 個字沒有人看過」的筆記，不該因為別的地方有錯就不見。
 */
for (const n of notes) console.log(`\n  · ${n}`);
/*
 * ── 範圍那一行要說「幾條規則」，而且要跟上面的筆記分開 ──────────
 *
 * 第 6 輪（第二十九圈）問「第一次跑的人跟第一百次跑的人看到的是同一份
 * 東西嗎」。這一行本來說「掃了 61 個檔案、13647 行」——
 * 說了掃了多少**東西**，沒說用幾條規則掃的。
 * 同一圈第 1、3、5 輪對 a11y、內容、隱私做過同樣的事。
 *
 * 另外它原本緊貼在上面那則筆記後面（中間沒有空行），
 * 讀起來像筆記的一部分。範圍是判決的一半，不是註腳。
 */
console.log(
  `\n掃了 ${scanned.files} 個檔案、${scanned.lines} 行` +
    `（其中含漢字的 ${scanned.cjkLines} 行）、${RULES.length + EXTRA_RULE_IDS.length} 條規則。`,
);

/*
 * ── 每條規則真的有東西可判斷的次數 ────────────────
 *
 * 「掃了 N 行」對五條語料規則是同一個數字，所以那個數字說不出
 * 「這一條到底判斷過多少東西」。這裡印的是**前提成立的行數**：
 * 一條要求兩側都是漢字的規則，在純英文的行上沒有東西可判斷。
 *
 * 零的那幾條要看得見 —— 它們的綠燈是「沒有東西可判斷」，
 * 不是「判斷過而且沒問題」。
 */
for (const rule of RULES) if (!subjects.has(rule.id)) subjects.set(rule.id, 0);
for (const id of EXTRA_RULE_IDS) {
  if (!subjects.has(id)) subjects.set(id, 0);
}
if (process.argv.includes('--verbose')) {
  console.log('\n每條規則真的有東西可判斷的次數：');
  for (const [id, n] of [...subjects.entries()].sort((a, b) => b[1] - a[1])) {
    const base = scanned.cjkLines || 1;
    const pct = ((n / base) * 100).toFixed(1);
    const scale = ['unused-i18n-key', 'rule-not-documented', 'date-wrong-language'].includes(id)
      ? ''
      : `　佔含漢字的行 ${pct}%`;
    console.log(`  ${String(n).padStart(6)}  ${id}${scale}`);
  }
}

/*
 * 先報問題，再談「有沒有東西可掃」。
 *
 * 順序反過來的話，`rule-not-documented` 與 `unused-i18n-key` 這兩條
 * **不吃語料**的規則會被蓋掉 —— 它們看的是 CLAUDE.md 與 ui.ts，
 * 而 CLAUDE.md 在 SKIP 裡、不算「掃到的檔案」。
 * 第 6 輪（第十五圈）第一版就是這樣把一個真的發現變成了「一個檔案都沒掃到」。
 */
if (problems.length > 0) {
  /*
   * ── 同一句話出現在每一頁時，報告要收得住 ──────────
   *
   * 第 6 輪（第十九圈）在 600 頁下量到：`ui.ts` 裡**一個**字串違規，
   * 這支腳本印出 **589 筆、2373 行** —— 因為那句話畫在每一頁的頁尾。
   * 掃產出的規則天生會乘上頁數；第 1 輪（a11y）與第 5 輪（隱私）
   * 已經各修過一次，判準照搬第三次。
   *
   * 同規則 ＋ 同引文 = 同一件事，檔案最多列 3 個；
   * 同一條規則最多列 3 組。總數照實說，`--verbose` 全印。
   */
  const VERBOSE = process.argv.includes('--verbose');
  /** @type {Map<string, { p: typeof problems[number], where: string[] }>} */
  const merged = new Map();
  for (const p of problems) {
    const key = `${p.id}\u0000${p.text}`;
    const g = merged.get(key) ?? { p, where: /** @type {string[]} */ ([]) };
    g.where.push(`${p.file}${p.line ? `:${p.line}` : ''}`);
    merged.set(key, g);
  }
  /*
   * ── 改得動的地方要排在前面 ──────────────────────
   *
   * 同一句話會同時出現在 `src/i18n/ui.ts`（改得動）與幾百個
   * `dist/…`（建置產物，改不得）。第一版的收合直接砍掉第 4 個以後的位置，
   * 於是**唯一能改的那個檔案被藏在第 587 個** —— 收合本身製造了
   * 第十七圈修過的那個毛病：指向改不得的地方。
   */
  for (const g of merged.values()) {
    g.where.sort(
      (/** @type {string} */ a, /** @type {string} */ b) =>
        Number(a.startsWith('dist/')) - Number(b.startsWith('dist/')),
    );
  }

  const perRule = new Map();
  for (const { p, where } of merged.values()) {
    const n = (perRule.get(p.id) ?? 0) + 1;
    perRule.set(p.id, n);
    if (!VERBOSE && n > 3) continue;
    console.log(`\n  X [${p.id}] ${where[0]}`);
    for (const w of VERBOSE ? where.slice(1) : where.slice(1, 3)) console.log(`        ${w}`);
    if (!VERBOSE && where.length > 3) {
      console.log(`        …另外 ${where.length - 3} 個地方（--verbose 看全部）`);
    }
    console.log(`      …${p.text}…`);
    console.log(`      ${p.why}`);
  }
  if (!VERBOSE) {
    for (const [id, n] of perRule) {
      if (n > 3) {
        console.log(`\n  X …另外 ${n - 3} 組也是 ${id}（同一條規則；--verbose 看全部）`);
      }
    }
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`${problems.length} 處。\n`);

  /*
   * ── dist/ 底下的路徑改不得 ────────────────────────
   *
   * 跟第 1 輪（第十七圈）在 check:a11y 補的是同一件事：那些路徑是 build
   * 出來的，站主照著去改，下一次 build 就沒了。
   *
   * 這一支跟 a11y 不同的是它**同時掃產出與原始檔** —— docs/、ui.ts、
   * workflow 的名字都是可以直接改的，所以只在真的有產出那半的發現時才說。
   */
  if (problems.some((x) => x.file.startsWith('dist/'))) {
    /* 差一分鐘以內不算 —— build 本身要跑一段時間 */
    const stale = newestSrc > 0 && newestBuilt > 0 && newestSrc - newestBuilt > 60_000;
    if (stale) {
      const mins = Math.round((newestSrc - newestBuilt) / 60_000);
      console.log(
        `dist/ 比 src/ 舊了大約 ${mins} 分鐘 —— **先跑 npm run build 再看上面的結果**。\n` +
          '  產出那半報的可能是改之前的字。\n',
      );
    }
    console.log(
      'dist/ 底下的路徑是**建置產物**，改不得 —— 那些字的出處在 src/ 或 src/content/。\n' +
        '  找出處：把上面引的那段字拿去搜，例如\n' +
        '      grep -rn "這個平臺" src/\n' +
        '  （docs/、src/i18n/ui.ts、workflow 那幾筆是原始檔，可以直接改。）\n',
    );
  }

  process.exit(1);
}

if (scanned.files === 0) {
  console.log(
    '\n一個檔案都沒掃到 —— 這不是「沒有問題」，是「沒有東西可看」。' +
      '\n  dist/ 是空的或不存在的話，先跑 npm run build。\n',
  );
  process.exit(1);
}

/*
 * ── 這次沒有東西可判斷的規則 ────────────────────────
 *
 * 第 6 輪（第二十一圈）量到：`halfwidth-ellipsis` 的前提在 3919 行含漢字的
 * 文字裡**一次都沒有成立** —— 它從加進來（第十四圈）到現在沒有判斷過任何東西。
 * `straight-quotes` 是 5 次。
 *
 * 兩條都是預防性的：加的時候全站就是 0 處，寫下來是為了「以後也不會有」。
 * 那沒有錯 —— 錯的是**報告看起來像它們在守著什麼**。
 *
 * 這個清單在 `check:a11y`（第十五圈）、`check:content`、`check:perf` 都有，
 * 判準一樣：綠燈分成「檢查過而且沒問題」與「沒有東西可檢查」兩種，說清楚是哪一種。
 */
const idle = [...subjects.entries()]
  .filter(([, n]) => n === 0)
  .map(([id]) => id)
  .sort();
if (idle.length > 0) {
  console.log(
    `\n這次沒有東西可判斷的規則（${idle.length} 條）：${idle.join('、')}` +
      '\n  它們是綠的，但那不是「判斷過而且沒問題」，是「沒有東西可判斷」——' +
      '\n  預防性的規則本來就會這樣，寫出來是為了不要把它誤讀成有人在守。',
  );
}

console.log('\n沒有發現問題。（掃產出、人會讀的文件、內容檔 frontmatter 的註解、' +
    '以及還沒被算繪的介面字串；程式碼註解與內容正文不在範圍內 —— 正文發佈後會進 dist）');
/*
 * ── 那個能回答「到底判斷過多少東西」的旗標，要說得出口 ──────────
 *
 * `--verbose` 多印 8 行「每條規則真的有東西可判斷的次數」，
 * 而且帶佔比（cjk-latin-space 598 次、佔含漢字的行 22.9%）——
 * 那正是「綠燈代表什麼」的答案。
 *
 * 第 1 輪（第二十九圈）量到：七支關卡裡六支有 `--verbose` 而輸出從來不提它。
 * 這是那六支裡的最後一支。
 */
if (!process.argv.includes('--verbose')) {
  console.log('要看每條規則真的有東西可判斷幾次：npm run check:copy -- --verbose');
}
console.log('');
process.exit(0);
