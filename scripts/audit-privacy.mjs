#!/usr/bin/env node
// @ts-check
/**
 * 隱私與安全稽核。
 *
 *   node scripts/audit-privacy.mjs
 *
 * privacy.ts 是一道閘門，但閘門只有在大家都走門的時候才有用。
 * 這個腳本負責抓「翻牆的人」，分三個層次：
 *
 *   1. 原始碼：把本名、校名寫死在頁面裡，或偷偷引進第三方資源
 *   2. 建置產物：dist/ 的 HTML 裡有沒有真的會發出去的第三方請求
 *      （第 1 層是看「寫了什麼」，這一層是看「最後長出什麼」——
 *       第 4 輪同步進來的 YouTube 縮圖網址就是只存不載入的例子，
 *       必須有東西把關這件事不會哪天被改掉）
 *   3. GitHub Actions：把使用者輸入直接插進 run: 的 script injection
 *
 * CI 會跑這個。有紅燈就擋下來，不讓它上線。
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

/*
 * 預設是專案根目錄，`--root=<路徑>` 可以指到別的地方。
 *
 * 那個選項存在的唯一理由是 scripts/test-privacy-structural.mjs ——
 * 這支腳本除了「內容比對規則」之外還有 8 個**結構性檢查**
 * （Actions 的 script injection、CSP 有沒有被拿掉或放寬、部署前有沒有關卡、
 * 個資檔有沒有被 git 追蹤⋯⋯），而那些**從來沒有人確認過會不會響**。
 *
 * 要驗它們就得放真的違規進去，而在真的 repo 上那樣做太危險
 * （備份還原中途失敗就把專案弄髒了）。指到一份拋棄式的假 repo 才安全。
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg
  ? resolve(rootArg.slice('--root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 這些檔案本來就會提到受保護的欄位名稱，不算違規 */
const ALLOWLIST = new Set([
  'src/config/privacy.ts',
  'src/config/identity.local.ts',          // 本機專用，已在 .gitignore
  'src/config/identity.local.example.ts',  // 只有假資料
  'scripts/audit-privacy.mjs',
  'scripts/lib/privacy-rules.mjs',      // 規則本身會提到要防的字串
  'scripts/lib/identity-needles.mjs',   // 同上，而且它解釋了為什麼不再寫死真值
  /*
   * 測試檔案裡**一定**會有它們要測的那些東西：假信箱、AWS 的文件範例金鑰、
   * Google Fonts 的網址、注入的樣子。那是測試資料，不是洩漏。
   *
   * 這個「解釋或測試一條規則，就會需要那條規則禁止的東西」的模式，
   * 在這個專案出現過五次了（第二圈第 5、6 輪，第三圈第 5、7 輪，第四圈第 5 輪）。
   *
   * **注意 identity-value 那條仍然會穿透這份豁免清單**（見下面的 IDENTITY_HOME）——
   * 真的個資就算寫在測試檔裡也會被抓到。豁免的只是「樣式比對」那些規則。
   */
  'scripts/test-privacy-rules.mjs',
  'scripts/test-privacy-structural.mjs',
  'docs/PRIVACY.md',
]);

const SCAN_DIRS = ['src', 'scripts', 'public', 'docs', '.github'];

/*
 * 根目錄的檔案也要掃。
 *
 * 第 5 輪（第五圈）發現它們**完全沒有被掃過** —— SCAN_DIRS 只列了子目錄，
 * 而 repo 根目錄有 13 個進版控的檔案，包括 `README.md`、`CLAUDE.md`、
 * `astro.config.mjs`、`.env.example`。
 *
 * 實測：把一個信箱和一個個資 needle 放進 README.md，稽核回報「乾淨」。
 *
 * **散文最容易寫到名字**，而 README 與 CLAUDE.md 正是這個 repo 裡
 * 最多散文的地方。這道檢查是「個資不進 repo」的最後一道防線，
 * 卻剛好看不到最可能出事的位置。
 *
 * `package-lock.json` 排除掉：它很大、內容是機器產生的，
 * 而且裡面的 URL 會讓 email 規則誤報（實測過）。
 */
const SCAN_ROOT_FILES = true;
const ROOT_FILE_SKIP = new Set(['package-lock.json']);
const SCAN_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.astro', '.md', '.mdx',
  '.json', '.html', '.css', '.yml', '.yaml', '.txt', '.svg',
  /*
   * `.webmanifest` 是第 5 輪（第十圈）補的。實測：把同一組探針
   * （一個 googletagmanager 網址 ＋ 一個 email）分別放進
   * `public/site.webmanifest` 與 `public/x.json`，稽核對後者報
   * 「必須修正 1」，對前者**完全沒有反應** —— 同樣的內容、同樣的目錄，
   * 差別只有副檔名。而那個檔案每一頁的 `<head>` 都引用，
   * 會原封不動被複製到 dist。
   *
   * `''` 是沒有副檔名的檔案（這個 repo 裡是 `public/CNAME`）。
   * 這類檔案在這裡都是純文字，而且都會出貨。
   */
  '.webmanifest', '',
]);

/**
 * 明確認定為二進位、不需要掃的副檔名。
 *
 * 這一份存在的理由不是效能，是**讓視野的缺口不能安靜地存在** ——
 * 見底下的 `unscanned-file-type`。
 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav',
  '.pdf', '.zip', '.gz', '.br',
]);

/**
 * 每條規則：正則、嚴重程度、為什麼這是問題。
 * 訊息要寫得讓人一看就知道該怎麼改，不然沒人會理它。
 */
import { RULES as STATIC_RULES } from './lib/privacy-rules.mjs';
import { readIdentityNeedles, identityRules } from './lib/identity-needles.mjs';

/*
 * 個資的值不寫在這個 repo 裡（見 lib/identity-needles.mjs 的說明）。
 * 取不到的時候身分規則就不跑 —— 那件事一定要印出來，見底下的輸出。
 */
const identity = readIdentityNeedles(ROOT);
const RULES = [...STATIC_RULES, ...identityRules(identity.needles)];

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.astro', '.git'].includes(entry.name)) continue;
      yield* walk(full);
    } else if (SCAN_EXT.has(extname(entry.name))) {
      yield full;
    }
  }
}

const findings = [];
/** 不算問題、但必須說出口的事：某一項「這次沒有檢查」（說了不擋） */
const notices = [];

/**
 * 每一項這次實際判斷過幾個東西。
 *
 * 第二十一圈的問題：一條只判斷過 2 個東西的規則，跟判斷過 899 個的，
 * 綠燈的意思完全不一樣。這一支尤其明顯 —— 它有兩種很不一樣的檢查混在一起：
 * 十條正則規則（掃檔案）與十幾項結構檢查（各自看很不一樣的東西），
 * 而報告上它們長得一模一樣。
 *
 * @type {Map<string, number>}
 */
const subjects = new Map();
/** 這一項這次看了 n 個東西（n 可以是 0，那正是重點） */
const saw = (/** @type {string} */ id, /** @type {number} */ n) =>
  subjects.set(id, (subjects.get(id) ?? 0) + n);

/*
 * ── GitHub Actions 的 script injection ──────────────────────
 *
 * `run:` 區塊裡的 ${{ ... }} 是在 shell 看到指令之前就被**字面代換**掉的。
 * 所以 `--only="${{ inputs.only }}"` 這種寫法，只要輸入含有引號與分號，
 * 就會變成好幾個獨立指令 —— 而那些 job 往往同時握有 secrets 與寫入權限。
 *
 * secrets.* 不算：那是 GitHub 注入的，不是外部可控的值。
 * 正確做法是先落到 env: 再用 "$VAR" 引用。
 */
{
  const wfDir = resolve(ROOT, '.github/workflows');
  /** @type {string[]} */
  let files = [];
  try {
    files = (await readdir(wfDir)).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    files = [];
  }
  saw('actions-script-injection', files.length);
  for (const name of files) {
    const text = await readFile(resolve(wfDir, name), 'utf8');
    const lines = text.split('\n');
    let inRun = false;
    let runIndent = 0;
    lines.forEach((line, i) => {
      /*
       * `- run: cmd` 跟 `run: cmd` 兩種寫法都要認。
       *
       * 第一版只寫 `^\s*run:`，配不到清單項目那種形式 —— 而那是很常見的寫法
       * （這個專案自己的 check.yml 就有一行 `- run: npm ci`）。
       * 也就是說：**注入寫成 `- run: echo "${{ … }}"` 的話，這條檢查看不到。**
       * 第 5 輪（第四圈）寫結構性檢查的實測時才發現，在那之前
       * 沒有人確認過這條會不會響。
       *
       * runIndent 取的是 `run:` 這個字本身的位置（不是行首），
       * 這樣多行 `run: |` 的後續行才比得對。
       */
      const runMatch = /^(\s*(?:-\s+)?)run:/.exec(line);
      if (runMatch) {
        inRun = true;
        runIndent = runMatch[1].length;
      } else if (inRun && line.trim() && line.length - line.trimStart().length <= runIndent) {
        inRun = false;
      }
      if (!inRun || !line.includes('${{')) return;
      const exprs = [...line.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
      const risky = exprs.filter((e) => !e.startsWith('secrets.'));
      if (risky.length === 0) return;
      findings.push({
        rel: `.github/workflows/${name}`,
        lineNo: i + 1,
        line: line.trim().slice(0, 110),
        matched: risky.join(', '),
        rule: {
          id: 'actions-script-injection',
          level: 'error',
          why:
            `run: 裡直接插了外部可控的運算式（${risky.join(', ')}）。` +
            '那是字面代換，含引號與分號的輸入會變成獨立指令，' +
            '而這類 job 通常握有 secrets 與寫入權限。' +
            '　改法：先把那個值寫進 env:，再在 run: 裡用 "$VAR" 引用。',
        },
      });
    });
  }
}

/*
 * ── 建置產物的第三方請求 ────────────────────────────────
 *
 * 「零第三方請求」是硬性限制，但前面的規則只看原始碼。
 * 這一段直接看 dist/：會真的發出請求的寫法指到外部網域就是違規。
 *
 * 純粹的 <a href> 不算 —— 那是使用者按了才會去，本來就是外連。
 *
 * ── 第 5 輪（第三十六圈）補的兩塊 ──────────
 *
 * 原本這一段只讀 `.html`，而且只認**標籤屬性**（src／data／link href）。
 * 量出來的缺口：dist 有 61 個檔案，讀到的是 44 個；
 * 而那 44 個裡有 **82 個內嵌 `<style>` 區塊**，裡面的 `url()` 一個都看不到
 * —— 這個站的樣式是內嵌的（`inlineStylesheets: 'auto'`），
 * 所以「看得到標籤、看不到樣式」等於漏掉讀者真的會下載的那一半。
 *
 * 實測過那個後果：在 `dist/_astro/*.css` 最前面加一行
 * `@import url("https://fonts.googleapis.com/css2?…")`，
 * 也就是**每一個讀者都會下載到的那份 CSS**，然後跑全部七支檢查 ——
 * `audit:privacy` 說「必須修正 0」，`check:perf`、`check:a11y`、
 * `check:content`、`check:copy`、`check:links` 一個字都沒說。
 * 這個專案的第一條硬性限制，在產出那一端沒有人在守。
 *
 * 所以現在多做兩件事：
 *   1. 讀 dist 裡**會出貨的文字檔**（css／webmanifest／json／txt／svg），不只 html
 *   2. 認 `url()` 與 `@import` —— 不管它在 .css 裡還是在內嵌的 `<style>` 裡
 *
 * 二進位（png／ico）與內容檔（xml 的 RSS／sitemap）不讀：
 * feed 裡的外部網址是**內容**（她的影片連結），不是請求。
 */
/**
 * dist 裡**每一個**檔案的副檔名分佈（不經過 SCAN_EXT 的篩子）。
 *
 * 要另外走一次的理由：`walk()` 自己就用 SCAN_EXT 篩過了，
 * 所以在那個迴圈裡數「跳過幾個」永遠是 0 —— 那會是一個假的數字，
 * 而假的 0 比不說更糟（讀起來像「全部都讀了」）。
 */
const distExt = /** @type {Map<string, number>} */ (new Map());
if (existsSync(resolve(ROOT, 'dist'))) {
  /** @param {string} dir @returns {AsyncGenerator<string>} */
  async function* rawWalk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) yield* rawWalk(full);
      else yield full;
    }
  }
  for await (const f of rawWalk(resolve(ROOT, 'dist'))) {
    const e = extname(f) || '（沒有副檔名）';
    distExt.set(e, (distExt.get(e) ?? 0) + 1);
  }
}
if (existsSync(resolve(ROOT, 'dist'))) {
  const LOADING = /<(?:script|iframe|img|source|video|audio|embed|object)\b[^>]*\b(?:src|data)\s*=\s*"(https?:\/\/[^"]+)"/gi;
  const LINKS = /<link\b[^>]*\bhref\s*=\s*"(https?:\/\/[^"]+)"[^>]*>/gi;
  const SAFE_REL = /rel\s*=\s*"(?:canonical|alternate|me|author|license|help)"/i;

  /*
   * ── 隱私頁承諾的 rel，跟產出裡的外部連結對得上嗎 ──────────
   *
   * `/privacy` 對訪客說「站上的外部連結一律加上 rel="noreferrer"」。
   * 那句話**是承諾**，而它的真假這支腳本查得到 —— 產出裡每一個外部
   * `<a href="http…">` 帶著什麼 rel，就在同一個 `dist/` 裡。
   *
   * 第 5 輪（第三十四圈）量到：那句話原本是寫死的常數，而實際的 rel 來自
   * `externalLinkRel`（`privacy.strictReferrerPolicy ? 'noopener noreferrer' : 'noopener'`）。
   * 把那個開關關掉，44 頁裡 58 個外部連結全部掉了 noreferrer，
   * **而那一頁還是照樣承諾**。承諾與事實各走各的。
   *
   * 那一句已經改成跟著開關走。這一條守的是**兩邊真的對得上** ——
   * 而且它不需要讀 `privacy.ts`（那是 TypeScript，這支腳本讀不到）：
   * 承諾就印在頁面上，事實就在隔壁的檔案裡，兩個都在 `dist/`。
   */
  const promiseFile = resolve(ROOT, 'dist/privacy/index.html');
  /** 隱私頁自己說的那個 rel（例如 `noreferrer`）；讀不到就是 null */
  let promisedRel = null;
  if (existsSync(promiseFile)) {
    const m = /<code>rel="([^"]+)"<\/code>/.exec(await readFile(promiseFile, 'utf8'));
    promisedRel = m ? m[1] : null;
  }
  /*
   * 先登記一次（主體 0）—— 不然沒有 `dist/privacy/` 的時候這條規則
   * **整條不存在**，而「規則有幾條」在不同語料上就會不一樣。
   * 這是這個 repo 的老規矩：閒置的規則要補 0，不要從名單上消失。
   */
  saw('external-link-rel-broken-promise', 0);
  if (promisedRel === null) {
    notices.push(
      '隱私頁承諾的 rel 讀不到 —— 「外部連結的 rel 跟承諾對得上嗎」這一條沒有執行。\n' +
        '  （dist/privacy/index.html 不在，或那句話換了寫法而 <code>rel="…"</code> 抽不到。）',
    );
  }

  /*
   * ── 那一頁還承諾了別的事，也拿產出去對 ────────────────
   *
   * 第 5 輪（第三十七圈）加的。這一圈問「這一條規則，是誰要求的？
   * 寫在哪份文件裡？」——隱私這一支的答案特別清楚：**要求它的是那一頁**，
   * 而那一頁是給**讀者**看的，不是給維護者看的。
   *
   * 把 `/privacy` 的承諾逐條列出來，對照現在有沒有東西在守：
   *
   *   不用分析服務              analytics ✓
   *   不用外部字型／CDN／圖片    google-fonts、third-party-cdn、built-third-party-request ✓
   *   不嵌入自動載入的第三方     raw-youtube-embed ✓
   *   localStorage 只有兩項      storage-not-documented、storage-documented-not-used ✓
   *   宣告 CSP 只載自己的網域    csp-missing、csp-no-default-src、csp-unsafe-inline ✓
   *   外部連結一律 noreferrer    external-link-rel-broken-promise ✓（第三十四圈加的）
   *   **不使用 cookie**          —— 沒有人在守
   *   **影片框用 youtube-nocookie.com**  —— 沒有人在守
   *
   * 兩條都是真的（今天 `document.cookie` 在產出裡 0 次、
   * CSP 的 `frame-src` 就是 `https://www.youtube-nocookie.com`），
   * 但**沒有東西讓它們保持為真**。
   *
   * 影片那一條特別值得守：`VideoFacade` 到今天**一次都沒有算繪過**
   * （站上還沒有影片），所以那段組網址的程式沒有人跑過。
   * 真正擋著的是 CSP 的 `frame-src` —— 而 CSP 現在沒有任何一條規則
   * 拿它跟那一頁的承諾對。
   */
  /** 產出裡的 HTML —— 跟底下那個迴圈走同一份語料 */
  const htmlFiles = [];
  for await (const f of walk(resolve(ROOT, 'dist'))) if (f.endsWith('.html')) htmlFiles.push(f);
  const promisePage = existsSync(promiseFile) ? await readFile(promiseFile, 'utf8') : '';
  /** 那一頁的**可見文字**（承諾寫在文字裡，不在標籤裡） */
  const promiseText = promisePage
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  saw('cookie-promised-none', 0);
  saw('csp-frame-host-unpromised', 0);
  if (promisePage === '') {
    notices.push('讀不到 dist/privacy/index.html —— cookie 與影片框那兩條承諾沒有對過。');
  } else {
    /*
     * 一、那一頁說「不使用 cookie」。產出裡任何一處寫 cookie 都是打臉。
     * 讀的是**設值**那一種（`document.cookie = …`）—— 只是讀取不會建立 cookie。
     */
    const saysNoCookie = /不使用\s*cookie/i.test(promiseText);
    if (saysNoCookie) {
      for (const file of htmlFiles) {
        saw('cookie-promised-none', 1);
        const text = await readFile(file, 'utf8');
        for (const m of text.matchAll(/document\s*\.\s*cookie\s*=/g)) {
          findings.push({
            rel: relative(ROOT, file),
            lineNo: text.slice(0, m.index).split('\n').length,
            line: m[0],
            matched: 'document.cookie',
            rule: {
              id: 'cookie-promised-none',
              level: 'error',
              why:
                '/privacy 對讀者說「不使用 cookie」，而這裡在設一個。' +
                '　改法：那一頁是承諾，不是描述 —— 要嘛不要設，要嘛先改那一頁。',
            },
          });
        }
      }
    }

    /*
     * 二、那一頁點名影片框用哪個網域。CSP 的 `frame-src` 允許的
     * **每一個**主機都要是那一頁提過的，不然讀者被承諾的跟瀏覽器允許的不一樣。
     */
    /*
     * 兩段就算一個網域（`youtube-nocookie.com`）。第一版寫成「至少三段」，
     * 於是那一頁點名的網域一個都沒抽到，44 頁全部誤報。
     */
    const named = new Set(
      [...promiseText.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)]
        .map((m) => m[0].toLowerCase())
        .filter((h) => /\.[a-z]{2,}$/.test(h)),
    );
    for (const file of htmlFiles) {
      const text = await readFile(file, 'utf8');
      const csp = /frame-src([^;"']*)/i.exec(text);
      if (!csp) continue;
      saw('csp-frame-host-unpromised', 1);
      for (const token of csp[1].split(/\s+/).filter(Boolean)) {
        if (token === "'self'" || token === "'none'" || token.startsWith("'")) continue;
        let host;
        try {
          host = new URL(token.includes('//') ? token : `https://${token}`).host.toLowerCase();
        } catch {
          continue;
        }
        const bare = host.replace(/^www\./, '');
        if ([...named].some((n) => n === host || n === bare || host.endsWith(`.${n}`))) continue;
        findings.push({
          rel: relative(ROOT, file),
          lineNo: text.slice(0, csp.index).split('\n').length,
          line: `frame-src ⋯ ${token}`,
          matched: host,
          rule: {
            id: 'csp-frame-host-unpromised',
            level: 'error',
            why:
              `CSP 允許把 ${host} 放進 iframe，而 /privacy 沒有跟讀者提過這個網域。` +
              '　改法：那一頁點名了影片框用哪個網域 —— 兩邊要一樣。' +
              '真的要多開一個的話，先去那一頁把它寫出來。',
          },
        });
      }
    }
  }

  /*
   * `url(https://…)` 與 `@import` —— CSS 裡「會自己發出請求」的兩種寫法。
   * 放在這裡而不是 privacy-rules.mjs，是因為它只對**產出**成立：
   * 原始碼那一端已經有 google-fonts／third-party-cdn 在守。
   */
  const CSS_URL = /url\(\s*["']?(https?:)?\/\/[^)"']+/gi;
  const CSS_IMPORT = /@import\s+(?:url\(\s*)?["'](https?:)?\/\/[^"']+/gi;
  /** dist 裡會出貨、而且讀得懂的純文字 —— 二進位與 feed 不在內（理由見上面） */
  const BUILT_TEXT = new Set(['.html', '.css', '.webmanifest', '.json', '.txt', '.svg', '']);

  for await (const file of walk(resolve(ROOT, 'dist'))) {
    if (!BUILT_TEXT.has(extname(file))) continue;
    saw('built-third-party-request', 1);
    const rel = relative(ROOT, file);
    const text = await readFile(file, 'utf8');

    const hits = [];
    for (const m of text.matchAll(LOADING)) hits.push([m[1], m[0]]);
    for (const m of text.matchAll(LINKS)) {
      // canonical / alternate 只是宣告，不會發出請求
      if (!SAFE_REL.test(m[0])) hits.push([m[1], m[0]]);
    }
    /*
     * 整份檔案一起掃，不先切出 `<style>` ——
     * `url(https://…)` 不管出現在哪裡都是一個請求，
     * 而切區塊反而會漏掉 `style="background:url(…)"` 那種寫在屬性裡的。
     */
    for (const m of text.matchAll(CSS_URL)) hits.push([m[0].replace(/^url\(\s*["']?/i, ''), m[0]]);
    for (const m of text.matchAll(CSS_IMPORT)) hits.push([m[0].replace(/^@import\s+(?:url\(\s*)?["']/i, ''), m[0]]);
    /*
     * webmanifest 的圖示是瀏覽器自己會去抓的（安裝、加到主畫面、分頁圖示），
     * 而它是 JSON —— 上面每一個樣式都認不出來。
     * 只對 .webmanifest 這樣讀：`search-index.json` 裡的網址是**內容**，不是請求。
     */
    if (extname(file) === '.webmanifest') {
      for (const m of text.matchAll(/"(?:src|url)"\s*:\s*"((?:https?:)?\/\/[^"]+)"/gi)) {
        hits.push([m[1], m[0]]);
      }
    }

    /* 承諾 vs 事實：外部的 <a> 有沒有帶著隱私頁說的那個 rel */
    if (promisedRel !== null) {
      for (const m of text.matchAll(/<a\b[^>]*\bhref\s*=\s*"(https?:\/\/[^"]+)"[^>]*>/gi)) {
        let host;
        try {
          host = new URL(m[1]).host;
        } catch {
          continue;
        }
        if (host.endsWith('bellafoxy.com')) continue;
        saw('external-link-rel-broken-promise', 1);
        const relAttr = /\brel\s*=\s*"([^"]*)"/i.exec(m[0])?.[1] ?? '';
        if (relAttr.split(/\s+/).includes(promisedRel)) continue;
        findings.push({
          rel,
          lineNo: text.slice(0, text.indexOf(m[0])).split('\n').length,
          line: m[0].slice(0, 110),
          matched: m[1].slice(0, 60),
          rule: {
            id: 'external-link-rel-broken-promise',
            level: 'error',
            why:
              `隱私頁對訪客承諾外部連結一律有 rel="${promisedRel}"，而這一個沒有（rel="${relAttr}"）。` +
              '　改法：那個連結的 rel 要用 src/config/privacy.ts 的 externalLinkRel，不要自己寫一份；' +
              '真的要改承諾的話，改的是 /privacy 那一句。',
          },
        });
      }
    }

    /* 同一行的 `@import url(…)` 兩個樣式都會配到，報一次就好 */
    const reported = new Set();
    for (const [url, tag] of hits) {
      let host;
      try {
        /* `//host/x` 是通訊協定相對網址 —— 照樣會發請求，但 new URL 收不下 */
        host = new URL(url.startsWith('//') ? `https:${url}` : url).host;
      } catch {
        continue;
      }
      if (host.endsWith('bellafoxy.com')) continue;
      const lineNo = text.slice(0, text.indexOf(tag)).split('\n').length;
      if (reported.has(`${host}@${lineNo}`)) continue;
      reported.add(`${host}@${lineNo}`);
      findings.push({
        rel,
        lineNo,
        line: tag.slice(0, 110),
        matched: host,
        rule: {
          id: 'built-third-party-request',
          level: 'error',
          why:
            `建置產物會向 ${host} 發出請求。零第三方請求是硬性限制。` +
            '　改法：把那個資源下載進 public/ 自己託管；如果是影片，改用 VideoFacade 元件。',
        },
      });
    }
  }
}

/*
 * ── 掃描的視野是一份清單，而清單不會自己長大 ─────────────
 *
 * 上面的 SCAN_EXT 決定了這支稽核「看得到什麼」。第 5 輪（第十圈）量到
 * `public/site.webmanifest` 整個在視野外 —— 不是有人決定不掃它，
 * 是它的副檔名剛好不在清單上。
 *
 * 補一個副檔名只解決那一個檔案。這一條解決的是**下一個**：
 * 掃描目錄裡任何「既不在 SCAN_EXT、也沒被認定為二進位」的副檔名都要報出來。
 * 有人放 `public/something.toml` 進來時，稽核會講話，
 * 而不是安靜地少掃一個會出貨的檔案。
 */
{
  /** @param {string} dir @returns {AsyncGenerator<string>} */
  async function* walkAll(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.astro', '.git'].includes(entry.name)) continue;
        yield* walkAll(full);
      } else {
        yield full;
      }
    }
  }

  /** @type {Map<string, string>} 副檔名 → 第一個踩到的檔案 */
  const unknown = new Map();
  for (const dir of SCAN_DIRS) {
    for await (const file of walkAll(resolve(ROOT, dir))) {
      saw('unscanned-file-type', 1);
      const ext = extname(file);
      if (SCAN_EXT.has(ext) || BINARY_EXT.has(ext)) continue;
      if (!unknown.has(ext)) unknown.set(ext, relative(ROOT, file));
    }
  }

  for (const [ext, example] of unknown) {
    findings.push({
      rel: example,
      lineNo: 1,
      line: `副檔名 ${ext}`,
      matched: ext,
      rule: {
        id: 'unscanned-file-type',
        level: 'warn',
        why:
          `${ext} 不在 SCAN_EXT 也不在 BINARY_EXT，所以這支稽核從來沒有讀過它 —— ` +
          '而它在會出貨的目錄裡。兩個都不加的話，這個檔案裡放什麼都不會有人看。' +
          '　改法：是文字就把副檔名加進 SCAN_EXT，是二進位就加進 BINARY_EXT' +
          '（兩份清單都在 audit-privacy.mjs 開頭）。',
      },
    });
  }
}

/*
 * ── 部署前的關卡有沒有被拿掉 ───────────────────────────
 *
 * deploy.yml 一度只跑 `npm run build`，六道關卡在另一個 workflow 裡 ——
 * 而那兩個是互相獨立的，check 紅燈不會擋住 deploy 綠燈。
 * 也就是說無障礙、隱私、CSP、效能的回歸照樣會被發佈出去。
 *
 * 這條規則守著「部署一定要先過關卡」。CNAME 那條同理：
 * 少了那個檔案，GitHub 會默默取消自訂網域，網站掉到 github.io 上。
 */
{
  const deployPath = resolve(ROOT, '.github/workflows/deploy.yml');
  /* 主體是那一個檔案本身 —— 它不在的話這兩項是 0，而 0 才說得出「沒查」 */
  saw('deploy-without-gates', existsSync(deployPath) ? 1 : 0);
  saw('deploy-without-cname-check', existsSync(deployPath) ? 1 : 0);
  if (existsSync(deployPath)) {
    const text = await readFile(deployPath, 'utf8');
    const rel = '.github/workflows/deploy.yml';

    if (!/npm run verify:all/.test(text)) {
      findings.push({
        rel,
        lineNo: 0,
        line: '(deploy.yml 沒有跑 verify:all)',
        matched: 'no-gates',
        rule: {
          id: 'deploy-without-gates',
          level: 'error',
          why:
            'deploy.yml 必須跑 `npm run verify:all`，不能只跑 build。' +
            'check.yml 是獨立的 workflow，它紅燈不會阻止這裡發佈。' +
            '　改法：在 deploy.yml 的部署步驟之前加一步 `run: npm run verify:all`。',
        },
      });
    }

    if (!/dist\/CNAME/.test(text)) {
      findings.push({
        rel,
        lineNo: 0,
        line: '(deploy.yml 沒有檢查 CNAME)',
        matched: 'no-cname-check',
        rule: {
          id: 'deploy-without-cname-check',
          level: 'error',
          why:
            'deploy.yml 要確認 dist/CNAME 存在。少了它 GitHub 會默默取消自訂網域，' +
            '網站掉到 eugeneyip.github.io 上，而且不會有任何錯誤。' +
            '　改法：在 deploy.yml 的建置之後加一步 `test -f dist/CNAME`。',
        },
      });
    }
  }
}

/*
 * ── 機密外洩 ───────────────────────────────────────────
 *
 * repo 是公開的，所以一把不小心 commit 進去的金鑰會在幾分鐘內被掃走，
 * 而且刪掉也沒用 —— 歷史紀錄還在。這一段在推上去之前擋一次。
 *
 * 只掃「一看就是機密」的形狀。刻意不做熵值偵測：
 * 這個 repo 到處都是雜湊（CSP 的 SHA-256、Astro 的檔名），誤報會多到沒人看。
 */
{
  /** @type {[RegExp, string][]} */
  const SECRET_PATTERNS = [
    [/AKIA[0-9A-Z]{16}/g, 'AWS access key'],
    [/gh[pousr]_[A-Za-z0-9]{36,}/g, 'GitHub token'],
    [/AIza[0-9A-Za-z_-]{35}/g, 'Google API 金鑰'],
    [/xox[baprs]-[0-9A-Za-z-]{10,}/g, 'Slack token'],
    [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, '私鑰'],
    [/(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s{}$<>]{16,}["']/gi, '寫死的密碼或金鑰'],
  ];

  /*
   * 這裡也要用 filesToScan()，不能只跑 SCAN_DIRS。
   *
   * 第 5 輪（第五圈）把根目錄納入掃描時**只改了內容規則那一圈**，
   * 這一圈忘了 —— 而金鑰最可能出現的地方正是根目錄的 `.env.example`。
   * 是常駐測試抓到的：同一個 AWS 金鑰放進 `README.md` 沒有響。
   */
  for await (const file of filesToScan()) {
    {
      const rel = relative(ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      saw('possible-secret', 1);
      const text = await readFile(file, 'utf8');
      for (const [pattern, label] of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text)) !== null) {
          const lineNo = text.slice(0, m.index).split('\n').length;
          findings.push({
            rel,
            lineNo,
            line: m[0].slice(0, 24) + '…（其餘不印出來）',
            matched: label,
            rule: {
              id: 'possible-secret',
              level: 'error',
              why:
                `看起來是${label}。repo 是公開的 —— 這種東西一旦推上去就等於已經外洩，` +
                '刪掉也沒用（歷史紀錄還在）。' +
                '　改法：把值搬到 GitHub Secrets 或本機的 .env（那個檔案在 .gitignore 裡），' +
                '程式改讀環境變數；已經推上去過的話，那把金鑰要作廢重發。',
            },
          });
        }
      }
    }
  }
}

/*
 * ── CSP 有沒有還在、有沒有被放寬 ────────────────────────
 *
 * CSP 是「零第三方請求」從約定變成瀏覽器強制的那一步。
 * 它很容易在除錯時被隨手關掉或加上 'unsafe-inline' 然後忘記改回來，
 * 而且關掉之後畫面完全正常 —— 沒有任何徵兆。所以要有東西盯著。
 *
 * script-src 一定要是雜湊制。style-src-attr 的 'unsafe-inline' 是刻意的
 * （雜湊對 style 屬性無效，見 astro.config.mjs 的說明），不在此限。
 */
if (existsSync(resolve(ROOT, 'dist'))) {
  const pages = [];
  for await (const file of walk(resolve(ROOT, 'dist'))) {
    if (file.endsWith('.html')) pages.push(file);
  }

  saw('csp-missing', pages.length);
  /* csp-weakened 的主體只有「有 CSP 的那幾頁」—— 沒有 CSP 就沒有東西可以放寬 */
  let withCsp = 0;

  for (const file of pages) {
    const rel = relative(ROOT, file);
    const text = await readFile(file, 'utf8');
    /*
     * 用反向參照配對引號。
     * CSP 的值本身就含單引號（'none'、'self'、雜湊），
     * 寫成 content=["']([^"']*)["'] 的話會在第一個 'none' 的引號就截斷，
     * 抓到的政策永遠只有 "default-src " —— 然後每一頁都誤報。
     */
    const meta = text.match(
      /<meta[^>]+http-equiv=(["'])content-security-policy\1[^>]*content=(["'])([\s\S]*?)\2/i,
    );

    if (!meta) {
      findings.push({
        rel,
        lineNo: 0,
        line: '(這一頁沒有 CSP)',
        matched: 'missing',
        rule: {
          id: 'csp-missing',
          level: 'error',
          why:
      '這一頁沒有 CSP。' +
      '　改法：檢查 astro.config.mjs 的 security.csp 是不是被關掉了（它預設是開的）。',
        },
      });
      continue;
    }

    withCsp++;
    const policy = meta[3];
    const scriptSrc = policy.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    if (/'unsafe-inline'|'unsafe-eval'/.test(scriptSrc)) {
      findings.push({
        rel,
        lineNo: 0,
        line: scriptSrc.trim().slice(0, 110),
        matched: 'unsafe',
        rule: {
          id: 'csp-unsafe-inline',
          /*
           * ── 為什麼這一條擋，底下那一條不擋 ──────────────
           *
           * 這兩件事本來是同一個 id（`csp-weakened`），**而且是兩個不同的
           * 嚴重度** —— 第 5 輪（第三十一圈）量到的：同一個規則 id 在
           * 一個地方是 error、另一個地方是 warn，而輸出上兩者都寫
           * `[csp-weakened]`，讀的人分不出是哪一種。
           *
           * 兩個等級各自都說得通，但**沒有一個字說它們為什麼不一樣**。
           * 拆成兩個 id 之後，等級跟著 id 走，主體數也各自算。
           *
           * 這一條是 error：`'unsafe-inline'`／`'unsafe-eval'` 等於把 CSP
           * 對 XSS 的防護關掉 —— 那是**洞**，不是姿態問題。
           */
          level: 'error',
          why:
            "script-src 出現 'unsafe-inline' 或 'unsafe-eval'，那等於把 CSP 對 XSS 的防護關掉。" +
            '　改法：拿掉那兩個關鍵字 —— Astro 會自動算 inline script 的雜湊，本來就不需要它們。',
        },
      });
    }
    if (!/default-src\s+'none'/.test(policy)) {
      findings.push({
        rel,
        lineNo: 0,
        line: policy.slice(0, 110),
        matched: 'default-src',
        rule: {
          id: 'csp-no-default-src',
          /*
           * 這一條是 warn：少了 `default-src 'none'` 之後，**已經列出來的
           * 那幾種資源仍然受限**，開的是沒列到的類型。那是姿態變鬆，
           * 不是防護被關掉 —— 而且有時是為了讓某種資源載得進來刻意拿掉的。
           */
          level: 'warn',
          why:
            "CSP 裡沒有 default-src 'none'。沒有這一條的話，沒列出來的資源類型會是全開的。" +
            "　改法：去 astro.config.mjs 的 security.csp 把 default-src 'none' 加回去；" +
            '是為了讓某個資源載得進來才拿掉的話，改成只替那一種資源開一條指令。',
        },
      });
    }
  }
  /* 兩條的主體都是「有 CSP 的那幾頁」—— 分開算，不然拆了 id 卻共用一個數字 */
  saw('csp-unsafe-inline', withCsp);
  saw('csp-no-default-src', withCsp);
}

/*
 * ── 隱私頁上列的那兩個鍵，跟瀏覽器裡真的存的一樣嗎 ──────────
 *
 * 第 5 輪（第十八圈）加的。這一圈問「讀者拿到的是什麼」，而隱私頁
 * **點名**告訴讀者：只有 `fox-theme` 與 `fox-poem-orientation` 兩個項目。
 *
 * 那一頁就是規格 —— 它是她對讀者的承諾，寫得比任何註解都具體。
 * 而在這之前**沒有任何東西**把那句話跟程式碼綁在一起：
 * 多存一個鍵，那一頁會安靜地變成一句假話，六道關卡全綠。
 *
 * ## 兩邊怎麼取
 *
 * 產出那一側取的是 JS 裡的 `fox-*` 字面值 —— 這個站的儲存鍵都是這個
 * 命名空間。**不逐一解析 localStorage 呼叫**，因為壓縮後有 6 個呼叫的
 * 鍵名是變數（`localStorage.getItem(e)`），照呼叫抓會抓到一半。
 * 命名空間之外的字面值鍵另外抓（見下），所以繞不過去。
 *
 * 隱私頁那一側取的是 `<code>` 裡的 `fox-*` —— 那一頁把鍵名包成 code，
 * 兩種語言都是。抽不到就說「沒有檢查」，不要印一份可能是空的名單。
 */
if (existsSync(resolve(ROOT, 'dist'))) {
  /** JS 裡出現過的 fox-* 字面值 → 第一次出現在哪一頁 */
  const used = new Map();
  /** 命名空間之外、但確實被當成 localStorage 鍵用的字面值 */
  const outside = new Map();
  /** 隱私頁上列出來的鍵 */
  const documented = new Set();
  let privacyPages = 0;

  for await (const file of walk(resolve(ROOT, 'dist'))) {
    if (!file.endsWith('.html')) continue;
    const rel = relative(ROOT, file);
    const text = await readFile(file, 'utf8');

    for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      const js = m[1];
      for (const k of js.matchAll(/['"`](fox-[a-z0-9-]+)['"`]/g)) {
        if (!used.has(k[1])) used.set(k[1], rel);
      }
      /* 命名空間外的鍵：只認字面值，變數的抓不到也不假裝抓得到 */
      for (const k of js.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*['"`]([^'"`]+)['"`]/g)) {
        if (!k[1].startsWith('fox-') && !outside.has(k[1])) outside.set(k[1], rel);
      }
    }

    if (/\/privacy\/index\.html$/.test(rel.replace(/\\/g, '/'))) {
      privacyPages++;
      for (const m of text.matchAll(/<code[^>]*>(fox-[a-z0-9-]+)<\/code>/g)) documented.add(m[1]);
    }
  }

  if (privacyPages === 0 || documented.size === 0) {
    notices.push(
      '瀏覽器儲存的檢查沒有執行：' +
        (privacyPages === 0
          ? '產出裡找不到隱私頁。'
          : '隱私頁上抽不到 <code>fox-…</code> 的鍵名。') +
        '（寧可說「沒查」，也不要印一份可能是空的名單。）',
    );
  } else {
    /*
     * 主體是「鍵」不是「頁」：這一項判斷的是每一個鍵有沒有被寫進隱私頁，
     * 反過來那一項判斷的是每一個列出來的鍵是不是真的還在用。
     */
    saw('storage-not-documented', used.size + outside.size);
    saw('storage-documented-not-used', documented.size);
    for (const [key, rel] of used) {
      if (documented.has(key)) continue;
      findings.push({
        rel,
        lineNo: 0,
        line: key,
        matched: key,
        rule: {
          id: 'storage-not-documented',
          level: 'error',
          why:
            `瀏覽器裡存了 ${key}，但隱私頁沒有列出這個項目 —— ` +
            '那一頁點名說「只有兩個項目」，多一個它就變成一句假話。' +
            '　改法：去 src/pages/[...locale]/privacy.astro 的「瀏覽器裡存了什麼」' +
            '把它加進兩種語言的清單，並加進同一個檔案的 CODEY（那決定它會不會被畫成 code）。' +
            '　或者這個鍵其實不必存，那就把它拿掉。',
        },
      });
    }
    for (const [key, rel] of outside) {
      findings.push({
        rel,
        lineNo: 0,
        line: key,
        matched: key,
        rule: {
          id: 'storage-not-documented',
          level: 'error',
          why:
            `localStorage 存了 ${key}，它不在這個站的 fox- 命名空間裡。` +
            '　改法：鍵名改成 fox-… 開頭（這支檢查靠那個前綴看得到全部的鍵），' +
            '並把它列進隱私頁的「瀏覽器裡存了什麼」。',
        },
      });
    }
    for (const key of documented) {
      if (used.has(key)) continue;
      findings.push({
        rel: 'dist/privacy/index.html',
        lineNo: 0,
        line: key,
        matched: key,
        rule: {
          id: 'storage-documented-not-used',
          level: 'error',
          why:
            `隱私頁說瀏覽器裡存了 ${key}，但產出的 JS 裡沒有這個鍵 —— ` +
            '那一頁在講一件已經不存在的事。' +
            '　改法：去 src/pages/[...locale]/privacy.astro 把它從兩種語言的清單裡拿掉。',
        },
      });
    }
  }
}

/*
 * 最重要的一項檢查：個資檔有沒有不小心被 git 追蹤。
 * repo 是公開的，這個檔案一旦進了版控，之後就算刪掉，歷史紀錄裡還是撈得到。
 */
/*
 * ── 這一項問的路徑，比 .gitignore 認定的私密範圍窄 ──
 *
 * 第 5 輪（第十五圈）量到：`.gitignore` 擋的是 `.env`、**`.env.*`**、
 * `src/config/identity.local.ts`、`*.local`，而這裡只問了前面兩個裡的一個
 * 加上第三個 —— 也就是說 `.env.local`、`.env.production` 這種檔案
 * **被 git 追蹤了也不會有人說話**。
 *
 * 現在改成用 pathspec 一次問完，並用 `:!` 把 `.env.example` 排除掉
 * （那個是範本，本來就該進版控，`.gitignore` 也用 `!` 放行它）。
 *
 * 為什麼不改用 `git ls-files --ignored --exclude-standard`（讓 git 自己
 * 拿 .gitignore 去比）：那樣的話**有人把 .gitignore 那一行刪掉，這項檢查
 * 就會跟著閉嘴** —— 而那正是最需要它出聲的時候。清單寫死在這裡是刻意的。
 * （.gitignore 有沒有被改弱，另外有一項檢查在看，見下。）
 */
const PRIVATE_PATHSPEC = [
  'src/config/identity.local.ts',
  '.env',
  '.env.*',
  '*.local',
  ':!.env.example',
];

try {
  const tracked = execFileSync('git', ['ls-files', '--', ...PRIVATE_PATHSPEC], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  if (tracked) {
    findings.push({
      rel: tracked.split('\n')[0],
      lineNo: 0,
      line: tracked.replace(/\n/g, '、'),
      matched: tracked,
      rule: {
        id: 'private-file-tracked',
        level: 'error',
        why:
          '這個檔案含有個人資料，但已經被 git 追蹤了。repo 是公開的。' +
          '　改法：執行 `git rm --cached <檔案>`，並確認 .gitignore 有擋住它。' +
          '如果已經推上去過，光是刪掉不夠 —— 歷史紀錄仍留有紀錄，需要改寫歷史或重建 repo。',
      },
    });
  }
  /*
   * 主體是問出去的那幾條路徑樣式 —— 不是「找到幾個」（找到就是紅燈了）。
   * 記在這裡而不是 try 的開頭：git 掛掉的時候這一項的主體數必須是 **0**，
   * 那才是實話。第 5 輪（第二十一圈）第一版寫在開頭，於是在一個不是 git repo
   * 的目錄上跑，報告會說「判斷過 4 個東西」而其實一個都沒有。
   */
  saw('private-file-tracked', PRIVATE_PATHSPEC.filter((p) => !p.startsWith(':!')).length);

  /*
   * ── 現在沒被追蹤，那**曾經**被 commit 過嗎 ──────────
   *
   * 上面那一項問的是 `git ls-files` —— **現在的索引**。
   * 一個檔案被 commit 過、後來 `git rm --cached` 掉再加進 .gitignore，
   * 上面那一項會完全安靜，而檔案內容**永遠留在公開 repo 的歷史裡**。
   *
   * 第 5 輪（第二十六圈）問「壞了誰會告訴我們」，這一項的答案本來是：
   * 沒有人。而且它跟這個專案的其他問題不一樣 —— **它是不可逆的**。
   * 推上去之後，改寫歷史只能防未來，別人的 fork、快取、封存不會跟著改。
   *
   * 實測這個 repo：`git log --all --diff-filter=A -- <那幾條路徑>`
   * 一筆都沒有（只有 `.env.example` 與 `identity.local.example.ts`，
   * 那兩個本來就是要公開的範本）。所以這一條加的是「以後也不會有」。
   *
   * 花費：這個 repo 上量到 0.5 秒。
   */
  const history = execFileSync(
    'git',
    ['log', '--all', '--diff-filter=A', '--format=', '--name-only', '--', ...PRIVATE_PATHSPEC],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();

  saw('private-file-in-history', PRIVATE_PATHSPEC.filter((p) => !p.startsWith(':!')).length);

  if (history) {
    const files = [...new Set(history.split('\n').filter(Boolean))];
    findings.push({
      rel: files[0],
      lineNo: 0,
      line: files.join('、'),
      matched: files.join('、'),
      rule: {
        id: 'private-file-in-history',
        level: 'error',
        why:
          '這個檔案現在沒有被追蹤，但**歷史紀錄裡有**。repo 是公開的，' +
          '所以那份內容已經在外面了 —— 刪掉現在的檔案不會把它收回來。' +
          '　改法：先假設它已經外洩 —— 裡面若有金鑰就換掉，若是個人資料就當成已經公開。' +
          '然後才是清歷史（git filter-repo 或重建 repo），那只防未來，' +
          '別人的 fork 與各種快取不會跟著改。',
      },
    });
  }
} catch {
  /*
   * ── 查不了要說 ──────────────────────────────────
   *
   * 原本是 `// 跳過這項檢查`，一句話都不印。
   * 第 5 輪（第二十一圈）實測：在一個不是 git repo 的目錄上跑，
   * `git ls-files` 與 `git check-ignore` 都以 128 結束，
   * **兩項都沒跑，而報告照樣說「乾淨」**。
   *
   * 這一支自己的第 2 圈註解就寫著「『乾淨』如果是因為『根本沒檢查』，
   * 那是最危險的一種綠燈」—— 而這兩項是唯二用 git 的，
   * 也正好是擋「含本名的檔案進公開 repo」的那兩項。
   * `notices` 這個機制本來就在（身分規則、瀏覽器儲存都在用），這裡接上去。
   */
  notices.push(
    '私密檔追蹤狀態沒有檢查：git 用不了（不是 repo，或環境裡沒有 git）。' +
      'identity.local.ts／.env 有沒有被 git 追蹤，這一次沒有查。',
  );
}

/*
 * ── .gitignore 自己有沒有被改弱 ────────────────────────
 *
 * 上面那項查的是「私密檔有沒有**已經**被追蹤」，那是事後。
 * 事前的那一道是 `.gitignore`，而 `.gitignore` 裡寫著
 * 「絕對不要拿掉這一行」的那一行，**在第 5 輪（第十五圈）之前沒有任何檢查在看**。
 *
 * 拿掉之後會發生什麼：檔案不再被忽略 → 下一次 `git add .` 就把它加進去 →
 * 公開 repo 上多了一份含本名與學歷的檔案。上面那項檢查會抓到，
 * 但那時東西已經在 index 裡，而 CI 是 push 之後才跑的。
 *
 * 用 `git check-ignore` 而不是自己讀 `.gitignore` 比對字串：
 * 忽略規則有否定（`!`）、目錄、萬用字元與優先序，自己剖析一定會錯 ——
 * 這個 repo 用正則剖析結構化資料已經踩過九次了。
 * `--no-index` 是必要的：檔案不存在（identity.local.ts 平常就不存在）
 * 或已經被追蹤時，都還是要問「規則本身在不在」。
 */
const MUST_BE_IGNORED = ['src/config/identity.local.ts', '.env', '.env.local'];
try {
  /**
   * 這條路徑被誰擋住的。
   *
   * ── 為什麼要問「誰」，不只是「有沒有」──────────────
   *
   * `git check-ignore` 會把**個人設定**也算進去：`~/.config/git/ignore`
   * （git 的預設全域忽略檔）、`core.excludesFile`、`.git/info/exclude`。
   * 那幾個都**不會進版控**，也就是說它們只在這一台機器上存在。
   *
   * 第 5 輪（第二十二圈）實測：造一個 `.gitignore` 裡**完全沒有**那三行的
   * repo，把 `.env` 寫進個人的 excludesFile ——
   *
   *   這台機器：`git check-ignore .env` → 被擋，`audit:privacy` 報 0 個錯
   *   別的 clone（CI、她的電腦）：**沒有被擋**，下一次 `git add .` 就進版控
   *
   * 也就是說這個 repo 最重要的一道防線，可以被一個只存在於某一台機器上的
   * 設定滿足。所以改成問 `-v`：規則來自哪個檔案，而那個檔案**有沒有進版控**。
   *
   * @param {string} path
   * @returns {{ ok: true } | { ok: false, why: 'not-ignored' } | { ok: false, why: 'personal', source: string }}
   */
  const ignoredBy = (path) => {
    let out;
    try {
      out = execFileSync('git', ['check-ignore', '-v', '--no-index', '--', path], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (err) {
      /*
       * check-ignore 的離開碼：0 = 有被擋、1 = 沒被擋、其他 = 真的出錯
       * （沒有 git、不是 repo⋯⋯）。只有 1 才算違規，其他要往外丟，
       * 不然「git 壞了」會被當成「沒被擋」而變成一堆誤報。
       */
      if (/** @type {{ status?: number }} */ (err)?.status === 1) {
        return { ok: /** @type {const} */ (false), why: /** @type {const} */ ('not-ignored') };
      }
      throw err;
    }
    /* 輸出是 `<來源>:<行>:<樣式>\t<路徑>` */
    const source = out.split(':')[0] ?? '';
    /*
     * 來源在不在「別人 clone 下來也會有」的地方。
     *
     * git 對工作目錄裡的 `.gitignore` 印的是**相對路徑**，
     * 對個人設定印的是**絕對路徑**（`~/.config/git/ignore`、
     * `core.excludesFile` 指到的檔案），而 `.git/info/exclude` 雖然是相對的，
     * 但 `.git/` 不會進版控。兩種都排除掉。
     *
     * 為什麼不用 `git ls-files --error-unmatch` 問「有沒有被追蹤」：
     * 剛把那一行加進 `.gitignore`、還沒 `git add` 的時候會誤報 ——
     * 而那正是最可能跑這支稽核的時刻。
     */
    const inRepo = !source.startsWith('/') && !source.startsWith('.git/');
    return inRepo
      ? { ok: /** @type {const} */ (true) }
      : { ok: /** @type {const} */ (false), why: /** @type {const} */ ('personal'), source };
  };

  const notIgnored = [];
  /** @type {{ path: string, source: string }[]} */
  const onlyPersonal = [];
  for (const path of MUST_BE_IGNORED) {
    const r = ignoredBy(path);
    if (r.ok) continue;
    if (r.why === 'not-ignored') notIgnored.push(path);
    else onlyPersonal.push({ path, source: r.source });
  }

  if (onlyPersonal.length > 0) {
    findings.push({
      rel: '.gitignore',
      lineNo: 0,
      line: onlyPersonal.map((x) => `${x.path} ← ${x.source}`).join('、'),
      matched: onlyPersonal.map((x) => x.path).join('、'),
      rule: {
        id: 'gitignore-weakened',
        level: 'error',
        why:
          `這幾條路徑是被**沒有進版控的忽略檔**擋住的：` +
          `${onlyPersonal.map((x) => `${x.path}（來自 ${x.source}）`).join('、')}。` +
          '那個檔案只存在於這一台機器上 —— 別人 clone 下來、CI 上、' +
          '她自己的電腦上都沒有，所以那裡的 `git add .` 會把這些檔案加進版控。' +
          '　改法：把對應的那幾行寫進 repo 自己的 `.gitignore`（那份會進版控）。',
      },
    });
  }
  if (notIgnored.length > 0) {
    findings.push({
      rel: '.gitignore',
      lineNo: 0,
      line: notIgnored.join('、'),
      matched: notIgnored.join('、'),
      rule: {
        id: 'gitignore-weakened',
        level: 'error',
        why:
          `.gitignore 已經擋不住這些路徑了：${notIgnored.join('、')}。` +
          'repo 是公開的，這幾個檔案含本名、學歷與金鑰 —— ' +
          '少了這道規則，下一次 `git add .` 就會把它們加進版控。' +
          '　改法：把對應的那幾行加回 .gitignore。',
      },
    });
  }
  saw('gitignore-weakened', MUST_BE_IGNORED.length);
} catch {
  /* 跟上面那項同一個理由：查不了要說出來，不要靜靜地放行 */
  notices.push(
    '.gitignore 沒有檢查：git 用不了（不是 repo，或環境裡沒有 git）。' +
      '那幾行「絕對不要拿掉」的規則還在不在，這一次沒有查。',
  );
}

/*
 * ALLOWLIST 的存在是因為某些檔案本來就會提到受保護的**欄位名稱**
 * （privacy.ts 有 realName 這個 key，PRIVACY.md 要解釋它）。
 *
 * 但 identity-value 這條例外：它比對的不是欄位名稱，是**真的值**。
 * 真值不該出現在任何會進版控的檔案裡 —— 包括原本被豁免的那幾個。
 *
 * 這正是第 5 輪（第二圈）那個漏洞的根因：唯一含有個資的檔案
 * （audit-privacy.mjs 自己）剛好在 ALLOWLIST 裡，所以檢查不到自己。
 * 光把值搬走還不夠，要讓「豁免」對這條規則失效，同樣的事才不會再發生一次。
 *
 * 唯一真正的例外是 identity.local.ts 本身 —— 值本來就住在那裡，
 * 而它在 .gitignore 裡（另有一項檢查確認它沒被 git 追蹤）。
 */
const IDENTITY_HOME = 'src/config/identity.local.ts';

/** 要掃的所有檔案：子目錄遞迴 + 根目錄那一層 */
async function* filesToScan() {
  for (const dir of SCAN_DIRS) yield* walk(resolve(ROOT, dir));
  if (!SCAN_ROOT_FILES) return;
  for (const name of await readdir(ROOT).catch(() => [])) {
    if (ROOT_FILE_SKIP.has(name)) continue;
    const full = resolve(ROOT, name);
    // 只要檔案，不要目錄（子目錄由上面那一圈處理）
    if (!SCAN_EXT.has(extname(name)) && !name.startsWith('.')) continue;
    try {
      if ((await readFile(full, 'utf8')) !== undefined) yield full;
    } catch {
      /* 目錄或讀不到的東西 */
    }
  }
}

/*
 * ── 每個隱私開關，有沒有人真的讀它 ────────────────────
 *
 * 一個沒有人讀的開關是**假的閘門**：它看起來把某件事關掉了，
 * 但把它改成 `true` 什麼都不會發生。第 5 輪（第九圈）量到
 * `showBirthday` 與 `showRelationship` 是這種，並在 privacy.ts 的
 * 註解裡寫了「沒有接到任何東西」——**但那只是註解，沒有人在守**。
 *
 * 第 5 輪（第十五圈）再量一次，發現又多了兩個沒有人讀、而且沒有註記的：
 * `allowRemoteFonts` 與 `stripImageExif`。所以這裡把它做成檢查，兩個方向都看：
 *
 *   - 沒有人讀、註解也沒說 → 它假裝自己是閘門
 *   - 有人讀了、註解卻還說「沒接到任何東西」→ 註解過期，比沒有更糟
 *
 * 「有沒有人讀」數的是 `privacy.<開關>`。這個 repo 沒有解構寫法
 * （實測：所有讀取都是 `privacy.x` 或 privacy.ts 自己的 reveal()／
 * externalLinkRel()），所以數得準。
 */
/** @type {Map<string, number>} */
const switchReads = new Map();
/** UNWIRED_SWITCHES 裡宣告的名字 —— 底下比對文件時要用同一份 */
const UNWIRED_DECLARED = new Set();
/** 文件那張表用來標記「這個開關沒有接上」的記號。定義只有這一個地方 */
const UNWIRED_MARK = '⚠ 這個開關沒有接上';
{
  const src = await readFile(resolve(ROOT, 'src/config/privacy.ts'), 'utf8').catch(() => '');
  const body = /interface PrivacyConfig \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? '';
  const decls = [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_]*)\??:/gm)];
  /*
   * 「這個開關是刻意沒接的」以 UNWIRED_SWITCHES 為準，不看註解措辭。
   * 第一版是比對註解裡的「沒有接到任何東西」，結果把用另一種寫法
   * （「沒有程式碼讀這一行」）的兩個誤報成沒有註記 —— 措辭會漂，清單不會。
   */
  const unwired = new Set(
    (/export const UNWIRED_SWITCHES[^=]*=\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? '')
      .match(/'([a-zA-Z][a-zA-Z0-9_]*)'/g)
      ?.map((q) => q.slice(1, -1)) ?? [],
  );
  const unknown = [...unwired].filter((k) => !decls.some((d) => d[1] === k));
  for (const k of unwired) UNWIRED_DECLARED.add(k);

  if (decls.length === 0 || unwired.size === 0 || unknown.length > 0) {
    console.log(
      '\n隱私開關沒有檢查：' +
        (decls.length === 0
          ? '讀不到 privacy.ts 的 PrivacyConfig，或抽不到開關名。'
          : unwired.size === 0
            ? '抽不到 UNWIRED_SWITCHES 名單。'
            : `UNWIRED_SWITCHES 裡有不是開關的名字：${unknown.join('、')}。`) +
        '\n  （寧可說「沒查」，也不要靜靜地放行。）',
    );
  } else {
    /* 主體是宣告出來的開關 —— 抽不到名字的話上面那一支就說「沒查」了 */
    saw('privacy-switch-unused', decls.length);
    saw('privacy-switch-stale-note', decls.length);
    for (const d of decls) switchReads.set(d[1], 0);
    for await (const file of filesToScan()) {
      const rel = relative(ROOT, file);
      if (!/\.(ts|astro|mjs)$/.test(rel)) continue;
      const text = await readFile(file, 'utf8');
      for (const key of switchReads.keys()) {
        const n = text.split(`privacy.${key}`).length - 1;
        if (n > 0) switchReads.set(key, (switchReads.get(key) ?? 0) + n);
      }
    }
    for (const d of decls) {
      const key = d[1];
      const reads = switchReads.get(key) ?? 0;
      const declaredNoOp = unwired.has(key);
      if (reads === 0 && !declaredNoOp) {
        findings.push({
          rel: 'src/config/privacy.ts',
          lineNo: 0,
          line: `${key}（沒有任何地方讀它）`,
          matched: key,
          rule: {
            id: 'privacy-switch-unused',
            level: 'warn',
            why:
              `沒有任何地方讀 privacy.${key} —— 把它改成別的值不會有任何效果。` +
              '一個沒有人讀的開關看起來像閘門，實際上不是。' +
              '要嘛接上去，要嘛把它加進 privacy.ts 的 UNWIRED_SWITCHES（並在註解裡寫清楚誰在守那件事）。',
          },
        });
      }
      if (reads > 0 && declaredNoOp) {
        findings.push({
          rel: 'src/config/privacy.ts',
          lineNo: 0,
          line: `${key}（UNWIRED_SWITCHES 說沒接到，實際有 ${reads} 處讀它）`,
          matched: key,
          rule: {
            id: 'privacy-switch-stale-note',
            level: 'warn',
            why:
              `privacy.${key} 在 UNWIRED_SWITCHES 名單裡（「沒有接到任何東西」），` +
              `但有 ${reads} 處在讀它。過期的註記比沒有註記危險 —— ` +
              '有人會照著它以為改了沒差。接上去了就把它從名單移除。',
          },
        });
      }
    }
  }
}

/*
 * ── 開關一覽那張表，跟程式說的一樣嗎 ──────────────────
 *
 * 上面那一支比的是**程式與程式**（有沒有人讀 vs UNWIRED_SWITCHES）。
 * 這一支比的是**程式與文件**。
 *
 * 第 5 輪（第二十四圈）量出來：`docs/PRIVACY.md` 的「影響」欄把四個
 * 刻意沒接的開關寫成好像有作用 —— `showBirthday` 寫「生日」、
 * `stripImageExif` 寫「`npm run clean-images` 會清掉圖片的 GPS 等資訊」。
 *
 * 兩份說法不一致的時候，人會相信哪一份？**文件那一份。**
 * `privacy.ts` 的註解寫得很清楚，但它在一個 200 行的型別定義中間；
 * 要決定「這個開關該開還是關」的人讀的是那張表。
 *
 * 而這件事在隱私上特別貴：一個看起來像閘門、實際上不是的開關，
 * 會讓人以為某一則個資已經被關起來了。
 */
{
  const doc = await readFile(resolve(ROOT, 'docs/PRIVACY.md'), 'utf8').catch(() => '');

  if (doc === '' || switchReads.size === 0) {
    console.log(
      '\n開關一覽沒有檢查：' +
        (doc === '' ? '讀不到 docs/PRIVACY.md。' : '上一支沒有抽到開關名。') +
        '\n  （寧可說「沒查」，也不要靜靜地放行。）',
    );
  } else {
    saw('privacy-doc-unwired', switchReads.size);
    for (const key of switchReads.keys()) {
      /* 那個開關在表格裡的那一列 —— 以 `key` 這種反引號寫法定位 */
      const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes('`' + key + '`'));
      if (!row) continue;
      const marked = row.includes(UNWIRED_MARK);
      if (UNWIRED_DECLARED.has(key) && !marked) {
        findings.push({
          rel: 'docs/PRIVACY.md',
          lineNo: 0,
          line: row.trim().slice(0, 96),
          matched: key,
          rule: {
            id: 'privacy-doc-unwired',
            level: 'warn',
            why:
              `privacy.${key} 在 UNWIRED_SWITCHES 名單裡（改它不會有任何效果），` +
              '但「開關一覽」把它寫得像有作用。要決定開或關的人讀的是那張表。\n' +
              `      改法：那一列的「影響」欄開頭加上「${UNWIRED_MARK}」，` +
              '後面寫清楚真正在守那件事的是誰。',
          },
        });
      }
      if (!UNWIRED_DECLARED.has(key) && marked) {
        findings.push({
          rel: 'docs/PRIVACY.md',
          lineNo: 0,
          line: row.trim().slice(0, 96),
          matched: key,
          rule: {
            id: 'privacy-doc-unwired',
            level: 'warn',
            why:
              `「開關一覽」說 privacy.${key} 沒有接上，但它不在 UNWIRED_SWITCHES 裡` +
              `（實際有 ${switchReads.get(key) ?? 0} 處讀它）。\n` +
              '      過期的警告比沒有警告危險 —— 有人會照著它以為改了沒差。\n' +
              `      改法：接上去了就把那一列的「${UNWIRED_MARK}」拿掉。`,
          },
        });
      }
    }

  }
}

/*
 * 這一支跟上面那個開關清單無關，所以**不能**放在它的 else 裡面。
 * 第一版放進去了，於是 UNWIRED_SWITCHES 是空陣列的 fixture 一路跳過，
 * 三格測試裡有一格因此變成**假的綠燈**（它什麼都沒跑）。
 */
{
  const doc = await readFile(resolve(ROOT, 'docs/PRIVACY.md'), 'utf8').catch(() => '');
  /*
   * ── 爬蟲的數量：文件寫的 vs robots.txt 真的擋的 ──
   *
   * 同一輪量到的第二件事：文件寫「擋掉 GPTBot、ClaudeBot 等 17 種」，
   * 而 `robots.txt.ts` 的 TRAINING_CRAWLERS 是 13 個（另外 5 個檢索用的
   * 是**放行**的）。清單改過，句子沒跟著改。
   *
   * 判準刻意不綁句型。第一版要求文件寫成「等 N 種訓練爬蟲，另外放行 M 種」，
   * 拿改之前的文件一跑，它說的是「找不到這種寫法」—— 也就是**真的那次漂移
   * 它抓不到**，只會說自己沒查。同一輪的第 2 條待辦（perf 的自我檢查只認
   * 一種句型）講的是同一件事，這次不要再犯。
   *
   * 改成：找到 `allowAiCrawlers` 那一列，把列裡**所有**數字抓出來，
   * 必須剛好等於 {擋幾個, 放行幾個}。句子隨便怎麼寫，但寫下去的數字要對。
   */
  const robots = await readFile(resolve(ROOT, 'src/pages/robots.txt.ts'), 'utf8').catch(() => '');
  const listLen = (/** @type {string} */ name) =>
    (new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];').exec(robots)?.[1].match(/'[^']+'/g) ?? [])
      .length;
  const training = listLen('TRAINING_CRAWLERS');
  const retrieval = listLen('RETRIEVAL_CRAWLERS');
  const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes('`allowAiCrawlers`'));
  const nums = [...(row ?? '').matchAll(/\d+/g)].map((m) => Number(m[0]));

  if (training === 0 || retrieval === 0 || !row) {
    notices.push(
      '爬蟲數量沒有核對：' +
        (row ? '抽不到 robots.txt.ts 的爬蟲清單。' : 'docs/PRIVACY.md 找不到 allowAiCrawlers 那一列。') +
        '（寧可說「沒查」，也不要靜靜地放行。）',
    );
  } else if (nums.length === 0) {
    /* 那一列沒有寫任何數字 —— 沒有第二份說法，就沒有東西會不一致 */
    notices.push('爬蟲數量：allowAiCrawlers 那一列沒有寫數字，沒有東西需要核對。');
  } else {
    saw('privacy-doc-crawler-count', nums.length);
    const want = [training, retrieval].sort((a, b) => a - b);
    const got = [...nums].sort((a, b) => a - b);
    if (got.length !== want.length || got.some((n, i) => n !== want[i])) {
      findings.push({
        rel: 'docs/PRIVACY.md',
        lineNo: 0,
        line: row.trim().slice(0, 96),
        matched: nums.join('、'),
        rule: {
          id: 'privacy-doc-crawler-count',
          level: 'warn',
          why:
            `allowAiCrawlers 那一列寫了 ${nums.join('、')}，` +
            `而 robots.txt.ts 實際是擋 ${training} 種、放行 ${retrieval} 種。\n` +
            '      清單會增減，句子不會自己跟著改。\n' +
            '      改法：把那一列的數字改成現在的值（不寫數字也可以，那就沒有東西會過期）。',
        },
      });
    }
  }
}

/**
 * 每一條豁免這一輪**實際擋住了幾條規則的命中**。
 *
 * ── 為什麼要數這個 ──────────────────────────────
 *
 * 第 5 輪（第二十八圈）問「這件事是誰決定的，那個人還在嗎」。
 * 豁免名單上的每一條都是一個決定：「這個檔案不用受這條規則管」。
 * 那些決定當初都有理由（測試檔一定會有假信箱、規則本身會提到要防的字串⋯⋯），
 * 而**沒有任何東西在看那些理由還成不成立**。
 *
 * 那一輪逐條拿掉量過：9 條裡只有 2 條真的在擋東西
 * （`test-privacy-rules.mjs` 拿掉會多出 7 處、`test-privacy-structural.mjs` 多 1 處）。
 * 另外 6 條**今天什麼都沒擋** —— 檔案裡已經沒有那些樣式了
 * （多半是後來改寫成「描述它，不要引用它」）。
 *
 * 一條什麼都沒擋的豁免不是無害的：它是一個**沒有守衛的門**。
 * 下一個人在 `docs/PRIVACY.md` 裡寫一個真的信箱，不會有任何東西響。
 *
 * 這裡不自作主張刪掉它們 —— 未來的用途我不知道。
 * 改成每一輪自己說出來，讓「這條還需要嗎」變成看得見的問題。
 * @type {Map<string, number>}
 */
const shadowedByAllowlist = new Map();

{
  for await (const file of filesToScan()) {
    const rel = relative(ROOT, file);
    const allowlisted = ALLOWLIST.has(rel);
    if (allowlisted) shadowedByAllowlist.set(rel, shadowedByAllowlist.get(rel) ?? 0);
    /*
     * `identity.local.ts` 連規則迴圈都不會進去（下一行就 continue），
     * 所以影子數不到它 —— 而它的豁免**確實在承重**：真的值本來就住在那裡。
     * 實測拿掉它的豁免會多出 1 處。標成 -1 表示「不是閒置，是本來就該豁免」。
     */
    if (allowlisted && rel === IDENTITY_HOME) shadowedByAllowlist.set(rel, -1);
    if (allowlisted && rel === IDENTITY_HOME) continue;

    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');

    for (const rule of RULES) {
      if (rel === IDENTITY_HOME && rule.id === 'identity-value') continue;
      if (rule.only && !rule.only.test(rel)) continue;
      /*
       * 「站上會不會載入它」那幾條不掃散文檔。
       *
       * `docs/*.md` 不會被瀏覽器載入，寫在裡面的網域只是在講它 ——
       * 而這個 repo 的文件正好在講「為什麼不用 Google Fonts／分析工具／CDN」。
       * 第 5 輪（第十六圈）實測：那三句話會讓自己的稽核紅燈。
       *
       * `public/` 底下的 .md 不算散文（那是會被送出去的檔案）。
       * 真的載入了由 built-third-party-request 掃 dist/ 抓。
       */
      if (rule.aboutLoading && /\.mdx?$/.test(rel) && !rel.startsWith('public/')) continue;
      /*
       * 被豁免的檔案只跑 identity-value —— 但在跳過之前先**空跑一次**，
       * 記下這條豁免今天實際擋住了什麼（見 shadowedByAllowlist 的說明）。
       */
      if (allowlisted && rule.id !== 'identity-value') {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(text)) {
          shadowedByAllowlist.set(rel, (shadowedByAllowlist.get(rel) ?? 0) + 1);
        }
        rule.pattern.lastIndex = 0;
        continue;
      }
      /* 上面每一道 continue 都是「這條規則沒看這個檔案」—— 活過來的才算數 */
      saw(rule.id, 1);
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(text)) !== null) {
        const before = text.slice(0, match.index);
        const lineNo = before.split('\n').length;
        const line = (lines[lineNo - 1] ?? '').trim();

        // GitHub Actions 的 bot 信箱是必要的
        if (rule.id === 'email' && /users\.noreply\.github\.com/.test(line)) continue;

        findings.push({ rel, lineNo, line: line.slice(0, 110), rule, matched: match[0] });
        if (!rule.pattern.global) break;
      }
    }
  }
}

/*
 * ── reveal() 拿得到的值，有沒有人真的畫出來 ──────────────
 *
 * 第 5 輪（第二十三圈）把「她填了 identity.local.ts → 開開關 → 站上看得到」
 * 整條走了一次。四個值都照著開關出現與消失，**只有 email 不管怎麼開都不出現**。
 *
 * 查下去：`privacy.showEmail` **有**人讀（`reveal()` 裡的 `case 'email'`），
 * 所以 `privacy-switch-unused` 不會響 —— 那條規則問的是
 * 「有沒有人讀這個開關」，而不是「這個值有沒有走到畫面上」。
 *
 * 鏈子是：開關 → `reveal()` → **沒有人**。
 * 她打開 `showEmail`，什麼都不會發生，而且沒有任何一句話解釋為什麼。
 * 那正是這個 repo 一直在防的「假的閘門」，只是躲在下一段。
 *
 * 判準：`reveal()` 的每一個 `case '<鍵>'`，都要有頁面或元件真的呼叫
 * `reveal('<鍵>'`。沒有的話，那個開關是通到死路的。
 *
 * 不自己把它接上去 —— 要不要在網站上放電子郵件是配色以外的另一種決定，
 * 是站主的事，不是稽核的事。這裡只負責說出來。
 */
{
  const privacySrc = await readFile(resolve(ROOT, 'src/config/privacy.ts'), 'utf8').catch(() => '');
  const keys = [...privacySrc.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]);
  saw('reveal-key-unused', keys.length);

  if (keys.length > 0) {
    /* 消費端：頁面與元件，不含 privacy.ts 自己與範本檔 */
    let consumers = '';
    for await (const file of walkSurfaces(resolve(ROOT, 'src'))) {
      const rel = relative(ROOT, file);
      if (rel.startsWith('src/config/')) continue;
      consumers += await readFile(file, 'utf8');
    }
    for (const key of keys) {
      if (consumers.includes(`reveal('${key}'`) || consumers.includes(`reveal("${key}"`)) continue;
      findings.push({
        rel: 'src/config/privacy.ts',
        lineNo: 0,
        line: `reveal('${key}')`,
        matched: key,
        rule: {
          id: 'reveal-key-unused',
          level: 'warn',
          why:
            `reveal('${key}') 有實作、也接著開關，但**沒有任何頁面或元件呼叫它** —— ` +
            '把對應的開關打開，畫面上什麼都不會發生，而且沒有東西解釋為什麼。' +
            '　改法：要嘛在頁面上把它畫出來，要嘛把那個開關加進 privacy.ts 的 ' +
            'UNWIRED_SWITCHES 並在註解裡寫清楚（那是這個專案既有的「刻意沒接」機制）。',
        },
      });
    }
  }
}

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walkSurfaces(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      if (['content', 'data'].includes(e.name)) continue;
      yield* walkSurfaces(full);
    } else if (/\.(astro|ts|mjs)$/.test(e.name)) {
      yield full;
    }
  }
}

const errors = findings.filter((f) => f.rule.level === 'error');
const warns = findings.filter((f) => f.rule.level === 'warn');

console.log('\n隱私稽核\n' + '─'.repeat(52));

/*
 * 這幾行不是裝飾。
 * 「乾淨」如果是因為「根本沒檢查」，那是最危險的一種綠燈。
 */
/*
 * ── 在 CI 上，「查不了」要當成失敗 ──────────────────
 *
 * 上面那段註解從第 5 輪（第二圈）就寫著「『乾淨』如果是因為『根本沒檢查』，
 * 那是最危險的一種綠燈」—— 但它只印警告，然後 exit 0。
 *
 * 在本機那是對的：開發時沒有身分檔很正常，不該擋人。
 * 但在 CI 上，`PRIVACY_NEEDLES` secret 是**唯一**的來源，沒有它就等於
 * 這支腳本最重要的那組規則整個沒跑 —— 而 GitHub 上看到的是一個綠勾，
 * 沒有人會去展開 log 讀那行警告。
 *
 * 第 5 輪（第三圈）已經對 `check:history` 做過完全一樣的判斷：
 * 查不了的時候從 exit 0 改成 exit 1。這一支當時漏掉了。
 *
 * 第 5 輪（第七圈）另外確認了為什麼這件事重要：部署是在 CI 上建的
 * （`deploy.yml` 上傳的是 CI 產生的 `dist`，而 `dist/` 沒有進版控），
 * 所以 CI 那台機器**永遠沒有** identity.local.ts ——
 * `reveal()` 就算整個壞掉也洩漏不了。**結構上安全的只有那條路。**
 * 有人把本名直接打進頁面，就完全靠這組身分規則，而它現在沒在跑。
 */
/*
 * ── 哪幾條豁免這一輪什麼都沒擋 ──────────
 *
 * 理由見 shadowedByAllowlist 的說明。這一段跟「這次沒有東西可看的規則」
 * 是同一個形狀：綠燈有兩種，而這兩種在畫面上長得一樣。
 */
{
  const idle = [...shadowedByAllowlist.entries()].filter(([, n]) => n === 0).map(([rel]) => rel);
  const busy = [...shadowedByAllowlist.entries()].filter(([, n]) => n > 0);
  const home = [...shadowedByAllowlist.entries()].filter(([, n]) => n === -1).map(([rel]) => rel);
  if (shadowedByAllowlist.size > 0) {
    notices.push(
      `豁免名單有 ${shadowedByAllowlist.size} 條，這一輪**只有 ${busy.length} 條真的擋住東西**` +
        (busy.length ? `（${busy.map(([r, n]) => `${r} ${n} 條規則`).join('、')}）` : '') +
        (home.length ? `，另外 ${home.join('、')} 是值本來就住的地方（不算閒置）` : '') +
        `。\n  其餘 ${idle.length} 條什麼都沒擋：${idle.join('、')}\n` +
        '  那不是「安全」，是**沒有守衛的門** —— 下一個人在那些檔案裡寫一個真的信箱，\n' +
        '  不會有任何東西響。\n' +
        '  改法：確認那條豁免現在還為了什麼而存在。說不出來就把它刪掉，\n' +
        '  讓稽核去看那個檔案；真的需要引用被禁的東西時，先想想能不能改成描述它。',
    );
  }
}

for (const n of notices) console.log('\n⚠ ' + n);

const CI = Boolean(process.env.CI);
if (identity.source === 'none') {
  console.log('\n⚠ 身分規則沒有執行 —— ' + identity.detail);
  console.log('  本機：cp src/config/identity.local.example.ts src/config/identity.local.ts 並填值');
  console.log('  CI：把值設成 PRIVACY_NEEDLES secret（一行一個）');
  console.log('  沒有這一步的話，本名／校名有沒有被貼進頁面，這支腳本查不到。');
  if (CI) {
    /*
     * ── 這一段是照著一次真的失敗改的 ──────────
     *
     * 2026-09-04 17:23 的第一次 CI（run 33899518777）就停在這裡，
     * 而原因不是「忘記設」，是**設在看起來一樣、但 job 讀不到的地方**：
     * 站主在 Settings → Environments 底下建了一個叫 PRIVACY_NEEDLES 的
     * **環境**，把值放進那個環境的 secrets 裡。
     *
     * Environment secret 只有在 job 宣告了 `environment:` 的時候才看得到，
     * 而 deploy.yml 沒有宣告（也不該為了這個宣告）。
     * 從網頁上看，兩個地方都叫「secrets」、都顯示成已設定 ——
     * 分辨得出來的只有 job 自己。
     *
     * 守門有接住（這一步 exit 1，整支 workflow 紅）。但接住是**事後**，
     * 而那要花掉一次完整的 CI 才知道。所以訊息裡直接點名那個陷阱。
     */
    console.error('\nCI 上沒有 PRIVACY_NEEDLES —— 這不是「乾淨」，是「沒有檢查」。');
    console.error('  要設在這裡：Settings → Secrets and variables → Actions → Repository secrets');
    console.error('  值是一行一個。');
    console.error('  ⚠ 不要設在 Settings → Environments 底下 —— 那裡的 secret 只有宣告了');
    console.error('    environment: 的 job 讀得到，而這支沒有宣告。兩個地方在網頁上都叫');
    console.error('    「secrets」、都顯示成已設定，分辨得出來的只有 job 自己。');
    console.error('    （2026-09-04 第一次 CI 就是這樣停在這裡的。）\n');
    process.exit(1);
  }
} else {
  console.log(`\n身分規則：${identity.needles.length} 個值，來自 ${identity.detail}`);
}

/**
 * 結構性檢查的名單（正則規則那幾條由 RULES 提供）。
 *
 * 存在的理由跟 `check-content.mjs` 的 RULES 一樣：一項檢查因為
 * **整個沒跑**而不在主體數名單裡的話，它會安靜地消失 ——
 * 而「消失」看起來就跟「沒有這種東西」一樣。
 * 第 5 輪（第二十一圈）實測：在不是 git repo 的地方跑，
 * 那兩項用 git 的檢查連 0 都不會出現。
 */
const STRUCTURAL_IDS = [
  'actions-script-injection',
  'built-third-party-request',
  'unscanned-file-type',
  'deploy-without-gates',
  'deploy-without-cname-check',
  'possible-secret',
  'csp-missing',
  'csp-unsafe-inline',
  'csp-no-default-src',
  'storage-not-documented',
  'storage-documented-not-used',
  'private-file-tracked',
  'private-file-in-history',
  'gitignore-weakened',
  'privacy-switch-unused',
  'privacy-switch-stale-note',
  'reveal-key-unused',
  'privacy-doc-unwired',
  'privacy-doc-crawler-count',
];
for (const id of [...STRUCTURAL_IDS, ...RULES.map((r) => r.id)]) {
  if (!subjects.has(id)) subjects.set(id, 0);
}
/*
 * `identity-value` 要另外補。
 *
 * 它是**動態**產生的（沒有 identity.local.ts 也沒有 PRIVACY_NEEDLES 時，
 * 那條規則根本不存在），所以上面那一圈補不到它 —— 它會整條從名單裡消失。
 *
 * 而它正是這一支最重要的一條：有 needles 的時候它掃 162 個檔案，
 * 比任何一條都多（它連 ALLOWLIST 都穿得過）。
 * 「消失」跟「0」在報告上差很多：前者看起來像沒有這種檢查，
 * 後者看起來像「這次什麼都沒守到」—— 而後者才是實話。
 */
if (!subjects.has('identity-value')) subjects.set('identity-value', 0);

/*
 * ── 每一項這次判斷過多少東西 ────────────────────────
 *
 * 這裡列的是「主體數」不是「發現數」。零的那幾項要看得見 ——
 * 它們的綠燈不是「檢查過而且沒問題」，是「沒有東西可檢查」。
 * 這一支的規則清單是動態的（身分規則要有 identity.local.ts 才會存在），
 * 所以名單也照實反映當下有哪幾項在跑。
 */
if (process.argv.includes('--verbose')) {
  console.log('\n每一項這次實際判斷過的東西：');
  for (const [id, n] of [...subjects.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${id}`);
  }
}

/*
 * ── 一個檔案都沒掃到，那不是「乾淨」──────────────────
 *
 * 第 5 輪（第二十五圈）拿一個**空目錄**當 root 跑一次：六項印了「沒有檢查」，
 * 然後結尾是
 *
 *     乾淨。沒有硬編碼的個資，也沒有第三方資源。
 *     exit 0
 *
 * 那些「沒有檢查」是這支腳本最好的習慣 —— 它把查不到的都說出來了。
 * 但**判決那一行推翻了它們**：什麼都沒看過，卻宣告沒有個資外洩。
 *
 * 跟第 1 輪（a11y 的 0 頁）、第 3 輪（內容的 0 檔案）同一件事。
 * 第 4 輪的「零來源」刻意沒改，因為零來源是這個專案現在就成立的事實；
 * 而「一個檔案都沒掃到」永遠是路徑指錯。
 */
const scanned = subjects.get('possible-secret') ?? 0;
if (scanned === 0) {
  console.log(
    '\nX 一個檔案都沒掃到 —— 這不是「乾淨」，是什麼都沒檢查。\n' +
      `  找的是 ${ROOT} 底下要掃的那幾個目錄。\n` +
      '  改法：確認 --root= 指到專案根目錄。\n',
  );
  process.exit(1);
}

/*
 * ── 掃了多少東西 ──────────────────────────────
 *
 * 第 5 輪（第二十九圈）問「第一次跑的人跟第一百次跑的人看到的是同一份
 * 東西嗎」。這一支從頭到尾**沒說掃了幾個檔案、跑了幾條規則** ——
 * 而 `check:copy` 說「掃了 61 個檔案、13646 行」、
 * `check:content` 說「6 篇內容⋯15 條規則」。
 *
 * 第一次跑的人看到「必須修正 0」—— **0 個問題，在什麼裡面？**
 * 這個 repo 從第二十一圈起的規矩就是「綠燈不說明判斷過什麼，等於沒說」。
 */
/*
 * ── 那個數字是**豁免之後**的 ──────────
 *
 * `scanned` 是 `possible-secret` 的主體數，而那一圈在 ALLOWLIST 那裡就
 * `continue` 了 —— 也就是說它算的是「真的看過的」，不是「走過的」。
 *
 * 第 5 輪（第三十五圈）用第二種算法數：`filesToScan()` 走出 185 個，
 * 扣掉 9 個豁免正好 176，跟這裡一字不差。**數字是對的。**
 * 但「掃了 176 個檔案」讀起來像全部，而被跳過的那 9 個正是
 * 唯一可能藏著真值的那幾個 —— 那件事上面雖然有一段在講，
 * 這一行自己不提就等於要讀者自己去加。
 */
const exempt = [...ALLOWLIST].filter((rel) => existsSync(resolve(ROOT, rel))).length;
console.log(
  `\n掃了 ${scanned} 個檔案（另外 ${exempt} 個在豁免名單上，沒掃）、${subjects.size} 條規則。`,
);

/*
 * ── 產出那一端的邊界，要自己說出口 ──────────────────
 *
 * 第 5 輪（第三十六圈）問「這道檢查的邊界外面是什麼？那裡現在有幾個？」
 *
 * 上面那一行講的是**原始碼**。而讀者拿到的是 `dist/`，
 * 那是另一個語料、另一個涵蓋範圍 —— 不說的話，「必須修正 0」
 * 讀起來像是連出貨的東西都掃過了。
 */
const built = subjects.get('built-third-party-request') ?? 0;
if (built > 0) {
  const total = [...distExt.values()].reduce((n, v) => n + v, 0);
  const skipped = total - built;
  console.log(
    `產出那一端另外讀了 dist 的 ${built}／${total} 個檔案` +
      `（html／css／webmanifest／json／txt／svg 這幾種會出貨的純文字）。\n` +
      `  沒讀的 ${skipped} 個：` +
      [...distExt.entries()]
        .filter(([e]) => !['.html', '.css', '.webmanifest', '.json', '.txt', '.svg', '（沒有副檔名）'].includes(e))
        .sort((a, b) => b[1] - a[1])
        .map(([e, n]) => `${e} ${n}`)
        .join('、') +
      '\n  —— 二進位（png／ico）讀不出字；xml 是 feed 與 sitemap，那裡的外部網址是\n' +
      '  **內容**（她的影片連結）不是請求，所以刻意不掃。',
  );
}

/*
 * ── 這次哪幾條一個東西都沒判斷過 ──────────────────
 *
 * 上面補 0 那一段的註解已經說了「零的那幾項要看得見」，
 * 而實際上**只有 `--verbose` 看得見**。第 5 輪（第三十圈）實測：
 * 拿一份只有一頁的假 root 跑，離開碼 0、輸出寫「必須修正 0」，
 * 而 26 條規則裡 **16 條主體是 0** —— 預設輸出一個字都沒提。
 *
 * 那 16 條這時候可以整條刪掉，預設輸出一模一樣。
 *
 * `check:a11y` 與 `check:content` 都在預設那條路上印這份名單，
 * 這一支沒有 —— 而它守的是唯一一件不能外洩的事。
 *
 * ── 為什麼「沒有閒置的」也要印一行 ──
 *
 * 不印的話，「這次沒有規則閒置」跟「這支腳本沒有這種報告」
 * 在輸出上長得一模一樣。第 8 輪（第二十九圈）在 `check:contrast`
 * 的 fallback 那一段踩過同一個形狀：一個數不出東西的綠勾。
 */
{
  const idle = [...subjects.entries()].filter(([, n]) => n === 0).map(([id]) => id).sort();
  /*
   * ── 為什麼是一行、而且條數永遠說出口 ──
   *
   * 第一版寫成兩條分支：有閒置的印名單，沒有的印「全部都有東西可判斷」。
   * 突變掃描當場證明那個 else **一格測試都碰不到** ——
   * 假 root 一定有閒置的規則，而真 repo 才是零閒置的那一份。
   * 分支存在、沒有語料走得到它，那條分支等於沒有人守。
   *
   * 改成一行：條數永遠印（所以「0 條」跟「沒有這種報告」還是分得開），
   * 名單只在有東西可列的時候接在後面。要驗的不變式因此變成
   * 「這一行一定在，而且條數等於主體為 0 的規則數」—— 那是測得到的。
   */
  console.log(
    `這次沒有東西可看的規則：${idle.length} 條` +
      (idle.length > 0
        ? `（${idle.join('、')}）\n` +
          '  它們是綠的，但那不是「檢查過而且沒問題」，是「沒有這種東西可掃」。'
        : `　（${subjects.size} 條規則這一輪每一條都有東西可判斷）`),
  );
}

if (findings.length === 0) {
  /*
   * 「乾淨」只涵蓋真的查過的那些。
   *
   * 上面每一個 notices 都是一項「這次沒有查」（身分規則沒有值、git 用不了、
   * 文件讀不到⋯⋯）。不把它們算進判決的話，一個「身分規則沒有執行」的環境
   * 會拿到跟「全部查過而且乾淨」一模一樣的結尾。
   *
   * **不因此擋下來** —— 本機沒有 identity.local.ts 是常態，
   * 擋下來等於要求每個人都放一份個資才跑得動關卡。說出來就好。
   */
  console.log(
    '乾淨。沒有硬編碼的個資，也沒有第三方資源。' +
      (notices.length > 0
        ? `\n  （不過上面有 ${notices.length} 項這次沒有檢查 —— 「乾淨」只涵蓋真的查過的那些。）`
        : '') +
      '\n',
  );
  /*
   * ── 那個能回答「到底判斷過多少東西」的旗標，要說得出口 ──────────
   *
   * `--verbose` 多印 18 行「每一項這次實際判斷過的東西」
   * （identity-value 181、email 173⋯），那正是「綠燈代表什麼」的答案。
   *
   * 第 1 輪（第二十九圈）量到：七支關卡裡六支有 `--verbose` 而輸出從來不提它。
   */
  if (!process.argv.includes('--verbose')) {
    console.log('要看每一項實際判斷過幾個東西：npm run audit:privacy -- --verbose\n');
  }
  process.exit(0);
}

/*
 * ── 一個錯誤不該印六百次 ────────────────────────────
 *
 * 第 5 輪（第十九圈）在 500 篇（634 頁）下量到：
 * 在頁尾放**一張**第三方圖片，這支腳本印出 **600 筆、2418 行**，
 * 而結尾寫著「必須修正 600」—— 讀起來像六百個問題，其實是一行程式碼。
 * 同一輪也量到身分 needle 撞到內容時是 163 筆、667 行。
 *
 * 共用的元件出現在每一頁，所以**掃產出的規則天生會乘上頁數**。
 * 第 1 輪（第十九圈）在 `check:a11y` 上修過同一件事，判準照搬：
 * 一模一樣的發現（同規則、同命中值、同一行內容）收成一組，
 * 檔案最多列 3 個；同一條規則最多列 3 組。總數照實說，`--verbose` 全印。
 */
const VERBOSE_REPORT = process.argv.includes('--verbose');

for (const group of [
  { label: '必須修正', items: errors, mark: '✗' },
  { label: '請確認', items: warns, mark: '!' },
]) {
  if (group.items.length === 0) continue;
  console.log(`\n${group.label}（${group.items.length}）`);

  /** 同規則 ＋ 同命中值 ＋ 同一行內容 = 同一件事 */
  const merged = new Map();
  for (const f of group.items) {
    const key = `${f.rule.id}\u0000${f.matched ?? ''}\u0000${f.line}`;
    if (!merged.has(key)) merged.set(key, { f, where: [] });
    merged.get(key).where.push(`${f.rel}:${f.lineNo}`);
  }

  const perRule = new Map();
  for (const { f, where } of merged.values()) {
    const n = (perRule.get(f.rule.id) ?? 0) + 1;
    perRule.set(f.rule.id, n);
    if (!VERBOSE_REPORT && n > 3) continue;
    console.log(`\n  ${group.mark} ${where[0]}  [${f.rule.id}]`);
    console.log(`    ${f.line}`);
    const rest = VERBOSE_REPORT ? where.slice(1) : where.slice(1, 3);
    for (const w of rest) console.log(`    ${' '.repeat(2)}${w}`);
    if (!VERBOSE_REPORT && where.length > 3) {
      console.log(`      …另外 ${where.length - 3} 個地方（--verbose 看全部）`);
    }
    console.log(`    → ${f.rule.why}`);
  }
  if (!VERBOSE_REPORT) {
    for (const [id, n] of perRule) {
      if (n > 3) {
        console.log(`\n  ${group.mark} …另外 ${n - 3} 組也是 ${id}（同一條規則；--verbose 看全部）`);
      }
    }
  }
}

console.log('\n' + '─'.repeat(52));
console.log(`必須修正 ${errors.length}、請確認 ${warns.length}\n`);

// 只有 error 會讓 CI 變紅；warn 是提醒，不擋路
process.exit(errors.length > 0 ? 1 : 0);
