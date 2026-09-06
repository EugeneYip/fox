#!/usr/bin/env node
// @ts-check
/**
 * 無障礙靜態檢查 —— 掃 dist/ 裡產生出來的 HTML。
 *
 *   npm run build && node scripts/check-a11y.mjs
 *   node scripts/check-a11y.mjs --verbose
 *
 * 只檢查「靜態看得出來」的部分：標題層級、地標、可及名稱、標籤關聯、
 * 重複 id、aria 指向不存在的元素。
 *
 * 檢查不到的（需要真的用瀏覽器跑）：焦點順序、焦點框看不看得見、
 * 螢幕閱讀器實際念出來的順序、動態內容的 live region 行為。
 * 那些要人工用鍵盤走一遍，見 docs/REVIEW-LOG.md 的無障礙輪次。
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attrOf, parseAttrs } from './lib/html-attrs.mjs';
import { dedupedInlineStyles } from './lib/site-css.mjs';
import { projectDay } from './lib/project-day.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/*
 * 預設掃 dist/，但可以用 --dir=<路徑> 指到別的地方。
 *
 * 那個選項存在的唯一理由是 scripts/test-a11y-rules.mjs ——
 * 它會產生一批「每一頁剛好違反一條規則」的假頁面，確認每條規則真的會響。
 *
 * 為什麼需要那個測試：第三圈的八輪裡有五輪的主要發現都是同一類 ——
 * **一個看起來在運作的檢查，其實沒有在檢查**。
 * 這 21 條規則裡，早期加的那些從來沒有被驗證過會不會響。
 */
const dirArg = process.argv.find((a) => a.startsWith('--dir='));
const DIST = dirArg ? resolve(dirArg.slice('--dir='.length)) : resolve(ROOT, 'dist');
const VERBOSE = process.argv.includes('--verbose');

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* htmlFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) yield* htmlFiles(full);
    else if (e.name.endsWith('.html')) yield full;
  }
}

/** @param {string} html */
const strip = (html) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

/** @param {string} html */
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/*
 * 屬性一律走 lib/html-attrs.mjs 的掃描器。
 *
 * 這裡原本是 `new RegExp('\\b' + name + …)` —— 而 `\b` 在連字號後面成立，
 * 所以 `data-lang="zh"` 會被讀成 `lang="zh"`。同一個成因在這支腳本裡
 * 造成過兩種相反的錯（誤報 positive-tabindex／aria-ref，
 * 漏報 html-lang／img-alt／blank-rel）。量測與理由寫在那個檔案的開頭。
 */
/** @param {string} tag @param {string} name */
const attr = (tag, name) => attrOf(tag, name);

/**
 * 拿掉標了 `aria-hidden="true"` 的整棵子樹 —— 那些字不會進可及名稱。
 *
 * 第 1 輪（第十四圈）之前，只有 `decorative-glyph-in-name` 在做這件事，
 * **`hasAccessibleName` 沒有**。兩條規則在同一個檔案裡隔十幾行，
 * 一條知道 aria-hidden、一條不知道，於是
 *
 *     <a href="/y"><span aria-hidden="true">↗</span></a>
 *
 * （整個內容都被藏起來，螢幕閱讀器唸不出任何東西）**不會被報成
 * 沒有可及名稱** —— 因為 `textOf(inner)` 看到的是「↗」。
 *
 * 抓到的方式是把違規包進好幾層再掃一次（figure/picture、fieldset、
 * ul/li 之類）。五個違規裡有四個照樣被抓到，只有這一個沒有。
 *
 * @param {string} html
 */
const withoutHidden = (html) =>
  html.replace(/<([a-z]+)\b[^>]*\saria-hidden\s*=\s*"true"[^>]*>[\s\S]*?<\/\1>/gi, ' ');

/** 一個元素有沒有「可及名稱」—— 螢幕閱讀器唸得出東西 */
/** @param {string} openTag @param {string} [innerHtml] */
function hasAccessibleName(openTag, innerHtml) {
  const inner = withoutHidden(innerHtml ?? '');
  if (attr(openTag, 'aria-label')?.trim()) return true;
  if (attr(openTag, 'aria-labelledby')?.trim()) return true;
  if (attr(openTag, 'title')?.trim()) return true;
  if (textOf(inner)) return true;
  // 只包一張圖的按鈕／連結，圖的 alt 就是名稱
  const img = inner.match(/<img\b[^>]*>/i);
  if (img && attr(img[0], 'alt')?.trim()) return true;
  // 內嵌 SVG 用 aria-label 或 <title>
  if (/<svg\b[^>]*\saria-label\s*=\s*"[^"]+"/i.test(inner)) return true;
  if (/<svg[\s\S]*?<title>[^<]+<\/title>/i.test(inner)) return true;
  return false;
}

/** @type {{ level: 'error'|'warn', file: string, rule: string, detail: string }[]} */
const findings = [];
/*
 * 這支腳本認得的規則。
 *
 * 為什麼要有這份明列 —— 第 1 輪（第二十五圈）量到的：拿一個**空的 dist**
 * 跑一次，輸出是
 *
 *     無障礙靜態檢查（0 頁）
 *     沒有發現問題。
 *     這次沒有東西可看的規則（1 條）：focus-outline-removed
 *
 * 25 條規則裡只有 1 條出現在那份名單上。其餘 24 條的 `saw()` 都寫在
 * 逐頁的迴圈裡，沒有頁面就一次都沒被呼叫，於是它們**整個消失** ——
 * 不在計數裡、也不在「沒有東西可看」的名單裡。
 *
 * 第十五圈加那份名單，就是為了讓「沒東西可看」不要被讀成「檢查過沒問題」。
 * 而它在**最需要它的那一刻**（什麼都沒檢查到）反而最安靜。
 *
 * 有了這份清單就能把每一條補成 0，跟 check-content.mjs 與
 * check-workflows.mjs 的做法一致。`add()` 也會擋住沒登記的 id，
 * 兩邊不可能默默分岔。
 */
const RULE_IDS = [
  'current-page-unmarked',
  'sr-only-broken',
  'html-lang',
  'title',
  'h1',
  'heading-order',
  'empty-heading',
  'landmark',
  'nav-label',
  'duplicate-landmark-name',
  'unnamed-region',
  'fullwidth-in-english',
  'unlabelled-cjk',
  'unlabelled-cjk-attr',
  'positive-tabindex',
  'img-alt',
  'svg-unnamed',
  'button-name',
  'link-name',
  'decorative-glyph-in-name',
  'same-name-different-target',
  'input-label',
  'duplicate-id',
  'aria-ref',
  'blank-rel',
  'lang-content-mismatch',
  'skip-link',
  'focus-outline-removed',
  'reduced-motion-blanket',
  'live-region-value',
  'doc-names-real-rule',
];

if (process.argv.includes('--list-rules')) {
  console.log(RULE_IDS.join('\n'));
  process.exit(0);
}

/**
 * warn 與 error 的分界（第 1 輪〔第十四圈〕才寫下來，之前沒有寫在任何地方）：
 *
 *   **error** —— 這個站上不可能有正當的例外，出現就是壞了
 *   **warn**  —— 有可能是刻意的，需要人看一眼再決定
 *
 * 照這個判準，`skip-link` 該是 error（那個連結是 Base.astro 為每一頁畫的，
 * 44／44 都有，沒有哪一頁能正當地少掉它），已經改了。
 *
 * `blank-rel` 也已經在第 5 輪（第十四圈）升成 error —— 這一支掃的是產出，
 * 產出裡少 rel 沒有正當理由。`audit:privacy` 的 target-blank-no-rel
 * 留在 warn 是因為它掃原始碼，那裡有包裝元件補 rel 的正當寫法。
 * （第 5 輪〔第十八圈〕重新確認過這兩件事都已經做完，並清掉了那兩筆待辦。）
 *
 * 現在是 warn 的有四條：`heading-order`、`nav-label`、`unnamed-region`、
 * `same-name-different-target`。逐條照上面那個判準重審，屬於無障礙那一輪。
 *
 * **warn 不會讓關卡紅燈**，所以放進 warn 等於是「印出來給人看」而不是
 * 「擋下來」。第 1 輪（第十四圈）實測過那有多不可靠：一個 warn 在樹上
 * 待了五輪沒有人發現。
 *
 * @param {'error'|'warn'} level
 * @param {string} file
 * @param {string} rule
 * @param {string} detail
 */
const add = (level, file, rule, detail) => {
  if (!RULE_IDS.includes(rule)) throw new Error(`規則 id "${rule}" 沒有登記在 RULE_IDS 裡`);
  findings.push({ level, file, rule, detail });
};

/*
 * ── 每一條規則這次「看過幾個東西」──────────────────
 *
 * 第 1 輪（第十五圈）量到的：站上有 **0 張 `<img>`、0 個 `aria-labelledby`
 * 之類的參照、0 個 `tabindex`**。也就是說 `img-alt`、`aria-ref`、
 * `positive-tabindex` 這三條**從來沒有判斷過任何一個元素** ——
 * 它們的綠燈不是「檢查過而且沒問題」，是「沒有東西可看」。
 *
 * `audit:privacy` 早就為同一件事做過處理：拿不到身分值的時候它會印
 * 「身分規則沒有執行」而不是安靜地放行，理由寫在那支腳本裡 ——
 * **安靜地什麼都沒檢查，比明講檢查不了危險得多。** 這裡補上同一件事。
 *
 * 計數放在每一條規則自己的迴圈裡，不另外算一份 ——
 * 另外算一份就是「同一件事兩個地方」，第十四圈整整一圈都在講那個。
 */
/** @type {Map<string, number>} */
const subjects = new Map();
/** @param {string} rule @param {number} n */
const saw = (rule, n) => subjects.set(rule, (subjects.get(rule) ?? 0) + n);

let pageCount = 0;

/*
 * ── 被 strip() 拿掉的那一塊裡，有什麼看不到 ──────────
 *
 * 第 1 輪（第三十五圈）用第二種算法數 `<a href=`：整份 HTML 是 901 個，
 * 而關卡的 `link-name` 說 899。差的 2 個在 `<script>` 裡面 ——
 * `strip()` 會先把 script 與 style 整段拿掉，**所以那 899 是對的**。
 *
 * 但追那 2 個的時候看到一件事：搜尋頁的前端會自己拼 `<a href=… target="_blank"
 * rel=… >`，還會加一個 `<span aria-hidden="true">↗</span>`。
 * 那是真的會出現在畫面上的連結，而**這一支的每一條規則都看不到它** ——
 * 包括 `decorative-glyph-in-name`，那條規則存在的理由正好就是那個箭頭。
 * （它今天是對的：箭頭有 `aria-hidden`。但那是人寫對的，不是檢查出來的。）
 *
 * 所以把這個盲點數出來、印在報告上。這一支的規矩是「綠燈要說出它涵蓋什麼」，
 * 而「有幾個東西不在涵蓋範圍裡」正是那句話的另一半。
 *
 * **第 1 輪（第四十三圈）改掉了這個盲點自己的盲點。** 那一版另外寫了一條
 * `/<a\b[^>]*\shref\s*=/` 去數 script 裡的連結 —— 於是「掃不到的東西」
 * 由一條手寫的樣式決定，而它只認連結。實測：把 `<button>` 與 `<img>` 藏進
 * 一頁的 script 裡，報告不但一個字都沒說，還把 `button-name`、`img-alt`
 * 列進「這次沒有東西可看的規則」，底下那句話是「**站上沒有這種元素**」——
 * 那一頁明明有。
 *
 * 現在改成由**規則自己的樣式**推導：`sawTags()` 同一個正則數兩次（整份的
 * 與 strip 過的），差額就是那條規則今天看不到的數量。要加一種元素不必回來
 * 改這裡，因為這裡沒有清單可以漏。
 */
/** @type {Map<string, number>} */
const hiddenSubjects = new Map();

for await (const file of htmlFiles(DIST)) {
  const rel = relative(DIST, file);
  const raw = await readFile(file, 'utf8');
  const html = strip(raw);
  pageCount++;

  /*
   * 同一個樣式數兩次：strip 過的（規則真的看得到的）與整份的。
   * 差額就是這條規則今天掃不到的主體 —— 見上面那段。
   */
  /** @param {string} rule @param {RegExp} re */
  const sawTags = (rule, re) => {
    const kept = (html.match(re) ?? []).length;
    saw(rule, kept);
    const all = (raw.match(re) ?? []).length;
    if (all > kept) hiddenSubjects.set(rule, (hiddenSubjects.get(rule) ?? 0) + (all - kept));
  };

  // ── lang ───────────────────────────────────────────
  const htmlTag = raw.match(/<html\b[^>]*>/i)?.[0] ?? '';
  const lang = attr(htmlTag, 'lang');
  if (!lang) {
    add('error', rel, 'html-lang', '<html> 沒有 lang，螢幕閱讀器不知道該用哪種語音');
  } else if (!/^[a-z]{2,3}(-[A-Za-z]{4})?(-[A-Za-z]{2})?$/.test(lang)) {
    add('error', rel, 'html-lang', 'lang="' + lang + '" 不是合法的 BCP-47 標籤');
  }

  // ── title ──────────────────────────────────────────
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  if (!title) add('error', rel, 'title', '沒有 title，分頁與書籤都會顯示網址');

  // ── 標題層級 ────────────────────────────────────────
  /*
   * 標題的「有沒有文字」要算**可及名稱**，不是只算內文。
   *
   * `<h2 aria-label="⋯"></h2>` 對螢幕閱讀器是有名字的（aria-label 蓋掉內容），
   * 只是視覺上看不見。第 1 輪（第十六圈）拿它當探針，`empty-heading` 響了 ——
   * 那是**冤枉**：那份標記沒有無障礙缺陷。
   *
   * `aria-labelledby` 指到的元素也算，所以順便解一次；指到不存在的 id
   * 是另一條規則（`aria-ref`）的事，這裡不重複判斷。
   */
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({
    level: Number(m[1]),
    text: textOf(m[2]),
    /*
     * 有沒有名字走既有的 `hasAccessibleName()` —— 那支就是為了這件事寫的，
     * 而且 `button-name`／`link-name` 已經在用它。判斷寫兩份遲早會分岔。
     * （`aria-labelledby` 指到不存在的 id 是 `aria-ref` 的事，不在這裡重複判斷。）
     */
    named: hasAccessibleName(m[0].slice(0, m[0].indexOf('>') + 1), m[2]),
  }));

  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) add('error', rel, 'h1', '沒有 h1');
  if (h1s.length > 1) add('error', rel, 'h1', '有 ' + h1s.length + ' 個 h1，應該只有一個');

  for (let i = 1; i < headings.length; i++) {
    const jump = headings[i].level - headings[i - 1].level;
    if (jump > 1) {
      add(
        'warn',
        rel,
        'heading-order',
        'h' + headings[i - 1].level + ' 之後直接跳到 h' + headings[i].level +
          '（「' + headings[i].text.slice(0, 24) + '」）—— 用標題跳著讀的人會以為漏了一段。' +
          '　改法：把它改成 h' + (headings[i - 1].level + 1) + '，或在中間補一層標題。',
      );
    }
  }

  for (const h of headings) {
    if (!h.named) {
      add(
        'error',
        rel,
        'empty-heading',
        '有一個空的 h' + h.level + '（內文是空的，也沒有 aria-label／aria-labelledby）',
      );
    }
  }

  // ── 地標 ────────────────────────────────────────────
  sawTags('nav-label', /<nav\b/gi);
  sawTags('duplicate-landmark-name', /<nav\b/gi);
  sawTags('h1', /<h1\b/gi);
  sawTags('heading-order', /<h[1-6]\b/gi);
  sawTags('empty-heading', /<h[1-6]\b/gi);
  /* 這四條是「每一頁都該有」，所以主體就是頁面本身 */
  saw('html-lang', 1);
  saw('title', 1);
  saw('landmark', 1);
  saw('skip-link', 1);
  if (!/<main\b/i.test(html)) add('error', rel, 'landmark', '沒有 main 地標');
  if ((html.match(/<main\b/gi) ?? []).length > 1) add('error', rel, 'landmark', '有多個 main 地標');

  const navs = [...html.matchAll(/<nav\b([^>]*)>/gi)];
  if (navs.length > 1) {
    const unlabeled = navs.filter(
      (m) => !attr(m[0], 'aria-label') && !attr(m[0], 'aria-labelledby'),
    );
    if (unlabeled.length > 0) {
      add(
        'warn',
        rel,
        'nav-label',
        '有 ' + navs.length + ' 個 nav，其中 ' + unlabeled.length +
          ' 個沒有 aria-label，螢幕閱讀器分不出誰是誰',
      );
    }
  }

  /*
   * ── 地標的名稱 ──────────────────────────────────────
   *
   * 兩個問題，都是螢幕閱讀器的「地標清單」才看得出來的：
   *
   * 1. 同一頁出現兩個同名的 nav。原本主選單與「上下篇」都叫「選單」，
   *    使用者在地標清單裡看到兩個一樣的名字，不知道該跳哪一個。
   * 2. 沒有名字的 <section>。它會變成一個叫「region」的地標 ——
   *    跳過去之後不知道自己在哪。有名字才有用，沒名字不如用 <div>。
   */
  const navNames = [...html.matchAll(/<nav\b([^>]*)>/gi)].map(
    (m) => attr(m[0], 'aria-label') ?? attr(m[0], 'aria-labelledby') ?? '',
  );
  const seenNav = new Map();
  for (const n of navNames) {
    if (!n) continue;
    seenNav.set(n, (seenNav.get(n) ?? 0) + 1);
  }
  for (const [name, count] of seenNav) {
    if (count > 1) {
      add(
        'error',
        rel,
        'duplicate-landmark-name',
        '這一頁有 ' + count + ' 個都叫「' + name + '」的 nav 地標 —— ' +
          '螢幕閱讀器的地標清單裡分不出誰是誰。每個都要有自己的名字。',
      );
    }
  }

  sawTags('unnamed-region', /<section\b/gi);
  for (const m of html.matchAll(/<section\b([^>]*)>/gi)) {
    if (!attr(m[0], 'aria-label') && !attr(m[0], 'aria-labelledby')) {
      add(
        'warn',
        rel,
        'unnamed-region',
        'section 沒有可及名稱：' + m[0].slice(0, 80) +
          '。這不是規範上的缺陷 —— 沒有名字的 section 不會被當成 region 地標，' +
          '只是一個普通容器。這一條是這個站的約定：section 用來分「讀者會想跳過去的段落」，' +
          '所以要嘛給它 aria-label，要嘛這裡其實只是排版分組、改用 div。',
      );
    }
  }

  /*
   * ── 英文頁面裡夾著全形標點 ────────────────────────
   *
   * 「Last synced：September 3, 2026」—— 全形冒號出現在英文句子中間。
   * 成因永遠是同一個：在模板字串裡把標點寫死，而不是放進翻譯字串裡。
   *
   *     `${t('elsewhere.lastSynced')}：${formatDate(date)}`   // ← 標點跟不了語言
   *     t('elsewhere.lastSynced', { date })                   // ← 標點在字串裡
   *
   * 第一圈第 6 輪修過一次（主題切換的播報夾了全形逗號，那次的解法是
   * 加一個 theme.join 字串）。第二圈第 1 輪我自己又犯了一次。
   * 犯兩次的東西就該由工具擋著。
   *
   * 判斷方式刻意保守：只有**兩側都是拉丁字母**的全形標點才算 ——
   * 英文頁面上引用一首中文詩是完全正常的，那種情況標點兩側都是漢字。
   */
  if (/^en\//.test(rel) || rel === 'en.html') {
    /* 這幾條只在英文頁上跑 —— 主體是「有一頁英文的可以看」 */
    saw('fullwidth-in-english', 1);
    saw('lang-content-mismatch', 1);
    const CJK_PUNCT = /[：，、。；？！「」『』〈〉《》（）]/g;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const seen = new Set();
    for (const m of text.matchAll(CJK_PUNCT)) {
      const before = text.slice(Math.max(0, m.index - 2), m.index);
      const after = text.slice(m.index + 1, m.index + 3);
      // 兩側都算「拉丁脈絡」：字母或數字。「Page 2 of 3）」的括號前是數字，
      // 第一版只認字母，剛好漏掉了那個 —— 而那正是實際發生的 bug
      if (!/[A-Za-z0-9]\s*$/.test(before) || !/^\s*[A-Za-z0-9]/.test(after)) continue;
      const snippet = text.slice(Math.max(0, m.index - 24), m.index + 24).replace(/\s+/g, ' ');
      if (seen.has(snippet)) continue;
      seen.add(snippet);
      add(
        'error',
        rel,
        'fullwidth-in-english',
        '英文頁面的句子中間出現全形標點「' + m[0] + '」：…' + snippet + '… ' +
          '標點要放進 ui.ts 的翻譯字串裡，不要寫死在模板字串中。',
      );
    }
  }

  /*
   * ── 英文頁面上的中文沒有標語言 ──────────────────
   *
   * WCAG 3.1.2（Language of Parts，AA）。螢幕閱讀器用**頁面的**語言
   * 去唸，所以英文頁上沒標 lang 的中文會用英文語音唸出來 —— 聽不懂。
   *
   * 這個站一定會有這種內容：她的影片標題、詩句、書名都是中文，
   * 而英文版仍然要列出它們（不該把《詩經》翻成 The Book of Songs 再唸）。
   *
   * 判斷方式：元素自己或任何祖先有 lang 就算過。
   * 這裡用「往回找最近的 lang=」來近似 —— 完整的 DOM 樹剖析對這支
   * 純字串掃描的腳本太重，而近似的代價只是偶爾漏報，不會誤報。
   */
  if (/^en\//.test(rel) || rel === 'en.html') {
    saw('unlabelled-cjk', 1);
    saw('unlabelled-cjk-attr', 1);
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const seen = new Set();
    for (const m of body.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>([^<]{2,})</gi)) {
      const [, tag, attrs, text] = m;
      if (!/[\u4e00-\u9fff]{2,}/.test(text)) continue;
      /*
       * 要 `zh` 開頭才算過 —— 光有 `lang` 不夠。
       *
       * 原本只看「有沒有 lang」，所以 `<p lang="en">中文</p>` 會被放行。
       * 那不是「標了」，是**標錯了** —— 而錯的宣告比沒有宣告更糟：
       * 沒有 lang 時螢幕閱讀器至少可能靠啟發式猜，有 `lang="en"` 時
       * 它會照著那個假的宣告用英文語音唸中文。
       *
       * 第 1 輪（第六圈）加 `unlabelled-cjk-attr` 時就是用這個判準，
       * 兩條規則守同一件事卻鬆緊不同 —— 那是給下一個人的陷阱。
       * 第 1 輪（第八圈）對齊，並先量過：收緊之後在現有的 12 個英文頁面上
       * **0 個新發現、0 個誤報**。
       */
      if (attrOf('<' + tag + attrs + '>', 'lang')?.startsWith('zh')) continue;
      // 祖先有沒有 lang：往前找最近的一個開標籤帶 lang 且尚未關閉的情形，
      // 用「這個元素之前 1200 字元內有 lang=」近似
      const before = body.slice(Math.max(0, m.index - 1200), m.index);
      if (/\slang="zh[^"]*"[^<>]*>(?:[^<]|<(?!\/))*$/.test(before)) continue;
      const key = text.trim().slice(0, 20);
      if (seen.has(key)) continue;
      seen.add(key);
      add(
        'error',
        rel,
        'unlabelled-cjk',
        '英文頁面上的中文沒有標語言：<' + tag + '> ' + key +
          '… 螢幕閱讀器會用英文語音唸它。加 lang="zh-Hant"（古典漢文）或 ' +
          'lang="zh-Hant-TW"（現代臺灣中文）。',
      );
    }

    /*
     * 同一條規則的另一半：**會變成無障礙名稱的屬性**。
     *
     * 上面那個迴圈只看標籤之間的文字。但 title、aria-label、alt、
     * placeholder 也會被唸出來，而且它們跟文字有一個關鍵差別：
     * **沒辦法包一層 <span lang="zh-Hant"> 來救** —— 屬性的語言就是
     * 元素自己的語言，要標只能標在那個元素身上。
     *
     * 第 1 輪（第六圈）用 HTML 剖析器掃過當時的 12 個英文頁面，
     * 這種屬性含中文的有 **0 個**，所以這條規則加下去的當下不會響。
     * 那不是「不需要」，是「還沒踩到」——
     * `VideoFacade` 的 iframe title 就是〈靜夜思〉李白 這種字串，
     * 而它到第六圈為止**從來沒有被算繪過**（沒有任何一首詩填了 videoUrl），
     * 所以五圈的無障礙檢查一次都沒有看過它。
     *
     * 判準比上面那條嚴：光有 lang 不算過，要是 zh 開頭才算。
     * `lang="en"` 配中文屬性正是這條要抓的東西。
     */
    const seenAttr = new Set();
    for (const m of body.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
      const [, tag, attrs] = m;
      const own = attrOf('<' + tag + attrs + '>', 'lang');
      if (own && /^zh/i.test(own)) continue;
      /*
       * 從屬性表挑，不要再對 attrs 做一次正則 ——
       * `data-title` 之類的前綴會被 `\b` 當成 `title`（第 1 輪〔第十三圈〕）。
       */
      for (const [name, value] of [...parseAttrs('<' + tag + attrs + '>')].filter(
        ([n]) => ['title', 'aria-label', 'alt', 'placeholder'].includes(n),
      )) {
        if (!/[一-鿿]{2,}/.test(value)) continue;
        // 祖先標了中文也算過，近似方式跟上面那條一致
        const before = body.slice(Math.max(0, m.index - 1200), m.index);
        if (/\slang="zh[^"]*"[^<>]*>(?:[^<]|<(?!\/))*$/.test(before)) continue;
        const key = tag + '/' + name + '/' + value.slice(0, 20);
        if (seenAttr.has(key)) continue;
        seenAttr.add(key);
        add(
          'error',
          rel,
          'unlabelled-cjk-attr',
          '英文頁面上的 ' + name + ' 屬性是中文：<' + tag + ' ' + name + '="' +
            value.slice(0, 24) + '…"> 螢幕閱讀器會用英文語音唸這個名稱。' +
            '屬性沒辦法包 <span lang> 來救，要在 <' + tag + '> 自己身上加 lang="zh-Hant"。',
        );
      }
    }
  }

  /*
   * ── tabindex 大於 0 ──────────────────────────────
   *
   * 正數的 tabindex 會把那個元素**插到所有自然順序的前面**，
   * 而且一旦有一個，整頁的 Tab 順序就變成「先跑完所有正數、再回頭跑
   * DOM 順序」—— 幾乎一定跟畫面上看到的順序對不起來。
   *
   * 第 1 輪（第四圈）用「DOM 順序 vs 視覺順序」量過四種頁型，
   * 目前 0 個不一致。但那個量測需要瀏覽器，靜態檢查跑不了；
   * 這條規則守的是**最常見的破壞方式**，那個是靜態看得出來的。
   *
   * 合法的值只有 0（可聚焦、照 DOM 順序）與 -1（程式可聚焦、不進 Tab 順序）。
   */
  sawTags('positive-tabindex', /\stabindex\s*=/gi);
  for (const m of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const ti = attr(m[0], 'tabindex');
    if (ti === null || !/^\d+$/.test(ti.trim()) || Number(ti) <= 0) continue;
    add(
      'error',
      rel,
      'positive-tabindex',
      'tabindex="' + ti + '" 會把這個元素插到所有自然順序的前面，整頁的 Tab 順序' +
        '就跟畫面對不起來了：' + m[0].slice(0, 70) + '。只用 0 或 -1。',
    );
  }

  /*
   * ── live region 的值打錯，什麼事都不會發生 ────────────
   *
   * 第 1 輪（第三十九圈）加的。那一圈在逐條驗待辦還成不成立，
   * 而「`aria-live`／`role="status"` 沒有規則」那一條驗出來**是活的，
   * 而且有 46 個主體**：44 個主題切換的狀態列（每一頁都有）
   * 加上搜尋頁的 2 個。今天全部是 `polite`。
   *
   * 為什麼值得擋：`aria-live` 的值打錯（`true`、`yes`、`on`⋯⋯）
   * **畫面上什麼都不會變**。那一格從此不再朗讀，而唯一會發現的人
   * 是正在用螢幕閱讀器的人 —— 而這個站的螢幕閱讀器測試
   * `docs/A11Y.md` 自己寫著「現況：**沒有人做過**」。
   *
   * 合法的值只有三個（`polite`／`assertive`／`off`）。
   */
  sawTags('live-region-value', /\saria-live\s*=/gi);
  for (const m of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const live = attr(m[0], 'aria-live');
    if (live === null) continue;
    const v = live.trim().toLowerCase();
    if (v === 'polite' || v === 'assertive' || v === 'off') continue;
    add(
      'error',
      rel,
      'live-region-value',
      `aria-live="${live}" 不是合法的值（只有 polite／assertive／off）。` +
        '畫面上什麼都不會變，而那一格從此不再朗讀 —— ' +
        '唯一會發現的人是正在用螢幕閱讀器的人：' + m[0].slice(0, 70),
    );
  }

  // ── 圖片 ────────────────────────────────────────────
  /*
   * ── 內嵌的 SVG，沒有人在看 ──────────
   *
   * 第 1 輪（第三十六圈）問「這道檢查的邊界外面是什麼、那裡有幾個」。
   * 把產出裡的元素種類數出來（45 種）之後，兩種**每一頁都有**的東西
   * 完全不在任何規則的視野裡：`<svg>` 99 個、`<details>`／`<summary>` 各 44 個。
   *
   * `svg` 這個字在這支腳本裡只出現在 `hasAccessibleName()` ——
   * 那是在問「這個連結／按鈕包著的圖有沒有名字」，
   * **不是**在看站上所有的 SVG。獨立站著的那些一個都沒被檢查過。
   *
   * 而 `<img>` 那條（`img-alt`）主體是 0 —— 站上一張 `<img>` 都沒有，
   * 圖示全是內嵌 SVG。也就是說「圖片有沒有替代文字」這件事，
   * **這個站上真正的那 99 個，剛好落在規則外面**。
   *
   * 現在的狀態是乾淨的：99 個全部有 `aria-hidden="true"`（實測）。
   * 所以這條規則今天不會響 —— 它守的是下一個加圖示的人。
   *
   * 判準：一個 SVG 要嘛藏起來（`aria-hidden`／`role="presentation"`／`role="none"`），
   * 要嘛有名字（`aria-label`／`aria-labelledby`／`<title>` 子元素）。
   * 兩個都沒有的話，螢幕閱讀器會把它當成一張沒有說明的圖念出來。
   * 沒有第三種正當寫法，所以是 error。
   *
   * ── 為什麼這裡不呼叫 `hasAccessibleName()` ────────────────
   *
   * 第 1 輪（第四十一圈）補的說明。這支腳本裡有一課寫在
   * `empty-heading` 旁邊：「判斷寫兩份遲早會分岔」，所以標題那條特地
   * 改成走既有的 `hasAccessibleName()`。而這一條**又寫了第二份** ——
   * 當時沒有說為什麼，看起來就像忘了那一課。
   *
   * 理由是 SVG 的命名規則跟 HTML 元素不一樣，`hasAccessibleName()`
   * 有兩件事對 SVG 是**錯的**：
   *
   *   `title` **屬性**　　HTML 元素上算名字，SVG 上不算 —— SVG 用的是
   *                      `<title>` **子元素**。認了它會把沒有名字的圖放過去。
   *   內文字　　　　　　  `<text>` 之類的內容不是可及名稱。
   *
   * 也就是說共用那一支會讓這一條**變寬**，而它守的正是「圖沒有說明」。
   * 所以是刻意寫第二份，不是漏掉 —— 兩個差別各有一格測試釘著
   * （`test-a11y-rules.mjs` 的 `svg-unnamed（title 屬性不算名字）`）。
   */
  sawTags('svg-unnamed', /<svg\b/gi);
  for (const m of html.matchAll(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gi)) {
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    const role = (attr(openTag, 'role') ?? '').trim().toLowerCase();
    const hidden =
      attr(openTag, 'aria-hidden') === 'true' || role === 'presentation' || role === 'none';
    const named =
      Boolean(attr(openTag, 'aria-label')?.trim()) ||
      Boolean(attr(openTag, 'aria-labelledby')?.trim()) ||
      /<title>[^<]+<\/title>/i.test(m[1]);
    if (hidden || named) continue;
    add(
      'error',
      rel,
      'svg-unnamed',
      '內嵌的 <svg> 既沒有 aria-hidden="true" 也沒有名字 —— ' +
        '螢幕閱讀器會把它當成一張沒有說明的圖念出來。' +
        '　改法：裝飾用的加 aria-hidden="true"；' +
        '有意義的加 aria-label="⋯" 或在裡面放一個 <title>⋯</title>。',
    );
  }

  sawTags('img-alt', /<img\b/gi);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    /*
     * `alt` 也可以**沒有值**：HTML 規定無值屬性的值就是空字串，
     * 所以 `<img alt>` 等同 `<img alt="">` —— 那正是「這張圖是裝飾用的」
     * 該有的寫法，而 Astro 的編譯器就是這樣輸出的。
     *
     * 原本只認 `alt="..."`，於是把裝飾圖報成「沒有 alt」。
     * 這個誤報一直看不見，因為**站上沒有任何內容有封面圖** ——
     * 第 3 輪（第八圈）為了跑 `coverAlt` 暫時掛了一張圖才撞到：
     * schema 的註解寫著「留空代表這張圖是裝飾用的」，
     * 而照著做會讓 CI 紅燈。
     */
    if (attr(m[0], 'alt') === null) {
      add(
        'error',
        rel,
        'img-alt',
        '圖片沒有 alt：' + m[0].slice(0, 80) +
          '　改法：寫一句話說明這張圖在講什麼；純裝飾的圖就寫 alt=""（空字串），' +
          '螢幕閱讀器會跳過它。',
      );
    }
  }

  // ── 按鈕與連結的可及名稱 ─────────────────────────────
  sawTags('button-name', /<button\b/gi);
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    if (!hasAccessibleName(m[0], m[2])) {
      add(
        'error',
        rel,
        'button-name',
        '按鈕沒有可及名稱（螢幕閱讀器唸不出這個鈕是做什麼的）：' + m[0].slice(0, 90) +
          '　改法：把文字放進按鈕裡，或加 aria-label="⋯"。' +
          '只有圖示的按鈕就用 aria-label。',
      );
    }
  }
  /*
   * 裝飾用的符號不要留在可及名稱裡。
   *
   * 第 1 輪（第十一圈）用瀏覽器的無障礙樹量到：全站有**四個地方**把外連的
   * 箭頭直接寫成文字，於是那些連結被念成「前往 右上箭頭」「聽朗讀 右上箭頭」。
   * 另外兩個地方（分頁、區塊標題）早就用 `<span aria-hidden="true">` 包起來了 ——
   * **同一個東西三種寫法，而只有其中一種會被念出來。**
   *
   * `SyndicationList` 用 CSS 的 `::after { content: " ↗" }` 是第三種，
   * 實測那一種不會進到可及名稱裡（量過三頁，一個都沒有），所以不在這裡管。
   *
   * 符號清單刻意很短，只放「明顯是裝飾、而且不會出現在中文正文裡」的那幾個。
   */
  const DECOR_GLYPHS = /[↗↘↙↖→←↑↓✦★☆▸▾»«]/;
  sawTags('link-name', /<a\b[^>]*\shref\s*=/gi);
  sawTags('same-name-different-target', /<a\b[^>]*\shref\s*=/gi);
  sawTags('decorative-glyph-in-name', /<a\b[^>]*\shref\s*=/gi);
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    if (attr(openTag, 'href') === null) continue;
    if (!hasAccessibleName(m[0], m[1])) {
      add(
        'error',
        rel,
        'link-name',
        '連結沒有可及名稱（螢幕閱讀器唸不出這個連結去哪）：' + m[0].slice(0, 90) +
          '　改法：把文字放進連結裡，或加 aria-label="⋯"。',
      );
    }
    // aria-label 會蓋掉內容，那種情況下內文的符號不進名稱
    if (attr(m[0], 'aria-label')?.trim()) continue;
    // 拿掉已經標了 aria-hidden 的部分，剩下的才是會被念出來的
    const spoken = textOf(withoutHidden(m[1]));
    const hit = DECOR_GLYPHS.exec(spoken);
    if (hit) {
      add(
        'error',
        rel,
        'decorative-glyph-in-name',
        `連結的可及名稱裡有裝飾符號「${hit[0]}」，會被螢幕閱讀器念出來：「${spoken.slice(0, 40)}」` +
          ' —— 用 <span aria-hidden="true"> 包起來（Pagination 與 SectionHeading 就是這樣寫的）。',
      );
    }
  }

  /*
   * ── 同一個名字，不同的去處 ────────────────────────
   *
   * 螢幕閱讀器有一個「連結清單」（rotor／link list）：它把整頁的連結抽出來
   * 排在一起，**沒有上下文**。兩個都叫「看全部」的連結在那份清單裡
   * 分不出誰是誰 —— 而它們一個去彙整、一個去別處。
   *
   * 第 1 輪（第十八圈）從讀者那一側量到的：7 頁有這種情況
   * （首頁兩個「看全部→」、導覽列的「詩詞」對上標籤的「詩詞」）。
   * 現有的 24 條規則沒有一條看得到它 —— `duplicate-landmark-name`
   * 守的是地標，不是連結。
   *
   * **level 是 warn 不是 error**：上下文有時候真的補得起來（清單裡每一項
   * 旁邊都有標題），那時候這條會冤枉人。第十六圈整圈都在講誤報的代價，
   * 所以取比較保守的那一邊。
   *
   * 網址先正規化：結尾的斜線與 hash 不算不同的去處。
   */
  {
    /** @type {Map<string, Set<string>>} */
    const byName = new Map();
    for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
      const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
      const href = attr(openTag, 'href');
      if (href === null) continue;
      const name = (attr(openTag, 'aria-label') ?? textOf(withoutHidden(m[1]))).trim();
      if (!name) continue;
      const target = href.replace(/#.*$/, '').replace(/\/$/, '') || '/';
      if (!byName.has(name)) byName.set(name, new Set());
      /** @type {Set<string>} */ (byName.get(name)).add(target);
    }
    for (const [name, targets] of byName) {
      if (targets.size < 2) continue;
      add(
        'warn',
        rel,
        'same-name-different-target',
        `這一頁有 ${targets.size} 個都叫「${name}」的連結，但去處不同：` +
          [...targets].slice(0, 3).join('、') +
          '。螢幕閱讀器的連結清單沒有上下文，那份清單裡分不出誰是誰。' +
          '　改法：給其中一個加 aria-label，把它要去哪裡講清楚（畫面上的字不用改）。',
      );
    }
  }

  // ── 表單標籤 ────────────────────────────────────────
  sawTags('input-label', /<(input|textarea|select)\b/gi);
  for (const m of html.matchAll(/<(input|textarea|select)\b[^>]*>/gi)) {
    const tag = m[0];
    const type = attr(tag, 'type');
    if (type && ['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    const id = attr(tag, 'id');
    const labelled =
      attr(tag, 'aria-label') ||
      attr(tag, 'aria-labelledby') ||
      (id !== null &&
        [...html.matchAll(/<label\b[^>]*>/gi)].some((l) => attr(l[0], 'for') === id));
    if (!labelled) {
      add(
        'error',
        rel,
        'input-label',
        m[1] + ' 沒有標籤（螢幕閱讀器唸不出這一欄要填什麼）：' + tag.slice(0, 90) +
          '　改法：加 <label for="它的 id">說明</label>，或在它身上加 aria-label="⋯"。',
      );
    }
  }

  // ── id 重複 ────────────────────────────────────────
  const ids = [...html.matchAll(/\sid\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
  saw('duplicate-id', ids.length);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const id of new Set(dupes)) {
    add(
      'error',
      rel,
      'duplicate-id',
      'id="' + id + '" 出現多次 —— aria-labelledby、跳轉錨點都只會找到第一個。' +
        '　改法：讓每個 id 唯一（元件裡的 id 通常要帶上該筆資料的 slug）。',
    );
  }

  // ── aria 指向不存在的元素 ────────────────────────────
  const idSet = new Set(ids);
  sawTags('aria-ref', /\saria-(labelledby|describedby|controls)\s*=/gi);
  for (const a of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    for (const m of html.matchAll(new RegExp('\\s' + a + '\\s*=\\s*"([^"]+)"', 'gi'))) {
      for (const ref of m[1].split(/\s+/).filter(Boolean)) {
        if (!idSet.has(ref)) {
          add(
            'error',
            rel,
            'aria-ref',
            a + '="' + ref + '" 指到不存在的 id —— 那個名稱等於沒有作用。' +
              '　改法：把 id 打對，或者這個屬性其實不需要就拿掉。',
          );
        }
      }
    }
  }

  /*
   * ── nav 裡連到自己的那個連結，要說得出「你在這裡」 ──
   *
   * 第 1 輪（第三十圈）問「這件事如果整個拿掉，會有誰發現」。
   * 把導覽列的 `aria-current` 整條刪掉、重建、跑完
   * **六道關卡加兩套測試 —— 全綠**。沒有任何東西發現它不見了。
   *
   * 而且它不只是無障礙：頁首的 CSS 是 `a[aria-current="page"]::after`，
   * 所以那個屬性一走，**看得見的「目前頁」記號也跟著消失**。
   *
   * 同一輪量到的另一半：全站 20 個「nav 裡連到自己」的連結，
   * 10 個沒有標記，全部在頁尾。同一個站的兩個 nav，一個說得出、
   * 一個不說 —— 而沒有任何東西分得出這兩種情況。
   *
   * 判準只認**完全相符**的自我連結。前綴（在 /poems/xyz 上看 /poems）
   * 是「你在這個區段」，那是設計選擇，不是這條規則管的事。
   */
  {
    const own = ('/' + rel.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '')).replace(/\/$/, '') || '/';
    /** @type {{ href: string, tag: string }[]} */
    const selfLinks = [];
    for (const nav of html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)) {
      for (const a of nav[1].matchAll(/<a\b([^>]*)>/gi)) {
        /* attr() 沒有那個屬性時回的是 null，不是 undefined —— 型別關卡抓過這一次 */
        const href = attr('<a' + a[1] + '>', 'href');
        if (href == null) continue;
        if ((href.replace(/\/$/, '') || '/') !== own) continue;
        selfLinks.push({ href, tag: a[0] });
      }
    }
    saw('current-page-unmarked', selfLinks.length);
    for (const l of selfLinks) {
      if (/\saria-current\s*=/i.test(l.tag)) continue;
      add(
        'error',
        rel,
        'current-page-unmarked',
        'nav 裡有一個連到這一頁自己的連結（' + l.href + '），卻沒有 aria-current —— ' +
          '螢幕閱讀器把它唸成跟旁邊四個一樣的普通連結，聽不出「你正在這一頁」。' +
          '　改法：那個 <a> 上加 aria-current="page"。',
      );
    }
  }

  // ── 新分頁 ──────────────────────────────────────────
  sawTags('blank-rel', /<a\b[^>]*\starget\s*=\s*"_blank"/gi);
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const openTag = m[0].slice(0, m[0].indexOf('>') + 1);
    if (attr(openTag, 'target') !== '_blank') continue;
    /*
     * 第 5 輪（第十四圈）從 warn 升成 error。
     *
     * 判準是第 1 輪（第十四圈）寫下的那條：「這個站上有沒有正當的例外」。
     * 這一支掃的是**產出**，而產出裡的 `target="_blank"` 少了 `rel` 沒有任何
     * 正當理由（會漏 referrer，而隱私頁明講不會）。實測 60 個這種連結，
     * **0 個少 rel**，所以升級不會製造誤報。
     *
     * `audit:privacy` 的 `target-blank-no-rel` 守同一件事，但**留在 warn** ——
     * 那一支掃的是**原始碼**，而原始碼裡 `<SomeWrapper target="_blank">`
     * 由包裝元件補 rel 是有可能的正當寫法。兩支的嚴重度不同不是漏改，
     * 是掃的東西不同（這一行寫下來，免得下一個人「順手對齊」）。
     */
    if (attr(openTag, 'rel') === null) {
      add(
        'error',
        rel,
        'blank-rel',
        'target="_blank" 沒有 rel —— 新分頁拿得到原頁面的參照，也會帶上來源網址。' +
          '　改法：用 ExternalLink 元件（它會自己補），或直接加 rel={externalLinkRel}。',
      );
    }
  }

  /*
   * ── 宣告的語言與實際內容對不對得上 ──────────────────
   *
   * 一個 lang="en" 的頁面裡放整篇中文，螢幕閱讀器會用英文語音去唸中文，
   * 結果是完全聽不懂的一串音。這是實打實的無障礙問題，不只是「翻譯沒做完」。
   *
   * 判準刻意保守：只有在「這一頁的可見文字跟對應的中文頁一模一樣」時才報。
   * 那是明確的「忘了翻」，不會誤傷 —— 英文版的介面配上中文的詩詞內容
   * 是正常且正確的（詩本來就是中文的）。
   */
  if (rel.startsWith('en/')) {
    const zhPath = resolve(DIST, rel.slice(3));
    let zhText = null;
    try {
      zhText = await readFile(zhPath, 'utf8');
    } catch {
      zhText = null;
    }
    if (zhText) {
      /** @param {string} t */
      const main = (t) => {
        const m = t.match(/<main[\s\S]*?<\/main>/i);
        return m ? textOf(strip(m[0])) : '';
      };
      const enMain = main(raw);
      const zhMain = main(zhText);
      if (enMain && enMain === zhMain) {
        add(
          'error',
          rel,
          'lang-content-mismatch',
          '這一頁宣告 lang="en"，但可見內容跟中文版一字不差 —— 沒有翻譯。' +
            '螢幕閱讀器會用英文語音唸中文。',
        );
      }
    }
  }

  /*
   * ── 跳到主要內容 ──────────────────────────────────
   *
   * 這一條第 1 輪（第十四圈）從 warn 升成 error。
   *
   * 判準是「這個站上有沒有一頁可以正當地沒有它」，答案是沒有：
   * 那個連結是 `Base.astro` 為**每一頁**畫的，實測 44／44 都有。
   * 一個永遠不會有正當例外的 warn，等於是把警報線拔掉的 error ——
   * 它出現的時候一定是壞了，而 warn 不會讓關卡紅燈。
   *
   * 為什麼這件事值得改：第 1 輪（第十四圈）實測到一個 warn
   * **在樹上放了五輪沒有人發現**（`audit:privacy` 的 target-blank-no-rel，
   * 被我自己寫進紀錄的一行例子觸發）。每一輪都印著「必須修正 0、請確認 1」，
   * 而在六道關卡的輸出裡那行字會被當成綠燈滑過去。
   */
  /*
   * ── 判準要跟訊息說的是同一件事 ──────────────────
   *
   * 這一條本來只認 `class="skip-link"`，而它的訊息說的是
   * 「沒有『跳到主要內容』連結」。**那是兩句不一樣的話。**
   *
   * 第 1 輪（第二十四圈）拿一個語意完全正確的跳轉連結當探針 ——
   * `<a class="skip" href="#m">跳到主要內容</a>`，第一個可聚焦的元素、
   * 指向 `<main id="m">` —— 這一條照樣報「沒有跳轉連結」。
   * 照訊息去做（加一個「跳到主要內容」的連結）不會讓它變綠，
   * 要照它沒說的那件事去做（把 class 取成 `skip-link`）才會。
   *
   * 判準改成認**那個東西本身**：一個 `<a href="#…">`，指向頁面上真的存在的
   * 錨點，而且出現在那個錨點之前。class 那一條留著當第一判準
   * （這個站自己就是那樣寫的，比對便宜），兩者任一成立就算有。
   *
   * 沒有放寬成「只要有 #錨點連結就算」：那樣頁尾的「回到頂端」也會過關，
   * 而它救不了每一頁都要穿過導覽列的人。
   */
  const hasSkipClass = /class="[^"]*skip-link/i.test(html);
  const skipByShape = (() => {
    const first = /<a\b[^>]*\shref\s*=\s*"#([^"]+)"[^>]*>/i.exec(html);
    if (!first) return false;
    const anchor = first[1];
    /* 錨點要真的存在，而且連結要在它前面（不然那是「回到某處」不是「跳過」） */
    const target = new RegExp(`\\sid\\s*=\\s*"${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
    const at = html.search(target);
    return at > 0 && at > (first.index ?? 0);
  })();

  if (!hasSkipClass && !skipByShape) {
    add(
      'error',
      rel,
      'skip-link',
      '沒有跳轉連結 —— 鍵盤使用者每頁都要先穿過導覽列。' +
        '　判準：頁面最前面要有一個 `<a href="#…">` 指向後面真的存在的錨點' +
        '（這個站是 Base.astro 的 `class="skip-link"` 指向 `<main id="main">`）。',
    );
  }
}

/*
 * ── 拿掉焦點框卻沒有補回來 ──────────────────────
 *
 * 這一條掃的是**產出的 CSS**，不是個別頁面。
 *
 * `outline: none` 是最容易造成鍵盤使用者被鎖在外面的一行 CSS ——
 * 寫的人通常只是覺得預設的焦點框醜，而畫面上完全看不出有什麼不對，
 * 因為用滑鼠根本不會觸發它。
 *
 * 合法的用法是「拿掉之後用 :focus-visible 補回來」，這個站有兩處這樣寫：
 * global.css 的 `:focus:not(:focus-visible)`，以及搜尋框。
 * 這條規則要求每一個含 outline:none 的規則區塊附近都要有 :focus-visible。
 *
 * ── 第 2 輪（第十四圈）：原本只掃了全站 CSS 的 38% ──
 *
 * 這裡本來只讀 `dist/_astro/*.css`。但 `inlineStylesheets: auto` 會把元件的
 * scoped style **內嵌進 HTML**，而這個站幾乎所有樣式都是那樣寫的：
 *
 *   外部 .css   2 個檔、21,251 bytes　　內嵌 <style>  16 種、**34,449 bytes**
 *
 * 上面那句「以及搜尋框」正是內嵌的那一處 —— **註解宣告了實作沒有的涵蓋範圍**。
 * （量到的時候它是安全的：同一個內嵌區塊裡就有 `:focus-visible` 補回來。
 * 但那是運氣，不是這條規則守住的。）
 *
 * `check:perf` 第 2 輪（第八圈）就學到「CSS 有兩半」了，這一支沒有 ——
 * 兩份各自維護的知識分岔了六圈。取內嵌區塊的做法現在共用 lib/site-css.mjs。
 */
{
  /** @type {{ rel: string, css: string }[]} */
  const cssFiles = [];
  for (const f of await readdir(resolve(DIST, '_astro')).catch(() => [])) {
    if (f.endsWith('.css')) {
      cssFiles.push({ rel: relative(DIST, resolve(DIST, '_astro', f)), css: await readFile(resolve(DIST, '_astro', f), 'utf8') });
    }
  }
  /* 內嵌的那一半：去重之後當成獨立的「檔案」掃，理由同上 */
  /** @type {string[]} */
  const pageTexts = [];
  for await (const f of htmlFiles(DIST)) pageTexts.push(await readFile(f, 'utf8'));
  for (const [i, block] of dedupedInlineStyles(pageTexts).entries()) {
    cssFiles.push({ rel: `（內嵌的 <style> 區塊 #${i + 1}）`, css: block });
  }

  /*
   * ── prefers-reduced-motion 的那道毯子還在嗎 ──────────
   *
   * `global.css` 有一段把**全站**的動畫與轉場時間壓成 0.01ms 的
   * `@media (prefers-reduced-motion: reduce)`。它是萬用選擇器，
   * 所以以後新加的轉場自動被蓋住 —— 這是對的寫法。
   *
   * 問題是**沒有任何東西在看它**。第 1 輪（第二十六圈）實測：
   * 把那個查詢改成 `no-preference`（意思正好相反 —— 要動的人沒有動畫，
   * 說不要動的人反而有），**六道關卡加兩套測試全部綠燈**。
   *
   * 而且這種壞法不會有人回報：受影響的是對前庭刺激敏感的人，
   * 他們只會覺得不舒服，不會知道那是一行 media query。
   *
   * 判準要跟訊息說的一樣（第 1 輪〔第二十四圈〕的教訓）：
   * 找的是「一個 **reduce** 查詢，而且它真的把 transition 與 animation
   * 的時間關掉」。只找 `prefers-reduced-motion` 這個字串不夠 ——
   * `Foxfire.astro` 自己也有一個（只停它那一個動畫），
   * 上面那個突變之下它照樣在，字串比對會通過。
   */
  {
    /** 這一條守的是「站上有動效」這件事；一個動效都沒有就沒東西可守 */
    const motion = cssFiles.reduce(
      (n, { css }) => n + (css.match(/(?:transition|animation)(?:-duration)?\s*:/g) ?? []).length,
      0,
    );
    saw('reduced-motion-blanket', motion);
    if (motion > 0) {
      /* @media 的區塊要數括號取，minify 過的 CSS 沒有換行可以靠 */
      const blanket = cssFiles.some(({ css }) => {
        for (let i = 0; (i = css.indexOf('@media', i)) !== -1; ) {
          const open = css.indexOf('{', i);
          if (open === -1) break;
          const cond = css.slice(i, open);
          let depth = 0;
          let j = open;
          for (; j < css.length; j++) {
            if (css[j] === '{') depth++;
            else if (css[j] === '}') { depth--; if (depth === 0) break; }
          }
          const body = css.slice(open + 1, j);
          if (
            /prefers-reduced-motion\s*:\s*reduce/.test(cond) &&
            /transition-duration\s*:/.test(body) &&
            /animation-duration\s*:/.test(body)
          ) {
            return true;
          }
          i = j + 1;
        }
        return false;
      });
      if (!blanket) {
        add(
          'error',
          'dist/（全站 CSS）',
          'reduced-motion-blanket',
          `站上有 ${motion} 處轉場或動畫，但找不到一個 ` +
            '`@media (prefers-reduced-motion: reduce)` 區塊同時關掉 ' +
            '`transition-duration` 與 `animation-duration`。' +
            '　說「不要動」的人會照樣看到動畫，而他們不會回報這件事。' +
            '　改法：`global.css` 底部那一段萬用選擇器的區塊要留著 —— ' +
            '它是萬用的，所以新加的轉場會自動被蓋住，不用一條一條補。',
        );
      }
    }
  }

  saw('focus-outline-removed', cssFiles.length);
  for (const { rel, css } of cssFiles) {
    for (const m of css.matchAll(/([^{}]*)\{[^{}]*outline:\s*(?:none|0)[^{}]*\}/g)) {
      const selector = (m[1].split(/[;}]/).pop() ?? '').trim();
      // 同一份 CSS 裡有沒有針對同一個東西的 :focus-visible 規則
      const base = selector.replace(/:focus[^,\s]*/g, '').split(',')[0].trim();
      const restored =
        css.includes(':focus-visible') &&
        (base === '' || new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{,]*:focus-visible').test(css));
      if (!restored) {
        add(
          'error',
          rel,
          'focus-outline-removed',
          '這條規則拿掉了焦點框卻沒有用 :focus-visible 補回來：' + selector.slice(0, 60) +
            '。鍵盤使用者會看不到自己在哪裡，而用滑鼠測完全看不出問題。',
        );
      }
    }
  }

  /*
   * ── 只給螢幕閱讀器的字，真的還藏著嗎 ──────────────
   *
   * 同一輪的第二個「拿掉了誰會發現」：把 `global.css` 的 `.sr-only`
   * 改名（等於整條定義消失）、重建、跑完六道關卡加兩套測試 —— **全綠**。
   *
   * 那個類別的工作就是「看不見但唸得出來」。定義一沒了，
   * 那些字會直接印在頁面上：搜尋頁的欄位標籤、以及每一頁那個
   * 切換主題後由 JavaScript 填字的狀態列。
   * 44 頁、46 處，沒有一道關卡看得出來 ——
   * **因為壞掉的樣子是「多了東西」，而所有檢查都在找「少了東西」。**
   *
   * 判準要跟訊息說的一樣（第 1 輪〔第二十四圈〕的教訓）：不是
   * 「CSS 裡有 .sr-only 這幾個字」——`.sr-only { color: red }` 也會通過 ——
   * 而是**那一塊真的有在把它藏起來**。
   *
   * 兩種正規寫法都認：clip-path／clip，或 1px ＋ overflow:hidden。
   * 只認站上現在用的那一種的話，這條規則守的就變成「別改寫法」，
   * 而不是「別讓它現形」—— 那是兩件事，而訊息說的是後者。
   */
  const srOnlyUses = pageTexts.reduce(
    (n, html) => n + (html.match(/\sclass\s*=\s*"[^"]*\bsr-only\b[^"]*"/gi) ?? []).length,
    0,
  );
  saw('sr-only-broken', srOnlyUses);
  if (srOnlyUses > 0) {
    const clips = cssFiles.some(({ css }) => {
      for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
        if (!/(^|[,\s])\.sr-only(?![\w-])/.test(m[1])) continue;
        const body = m[2];
        const clipped = /clip-path\s*:|(^|[;\s])clip\s*:/.test(body);
        const boxed = /(width|height)\s*:\s*1px/.test(body) && /overflow\s*:\s*hidden/.test(body);
        if (clipped || boxed) return true;
      }
      return false;
    });
    if (!clips) {
      add(
        'error',
        'dist/（全站 CSS）',
        'sr-only-broken',
        `站上有 ${srOnlyUses} 處 class="sr-only"，但送出去的 CSS 裡找不到一條` +
          ' `.sr-only` 規則在把它藏起來（clip-path／clip，或 1px ＋ overflow:hidden）。' +
          '　那些字是寫給螢幕閱讀器的，定義一沒了它們就直接印在畫面上。' +
          '　改法：`global.css` 的 `.sr-only` 那一段要留著 —— ' +
          '它是 1px ＋ clip-path 的寫法，別改成 display:none（那樣讀螢幕的人也聽不到）。',
      );
    }
  }
}

/*
 * 每一條規則都要出現在計數裡，就算這次一個元素都沒看過。
 *
 * 沒有這一步的話，`saw()` 寫在逐頁迴圈裡的那 24 條在「0 頁」時整個消失，
 * 而「這次沒有東西可看」那份名單只會列出 1 條 —— 看起來像「其餘 24 條
 * 都好好地查過了」。名單在最需要它的時候最安靜。
 */
for (const id of RULE_IDS) if (!subjects.has(id)) subjects.set(id, 0);

if (hiddenSubjects.size > 0) {
  const rows = [...hiddenSubjects.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  console.log(
    `\n掃不到的主體（寫在 <script> 或 <style> 裡，strip() 在掃之前就整段拿掉了）：\n` +
      rows.map(([id, n]) => `  ${String(n).padStart(5)}  ${id}`).join('\n') +
      `\n  這 ${rows.length} 條規則各少看了上面那麼多個。那不是漏掉，是掃不到 ——\n` +
      '  前端拼出來的東西（站上是搜尋結果）要等使用者打字才存在。\n',
  );
}

/*
 * ── 文件抄了一份閒置名單，而這裡每次都算得出來 ──────────
 *
 * `docs/A11Y.md` 寫著「跑完還會列出『這次沒有東西可看的規則』
 * （目前 3 條：aria-ref、img-alt、positive-tabindex）」。
 *
 * 那份名單**每跑一次就重算一次**，就在下面幾行。文件裡那一份是手抄的快照 ——
 * 站上哪天多一張圖，`img-alt` 就不再閒置，而文件不會知道。
 *
 * 第 1 輪（第三十三圈）在同一份文件上守住了「幾條規則」那個數字，
 * 但沒有守這份**清單**。第三十四圈問「這個答案系統裡已經有了嗎」——
 * 有，就在這支腳本手上，只是沒有拿去跟文件對。
 *
 * 只在掃真的 `dist/` 時比對：測試會拿 `--dir=` 指向暫存語料，
 * 那種語料的閒置名單本來就跟站上不一樣，比對它沒有意義。
 */

let docDrift = false;
/* `--doc=` 是給測試用的：帶了它就比對那一份，`--dir=` 的語料才驗得到這一格 */
const docOverride = process.argv.find((a) => a.startsWith('--doc='))?.slice('--doc='.length);
const checkDoc = docOverride !== undefined || !process.argv.some((a) => a.startsWith('--dir='));
/*
 * 文件先讀、`doc-names-real-rule` 先 `saw()` —— **都要在 `idleRules` 之前**。
 *
 * 第一版把它放在底下那個區塊裡，於是它明明判斷了 5 個 id，
 * 卻同時出現在「這次沒有東西可看的規則」名單上（而且因為名單變了，
 * 上面那條閒置名單的比對還跟著紅了一次）。
 * 東西插在它的消費者後面 —— 這是我在這個 repo 第八次犯同一個形狀。
 */
/* 不比對文件的時候也要登記 0 —— 少了這一步，這條規則會整個從計數裡消失 */
if (!checkDoc) saw('doc-names-real-rule', 0);
const doc = checkDoc
  ? await readFile(
      docOverride === undefined ? resolve(ROOT, 'docs/A11Y.md') : resolve(docOverride),
      'utf8',
    ).catch(() => '')
  : '';
/*
 * 這一段要在 `idleRules` **之前**：它自己也會 `saw()`，
 * 排在後面的話那條規則會同時「判斷過 5 個」又出現在「沒有東西可看」名單上
 * （第一版就是這樣，而且連帶讓下面那條閒置名單的比對紅了一次）。
 */
  /*
   * ── 文件點名的規則 id，還存在嗎 ────────────────────
   *
   * 第 1 輪（第三十七圈）加的。這一圈問「這一條規則，是誰要求的？
   * 寫在哪份文件裡？兩邊還一致嗎？」
   *
   * `docs/A11Y.md` 不是規則目錄（它寫的是**自動不了**的那三件事），
   * 但它在講那三件事的時候會**點名規則當證據**：
   * 「`check:a11y` 的 `positive-tabindex` 也在守這一條」、
   * 「焦點框本身是自動守住的：`focus-outline-removed` 這條規則」。
   * 今天點到 5 個 id。
   *
   * 那幾句是給**做人工走查的人**看的 —— 他讀到那一句就會跳過那一項。
   * 所以規則要是改了名或被刪掉，那份文件會變成一個**假的保證**。
   *
   * 實測過會不會被別人抓到：把 `focus-outline-removed` 在腳本裡
   * 5 處全部改名，`check:a11y` 離開碼 **0**、`check:doc-links` 0、
   * `test:doc-links` 0；只有 `test:a11y-rules` 紅 —— 而它紅的理由是
   * **它自己的 fixture 也寫著那個名字**。改名的人本來就要改那份 fixture，
   * 改完就綠了，而文件還在那裡指著一條不存在的規則。
   *
   * 「一條都沒點到」也要說話：那句話八成是文件改了寫法，
   * 而不是文件真的不再提規則 —— 安靜放行的話這一格就沒有在守了。
   */
  if (doc !== '') {
    const named = [...new Set([...doc.matchAll(/`([a-z][a-z-]{3,})`/g)].map((m) => m[1]))]
      .filter((id) => RULE_IDS.includes(id) || /^[a-z]+(-[a-z]+)+$/.test(id));
    const claimed = named.filter((id) => RULE_IDS.includes(id));
    const ghosts = named.filter(
      (id) => !RULE_IDS.includes(id) && /^(aria|img|link|button|input|focus|skip|heading|html|lang|nav|svg|duplicate|empty|positive|current|sr|unnamed|unlabelled|fullwidth|decorative|same|blank|reduced)-/.test(id),
    );
    saw('doc-names-real-rule', claimed.length);

    /*
     * ── 那三件自動不了的事，上一次做是多久以前 ────────────────
     *
     * 第 1 輪（第三十八圈）加的。這一圈問「這件事現在靠誰記得？忘了會怎樣？」
     *
     * `docs/A11Y.md` 點名三件**只能靠人**的事：Tab 順序、目標尺寸、
     * 螢幕閱讀器。前兩件有探針，但那支探針要**人手貼進 console**；
     * 第三件那份文件自己寫著「現況：**沒有人做過**」。
     *
     * 在這之前，沒有任何一個地方會提醒你這件事在變舊 ——
     * 綠燈只說靜態的那幾十條過了，而那三件事可能已經半年沒人碰。
     *
     * 這裡只把**天數**印出來，不擋：那是人的工作，關卡沒有立場替它訂期限。
     * 但「上一次是 N 天前」是個數字，而數字會讓人想起來。
     */
    const dates = [...doc.matchAll(/(?:基準（|重驗：)(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]).sort();
    const neverDone = /現況：\*\*沒有人做過\*\*/.test(doc);
    const today = projectDay();
    if (dates.length === 0) {
      console.log(
        '\n⚠ docs/A11Y.md 裡抽不到「上一次量是哪一天」—— 這一格沒有在守。\n' +
          '  那份文件記的是三件只能靠人做的事，抽不到日期通常表示寫法變了。',
      );
    } else {
      const last = dates[dates.length - 1];
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${last}T00:00:00Z`)) / 86_400_000);
      console.log(
        `\n只能靠人做的那幾件：目標尺寸與 Tab 順序上一次量是 ${last}（${days} 天前）；` +
          `螢幕閱讀器${neverDone ? '**還沒有人做過**' : '有紀錄'}。\n` +
          /*
           * 這裡曾經寫死「30 條」。第 1 輪（第四十圈）發現同一次輸出裡
           * 標題印的是「31 條規則」，而這一行印「上面那 30 條」——
           * 兩個數字差一個，因為規則加到 31 的時候沒有人回來改這一行。
           * 現在跟標題用同一個來源，而底下有一格在比兩者相等。
           */
          `  上面那 ${RULE_IDS.length} 條是靜態的，這三件它們看不到。怎麼做在 docs/A11Y.md，\n` +
          '  前兩件有一支貼進 console 就能跑的探針（scripts/probe-a11y-layout.js）。',
      );
    }
    if (claimed.length === 0) {
      console.log(
        '\n⚠ docs/A11Y.md 一個規則 id 都沒點到 —— 這一格沒有在守。\n' +
          '  那份文件本來會拿規則當證據（「這一條 check:a11y 已經在守」）。\n' +
          '  一個都抓不到，通常是文件換了寫法，不是它真的不再提規則。',
      );
    }
    for (const g of ghosts) {
      docDrift = true;
      console.log(
        `\n✗ docs/A11Y.md 點名了 \`${g}\`，而 RULE_IDS 裡沒有這一條。\n` +
          '      那份文件是給做人工走查的人看的 —— 他讀到「這一條已經自動守住」\n' +
          '      就會跳過那一項。指到一條不存在的規則，等於一個假的保證。\n' +
          '      改法：規則改名的話文件跟著改；真的刪掉的話，把那句話改成\n' +
          '      「這一項現在沒有自動守」，不要留著。',
      );
    }
}

/*
 * `doc-names-real-rule` 不進這份名單。
 *
 * 這份名單底下印的話是「**站上沒有這種元素**」，而那一條看的不是站上的元素，
 * 是 `docs/A11Y.md` 點名了幾個規則 id。放進去的話那句話會對它說謊。
 *
 * 而且它的主體數會隨 `--doc=` 有沒有帶而變（測試用 `--dir=` 時不比對文件），
 * 於是「文件抄的閒置名單」那一格會因為這條規則進進出出而假紅一次。
 */
const idleRules = [...subjects.entries()]
  .filter(([id, n]) => n === 0 && id !== 'doc-names-real-rule')
  .map(([id]) => id)
  .sort();
if (checkDoc && doc === '') {
  console.log('\n⚠ 讀不到 docs/A11Y.md —— 閒置名單沒有跟文件對過。');
} else if (checkDoc) {
  /* 「（目前 N 條：a、b、c）」——括號裡那一串就是被抄下來的答案 */
  const claim = /這次沒有東西可看的規則」（目前 \d+ 條：\s*([^）]+)）/.exec(doc.replace(/\n/g, ''));
  if (!claim) {
    console.log(
      '\n⚠ docs/A11Y.md 裡找不到閒置名單的說法 —— 這一格沒有在守。\n' +
        '  文件換了寫法的話，這裡的樣式要跟著改（不然它會安靜地什麼都不比）。',
    );
    docDrift = true;
  } else {
    const listed = claim[1].split(/[、，,]/).map((t) => t.replace(/[`\s]/g, '')).filter(Boolean).sort();
    if (listed.join('|') !== idleRules.join('|')) {
      docDrift = true;
      console.log(
        `\n✗ docs/A11Y.md 的閒置名單過期了。\n` +
          `      文件寫：${listed.join('、') || '（空的）'}\n` +
          `      實際是：${idleRules.join('、') || '（一條都沒有）'}\n` +
          '      那份名單這支腳本每次都會重算 —— 文件裡那一份是手抄的快照。\n' +
          '      改法：把 docs/A11Y.md「跑完還會列出」那一段的括號內容換成上面實際的那幾條。',
      );
    }
  }
}

// ── 輸出 ──────────────────────────────────────────────

/*
 * ── 標題要說「幾條規則」，不只是「幾頁」 ──────────
 *
 * 第 1 輪（第二十九圈）問「第一次跑的人跟第一百次跑的人看到的是同一份
 * 東西嗎」。量了一次綠燈的輸出：這一支只說「44 頁」，**沒說跑了幾條規則**。
 * 而 `check:copy` 說「掃了 61 個檔案、13646 行」、`check:links` 說
 * 「44 頁、1263 個站內連結」—— 這一支是少數不說自己判斷過多少的。
 *
 * 這個 repo 從第二十一圈起的整套規矩就是「綠燈不說明判斷過什麼，
 * 等於沒說」。標題是第一次跑的人唯一一定會看到的地方。
 */
console.log(
  '\n無障礙靜態檢查（' + pageCount + ' 頁、' + RULE_IDS.length + ' 條規則）\n' + '='.repeat(72),
);

/*
 * ── 一頁都沒有，那不是「沒有問題」──────────────────
 *
 * `verify:all` 是 `build && … && check:a11y`，所以正常情況不會走到這裡。
 * 但「正常情況不會發生」正是這一圈在找的東西：真的發生時，
 * 這支腳本原本會印「沒有發現問題」然後 exit 0 ——
 * **25 條規則一條都沒跑，而關卡是綠的。**
 */
if (pageCount === 0) {
  console.log(
    '\nX 一頁都沒有掃到 —— 這不是「沒有問題」，是「什麼都沒檢查」。\n' +
      `  找的是 ${DIST} 底下的 .html。\n` +
      '  改法：先跑 npm run build；如果是用 --dir= 指過來的，確認那個路徑對不對。\n',
  );
  process.exit(1);
}

if (findings.length === 0) {
  console.log('\n沒有發現問題。');
  /*
   * 這段列的是**這支腳本查不到、只能靠人的**東西。
   *
   * 為什麼查不到：那三件事都要算版面（多大、離多遠、Tab 走到哪），
   * 而算版面要有排版引擎 —— 這個專案刻意沒有瀏覽器那個相依套件。
   * **那個決定的理由與有效期限**寫在 docs/ARCHITECTURE.md 的
   * 「檢查用的瀏覽器：這個決定的有效期限」（第 1 輪〔第二十八圈〕重新查過，
   * 兩個理由過期了一個）。
   *
   * **怎麼做、上一次量到什麼，全部在 `docs/A11Y.md`。**
   * 這裡不重複那些數字：第 1 輪（第二十七圈）之前，數字寫在這個註解裡
   * 而量法哪裡都沒有 —— 於是「最小餘裕 17.9px」沒人知道是相對於什麼，
   * 重現時試了三種解讀（原始圓心距 41.9、框的間隙 16.0、圓心距減 24 才是 17.9）。
   * 結論留在程式碼裡、方法留在文件裡，只會再發生一次同樣的事。
   */
  /*
 * ── 哪幾條這次沒有東西可看 ────────────────────────
 *
 * 綠燈有兩種：「檢查過而且沒問題」與「沒有東西可檢查」。
 * 這兩種在輸出上長得一模一樣，而它們的意思完全不同。
 * `audit:privacy` 早就為同一件事做過處理（拿不到身分值時會明講
 * 「身分規則沒有執行」）—— 理由是安靜地什麼都沒檢查比較危險。
 *
 * 第 1 輪（第十五圈）實測：站上 **0 張 `<img>`、0 個 aria 參照、
 * 0 個 tabindex**，所以那三條從來沒有判斷過任何一個元素。
 */
{
  /*
   * 從 `subjects` 自己取名單，不另外維護一份規則清單。
   * 每條規則的迴圈都會呼叫 `saw(id, n)`（n 可能是 0），所以有呼叫就有鍵。
   * 漏了呼叫的規則會安靜地不出現在這裡 —— `test:a11y-rules` 有一格在守那個。
   */
  /*
   * ── `--verbose` 把每一條規則實際判斷過幾個東西印出來 ──
   *
   * 第 1 輪（第二十一圈）問的是「它到底看過多少東西」——
   * 第十五圈問過「有沒有東西」（0 或非 0），這一圈問的是**數量**：
   * 一條只判斷過 2 個元素的規則，跟判斷過 899 個的，
   * 在「綠燈代表什麼」上完全不是同一回事。
   *
   * 那次是拿一段丟掉的補丁量出來的。留成 `--verbose` 的一部分，
   * 下次要問同一個問題不用再改程式。
   */
  if (VERBOSE) {
    const rows = [...subjects.entries()].sort((a, b) => b[1] - a[1]);
    console.log('每條規則實際判斷過的元素數：');
    for (const [id, n] of rows) console.log(`  ${String(n).padStart(5)}  ${id}`);
    console.log('');
  }

  /*
   * ── 那個能回答「到底判斷過多少東西」的旗標，要說得出口 ──────────
   *
   * `--verbose` 會印出每條規則實際判斷過幾個元素（link-name 899 個、
   * heading-order 161 個⋯⋯）—— 那正是「綠燈代表什麼」的答案。
   *
   * 第 1 輪（第二十九圈）量到：七支關卡裡**六支有 --verbose，而輸出
   * 從來不提它**（只有 check:contrast 提）。也就是說老手知道要打，
   * 第一次跑的人不知道那個東西存在。
   *
   * 一行就能讓它被看見。
   */
  if (!VERBOSE) {
    console.log('要看每條規則實際判斷過幾個元素：npm run check:a11y -- --verbose\n');
  }

  const idle = idleRules;
  if (idle.length > 0) {
    console.log(
      `這次沒有東西可看的規則（${idle.length} 條）：${idle.join('、')}\n` +
        '  它們是綠的，但那不是「檢查過而且沒問題」，是「站上沒有這種元素」。\n' +
        '  哪天內容裡出現了，這幾條才第一次真的在守。\n',
    );
    /*
     * 上面那句「站上沒有這種元素」有一種情況會說謊：元素在，但寫在
     * script／style 裡，`strip()` 拿掉了。第 1 輪（第四十三圈）實測過
     * `<button>` 藏在 script 裡的樣子 —— 那時報告兩件事都沒說。
     */
    const blind = idle.filter((id) => hiddenSubjects.has(id));
    if (blind.length > 0) {
      console.log(
        `  其中 ${blind.length} 條站上其實有這種元素，只是寫在 script／style 裡掃不到：` +
          `${blind.join('、')}\n` +
          '  對這幾條來說，上面那句「站上沒有這種元素」是不對的。\n',
      );
    }
  }
}

console.log(
  '（還是要人工的三件事：Tab 的**順序**合不合理、互動目標的尺寸（WCAG 2.5.8）、\n' +
    '  實際開一次螢幕閱讀器聽。\n' +
    '  **怎麼做寫在 docs/A11Y.md**，前兩件有一支貼進 console 就能跑的探針\n' +
    '  （scripts/probe-a11y-layout.js），第三件目前**還沒有人做過**。\n' +
    '  焦點框本身已經自動守住了 —— focus-outline-removed 這條規則，\n' +
    '  加上 check:contrast 會算焦點色在深淺兩套下的對比）\n',
);
  process.exit(docDrift ? 1 : 0);
}

/** 同一個問題常常每一頁都出現一次，合併起來看才有意義 */
const grouped = new Map();
for (const f of findings) {
  const key = f.level + ' ' + f.rule + ' ' + f.detail;
  if (!grouped.has(key)) grouped.set(key, { ...f, files: [] });
  grouped.get(key).files.push(f.file);
}

const errors = [...grouped.values()].filter((g) => g.level === 'error');
const warns = [...grouped.values()].filter((g) => g.level === 'warn');

for (const [label, group, mark] of [
  ['必須修正', errors, 'X'],
  ['建議處理', warns, '!'],
]) {
  if (group.length === 0) continue;
  console.log('\n' + label + '（' + group.length + ' 類）');
  /*
   * ── 同一條規則印太多類的話，先壞掉的是報告 ──────────
   *
   * 每一「類」的頁面清單早就有上限（3 頁 ＋「另外 N 頁」），但**類本身沒有**。
   * 第 1 輪（第十九圈）灌 500 篇假內容量到：`same-name-different-target`
   * 一次報 **75 類**，整份輸出 439 行 —— 每一條訊息都是對的、都有改法，
   * 但沒有人會讀完 439 行。站上內容一多，先不能用的是這份報告。
   *
   * 所以同一條規則最多印 3 類，其餘收成一行。`--verbose` 仍然全印。
   * 這跟頁面清單那個上限是同一個判準，只是套在另一個維度上。
   */
  const perRule = new Map();
  for (const g of group) {
    const n = (perRule.get(g.rule) ?? 0) + 1;
    perRule.set(g.rule, n);
    if (!VERBOSE && n > 3) continue;
    console.log('\n  ' + mark + ' [' + g.rule + '] ' + g.detail);
    const shown = VERBOSE ? g.files : g.files.slice(0, 3);
    for (const f of shown) console.log('      ' + f);
    if (!VERBOSE && g.files.length > 3) {
      console.log('      …另外 ' + (g.files.length - 3) + ' 頁（--verbose 看全部）');
    }
  }
  if (!VERBOSE) {
    for (const [rule, n] of perRule) {
      if (n > 3) {
        console.log(
          '\n  ' + mark + ' …另外 ' + (n - 3) + ' 類也是 ' + rule +
            '（同一條規則，改法一樣；--verbose 看全部）',
        );
      }
    }
  }
}

console.log('\n' + '='.repeat(72));
console.log(
  '必須修正 ' + errors.length + ' 類、建議處理 ' + warns.length + ' 類，共 ' + findings.length + ' 處。\n',
);

/*
 * ── 上面那些路徑是**建置產物**，不是要改的檔案 ──────────
 *
 * 第 1 輪（第十七圈）量到的：24 條規則印出來的位置**全部**是 `dist/…html`，
 * 而沒有任何一句話提過那是 build 出來的東西。
 * 站主要改的是 `src/` 底下的元件與內容 —— 這一步從來沒有人說。
 *
 * 給的是能直接貼進終端機的一行：拿訊息裡引的那段標記去 `src/` 找。
 * （Astro 的 `data-astro-cid-⋯` 只在產出裡，對不回元件名，所以用內容找。）
 */
if (findings.length > 0) {
  console.log(
    '上面的路徑是 dist/ 底下的**建置產物**，改不得 —— 要改的是 src/ 底下的元件或內容。\n' +
      '  找出處：把訊息裡引的那段標記（class 名、文字都行）拿去搜，例如\n' +
      '      grep -rn "poem__original" src/\n',
  );
}
/*
 * ── 最後一行用 `process.exitCode`，不用 `process.exit()` ──────────
 *
 * `process.exit()` **不等 stdout 排空**。輸出接到終端機時是同步寫的，
 * 所以看不出差別；接到**管線**（`| tail`、CI 的 log 收集）時，
 * 超過管線緩衝區的部分會是非同步的，而 `process.exit()` 會把它丟掉。
 *
 * 第 7 輪（第四十五圈）量了這台機器的緩衝區與每一支關卡的輸出：
 *
 *     管線緩衝區          65,536 bytes
 *     最大的一支輸出      13,827 bytes（check:perf --verbose）＝ 21%
 *
 * 也就是說**今天還咬不到**。改它不是在修一個現在會發生的錯，
 * 是在拿掉一個「輸出長大就會安靜地開始截斷」的機制 ——
 * 而這個 repo 的輸出每一圈都在長。
 *
 * 最後一行是輸出累積最多的那一刻，所以先改這裡。
 * 檔案裡中途早退的那幾個 `process.exit()` 記在待辦（它們累積的比較少）。
 *（`check:perf` 與 `check:content` 第 7 輪〔第四十四圈〕就改過了。）
 */
process.exitCode = errors.length > 0 || docDrift ? 1 : 0;
