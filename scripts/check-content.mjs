#!/usr/bin/env node
// @ts-check
/**
 * 內容管線的產出檢查 —— `npm run check:content`
 *
 * 比對 `src/content/` 的原始檔案與 `dist/` 的產出，確認兩件事：
 *
 * 1. **草稿沒有洩漏出去。** `draft: true` 的東西不該出現在產出的任何地方 ——
 *    包括頁面、搜尋索引、RSS、sitemap。
 * 2. **每一篇非草稿都有頁面。** 有檔案卻沒有對應的頁面，
 *    代表某個路由忘了包含它。
 *
 * ## 為什麼需要
 *
 * 決定「什麼東西出現在哪裡」的規則都在 `src/lib/content.ts`：
 * 草稿過濾、語言過濾、排序、分頁。**在此之前沒有任何東西在守它們。**
 *
 * 草稿過濾只有一行：
 *
 *     const visible = ({ data }) => import.meta.env.DEV || !data.draft;
 *
 * 那一行壞掉、或者某個新頁面忘了走 `getEntries()` 直接呼叫 `getCollection()`，
 * 沒寫完的東西就會安靜地上線 —— 而**建置會成功、六道關卡全綠**。
 *
 * 這是第四圈一直在找的那種東西：一件重要的事，沒有人在看。
 *
 * ## 為什麼是比對產出，不是單元測試
 *
 * `lib/content.ts` 匯入 `astro:content`，純 Node 載不動。
 * 而且真正要保證的是**產出裡沒有草稿**，不是某個函式回傳什麼 ——
 * 就算函式對了，某個頁面繞過它一樣會洩漏。比對產出兩種都涵蓋得到。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLValidator } from 'fast-xml-parser';
import { countItems } from './lib/count-items.mjs';
import { ALL_TEMPLATE_TEXT } from './lib/entry-template.mjs';
import { dedupedInlineStyles } from './lib/site-css.mjs';
import { validate, unsupported } from './lib/validate-schema.mjs';
import { documentationDuty } from './lib/copy-rules.mjs';
import { sourceHealth, coldLine, SYNC_STALE_DAYS as STALE_DAYS } from './lib/sync-health.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (/** @type {string} */ name) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? resolve(found.slice(name.length + 3)) : undefined;
};
const DIST = arg('dir') ?? resolve(ROOT, 'dist');
/*
 * `--content=` 只給測試用。第 3 輪（第六圈）要替這四條規則寫「會響」的案例，
 * 而規則吃的是 src/content 與 dist 的**比對**結果 —— 兩邊都要能換成假的，
 * 只換 dist 是測不出東西的。
 */
const CONTENT = arg('content') ?? resolve(ROOT, 'src/content');
/* `--guide=` 同理，給 field-undocumented 的案例換一份假的寫作指南用 */
const GUIDE = arg('guide') ?? resolve(ROOT, 'docs/CONTENT.md');
/* `--syndication=` 同理，給「同步資料放了多久」那一項換一份假的用 */
const SYNDICATION = arg('syndication') ?? resolve(ROOT, 'src/data/syndication.json');
/* `--src=` 同理，給 component-unreached 的案例換一份假的原始碼樹用 */
const SRC = arg('src') ?? resolve(ROOT, 'src');
/* `--astro=` 同理，給 locale-list-drift 的案例換一份假的 astro.config.mjs 用 */
const ASTRO_CONFIG = arg('astro') ?? resolve(ROOT, 'astro.config.mjs');

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** 從 frontmatter 取一個純量欄位（值可能有引號） */
/*
 * ── 只在 frontmatter 裡找，不要整份檔案找 ──────────────
 *
 * 第 3 輪（第四十一圈）補的。這一圈問「這一課學過了，當時修乾淨了嗎？」，
 * 而那一課就是兩輪前（第四十圈）在這個檔案裡記的：
 * **判準錨在「長得像」上，不是錨在「在哪個鍵底下」**
 * （當時 `poem.title` 是用「有縮排的 title:」抽的，於是短札的
 * `inResponseTo.title` 被當成詩題）。
 *
 * 那一次只修了 `poemTitle`。這一支 `field()` 是同一個形狀：
 * 它比對的是「**整份檔案**裡第一行 `name:` 開頭的」——
 * 而 frontmatter 只是檔案的前面那一段。
 *
 * `title` 是必填，frontmatter 一定在前面，所以第一個命中永遠是對的。
 * 出事的是**選填**的那些 —— 今天只有 `lang`：
 * 一篇沒有寫 `lang:` 的內容，只要正文裡有一行以 `lang:` 開頭
 * （例如一段示範 frontmatter 的程式碼框，而這個站正好在教人怎麼發文），
 * 那一行就會被當成這篇的語言。`lang` 牽動 `lang-leaked`、
 * `locale-dead-end`、`missing-page` 與搜尋索引。
 *
 * 同一個函式底下十幾行的 `usedFields` 早就先切 frontmatter 了
 * （`md.split(/^---$/m)[1]`）—— **同一個檔案裡兩種讀法**，
 * 一種錨在結構上、一種錨在長相上。這裡跟它對齊。
 *
 * 今天量過：6 篇內容的正文裡，行首就是 `key:` 的行 **0 行**。
 * 所以這是補一個還沒發生的誤讀，不是修一個現行的 bug。
 */
const field = (/** @type {string} */ md, /** @type {string} */ name) => {
  const fm = md.split(/^---$/m)[1] ?? '';
  const m = fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : undefined;
};

/** @type {{ file: string, id: string, msg: string }[]} */
const problems = [];

/*
 * ── 每條規則實際判斷過幾個東西 ──────────
 *
 * 「沒有發現問題」有兩種意思：檢查過而且沒問題，或者根本沒有東西可檢查。
 * 這兩種在輸出上長得一模一樣，而第二種是假的綠燈。
 *
 * 第 3 輪（第十五圈）量到 `external-missing` 就是第二種：站上唯一一筆
 * external 是 `draft: true` 的範例檔，所以那條規則的主體數是 **0**，
 * 從上線到現在一次都沒有判斷過任何東西。
 *
 * 這件事 `audit:privacy` 早就在做（拿不到身分值時會印「身分規則沒有執行」），
 * `check:a11y`（第 1 輪）與 `check:perf`（第 2 輪）這一圈也補上了。
 *
 * 計數放在規則自己旁邊，不另外算一份 —— 另外算一份就是「同一件事兩個地方」。
 */
/** 不算問題、但必須說出口的事（說了不擋，理由見各自的註解） */
/** @type {string[]} */
const notes = [];

/** @type {Set<string>} */
const usedFields = new Set();

/** @type {Map<string, number>} */
const subjects = new Map();
/** 這條規則這次看了 n 個東西（n 可以是 0，那正是重點） */
const saw = (/** @type {string} */ rule, /** @type {number} */ n) =>
  subjects.set(rule, (subjects.get(rule) ?? 0) + n);

// ── 收集內容檔案 ──────────────────────────────────────
/**
 * 一篇內容在**產出裡找得到的字串**。
 *
 * 不能只用 frontmatter 的 `title` —— 第 3 輪（第五圈）實測發現
 * **詩詞頁根本不顯示那個欄位**，它顯示的是 `poem.title`。
 * 也就是說 draft-leaked 那條規則對詩詞是**永遠不會響的**：
 * 它在找一個不會出現在產出裡的字串。
 *
 * 所以每篇都收集多個「找得到的字串」：frontmatter 的 title、
 * poem.title、以及原文的第一行。
 *
 * @type {{ rel: string, text: string, needles: string[], draft: boolean, collection: string, slug: string, lang: string }[]}
 */
const entries = [];
/*
 * ── dist/ 是不是比內容還舊 ──────────────────────────
 *
 * 這幾條規則（missing-page、external-missing、draft-*）比的是
 * 「src/content 有什麼」對「dist 有什麼」。而**最常見的不一致原因不是 bug，
 * 是還沒重新 build**。
 *
 * 第 3 輪（第十七圈）實測那個情境：加一首詩、不 build、跑這支檢查，
 * 得到的是「不是草稿，但產出裡找不到 poems/⋯/index.html。某個路由可能漏掉它了。」
 * —— 站主會照著那句話去 `src/pages/` 找一個不存在的 bug。
 *
 * 所以先量：內容檔裡最新的一個，比產出檔裡最新的一個還新嗎？
 */
/*
 * 掃到幾個 .md／.mdx。**不是 entries.length** ——
 * 沒有 title 的檔案會在下面 `continue`，永遠進不了 entries，
 * 而它是一個真實存在的內容檔（`no-title` 那條規則就是為它存在的）。
 * 用 entries 當「有沒有內容」的判準，會把「一個壞掉的檔案」讀成「一個檔案都沒有」。
 */
/*
 * 詩詞的 `title` 與 `poem.title` 不一樣的那幾篇。
 * 迴圈裡收集、迴圈之後才印 —— 宣告放在使用之前。
 */
/** @type {Array<{ file: string, title: string, poemTitle: string }>} */
const shadowedTitles = [];
let contentFiles = 0;
let newestContent = 0;
let newestBuilt = 0;

for await (const f of walk(CONTENT)) {
  if (!/\.mdx?$/.test(f)) continue;
  contentFiles++;
  newestContent = Math.max(newestContent, (await stat(f)).mtimeMs);
  const rel = relative(ROOT, f);
  const md = await readFile(f, 'utf8');
  saw('no-title', 1);
  // frontmatter 用到的欄位（含巢狀與陣列項）—— 下面「沒有內容用過的欄位」要用
  for (const m of (md.split(/^---$/m)[1] ?? '').matchAll(/^\s*(?:-\s*)?([a-zA-Z][a-zA-Z0-9_]*):/gm)) {
    usedFields.add(m[1]);
  }
  const title = field(md, 'title');
  if (!title) {
    problems.push({
      file: rel,
      id: 'no-title',
      msg:
        'frontmatter 裡找不到 title。　改法：檔案最上面那兩行 `---` 之間要有一行 ' +
        '`title: 這篇的標題`（詩詞的話，`poem.title` 是另一個欄位，兩個都要有）。',
    });
    continue;
  }
  const needles = [title];
  /*
   * 詩詞顯示的是 `poem.title`（縮排在 `poem:` 底下），不是上面那個 title。
   *
   * ── 判準原本是「有縮排」，而那**不是**「在 poem: 底下」 ──────
   *
   * 第 3 輪（第四十圈）發現的。原本寫的是 `/^\s{2,}title:\s*(.+)$/m` ——
   * 任何一行有縮排的 `title:` 都算。frontmatter 裡不只 `poem:` 有巢狀 title：
   *
   *     inResponseTo:
   *       title: 某篇文章        ← 短札用的，這一行也有縮排
   *       url: …
   *
   * 於是一篇**短札**（根本沒有 `poem:` 這個鍵）被當成詩詞，
   * 進了「這幾篇詩詞的 title 讀者看不到」那份名單，說它顯示的是「某篇文章」——
   * 而那一頁的 `<h1>` 與 `<title>` 印的都是它自己的 title。
   * 順帶還讓 `poem-title-bracketed` 把一個非詩詞算成主體。
   *
   * 沒有人發現，是因為 `inResponseTo` **在這之前一篇都沒有用過**
   * （`check:content` 自己那份「宣告了但沒有內容用過」名單上就有它）。
   *
   * 所以改成錨在 `poem:` 這個鍵上 —— 先框出它底下那一段，再在那一段裡找 title。
   */
  const poemBlock = /^poem:[ \t]*$\n((?:[ \t]+.*\n?)*)/m.exec(md)?.[1] ?? '';
  const poemTitle = poemBlock.match(/^\s+title:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (poemTitle) {
    saw('poem-title-bracketed', 1);
    needles.push(poemTitle);
    if (poemTitle !== title) shadowedTitles.push({ file: rel, title, poemTitle });
    /*
     * 詩題不要自己加書名號。
     *
     * 程式有八個地方會自己補上〈〉（rss.xml.ts、rss-all.xml.ts、archive.astro、
     * 詩詞頁的標題／朗讀卡／相關詩／上下篇、ui.ts 的 poem.region），
     * 所以 frontmatter 寫〈靜夜思〉會變成〈〈靜夜思〉〉。
     *
     * 第 3 輪（第十圈）實測：這樣寫，四道檢查沒有一個會說話，
     * 而 dist 裡有 8 處變成雙層 —— 其中一處還在**另一首詩**的「上下篇」上。
     * 會踩到不是因為粗心：schema 那一行的註解自己寫著「例如〈靜夜思〉」。
     * 註解已經改掉，這條規則是為了讓它不能再靜靜地發生。
     */
    /*
     * 要**整個標題被包起來**才算，不是「開頭或結尾有書名號」。
     *
     * 第 3 輪（第十六圈）的誤報探針量到：「題《赤壁圖》」是一個完全正常的詩題
     * （畫面會畫成〈題《赤壁圖》〉，對的），但它結尾是》，舊的判斷就報了。
     * 「《文心》讀後」是另一半 —— 開頭是《、結尾不是。
     *
     * 這條要抓的是「有人把整個標題包進括號」，所以條件是頭尾**成對**。
     */
    const wrapped = /^〈[^〈〉]*〉$/.test(poemTitle) || /^《[^《》]*》$/.test(poemTitle);
    if (wrapped) {
      const bare = poemTitle.slice(1, -1);
      problems.push({
        file: rel,
        id: 'poem-title-bracketed',
        msg:
          `poem.title 寫成「${poemTitle}」。書名號由畫面自己加，不然會變成〈〈${bare}〉〉。` +
          `　改法：把 poem.title 改成「${bare}」。` +
          '（poem.source 相反，那個要自己寫《》。）',
      });
    }
  }
  // 原文的第一行也一定會出現在頁面上
  const firstLine = md.match(/^\s*original:\s*\|\s*\n\s+(.+)$/m)?.[1]?.trim();
  if (firstLine) needles.push(firstLine);

  const parts = relative(CONTENT, f).split('/');
  entries.push({
    rel,
    /** 原始 markdown —— 只給下面「這個字串是不是別人的」比對用 */
    text: md,
    needles: [...new Set(needles.filter((n) => n && n.length >= 4))],
    draft: /^draft:\s*true\s*$/m.test(md),
    collection: parts[0],
    slug: parts.slice(1).join('/').replace(/\.mdx?$/, ''),
    lang: field(md, 'lang') ?? 'zh-TW',
  });
}

/*
 * ── 詩詞的 `title` 沒有人看得到 ──────────
 *
 * 第 3 輪（第三十三圈）逐條數過：**每一個會顯示詩名的地方都挑 `poem.title`。**
 * 兩份 RSS、搜尋索引、`EntryCard`（首頁與列表卡片）、`/archive`、
 * 詩頁的 `<h1>` 與 `<title>` —— 六條路徑各自寫著 `poem ? … : entry.data.title`。
 *
 * 也就是說詩詞的 `title` 是**必填、而且沒有任何讀者會看到**。
 * 上面第 169 行的註解早就知道這件事（「詩詞顯示的是 poem.title⋯不是上面那個
 * title」），但沒有任何東西照著它說話。
 *
 * 兩個值一樣的時候看不出來 —— 而 `npm run write` 正好把兩個都填成同一個答案，
 * 所以它產出的每一篇都剛好遮住這件事。實際踩到的是手寫的那一篇：
 * `pi-pa-xing-excerpt.md` 的 `title` 是「琵琶行（節錄）」，`poem.title` 是
 * 「琵琶行」，而「節錄」兩個字在整個 `dist/` 裡只出現 1 次 —— 還是來自
 * `poem.source`，不是那個 title。寫的人打了「（節錄）」，讀者一次都沒看到。
 *
 * 這裡**只說不擋**：要不要讓列表顯示 `title`，是版面與語氣的取捨，
 * 跟 `content.config.ts` 裡「要不要讓 EntryCard 補書名號」同一類，留給站主。
 * 擋的話等於現在就替他決定了。
 */
if (shadowedTitles.length > 0) {
  notes.push(
    `這幾篇詩詞的 title 讀者看不到（顯示的一律是 poem.title）：` +
      shadowedTitles.map((p) => `${p.file}「${p.title}」→ 顯示「${p.poemTitle}」`).join('；') +
      '。　要讓那幾個字出現，得寫進 poem.title、poem.source 或 description。',
  );
}

/**
 * 一個字串在產出裡可能長成什麼樣子。
 *
 * ## 為什麼不能直接 includes()
 *
 * 這支腳本拿**原始碼裡的字**去搜**產出的檔案**，而產出會逃脫。
 * 第 3 輪（第十三圈）用五種標題各建一次量到的（Astro 實際輸出）：
 *
 *   標題含    HTML／XML 裡      JSON 裡     舊的 includes() 找得到嗎
 *   （純中文） 原樣              原樣        8 個檔案（對照組）
 *   &        &amp;             原樣        只有 search-index.json
 *   <        &lt;              原樣        只有 search-index.json
 *   "        &quot;            \"          **一個都沒有**
 *   '        &#39;（數字型）     原樣        只有 search-index.json
 *
 * 後果有兩種方向：
 * - external-missing **誤報**（東西明明畫在頁面上，只是逃脫了）——
 *   五種標題裡有四種會誤報
 * - draft-leaked **漏報**：標題含半形引號的草稿洩漏到八個檔案裡，
 *   這支腳本一個字都不會說
 *
 * 做法是把針也逃脫一次去比對，而不是把整份產出解碼 ——
 * 針是一小段字面字串，變體算得出來；解碼整份文件反而可能生出新的假命中。
 *
 * @param {string} needle
 */
function variants(needle) {
  /*
   * 半形單引號有兩種寫法，而這個站兩種都會產生：
   * Astro 的 HTML 輸出是 `&#39;`（數字型），RSS 的 XML 輸出是 `&apos;`。
   * 只寫其中一種的話，含單引號的標題會在 rss-all.xml 上漏掉 ——
   * 第一版就是這樣，靠「對照組命中 8 個檔案而它只有 7 個」才看出來。
   */
  const escape = (/** @type {string} */ apos) =>
    needle
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, apos);
  // JSON.stringify 會補頭尾的引號，切掉
  const json = JSON.stringify(needle).slice(1, -1);
  return [...new Set([needle, escape('&#39;'), escape('&apos;'), json])];
}

/**
 * 產出的某個檔案裡有沒有出現這些字串（任何一種逃脫形式都算）。
 *
 * @param {string} text
 * @param {string[]} needles
 */
const appearsIn = (text, needles) => needles.some((n) => variants(n).some((v) => text.includes(v)));

// ── 讀產出 ────────────────────────────────────────────
/** @type {{ path: string, text: string }[]} */
const built = [];
for await (const f of walk(DIST)) {
  if (!/\.(html|json|xml|txt|webmanifest)$/.test(f)) continue;
  newestBuilt = Math.max(newestBuilt, (await stat(f)).mtimeMs);
  built.push({ path: relative(DIST, f), text: await readFile(f, 'utf8') });
}

/** 內容比產出新 —— 差一分鐘以內不算（build 本身要跑一段時間） */
const staleDist = newestContent > 0 && newestBuilt > 0 && newestContent - newestBuilt > 60_000;

/*
 * 沒有產出就什麼都比對不了。
 * 少了這一段，忘記先 build 的人會拿到「每一篇都缺頁面」的一長串誤報 ——
 * 而那種輸出會讓人直接放棄看這個檢查。
 */
if (built.length === 0) {
  console.error('\ndist/ 是空的或不存在。先跑 npm run build。\n');
  process.exit(1);
}

/*
 * ── 第二把尺不見了，不當作過關 ──────────────────────
 *
 * 第 3 輪（第四十五圈）加的欄位抽取自我檢查靠
 * `.astro/collections/*.schema.json`（`astro sync`／`astro build` 產生的）。
 * 那個目錄在 `.gitignore` 裡，而它不在的時候底下只印一句 note、**不擋** ——
 * 那一輪自己就把這件事記進待辦了：哪天 Astro 改了輸出位置，
 * 就會安靜地退回一把尺。
 *
 * 判準要兩個條件**同時**成立：
 *
 *   1. `dist/` 是 Astro 真的建出來的 —— 有 `dist/_astro/`，
 *      而它跟 `.astro/collections/` 是**同一個指令**產生的
 *   2. 這個 `dist/` 跟 `--astro=` 指的是**同一棵樹**
 *
 * 只有第 1 個不夠：`ci:sim` 當場抓到。fixture 會自己寫 `_astro/x.css`
 *（那是直排那幾格要的語料），而它們多半不傳 `--astro=` ——
 * 於是 `ASTRO_CONFIG` 是真 repo 的，`.astro/` 在乾淨的 checkout 上還沒有
 *（`deploy.yml` 的 `test:units` 跑在 build **之前**），
 * 這一支就在 12 格 fixture 上早退，印出來的是「（沒印）」。
 *
 * 本機兩套關卡全綠，因為工作樹永遠有 `.astro/`。
 * **唯一抓到它的是 `ci:sim`** —— CLAUDE.md 寫的就是這件事。
 */
{
  const reallyBuilt =
    existsSync(resolve(DIST, '_astro')) && resolve(dirname(ASTRO_CONFIG), 'dist') === DIST;
  const rulerDir = resolve(dirname(ASTRO_CONFIG), '.astro/collections');
  if (reallyBuilt && !existsSync(rulerDir)) {
    console.error(
      '\ndist/ 是 Astro 建出來的（有 _astro/），但 .astro/collections/ 不在。\n' +
        '  那兩個是同一個指令產生的 —— 一個在、另一個不在，表示有事情變了。\n' +
        '  欄位抽取的第二把尺（Astro 自己寫的 schema）靠那個目錄，\n' +
        '  它不在的話 field-undocumented 與 guide-field-unknown 會少一層保護。\n' +
        '  先跑 npm run build；還是不見的話，Astro 可能改了輸出位置，\n' +
        '  要跟著改 check-content.mjs 裡那一段。\n',
    );
    process.exit(1);
  }
}

/** collection 名稱 → 網址前綴。跟 lib/content.ts 的 entryUrl() 對應 */
const URL_PREFIX = { posts: 'writing', poems: 'poems', notes: 'notes' };
const DEFAULT_LANG = 'zh-TW';

/** 這一篇如果有自己的頁面，會在哪個路徑 */
const pagePath = (/** @type {typeof entries[number]} */ e) => {
  const prefix = URL_PREFIX[/** @type {keyof typeof URL_PREFIX} */ (e.collection)];
  if (!prefix) return undefined; // external 是手動登錄，沒有自己的頁面
  const localePrefix = e.lang === DEFAULT_LANG ? '' : e.lang.split('-')[0];
  /*
   * slug 要轉小寫 —— Astro 產生的網址是小寫的（`LANGTEST-en.md` → `/langtest-en`）。
   *
   * 這個 bug 在 macOS 上**看不出來**：檔案系統不分大小寫，
   * 所以 `existsSync('…/LANGTEST-en/…')` 會回 true。到 Linux 的 CI 上才會炸。
   *
   * 跟第 3 輪（第一圈）的標籤大小寫是同一個坑 ——
   * 那次也是「本機看到的跟線上跑的不一樣」。
   */
  return join(localePrefix, prefix, e.slug.toLowerCase(), 'index.html');
};

// ── 1. 草稿不能出現在產出裡 ──────────────────────────
for (const e of entries.filter((x) => x.draft)) {
  for (const id of ['draft-page', 'draft-unscannable', 'draft-leaked']) saw(id, 1);
  /*
   * ── 先看最直接的一種洩漏：草稿有了自己的頁面 ──
   *
   * 這一條不依賴標題比對，所以**標題多短都守得住**。
   * 第 3 輪（第六圈）量到下面那條字串比對有一個安靜的洞：
   * needles 有 `n.length >= 4` 的過濾，而中文標題兩三個字太常見了
   * （站上現有最短的是「靜夜思」「烏衣巷」，都是 3 個字）。
   * 實測一篇標題「讀詩」的草稿洩漏到首頁，check:content 回報「沒有發現問題」；
   * 同樣的內容改成「讀詩的方法」就抓得到。
   *
   * 那個過濾不能直接拿掉 —— 一兩個字的字串在整站掃會到處誤中。
   * 所以改成補一條不需要比對字串的檢查，再把「掃不到」講出來（見下）。
   */
  /*
   * ── 這個字串是這篇草稿獨有的嗎 ──────────────────────
   *
   * 第 3 輪（第十六圈）的誤報探針：一篇草稿的標題剛好是**另一篇已發佈**
   * 內容正文裡的一句話（「春天的雨落在瓦上」），於是它在產出裡當然找得到 ——
   * 而 `draft-leaked` 報了「草稿洩漏」。那是冤枉：洩漏的是別人的句子。
   *
   * 字串比對分不出「誰寫的」，所以**不要猜**：別人也有的字串就不拿來掃，
   * 全部都不能用的話就照 draft-unscannable 的老規矩講出來（見下），
   * 而不是報一個假的洩漏。頁面層級的 draft-page 仍然守著最重要的那種洩漏。
   */
  const usable = e.needles.filter(
    (n) => !entries.some((o) => o !== e && !o.draft && o.text.includes(n)),
  );
  const shared = e.needles.length - usable.length;

  const page = pagePath(e);
  if (page && built.some((b) => b.path === page)) {
    problems.push({
      file: e.rel,
      id: 'draft-page',
      msg:
        `這是草稿（draft: true），但產出裡有它自己的頁面 ${page}。` +
        '　改法：先確認 dist/ 是這次 build 出來的；還在的話，' +
        '去看畫那個集合的路由有沒有走 lib/content.ts 的 getEntries()（草稿過濾寫在那裡）。',
    });
  }

  /*
   * 沒有任何夠長的字串可以拿來掃 —— 不是「沒問題」，是「查不了」。
   *
   * 安靜通過是這個 repo 反覆踩到的失敗模式（第 5 輪〔第三圈〕的
   * check:history 在查不了的時候回 exit 0，那是假的綠燈）。
   * 上面那條 draft-page 仍然守著最重要的一種洩漏，所以這裡是提醒不是恐慌 ——
   * 但它必須說出口。
   */
  /*
   * 兩種「掃不了」要分開處置：
   *
   *   · **沒有夠長的字串**（標題與原文都短於 4 個字）—— 擋。
   *     那是作者可以立刻修好的事，而且很少見。
   *   · **字串別篇也有** —— **不擋，只說**。
   *     第 3 輪（第十六圈）量到：一篇草稿的標題剛好是別篇正文裡的一句話，
   *     舊版報「草稿洩漏」（冤枉）。改成不猜之後，如果又用擋的，
   *     等於把「你寫了一個跟別人重複的句子」變成建置失敗 ——
   *     那是換一種方式冤枉人。
   */
  if (e.needles.length === 0) {
    problems.push({
      file: e.rel,
      id: 'draft-unscannable',
      msg:
        '這是草稿，但它的標題與原文都短於 4 個字，沒有夠長的字串可以在產出裡掃。' +
        '頁面層級的檢查（draft-page）仍然有守，但「標題出現在列表／RSS／搜尋索引裡」' +
        '這種洩漏查不到。　改法：給它一個長一點的 title（4 個字以上）就能恢復完整的檢查。',
    });
  } else if (usable.length === 0) {
    notes.push(
      `${e.rel}：這篇草稿可以拿來掃的 ${e.needles.length} 個字串，別篇已發佈的內容也有 ——` +
        '\n    在產出裡找到它們證明不了是這一篇洩漏的，所以這次沒有用字串比對。' +
        '\n    頁面層級的 draft-page 仍然有守。',
    );
  }

  const hits = built.filter((b) => appearsIn(b.text, usable));
  if (hits.length > 0) {
    problems.push({
      file: e.rel,
      id: 'draft-leaked',
      msg:
        `這是草稿（draft: true），但它的內容出現在 ${hits.length} 個產出檔案裡` +
        (shared > 0 ? `（比對用的 ${usable.length} 個字串，另外 ${shared} 個別篇也有、已排除）` : '') +
        '：' +
        hits.slice(0, 4).map((h) => h.path).join('、') +
        '。　改法：先確認 dist/ 是這次 build 出來的；還在的話，' +
        '去看那幾個產出的來源有沒有繞過 lib/content.ts 的 getEntries()。',
    });
  }
}

// ── 2. 非草稿都要有頁面 ──────────────────────────────
/*
 * 非預設語言的內容住在 /en/ 底下（處理在上面的 pagePath()）。
 *
 * 第一版沒有處理這件事 —— 而站上**六篇內容全部是 zh-TW**，
 * 所以那個 bug 一直看不出來。第 3 輪（第五圈）放一篇 `lang: en` 的詩進去測，
 * 它立刻誤報「找不到 poems/…/index.html」。
 * 也就是說：**站主一開始寫英文內容，這個檢查就會炸。**
 */
for (const e of entries.filter((x) => !x.draft)) {
  const prefix = URL_PREFIX[/** @type {keyof typeof URL_PREFIX} */ (e.collection)];
  if (!prefix) {
    /*
     * ── external 沒有自己的頁面，但仍然該出現在某個地方 ──
     *
     * 到第 3 輪（第六圈）為止這裡只有一行 `continue`，也就是
     * **手動登錄的外站文章完全不在這支檢查的視野內**（記了三圈的待辦）。
     *
     * 它值得檢查的理由很具體：`lib/syndication.ts` 自己寫了一份草稿過濾
     * （`getCollection('external', ({ data }) => … || !data.draft)`），
     * **沒有走 lib/content.ts 的 getEntries()** —— 同一條規則的第二份實作。
     * 兩份實作遲早會分岔，而分岔的那天沒有東西會說話。
     *
     * ── 這條的改法本來第一句就指錯方向 ──────────────
     *
     * 原本寫的是「先確認 frontmatter 的 platform 是 docs/PLATFORMS.md 裡有的 id」。
     * 第 3 輪（第五十二圈）實測，那個原因**不可能造成這條規則響**：
     * `platformOrFallback()` 對不認得的 id 會**當場編一個平臺出來**
     * （name 就是那串 id、灰色、media: 'article'），所以條目照樣會出現。
     *
     * 把範本那一筆改成 `draft: false` ＋ `platform: thrads`（打錯一個字）再建置：
     *
     *   build 離開碼 0
     *   /elsewhere 多一格叫「thrads」的平臺，寫著「共 1 篇」
     *   多產生兩頁：dist/elsewhere/thrads/ 與 dist/en/elsewhere/thrads/
     *   sitemap-0.xml、rss-all.xml、search-index.json、首頁、/about 都有它
     *   **這一條 saw 到 1 個主體，然後是綠的**
     *
     * 也就是說：打錯 platform 的後果不是「不見了」，是**多了一個假的平臺**，
     * 而七道關卡沒有一道說話（`docs/TODO.md` 記了「沒有人在驗 platform id」）。
     * 改法的第一句因此指向一個永遠不會發生的原因 —— 拿掉了。
     *
     * 這條只問一件事：非草稿的 external 有沒有出現在 elsewhere/ 底下。
     * 標題短於 4 個字時 needles 會是空的、掃不了 —— 那是這整套字串比對
     * 共同的限制（見上面 draft-unscannable），不在這裡重複處理。
     */
    if (e.collection === 'external' && e.needles.length > 0) {
      saw('external-missing', 1);
      const shown = built.some((b) => /(^|\/)elsewhere\//.test(b.path) && appearsIn(b.text, e.needles));
      if (!shown) {
        problems.push({
          file: e.rel,
          id: 'external-missing',
          msg:
            '不是草稿，但產出的 elsewhere/ 底下找不到它。' +
            (staleDist
              ? '　改法：dist/ 比內容舊，**先跑 npm run build**。'
              : '　改法：dist/ 是新的，所以是 lib/syndication.ts 的 manualItems() 沒把它收進去。' +
                '　（**不是 platform 打錯** —— 那不會讓它消失，見下面那段註解。）'),
        });
      }
    }
    continue;
  }
  saw('missing-page', 1);
  saw('lang-leaked', 1);
  const expected = /** @type {string} */ (pagePath(e));
  if (!built.some((b) => b.path === expected)) {
    problems.push({
      file: e.rel,
      id: 'missing-page',
      msg:
        `不是草稿，但產出裡找不到 ${expected}。` +
        (staleDist
          ? '　改法：dist/ 比內容舊，**先跑 npm run build** —— 多半只是還沒重新建置。'
          : '　改法：dist/ 是新的，所以不是沒 build 的問題 —— 去看那個集合的路由（src/pages/）是不是漏掉它了。'),
    });
  }

  /*
   * ── 語言過濾 ──────────────────────────────────────
   *
   * 一篇內容只該在自己語言的路徑下有頁面。`lang: en` 的東西出現在
   * 中文路徑下，代表 `getEntries({ lang })` 的過濾被繞過了。
   *
   * 這一條只看**它自己的頁面存不存在**，不看標題有沒有出現在別的頁面上 ——
   * 後者會誤傷正常的情況（語言切換器、翻譯對照的連結）。
   * 第 3 輪（第四圈）記這條待辦時卡住的就是這個分辨，
   * 而「自己的頁面」這個角度剛好完全沒有那個問題。
   */
  const wrongPrefix = e.lang === DEFAULT_LANG ? 'en' : '';
  const wrong = join(wrongPrefix, prefix, e.slug.toLowerCase(), 'index.html');
  if (built.some((b) => b.path === wrong)) {
    problems.push({
      file: e.rel,
      id: 'lang-leaked',
      msg:
        `這篇是 ${e.lang}，卻在 ${wrong} 也產生了頁面。` +
        '　改法：去看那個路由有沒有把 lang 傳進 lib/content.ts 的 getEntries({ lang })。',
    });
  }
}

/*
 * ── `related` 指到不存在的東西 ──────────────────────
 *
 * 第 3 輪（第二十圈）走這條從來沒有人走過的路（`related` 是那 8 個
 * 「沒有任何一篇內容用過」的欄位之一）。把一首詩的 `related` 打錯一個字：
 *
 *   Astro 印　[ERROR] Invalid content reference: … references
 *             "wu-yi-xian" … but that entry does not exist.
 *   npm run build　**exit 0**
 *   那一頁　　「相關的詩」整段消失，沒有任何痕跡
 *   六道關卡　**全綠**
 *
 * 也就是說：她打錯一個字，站上少一段，而沒有一個地方會說話。
 * Astro 那行 ERROR 只是印出來，不擋。
 *
 * ## 抽取方式與它的自我檢查
 *
 * `related` 的兩種寫法都認：行內陣列 `related: [a, b]` 與清單
 * `related:\n  - a`。抽不到的話**不會安靜放行** —— 如果原始檔裡有
 * `related:` 而一個 id 都沒抽出來，印的是「沒有檢查」而不是「沒問題」。
 */
{
  /** 每個 collection 實際存在的 id（檔名去掉副檔名） */
  const idsByCollection = new Map();
  for (const e of entries) {
    if (!idsByCollection.has(e.collection)) idsByCollection.set(e.collection, new Set());
    idsByCollection.get(e.collection).add(e.slug);
  }

  let sawRelatedKey = 0;
  let extracted = 0;

  for (const e of entries) {
    saw('bad-reference', 1);
    const fm = e.text.split(/^---$/m)[1] ?? '';
    if (!/^related:/m.test(fm)) continue;
    sawRelatedKey++;

    /** 行內陣列 */
    const inline = fm.match(/^related:\s*\[([^\]]*)\]/m);
    /** 清單形式 */
    const listBlock = fm.match(/^related:\s*\n((?:\s*-\s*\S+\n?)+)/m);
    const ids = inline
      ? inline[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      : listBlock
        ? [...listBlock[1].matchAll(/-\s*(\S+)/g)].map((m) => m[1].replace(/^['"]|['"]$/g, ''))
        : [];
    extracted += ids.length;

    for (const id of ids) {
      /*
       * **大小寫要一致。** Astro 的 `reference()` 是大小寫敏感的 ——
       * 第 3 輪（第二十圈）實測 `Wu-Yi-Xiang` 指向 `wu-yi-xiang.md`：
       * Astro 印 ERROR、build 照樣 exit 0、那一筆從畫面上消失。
       * 第一版這裡兩邊都 `toLowerCase()`，比 Astro 寬鬆，剛好漏掉這一種
       * —— 而大小寫正是這個 repo 踩過兩次的坑（macOS 的檔案系統不分大小寫）。
       */
      if (idsByCollection.get('poems')?.has(id)) continue;
      problems.push({
        file: e.rel,
        id: 'bad-reference',
        msg:
          `related 裡的「${id}」在 poems 底下找不到。` +
          '　Astro 會印一行 ERROR 但**照樣 exit 0**，那一頁的「相關的詩」會整段消失。' +
          '　改法：那是檔名（不含 .md），去 src/content/poems/ 對一次拼字。',
      });
    }
  }

  if (sawRelatedKey > 0 && extracted === 0) {
    notes.push(
      'related 的檢查沒有執行：有內容寫了 related，但一個 id 都抽不到 —— ' +
        '抽取方式有洞。（寧可說「沒查」，也不要印一份可能是空的名單。）',
    );
  }
}

/*
 * ── 每一篇已發佈的內容，搜尋索引裡都要找得到 ──────────
 *
 * 第 2 輪（第二十一圈）量到的洞：把 `dist/search-index.json` 刪掉，
 * **沒有任何一道檢查會說話**。`check:perf` 只是少印一條預算
 * （那一輪補上了「少了一條」的提示），而 `check:links` 掃不進 `<script>`，
 * 所以那個檔案是誰在抓的、還在不在，沒有人管。
 *
 * 而它就是站內搜尋的全部：少了它，搜尋框打什麼都沒有結果。
 *
 * ## 為什麼是「每一篇都要在裡面」而不是「筆數對得上」
 *
 * 索引裡除了內容還有同步回來的影片（現在 14 筆 = 5 篇 ＋ 9 支）。
 * 拿總數比對就得在這裡重算一次影片數 —— 那是「同一件事兩個地方」。
 * 改問「每一篇已發佈的內容都在裡面嗎」：資料這支腳本本來就有，
 * 而且它抓得到更細的壞法（索引還在，但漏了某一篇）。
 */
{
  const indexFile = built.find((b) => b.path === 'search-index.json');
  saw('search-index-missing', entries.filter((e) => !e.draft && pagePath(e)).length);

  if (!indexFile) {
    problems.push({
      file: 'dist/search-index.json',
      id: 'search-index-missing',
      msg:
        '產出裡沒有搜尋索引 —— 站內搜尋會完全沒有結果。' +
        '　改法：那個檔案是 src/pages/search-index.json.ts 產的，先看那條路由還在不在；' +
        'dist 比內容舊的話先跑 npm run build。',
    });
  } else {
    /** 索引裡的網址；解析不了就說「沒有檢查」，不要印一份反過來的名單 */
    let urls = null;
    try {
      const parsed = JSON.parse(indexFile.text);
      const items = Array.isArray(parsed) ? parsed : parsed?.items;
      if (Array.isArray(items)) urls = new Set(items.map((i) => String(i?.u ?? '')));
    } catch {
      /* 下面統一處理 */
    }

    if (!urls) {
      notes.push(
        '搜尋索引沒有檢查：search-index.json 解析不出 items 陣列 —— ' +
          '格式可能改了。（寧可說「沒查」，也不要印一份可能是錯的名單。）',
      );
    } else {
      for (const e of entries) {
        if (e.draft) continue;
        const path = pagePath(e);
        if (!path) continue; // external 沒有自己的頁面
        const url = '/' + path.replace(/\/index\.html$/, '');
        if (urls.has(url)) continue;
        problems.push({
          file: e.rel,
          id: 'search-index-missing',
          msg:
            `這一篇不在搜尋索引裡（找不到 ${url}）—— 站內搜尋找不到它。` +
            '　改法：索引是 src/pages/search-index.json.ts 用 getAllWriting() 產的，' +
            '去看那裡的過濾條件是不是把它排除掉了。',
        });
      }
    }
  }
}

/*
 * ── 範本文字有沒有被留在已發佈的內容裡 ──────────────────
 *
 * `npm run write` 會在新檔案裡放幾句範本文字（「這裡放原文，一行一句」、
 * 「（短札的正文。）」⋯⋯），等她替換掉。
 *
 * 第 3 輪（第二十三圈）把整條路走了一次，包括失敗的那一支：
 * 把一首詩的原文留成範本文字然後發佈 —— **六道關卡全綠、
 * `check:copy` 與 `check:content` 都說沒有問題**。站上就會有一首
 * 「原文」是「請在這裡放原文」的詩。
 *
 * 原因是範本文字寫在 `new-entry.mjs`，檢查寫在別的地方，兩邊不知道對方。
 * （`leftover-placeholder` 那條只認 `CHANGE_ME`，那是設定檔的佔位字串。）
 * 現在兩邊都從 `lib/entry-template.mjs` 讀同一份。
 *
 * **草稿不算**。草稿本來就是還沒寫完的東西，那正是 `draft: true` 的意思 ——
 * 對草稿報這個只會讓她學會忽略它。
 */
{
  const published = entries.filter((e) => !e.draft);
  saw('template-text-left', published.length);

  for (const e of published) {
    const found = ALL_TEMPLATE_TEXT.filter((t) => e.text.includes(t));
    if (found.length === 0) continue;
    problems.push({
      file: e.rel,
      id: 'template-text-left',
      msg:
        `這一篇已經發佈了，但裡面還留著 npm run write 的範本文字：「${found[0]}」。` +
        '　改法：把那幾句換成真的內容；還沒寫完的話，把 `draft: true` 加回去 —— ' +
        '草稿不會出現在站上，也不會被這條規則報。',
    });
  }
}

/*
 * ── 我們自己發出去的 feed，讀得動嗎 ────────────────────
 *
 * 第 4 輪（第二十一圈）量到的縫：站上發兩份 feed（rss.xml 5 筆、
 * rss-all.xml 14 筆），而**沒有任何一道檢查真的把它們當 feed 剖析過**。
 * 現有的三處都是字串操作 —— check-links 用正則撿連結、
 * check-perf 量檔案大小、check-content 看標題有沒有補〈〉。
 *
 * 所以一份「XML 壞掉但字串看起來正常」的 feed 會**六道關卡全綠**，
 * 只在讀者的閱讀器裡壞掉 —— 而我們永遠不會知道。
 * 這不是假想的壞法：這個檔案第 235 行那條規則，起因就是單引號沒跳脫
 * 讓標題從 rss-all.xml 上漏掉。
 *
 * ## 兩道，不是一道
 *
 * 第一版只用剖析器（lib/count-items.mjs，同步流程在用的那一支）。
 * 突變掃描當場證明那不夠：在標題裡塞一個**沒跳脫的 `&`**，
 * 剖析器照樣讀出 5 筆，這條規則全綠。把 feed **從中間砍掉一半**，
 * 它還是讀得出 3 筆。
 *
 * 原因是 fast-xml-parser 很寬容 —— 而 XML 規格不是：
 * 不合語法的文件，符合規格的剖析器**必須**拒絕（這一點跟 HTML 相反）。
 * 也就是說「我們讀得動」證明不了「閱讀器讀得動」。
 *
 * 所以先用 XMLValidator 驗語法（這一關才擋得住上面那兩種），
 * 再用剖析器數筆數（這一關擋的是「語法沒錯但內容空了」）。
 */
{
  const feeds = built.filter((b) => /^[^/]*(rss|feed)[^/]*\.xml$/i.test(b.path));
  saw('feed-unreadable', feeds.length);

  for (const f of feeds) {
    const valid = XMLValidator.validate(f.text);
    if (valid !== true) {
      problems.push({
        file: `dist/${f.path}`,
        id: 'feed-unreadable',
        msg:
          `這份 feed 不是合法的 XML（${String(valid?.err?.msg ?? '').slice(0, 60)}）—— ` +
          '照規格，閱讀器**必須**拒絕它。' +
          '　改法：最常見的是標題或描述裡有沒跳脫的 & < >，' +
          `產生它的是 src/pages/${f.path}.ts。注意我們自己的剖析器讀得動這種檔案，` +
          '所以不能拿「本機看起來正常」當證據。',
      });
      continue;
    }

    const { n, err } = countItems(f.text);
    if (n < 0) {
      problems.push({
        file: `dist/${f.path}`,
        id: 'feed-unreadable',
        msg:
          `這份 feed 剖析不動（${err}）—— 訂閱的人會拿到一個壞掉的來源。` +
          '　改法：先用瀏覽器打開它看是不是 XML 語法錯了（沒跳脫的 & 、壞掉的 CDATA 最常見），' +
          `產生它的是 src/pages/${f.path}.ts。`,
      });
    } else if (n === 0) {
      problems.push({
        file: `dist/${f.path}`,
        id: 'feed-unreadable',
        msg:
          '這份 feed 剖析得動，但**一筆都沒有** —— 訂閱的人會看到一個空的來源。' +
          `　改法：去看 src/pages/${f.path}.ts 的過濾條件，多半是把全部內容都濾掉了` +
          '（例如 draft 判斷寫反）。',
      });
    }
  }
}

/*
 * ── 這個語言是空的，另一個語言呢 ──────────────────────
 *
 * 第 3 輪（第十八圈）從讀者那一側量到的：站上五篇已發佈的內容全部是
 * zh-TW，所以英文讀者在 /en 底下的六個頁面看到的都是「這裡還沒有東西」——
 * 而**沒有任何一句話告訴他另一個語言不是空的**。頁首有語言切換鈕，
 * 但那是「換語言」不是「那邊有東西」，兩件事。
 *
 * 判準：這一頁有空狀態、而另一個語言有已發佈的內容時，
 * 至少要有一個空狀態裡面帶著往另一個語言的連結。
 *
 * ## 為什麼只看這幾個路徑
 *
 * 因為只有這幾頁的「空」跟語言有關。/elsewhere 的空狀態是
 * 「同步還沒跑」——兩個語言一起空，指過去也是空的，
 * 把它算進來就是第十六圈那種「在講它被當成在用它」的誤報。
 *
 * ## 為什麼是「至少一個」而不是「每一個」
 *
 * 首頁有兩個空狀態（最新、別處）。別處那個不歸語言管，
 * 逐個要求就會冤枉它。問的是「這一頁有沒有指路」，不是「每一格都要指」。
 */
const LOCALE_SCOPED = /^(en\/)?(archive|poems|notes|writing|tags)?\/?(page\/\d+\/)?index\.html$/;

/** dist 裡 class="empty" 那個區塊的完整 HTML（數 div 的深度，不猜結尾在哪） */
const emptyBlocks = (/** @type {string} */ html) => {
  /** @type {string[]} */
  const blocks = [];
  const opens = /<div\b[^>]*class="empty"[^>]*>/g;
  for (let m; (m = opens.exec(html)); ) {
    let depth = 1;
    const tags = /<div\b[^>]*>|<\/div>/g;
    tags.lastIndex = m.index + m[0].length;
    for (let t; depth > 0 && (t = tags.exec(html)); ) {
      depth += t[0] === '</div>' ? -1 : 1;
      if (depth === 0) blocks.push(html.slice(m.index, t.index + t[0].length));
    }
  }
  return blocks;
};

{
  /** @type {Record<string, number>} */
  const otherHas = { 'zh-TW': 0, en: 0 };
  for (const e of entries) if (!e.draft && e.lang in otherHas) otherHas[e.lang]++;

  const pages = built.filter((b) => LOCALE_SCOPED.test(b.path));
  saw('locale-dead-end', pages.length);

  /*
   * 抽出來的每一塊都必須含有 empty__title —— 那是 EmptyState 一定會印的東西。
   * 對不上就代表這個抽法有洞，那時要說「沒查」而不是印一份可能是空的名單。
   */
  const blocks = pages.map((b) => /** @type {const} */ ([b, emptyBlocks(b.text)]));
  const broken = blocks.flatMap(([, bs]) => bs).filter((b) => !b.includes('empty__title'));
  if (broken.length > 0) {
    notes.push(
      `跨語言空狀態沒有檢查：抽出來的 ${broken.length} 個區塊裡沒有 empty__title，` +
        '抽法有洞。（寧可說「沒查」，也不要印一份可能是錯的名單。）',
    );
  } else {
    for (const [b, bs] of blocks) {
      if (bs.length === 0) continue; // 這一頁有內容
      const lang = b.path.startsWith('en/') ? 'en' : 'zh-TW';
      const other = lang === 'en' ? 'zh-TW' : 'en';
      if (otherHas[other] === 0) continue; // 那邊也是空的，沒什麼好指的
      const toOther = other === 'en' ? /href="\/en\// : /href="\/(?!en\/)/;
      if (bs.some((block) => toOther.test(block))) continue;
      problems.push({
        file: b.path,
        id: 'locale-dead-end',
        msg:
          `這一頁在 ${lang} 是空的，但 ${other} 有 ${otherHas[other]} 篇 —— ` +
          '空狀態裡沒有任何一條連過去，讀者會以為整個站都是空的。' +
          '　改法：那幾頁的空狀態都在 src/ 裡（列表頁走 layouts/ListPage.astro，' +
          '首頁、archive.astro、tags/index.astro 各自一處），' +
          "照既有寫法在 <EmptyState> 裡放一條 t('list.otherLang') 的連結。",
      });
    }
  }
}

/*
 * 一條規則從來沒進過迴圈的話，`saw()` 不會建那個鍵，它就會**安靜地不在名單裡** ——
 * 於是「綠得因為空」的規則反而最容易從「誰是空的」名單上消失。
 * 所以十一條全部先歸零。`test:content-pipeline` 有一格守這份清單跟實際規則一致。
 */
/*
 * ── 從 src/pages 走不到的元件 ────────────────────────
 *
 * 第 3 輪（第三十圈）問「這件事如果整個拿掉，會有誰發現」。
 * 內容這一層的答案很具體：**`src/components/ui/ExternalLink.astro`
 * 沒有任何一個檔案 import 它**，它那句「（在新分頁開啟）」
 * 從來沒有進過 `dist/`，而整個拿掉不會有任何一道關卡出聲。
 *
 * `check:copy` 已經會說「191 個介面字串裡 35 個從來沒有被算繪出來」，
 * 但那句話把兩種東西算成同一種：
 *
 *   · 「**還沒**算繪」—— 空狀態、分頁的字，等她寫出那種內容就會出現
 *   · 「**永遠不會**算繪」—— 掛在沒有人 import 的元件上
 *
 * 前者在等內容，後者在等人發現。這條規則只管後者。
 *
 * ── 為什麼要走遞移，不只數「有沒有人 import」──
 *
 * 甲 import 乙、而甲自己是死的話，乙也是死的。直接數 importer
 * 會說乙有一個人用。今天兩種算法答案一樣（12 個元件），但那是巧合。
 *
 * ── 為什麼只報 components/ ──
 *
 * 靜態走 import 會漏掉三種**依慣例載入**的檔案，實測都在名單上：
 *   · `content.config.ts` —— Astro 自己讀，沒有人 import 它
 *   · `identity.local.ts` —— 走 `import.meta.glob`（所以下面也認 glob）
 *   · `identity.local.example.ts` —— 樣板，本來就不該有人 import
 * 三個都不是死的。只報 `components/` 底下的 `.astro`，
 * 那些**一定**是靠 import 進來的 —— 於是 0 誤報。
 */
{
  /** tsconfig 的 paths 是別名的唯一來源 —— 寫死一份就會跟它分岔 */
  const tsconfig = await readFile(resolve(ROOT, 'tsconfig.json'), 'utf8').catch(() => '');
  /** @type {[string, string][]} */
  const aliases = [];
  for (const m of tsconfig.matchAll(/"(@[\w-]*\/)\*"\s*:\s*\[\s*"src\/([^"*]*)\*"/g)) {
    aliases.push([m[1], m[2]]);
  }
  if (aliases.length === 0) {
    notes.push('元件可達性沒有檢查：tsconfig.json 讀不到、或裡面沒有 paths 別名。');
  } else {
    /** @type {string[]} */
    const files = [];
    for await (const f of walk(SRC)) if (/\.(astro|ts|mjs|mdx)$/.test(f)) files.push(f);
    const have = new Set(files);
    /** 補副檔名／index，補不出來就回 null（那是套件，不是本地檔案） */
    const land = (/** @type {string} */ p) => {
      if (have.has(p)) return p;
      for (const e of ['.astro', '.ts', '.mjs', '.mdx']) if (have.has(p + e)) return p + e;
      for (const e of ['.astro', '.ts', '.mjs']) if (have.has(resolve(p, 'index' + e))) return resolve(p, 'index' + e);
      return null;
    };

    /** @type {Map<string, string[]>} */
    const edges = new Map();
    for (const f of files) {
      const text = await readFile(f, 'utf8').catch(() => '');
      const specs = [
        ...[...text.matchAll(/import\s+[^'"]*from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
        ...[...text.matchAll(/import\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
        /* glob 也算 —— identity.local.ts 就是這樣進來的 */
        ...[...text.matchAll(/import\.meta\.glob[^(]*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ];
      /** @type {string[]} */
      const out = [];
      for (const spec of specs) {
        /** @type {string | null} */
        let abs = null;
        for (const [a, r] of aliases) if (spec.startsWith(a)) abs = resolve(SRC, r + spec.slice(a.length));
        if (abs === null && /^\.\.?\//.test(spec)) abs = resolve(dirname(f), spec);
        if (abs === null) continue;
        const hit = land(abs);
        if (hit) out.push(hit);
      }
      edges.set(f, out);
    }

    const seen = new Set();
    const stack = files.filter((f) => f.startsWith(resolve(SRC, 'pages')));
    if (stack.length === 0) {
      notes.push('元件可達性沒有檢查：src/pages 底下一個檔案都沒有，走不出起點。');
    } else {
      while (stack.length > 0) {
        const f = /** @type {string} */ (stack.pop());
        if (seen.has(f)) continue;
        seen.add(f);
        for (const d of edges.get(f) ?? []) stack.push(d);
      }
      const components = files.filter(
        (f) => f.startsWith(resolve(SRC, 'components')) && f.endsWith('.astro'),
      );
      /*
       * 這裡不進 RULES，也不呼叫 saw() —— 跟底下「同步資料放了多久」
       * 同一個理由（見那一段的說明）。那兩個是給會報 problem 的規則用的。
       *
       * 第一版又把它登記成規則了，`test:content-rules` 當場說
       * 「RULES 名單裡有不存在的規則」。**同一個坑，這個 repo 踩第二次。**
       * 主體數（看過幾個元件）改成寫在筆記的第一句裡。
       */
      const orphans = components.filter((f) => !seen.has(f)).sort();
      /*
       * ── 為什麼是筆記，不是錯 ──
       *
       * 跟 `check:contrast` 的「未使用的 token」同一種：不是寫錯了，
       * 是**沒有接上去**，而「要刪還是要接上去」是站主的決定。
       *
       * 這裡把決定需要的數字一起印出來，免得那個決定要靠人再去量一次：
       * 有幾個地方在自己手寫同一件事。`ExternalLink.astro` 的說明第一句
       * 就是「統一在這裡處理⋯免得每個地方各寫各的」—— 而實際上
       * 每個地方真的各寫各的。**那不是死程式碼，是沒插上電的解法。**
       */
      if (orphans.length > 0) {
        /** @type {string[]} */
        const handRolled = [];
        for (const f of files) {
          if (orphans.includes(f)) continue;
          const text = await readFile(f, 'utf8').catch(() => '');
          if (/target\s*=\s*["']_blank["']/.test(text)) handRolled.push(relative(ROOT, f));
        }
        notes.push(
          `${components.length} 個元件裡，**${orphans.length} 個從 src/pages 沿著 import 走不到**：\n` +
            orphans.map((f) => '      · ' + relative(ROOT, f)).join('\n') +
            '\n    它們裡面的字一行都不會進 dist/，整個刪掉今天不會有任何一道關卡出聲。\n' +
            `    同時：另外 **${handRolled.length} 個地方**自己手寫了 target="_blank"。\n` +
            '    所以這不是「沒有人需要的程式碼」，是**沒插上電的解法** ——\n' +
            '    要刪還是要接上去，站主決定（接上去會改到那些連結的外觀）。',
        );
      }
    }
  }
}

/*
 * ── 沒有人用的具名匯出 ────────────────────────────
 *
 * 第 3 輪（第三十九圈）加的。那一圈在逐條驗待辦，而
 * 「`PAGE_SIZE` 沒有呼叫者」那一條**驗出來是錯的** ——
 * 它被 `paginate()` 與 `extraPageNumbers()` 當預設參數用，
 * 而且有 **8 個頁面**呼叫 `paginate()` 時不帶 `size`，所以它天天在用。
 *
 * 那條待辦當初怎麼寫錯的，我在驗它的時候**當場重演了一次**：
 * 第一版的探針只看「別的檔案有沒有提到這個名字」，於是報出 16 個
 * ——`PAGE_SIZE` 也在裡面。少看了兩件事：
 *
 *   1. **同一個檔案裡的使用**（預設參數就是這樣用的）
 *   2. **`src/` 以外的消費者**（`UNWIRED_SWITCHES` 是 `audit:privacy` 在讀）
 *
 * 補上這兩個之後是 **5 個**，其中 `collections` 是 Astro 依約定去讀的
 * （不是靠 import），所以真正可疑的是 4 個。
 *
 * 這一段就是把那個判準寫下來，免得下一個人再用「別的檔案有沒有提到」
 * 這種寫法量一次、再寫一條錯的待辦。跟上面「走不到的元件」一樣只說不擋。
 */
{
  /** Astro 依約定去讀的名字 —— 不靠 import，所以「沒有人 import」不代表沒人用 */
  const BY_CONVENTION = new Set(['collections']);
  /** @type {Map<string, string>} */
  const sourceTexts = new Map();
  /*
   * `--scripts=` 只給測試用。
   *
   * 理由很具體：測試要驗「沒有人用的匯出會被點名」，就得在 fixture 裡寫一個
   * `export const NOBODY`——**而那個名字同時也出現在測試檔自己裡面**。
   * 而測試檔在 `scripts/` 底下，也就是這一段的語料裡，
   * 於是那個符號看起來「別的檔案有提到」，永遠不會被點名。
   *
   * 第一版就是這樣：fixture 明明只有一個沒人用的匯出，輸出卻說「每一個都有人用」。
   */
  for (const dir of [SRC, arg('scripts') ?? resolve(ROOT, 'scripts')]) {
    for await (const f of walk(dir)) {
      if (/\.(ts|mjs|js|astro)$/.test(f)) sourceTexts.set(f, await readFile(f, 'utf8'));
    }
  }
  let exported = 0;
  /** @type {string[]} */
  const unused = [];
  for (const [f, text] of sourceTexts) {
    if (f.includes('/pages/') || f.endsWith('.astro')) continue;
    for (const m of text.matchAll(/^export (?:const|function|type|interface|class) (\w+)/gm)) {
      exported += 1;
      const name = m[1];
      if (BY_CONVENTION.has(name)) continue;
      const re = new RegExp(`\\b${name}\\b`, 'g');
      const elsewhere = [...sourceTexts.entries()].some(([g, u]) => g !== f && re.test(u));
      /* 宣告那一次不算 —— 只出現一次就表示自己也沒用它 */
      const selfUses = (text.match(re) ?? []).length;
      if (!elsewhere && selfUses <= 1) unused.push(`${relative(ROOT, f)}　${name}`);
    }
  }
  if (unused.length === 0) {
    notes.push(
      `${exported} 個具名匯出，**每一個都有人用**（判準：src/ 與 scripts/ 裡` +
        '別的檔案提到，或自己檔案裡除了宣告以外還用到）。',
    );
  } else {
    notes.push(
      `${exported} 個具名匯出裡，**${unused.length} 個沒有人用**：\n` +
        unused.map((u) => `      · ${u}`).join('\n') +
        '\n    判準：`src/` 與 `scripts/` 裡別的檔案提到，或自己檔案裡除了宣告以外還用到。\n' +
        '    （Astro 依約定去讀的名字不算 —— 目前只有 `collections`。）\n' +
        '    只說不擋：刪掉是站主的決定，而型別匯出本來就可能只是為了讓別人標註用。',
    );
  }
}

const RULES = [
  'no-title',
  'poem-title-bracketed',
  'draft-page',
  'draft-unscannable',
  'draft-leaked',
  'external-missing',
  'missing-page',
  'lang-leaked',
  'locale-dead-end',
  'bad-reference',
  'search-index-missing',
  'feed-unreadable',
  'template-text-left',
  'field-undocumented',
  'vertical-lost',
  'linebreak-lost',
  'punct-orphan-risk',
  'vertical-keep-all',
  'listing-order',
  'locale-list-drift',
  'domain-drift',
  'search-crosslang-mute',
  'guide-field-unknown',
  'syndication-schema',
  'collection-unregistered',
  'manifest-drift',
  'external-date-drift',
  'rule-not-in-guide',
];
/*
 * ── 某個語言一篇都沒有的時候，那個語言的搜尋頁要說得出來 ──────────
 *
 * 第 6 輪（第三十三圈）量的：索引裡 14 筆**全部是 zh-TW**，而搜尋只比對
 * title／tags／description／body 四個欄位 —— 這四欄含拉丁字母的只有 1 筆。
 * 拿 11 個英文讀者會打的字實測（moon、li bai、poetry、autumn、du fu⋯⋯），
 * **10 個回 0 筆**。而 `search.hint` 對他說的是「Looks through titles,
 * body text, tags, and poets’ names」—— 讀完這句就會去打「Li Bai」。
 *
 * 站上每一個空的英文頁面都已經接好指路了（`/en`、`/en/poems`、`/en/writing`、
 * `/en/notes`、`/en/archive`、`/en/tags`，第 3 輪〔第十八圈〕加的）。
 * 只有搜尋沒有 —— 偏偏那是他唯一主動做了什麼的地方。
 *
 * 這條守的是**接線還在**：那三個字串是 build 時放進 `data-strings` 的，
 * 少了任何一個，前端那段指路就會安靜地不出現。
 *
 * **它守不到判斷本身**（`mine === 0 && other > 0` 在 client script 裡，
 * 這支腳本跑不到瀏覽器）。那一段是第 6 輪用真的瀏覽器逐一驗的：
 * `/en/search` 打「li bai」會指路、打「李白」有 2 筆不指路、
 * 中文頁打不存在的字則只說「沒有找到相符的東西。」不指路。
 */
{
  const idx = built.find((b) => b.path === 'search-index.json');
  /** @type {{ l?: string }[]} */
  let items = [];
  try {
    items = JSON.parse(idx?.text ?? '{"items":[]}').items ?? [];
  } catch {
    items = [];
  }

  /* 兩個語言的搜尋頁在產出裡的位置 */
  const pages = [
    { locale: 'zh-TW', path: 'search/index.html' },
    { locale: 'en', path: 'en/search/index.html' },
  ].filter((x) => built.some((b) => b.path === x.path));

  saw('search-crosslang-mute', pages.length);

  if (idx && pages.length > 0) {
    for (const { locale, path } of pages) {
      const mine = items.filter((i) => i.l === locale).length;
      if (mine > 0) continue; // 這個語言有東西，不需要指路
      const html = built.find((b) => b.path === path)?.text ?? '';
      /*
       * 只看 `data-strings` 那個屬性裡面 —— 整頁 `includes()` 是不夠的：
       * 這幾個鍵在頁面上出現兩次（屬性裡一次、編譯後的 client script 裡一次），
       * 所以屬性掉了一個鍵，全頁比對照樣綠。第 6 輪（第三十三圈）的突變掃描
       * 就是這樣抓到自己的：改掉第一處，這一格沒有反應。
       */
      const attr = /data-strings="([^"]*)"/.exec(html)?.[1] ?? '';
      const missing = ['otherLangOne', 'otherLangMany', 'otherLangHref'].filter(
        (k) => !attr.includes(k),
      );
      if (missing.length > 0) {
        problems.push({
          file: 'dist/' + path,
          id: 'search-crosslang-mute',
          msg:
            `索引裡「${locale}」一筆都沒有，而這一頁少了指路用的字串（${missing.join('、')}）。` +
            `　讀者用 ${locale} 搜尋永遠是「沒有結果」，而畫面上不會說為什麼。` +
            '　改法：那三個是 src/pages/[...locale]/search.astro 的 strings 裡放進 data-strings 的，' +
            '　先看那幾行還在不在；dist 比原始碼舊的話先跑 npm run build。',
        });
      }
    }
  }
}

/*
 * ── schema 說詩詞預設直排，產出裡還有那條規則嗎 ──────────
 *
 * `content.config.ts` 寫著 `vertical: z.boolean().default(true)` ——
 * 也就是**每一首詩預設直排**。直排是這個站最有辨識度的一件事，
 * 而實作它的只有 `PoemBlock.astro` 裡一行 `writing-mode: vertical-rl`。
 *
 * 第 8 輪（第二十六圈）實測：把那一行改成 `horizontal-tb`，
 * 產出的 CSS 裡 `vertical-rl` **整個消失**，而
 * `npm run verify:all` 與 `npm run test:tools` **都是綠的**。
 *
 * 誰會告訴我們？讀者，或者她。全站的詩會變成橫排，
 * 而沒有任何一道關卡覺得有問題。
 *
 * 判準只問「產出的 CSS 裡還有沒有那條宣告」—— 靜態掃描看不出版面對不對，
 * 但看得出那條規則**在不在**。而它不在的時候，一定是壞的。
 */
/**
 * 真的送到讀者那裡的 CSS —— 外部檔與內嵌 `<style>` 兩半。
 *
 * Astro 的 `inlineStylesheets: 'auto'` 會把小的 scoped style 內嵌進 HTML，
 * 所以只讀 `_astro/*.css` 會漏掉一大半（`check:a11y` 第 2 輪〔第十四圈〕
 * 踩過：原本只掃到全站 CSS 的 38%）。
 *
 * 抽出來是因為底下有兩處要用（直排那條規則、斷點那份清單）——
 * 各讀一次的話，兩邊會慢慢分岔。
 */
/**
 * 這個位置外面包著哪幾層 @media（由內往外）。
 *
 * 本來寫在 `vertical-lost` 的 else 分支裡。2026-09-09 加 `linebreak-lost`
 * 時搬出來 —— 兩條規則問的是同一種問題（一條 CSS 宣告在不在、有沒有被
 * 條件蓋掉），各留一份會慢慢分岔。
 * @param {string} text
 * @param {number} at
 */
const enclosingMedia = (text, at) => {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  for (let i = at; i >= 0; i--) {
    const c = text[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        const head = text.slice(Math.max(0, i - 300), i);
        const m = /@media([^{}]*)$/.exec(head);
        if (m) out.push(m[1].trim());
      } else depth--;
    }
  }
  return out;
};

/** 這條宣告所在區塊的選擇器 */
const selectorAt = (/** @type {string} */ text, /** @type {number} */ at) => {
  const blockStart = text.lastIndexOf('{', at);
  const selStart = Math.max(text.lastIndexOf('}', blockStart), text.lastIndexOf('{', blockStart - 1));
  return text.slice(selStart + 1, blockStart);
};

let servedCss = '';
for (const f of await readdir(resolve(DIST, '_astro')).catch(() => [])) {
  if (f.endsWith('.css')) servedCss += await readFile(resolve(DIST, '_astro', f), 'utf8');
}
servedCss += dedupedInlineStyles(built.filter((b) => b.path.endsWith('.html')).map((b) => b.text)).join('\n');

{
  const wantVertical = entries.filter(
    (e) => e.collection === 'poems' && !/^vertical:\s*false\s*$/m.test(e.text),
  ).length;

  if (wantVertical > 0) {
    saw('vertical-lost', wantVertical);
    const css = servedCss;

    if (css === '') {
      notes.push('直排沒有檢查：產出裡找不到任何 CSS。');
    } else if (!/writing-mode\s*:\s*vertical-rl/.test(css)) {
      problems.push({
        file: 'dist/（全站 CSS）',
        id: 'vertical-lost',
        msg:
          `有 ${wantVertical} 首詩沒有寫 \`vertical: false\`（schema 的預設是直排），` +
          '但產出的 CSS 裡找不到 `writing-mode: vertical-rl`。\n' +
          '      全站的詩會變成橫排，而其他檢查看不出來。\n' +
          '      改法：看 src/components/content/PoemBlock.astro —— 直排那一段是不是被改掉或刪掉了。',
      });
    } else {
      /*
       * ── 那條規則「在」，可是有沒有被無條件蓋掉 ──────────
       *
       * 上面那一條問的是「宣告還在不在」。第 8 輪（第二十七圈）量到
       * 它的補集：**規則可以在，而且同時被蓋掉**。
       *
       * 實測：把窄螢幕那個 `@media (max-width: 48rem)` 的方向寫反
       * （改成 `min-width: 0rem`，一個看起來像在放寬的改動），
       * 產出的 CSS 裡 `vertical-rl` **仍然在**，`npm run build` 成功，
       * `check:content` **exit 0** —— 而每一台裝置上的詩都變成橫排。
       *
       * 判準：任何打在 `.poem__original` 上的
       * `writing-mode: horizontal-tb !important`，都必須關在一個
       * **從上方設限**的媒體查詢裡（`max-width` / 壓縮後的 `width<=`），
       * 或者是 `print`。
       *
       * 「有 width 就算數」不夠 —— 那是我第一版的判準，而它放行了
       * `min-width: 0`（壓縮成 `(width>=0)`）。**一個永遠成立的條件不是條件。**
       * 判準跟它要抓的東西犯了同一個錯，這件事本身值得留在這裡。
       */
      for (const m of css.matchAll(/writing-mode\s*:\s*horizontal-tb\s*!important/g)) {
        const at = m.index ?? 0;
        const blockStart = css.lastIndexOf('{', at);
        /*
         * 只看打在詩的原文上的那些 —— 別的元素本來就可以是橫排。
         *
         * 選擇器要取**這個區塊自己的那一段**：前一個 `}` 或 `{` 之後到這裡。
         * 第一版寫「往回看 400 個字元」，結果撈到了前一個區塊的選擇器 ——
         * 於是 `.poem__original{…vertical-rl}.some-note{…horizontal-tb!important}`
         * 會被判成「打在詩上」。壓縮過的 CSS 沒有換行，400 個字元裡有好幾條規則。
         */
        const selStart = Math.max(css.lastIndexOf('}', blockStart), css.lastIndexOf('{', blockStart - 1));
        if (!/poem__original/.test(css.slice(selStart + 1, blockStart))) continue;
        const medias = enclosingMedia(css, at);
        const guarded = medias.some((q) => /max-width|width\s*<=|width\s*<[^=]|print/.test(q));
        if (guarded) continue;
        problems.push({
          file: 'dist/（全站 CSS）',
          id: 'vertical-lost',
          msg:
            '`writing-mode: vertical-rl` 還在，但有一條 `horizontal-tb !important` ' +
            `打在 .poem__original 上，而它**沒有關在從上方設限的媒體查詢裡**` +
            `${medias.length ? `（外層是 ${medias.map((q) => `\`${q}\``).join('、')}）` : '（完全不在任何 @media 裡）'}。\n` +
            '      也就是說每一台裝置上的詩都是橫排 —— 而 vertical-rl 還在，前一條看不出來。\n' +
            '      改法：窄螢幕改橫排要用 `max-width`（壓縮後是 `width<=`）。' +
            '`min-width: 0` 這種永遠成立的條件不是條件。',
        });
      }
    }
  }
}

/*
 * ── 語言清單寫在四個地方 ──────────────────────────────
 *
 * 第 3 輪（第三十一圈）量到的：`['zh-TW', 'en']` 這個清單存在於
 *
 *   src/config/site.ts        LOCALES —— 型別的來源
 *   src/content.config.ts     z.enum([…]) —— 驗 frontmatter 的 lang
 *   astro.config.mjs          i18n.locales —— 路由
 *   astro.config.mjs          sitemap 的 locales{} —— hreflang 對照
 *
 * **四份，沒有任何東西檢查它們一樣。** 而「只有中文與英文」是這個專案
 * 三條硬性限制之一，寫在 CLAUDE.md 與 AGENTS.md 裡 —— 只寫在散文裡。
 *
 * 四份不是有人選的：型別要一份、Zod 要一份、Astro 的路由要一份、
 * sitemap 的對照表要一份，每一層各自需要，於是就變成四份。
 * 它們也**沒辦法共用**：`astro.config.mjs` 是 ESM 設定檔，
 * `content.config.ts` 跑在 Astro 的內容管線裡，都不方便 import 對方。
 *
 * 所以跟版面斷點那件事一樣：改不掉重複，就檢查它們一致。
 * 差別在斷點那邊「全部要一樣」是錯的（站上真的有三種），
 * 這邊**四份講的是同一件事**，不一樣就是 bug。
 */
{
  /** @param {string} text @param {RegExp} re */
  const listFrom = (text, re) => {
    const m = re.exec(text);
    if (!m) return null;
    return [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]);
  };
  /* 路徑走 SRC／ASTRO_CONFIG，不是寫死的 ROOT —— 不然測試換不掉，
     這幾條規則就只驗得到真的 repo（而真的 repo 永遠是一致的）。 */
  const readOr = async (/** @type {string} */ abs) => await readFile(abs, 'utf8').catch(() => '');
  const siteTs = await readOr(resolve(SRC, 'config/site.ts'));
  const contentTs = await readOr(resolve(SRC, 'content.config.ts'));
  const astroCfg = await readOr(ASTRO_CONFIG);

  /** @type {{ where: string, list: string[] | null }[]} */
  const sources = [
    { where: 'src/config/site.ts（LOCALES）', list: listFrom(siteTs, /LOCALES\s*=\s*\[([^\]]*)\]/) },
    { where: 'src/content.config.ts（z.enum）', list: listFrom(contentTs, /z\.enum\(\s*\[([^\]]*)\]/) },
    { where: 'astro.config.mjs（i18n.locales）', list: listFrom(astroCfg, /locales:\s*\[([^\]]*)\]/) },
    {
      where: 'astro.config.mjs（sitemap 的 locales）',
      /* 這一份是對照表不是陣列，取它的鍵 —— `en: 'en'` 的鍵沒有引號，兩種都要認 */
      list: (() => {
        const m = /locales:\s*\{([^}]*)\}/.exec(astroCfg);
        return m ? [...m[1].matchAll(/(?:['"]([\w-]+)['"]|\b([a-z]{2})\b)\s*:/g)].map((x) => x[1] ?? x[2]) : null;
      })(),
    },
  ];
  const found = sources.filter((x) => x.list !== null && x.list.length > 0);
  /*
   * ── 網域也有三份 ──────────
   *
   * 跟上面語言清單一模一樣的形狀，只是這次是網域：
   *
   *   src/config/site.ts   url    —— 頁面文案、seo.ts 用它組絕對網址
   *   astro.config.mjs     site   —— sitemap、RSS、og:image 的絕對網址
   *   public/CNAME                —— GitHub Pages 真的把站掛在哪個網域
   *
   * `astro.config.mjs` 自己的註解就寫著「site 一定要正確，否則 sitemap、RSS、
   * og:image 產出的絕對網址會是錯的」—— 重要性寫下來了，**一致性沒有人在看**。
   *
   * 三者分岔的後果各不相同而且都不會報錯：
   *   site.ts ≠ astro.config → 頁面上寫的網域跟 canonical／sitemap 不同
   *   兩者 ≠ CNAME           → 整站的絕對網址指到一個不是自己的網域
   *
   * 第 7 輪（第三十四圈）：這一圈問「這個答案系統裡已經有了嗎」——
   * 有三份，而且上面那條 `locale-list-drift` 已經把 `site.ts` 與
   * `astro.config.mjs` 都讀進來了。只差沒有人問它們是不是同一個網域。
   *
   * CNAME 的路徑從 `ASTRO_CONFIG` 的目錄推 —— 跟上面一樣，
   * 寫死 ROOT 的話測試換不掉，這條規則就只驗得到真的 repo。
   */
  {
    const host = (/** @type {string} */ raw) => {
      const t = raw.trim();
      if (t === '') return null;
      try {
        return new URL(t.includes('://') ? t : `https://${t}`).host;
      } catch {
        return null;
      }
    };
    const cnameAt = resolve(dirname(ASTRO_CONFIG), 'public/CNAME');
    const domains = [
      { where: 'src/config/site.ts（url）', host: host(/url:\s*'([^']+)'/.exec(siteTs)?.[1] ?? '') },
      { where: 'astro.config.mjs（site）', host: host(/site:\s*'([^']+)'/.exec(astroCfg)?.[1] ?? '') },
      { where: 'public/CNAME', host: host(await readOr(cnameAt)) },
    ];
    const got = domains.filter((d) => d.host !== null);
    saw('domain-drift', got.length);

    if (got.length < domains.length) {
      notes.push(
        '網域只比對了 ' + got.length + '／' + domains.length + ' 份 —— 抽不到的：' +
          domains.filter((d) => d.host === null).map((d) => d.where).join('、') +
          '。\n    不是「一致」，是**沒有比對到**。',
      );
    }
    for (const d of got.slice(1)) {
      if (d.host === got[0].host) continue;
      problems.push({
        file: d.where.replace(/（.*/, ''),
        id: 'domain-drift',
        msg:
          `網域跟 ${got[0].where} 對不起來。\n` +
          `      ${got[0].where}：${got[0].host}\n` +
          `      ${d.where}：${d.host}\n` +
          '      這三份講的是同一件事（頁面文案、canonical／sitemap／RSS 的絕對網址、\n' +
          '      以及 GitHub Pages 實際掛在哪）。不一樣不會報錯，只會讓整站的絕對網址\n' +
          '      指到一個不是自己的網域。\n' +
          '      改法：三個地方一起改；換網域的話 DNS 也要跟著（見 docs/DEPLOY.md）。',
      });
    }
  }

  /*
 * ── 列表的順序，拿掉排序之後沒有人說話 ────────────────────
 *
 * 第 3 輪（第四十六圈）問「這一段如果拿掉，輸出會差在哪裡」，
 * 把 `lib/content.ts` 的零件一個一個拿掉再建置、再跑全部關卡：
 *
 *   草稿過濾（真的放一篇草稿進去）  dist 43 → 45 頁　check:content 抓到
 *   語言過濾                    check:links 與 check:a11y 抓到
 *   **getEntries 的 sort**       **dist 有 4 個檔案不一樣，而沒有人說話**
 *   getEntries／getAllWriting 的 limit  dist 一個字都沒變（現在的內容量用不到）
 *
 * 那 4 個檔案是 `poems/index.html`（列表順序）與三篇詩頁
 *（上一篇／下一篇的鄰居換了）。**讀者看得到，關卡看不到。**
 *
 * 判準不重寫一次排序（那會變成同一個判斷寫兩份），而是驗一個**性質**：
 * 把標了 `data-featured` 的項目拿掉之後，剩下的日期必須遞減；
 * 標了 featured 的那幾個彼此之間也要遞減。
 * 這個性質對兩種列表都成立 —— `featuredFirst: true`（詩詞）
 * 與 `false`（短札、彙整）—— 而排序一拿掉就不成立。
 *
 * 導入時實測：9 頁有兩個以上日期，0 頁違規；
 * 把 sort 拿掉之後 `poems/index.html` 變成 ★09-01、08-20、08-28，抓得到。
 */
{
  let listings = 0;
  for (const b of built) {
    if (!b.path.endsWith('.html')) continue;
    /*
     * `data-featured` 標在**標題**上，而標題在同一個項目裡排在 `<time>` 前面。
     * 所以往回看的範圍是「上一個 `<time>` 結束的地方」到「這一個 `<time>` 開始」——
     * 那一段裡剛好只有這一個項目的標題。
     *
     * 第一版往回看固定 600 字元，那是**猜的**：站上的項目夠長所以看起來對，
     * 而測試的 fixture 項目短，第二個項目就看到了第一個的 `data-featured`。
     * 測試當場紅了 —— 這一圈第 2 輪也是同一種錯（判準是猜的，不是問出來的）。
     */
    /*
     * ── 一頁上可能有不只一份清單，而它們各自排各自的 ────────────
     *
     * 2026-09-09 之前這裡把**整頁的 `<time>` 當成一份清單**。首頁其實有兩份：
     * 「最近」（`lib/content.ts` 排的站內內容）與「各處」
     * （`syndication.json` 排的外站作品）。
     *
     * 那個假設一直沒被戳破，是因為站內內容的日期**剛好全都比影片新**
     * —— 兩份接起來仍然遞減。站主 2026-09-09 把接了影片的詩改成用
     * YouTube 的發佈時刻之後，站內內容掉進 2024 年，兩份一交錯就誤報：
     *
     *   ★2026-09-02 ★2026-08-30 2026-08-28 2026-08-20 2024-10-26 2024-10-23
     *   │← 這六個是「最近」，自己是遞減的                              │
     *                                          2024-10-26 2024-10-23 …
     *                                          └← 這五個是「各處」，自己也是遞減的
     *
     * 兩份都對，接起來不對 —— **錯的是判準不是頁面**。
     * 而且原本那句改法（「去看 lib/content.ts 的 getEntries()」）對第二份
     * 根本不成立：那份的順序不是它排的。
     *
     * 改成按 `<section>` 分組。用 section 不用 `<ul>`：每一張卡片裡面
     * 自己就有一個標籤用的 `<ul>`，拿 `</ul>` 切會把「最近」切成六份單筆的，
     * 這條規則就形同廢掉（實測那六個 `<time>` 每一個前面都夾著一個 `</ul>`）。
     */
    /** @type {{ d: string, f: boolean, g: number }[]} */
    const items = [];
    let prevEnd = 0;
    for (const m of b.text.matchAll(/<time[^>]*datetime="([0-9-]+)"[^>]*>/g)) {
      const at = /** @type {number} */ (m.index);
      const g = (b.text.slice(0, at).match(/<section[\s>]/g) ?? []).length;
      items.push({ d: m[1], f: /data-featured/.test(b.text.slice(prevEnd, at)), g });
      prevEnd = at + m[0].length;
    }
    if (items.length < 2) continue;
    listings += 1;
    const desc = (/** @type {string[]} */ a) => a.every((v, i) => i === 0 || a[i - 1] >= v);
    /** @type {Map<number, { d: string, f: boolean }[]>} */
    const groups = new Map();
    for (const it of items) {
      const bucket = groups.get(it.g) ?? [];
      bucket.push(it);
      groups.set(it.g, bucket);
    }
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      const plain = group.filter((x) => !x.f).map((x) => x.d);
      const feat = group.filter((x) => x.f).map((x) => x.d);
      if (desc(plain) && desc(feat)) continue;
      problems.push({
        file: b.path,
        id: 'listing-order',
        msg:
          '這一段的日期不是由新到舊：' +
          group.map((x) => (x.f ? '★' : '') + x.d).join('　') +
          '\n      （★ 是 data-featured。判準是：拿掉 featured 之後剩下的要遞減，' +
          'featured 彼此之間也要遞減。一頁上每個 <section> 各自比。）\n' +
          '      改法：站內清單的順序是 src/lib/content.ts 的 getEntries()／getAllWriting() 排的；' +
          '「各處」那一份是 src/lib/syndication.ts 排的 —— 先看是哪一段。',
      });
    }
  }
  saw('listing-order', listings);
}

/*
 * ── 一句詩不能被折成兩截 ─────────────────────────
 *
 * 直排那一支早就有保護：`max-inline-size` 的下限寫成
 * `calc(var(--poem-longest-line) * 1.14em + 0.5em)` —— 用 em，
 * 所以讀者把字級調大時它自己跟著長。
 *
 * 橫排那一支到 2026-09-09 為止只有 `max-inline-size: 100%`，
 * 那是**容器的百分比**，不跟著字級走。站主要求「嚴格確認斷句」那天實測：
 *
 *   視窗 320px　字級 175%　→ 四句七言每一句都折成兩截
 *   視窗 360px　字級 200%　→ 折（360 是最常見的 Android 寬度）
 *   視窗 375px　字級 200%　→ 不折（一句七言要 287px）
 *
 * 折出來是「秦時明月漢／時關」——**那不是排版難看，是讀錯**。
 * 而且窄螢幕一律橫排，所以受影響的是所有手機，不是少數。
 *
 * 這條守的是修法還在：`.poem__original` 上要有一個非 0 的
 * `min-inline-size`（列印那一份是 0，紙上沒有捲軸，那是刻意的例外）。
 *
 * **它守不到「折了沒有」本身** —— 那要有排版引擎，而這個專案刻意沒有
 * 無頭瀏覽器（見 docs/ARCHITECTURE.md）。量法寫在 docs/A11Y.md。
 */
/*
 * ── 直排的區塊要自己講清楚 `word-break` ────────────────────────
 *
 * 全站 `body` 是 `word-break: keep-all`，它會繼承到每一個直排區塊裡。
 * 2026-09-11 在真的 WebKit 上量到：**`keep-all` 在 `vertical-rl` 底下
 * 根本不產生斷點**，連「，」後面都不斷。該換欄的地方不換，
 * 整欄的字直接往下溢出盒子 —— 而且**把盒子縮小沒有用**
 *（`max-inline-size` 6.4em → 6.2em → 5.5em，溢出反而是 112 → 117 → 135px）。
 *
 * 站主當天看到的：首頁的題辭「青青子衿，悠悠我心」擠成一條直線，
 * 底下那行《詩經・鄭風・子衿》橫著穿過去 ——「像倒十字架」。
 *
 * 這條要求每一個 `writing-mode: vertical-*` 的區塊在**同一個大括號裡**
 * 自己寫出 `word-break`。不是要它寫某個值，是要它別用繼承來的那個 ——
 * 直排要不要斷、怎麼斷，是寫那個區塊的人該決定的事。
 *
 * 為什麼不是「量有沒有溢出」：那要排版引擎，而且**橫向的量法量不到它**
 *（直排是往**下**溢出，`scrollWidth` 與「超出視窗右緣」兩個判準都看不見）——
 * 上一輪 228 格全綠卻漏掉這個 bug，就是因為只量了橫向。
 */
{
  if (servedCss === '') {
    notes.push('直排區塊的 `word-break` 沒有檢查：產出裡找不到任何 CSS。');
  } else {
    /** 這個位置所在區塊的內容（`{` 到配對的 `}`） */
    const blockAt = (/** @type {number} */ at) => {
      const start = servedCss.lastIndexOf('{', at);
      let depth = 0;
      for (let i = start; i < servedCss.length; i++) {
        if (servedCss[i] === '{') depth++;
        else if (servedCss[i] === '}' && --depth === 0) return servedCss.slice(start, i);
      }
      return servedCss.slice(start);
    };

    /** @type {string[]} */
    const silent = [];
    let verticalBlocks = 0;
    for (const m of servedCss.matchAll(/writing-mode\s*:\s*vertical-[a-z]+/g)) {
      const at = m.index ?? 0;
      verticalBlocks += 1;
      if (!/word-break\s*:/.test(blockAt(at))) silent.push(selectorAt(servedCss, at).trim().slice(0, 70));
    }
    saw('vertical-keep-all', verticalBlocks);

    if (verticalBlocks === 0) {
      notes.push('直排區塊的 `word-break` 沒有檢查：CSS 裡找不到 `writing-mode: vertical-*`。');
    } else if (silent.length > 0) {
      problems.push({
        file: 'dist/（全站 CSS）',
        id: 'vertical-keep-all',
        msg:
          `${silent.length}／${verticalBlocks} 個直排區塊沒有自己寫 \`word-break\`，` +
          '會繼承到 `body` 的 `keep-all`：\n' +
          silent.map((sel) => `        ${sel}`).join('\n') +
          '\n      在 WebKit（Safari）上 `keep-all` 在直排底下**不產生斷點** ——\n' +
          '      該換欄的地方不換，整欄往下溢出，而且縮小盒子沒有用。\n' +
          '      站主 2026-09-11 看到的是首頁題辭擠成一條直線、\n' +
          '      出處那一行橫著穿過去，「像倒十字架」。\n' +
          '      改法：在那個區塊裡寫出來 —— 會換欄的寫 `word-break: normal`，\n' +
          '      每一行都 `white-space: nowrap` 的也寫（那是說「我想過了」）。',
      });
    }
  }
}
/*
 * ── `keep-all` 跟 `overflow-wrap` 不可以同時打在同一個地方 ──────────
 *
 * 中文的行首禁則是「`。`、`，`、`」` 這些不可以起一行」。2026-09-11 用
 * 真的 WebKit（`WKWebView`，跟站主用的 Safari 同一個引擎）量出來：
 *
 *   word-break   overflow-wrap                     違規（321 種寬度）
 *   normal       normal / break-word / anywhere          0
 *   keep-all     normal                                  0
 *   keep-all     break-word                             68
 *   keep-all     anywhere                               68
 *
 * `keep-all` 把「兩個標點之間」變成一個斷不開的詞；WebKit 的 `overflow-wrap`
 * 在那個詞放不進**這一行剩下的空間**時就地切開它，切的位置只看寬度不看禁則。
 * 於是站主在 `/poems` 上看到「⋯還有一點自己的話／。」—— 句號自己站一行。
 * 那一句在 560、768、1024、1280、1440px 每一個寬度都會出現，不是窄螢幕才有。
 *
 * **Chrome 沒有這個行為**，所以在只有 Chrome 的機器上看不到它 ——
 * 這條規則的存在就是為了補那個看不到。
 *
 * 這條守的是那個組合不會被裝回去。它**守不到「有沒有折壞」本身**
 *（那要排版引擎，這個專案刻意沒有無頭瀏覽器，見 docs/ARCHITECTURE.md）；
 * 量法寫在 docs/ARCHITECTURE.md 的「斷句」那一節。
 *
 * 為什麼是這個判準而不是「body 上不准有 overflow-wrap」：保險本身是需要的
 *（拉丁長字、窄欄），只是不能跟 `keep-all` 疊在一起。所以比的是
 * **同一個選擇器＋同一組 @media 條件**底下有沒有同時出現這兩件事。
 */
{
  if (servedCss === '') {
    notes.push('標點會不會落單沒有檢查：產出裡找不到任何 CSS。');
  } else {
    /** 一條宣告的「生效條件」：選擇器 ＋ 外面包的 @media（排序過，才比得起來） */
    const contextOf = (/** @type {number} */ at) =>
      JSON.stringify([
        selectorAt(servedCss, at).trim().replace(/\s+/g, ' '),
        enclosingMedia(servedCss, at).slice().sort(),
      ]);

    /** @type {Map<string, string[]>} */
    const keepAll = new Map();
    for (const m of servedCss.matchAll(/word-break\s*:\s*keep-all/g)) {
      const k = contextOf(m.index ?? 0);
      keepAll.set(k, JSON.parse(k));
    }
    saw('punct-orphan-risk', keepAll.size);

    /** @type {string[]} */
    const clashes = [];
    for (const m of servedCss.matchAll(/overflow-wrap\s*:\s*(break-word|anywhere)/g)) {
      const k = contextOf(m.index ?? 0);
      if (keepAll.has(k)) {
        const [sel, media] = JSON.parse(k);
        clashes.push(`${sel || '(?)'}${media.length ? `  @media ${media.join(' / ')}` : '（沒有任何 @media 條件）'}`);
      }
    }

    if (keepAll.size === 0) {
      notes.push('標點會不會落單沒有檢查：CSS 裡找不到 `word-break: keep-all`。');
    } else if (clashes.length > 0) {
      problems.push({
        file: 'dist/（全站 CSS）',
        id: 'punct-orphan-risk',
        msg:
          `有 ${clashes.length} 個地方同時打了 \`word-break: keep-all\` 與 ` +
          '`overflow-wrap: break-word／anywhere`：\n' +
          clashes.map((c) => `        ${c}`).join('\n') +
          '\n      在 WebKit（Safari）上這個組合會讓「。」「，」「」」落到行首 ——\n' +
          '      站主看過三次，最後一次是「⋯還有一點自己的話／。」。\n' +
          '      Chrome 沒有這個行為，所以本機看不出來。\n' +
          '      改法：保險只放在窄螢幕那一支（那裡是 `word-break: normal`，\n' +
          '      量過 0 違規），寬螢幕靠 `minmax(0, 1fr)` 讓軌道不被內容撐開。\n' +
          '      見 src/styles/global.css 的「中文要斷在講得通的地方」。',
      });
    }
  }
}
{
  const poems = entries.filter((e) => e.collection === 'poems').length;
  if (poems > 0) {
    saw('linebreak-lost', poems);
    if (servedCss === '') {
      notes.push('詩句會不會被折斷沒有檢查：產出裡找不到任何 CSS。');
    } else {
      /*
       * 判準是「**每一個**把詩設成橫排的區塊，自己都要帶那個下限」，
       * 不是「全站找得到一個就算數」。
       *
       * 第一版寫的是後者，當場被自己的突變掃描打臉：橫排有兩段
       *（寬螢幕手動切的那一段、窄螢幕一律橫排的那一段），
       * 只拿掉窄螢幕那一份 —— 也就是**所有手機**——，規則照樣綠。
       */
      /** 這條宣告所在區塊的內容（`{` 到配對的 `}`） */
      const blockAt = (/** @type {number} */ at) => {
        const start = servedCss.lastIndexOf('{', at);
        let depth = 0;
        for (let i = start; i < servedCss.length; i++) {
          if (servedCss[i] === '{') depth++;
          else if (servedCss[i] === '}' && --depth === 0) return servedCss.slice(start, i);
        }
        return servedCss.slice(start);
      };
      const hasGuard = (/** @type {string} */ block) => {
        const m = /min-inline-size\s*:\s*([^;}]+)/.exec(block);
        if (!m) return false;
        return !/^0(\D|$)/.test(m[1].trim());
      };

      /** @type {string[]} */
      const unguarded = [];
      let horizontalBlocks = 0;
      for (const m of servedCss.matchAll(/writing-mode\s*:\s*horizontal-tb/g)) {
        const at = m.index ?? 0;
        const sel = selectorAt(servedCss, at);
        if (!/poem__original/.test(sel)) continue;
        /* 紙上沒有捲軸，那一份刻意不設下限 */
        if (enclosingMedia(servedCss, at).some((q) => /print/.test(q))) continue;
        horizontalBlocks += 1;
        if (!hasGuard(blockAt(at))) unguarded.push(sel.trim().slice(0, 80));
      }
      /*
       * ── 真正的保證是 `nowrap`，不是那個算式 ──────────────
       *
       * 這條規則本來只看 `min-inline-size`：算出「一句有多寬」再把容器撐到
       * 那麼寬。2026-09-11 第三次折斷之後換了做法 ——
       * `.poem__line { white-space: nowrap }` 讓一句詩**結構上**斷不了，
       * 不管字型多寬、視窗多窄。
       *
       * 所以這裡也跟著改：`nowrap` 不見了才是真的失守（那是無條件的保證），
       * `min-inline-size` 不見了是版面退步（方塊會縮成一條）——
       * 兩件都要說，但要說清楚哪一件比較嚴重。
       */
      const lineNowrap = (() => {
        for (const m of servedCss.matchAll(/white-space\s*:\s*nowrap/g)) {
          const sel = selectorAt(servedCss, m.index ?? 0);
          if (/poem__line/.test(sel)) return true;
        }
        return false;
      })();

      const guarded = horizontalBlocks > 0 && unguarded.length === 0;
      if (horizontalBlocks === 0) {
        notes.push('詩句會不會被折斷沒有檢查：CSS 裡找不到打在 .poem__original 上的橫排規則。');
      } else if (!lineNowrap || !guarded) {
        problems.push({
          file: 'dist/（全站 CSS）',
          id: 'linebreak-lost',
          msg:
            (lineNowrap
              ? ''
              : '**`.poem__line` 沒有 `white-space: nowrap`** —— 一句詩折不折得斷，' +
                '現在就只剩算式在擋了。\n') +
            (guarded
              ? ''
              : `站上有 ${poems} 首詩，而 ${unguarded.length}／${horizontalBlocks} 個把詩設成橫排的 ` +
                'CSS 區塊沒有非 0 的 `min-inline-size`：\n' +
                unguarded.map((sel) => `        ${sel}`).join('\n') + '\n') +
            '      一句詩被折成兩截是**讀錯**，不是難看：「秦時明月漢／時關」\n' +
            '      讀起來像另一種格律。這件事壞過三次（第 8 輪〔第十二圈〕直排、\n' +
            '      2026-09-09 橫排、2026-09-11 站主又看到「舉頭望明／月」）——\n' +
            '      前兩次都是修那個算式，第三次才改成結構上不可能。\n' +
            '      改法：看 src/components/content/PoemBlock.astro ——\n' +
            '      `.poem__line { white-space: nowrap }` 是**保證**（無條件），\n' +
            '      `min-inline-size: calc(...)` 是**版面**（讓方塊至少一句寬）。',
        });
      }
    }
  }
}

/*
   * ── 站名、描述、主題色，manifest 裡還有一份 ──────────
   *
   * `public/site.webmanifest` 是**手寫的靜態檔**（不是產生的），裡面有：
   *
   *   name / short_name  —— 安裝成 App 之後主畫面顯示的名字
   *   description        —— 安裝介面上的說明
   *   theme_color / background_color —— 啟動畫面與網址列的顏色
   *
   * 這四樣在 `src/config/site.ts` 都另有一份。**沒有人比過。**
   *
   * 顏色那一組最能說明問題：`#faf6ee` 寫在三個地方 ——
   * `tokens.css` 的 `--c-bg`、`site.ts` 的 `themeColor.light`、
   * 以及這份 manifest。前兩份 `check:contrast` 已經在比（對不上會紅，
   * 改法就寫著「把 site.ts 的 themeColor 改成 --c-bg 的值」），
   * 第三份誰都沒有在看。
   *
   * 第 3 輪（第四十三圈）實測：把 `--c-bg` 與 `themeColor.light` 一起改成
   * `#faf6ef`（兩份互相對得上），**六道關卡全綠**，而 manifest 還是舊的 ——
   * 安裝成 App 的人看到的啟動畫面就是舊顏色，沒有任何一格會出聲。
   *
   * 描述那一項用「開頭要對得上」而不是完全相等：manifest 現在寫的是
   * `site.ts` 描述的**第一句**（短版是刻意的，安裝介面的空間有限）。
   * 要求相等會把今天就擋掉，而要求是前綴，改了 `site.ts` 的第一句仍然會紅。
   */
  {
    const manifestAt = resolve(dirname(ASTRO_CONFIG), 'public/site.webmanifest');
    const rawManifest = await readOr(manifestAt);
    /** @type {Record<string, unknown>} */
    let mf = {};
    let readable = false;
    if (rawManifest.trim() !== '') {
      try {
        mf = JSON.parse(rawManifest);
        readable = true;
      } catch {
        readable = false;
      }
    }
    const str = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : null);
    const siteName = /name:\s*\{\s*'zh-TW':\s*'([^']+)'/.exec(siteTs)?.[1] ?? null;
    const siteDesc = /description:\s*\{\s*'zh-TW':\s*'([^']+)'/.exec(siteTs)?.[1] ?? null;
    const siteTheme = /themeColor:\s*\{\s*light:\s*'([^']+)'/.exec(siteTs)?.[1] ?? null;

    /* 「這一項有沒有真的比到」跟「它對不對」是兩件事 —— 分開數 */
    const pairs = [
      { key: 'name', got: str(mf.name), want: siteName, from: "site.ts 的 name['zh-TW']", how: 'equal' },
      { key: 'short_name', got: str(mf.short_name), want: siteName, from: "site.ts 的 name['zh-TW']", how: 'equal' },
      {
        key: 'description',
        got: str(mf.description),
        want: siteDesc,
        from: "site.ts 的 description['zh-TW']",
        how: 'prefix',
      },
      { key: 'theme_color', got: str(mf.theme_color), want: siteTheme, from: 'site.ts 的 themeColor.light', how: 'color' },
      {
        key: 'background_color',
        got: str(mf.background_color),
        want: siteTheme,
        from: 'site.ts 的 themeColor.light',
        how: 'color',
      },
    ];
    /*
     * ── manifest 裡還有三樣東西指向真的檔案 ──────────────
     *
     * 第 3 輪（第四十五圈）逐條驗待辦時量到的：上面那五項比的是**文字**
     * （站名、描述、顏色），而 manifest 裡另外三樣是**指路**的 ——
     * `icons[].src`、`start_url`、`scope`。指到不存在的東西不會有人說話：
     * 這一支不掃圖片，`check:links` 也不掃 manifest。
     *
     * 後果是安裝的時候才看得到（主畫面的圖示破掉、開啟後 404），
     * 而那正是**最不會有人回頭看**的一條路。
     *
     * 判準都是「它指到的東西在不在 `dist/` 裡」—— 不需要任何清單。
     * `lang` 也一起比：拿 `start_url` 那一頁真的寫的 `<html lang>` 來對。
     */
    /** @type {{ what: string, why: string }[]} */
    const pointerProblems = [];
    let pointersChecked = 0;
    /*
     * manifest 從 `--astro=` 那一邊來，`dist/` 從 `--dir=` 那一邊來。
     * 平常是同一棵樹，測試裡可以不是 —— 拿甲的 manifest 去問乙的產出，
     * 答案沒有意義（每個圖示都會「不存在」）。所以先確認是同一棵樹。
     */
    const sameTree = resolve(dirname(ASTRO_CONFIG), 'dist') === DIST;
    if (readable && sameTree) {
      const distPath = (/** @type {string} */ u) => resolve(DIST, u.replace(/^\//, '').split(/[?#]/)[0]);
      const icons = Array.isArray(mf.icons) ? mf.icons : [];
      for (const icon of icons) {
        const src = str(/** @type {any} */ (icon)?.src);
        if (src === null) continue;
        pointersChecked += 1;
        if (!existsSync(distPath(src))) {
          pointerProblems.push({
            what: `icons 裡的 ${src}`,
            why: '這個檔案不在產出裡 —— 安裝成 App 的時候那個圖示會是破的。',
          });
        }
      }

      const startUrl = str(mf.start_url);
      if (startUrl !== null) {
        pointersChecked += 1;
        const asPage = startUrl.endsWith('/') ? `${startUrl}index.html` : `${startUrl}/index.html`;
        if (!existsSync(distPath(asPage)) && !existsSync(distPath(startUrl))) {
          pointerProblems.push({
            what: `start_url ${startUrl}`,
            why: '這個網址在產出裡找不到對應的頁 —— 從主畫面開啟會落在 404。',
          });
        }
      }

      const scope = str(mf.scope);
      if (scope !== null && startUrl !== null) {
        pointersChecked += 1;
        if (!startUrl.startsWith(scope)) {
          pointerProblems.push({
            what: `scope ${scope}`,
            why: `start_url（${startUrl}）不在 scope 底下 —— 一開啟就跳出 App 的範圍。`,
          });
        }
      }

      const mfLang = str(mf.lang);
      if (mfLang !== null && startUrl !== null) {
        const homePath = distPath(startUrl.endsWith('/') ? `${startUrl}index.html` : `${startUrl}/index.html`);
        const home = built.find((b) => resolve(DIST, b.path) === homePath);
        const htmlLang = home ? /<html[^>]*\slang="([^"]+)"/i.exec(home.text)?.[1] ?? null : null;
        if (htmlLang !== null) {
          pointersChecked += 1;
          if (htmlLang !== mfLang) {
            pointerProblems.push({
              what: `lang ${mfLang}`,
              why: `start_url 那一頁的 <html lang> 是 ${htmlLang} —— 兩邊講的是同一個語言，寫法要一樣。`,
            });
          }
        }
      }
    }

    const compared = readable ? pairs.filter((p) => p.got !== null && p.want !== null) : [];
    saw('manifest-drift', compared.length + pointersChecked);

    for (const pp of pointerProblems) {
      problems.push({
        file: 'public/site.webmanifest',
        id: 'manifest-drift',
        msg:
          `${pp.what} 指到的東西不對。\n      ${pp.why}\n` +
          '      改法：改 public/site.webmanifest，或把那個檔案放進 public/。',
      });
    }

    if (!readable) {
      notes.push(
        `site.webmanifest 沒有比對：public/site.webmanifest ` +
          `${rawManifest.trim() === '' ? '讀不到' : '不是合法的 JSON'}。\n` +
          '    不是「一致」，是**沒有比對到**。',
      );
    } else if (compared.length < pairs.length) {
      notes.push(
        `site.webmanifest 只比對了 ${compared.length}／${pairs.length} 項 —— 抽不到的：` +
          pairs.filter((p) => !compared.includes(p)).map((p) => p.key).join('、') +
          '。\n    不是「一致」，是**沒有比對到**。',
      );
    }

    for (const p of compared) {
      const got = /** @type {string} */ (p.got);
      const want = /** @type {string} */ (p.want);
      const ok =
        p.how === 'color'
          ? got.toLowerCase() === want.toLowerCase()
          : p.how === 'prefix'
            ? want.startsWith(got)
            : got === want;
      if (ok) continue;
      problems.push({
        file: 'public/site.webmanifest',
        id: 'manifest-drift',
        msg:
          `${p.key} 跟 ${p.from} 對不起來。\n` +
          `      manifest：${got}\n` +
          `      ${p.from}：${want}\n` +
          (p.how === 'prefix'
            ? '      這一項只要求 manifest 的描述是 site.ts 那句的開頭（短版是刻意的）。\n'
            : '') +
          '      這份 manifest 是手寫的靜態檔，安裝成 App 之後顯示的就是它。\n' +
          '      改法：改 public/site.webmanifest，或改 src/config/site.ts —— 兩份要說同一件事。',
      });
    }
  }

  saw('locale-list-drift', found.length);
  if (found.length < sources.length) {
    notes.push(
      '語言清單只比對了 ' + found.length + '／' + sources.length + ' 份 —— 抽不到的：' +
        sources.filter((x) => !found.includes(x)).map((x) => x.where).join('、') +
        '。\n    不是「一致」，是**沒有比對到**。抽取的正則可能跟不上寫法了。',
    );
  }
  if (found.length > 1) {
    const key = (/** @type {string[]} */ l) => [...l].sort().join('|');
    const base = key(/** @type {string[]} */ (found[0].list));
    const off = found.slice(1).filter((x) => key(/** @type {string[]} */ (x.list)) !== base);
    for (const x of off) {
      problems.push({
        file: x.where.replace(/（.*/, ''),
        id: 'locale-list-drift',
        msg:
          `語言清單跟 ${found[0].where} 對不起來。\n` +
          `      ${found[0].where}：${/** @type {string[]} */ (found[0].list).join('、')}\n` +
          `      ${x.where}：${/** @type {string[]} */ (x.list).join('、')}\n` +
          '      這四份講的是同一件事（型別、frontmatter 驗證、路由、hreflang 對照），\n' +
          '      不一樣的話會出現「路由得到但型別沒有」或反過來的頁面。\n' +
          '      改法：四個地方一起改 —— 但先確認真的要加語言（`不加日文` 是專案的硬性限制）。',
      });
    }
  }
}

/*
 * ── `src/content/` 底下的資料夾，都註冊了嗎 ────────────────
 *
 * 第 3 輪（第四十二圈）加的。這一圈問「這份清單是誰維護的？漏一個會怎樣？」
 *
 * `content.config.ts` 最後一行是一份**手寫的註冊表**：
 *
 *     export const collections = { posts, poems, notes, external };
 *
 * 今天四個名字剛好對上 `src/content/` 底下的四個資料夾 —— 而**沒有東西在比**。
 *
 * 實測漏一個會怎樣：把一篇 md 放進沒有註冊的 `src/content/essays/`，
 * 然後跑一次全套：
 *
 *   build              44 頁（**沒有變**，那一篇一頁都沒有）
 *   check:content      「**7 篇內容**」（它把那一篇算進去了）
 *   離開碼             **0**
 *
 * 也就是說她寫了一篇、檢查器數到了、而站上沒有它，**沒有任何一道關卡出聲**。
 * Astro 的 glob 是逐個 collection 掛的，沒註冊的資料夾就是不存在。
 *
 * 這一段要在「補 0」那一行**之前** —— 它自己會 `saw()`。
 * （同一個形狀在這個 repo 犯到第十二次了，所以每一次都留這句話。）
 */
{
  const configText = await readFile(resolve(SRC, 'content.config.ts'), 'utf8').catch(() => null);
  /** 註冊表裡的名字 —— 從 `export const collections = { … }` 抽 */
  const registered = new Set(
    [...(/export const collections\s*=\s*\{([^}]*)\}/.exec(configText ?? '')?.[1] ?? '')
      .matchAll(/([a-zA-Z][\w]*)/g)].map((m) => m[1]),
  );
  /** `src/content/` 底下真的有哪些資料夾 */
  const dirs = (await readdir(CONTENT, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (configText === null || registered.size === 0) {
    notes.push(
      'content.config.ts 讀不到、或抽不到 `collections` 那一行 —— ' +
        '**「資料夾有沒有註冊」這一格沒有在守**。\n' +
        '    那一行換了寫法的話，這裡的樣式要跟著改（不然它會安靜地什麼都不比）。',
    );
    saw('collection-unregistered', 0);
  } else {
    saw('collection-unregistered', dirs.length);
    for (const d of dirs) {
      if (registered.has(d)) continue;
      const files = (await readdir(resolve(CONTENT, d)).catch(() => [])).filter((f) => /\.mdx?$/.test(f));
      problems.push({
        file: `src/content/${d}`,
        id: 'collection-unregistered',
        msg:
          `這個資料夾沒有註冊進 content.config.ts 的 collections（裡面有 ${files.length} 篇）—— ` +
          '**Astro 不會讀它，那幾篇在站上一頁都不會有**，而且建置不會失敗。\n' +
          '      改法：內容放進已經註冊的資料夾' +
          `（${[...registered].join('、')}）；` +
          '真的要開一個新的分類，那要先在 `content.config.ts` 裡定義它。',
      });
    }
    const ghost = [...registered].filter((r) => !dirs.includes(r));
    if (ghost.length > 0) {
      notes.push(
        `collections 註冊了 ${ghost.join('、')}，而 src/content/ 底下沒有這些資料夾 —— ` +
          '不是錯（還沒有那種內容而已），但那幾個名字今天什麼都沒載入。',
      );
    }
  }
}

for (const id of RULES) if (!subjects.has(id)) subjects.set(id, 0);

console.log('\n內容管線檢查\n' + '─'.repeat(56));
/*
 * ── 標題要說「幾條規則」，不只是「幾篇內容」 ──────────
 *
 * 第 3 輪（第二十九圈）問「第一次跑的人跟第一百次跑的人看到的是同一份
 * 東西嗎」。這一行本來說「6 篇內容（草稿 1 篇），產出 50 個檔案」——
 * 說了**掃了什麼**，沒說**用幾條規則掃的**。
 *
 * 同一圈第 1 輪對 `check:a11y` 做過同樣的事。這個 repo 從第二十一圈起的
 * 規矩是「綠燈不說明判斷過什麼，等於沒說」，而規則數是那句話的一半。
 */
/*
 * 「產出 N 個檔案」是**讀進來的**那些，不是 `dist/` 的全部 ——
 * 這一支只讀 html／json／xml／txt／webmanifest（圖片、CSS、CNAME 不在裡面）。
 * 第 3 輪（第三十五圈）拿 `find dist -type f` 對照得到 61，跟當時的 50 差 11，
 * 追下去差的就是這個。50 是對的，只是沒說是哪 50 個。
 *
 * **第 3 輪（第四十三圈）補了 `.webmanifest`。** 那次算清楚差的 11 個是
 * 誰：圖片 7、CSS 2、CNAME 1 —— 加起來只有 10。第 11 個是
 * `site.webmanifest`，而上面那句話沒有提到它。它是 JSON，只是副檔名不同，
 * 裡面有站名與描述（安裝成 App 之後顯示的就是那個名字）。
 * `audit:privacy` 第 5 輪（第十圈）為同一件事踩過同一個坑，
 * 那支的註解寫著「`public/site.webmanifest` 整個在視野外 ——
 * 不是有人決定不掃它」。這一支到今天才補上。
 */
console.log(
  `${entries.length} 篇內容（草稿 ${entries.filter((e) => e.draft).length} 篇）` +
    `，讀了產出裡 ${built.length} 個 html／json／xml／txt／webmanifest，${RULES.length} 條規則。`,
);

/*
 * ── 一篇內容都沒有，那不是「沒有問題」──────────────────
 *
 * 第 3 輪（第二十五圈）量到的：`--content=` 指到一個空目錄時，這支腳本印
 *
 *     0 篇內容（草稿 0 篇），產出 2 個檔案。
 *     沒有發現問題。
 *     這次沒有東西可看的規則（12 條）：⋯
 *
 * 然後 exit 0。那份「沒東西可看」的名單是誠實的（14 條裡 12 條真的沒東西），
 * 但**判決那一行仍然是綠的** —— 十四條規則裡有十二條沒有跑過。
 *
 * 跟第 1 輪（第二十五圈）在 check-a11y 補的是同一件事：
 * dist 是空的它已經會擋（上面那一支），內容是空的卻不會。
 * 兩邊都是「找錯地方」會發生的事，兩邊都該說出來。
 */
if (contentFiles === 0) {
  console.log(
    '\nX 一篇內容都沒有 —— 這不是「沒有問題」，是十四條規則裡有十二條沒東西可判斷。\n' +
      `  找的是 ${CONTENT} 底下的 .md／.mdx。\n` +
      '  改法：確認那個路徑對不對；如果是用 --content= 指過來的，看看是不是指錯了。\n',
  );
  process.exit(1);
}
/*
 * ── 哪些欄位是「宣告了，但沒有任何一篇用過」──────────
 *
 * 這是同一個問題換一個角度問。第 3 輪（第十五圈）量到：
 * schema 宣告 33 個欄位，其中 **8 個沒有任何一篇內容用過**
 * （`alsoOn`、`canonicalUrl`、`cover`、`coverAlt`、`inResponseTo`、
 * `related`、`updatedAt`、`videoUrl`），而它們在 `src/` 底下有 **49 處消費者**。
 *
 * 也就是說有 49 段畫面與 SEO 的程式碼**從來沒有跟真資料跑過**。
 * 所有檢查都是綠的，但那些路徑根本沒有出現在產出裡可以被檢查。
 * 這不是 bug，是「還沒有內容」的另一個面貌 —— 值得說出來而不是留在心裡。
 *
 * ## 抽欄位名為什麼敢用正則
 *
 * 因為它會自己驗自己：**內容裡實際用到的欄位，一定要抽得到**。
 * 對不上就代表抽取方式有洞，那時印的是「這一段沒有執行」而不是一份錯名單。
 * 實測有效：第一版漏了 `lang: LOCALE`（值不是 `z.` 開頭）與寫在同一行的
 * `gloss: z.string()`，兩次都是被這個自我檢查抓出來的。
 */
const SCHEMA_STRUCTURAL = new Set(['loader', 'schema', 'type', 'base', 'message', 'error']);
let fieldReport = '';
{
  /* 走 SRC 不是寫死的 ROOT —— 不然測試換不掉，這一段就只驗得到真的 repo
     （第 3 輪〔第三十一圈〕在語言清單那條踩過同一件事） */
  const src = await readFile(resolve(SRC, 'content.config.ts'), 'utf8').catch(() => '');
  /** 抽到的所有名字（還沒扣掉結構性的那些）—— 底下要拿它算「哪幾條豁免什麼都沒擋」 */
  const extracted = new Set([
    ...[...src.matchAll(/^\s{2,}([a-zA-Z][a-zA-Z0-9_]*):\s*\S/gm)].map((m) => m[1]),
    ...[...src.matchAll(/\b([a-zA-Z][a-zA-Z0-9_]*):\s*z\./g)].map((m) => m[1]),
  ]);
  const declared = new Set(
    [...extracted].filter((n) => !SCHEMA_STRUCTURAL.has(n)),
  );
  /*
   * ── 那份排除清單，哪幾條什麼都沒擋 ──────────────────
   *
   * 第 3 輪（第三十二圈）問「如果第一版就寫錯，今天有沒有東西會說話」。
   * `SCHEMA_STRUCTURAL` 有 6 個名字，實測**只有 3 個真的濾到東西**
   * （`loader`、`schema`、`error`）。另外三個：
   *
   *   `type`、`message` —— `content.config.ts` 裡一次都沒出現
   *   `base`           —— 出現 4 次，但都寫在 `glob({ base: … })` 裡面，
   *                        而抽取的正則只認**行首**那種，所以從來沒抽到它
   *
   * 也就是說那份清單的第一版是**猜**哪些名字會被抽到 —— 一半猜錯了，
   * 而猜錯的那一半跟猜對的一樣安靜。
   *
   * 不刪 —— 跟 `audit:privacy` 的豁免名單同一個處理：讓它每一輪自己說出來。
   * （那一條是第 5 輪〔第二十八圈〕加的，理由一模一樣。）
   */
  const idleExempt = [...SCHEMA_STRUCTURAL].filter((n) => !extracted.has(n)).sort();
  if (idleExempt.length > 0) {
    notes.push(
      `SCHEMA_STRUCTURAL 有 ${SCHEMA_STRUCTURAL.size} 個名字，這一輪` +
        `**${idleExempt.length} 個什麼都沒擋**：${idleExempt.join('、')}。\n` +
        '    抽取的正則根本沒抽到它們，所以排不排除都一樣。\n' +
        '    不是錯，但那幾行看起來像在守什麼，其實沒有 —— 要刪還是要修正則，站主決定。',
    );
  }

  /*
   * ── 第二把尺：Astro 自己說 schema 有哪些欄位 ──────────────
   *
   * 上面那兩條正則是**我寫的**，`declared` 是它們的答案。而底下兩條規則
   * （`field-undocumented`、`guide-field-unknown`）整個站在那個答案上。
   *
   * 原本只有一個自我檢查：「內容真的用過的欄位，有沒有全部抽到」——
   * 那只驗得到**內容用過的**那些。宣告了但還沒有人寫過的欄位（`related`
   * 就是這樣的一個），抽漏了不會有任何人說話：`field-undocumented` 少查一格，
   * 而 `guide-field-unknown` 會反過來**誣賴指南**教了一個「不存在」的欄位。
   *
   * 第 3 輪（第四十五圈）找到的第二把尺：`astro sync` 會把每個 collection 的
   * zod schema 寫成 `.astro/collections/*.schema.json`。那是 **Astro 自己**
   * 從 schema 推出來的，跟我的正則完全無關 —— 拿它來對，抽漏就會顯出來。
   *
   * 導入時實測：Astro 說 26 個，正則抽到 33 個（多的 7 個是
   * `annotations`／`related` 裡面的巢狀欄位，那些也是真的可以寫的），
   * **一個都沒漏**。所以只單向斷言「Astro 有的，正則不能沒有」。
   *
   * 那個目錄是產生的（在 `.gitignore` 裡），跟 `dist/` 同一種東西。
   * 沒有它的時候不當作過關，而是說出「這一把尺不在」。
   */
  const collectionsDir = resolve(dirname(ASTRO_CONFIG), '.astro/collections');
  /** @type {Set<string>} Astro 自己寫出來的欄位名 */
  const astroFields = new Set();
  for (const f of (await readdir(collectionsDir).catch(() => [])).filter((f) => f.endsWith('.schema.json'))) {
    const raw = await readFile(resolve(collectionsDir, f), 'utf8').catch(() => '');
    try {
      for (const k of Object.keys(JSON.parse(raw)?.properties ?? {})) {
        if (k !== '$schema') astroFields.add(k);
      }
    } catch {
      /* 壞掉的 JSON 就當作這一份沒有 —— 底下會因為總數對不上而說話 */
    }
  }
  const missedByRegex = [...astroFields].filter((n) => !declared.has(n) && !SCHEMA_STRUCTURAL.has(n)).sort();

  const unreadable = [...usedFields].filter((u) => !declared.has(u));
  if (declared.size === 0 || unreadable.length > 0 || missedByRegex.length > 0) {
    fieldReport =
      '\n欄位使用情況沒有檢查：content.config.ts ' +
      (declared.size === 0
        ? '讀不到或抽不到欄位。'
        : missedByRegex.length > 0
          ? `Astro 自己的 schema 有 ${missedByRegex.join('、')}，這支腳本的正則沒抽到。`
          : `抽不到內容用過的 ${unreadable.join('、')}。`) +
      '\n  （寧可說「沒查」，也不要印一份可能是錯的名單。）\n';
  } else {
    if (astroFields.size === 0) {
      notes.push(
        '欄位抽取只有一把尺：`.astro/collections/*.schema.json` 不在，' +
          '所以「正則有沒有抽漏」這一關這次沒有跑。\n' +
          '    那個目錄是 `astro sync`／`astro build` 產生的 —— 先跑一次 `npm run build`。',
      );
    }
    /*
     * ── schema 有這個欄位，`docs/CONTENT.md` 說過嗎 ──────────
     *
     * 第 3 輪（第二十四圈）加的。「可以寫哪些欄位」這件事寫在兩個地方：
     * 這支腳本上面讀的 `content.config.ts`（程式認的），與 `docs/CONTENT.md`
     * （她照著抄的）。當時量出來兩邊差 2 個：`related` 與 `updatedAt` ——
     * `related` 的畫面早就寫好了（詩頁最下面的「相關的詩」），
     * 只是唯一會用它的人不知道它存在。
     *
     * 判準刻意用「以程式碼的樣子出現」而不是「文件裡有這個詞」：
     * 欄位名很多是普通字（`title`、`url`、`source`、`why`），
     * 在內文裡撞到一次太容易了。要嘛在 ``` 區塊裡、要嘛被反引號包起來，
     * 才算真的教過怎麼寫。導入時 33 個欄位全數通過，所以沒有例外名單。
     */
    const doc = await readFile(GUIDE, 'utf8').catch(() => '');
    if (doc === '') {
      notes.push('欄位文件沒有檢查：讀不到 docs/CONTENT.md。');
    } else {
      const asCode =
        [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n') +
        '\n' +
        [...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join('\n');
      saw('field-undocumented', declared.size);
      for (const f of [...declared].sort()) {
        if (new RegExp('\\b' + f + '\\b').test(asCode)) continue;
        problems.push({
          file: 'docs/CONTENT.md',
          id: 'field-undocumented',
          msg:
            `schema 有 \`${f}\` 這個欄位，但寫作指南從頭到尾沒教過怎麼寫它。\n` +
            '      改法：在 docs/CONTENT.md 相對應的章節補一段，' +
            '把欄位名放進 ``` 範例或用反引號包起來；\n' +
            '      如果它其實不是她要寫的欄位，加進這支腳本的 SCHEMA_STRUCTURAL。',
        });
      }

      /*
       * ── 反過來那一半：指南教的欄位，schema 還有嗎 ──────────
       *
       * 上面那個迴圈從 `declared` 走到指南 —— 只證明「schema 有的都教過」。
       * 反過來沒有人看：**指南教一個 schema 已經沒有的欄位，不會有任何人說話。**
       *
       * 後果不是報錯，是更安靜的一種：zod 物件預設會把不認得的鍵**直接丟掉**。
       * 她照著指南寫了 `videoUrl:`，而那個欄位哪天被拿掉了 ——
       * 建置不會紅、畫面不會變、frontmatter 裡那一行就這樣什麼都不做。
       *
       * 第 3 輪（第三十四圈）：這一圈問「這個答案系統裡已經有了嗎」——
       * 有，`declared` 就在上面那一行，只是沒有人往回問一次。
       * 量到的是 23 個範例欄位、0 個對不上（`term`／`gloss` 這種巢狀的也算得到，
       * 因為抽取有第二條樣式 `name: z.`）。
       */
      const fmBlocks = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
        .map((m) => m[1])
        .filter((b) => b.trimStart().startsWith('---'));
      /** @type {Map<string, number>} 指南範例裡出現過的 frontmatter 鍵 */
      const guideKeys = new Map();
      for (const b of fmBlocks) {
        const parts = b.split('---');
        for (const line of (parts.length >= 3 ? parts[1] : b).split('\n')) {
          const m = /^\s*(?:-\s*)?([a-zA-Z][\w]*)\s*:/.exec(line);
          if (m) guideKeys.set(m[1], (guideKeys.get(m[1]) ?? 0) + 1);
        }
      }
      saw('guide-field-unknown', guideKeys.size);
      const unknownKeys = [...guideKeys.keys()].filter((k) => !declared.has(k)).sort();
      for (const k of unknownKeys) {
        problems.push({
          file: 'docs/CONTENT.md',
          id: 'guide-field-unknown',
          msg:
            `寫作指南的範例教了 \`${k}\`，但 content.config.ts 裡沒有這個欄位。\n` +
            '      照著寫的話那一行會被 zod 安靜丟掉 —— 建置不紅、畫面不變、什麼都不會發生。\n' +
            '      改法：欄位改名或刪掉的話，指南的範例要跟著改；' +
            '如果它是新加的欄位，先把 content.config.ts 補上。',
        });
      }
    }
    const never = [...declared].filter((d) => !usedFields.has(d)).sort();
    if (never.length > 0) {
      fieldReport =
        `\nschema 宣告了、但沒有任何一篇內容用過的欄位（${never.length}／${declared.size}）：` +
        `${never.join('、')}\n` +
        '  畫面上讀這些欄位的程式碼從來沒有跟真資料跑過。不是問題，是還沒有內容。\n';
    }
  }
}

/*
 * ── `--verbose` 印出每條規則判斷過幾個東西 ──────────
 *
 * 第 3 輪（第二十一圈）加的，跟第 1、2 輪在 a11y 與 perf 上做的是同一件事：
 * 第十五圈問「有沒有東西可看」（0 或非 0），這一圈問**數量**。
 *
 * 量出來最值得記的一項：`draft-page`、`draft-unscannable`、`draft-leaked`
 * 三條的主體數都是 **1** —— 站上只有一個草稿，而那一個是範本
 * （`external/EXAMPLE-threads.md`）。守「草稿不能外洩」的三條規則，
 * 綠燈涵蓋的是一個範本檔。她真的開始寫草稿之後，它們才第一次做事。
 */
const VERBOSE = process.argv.includes('--verbose');

/*
 * 這一行要印在最前面：下面每一條「產出裡找不到」都可能只是它造成的。
 * 沒有這一行的話，站主會照著那些訊息去找一個不存在的 bug。
 */
if (staleDist) {
  const mins = Math.round((newestContent - newestBuilt) / 60_000);
  console.log(
    `\n  ⚠ dist/ 比 src/content 舊了大約 ${mins} 分鐘 —— 先跑 npm run build 再看下面的結果。`,
  );
}

/*
 * ── 同步的資料放了多久 ──────────────────────────────
 *
 * 第 3 輪（第二十六圈）問「壞了誰會告訴我們」，量到的：
 *
 *   `/colophon` 印的是「上次同步：<日期>　來源狀態：1 個正常」。
 *   而那個「1 個正常」是**上一次真的跑過的那一輪**記下來的狀態 ——
 *   排程從此不再觸發的話，這一頁會**永遠**說「1 個正常」。
 *   一個停掉的排程，跟一個健康的排程，在這一頁上長得一模一樣。
 *
 * （2026-09-11 `/colophon` 整頁移除了。那個「來源狀態」搬到 `/elsewhere`，
 * 而且改成**只在讀不到的時候才說話** —— 但底下這個鬧鐘要守的東西沒變：
 * 它看的是「排程有沒有跑」，那件事**任何一頁都看不出來**。）
 *
 * 讀者那邊也不會通報：他們看到一個日期，但沒有理由知道它該多新。
 * 而 workflow 真的停了的話，GitHub 上不會有紅色的執行紀錄 ——
 * 沒有跑，就沒有紀錄。
 *
 * ## 為什麼是「說出來」而不是「擋下來」
 *
 * 剛 clone 下來的機器、或者只是幾天沒同步，資料本來就會舊。
 * 擋下來等於製造誤報，而誤報會讓人學會忽略整道關卡（這個 repo 記過很多次）。
 * 所以印成一則 note：每次跑關卡的人都看得到，而它不會擋任何人。
 *
 * 門檻 3 天是從排程推出來的：`sync-feeds.yml` 是一天兩次
 * （臺北 08:00／20:00），3 天代表**至少六次沒有跑到**，
 * 不會是一次網路不好造成的。
 */
const SYNC_STALE_DAYS = 3;
{
  const raw = await readFile(SYNDICATION, 'utf8').catch(() => null);
  if (raw === null) {
    notes.push('同步資料的新舊沒有檢查：讀不到 src/data/syndication.json。');
  } else {
    /**
     * @type {{
     *   $schema?: string,
     *   generatedAt?: string,
     *   sources?: Record<string, { lastSuccessAt?: string | null, status?: string }>,
     *   items?: { externalId?: string, url?: string, publishedAt?: string }[],
     * }}
     */
    let data = {};
    let parsed = false;
    try {
      data = JSON.parse(raw);
      parsed = true;
    } catch {
      notes.push('同步資料的新舊沒有檢查：src/data/syndication.json 不是合法的 JSON。');
    }

    /*
     * ── 那份 schema 從第一個 commit 就在，而沒有人執行過它 ────────────
     *
     * 第 4 輪（第三十六圈）量的。`npm run verify -- --patterns` 打的是
     * **網路**（這一輪實測 11 個平臺全部 200）；沒有任何一支看**資料本身**。
     * 而站上算繪用的是資料，不是網路。
     *
     * `src/data/syndication.json` 的第二行寫著
     * `"$schema": "./syndication.schema.json"`，那個檔案真的存在
     * （draft-07，宣告了 13 個欄位、其中 5 個必填），
     * `git grep syndication.schema` 只有兩個結果：寫出那一行的 sync-core，
     * 跟那一行本身。**編輯器會讀它，關卡不會。**
     *
     * 邊界外面有多少東西：9 筆 × 13 欄 + 1 個來源 + itemCount。
     *
     * 這不是理論上的漏洞，實測過：把第一筆的 `url` 改名成 `urlx`（少一個必填欄），
     * `npm run build` **成功**，六道關卡**全綠**，兩套測試也全綠。
     * 產出裡那一筆變成
     *     `<a class="synd__link" target="_blank" rel="noopener noreferrer">`
     * —— **一個沒有 href 的 <a>**，出現在 6 個頁面上。
     * 它看起來跟正常的卡片一模一樣，但點不動、也 tab 不到。
     *
     * check:a11y 看不到它是**設計使然**：那裡每一條跟連結有關的規則
     * 都以 `<a ... href=` 開頭，或是 `if (href === null) continue;`
     * —— 沒有 href 的 <a> 依定義不是連結，所以每一條都正確地跳過它。
     * （站上平常一個都沒有：還原之後重數是 0 個。）
     *
     * 消費端也擋不住：`lib/syndication.ts` 對**選填**欄位有 `??` 退路
     * （media、summary、lang、tags、thumbnail），對那 5 個必填欄位一個都沒有。
     * 正好就是沒有退路的那幾個沒有人在守。
     *
     * 驗證器讀的是那份 schema 檔本身，不是手寫第二份「必填有哪些」——
     * 手寫第二份就是這個 repo 一再犯的「同一件事寫在兩個地方」。
     */
    if (parsed) {
      /*
       * 跟著資料自己宣告的 `$schema` 走，而不是把路徑寫死 ——
       * 寫死的話，哪天那一行改指到別的檔案，這裡還會對著舊的驗得好好的。
       */
      const pointer = typeof data.$schema === 'string' ? data.$schema : null;
      if (pointer === null) {
        notes.push(
          '同步資料沒有宣告 $schema，所以沒有拿合約驗過它。\n' +
            '    src/data/syndication.schema.json 還在，但沒有東西指著它了。',
        );
        saw('syndication-schema', 0);
      } else if (!/^\.{0,2}\//.test(pointer)) {
        /* 遠端的 meta-schema 要連外才拿得到，這個站零第三方請求，不連 */
        notes.push(`同步資料的 $schema 指到 ${pointer} —— 不是本地路徑，沒有驗。`);
        saw('syndication-schema', 0);
      } else {
        const schemaPath = resolve(dirname(SYNDICATION), pointer);
        const schemaRaw = await readFile(schemaPath, 'utf8').catch(() => null);
        if (schemaRaw === null) {
          problems.push({
            file: relative(ROOT, SYNDICATION),
            id: 'syndication-schema',
            msg:
              `$schema 指到 ${pointer}，但那個檔案讀不到（找的是 ${relative(ROOT, schemaPath)}）。\n` +
              '      資料的形狀從此沒有人在守，而站上算繪用的就是這份資料。\n' +
              '      改法：把 schema 檔補回來，或把 $schema 那一行改成它現在的位置\n' +
              '      （寫出那一行的是 scripts/lib/sync-core.mjs）。',
          });
          saw('syndication-schema', 0);
        } else {
          let schema = null;
          try {
            schema = JSON.parse(schemaRaw);
          } catch {
            problems.push({
              file: relative(ROOT, schemaPath),
              id: 'syndication-schema',
              msg:
                'schema 檔本身不是合法的 JSON，所以沒辦法拿它驗任何東西。\n' +
                '      改法：用 node -e "require(\'./' + relative(ROOT, schemaPath) + '\')" 看它壞在哪一行。',
            });
          }
          if (schema !== null) {
            /*
             * 這支只實作了 draft-07 的一小塊。看不懂的關鍵字要**說出來**，
             * 不能安靜略過 —— 安靜略過的話，「schema 寫了、驗證器看不懂、於是綠燈」
             * 會被讀成「合約有人在守」。
             */
            const blind = unsupported(schema);
            if (blind.length > 0) {
              notes.push(
                `schema 裡有 ${blind.length} 個關鍵字這支看不懂，那幾條沒有驗到：\n` +
                  '      · ' + blind.join('\n      · ') + '\n' +
                  '    scripts/lib/validate-schema.mjs 的 SUPPORTED 決定看得懂哪些。',
              );
            }
            const { errors, nodes } = validate(data, schema);
            saw('syndication-schema', nodes);
            for (const e of errors.slice(0, 12)) {
              problems.push({
                file: relative(ROOT, SYNDICATION),
                id: 'syndication-schema',
                msg:
                  `${e}\n` +
                  `      比對的合約：${relative(ROOT, schemaPath)}（資料自己的 $schema 指的）。\n` +
                  '      少一個必填欄不會讓建置失敗 —— 站上會多出一個沒有 href 的 <a>，\n' +
                  '      看起來跟正常的卡片一樣，但點不動也 tab 不到。\n' +
                  '      改法：這份是 scripts/sync-feeds.mjs 產生的，不要手改 ——\n' +
                  '      跑 npm run sync 重生一次；還是一樣的話是 normalize 那一段變了。',
              });
            }
            if (errors.length > 12) {
              notes.push(`syndication-schema 還有 ${errors.length - 12} 個錯誤沒列出來。`);
            }
          }
        }
      }
    }

    /*
     * ── 站上那一篇的日期，要跟它在外站的發佈時刻一致 ──────────────
     *
     * 站主 2026-09-09 定的：接了外站作品的內容（現在是 `videoUrl`，
     * 以後串別的平臺也一樣），`publishedAt` 用**那個平臺的發佈時刻**，
     * 不是把頁面寫出來的那一天。
     *
     * 這條為什麼值得一條規則：這件事**沒有任何自動的力量在維持**。
     * 那九篇的日期是人手抄過去的，而 `syndication.json` 是排程每天重寫的 ——
     * 哪天 feed 那邊的時刻變了（重新上傳、改成公開的時間不同），
     * 兩邊就分岔，而分岔的樣子是「同一支影片在 /elsewhere 寫 10月22日、
     * 在詩頁寫 10月26日」，兩頁都不會壞，也沒有人會被通知。
     *
     * 訂之前這九篇**全部都不一致**（差了將近兩年），所以這不是預防性的規則。
     *
     * 比的是**臺北日**不是時刻：frontmatter 允許只寫到日
     * （`publishedAt: 2024-10-22` 是合法的），而畫面上顯示的就是臺北日。
     * 比到秒的話，寫成只有日期的那些會全部誤報。
     */
    const taipeiDay = (/** @type {string | undefined} */ iso) => {
      const t = iso ? Date.parse(iso) : NaN;
      if (Number.isNaN(t)) return null;
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(t));
    };

    const feedItems = parsed ? (data.items ?? []) : [];
    if (feedItems.length === 0) {
      notes.push('外站日期一致性沒有檢查：syndication.json 裡沒有可比對的項目。');
    } else {
      const byVideoId = new Map(
        feedItems.filter((it) => it.externalId).map((it) => [it.externalId, it]),
      );
      for (const e of entries) {
        const videoUrl = field(e.text, 'videoUrl');
        if (!videoUrl) continue;
        /* watch?v= / youtu.be/ / shorts/ 三種都要認得 —— 跟詩頁那支 youtubeId() 對齊 */
        const vid = videoUrl.split(/[?&]v=|youtu\.be\/|\/shorts\//).pop()?.split(/[?&]/)[0];
        const item = vid ? byVideoId.get(vid) : undefined;
        if (!item) {
          notes.push(`外站日期：${e.rel} 的 videoUrl 在 syndication.json 裡找不到（${vid ?? '取不出 id'}）。`);
          continue;
        }
        saw('external-date-drift', 1);
        const mine = taipeiDay(field(e.text, 'publishedAt'));
        const theirs = taipeiDay(item.publishedAt);
        if (mine && theirs && mine !== theirs) {
          problems.push({
            file: e.rel,
            id: 'external-date-drift',
            msg:
              `publishedAt 是 ${mine}，但這支影片在 YouTube 上是 ${theirs}（都換算成臺北日）。\n` +
              '      站上這一篇跟外站是同一件作品，日期要一樣 ——\n' +
              '      否則同一支影片在 /elsewhere 跟在詩頁上會寫著不同的日子。\n' +
              `      改法：把 publishedAt 換成 ${item.publishedAt}（照抄 syndication.json 那一筆）。`,
          });
        }
      }
    }

    const at = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
    if (Number.isNaN(at)) {
      if (raw !== null && Object.keys(data).length > 0) {
        notes.push('同步資料的新舊沒有檢查：generatedAt 讀不出日期。');
      }
    } else {
      /*
       * 這裡不進 RULES，也不呼叫 saw()。
       *
       * 那兩個是給「會不會報 problem」的規則用的 —— 第一版把它登記成規則，
       * 結果它出現在「這次沒有東西可看的規則」名單裡，
       * 而那份名單講的是「站上沒有這種內容」，跟這件事完全不同。
       * 這一項本來就只會說話、不會擋。
       */
      const days = (Date.now() - at) / 86_400_000;
      if (days > SYNC_STALE_DAYS) {
        notes.push(
          `同步的資料已經 ${days.toFixed(1)} 天沒更新了（sync-feeds 是一天兩次，` +
            `也就是至少 ${Math.floor((days * 2) - 1)} 次沒跑到）。\n` +
            '    畫面上看不出來：`/elsewhere` 的「上次同步」是**上一次真的跑過**時記下的日期，\n' +
            '    而「讀不到」那一行只在來源本身出事時才出現 —— 排程整個停掉的話兩者都不會動。\n' +
            '    改法：跑一次 npm run sync；如果是排程本身停了，去 GitHub 的 Actions 看 sync-feeds.yml。',
        );
      }

      /*
       * ── 上面那個鬧鐘看的是「排程有沒有跑」，不是「來源有沒有活著」──
       *
       * 第 4 輪（第三十圈）量到的：`sync-feeds.yml` **終於第一次觸發了**
       * （2026-09-05 04:07 UTC，排程 `0 0,12` 遲了四個多小時），
       * 而那一次的紀錄是 `status: "error"` —— YouTube 的 feed 回 404。
       *
       * 那次執行是**綠的**：`npm run sync` 在來源全部失敗時離開碼仍然是 0
       * （實測），commit message 還寫「共 9 筆」。站上不受影響（沿用快取）。
       *
       * 問題在這裡：**`generatedAt` 每跑一次就更新，不管來源成不成功。**
       * 排程一天兩次，所以上面那個「3 天沒更新」的鬧鐘從今天起**永遠不會響**
       * —— 即使這個來源已經死了好幾個月。
       *
       * 鬧鐘的錶被它要監視的東西自己撥快了。
       *
       * 而真正能回答「上次真的拿到資料是什麼時候」的欄位一直都在：
       * `lastSuccessAt`。`sync-core.mjs` 會寫它、失敗時刻意保住舊值、
       * `lib/syndication.ts` 有型別、`test-sync-core.mjs` 有兩格在守它 ——
       * **然後沒有任何一個地方讀它來報警。**
       *
       * 沿用同一個 3 天的門檻（不另訂一個），一樣只說話、不擋。
       */
      /*
       * 判斷搬到 scripts/lib/sync-health.mjs 了 —— 第 4 輪（第三十八圈）
       * 追出來這個鬧鐘從排程那條路走不到（來源全掛時 deploy 根本不會跑），
       * 所以 `npm run sync:health` 也要問同一句。門檻是同一個常數。
       */
      const { total: sourceCount, cold: coldSources } = sourceHealth(data);
      const cold = coldSources.map((c) => `      · ${coldLine(c)}`);
      if (cold.length > 0) {
        notes.push(
          `${sourceCount} 個來源裡，**${cold.length} 個已經超過 ${STALE_DAYS} 天沒有成功過**：\n` +
            cold.join('\n') +
            '\n    這跟上面那句不是同一件事：`generatedAt` 每跑一次就更新（不管成不成功），\n' +
            '    所以排程活著的時候，那個鬧鐘永遠不會為「來源死掉」響。\n' +
            '    網站不會壞（沿用快取），但顯示的東西會停在那一天。\n' +
            '    改法：npm run verify -- --patterns 實際打一次；真的持續不通再考慮設 YOUTUBE_API_KEY。',
        );
      }
    }
  }
}

/*
 * ── 版面斷點：同一個數字寫在九個地方 ────────────────
 *
 * 第 8 輪（第三十圈）實測：把 `Header.astro` 的
 * `@media (max-width: 34rem)` 改成 `32rem`，重建，跑完
 * **六道關卡加兩套測試 —— 全綠**。
 *
 * 後果是看得見的：在 33rem 寬的視窗上，頁首會停在桌機版面，
 * 而頁尾、分頁、詩塊已經切到手機版面 —— 中間裂一條縫，
 * 而沒有任何一道關卡分得出「刻意的斷點」與「打錯的斷點」。
 *
 * ── 為什麼是清單，不是「全部要一樣」──
 *
 * 這個站真的有四個 max-width 斷點：34rem（9 處）、48rem（2 處）、
 * 52rem、40rem。「全部要一樣」會是**我自己發明的規矩**，而且是錯的。
 *
 * 而 `--w-prose: 34rem` 跟那九個 34rem 數字相同，是巧合不是關係 ——
 * 前者是正文欄寬，後者是手機斷點；把它們綁起來同樣是發明。
 *
 * 所以這裡只做一件真的能做的事：**把有幾種斷點、各幾處數出來**。
 * 34rem 從 9 處變成 8 處、旁邊冒出一個 32rem × 1，讀的人看得見。
 * 一樣只說話、不擋 —— 不進 RULES 也不呼叫 saw()（理由同底下那一段）。
 */
{
  /** 壓縮過的 CSS 寫成 `(width<=34rem)`，沒壓縮的是 `(max-width: 34rem)`，兩種都要認 */
  /** @type {Map<string, number>} */
  const widths = new Map();
  for (const m of servedCss.matchAll(/\(\s*(?:max-width\s*:|width\s*<=)\s*([\d.]+(?:rem|px|em))\s*\)/g)) {
    widths.set(m[1], (widths.get(m[1]) ?? 0) + 1);
  }
  /*
   * ── 這份清單只數 max-width ──────────
   *
   * 第 3 輪（第三十五圈）用第二種算法數斷點，得到跟這裡不一樣的答案
   * （多一個 46rem、48rem 多一處）。追下去我錯了三處：語料掃了 `src/`
   * 連註解一起（那兩個數字都寫在註解裡）、判準把 `min-width` 也算進去、
   * 而且正則的 `[^{]*?` 會跨行配到很遠的 rem。**這裡的 12 是對的。**
   *
   * 但這一行沒說它只數 `max-width` —— 照著它去對的人會得到別的數字。
   * 順手把 `min-width` 也數出來：今天是 **0 處**，也就是這個站的版面
   * 完全是「先寬後窄」那一種寫法。那是一句免費的事實，值得說出來。
   */
  /** @type {Map<string, number>} */
  const minWidths = new Map();
  for (const m of servedCss.matchAll(/\(\s*(?:min-width\s*:|width\s*>=)\s*([\d.]+(?:rem|px|em))\s*\)/g)) {
    minWidths.set(m[1], (minWidths.get(m[1]) ?? 0) + 1);
  }
  const minTotal = [...minWidths.values()].reduce((n, c) => n + c, 0);
  const minSaid =
    minTotal === 0
      ? '（只數 max-width；min-width 這一輪 0 處 —— 版面全是先寬後窄那一種寫法）'
      : `（只數 max-width；另有 ${minTotal} 處 min-width：` +
        [...minWidths.entries()].map(([w, c]) => `${w} × ${c}`).join('、') +
        '）';

  if (widths.size === 0) {
    notes.push('版面斷點沒有檢查：送出去的 CSS 裡一個 max-width 查詢都沒有。' + minSaid);
  } else {
    /*
     * 數量多的排前面；一樣多的用**碼位**比，不用 localeCompare ——
     * 不給語言的 localeCompare 跟著 `LANG` 走，`test:portability` 有一格在擋，
     * 而它當場擋下了這一行的第一版。斷點字串都是 ASCII，碼位比較就夠了
     * （`lib/sync-core.mjs` 也是這樣改的）。
     */
    const rows = [...widths.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    notes.push(
      `版面斷點：${rows.length} 種，共 ${rows.reduce((n, [, c]) => n + c, 0)} 處 —— ` +
        rows.map(([w, c]) => `${w} × ${c}`).join('、') +
        `\n    ${minSaid}` +
        '\n    CSS 沒辦法把斷點寫成變數（媒體查詢裡不能用 custom property），所以同一個數字'
        + '是一處一處寫的。\n    這裡不判斷對錯 —— 但一個只出現一次、又跟主要斷點只差一點的數字，'
        + '通常是打錯的。',
    );
  }
}

/*
 * ── translationKey：填了，然後呢 ──────────────────────
 *
 * 第 3 輪（第三十一圈）問「是我們選的，還是它剛好長成這樣」。
 *
 * `content.config.ts` 的說明寫著「同一篇文章的中／英／日版本填一樣的
 * translationKey，頁面就能自動互相連結」。實測：3 篇填了，
 * **每一個 key 都只有一篇** —— `getTranslations()` 的
 * `filter(e => e.data.translationKey === key && e.id !== entry.id)`
 * 從來沒有回過非空的陣列。
 *
 * 那不是決定（沒有人決定「每篇各自獨立」），是**還沒有任何一篇被翻譯過**。
 * 差別在於：填了 key 會讓這個機制看起來已經在跑。
 *
 * 這裡不擋 —— 填了 key 等著將來配對是完全正常的。只是把「幾組真的配成對」
 * 說出來，免得「有人填了」被讀成「有在運作」。
 */
{
  /** @type {Map<string, string[]>} */
  const byKey = new Map();
  for (const e of entries) {
    const key = /^translationKey:\s*(.+?)\s*$/m.exec(e.text)?.[1]?.replace(/^['"]|['"]$/g, '');
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), `${e.collection}/${e.slug}（${e.lang}）`]);
  }
  if (byKey.size > 0) {
    const paired = [...byKey.values()].filter((v) => v.length > 1);
    const filled = [...byKey.values()].reduce((n, v) => n + v.length, 0);
    notes.push(
      `translationKey：${filled} 篇填了、${byKey.size} 個 key，其中 **${paired.length} 組真的配成對**。\n` +
        (paired.length === 0
          ? '    也就是說跨語言互連那條路從來沒有跑過 —— 不是壞了，是還沒有任何一篇被翻譯過。\n' +
            '    填了 key 會讓這個機制看起來已經在運作，所以這裡把數字說出來。'
          : '    配成對的：' + paired.map((v) => v.join(' ↔ ')).join('、')),
    );
  }
}

/*
 * ── 會把她送回自己檔案的規則，她的文件裡要寫 ────────────────
 *
 * 第 3 輪（第三十七圈）加的。這一圈問「這一條規則，是誰要求的？
 * 寫在哪份文件裡？那份文件是給誰看的？」
 *
 * 量出來的：這一支 20 條規則，`docs/CONTENT.md`、`CLAUDE.md`、
 * `ARCHITECTURE.md` 加起來提到 **0 條**。
 *
 * 但「全部都要寫進文件」會是我自己發明的規矩 —— 多數規則報的是 `dist/`、
 * 設定檔或產生出來的資料，那是維護者的事，她不需要知道。
 *
 * 判準用**這條規則會叫誰去改哪個檔案**：報的檔案是 `src/content/` 底下
 * 那一份的，就是她寫的那一份 —— 她會被 CI 擋下來、被指到自己的檔案，
 * 而她的文件裡沒有那個名字。那正是 `check:copy` 的 `rule-not-documented`
 * 當初存在的理由（「照文件寫的人會在 CI 上被擋下來卻不知道為什麼」）。
 *
 * 只要求 `docs/CONTENT.md` 一份，不像文案那五條要求兩份：
 * 那五條同時是寫作約定與寫程式的約定，這幾條只有她會踩到。
 *
 * 排除的那幾條要**說得出理由**，而且 `unknown` 會抓出「排除清單裡有、
 * 但根本不是規則」的 id —— 不然「要寫的 ＋ 不用寫的 ＝ 總數」會假成立。
 */
/** id → 為什麼她不需要知道這一條（報的不是她寫的檔案） */
const NOT_A_WRITER_RULE = new Map([
  ['feed-unreadable', '報的是產出的 feed，壞的是產生 feed 的程式'],
  ['locale-dead-end', '報的是產出的空狀態頁，改法在版面不在內容'],
  ['search-crosslang-mute', '報的是產出的搜尋頁，改法在那一頁的程式'],
  ['linebreak-lost', '報的是全站 CSS 的一條宣告，改法在 PoemBlock.astro 不在內容'],
  ['punct-orphan-risk', '報的是全站 CSS 裡兩條宣告的組合，改法在 global.css 不在內容'],
  ['vertical-keep-all', '報的是直排區塊的一條 CSS 宣告，改法在那個元件不在內容'],
  ['vertical-lost', '報的是全站 CSS'],
  ['listing-order', '報的是列表頁的排序，那是 lib/content.ts 的事不是內容的事'],
  ['domain-drift', '報的是三份設定檔（site.ts／astro.config／CNAME）'],
  ['manifest-drift', '報的是 public/site.webmanifest 與 site.ts，不是她寫的內容'],
  ['locale-list-drift', '報的是設定檔裡的語言清單'],
  ['field-undocumented', '它本身就在要求文件跟 schema 對齊，報的是文件'],
  ['guide-field-unknown', '同上，報的是文件'],
  ['syndication-schema', '報的是 sync-feeds 產生的資料，不要手改'],
  ['rule-not-in-guide', '它本身就在要求這件事，報的也是文件'],
]);
/*
 * 只在對**真的** repo 跑的時候比，或是測試明講了 `--guide=`。
 *
 * 理由跟 check-a11y 的 `--doc=` 一樣：迷你 fixture 沒有那份寫作指南，
 * 比對它的話每一格都會多噴 11 條「文件沒寫」——
 * 那不是那些案例要測的東西（第一版就是這樣，一次紅了兩格）。
 */
if (arg('content') === undefined || arg('guide') !== undefined) {
  const { required: writerRules, excluded, unknown } = documentationDuty(RULES, NOT_A_WRITER_RULE);
  const guide = await readFile(GUIDE, 'utf8').catch(() => null);
  saw('rule-not-in-guide', guide === null ? 0 : writerRules.length);
  if (unknown.length > 0) {
    notes.push(
      `排除清單裡有不存在的規則：${unknown.join('、')} —— ` +
        '那會讓「要寫的 ＋ 不用寫的 ＝ 總數」看起來成立，而其實在數不存在的東西。',
    );
  }
  if (guide === null) {
    notes.push(`讀不到 ${relative(ROOT, GUIDE)} —— 沒有比對過「她該知道哪幾條規則」。`);
  } else {
    notes.push(
      `文件要求：${RULES.length} 條規則裡 **${writerRules.length} 條**會把她指回自己寫的檔案，` +
        `所以要寫進 ${relative(ROOT, GUIDE)}；${excluded.length} 條不用 ——\n` +
        excluded.map((id) => `      · ${id}：${NOT_A_WRITER_RULE.get(id)}`).join('\n'),
    );
    for (const id of writerRules) {
      if (guide.includes(id)) continue;
      problems.push({
        file: relative(ROOT, GUIDE),
        id: 'rule-not-in-guide',
        msg:
          `\`${id}\` 會擋住建置並指到她寫的那個檔案，而這份文件沒有提到它。\n` +
          '      她照文件寫，然後在 CI 上被一個沒看過的名字擋下來。\n' +
          '      改法：在「寫錯的時候會看到什麼」那一節加一列，寫出這條規則\n' +
          '      會說什麼、以及怎麼改。真的不該由她知道的話，把它加進\n' +
          '      check-content.mjs 的 NOT_A_WRITER_RULE 並寫下理由。',
      });
    }
  }
}

/*
 * ── 這一段一定要在**所有規則都跑完之後** ────────────
 *
 * 它把 `subjects` 收成「這次沒有東西可看的規則」那份名單。在它上面
 * 呼叫的 `saw()` 才數得到；在它下面呼叫的，名單會把那條規則說成 0。
 *
 * 第 4 輪（第三十六圈）踩到：新加的 `syndication-schema` 明明判斷了
 * 155 個節點，輸出卻把它列在「沒有東西可看」裡 —— 因為那個 saw()
 * 在原本這一段的 143 行之後。**那是這個 repo 一犯再犯的形狀**
 * （東西插在它的消費者後面），而且錯得很安靜：名單看起來很正常。
 *
 * 所以搬到這裡，而不是把新規則往上塞 —— 往上塞的話，下一條新規則
 * 還是會掉進同一個坑。這裡是最後一條規則跑完的地方。
 */
if (VERBOSE) {
  console.log('\n每條規則實際判斷過的東西：');
  for (const [id, n] of [...subjects.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${id}`);
  }
}

const idle = [...subjects.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
const idleReport =
  idle.length === 0
    ? ''
    : `\n這次沒有東西可看的規則（${idle.length} 條）：${idle.join('、')}\n` +
      '  它們是綠的，但那不是「檢查過而且沒問題」，是「沒有這種內容」。\n' +
      '  站上有了那種內容，這幾條才第一次真的在守。\n';

for (const n of notes) console.log(`\n  · ${n}`);

if (problems.length === 0) {
  console.log('\n沒有發現問題。');
  /*
   * ── 那個能回答「到底判斷過多少東西」的旗標，要說得出口 ──────────
   *
   * `--verbose` 多印 16 行「每條規則實際判斷過的東西」，
   * 而那正是「綠燈代表什麼」的答案。
   *
   * 第 1 輪（第二十九圈）量到：七支關卡裡六支有 `--verbose` 而輸出從來不提它。
   * （`check:links` 是例外 —— 它的 `--verbose` 只影響失敗那條路，
   * 而且就在相關的地方自己講了，所以那一支不需要改。）
   */
  if (!VERBOSE) {
    console.log('要看每條規則實際判斷過幾個東西：npm run check:content -- --verbose');
  }
  console.log(idleReport + fieldReport);
  /*
   * ── 這兩個出口用 `process.exitCode`，不用 `process.exit()` ──────────
   *
   * `process.exit()` **不等 stdout 排空**。接到終端機時是同步寫的，
   * 看不出來；接到**管線**時（CI 收集輸出、測試用 execFile 讀 stdout）
   * 是非同步的，排隊中的那一段就被丟掉。
   *
   * 第 8 輪（第四十三圈）在 `check:perf` 上實測到 30 次斷 1 次，
   * 修完之後同一天又在這一支上撞到：`test:content-rules` 紅，
   * 而失敗的是 `rule-not-in-guide`（`out.includes('[rule-not-in-guide]')`
   * 讀不到那一行）—— **不是規則沒響，是那一行沒送到。**
   *
   * 綠燈那條路也要改：它印的是最長的那一份報告，最容易被截斷。
   * 改成設 `exitCode` 之後用 `return` 收尾（這裡是模組頂層，return 不合法，
   * 所以把底下那段包成 else）。
   */
  process.exitCode = 0;
} else {
  for (const p of problems) {
    console.log(`\n  X [${p.id}] ${p.file}`);
    console.log(`      ${p.msg}`);
  }
  console.log('\n' + '─'.repeat(56));
  console.log(`${problems.length} 個問題。\n`);
  process.exitCode = 1;
}
