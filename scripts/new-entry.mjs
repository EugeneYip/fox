#!/usr/bin/env node
// @ts-check
/**
 * 開一篇新的內容 —— `npm run write`
 *
 * ## 為什麼有這個
 *
 * 站主 2026-09-03 要一個「Bella 自己就能發文」的介面。三條路裡選了這一條：
 * **在她自己的電腦上跑，不需要登入、不需要服務、不碰第三方**。
 * （另外兩條是 GitHub 的網頁編輯器，以及 git-based CMS —— 後者會讓
 * `/admin` 載入第三方腳本，破掉「零第三方請求」那條硬性限制。）
 *
 * 它做的事很小：問幾個問題，寫出一個 frontmatter 正確的 markdown 檔。
 * 內容仍然是檔案，`docs/ARCHITECTURE.md` 的「Markdown 檔案就是 CMS」沒有變。
 *
 * ## 三個刻意的決定
 *
 * 1. **預設 `draft: true`。** 沒有人會因為手滑而發佈。要上線是另一個動作
 *    （把那一行改掉），而那個動作她看得見。
 * 2. **slug 要她自己給。** 中文標題轉網址是猜的，而網址一旦發出去就不該改
 *    （`translationKey` 也綁在上面）。與其猜錯，不如問。
 * 3. **不覆蓋已經存在的檔案。** 這支腳本只會「開新的」。
 *
 * ## 用法
 *
 *   npm run write                    互動問答
 *   npm run write -- --collection=notes --title=… --slug=…   直接給（測試用）
 *
 * 走 npm 的話**要加 `--`**，不然 npm 會把旗標吃掉。
 */
import { writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { TEMPLATE_FRONTMATTER, TEMPLATE_BODY } from './lib/entry-template.mjs';

/*
 * `--root=<路徑>` 讓測試指到一份假的專案。
 * 第 7 輪（第二十圈）在 `ci:sim` 上學到的：根目錄寫死，就測不動。
 */
const rootArg = process.argv.find((a) => a.startsWith('--root='));
const ROOT = rootArg
  ? resolve(rootArg.slice('--root='.length))
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 三種內容，各自的資料夾與網址前綴 */
const COLLECTIONS = {
  poems: { dir: 'poems', label: '詩詞', urlBase: '/poems' },
  notes: { dir: 'notes', label: '短札', urlBase: '/notes' },
  posts: { dir: 'posts', label: '文章', urlBase: '/writing' },
};

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

/**
 * 今天，寫成 YYYY-MM-DD。
 *
 * 用**本地**時間，不用 `toISOString()` —— 那個給的是 UTC，
 * 臺灣時間晚上八點之後就會寫成明天的日期。第一次測試就撞到。
 */
const today = () => {
  const d = new Date();
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * slug 的規矩：小寫英數與連字號。
 *
 * 大小寫**一定**要壓成小寫 —— 這個 repo 在標籤與 `related` 上各踩過一次
 * 大小寫的坑（macOS 的檔案系統不分大小寫，本機看不出來）。
 * @param {string} raw
 */
const cleanSlug = (raw) =>
  raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** frontmatter 的字串值：含冒號、引號、開頭是特殊字元時要加引號 */
const yamlString = (/** @type {string} */ v) =>
  /^[\s>|&*#?%@`'"[\]{},]|[:#]\s|\s$/.test(v) ? JSON.stringify(v) : v;

/**
 * @param {{ collection: keyof typeof COLLECTIONS, title: string, slug: string,
 *   description: string, tags: string[], date: string, draft: boolean,
 *   poemAuthor?: string, poemDynasty?: string }} o
 */
function frontmatter(o) {
  const lines = [
    '---',
    `title: ${yamlString(o.title)}`,
    `description: ${yamlString(o.description)}`,
    'lang: zh-TW',
    `publishedAt: ${o.date}`,
  ];
  if (o.draft) lines.push('draft: true');
  if (o.tags.length > 0) lines.push(`tags: [${o.tags.map(yamlString).join(', ')}]`);

  if (o.collection === 'poems') {
    lines.push(
      `translationKey: ${o.slug}`,
      'vertical: true',
      'poem:',
      `  title: ${yamlString(o.title)}`,
      `  author: ${yamlString(o.poemAuthor ?? '')}`,
      ...(o.poemDynasty ? [`  dynasty: ${yamlString(o.poemDynasty)}`] : []),
      '  original: |',
      `    ${TEMPLATE_FRONTMATTER.original}`,
      'plain: >-',
      `  ${TEMPLATE_FRONTMATTER.plain}`,
    );
  }
  lines.push('---', '');
  return lines.join('\n');
}

/*
 * 範本文字放在 lib/entry-template.mjs —— `check:content` 也要讀同一份，
 * 才擋得住「忘了換掉就發佈」。理由見那個檔案。
 */
const BODY = TEMPLATE_BODY;

async function main() {
  /** 旗標齊全的話就不問 —— 測試與腳本走這一條 */
  const nonInteractive = Boolean(flag('collection') && flag('title') && flag('slug'));
  const rl = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout });

  /**
   * @param {string} question
   * @param {string} fallback
   * @param {string | undefined} fromFlag
   */
  const ask = async (question, fallback, fromFlag) => {
    if (fromFlag !== undefined) return fromFlag;
    if (!rl) return fallback;
    const answer = (await rl.question(`${question}${fallback ? `（預設 ${fallback}）` : ''}：`)).trim();
    return answer || fallback;
  };

  if (rl) {
    console.log('\n開一篇新的 —— 每一題直接按 Enter 就用預設值。\n');
  }

  const collectionRaw = await ask('要寫哪一種？poems（詩詞）／notes（短札）／posts（文章）', 'notes', flag('collection'));
  const collection = /** @type {keyof typeof COLLECTIONS} */ (collectionRaw.trim());
  if (!COLLECTIONS[collection]) {
    console.error(`\n不認得「${collectionRaw}」。只能是 poems、notes 或 posts。\n`);
    rl?.close();
    process.exit(1);
  }

  const title = (await ask('標題', '', flag('title'))).trim();
  if (!title) {
    console.error('\n標題不能空白。\n');
    rl?.close();
    process.exit(1);
  }

  const slugRaw = await ask('網址用的英文 slug（例如 jing-ye-si）', '', flag('slug'));
  const slug = cleanSlug(slugRaw);
  if (!slug) {
    console.error(
      '\nslug 不能空白，而且只能用英數與連字號。\n' +
        '  它會變成網址的一部分（例如 /poems/jing-ye-si），發出去之後就不該再改。\n',
    );
    rl?.close();
    process.exit(1);
  }

  const description = (await ask('一句話說明（列表頁與分享卡片會用）', '', flag('description'))).trim();
  const tagsRaw = await ask('標籤，用逗號分開', '', flag('tags'));
  const tags = tagsRaw
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
  const date = await ask('日期', today(), flag('date'));
  const draftRaw = await ask('先存成草稿嗎？（草稿不會出現在網站上）y／n', 'y', flag('draft'));
  const draft = !/^(n|no|false)$/i.test(draftRaw.trim());

  const poemAuthor = collection === 'poems' ? await ask('作者', '', flag('author')) : undefined;
  const poemDynasty = collection === 'poems' ? await ask('朝代', '', flag('dynasty')) : undefined;

  rl?.close();

  const dir = join(ROOT, 'src', 'content', COLLECTIONS[collection].dir);
  const file = join(dir, `${slug}.md`);

  /* 只開新的，不覆蓋 */
  const exists = await access(file).then(
    () => true,
    () => false,
  );
  if (exists) {
    console.error(`\n${file} 已經存在了。這支腳本只會開新的，不會覆蓋。\n`);
    process.exit(1);
  }

  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    frontmatter({ collection, title, slug, description, tags, date, draft, poemAuthor, poemDynasty }) +
      BODY[collection],
    'utf8',
  );

  const rel = file.slice(ROOT.length + 1);
  console.log(`\n寫好了：${rel}`);
  console.log(`網址會是：${COLLECTIONS[collection].urlBase}/${slug}`);
  if (draft) {
    console.log('現在是草稿（`draft: true`）—— 網站上還看不到。要發佈就把那一行刪掉。');
  }
  console.log('\n接下來：');
  console.log('  1. 打開那個檔案，把內容寫進去');
  console.log('  2. npm run dev      在瀏覽器上看');
  console.log('  3. npm run verify:all && npm run test:tools    兩個都綠才算好\n');
}

await main();
