/**
 * robots.txt —— 內容由 src/config/privacy.ts 決定，所以是動態產生的。
 * 想擋掉 AI 訓練爬蟲，把 privacy.allowAiCrawlers 設成 false 就好。
 */
import type { APIRoute } from 'astro';
import { site } from '@config/site';
import { privacy } from '@config/privacy';

/*
 * ── 兩種 AI 爬蟲，兩種待遇 ──────────────────────────
 *
 * 這份清單原本混在一起全部擋掉。2026-09-03 站主決定分開：
 *
 *   **訓練**：把內容收進模型。這裡的文章是一個字一個字寫出來的，
 *             不提供作為訓練語料 —— 繼續擋。
 *   **檢索**：有人問 AI 關於這首詩，AI 去抓這一頁、然後**引用它**。
 *             那跟搜尋引擎是同一件事，擋掉等於讓她的站在 AI 的答案裡消失。
 *
 * 兩者用的是不同的 user-agent，所以分得開。之前沒分，
 * 於是「不給訓練」順手把「不給引用」也一起做了 —— 那不是同一個決定。
 */

/** 拿內容去訓練模型的 —— 擋 */
const TRAINING_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'Google-Extended',
  'Applebot-Extended',
  'Bytespider',
  'Amazonbot',
  'CCBot',
  'meta-externalagent',
  'Diffbot',
  'cohere-ai',
  'Timpibot',
  'Omgilibot',
];

/**
 * 檢索與引用用的 —— 放行。
 *
 * 這幾個只是「使用者現在問到了，去把那一頁讀回來」或
 * 「建立可被引用的索引」，不進訓練集。清單同樣會過時。
 */
const RETRIEVAL_CRAWLERS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
];

export const GET: APIRoute = () => {
  const lines: string[] = [];

  if (privacy.indexing === 'noindex') {
    lines.push('# 整站不希望被索引', 'User-agent: *', 'Disallow: /');
  } else {
    lines.push(
      'User-agent: *',
      'Allow: /',
      '',
      '# 搜尋頁沒有內容，不用浪費配額',
      'Disallow: /search',
      'Disallow: /*/search',
      '',
      '# 這是給站內搜尋用的索引檔，不是給人讀的頁面。',
      '# 它一個檔案就包含全站的內文摘要，被當成搜尋結果收錄只會是雜訊。',
      'Disallow: /search-index.json',
    );
  }

  if (!privacy.allowAiCrawlers) {
    lines.push(
      '',
      '# 這裡的文章是一個字一個字寫出來的，不提供作為訓練語料。',
      '# 下面擋的是訓練爬蟲；檢索／引用的爬蟲另外放行（見再下面）。',
    );
    for (const bot of TRAINING_CRAWLERS) {
      lines.push('', `User-agent: ${bot}`, 'Disallow: /');
    }

    lines.push(
      '',
      '# 這幾個是「有人問到了，去把那一頁讀回來並引用」用的，不是訓練。',
      '# 擋掉的話，別人問 AI 關於這裡的詩，答案裡不會有這個站。',
    );
    for (const bot of RETRIEVAL_CRAWLERS) {
      lines.push('', `User-agent: ${bot}`, 'Allow: /', 'Disallow: /search', 'Disallow: /search-index.json');
    }
  }

  lines.push('', `Sitemap: ${new URL('/sitemap-index.xml', site.url).toString()}`);

  return new Response(lines.join('\n') + '\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
