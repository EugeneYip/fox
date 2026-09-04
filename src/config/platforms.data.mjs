// @ts-check
// 這個檔案是平臺目錄的單一真相，前端與同步腳本都讀它。
// 開 ts-check 是因為第 7 輪發現有三個平臺各有兩個 note 欄位 ——
// JS 只會取後面那個，前面那段就成了沒人看得到的死字，而且沒有任何徵兆。
/**
 * 平台目錄（資料層）—— 純資料，沒有型別語法。
 *
 * 為什麼是 .mjs 而不是 .ts：
 * scripts/sync-feeds.mjs 要在沒有任何編譯步驟的純 Node 環境下 import 這份資料。
 * 型別由 src/config/platforms.ts 這層薄包裝補上，前端一樣有完整的 TypeScript 支援。
 * 資料只有這一份，不會出現前端與腳本各記一套的情況。
 *
 * @typedef {'rss'|'hybrid'|'api'|'bridge'|'manual'} FeedKind
 * @typedef {'global'|'tw'|'cn'|'jp'|'us'} Region
 * @typedef {'article'|'social'|'video'|'audio'|'gallery'|'code'} MediaKind
 * @typedef {'verified'|'documented'|'lookup-required'} Confidence
 * @typedef {'username'|'domain'|'instance-user'|'channel-id'} HandleShape
 *
 * @typedef {object} Platform
 * @property {string} id
 * @property {{'zh-TW': string, en: string}} name
 * @property {Region} region
 * @property {MediaKind} media
 * @property {FeedKind} feedKind
 * @property {string} [homeTemplate]
 * @property {string} [feedTemplate]
 * @property {string} [bridgeRoute]
 * @property {Confidence} confidence
 * @property {HandleShape} [handleShape]
 * @property {string} [probeHandle] 驗證用的公開帳號，見 scripts/verify-sources.mjs --patterns
 * @property {string} [probeHandle] 驗證用的公開帳號，見 scripts/verify-sources.mjs --patterns
 * @property {string} color
 * @property {string} [note]
 */

/** @type {Platform[]} */
export const PLATFORMS = [
  // ── 文章平台：有官方 RSS ────────────────────────────────
  {
    id: 'medium',
    name: { 'zh-TW': 'Medium', en: 'Medium' },
    region: 'us',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://medium.com/@{handle}',
    feedTemplate: 'https://medium.com/feed/@{handle}',
    confidence: 'verified',
    probeHandle: 'Medium',
    color: '#000000',
    note: 'feed 只有全文的前段摘要，圖片會帶 Medium 的 CDN 網址。',
  },
  {
    id: 'substack',
    name: { 'zh-TW': 'Substack', en: 'Substack' },
    region: 'us',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://{handle}.substack.com',
    feedTemplate: 'https://{handle}.substack.com/feed',
    confidence: 'verified',
    probeHandle: 'astralcodexten',
    color: '#FF6719',
  },
  {
    id: 'note',
    name: { 'zh-TW': 'note（日本）', en: 'note' },
    region: 'jp',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://note.com/{handle}',
    feedTemplate: 'https://note.com/{handle}/rss',
    confidence: 'verified',
    probeHandle: 'note_official',
    color: '#41C9B4',
    note: '日本最大的寫作平臺，中文創作者也不少。RSS 穩定。',
  },
  {
    id: 'hatena',
    name: { 'zh-TW': 'はてなブログ', en: 'Hatena Blog' },
    region: 'jp',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://{handle}.hatenablog.com',
    feedTemplate: 'https://{handle}.hatenablog.com/rss',
    confidence: 'verified',
    probeHandle: 'staff',
    color: '#00A4DE',
  },
  {
    id: 'pixnet',
    name: { 'zh-TW': '痞客邦', en: 'Pixnet' },
    region: 'tw',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://{handle}.pixnet.net/blog',
    feedTemplate: 'https://{handle}.pixnet.net/blog/rss',
    confidence: 'lookup-required',
    color: '#78C6C4',
    note:
      '2026-09-02 用四個真實部落格實測 /blog/rss，全部回 200 但內容是 HTML 不是 feed，' +
      '所以這個樣板已經失效或改版了。真的要用的話請到部落格頁面找 RSS 圖示，' +
      '把實際網址填進 sources.mjs 的 feedUrl。' +
      '另注意：痞客邦對不存在的子網域也回 200 導引頁，「打得通」不代表帳號存在。',
  },
  {
    id: 'blogger',
    name: { 'zh-TW': 'Blogger', en: 'Blogger' },
    region: 'global',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://{handle}.blogspot.com',
    feedTemplate: 'https://{handle}.blogspot.com/feeds/posts/default',
    confidence: 'verified',
    probeHandle: 'googleblog',
    color: '#FF5722',
  },
  {
    id: 'wordpress',
    handleShape: 'domain',
    name: { 'zh-TW': 'WordPress', en: 'WordPress' },
    region: 'global',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://{handle}',
    feedTemplate: 'https://{handle}/feed',
    confidence: 'verified',
    probeHandle: 'en.blog.wordpress.com',
    color: '#21759B',
    note: 'handle 直接填網域，例如 example.com。',
  },
  {
    id: 'ghost',
    handleShape: 'domain',
    name: { 'zh-TW': 'Ghost', en: 'Ghost' },
    region: 'global',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://{handle}',
    feedTemplate: 'https://{handle}/rss/',
    confidence: 'verified',
    probeHandle: 'blog.ghost.org',
    color: '#15171A',
  },

  // ── 華文平台：RSS 存在但網址要自己找 ─────────────────────
  {
    id: 'vocus',
    name: { 'zh-TW': '方格子', en: 'Vocus' },
    region: 'tw',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://vocus.cc/salon/{handle}',
    confidence: 'lookup-required',
    color: '#FFC700',
    note:
      '2026-09-02 用真實文章頁反查到 salonId / publicationId / userId，' +
      '試過 /api/rss/{user,salon,publication}/、/rss/、/{id}/rss 等八種路徑，全部 404，' +
      '頁面 HTML 裡也沒有 <link rel=alternate>。從站外推導不出來。' +
      '請登入後到個人沙龍頁找 RSS 圖示，複製實際網址填進 sources.mjs 的 feedUrl。',
  },
  {
    id: 'matters',
    name: { 'zh-TW': 'Matters', en: 'Matters' },
    region: 'tw',
    media: 'article',
    feedKind: 'rss',
    homeTemplate: 'https://matters.town/@{handle}',
    confidence: 'lookup-required',
    color: '#0F1417',
    note:
      'Matters 官方公告過「即日起支援 RSS 訂閱」，但 2026-09-02 用真實帳號試過 ' +
      '/@{handle}/feed、/rss、/rss.xml、/feed/@{handle}、/api/rss/ 等，全部 404。' +
      '推測是創作者要在後台自行開啟（可能綁 IPNS），開啟後才會有網址。' +
      '另外它的速率限制很嚴 —— 連續打幾次就開始回 429，同步時要放慢。',
  },
  {
    id: 'sspai',
    name: { 'zh-TW': '少數派', en: 'sspai' },
    region: 'cn',
    media: 'article',
    feedKind: 'bridge',
    homeTemplate: 'https://sspai.com/u/{handle}',
    bridgeRoute: '/sspai/author/{handle}',
    confidence: 'lookup-required',
    color: '#D71A1B',
  },

  // ── 社群：多半沒有官方 RSS ──────────────────────────────
  {
    id: 'threads',
    name: { 'zh-TW': 'Threads', en: 'Threads' },
    region: 'global',
    media: 'social',
    feedKind: 'bridge',
    homeTemplate: 'https://www.threads.net/@{handle}',
    bridgeRoute: '/threads/{handle}',
    confidence: 'lookup-required',
    color: '#000000',
    note: 'Meta 沒有給公開 RSS。官方 Threads API 需要 OAuth 且只能讀自己的貼文；短期建議手動挑幾則代表作放 external。',
  },
  {
    id: 'instagram',
    name: { 'zh-TW': 'Instagram', en: 'Instagram' },
    region: 'global',
    media: 'gallery',
    feedKind: 'manual',
    homeTemplate: 'https://www.instagram.com/{handle}/',
    confidence: 'documented',
    color: '#E1306C',
    note: '無公開 feed，且嵌入會追蹤訪客。本站只放連結與自存的封面圖。',
  },
  {
    id: 'x',
    name: { 'zh-TW': 'X', en: 'X' },
    region: 'global',
    media: 'social',
    feedKind: 'bridge',
    homeTemplate: 'https://x.com/{handle}',
    bridgeRoute: '/twitter/user/{handle}',
    confidence: 'lookup-required',
    color: '#000000',
  },
  {
    id: 'bluesky',
    name: { 'zh-TW': 'Bluesky', en: 'Bluesky' },
    region: 'global',
    media: 'social',
    feedKind: 'rss',
    homeTemplate: 'https://bsky.app/profile/{handle}',
    feedTemplate: 'https://bsky.app/profile/{handle}/rss',
    confidence: 'verified',
    probeHandle: 'bsky.app',
    color: '#0085FF',
    note: 'handle 用完整網域式帳號，例如 fox.bsky.social。',
  },
  {
    id: 'mastodon',
    handleShape: 'instance-user',
    name: { 'zh-TW': 'Mastodon', en: 'Mastodon' },
    region: 'global',
    media: 'social',
    feedKind: 'rss',
    homeTemplate: 'https://{handle}',
    feedTemplate: 'https://{handle}.rss',
    confidence: 'verified',
    probeHandle: 'mastodon.social/@Mastodon',
    color: '#6364FF',
    note: 'handle 填 instance/@user，例如 mastodon.social/@fox。',
  },
  {
    id: 'xiaohongshu',
    name: { 'zh-TW': '小紅書', en: 'RED / Xiaohongshu' },
    region: 'cn',
    media: 'gallery',
    feedKind: 'bridge',
    homeTemplate: 'https://www.xiaohongshu.com/user/profile/{handle}',
    bridgeRoute: '/xiaohongshu/user/{handle}/notes',
    confidence: 'lookup-required',
    color: '#FF2442',
    note: '反爬很兇，橋接常失效。建議當成 manual 用。',
  },
  {
    id: 'zhihu',
    name: { 'zh-TW': '知乎', en: 'Zhihu' },
    region: 'cn',
    media: 'article',
    feedKind: 'bridge',
    homeTemplate: 'https://www.zhihu.com/people/{handle}',
    bridgeRoute: '/zhihu/people/activities/{handle}',
    confidence: 'lookup-required',
    color: '#0084FF',
  },
  {
    id: 'douban',
    name: { 'zh-TW': '豆瓣', en: 'Douban' },
    region: 'cn',
    media: 'article',
    feedKind: 'bridge',
    homeTemplate: 'https://www.douban.com/people/{handle}/',
    bridgeRoute: '/douban/people/{handle}/status',
    confidence: 'lookup-required',
    color: '#2E963B',
    note: '讀書筆記與影評的好地方，很適合中文系。',
  },
  {
    id: 'weixin',
    name: { 'zh-TW': '微信公眾號', en: 'WeChat Official Account' },
    region: 'cn',
    media: 'article',
    feedKind: 'manual',
    confidence: 'documented',
    color: '#07C160',
    note: '封閉生態，沒有可靠的自動化方式。只能手動貼連結。',
  },

  // ── 影音 ─────────────────────────────────────────────
  {
    id: 'youtube',
    handleShape: 'channel-id',
    name: { 'zh-TW': 'YouTube', en: 'YouTube' },
    region: 'global',
    media: 'video',
    feedKind: 'hybrid',
    homeTemplate: 'https://www.youtube.com/@{handle}',
    confidence: 'verified',
    feedTemplate: 'https://www.youtube.com/feeds/videos.xml?channel_id={handle}',
    probeHandle: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    color: '#FF0000',
    note: 
      '官方 Atom feed 可用，不需要金鑰，最近 15 支。' +
      '但它會間歇性掛掉：2026-09-02 上午實測所有頻道（含 Google 自家的）都回 404，' +
      '同日中午再測就恢復 200。所以同步腳本是「先 RSS，掛了才退回 Data API v3」。' +
      'YOUTUBE_API_KEY 是選填的備援，也是想往回抓 15 支以外的歷史時才需要。',
  },
  {
    id: 'podcast',
    name: { 'zh-TW': 'Podcast', en: 'Podcast' },
    region: 'global',
    media: 'audio',
    feedKind: 'rss',
    confidence: 'documented',
    color: '#8940FA',
    note: 'Podcast 本體就是一份 RSS。直接把節目的 feed 網址填進 feedUrl 即可，不必經過 Apple 或 Spotify。',
  },

  // ── 其他 ─────────────────────────────────────────────
  {
    id: 'github',
    name: { 'zh-TW': 'GitHub', en: 'GitHub' },
    region: 'global',
    media: 'code',
    feedKind: 'rss',
    homeTemplate: 'https://github.com/{handle}',
    feedTemplate: 'https://github.com/{handle}.atom',
    confidence: 'verified',
    probeHandle: 'gaearon',
    color: '#181717',
  },
  {
    id: 'behance',
    name: { 'zh-TW': 'Behance', en: 'Behance' },
    region: 'global',
    media: 'gallery',
    feedKind: 'manual',
    homeTemplate: 'https://www.behance.net/{handle}',
    confidence: 'documented',
    color: '#1769FF',
  },
];

/** @param {string} id */
export function getPlatform(id) {
  return PLATFORMS.find((p) => p.id === id);
}

/*
 * 把樣板裡的 {handle} 換掉。
 *
 * 三個 JSDoc 區塊而不是一個：@overload 必須各自獨立成一個註解區塊，
 * 寫在同一個裡面 TypeScript 會判成「多載與實作不相容」。
 *
 * 為什麼要多載：少了它，呼叫端即使先檢查過 template 不是 undefined，
 * 拿到的還是 string | undefined，只能到處補非空斷言。
 */

/**
 * @overload
 * @param {string} template
 * @param {string} handle
 * @returns {string}
 */

/**
 * @overload
 * @param {string|undefined} template
 * @param {string} handle
 * @returns {string|undefined}
 */

/**
 * @param {string|undefined} template
 * @param {string} handle
 * @returns {string|undefined}
 */
export function fillTemplate(template, handle) {
  return template ? template.replaceAll('{handle}', handle) : undefined;
}

export default PLATFORMS;
