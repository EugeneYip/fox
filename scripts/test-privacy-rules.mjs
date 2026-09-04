#!/usr/bin/env node
// @ts-check
/**
 * 隱私規則的實測 —— `npm run test:privacy-rules`
 *
 * 每一條規則都測兩件事：**該抓到的有抓到**，以及**不該抓到的沒抓到**。
 *
 * 為什麼第二件事同樣重要：第 5 輪（第二圈）把 email 規則改窄了，
 * 因為它把 `undici@8.10.1` 這種版本字串當成信箱 —— 關卡裡的雜訊會讓人
 * 學會忽略警告。但**把隱私規則改寬鬆是有風險的動作**：改過頭就會漏掉
 * 真的洩漏，而且不會有任何地方報錯。所以這裡兩個方向都測。
 */
import { RULES } from './lib/privacy-rules.mjs';
import { identityRules, readIdentityNeedles } from './lib/identity-needles.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * catch／skip 是字串（測 pattern），files 是路徑（測 only）。
 * 有 only 的規則沒寫 files 會直接失敗 —— 見下面的迴圈。
 * @type {Record<string, { catch: string[], skip: string[], files?: { match: string[], skip: string[] } }>}
 */
const CASES = {
  email: {
    catch: [
      'bella@gmail.com',
      '聯絡：foxpoetry@hotmail.com.tw',
      'a.b+tag@sub.domain.co.uk',
      'Bella.Chen@ntu.edu.tw',
      'someone@protonmail.ch',
      'x@yahoo.com.tw',
    ],
    skip: [
      '`undici@8.10.1`（Astro 工具鏈的傳遞相依）',
      '`@astrojs/check@0.9.10` 的 peer 是 `^5.0.0`',
      'astro@7.2.10',
      'npm i sharp@0.34.2',
      'pkg@1.2.3-beta',
      'eslint@9.0.0-rc.1',
      'foo@example.com',
      'bar@sub.example',
      '@media (max-width: 34rem)',
    ],
  },
  'google-fonts': {
    catch: ['<link href="https://fonts.googleapis.com/css2?family=X">', 'fonts.gstatic.com'],
    skip: ['系統字型：Noto Serif TC, Songti TC', 'fonts are local'],
  },
  analytics: {
    catch: ['gtag(\'config\', \'G-XXX\')', 'https://plausible.io/js/script.js', 'umami.is/script.js'],
    skip: ['這個站不做訪客追蹤', 'const analytics = "none";'],
  },
  'raw-youtube-embed': {
    catch: ['<iframe src="https://www.youtube.com/embed/abc" />'],
    skip: ['<VideoFacade id="abc" />', 'frame-src https://www.youtube-nocookie.com'],
  },
  'third-party-cdn': {
    catch: ['https://cdn.jsdelivr.net/npm/x', 'https://unpkg.com/y'],
    skip: ['本站不用 CDN'],
  },
  'target-blank-no-rel': {
    /*
     * 第 5 輪（第十四圈）之前只有這兩條，而它們**同一個順序、同一種寫法** ——
     * 所以第 1 輪（第十四圈）量到的兩個 bug（`rel` 寫在前面會誤報、
     * `data-rel` 會漏報）在這裡一個都測不到。
     * 底下的四種寫法是拿 `check:a11y` 的 `blank-rel` 當對照組比出來的。
     */
    catch: [
      '<a target="_blank" href="https://x.com">x</a>',
      /* data-rel 不是 rel —— 跟第 1 輪（第十三圈）在 check-a11y 修掉的同一族 */
      '<a href="https://x.com" target="_blank" data-rel="x">x</a>',
      "<a href='https://x.com' target='_blank'>x</a>",
      /* 元件也算：包裝元件不一定會補 rel */
      '<ExternalLink target="_blank" href="https://x.com">x</ExternalLink>',
    ],
    skip: [
      '<a href="https://x.com" target="_blank" rel="noopener noreferrer">x</a>',
      /* rel 寫在 target **前面** —— 舊的樣式只往後看，會誤報 */
      '<a href="https://x.com" rel="noopener noreferrer" target="_blank">x</a>',
      /* 站上真正的寫法：多行，而且 rel 在下一行 */
      '<a\n  href={href}\n  target="_blank"\n  rel={externalLinkRel}\n>',
      '<a\n  href={href}\n  rel={externalLinkRel}\n  target="_blank"\n>',
      /*
       * Astro 的展開語法：rel 在那個物件裡，字串比對看不進去。
       * 第 5 輪（第十六圈）的誤報探針量到的 —— 沒有這一格，
       * 一份完全合法的元件會被報成「忘了加 rel」。
       */
      '<a href="https://x.com" target="_blank" {...externalLinkRel}>x</a>',
      '<a href="https://x.com" {...attrs} target="_blank">x</a>',
    ],
    files: {
      match: ['src/pages/about.astro', 'src/content/posts/x.md'],
      skip: ['scripts/audit-privacy.mjs'],
    },
  },
  'leftover-placeholder': {
    catch: ['handle: \'CHANGE_ME\'', '<handle>CHANGE_ME</handle>'],
    /*
     * 第二個 skip 是這一輪加的重點：`=== 'CHANGE_ME'` 是**在比對**這個字串，
     * 不是忘了填。版控裡每一處 CHANGE_ME 都是這種寫法，只有文件是在講它。
     */
    skip: ['handle: \'FoxPoetry\'', "if (source.handle === 'CHANGE_ME') {"],
    files: {
      match: ['src/config/sources.mjs', '.github/workflows/deploy.yml'],
      skip: ['docs/REVIEW-LOG.md', 'scripts/lib/privacy-rules.mjs'],
    },
  },
};

let failed = 0;
/**
 * @param {boolean} cond
 * @param {string} label
 */
const ok = (cond, label) => {
  if (!cond) { failed++; console.log(`  X ${label}`); }
  return cond;
};

console.log('\n隱私規則實測');
console.log('─'.repeat(64));

for (const rule of RULES) {
  const c = CASES[rule.id];
  if (!c) {
    console.log(`  ⚠ ${rule.id.padEnd(18)} 沒有測試案例 —— 加規則就要加案例`);
    failed++;
    continue;
  }
  let pass = 0;
  for (const s of c.catch) {
    rule.pattern.lastIndex = 0;
    if (ok(rule.pattern.test(s), `${rule.id}：應該抓到卻沒抓到 → ${s}`)) pass++;
  }
  for (const s of c.skip) {
    rule.pattern.lastIndex = 0;
    if (ok(!rule.pattern.test(s), `${rule.id}：不該抓卻抓到了 → ${s}`)) pass++;
  }

  /*
   * ── only 也要測 ──
   *
   * 到第 5 輪（第六圈）為止，這裡只測 `rule.pattern`，從來沒碰過 `rule.only`。
   * 結果是 leftover-placeholder 用一個 .mjs 形狀的字串通過測試，
   * 而真實的稽核把 .mjs 整個排除掉 —— **測試通過的理由跟規則實際做的事無關**。
   *
   * 有 only 的規則就必須說出「哪些路徑該掃、哪些不該」。
   */
  let total = c.catch.length + c.skip.length;
  if (rule.only && !c.files) {
    failed++;
    console.log(`  X ${rule.id}：有 only 卻沒有 files 案例 —— 沒有人確認過它掃的是哪些檔案`);
  } else if (c.files) {
    for (const f of c.files.match) {
      total++;
      if (ok(rule.only ? rule.only.test(f) : true, `${rule.id}：這個路徑該掃卻被排除 → ${f}`)) pass++;
    }
    for (const f of c.files.skip) {
      total++;
      if (ok(rule.only ? !rule.only.test(f) : false, `${rule.id}：這個路徑不該掃卻掃了 → ${f}`)) pass++;
    }
  }
  console.log(`  ✓ ${rule.id.padEnd(18)} ${pass}/${total}`);
}

/*
 * ── 每一條規則都要說得出「改法：」──────────────────────
 *
 * 第十七圈問的是「站主照著做得到嗎」。第 5 輪（第十七圈）量到：
 * 七條樣式規則裡有六條其實有建議，只是措辭不一；而
 * `leftover-placeholder` 只有十個字（「還有沒填的佔位字串。」）——
 * 那偏偏是**站主最可能踩到的一條**（她複製 sources.mjs 的範本、忘了填 handle）。
 *
 * 統一用「改法：」當標記，跟 check:a11y、check:content 一樣。
 */
{
  const missing = RULES.filter((r) => !r.why.includes('改法：')).map((r) => r.id);
  if (missing.length > 0) {
    failed += missing.length;
    console.log(`\n  X 這些規則的 why 沒有講「改法：」：${missing.join('、')}`);
    console.log('      站主看到的是一句事實，不知道下一步要做什麼。');
  } else {
    console.log(`  ✓ ${RULES.length} 條規則都講了「改法：」`);
  }
}

/*
 * 身分規則是執行時組出來的，也要測。
 *
 * 第 5 輪（第十三圈）之前這裡只有三條斷言，而且**用的字串跟針一模一樣** ——
 * 所以「同一個值換個寫法還抓不抓得到」十三圈以來沒有人問過。
 * 實測十種寫法只有三種被抓到（三種都是原樣）。下面把十種都釘住，
 * 並且釘住幾種**不該**抓到的，因為放寬比對是有風險的動作：
 * 改過頭就會滿螢幕誤報，而誤報會讓人學會忽略這道關卡。
 */
{
  const [rule] = identityRules(['黃小明', 'Some University', 'a.b@example.invalid']);
  /** @param {string} text @param {boolean} want @param {string} label */
  const hit = (text, want, label) => {
    rule.pattern.lastIndex = 0;
    ok(rule.pattern.test(text) === want, `身分規則：${label}`);
  };

  // ── 該抓到的 ──
  hit('作者是黃小明', true, '原樣（中文）');
  hit('from Some University', true, '原樣（英文）');
  hit('寫信到 a.b@example.invalid', true, '原樣（email）');
  hit('FROM SOME UNIVERSITY', true, '全大寫');
  hit('from some university', true, '全小寫');
  hit('a.b@EXAMPLE.INVALID', true, 'email 的網域大寫');
  hit('from Some\nUniversity', true, '被折行拆成兩行（英文，在空白處）');
  hit('作者是黃小\n明', true, '被折行拆在詞中間（中文）');
  hit('from Some  University', true, '中間多一個空白');
  hit('https://x.invalid/?q=Some%20University', true, '網址裡的百分比編碼（英文）');
  hit('https://x.invalid/?q=' + encodeURIComponent('黃小明'), true, '網址裡的百分比編碼（中文）');

  // ── 不該抓到的 ──
  hit('作者是狐狸', false, '完全不相干的字');
  hit('from Some', false, '只有前半（英文）');
  hit('黃小', false, '只有前半（中文）');
  hit('University Some', false, '順序反過來');
  hit('from Some-University', false, '空白換成連字號');
  /*
   * 中文詞中間夾**空白**刻意不算 —— 只允許換行。
   * 允許空白的話，「黃 小 明」這種排版與不相干的字組合都會中，
   * 而誤報的代價是整道關卡被忽略。這一條是把取捨釘住，不是理想行為。
   */
  hit('黃 小明', false, '中文詞中間夾空白（刻意不放寬）');

  ok(identityRules([]).length === 0, '身分規則：沒有值時不產生規則');

/*
 * ── 跟專案釘住的時區同名的值，不當成搜尋字串 ──────────
 *
 * 2026-09-04 身分規則第一次真的跑（在那之前這台機器沒有 identity.local.ts、
 * CI 上也沒有 secret），結果 28 個 identity-value，落點全部是時區相關的檔案。
 * 逐欄位量過：只有**英文城市**命中，而命中的是 `Asia/⋯` 這個時區識別碼。
 *
 * 這個專案把時區釘成 `Asia/Taipei`（`dates.ts` 兩處，有測試在守）——
 * 那個字串本來就公開寫在程式碼裡，拿它當「不能出現的個資」，
 * 等於要求專案不能寫出自己用的時區。
 *
 * 判準做在**來源**（讀 needles 的時候），不是在兩個工具各補一個例外 ——
 * 第二十四圈整圈都在講「同一件事寫在兩個地方」。
 */
{
  const dir = mkdtempSync(join(tmpdir(), 'needle-zone-'));
  mkdirSync(join(dir, 'src/config'), { recursive: true });
  mkdirSync(join(dir, 'src/lib'), { recursive: true });
  writeFileSync(
    join(dir, 'src/lib/dates.ts'),
    "const a = { timeZone: 'Asia/Taipei' };\nconst b = { timeZone: 'Asia/Taipei' };\n",
    'utf8',
  );
  writeFileSync(
    join(dir, 'src/config/identity.local.ts'),
    "export const identity = { realName: { zh: '某真名', en: 'Taipei' }, email: 'x@real.invalid' };\n",
    'utf8',
  );
  const got = readIdentityNeedles(dir);
  ok(
    !got.needles.some((n) => n.toLowerCase() === 'taipei'),
    '身分規則：跟釘住的時區同名的值不當搜尋字串',
  );
  ok(got.needles.includes('某真名'), '身分規則：其他值照樣當搜尋字串');
  ok(/沒有當成搜尋字串/.test(got.detail), '身分規則：排除掉的要說出來，不是安靜地漏掉');
  rmSync(dir, { recursive: true, force: true });
}
  ok(rule.pattern.flags.includes('i'), '身分規則：大小寫不分');

  /*
   * 值本身含引號時，寫在 JS／TS 的字串字面值裡會多一個反斜線
   * （`'O\\'Brien College'`）。那仍然是同一個值，也仍然在版控裡。
   */
  const [quoted] = identityRules(["O'Brien College"]);
  /** @param {string} text @param {boolean} want @param {string} label */
  const q = (text, want, label) => {
    quoted.pattern.lastIndex = 0;
    ok(quoted.pattern.test(text) === want, `身分規則：${label}`);
  };
  q("O'Brien College", true, '含單引號的值：原樣');
  q("const s = 'O\\'Brien College';", true, '含單引號的值：被反斜線逃脫');
  q('OBrien College', false, '含單引號的值：少了引號不算');

  console.log('  ✓ identity-value      21/21');
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
