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
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLValidator } from 'fast-xml-parser';
import { countItems } from './lib/count-items.mjs';
import { ALL_TEMPLATE_TEXT } from './lib/entry-template.mjs';

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

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** 從 frontmatter 取一個純量欄位（值可能有引號） */
const field = (/** @type {string} */ md, /** @type {string} */ name) => {
  const m = md.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
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
  // 詩詞顯示的是 poem.title（縮排在 poem: 底下），不是上面那個 title
  const poemTitle = md.match(/^\s{2,}title:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (poemTitle) {
    saw('poem-title-bracketed', 1);
    needles.push(poemTitle);
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
  if (!/\.(html|json|xml|txt)$/.test(f)) continue;
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
              : '　改法：dist/ 是新的。先確認 frontmatter 的 platform 是 docs/PLATFORMS.md 裡有的 id；' +
                '再不然就是 lib/syndication.ts 的 manualItems() 沒把它收進去。'),
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
];
for (const id of RULES) if (!subjects.has(id)) subjects.set(id, 0);

console.log('\n內容管線檢查\n' + '─'.repeat(56));
console.log(
  `${entries.length} 篇內容（草稿 ${entries.filter((e) => e.draft).length} 篇）` +
    `，產出 ${built.length} 個檔案。`,
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
  const src = await readFile(resolve(ROOT, 'src/content.config.ts'), 'utf8').catch(() => '');
  const declared = new Set(
    [
      ...[...src.matchAll(/^\s{2,}([a-zA-Z][a-zA-Z0-9_]*):\s*\S/gm)].map((m) => m[1]),
      ...[...src.matchAll(/\b([a-zA-Z][a-zA-Z0-9_]*):\s*z\./g)].map((m) => m[1]),
    ].filter((n) => !SCHEMA_STRUCTURAL.has(n)),
  );
  const unreadable = [...usedFields].filter((u) => !declared.has(u));
  if (declared.size === 0 || unreadable.length > 0) {
    fieldReport =
      '\n欄位使用情況沒有檢查：content.config.ts ' +
      (declared.size === 0
        ? '讀不到或抽不到欄位。'
        : `抽不到內容用過的 ${unreadable.join('、')}。`) +
      '\n  （寧可說「沒查」，也不要印一份可能是錯的名單。）\n';
  } else {
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
    /** @type {{ generatedAt?: string }} */
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch {
      notes.push('同步資料的新舊沒有檢查：src/data/syndication.json 不是合法的 JSON。');
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
            '    /colophon 仍然會說「來源狀態：N 個正常」—— 那是**上一次真的跑過**時記下的，\n' +
            '    所以排程停掉跟排程健康在那一頁上長得一樣。\n' +
            '    改法：跑一次 npm run sync；如果是排程本身停了，去 GitHub 的 Actions 看 sync-feeds.yml。',
        );
      }
    }
  }
}

for (const n of notes) console.log(`\n  · ${n}`);

if (problems.length === 0) {
  console.log('\n沒有發現問題。');
  console.log(idleReport + fieldReport);
  process.exit(0);
}
for (const p of problems) {
  console.log(`\n  X [${p.id}] ${p.file}`);
  console.log(`      ${p.msg}`);
}
console.log('\n' + '─'.repeat(56));
console.log(`${problems.length} 個問題。\n`);
process.exit(1);
