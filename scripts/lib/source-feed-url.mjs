// @ts-check
/**
 * 一個來源的 feed 網址該怎麼組 —— 只有這裡知道。
 *
 * 為什麼要抽出來：第 4 輪（第二圈）發現 verify-sources.mjs 與 sync-feeds.mjs
 * 對同一個來源組出**不同的網址**。sync 用 source.channelId 抓得到 9 筆，
 * verify 用 source.handle 填樣板，組出
 * `…videos.xml?channel_id=FoxPoetry` 然後回報 404。
 *
 * 也就是說：專案裡唯一能動的來源，被「檢查來源還通不通」的工具報成壞的。
 * 這比壞掉更糟 —— 它會讓人去修一個不存在的問題，或者學會忽略這個工具。
 *
 * 分岔的根因是「同一件事寫在兩個地方」，所以修法是讓它只有一個地方。
 */

/**
 * @param {{ feedUrl?: string, handle?: string, channelId?: string }} source
 * @param {{ feedTemplate?: string, handleShape?: string }} platform
 * @returns {string} 組好的 feed 網址；組不出來時回空字串
 */
export function sourceFeedUrl(source, platform) {
  // 手填的最優先 —— 有些平臺的 feed 網址推導不出來，只能到個人頁複製
  const explicit = source.feedUrl?.trim();
  if (explicit) return explicit;
  if (!platform?.feedTemplate) return '';

  /*
   * 樣板裡的佔位符一律叫 {handle}，但「handle 是什麼」由平臺決定 ——
   * platform.handleShape 已經把答案寫在資料裡了，只是以前沒有人去讀它。
   * YouTube 的 handleShape 是 'channel-id'：它的 feed 端點只吃 UC 開頭的
   * 頻道 ID，@FoxPoetry 這種顯示用的帳號名填進去一定 404。
   */
  const value =
    platform.handleShape === 'channel-id' ? source.channelId?.trim() : source.handle?.trim();

  if (!value) return '';

  /*
   * ── 編碼要看 handle 的形式 ────────────────────────────
   *
   * `encodeURIComponent` 會把 `/` 與 `@` 也編掉，而 `instance-user` 那一種
   * handle（`mastodon.social/@fox`）**兩個都是結構的一部分**。
   *
   * 第 4 輪（第二十三圈）走「加一個新平臺」那條路時撞到：照平臺目錄上寫的
   * 形式填 `mastodon.social/@Mastodon`，組出來的是
   *
   *     https://mastodon.social%2F%40Mastodon.rss
   *
   * 而 `npm run verify -- --patterns` 用**同一個平臺、同一個 handle**
   * 卻好好的 —— 因為那條路走的是 `fillTemplate()`，它根本不編碼。
   * 同一件事兩條路，只在「handle 裡沒有特殊字元」的時候答案才一樣。
   * （這個檔案開頭那段講的就是同一種病，這次是它的第二個版本。）
   *
   * 修法：`instance-user` 逐段編碼，把 `/` 與 `@` 留著；其餘照舊。
   * 不改成「完全不編碼」—— handle 是設定檔裡的值，仍然該擋住奇怪的字元。
   */
  const encoded =
    platform.handleShape === 'instance-user'
      ? value.split('/').map(encodeURIComponent).join('/').replaceAll('%40', '@')
      : encodeURIComponent(value);

  return platform.feedTemplate.replaceAll('{handle}', encoded);
}
