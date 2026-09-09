/** 日期格式化 —— 中文用「2026年9月2日」，英文用 Sep 2, 2026。 */
import { localeTag } from '@i18n/utils';
import type { Locale } from '@config/site';

export function formatDate(input: Date | string | number, locale: Locale = 'zh-TW'): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(localeTag(locale), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Taipei',
  }).format(d);
}

/**
 * `<time datetime>` 用的 ISO 日期（只到日，不洩漏精確時刻）。
 *
 * **也釘在臺北時間** —— 跟 `formatDate()`、`year()` 一樣。
 *
 * 2026-09-09 之前這一支用的是 `toISOString()`，也就是 UTC，而它每一個
 * 呼叫端都是這樣寫的：`<time datetime={isoDate(x)}>{formatDate(x)}</time>`
 * —— 同一個值，兩支函式，兩個時區。
 *
 * 平常看不出來，因為內容的 `publishedAt` 都只寫到日（會被當成 UTC 午夜，
 * 加八小時還是同一天）。但 `/elsewhere` 上那幾支 YouTube 影片是**帶時刻的**，
 * 於是那一頁當時就有兩處自相矛盾：
 *
 *   <time datetime="2024-10-21">2024年10月22日</time>   ←〈山行〉
 *   <time datetime="2024-10-16">2024年10月17日</time>   ←〈月夜憶舍弟〉
 *
 * 螢幕上寫 22 日，機器讀到的是 21 日。九筆裡錯兩筆 —— 錯的正好是
 * 臺北時間已經跨日、UTC 還沒跨的那兩筆。
 *
 * 站主 2026-09-09 決定詩頁的日期要跟外站的發佈時刻一致之後，
 * 內容那一邊也開始帶時刻了，這個洞會從一頁擴散到全站。
 */
export function isoDate(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  /* `en-CA` 給的就是 YYYY-MM-DD，不必自己拼 */
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * 年份 —— **以臺北時間為準**。
 *
 * ## 為什麼不能用 `getFullYear()`
 *
 * `publishedAt: 2026-01-01` 這種只有日期的字串，`new Date()` 會當成
 * **UTC 的午夜**。而 `getFullYear()` 讀的是「執行這段程式的機器」的時區 ——
 * 在美東那是前一年的 12 月 31 日晚上七點。
 *
 * 第 3 輪（第二十二圈）實測：放一篇 `publishedAt: 2026-01-01` 的內容，
 * 同一份原始碼建三次 ——
 *
 *   TZ=Asia/Taipei　　→  彙整頁只有一個年份標題「2026」
 *   TZ=UTC　　　　　　→  「2026」
 *   TZ=America/New_York → 「2026」與「**2025**」
 *
 * 而站主的機器就是美東。也就是說**這個站現在建出來的彙整頁，
 * 元旦那天的文章會被歸到前一年**，而它下面顯示的日期還是「1月1日」——
 * 標題 2025、內容 1月1日，同一個畫面上自相矛盾。
 * （CI 是 UTC，所以本機建的跟 CI 建的會不一樣。）
 *
 * 同一個檔案裡的 `formatDate()` 早就把時區釘成 `Asia/Taipei` 了，
 * 這一支沒有 —— 一個刻意、一個沒有，而兩個給的是同一件事的答案。
 */
export function year(input: Date | string | number): number {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return 0;
  /* `en-CA` 給的是 YYYY-MM-DD，取前四碼最穩 —— 不必解析在地化的年份字樣 */
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric' }).format(d),
  );
}

/**
 * 估閱讀時間。中文按每分鐘 350 字，英文按 220 字 —— 中文字資訊密度高，
 * 用同一個數字會嚴重高估。
 */
export function readingMinutes(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const words = text.replace(/[㐀-鿿豈-﫿]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(cjk / 350 + words / 220));
}
