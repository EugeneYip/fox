#!/usr/bin/env node
// @ts-check
/**
 * 對比度檢查 —— 直接讀 src/styles/tokens.css，算 WCAG 對比值。
 *
 *   node scripts/check-contrast.mjs
 *   node scripts/check-contrast.mjs --verbose   連通過的也列出來
 *
 * 為什麼要有這個：顏色是用 CSS 變數定義的，改一個值可能同時影響十幾個地方。
 * 「看起來還好」不是驗收標準 —— 把數字算出來，深淺兩套都算。
 *
 * WCAG 2.2 的門檻：
 *   正文（小於 18.66px bold / 24px regular）  4.5:1
 *   大字                                      3:1
 *   介面元件的邊界、圖示、焦點框                 3:1（1.4.11 非文字對比）
 *   純裝飾                                     沒有要求
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve, resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * `--root=<路徑>` 讓 scripts/test-contrast.mjs 指到一份假的專案 ——
 * 放一組故意不合格的顏色，確認這道關卡真的會擋。
 *
 * 第 8 輪（第四圈）之前，check:contrast 是**唯一沒有被驗證過會擋的關卡**。
 * 而它守的是「字看不看得清楚」，壞掉的話所有顏色都會安靜地通過。
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg
  ? resolve(rootArg.slice('--root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

// ── WCAG 計算 ────────────────────────────────────────────

/**
 * 只認 3 位與 6 位的**不透明** hex。
 *
 * 第 8 輪（第十三圈）量到的：原本是 `h.length === 3 ? 補齊 : 原樣`，
 * 於是四位與八位（帶 alpha 的短寫法與長寫法）也會通過 ——
 *
 *   `#fffdf880`（八位、五成透明）→ alpha 被安靜丟掉，
 *      算出 16.69:1、印綠勾、離開碼 0。**這個站看不到它後面是什麼**，
 *      所以那個數字是「假設它不透明」算出來的，不是實際的對比
 *   `#abcd`（四位）→ 第三個色版是 NaN，印出「NaN:1」
 *
 * 半透明是**模型外的東西**，跟第 8 輪（第十一圈）那個漸層一樣。
 * 差別在漸層有寫在註解裡說明白，半透明沒有 —— 而且它還會給綠燈。
 * 現在算不出來就明講（見底下的 unusable）。
 */
const OPAQUE_HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** @param {string} hex @returns {number[]} */
function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** WCAG 2.x 的相對亮度公式 */
/** @param {string} hex */
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** @param {string} a @param {string} b */
function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * ── 算一個「改成這樣就會過」的顏色 ──────────────────
 *
 * 第 8 輪（第十七圈）量到：不合格那一行只說「1.40:1 需 4.5:1，#d8d2c6 on #faf6ee」
 * —— 事實齊全，但站主看不出**要調到多暗才夠**。而那正是這裡唯一能算、
 * 她絕對算不出來的東西（WCAG 的相對亮度不是線性的）。
 *
 * 做法：把前景往黑或往白推（看底色偏亮還偏暗），二分找剛好過門檻的那一點，
 * 再多推一點點留餘裕。回傳 undefined 表示往哪邊推都到不了 ——
 * 那時候該動的是底色，訊息會這樣說。
 *
 * @param {string} fg @param {string} bg @param {number} need
 */
function suggestFg(fg, bg, need) {
  const toward = luminance(bg) > luminance(fg) ? [0, 0, 0] : [255, 255, 255];
  const from = hexToRgb(fg);
  /** @param {number} t */
  const mix = (t) =>
    '#' +
    from
      .map((v, i) => Math.round(v + (toward[i] - v) * t))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('');
  if (contrast(mix(1), bg) < need) return undefined;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(mid), bg) >= need) hi = mid;
    else lo = mid;
  }
  /* 多推 4% —— 剛好卡在門檻上的值，之後任何微調都會掉下來 */
  return mix(Math.min(1, hi + 0.04));
}

/**
 * 去掉 CSS 註解。
 *
 * 這個 repo 因為「拿字串比對去解析結構化資料」踩過很多次，
 * 註解是其中最常見的一種：**它長得跟程式碼一模一樣**。
 * 列印那一段與 fallback 那一段早就在用它了，第 8 輪（第十五圈）
 * 把 `parseTokens()` 也接上 —— 那是待辦裡記著的最後一處。
 *
 * @param {string} t
 */
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ');

// ── 讀 tokens.css ────────────────────────────────────────

/**
 * 抓出某個選擇器區塊裡的 --c-* 變數。
 * 淺色在 :root，深色在 :root[data-theme="dark"]。
 */
/**
 * @param {string} rawCss
 * @param {string} selector
 * @param {number} [from]
 */
function parseTokens(rawCss, selector, from = 0) {
  /*
   * 註解要先拿掉，理由跟下面列印那一段一樣，而且方向兩邊都會壞：
   * 第 8 輪（第十五圈）實測，把一段假宣告寫成註解**放在真宣告之後**，
   * 42 組裡有 8 組從通過變成不合格 —— 註解贏了真的宣告。
   * 反過來（註解裡是個好顏色）就會蓋掉真的壞值，變成假的綠燈。
   *
   * 註解裡若有 `{` 或 `}`，下面用 indexOf 找區塊邊界也會被切錯，
   * 一起解決。
   */
  const css = stripComments(rawCss);
  const start = css.indexOf(selector, from);
  if (start === -1) throw new Error(`tokens.css 裡找不到 ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);

  /*
   * 顏色是用 `--c-x: light-dark(淺, 深)` 定義的，兩個值寫在同一行。
   *
   * 每個 token 前面還有一行只有淺色值的 fallback（給不支援 light-dark()
   * 的舊瀏覽器）。那一行會先被下面的迴圈掃到，但隨後就被 light-dark()
   * 那一行覆蓋掉 —— 跟瀏覽器的行為一致（後面的宣告贏）。
   */
  /** @type {Record<string, string>} */
  const light = {};
  /** @type {Record<string, string>} */
  const dark = {};

  /**
   * 算不出對比的值（帶 alpha、或位數不對）。
   * 記下來而不是丟掉 —— 「這個 token 不見了」與「這個 token 算不出來」
   * 對讀的人是兩件完全不同的事。
   * @type {Map<string, string>}
   */
  const unusable = new Map();

  /** @param {Record<string,string>} into @param {string} name @param {string} value */
  const put = (into, name, value) => {
    if (OPAQUE_HEX.test(value)) {
      into[name] = value;
      return;
    }
    unusable.set(name, value);
    delete into[name];
  };

  for (const m of block.matchAll(/(--c-[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    put(light, m[1], m[2]);
    put(dark, m[1], m[2]); // 只有 fallback 的話，深淺同值；有 light-dark() 就會被蓋掉
  }

  for (const m of block.matchAll(
    /(--c-[\w-]+)\s*:\s*light-dark\(\s*(#[0-9a-fA-F]{3,8})\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)\s*;/g,
  )) {
    put(light, m[1], m[2]);
    put(dark, m[1], m[3]);
  }

  /*
   * ── fallback 與 light-dark() 的淺色值是同一個值，寫了兩次 ──
   *
   * 每個顏色 token 在這個檔案裡出現兩行：
   *
   *   --c-bg: #faf6ee;                        ← 給不支援 light-dark() 的瀏覽器
   *   --c-bg: light-dark(#faf6ee, #14120f);   ← 現代瀏覽器用這個
   *
   * **同一個淺色值寫了兩次，而沒有任何東西檢查它們一樣。** 後面那行會蓋掉
   * 前面那行，所以漂移不會影響現代瀏覽器，也不會影響這支腳本算出來的對比
   * （它讀的是 light-dark 的值）—— 舊瀏覽器會安靜地拿到過期的配色。
   *
   * 第 8 輪（第十四圈）量過：21 個 light-dark 宣告，21 個都有 fallback、
   * 21 個都一致。這一條加的是「以後也一致」。
   *
   * 註解要先拿掉再掃 —— 這一輪的前兩次量測都被註解裡提到的 light-dark()
   * 汙染了（那份說明本身就在講這件事）。目前註解裡沒有長得像宣告的東西，
   * 但那是巧合不是設計。
   */
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {Record<string, string>} */
  const single = {};
  /** @type {{ name: string, fallback: string, light: string }[]} */
  const fallbackDrift = [];
  /** @type {string[]} */
  const noFallback = [];
  for (const raw of noComments.split('\n')) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+);\s*$/.exec(raw);
    if (!m) continue;
    const [, name, value] = m;
    if (!value.startsWith('light-dark(')) {
      single[name] = value;
      continue;
    }
    /* 括號要配對 —— rgb(0 0 0 / 0.3) 裡面也有括號 */
    const inner = value.slice('light-dark('.length, -1);
    let depth = 0;
    let comma = -1;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { comma = i; break; }
    }
    if (comma < 0) continue;
    const lightValue = inner.slice(0, comma).trim();
    if (!(name in single)) noFallback.push(name);
    else if (single[name] !== lightValue) {
      fallbackDrift.push({ name, fallback: single[name], light: lightValue });
    }
  }

  return { light, dark, unusable, fallbackDrift, noFallback, end: close };
}

// ── 要檢查的組合 ─────────────────────────────────────────

/**
 * kind 決定門檻：
 *   text        4.5:1  正文
 *   large       3:1    大字（標題、hero）
 *   ui          3:1    邊界、圖示、焦點框
 *   decorative  無要求，只報數字
 */
const PAIRS = [
  { fg: '--c-ink', bg: '--c-bg', kind: 'text', where: '正文' },
  { fg: '--c-ink', bg: '--c-bg-raised', kind: 'text', where: '卡片上的正文' },
  { fg: '--c-ink', bg: '--c-bg-sunken', kind: 'text', where: '程式碼區塊' },
  { fg: '--c-ink-soft', bg: '--c-bg', kind: 'text', where: '次要文字（.muted、摘要）' },
  { fg: '--c-ink-soft', bg: '--c-bg-raised', kind: 'text', where: '卡片上的次要文字' },
  { fg: '--c-ink-faint', bg: '--c-bg', kind: 'text', where: '.faint（日期、註記）' },
  { fg: '--c-ink-faint', bg: '--c-bg-raised', kind: 'text', where: '卡片上的 .faint' },
  { fg: '--c-flame-ink', bg: '--c-bg', kind: 'text', where: '連結、強調' },
  { fg: '--c-flame-ink', bg: '--c-bg-raised', kind: 'text', where: '卡片上的連結' },
  { fg: '--c-flame-ink', bg: '--c-flame-wash', kind: 'text', where: '彙整頁的詩詞標記' },
  { fg: '--c-moss', bg: '--c-bg', kind: 'text', where: '「手動挑選」標記' },
  { fg: '--c-seal', bg: '--c-bg', kind: 'text', where: '同步異常訊息' },
  { fg: '--c-bg', bg: '--c-seal', kind: 'large', where: '印章裡的字' },
  { fg: '--c-ink', bg: '--c-selection', kind: 'text', where: '選取範圍' },
  { fg: '--c-flame', bg: '--c-bg', kind: 'ui', where: '狐狸標記、目前頁面的底線' },
  { fg: '--c-focus', bg: '--c-bg', kind: 'ui', where: '鍵盤焦點框' },
  { fg: '--c-focus', bg: '--c-bg-raised', kind: 'ui', where: '卡片上的焦點框' },
  { fg: '--c-edge', bg: '--c-bg', kind: 'ui', where: '輸入框、按鈕的邊界' },
  { fg: '--c-edge', bg: '--c-bg-raised', kind: 'ui', where: '卡片上的輸入框邊界' },
  { fg: '--c-rule-strong', bg: '--c-bg', kind: 'decorative', where: '浮起表面外框（有陰影撐著）' },
  { fg: '--c-rule', bg: '--c-bg', kind: 'decorative', where: '分隔線（純裝飾）' },
];

/** @type {Record<string, number>} */
const THRESHOLD = { text: 4.5, large: 3, ui: 3, decorative: 0 };

/*
 * ── 這份表看不到的兩件事（第 8 輪〔第十一圈〕在瀏覽器裡量過）──
 *
 * **一、漸層。** 首頁 hero 的底是
 * `radial-gradient(70% 60% at 22% 0%, var(--c-flame-wash), transparent 68%), var(--c-bg)`，
 * 而這裡假設所有文字都在 `--c-bg` 上。深色主題下如果真的有字落在漸層最濃的
 * 地方，`.hero__source` 會是 **4.25:1**（低於 4.5），而這支腳本會報 4.86。
 *
 * 實際量過**沒有字落在那裡**：漸層在 0.68 就淡到全透明，而四段文字離中心
 * 最近的是 0.82（320／600／864px 三種寬度、深淺兩套都量過，`alpha` 全是 0）。
 * 也就是說**現在沒問題，而餘裕是 0.82 對 0.68**。hero 的版面若改動，
 * 這個餘裕是要重新量的東西。
 *
 * **二、實際字級。** 「印章裡的字」在這裡歸類為 `large`（門檻 3），
 * 但 `FoxSeal size={34}` 那個實例算出來只有 24.8px 以下 —— 瀏覽器會要求 4.5。
 * 它實際是 4.84，兩個門檻都過，所以不影響結論；但這份表的 `kind` 是
 * **人寫的假設**，不是量出來的。
 *
 * 兩件事都只有在瀏覽器裡才看得到（要版面），而六道關卡都是靜態的。
 */

// ── 執行 ─────────────────────────────────────────────────

const css = await readFile(resolve(ROOT, 'src/styles/tokens.css'), 'utf8');

/*
 * 深淺兩套值都從同一個 :root 區塊來 —— 每個 token 是一行 light-dark(淺, 深)。
 *
 * 這裡曾經有一段「比對兩份深色 token 有沒有漂移」的檢查：以前深色的值
 * 在檔案裡出現兩次（手動選深色一次、跟隨系統一次），不同步時只有跟隨
 * 系統的使用者會踩到，開發時幾乎看不出來。
 *
 * 改用 light-dark() 之後那個問題在結構上不可能發生了 —— 一個 token 只有
 * 一行，兩個值並排 —— 所以那段檢查一併刪掉。少一個要維護的東西。
 */
const tokens = parseTokens(css, ':root {');
const themes = { 淺色: tokens.light, 深色: tokens.dark };

console.log('\n對比度檢查（WCAG 2.2）\n' + '═'.repeat(78));

let failures = 0;
let checked = 0;

for (const [themeName, vars] of Object.entries(themes)) {
  console.log(`\n${themeName}`);
  console.log('─'.repeat(78));

  /**
   * 兩種形狀：找不到變數的（只有 missing），與算得出對比的（有 ratio/need/pass）。
   * 加一個判別欄位讓 TypeScript 分得開 —— 不然 r.pass 這種存取會報
   * 「屬性不存在於聯集型別」，而程式其實是先看過 r.missing 才碰它的。
   * @type {({ where: string, fg: string, bg: string, kind: string, missing: true, unusable: string[] }
   *        | { where: string, fg: string, bg: string, kind: string, missing: false,
   *            ratio: number, need: number, pass: boolean })[]}
   */
  const rows = [];
  /** where → 「前景 token on 背景 token」，改法那一行要指名道姓 */
  const pairNames = new Map(PAIRS.map((p) => [p.where, `${p.fg}（配 ${p.bg}）`]));
  for (const pair of PAIRS) {
    const fg = vars[pair.fg];
    const bg = vars[pair.bg];
    if (!fg || !bg) {
      /*
       * 「找不到」與「算不出來」對讀的人是兩件事。
       * 第 8 輪（第十三圈）之前只有前者 —— 而後者根本沒有發生過，
       * 因為帶 alpha 的值會被當成不透明算下去、印綠勾。
       */
      const bad = [pair.fg, pair.bg].filter((n) => tokens.unusable.has(n));
      rows.push({ ...pair, missing: true, unusable: bad });
      continue;
    }
    const ratio = contrast(fg, bg);
    const need = THRESHOLD[pair.kind];
    const pass = ratio >= need;
    checked++;
    if (!pass) failures++;
    rows.push({ ...pair, fg, bg, ratio, need, pass, missing: false });
  }

  for (const r of rows) {
    if (r.missing) {
      if (r.unusable.length > 0) {
        const shown = r.unusable.map((n) => `${n}: ${tokens.unusable.get(n)}`).join('、');
        console.log(`  ⚠  ${r.where.padEnd(26)} 算不出對比：${shown}`);
        console.log(
          '        帶 alpha 的顏色算出來的數字取決於它後面是什麼，而這支腳本看不到那個。' +
            '要嘛寫成不透明的值，要嘛把這一組從 PAIRS 拿掉並在註解裡說明為什麼。',
        );
      } else {
        console.log(`  ⚠  ${r.where.padEnd(26)} 找不到變數 ${r.fg} 或 ${r.bg}`);
      }
      failures++;
      continue;
    }
    if (r.pass && !VERBOSE && r.kind !== 'decorative') continue;

    const mark = r.kind === 'decorative' ? '·' : r.pass ? '✓' : '✗';
    const ratioText = `${r.ratio.toFixed(2)}:1`;
    const needText = r.need ? `需 ${r.need}:1` : '無門檻';
    console.log(
      `  ${mark}  ${r.where.padEnd(26)} ${ratioText.padStart(8)}  ${needText.padEnd(10)} ${r.fg} on ${r.bg}`,
    );
    if (!r.pass && r.kind !== 'decorative') {
      const better = suggestFg(r.fg, r.bg, r.need);
      console.log(
        `        改法：${pairNames.get(r.where) ?? '前景那個 token'} 在 tokens.css 裡` +
          (better
            ? `改成 ${better}（或更${luminance(r.bg) > luminance(r.fg) ? '暗' : '亮'}）就會過 ${r.need}:1。`
            : `不管調到全黑或全白都到不了 ${r.need}:1 —— 要動的是底色 ${r.bg}。`) +
          '　深淺兩套都要改（同一行 light-dark() 的兩個值，以及上面那行 fallback）。',
      );
    }
  }

  const failed = rows.filter((r) => !r.missing && !r.pass).length;
  if (failed === 0) console.log('  （全部通過。加 --verbose 看完整數字）');
}

/**
 * `src/` 底下所有會影響樣式的檔案（跳過 `src/content` —— 那是內容不是樣式）。
 *
 * 提到模組層是因為有兩段都要走同一批檔案：半透明表面那一段，
 * 以及 `color-mix()` 的 fallback 那一段。第 1 輪（第二十二圈）第一版
 * 把它留在前一段裡面，第二段就 ReferenceError。
 *
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walkSurf(dir) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = resolvePath(dir, e.name);
    if (e.isDirectory()) {
      if (full === resolvePath(ROOT, 'src/content')) continue;
      yield* walkSurf(full);
    } else if (/\.(css|astro)$/.test(e.name)) {
      yield full;
    }
  }
}

/*
 * ── 半透明的表面：這支腳本看不到的那一塊 ────────────────
 *
 * 第 8 輪（第二十一圈）在瀏覽器裡實測，八組顏色跟這支腳本算出來的
 * **一個小數點都不差** —— 模型是對的。然後撞到它模型不到的東西：
 *
 *     .site-header { background: color-mix(in srgb, var(--c-bg) 88%, transparent);
 *                    backdrop-filter: blur(10px); }
 *
 * 那是 `position: sticky` 的頁首，**每一頁都有，而且所有內容都會從它底下捲過去**。
 * 它的實際背景不是一個顏色，是「這一刻底下剛好是什麼」。
 *
 * PAIRS 把頁首上的字當成畫在不透明的 `--c-bg` 上（深色主題 4.86:1），
 * 而拿站上最亮的一塊（印章 `--c-flame`）合成一次，同一組字掉到 **4.29:1**
 * —— 低於 4.5:1。
 *
 * ── 那個「最壞情況」對誰是準的 ────────────────────
 *
 * 第 8 輪（第二十二圈）在瀏覽器裡把兩種情況都量了一次（淺色主題、標語）：
 *
 *   底下是頁面底色　　　　　　　　4.94:1
 *   底下是印章、**而且沒有模糊**　4.10:1　← 這支腳本報的就是這個
 *
 * 所以那個數字不是「大概」：
 *
 *   **不支援 `backdrop-filter` 的瀏覽器**（舊版 Firefox，或關掉那個旗標）
 *   —— 底下是什麼就直接透出來，讀者看到的**就是**那個數字。
 *   **支援的瀏覽器** —— 模糊把周圍抹平，實際值落在兩個數字之間。
 *
 * 也就是說：報的是**最壞的那一台機器**上的值。那是對的方向。
 *
 * ## 為什麼是「說出來」而不是「擋下來」
 *
 * 真實值取決於捲動位置，算不出單一答案；而把頁首改成不透明是配色決定，
 * 不是腳本該替站主做的。所以這裡做的是**讓看不到的那一塊被看見**：
 * 找出「文字底下是半透明表面」的地方，把最壞情況算給她看。
 *
 * 判準只認 `background`／`background-color` 裡的 `color-mix(… transparent)`
 * 與帶 alpha 的寫法，而且跳過漸層（漸層本來就算不出單一對比，
 * 上面涵蓋率那一段也是同一個判斷）。
 */
{
  /** 半透明背景的兩種寫法：color-mix 到 transparent，或帶 alpha 的顏色函式 */
  const TRANSLUCENT = [
    /color-mix\(\s*in\s+[\w-]+\s*,\s*var\(\s*(--c-[\w-]+)\s*\)\s*(\d+)%\s*,\s*transparent\s*\)/,
    /rgba?\([^)]*\/\s*(?:0?\.\d+)\s*\)/,
  ];

  /** @type {{ where: string, sel: string, token: string, pct: number }[]} */
  const surfaces = [];

  for await (const file of walkSurf(resolve(ROOT, 'src'))) {
    const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ' ');
    const where = file.slice(ROOT.length + 1);
    /*
     * 選擇器只是為了讓她找得到那一段 —— 取這個宣告前面最近的
     * `xxx {`。剖得不完美沒關係（這裡不擋人），但要指得到地方。
     */
    for (const m of text.matchAll(/(background(?:-color)?)\s*:\s*([^;{}]+)/g)) {
      const value = m[2];
      if (/gradient\(/.test(value)) continue;
      const mix = TRANSLUCENT[0].exec(value);
      if (!mix && !TRANSLUCENT[1].test(value)) continue;
      const before = text.slice(0, m.index);
      const sel = [...before.matchAll(/([^{}();]+)\{/g)].pop()?.[1].trim().split('\n').pop()?.trim() ?? '(不明)';
      surfaces.push({
        where,
        sel: sel.slice(0, 40),
        token: mix?.[1] ?? '(直接寫的 alpha)',
        pct: mix ? Number(mix[2]) : 0,
      });
    }
  }

  console.log('\n' + '═'.repeat(78));
  if (surfaces.length === 0) {
    console.log('半透明表面：沒有 —— 上面每一組算的都是實際會畫出來的顏色 ✓');
  } else {
    console.log(`半透明表面（${surfaces.length} 個）—— **上面那些數字沒有涵蓋這些**`);
    console.log('  它們的實際背景是「這一刻底下剛好是什麼」，算不出單一答案。\n');

    /*
     * ── 最壞情況要拿真的會發生的東西來算 ──────────────
     *
     * 第一版拿「站上最亮的 token」跟「PAIRS 裡畫在同一個底色上的每一種字」
     * 交叉相乘，結果報出五筆，其中三筆是**不可能發生的組合** ——
     * 「同步異常訊息」與「手動挑選標記」根本不會出現在頁首上，
     * 而深色主題的「最亮 token」抓到的是 `--c-ink`（那是字的顏色，
     * 從來不是一整塊表面，而且模糊會把細細的筆畫抹平）。
     *
     * 一條會誤報的規則比沒有規則糟 —— 這個 repo 記過很多次。
     * 所以兩邊都收窄成量得到的東西：
     *
     *   底下捲過什麼　→ 真的被當成**純色背景**用過的 token
     *   上面畫什麼字　→ 那個元件自己 `color:` 出來的 token
     */
    const solidBg = new Set();
    const textIn = new Map();
    /** class 名 → 它設定的文字顏色 token（跨檔案） */
    const classColor = new Map();
    /** 每個檔案的 markup 用到哪些 class */
    const classesUsed = new Map();
    for await (const file of walkSurf(resolve(ROOT, 'src'))) {
      const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ' ');
      const rel = file.slice(ROOT.length + 1);
      /*
       * ── class → 它設定的文字顏色 ──────────────────
       *
       * 要追得到 `class="brand__tagline faint"` 這種：`.faint` 的顏色定義在
       * global.css，不在頁首那個檔案裡。
       *
       * 這裡**不能**用上面那個 `split(/[;{}]/)` 的切法 —— 那會把選擇器切成
       * 獨立的一塊，宣告那一塊裡根本看不到選擇器。第一版就是這樣寫的，
       * 於是 classColor 全空、標語整個漏掉，而那一段變成一句警告都沒有 ——
       * **看起來像沒事**。逐個 `選擇器 { … }` 走才對得起來。
       */
      for (const b of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const tok = /(?:^|[;\s])color\s*:[^;]*var\(\s*(--c-[\w-]+)/.exec(b[2])?.[1];
        if (!tok) continue;
        for (const c of b[1].matchAll(/\.([a-z][\w-]*)/g)) {
          if (!classColor.has(c[1])) classColor.set(c[1], new Set());
          classColor.get(c[1]).add(tok);
        }
      }
      for (const m of text.matchAll(/class=["']([^"']+)["']/g)) {
        if (!classesUsed.has(rel)) classesUsed.set(rel, new Set());
        for (const c of m[1].split(/\s+/)) classesUsed.get(rel).add(c);
      }
      for (const decl of text.split(/[;{}]/)) {
        const colon = decl.indexOf(':');
        if (colon < 0) continue;
        const prop = decl.slice(0, colon).trim().toLowerCase().split(/\s/).pop() ?? '';
        const value = decl.slice(colon + 1);
        if (/gradient\(|transparent/.test(value)) continue;
        const tok = /var\(\s*(--c-[\w-]+)/.exec(value)?.[1];
        if (!tok) continue;
        if (prop === 'background' || prop === 'background-color') solidBg.add(tok);
        if (prop === 'color') {
          if (!textIn.has(rel)) textIn.set(rel, new Set());
          textIn.get(rel).add(tok);
        }
      }
    }

    for (const [themeName, vars] of Object.entries(themes)) {
      const unders = [...solidBg].filter((t) => vars[t] && OPAQUE_HEX.test(vars[t]));
      if (unders.length === 0) continue;

      for (const surf of surfaces) {
        const base = vars[surf.token];
        if (!base || !surf.pct) continue;
        /** 半透明層蓋在某個底色上之後的實際顏色 */
        const composite = (/** @type {string} */ under) => {
          const a = surf.pct / 100;
          const [f, u] = [hexToRgb(base), hexToRgb(under)];
          const c = f.map((v, i) => Math.round(v * a + u[i] * (1 - a)));
          return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
        };
        /*
         * 這個表面上會出現的字：元件自己 `color:` 的，
         * 加上它 markup 裡用到的 class 在別處定義的顏色。
         * 兩份都要 —— 頁首的站名與導覽是前者，標語（`.faint`）是後者。
         */
        const onSurface = new Set(textIn.get(surf.where) ?? []);
        for (const c of classesUsed.get(surf.where) ?? []) {
          for (const t of classColor.get(c) ?? []) onSurface.add(t);
        }
        for (const fgTok of onSurface) {
          const fg = vars[fgTok];
          if (!fg) continue;
          const onBase = contrast(fg, base);
          if (onBase < 4.5) continue; // 本來就不合格的話，上面那張表已經報過了
          let worstUnder = '';
          let worst = Infinity;
          for (const u of unders) {
            const r = contrast(fg, composite(vars[u]));
            if (r < worst) { worst = r; worstUnder = u; }
          }
          if (worst >= 4.5) continue;
          console.log(
            `  ⚠  ${themeName}　${surf.sel} 上的 ${fgTok}：` +
              `這支腳本算的是 ${onBase.toFixed(2)}:1（當成不透明的 ${surf.token}），` +
              `而底下捲過 ${worstUnder} 的時候是 **${worst.toFixed(2)}:1**`,
          );
        }
      }
    }
    for (const s of surfaces) {
      console.log(`  ·  ${s.where}　${s.sel}　${s.token}${s.pct ? ` ${s.pct}%` : ''}`);
    }
    console.log(
      '\n  要讓這一塊變成算得準的：把表面改成不透明，' +
        '或把畫在它上面的字改成在最壞情況下也過門檻的顏色。',
    );
  }
}

/*
 * ── PAIRS 涵蓋不涵蓋實際用到的顏色 ───────────────────
 *
 * 上面那 21 組是**手寫的**。手寫清單的問題不是它今天對不對，
 * 是它不會自己長大 —— 有人加一個 `--c-something` 並拿來當文字顏色，
 * 這支腳本會照樣印「全部通過」，因為它從來不知道那個 token 存在。
 *
 * 第 8 輪（第九圈）手動量過一次（前景 9／9 都在），第 8 輪（第十圈）
 * 把那次量測變成每次都跑的東西。判準分三種，刻意不一樣：
 *
 *   前景（color、fill、border-color…）  必須以 fg 的身分出現在 PAIRS 裡
 *   純色背景（background: var(...)）    必須**出現在 PAIRS 裡**（fg 或 bg 都算）
 *   漸層與陰影裡的 token               不管
 *
 * 中間那條為什麼放寬：`background` 也用來**畫東西**，不只是鋪底。
 * 實測的兩個例子是 Header 那條 2px 的底線與狐火的圓點 —— 它們用
 * `background` 上色，但上面沒有字。那種 token 該被當成「介面元件」
 * 算對比（`--c-flame` on `--c-bg`，門檻 3:1），而它確實已經在 PAIRS 裡。
 * 所以要求「出現在 PAIRS 裡」就夠了，不必判斷它是底色還是圖形 ——
 * 那件事靜態分析判不出來，而硬猜會製造假警報。
 *
 * 第三條為什麼不管：漸層疊出來的實際底色算不出單一比值。
 * `VideoFacade` 沒有封面時那塊暈染就是這種，上面唯一的字是 `aria-hidden`
 * 的裝飾，真正要讀的播放鈕自己帶背景（而那一組在 PAIRS 裡）。
 */
{
  const FG_PROPS = new Set([
    'color', 'fill', 'stroke', '-webkit-text-fill-color', 'caret-color',
    'text-decoration-color', 'outline-color', 'border-color',
    'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color',
    'border-inline-start-color', 'border-inline-end-color',
    'border-block-start-color', 'border-block-end-color',
  ]);
  const BG_PROPS = new Set(['background', 'background-color', 'background-image']);

  /*
   * 要排除的是 `src/content`（markdown 內容），**不是任何叫 content 的目錄**。
   * 第一版寫成 `e.name === 'content'`，結果連 `src/components/content/` 整個
   * 都不掃了 —— 那裡面有 `color: var(--c-moss)`。跟先前手動量的結果一比才發現
   * 前景少了一種（9 → 8）。比對整條路徑，不比對名字。
   */
  const CONTENT_DIR = resolvePath(ROOT, 'src/content');

  /** @param {string} dir @returns {AsyncGenerator<string>} */
  async function* walkSrc(dir) {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = resolvePath(dir, e.name);
      if (e.isDirectory()) {
        if (full === CONTENT_DIR) continue;
        yield* walkSrc(full);
      } else if (/\.(css|astro)$/.test(e.name)) {
        yield full;
      }
    }
  }

  /** 任何 `var(--x)` 用到的 token —— 給下面「宣告了卻沒有人用」那一段 */
  const anyUse = new Set();
  /** @type {Map<string, Set<string>>} 前景 token → 用在哪 */
  const fgUse = new Map();
  /** @type {Map<string, Set<string>>} 純色背景 token → 用在哪 */
  const bgUse = new Map();

  for await (const file of walkSrc(resolve(ROOT, 'src'))) {
    const raw = await readFile(file, 'utf8');
    // 註解裡的 var(--c-x) 不算數
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const where = file.slice(ROOT.length + 1);
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) anyUse.add(m[1]);
    // 逐個宣告切開 —— 屬性名決定它是前景還是背景，不是拿整段去猜
    for (const decl of text.split(/[;{}]/)) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const prop = decl.slice(0, colon).trim().toLowerCase().split(/\s/).pop() ?? '';
      const value = decl.slice(colon + 1);
      const tokens = [...value.matchAll(/var\(\s*(--c-[\w-]+)/g)].map((m) => m[1]);
      if (tokens.length === 0) continue;
      const bucket = FG_PROPS.has(prop)
        ? fgUse
        : BG_PROPS.has(prop) && !/gradient\(/.test(value)
          ? bgUse
          : null;
      if (!bucket) continue;
      for (const t of tokens) {
        if (!bucket.has(t)) bucket.set(t, new Set());
        /** @type {Set<string>} */ (bucket.get(t)).add(where);
      }
    }
  }

  /*
   * ── 宣告了，但沒有任何地方 var() 它 ──────────────────
   *
   * 第 8 輪（第十五圈）量到：tokens.css 宣告 65 個自訂屬性，其中 4 個
   * （`--t-2xl`、`--lh-loose`、`--r-lg`、`--dur-slow`）**只出現在自己那一行**。
   *
   * 這不是錯 —— 字級與圓角本來就常常整組宣告、只用其中幾階。
   * 但它跟這一圈追的是同一件事：**看起來是個旋鈕，轉了卻什麼都不會動。**
   * （第 5 輪在 privacy.ts 找到四個同樣的開關。）
   *
   * 所以只印出來，不擋 —— 要刪還是要用是站主的決定。
   */
  {
    const declared = [
      ...new Set([...stripComments(css).matchAll(/^\s*(--[a-z][\w-]*)\s*:/gm)].map((m) => m[1])),
    ];
    const unused = declared.filter((t) => !anyUse.has(t));
    console.log('\n' + '─'.repeat(78));
    /* 開頭的「未使用：」是給 test-contrast 的段落狀態機認的，跟上面幾段一致 */
    if (unused.length === 0) {
      console.log(`未使用：宣告的 ${declared.length} 個 token 都有人用 ✓`);
    } else {
      console.log(`未使用：${declared.length} 個 token 裡有 ${unused.length} 個沒有任何地方 var() 它 —`);
      for (const t of unused) console.log(`  ✗ ${t}`);
      console.log('  不是錯，但轉了不會有任何效果。要刪還是要接上去，站主決定。');
    }
  }

  const pairFg = new Set(PAIRS.map((p) => p.fg));
  const pairAny = new Set([...PAIRS.map((p) => p.fg), ...PAIRS.map((p) => p.bg)]);

  /** @type {string[]} */
  const gaps = [];
  for (const [token, files] of fgUse) {
    if (pairFg.has(token)) continue;
    gaps.push(`  ✗ ${token} 被當文字顏色用，但 PAIRS 裡沒有以它為前景的組合`
      + `\n      用在：${[...files].slice(0, 3).join('、')}`);
  }
  for (const [token, files] of bgUse) {
    if (pairAny.has(token)) continue;
    gaps.push(`  ✗ ${token} 被當純色背景用，但 PAIRS 裡完全沒有它`
      + `\n      用在：${[...files].slice(0, 3).join('、')}`);
  }

  console.log('\n' + '─'.repeat(78));
  if (gaps.length === 0) {
    console.log(
      `涵蓋率：前景 ${fgUse.size} 種、純色背景 ${bgUse.size} 種，都在 PAIRS 裡 ✓`,
    );
  } else {
    console.log('涵蓋率：有顏色在用，但沒有任何一組對比在算它 —');
    for (const g of gaps) console.log(g);
    console.log('  修法：在 PAIRS 加一組，順便決定它的門檻（text 4.5 / large 3 / ui 3 / decorative 無）。');
    failures += gaps.length;
  }
}

/*
 * ── fallback 有沒有跟 light-dark() 的淺色值分岔 ──────
 *
 * 同一個淺色值在這個檔案裡寫了兩次（理由見 readTokens 裡的說明）。
 * 分岔的話現代瀏覽器不受影響、這支腳本算出來的對比也不受影響 ——
 * **只有不支援 light-dark() 的瀏覽器會安靜地拿到過期的配色**，
 * 而那正是沒有人會去看的地方。
 */
{
  console.log('\n' + '─'.repeat(78));
  const { fallbackDrift, noFallback } = tokens;
  if (fallbackDrift.length === 0 && noFallback.length === 0) {
    console.log('fallback：每個 light-dark() 都有一行單值 fallback，而且值一樣 ✓');
  } else {
    /* 這一行是段落標題 —— test-contrast 的剖析器靠它切段（跟涵蓋率、列印一致） */
    console.log('fallback：兩行寫的淺色對不起來 —');
    for (const d of fallbackDrift) {
      console.log(`  ✗ ${d.name} 的 fallback 跟 light-dark() 的淺色值不一樣`);
      console.log(`      fallback ${d.fallback}　light-dark 的淺色 ${d.light}`);
    }
    for (const n of noFallback) {
      console.log(`  ✗ ${n} 有 light-dark() 但沒有單值的 fallback —— 舊瀏覽器會拿不到這個顏色`);
    }
    console.log('  兩行寫的是同一個淺色，改了一行就要改另一行。');
    failures += fallbackDrift.length + noFallback.length;
  }

  /*
   * ── 同一套紀律，`color-mix()` 也要有 ────────────────
   *
   * 第 1 輪（第二十二圈）量到的：`light-dark()` 每一個都有 fallback、
   * 而且有這一段在守；**`color-mix()` 兩處都沒有，也沒有人在守**。
   *
   * 不支援時的行為比 light-dark 更糟：整條宣告會被丟掉（實測 ——
   * 用不合法的色彩空間去設，`style.background` 回空字串）。
   * 而其中一處是 `position: sticky` 的頁首背景 —— 沒有背景就等於
   * 導覽列的字直接印在捲過去的內文上。那一輪截圖看過那個樣子：
   * 標題與導覽列疊在一起，兩邊都讀不了。
   *
   * 判準：`color-mix()` 那一行的**前一行**要有同一個屬性的宣告。
   * 不管它的值是什麼（那是配色決定），只要求「有東西接得住」。
   */
  const mixMissing = [];
  for await (const file of walkSurf(resolve(ROOT, 'src'))) {
    const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, ' ');
    /*
     * 逐個宣告看，不逐行看。
     *
     * 第一版是「這一行有 color-mix，那前一行呢」—— 在
     * `.bar { background: color-mix(…); }` 這種一行寫完的形式上
     * **連屬性名都抽不到**，於是整條規則安靜跳過。
     * 自己寫的測試案例就是那個形式，跑起來才發現。
     */
    for (const m of text.matchAll(/([a-z-]+)\s*:\s*[^;{}]*color-mix\([^;{}]*/g)) {
      const prop = m[1];
      const before = text.slice(0, m.index);
      /** 前一個宣告：從上一個 `;` 或 `{` 往回再找一個 */
      const cut = Math.max(before.lastIndexOf(';'), before.lastIndexOf('{'));
      const prevChunk =
        cut < 0 ? '' : before.slice(Math.max(before.lastIndexOf(';', cut - 1), before.lastIndexOf('{', cut - 1)) + 1, cut);
      /** 前一個宣告接得住嗎：同一個屬性，而且它自己不是 color-mix */
      const caught =
        new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(prevChunk) && !/color-mix\(/.test(prevChunk);
      if (caught) continue;
      mixMissing.push({
        where: `${file.slice(ROOT.length + 1)}:${before.split('\n').length}`,
        prop,
        line: m[0].trim().slice(0, 70),
      });
    }
  }
  if (mixMissing.length === 0) {
    console.log('　　　　每個 color-mix() 前面也都有一行接得住的宣告 ✓');
  } else {
    console.log('fallback：color-mix() 沒有接得住的前一行 —');
    for (const m of mixMissing) {
      console.log(`  ✗ ${m.where}　${m.line}`);
      console.log(
        `      不支援 color-mix() 的瀏覽器會把整條 \`${m.prop}\` 丟掉。` +
          `　改法：前面加一行 \`${m.prop}: …\`，用一個不含 color-mix 的值。`,
      );
    }
    failures += mixMissing.length;
  }
}

/*
 * ── 列印時所有主題都要切回淺色 ──────────────────────
 *
 * 顏色是用 light-dark() 定義的，所以「列印時用淺色」這件事只需要一行
 * `color-scheme: light`。問題是**媒體查詢不增加權重**：
 *
 *   tokens.css  :root[data-theme="dark"] { color-scheme: dark }   權重 (0,1,1)
 *   global.css  @media print { :root { color-scheme: light } }    權重 (0,1,0)
 *
 * 後者輸了。結果是手動選深色的人列印時，除了硬改的三個 token 之外
 * 全部仍然是深色那一套 —— 狐火色、註解色、分隔線都是為深底調的，
 * 印在白紙上淡到看不清楚。
 *
 * 這個 bug 活了兩圈（第 8 輪〔第一圈〕以為修好了），
 * 因為列印樣式從來沒有真的驗過。所以這裡不靠人記得，改成用比對的：
 * **tokens.css 裡每一個設定 color-scheme 的選擇器，
 * 列印區塊都必須有對應的一條。**
 */
{
  /*
   * 先把 CSS 註解拿掉再比對。
   *
   * 第一版沒拿掉，結果**我自己寫在列印區塊裡的說明文字**提到了
   * `:root[data-theme="dark"]`，字串比對就配到那段註解，
   * 於是「有沒有覆蓋到」永遠是 true —— 檢查等於沒作用。
   * 第五次踩「拿字串比對去解析結構化資料」。
   */
  const globalCss = stripComments(await readFile(resolve(ROOT, 'src/styles/global.css'), 'utf8'));
  const printBlock = globalCss.slice(globalCss.indexOf('@media print'));

  /** tokens.css 裡設了 color-scheme 的選擇器 */
  const themeSelectors = [...stripComments(css).matchAll(/([^{}]+)\{[^{}]*color-scheme\s*:[^;}]+/g)]
    .map((m) => m[1].trim().split('\n').pop()?.trim() ?? '')
    .filter(Boolean);

  const missing = themeSelectors.filter((sel) => !printBlock.includes(sel));

  console.log('\n' + '─'.repeat(78));
  if (missing.length === 0) {
    console.log(`列印：${themeSelectors.length} 個設 color-scheme 的選擇器，列印區塊都有覆蓋 ✓`);
  } else {
    console.log('列印：以下選擇器在 tokens.css 設了 color-scheme，但 @media print 沒有覆蓋 —');
    for (const sel of missing) console.log(`  ✗ ${sel}`);
    console.log('  這些主題的使用者列印時會拿到為螢幕調的顏色。');
    console.log('  修法：在 global.css 的 @media print 裡把這些選擇器也列進 color-scheme: light。');
    failures += missing.length;
  }
}

/*
 * ── 瀏覽器外框的顏色，跟頁面背景是同一個嗎 ──────────────
 *
 * `theme-color` 畫的是手機網址列、PWA 啟動畫面、Safari 分頁列的底色，
 * 也就是**緊貼著頁面上緣的那一塊**。對不上就是一條看得見的接縫。
 *
 * 而它寫在 `src/config/site.ts`，不在 `tokens.css` 裡 ——
 * 這支腳本從第一天起就只讀 tokens.css，所以那兩個值**沒有任何檢查看過**。
 *
 * 第 8 輪（第二十四圈）量到它們真的不一樣：
 *
 *     淺色  site.ts #F7F2E8　vs　--c-bg #faf6ee　逐通道 -3/-4/-6，對比 1:1.035
 *     深色  site.ts #12110F　vs　--c-bg #14120f　逐通道 -2/-1/0，  對比 1:1.009
 *
 * 同一個顏色寫在兩個檔案裡，兩份都很像、都不對。
 */
{
  const siteSrc = await readFile(resolve(ROOT, 'src/config/site.ts'), 'utf8').catch(() => '');
  const m = /themeColor:\s*\{\s*light:\s*'([^']+)'\s*,\s*dark:\s*'([^']+)'/.exec(siteSrc);
  const bgLight = tokens.light['--c-bg'];
  const bgDark = tokens.dark['--c-bg'];

  console.log('\n' + '─'.repeat(78));
  if (!m || !bgLight || !bgDark) {
    console.log(
      'theme-color 沒有核對：' +
        (m ? '讀不到 --c-bg。' : "src/config/site.ts 裡找不到 themeColor: { light: '…', dark: '…' }。") +
        '（寧可說「沒查」，也不要靜靜地放行。）',
    );
  } else {
    /* 大小寫不算差異 —— #FAF6EE 與 #faf6ee 是同一個顏色 */
    const same = (/** @type {string} */ a2, /** @type {string} */ b2) =>
      a2.toLowerCase() === b2.toLowerCase();
    const bad = [];
    if (!same(m[1], bgLight)) bad.push(['淺色', m[1], bgLight]);
    if (!same(m[2], bgDark)) bad.push(['深色', m[2], bgDark]);
    if (bad.length === 0) {
      console.log(`theme-color：兩種主題都跟 --c-bg 一致 ✓（${bgLight} / ${bgDark}）`);
    } else {
      console.log('theme-color：跟頁面背景 --c-bg 對不上 —');
      for (const [which, got, want] of bad) {
        console.log(`  ✗ ${which}　site.ts ${got}　vs　--c-bg ${want}`);
      }
      console.log('  瀏覽器外框與頁面之間會有一條看得見的接縫。');
      console.log('  改法：把 src/config/site.ts 的 themeColor 改成上面 --c-bg 的值。');
      failures += bad.length;
    }
  }
}

console.log('\n' + '═'.repeat(78));
console.log(`檢查 ${checked} 組，未達標 ${failures} 組。\n`);

process.exit(failures > 0 ? 1 : 0);
