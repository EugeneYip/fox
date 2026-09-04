/**
 * 平台目錄（型別層）—— 為 platforms.data.mjs 補上 TypeScript 型別與查詢工具。
 * 實際資料在 ./platforms.data.mjs，那份是前端與同步腳本共用的單一真相。
 */
import { PLATFORMS as RAW } from './platforms.data.mjs';

/**
 * 'rss'    直接有公開 RSS/Atom，最理想
 * 'hybrid' 有公開 RSS，但那個端點會間歇性掛掉，所以另外備一條 API 的路
 * 'api'    只能打官方 API（需要金鑰，放 GitHub Secrets）
 * 'bridge' 官方沒有 RSS，靠 RSSHub 之類的橋接服務轉出來（可能不穩）
 * 'manual' 完全抓不到，只能手動在 src/content/external/ 補一筆
 */
export type FeedKind = 'rss' | 'hybrid' | 'api' | 'bridge' | 'manual';
export type Region = 'global' | 'tw' | 'cn' | 'jp' | 'us';

/**
 * handle 欄位到底要填什麼。
 * 不寫清楚的話，很容易在 sources.mjs 裡把 note.com 的帳號名填成完整網址。
 *   'username'      純帳號名，例如 foxpoetry
 *   'domain'        完整網域，例如 example.com（自架 WordPress / Ghost）
 *   'instance-user' 站台加帳號，例如 mastodon.social/@fox
 *   'channel-id'    平台內部 ID，例如 YouTube 的 UCxxxx
 */
export type HandleShape = 'username' | 'domain' | 'instance-user' | 'channel-id';
export type MediaKind = 'article' | 'social' | 'video' | 'audio' | 'gallery' | 'code';

/** 這個 pattern 我實際打過嗎？誠實記錄，避免把猜測當事實。 */
export type Confidence =
  /** 本專案建置時實際 curl 過，確認回傳 feed */
  | 'verified'
  /** 平台文件或長期慣例，但本次未實測 */
  | 'documented'
  /** 需要到該平台頁面上找 RSS 圖示，複製實際網址 */
  | 'lookup-required';

export interface Platform {
  id: string;
  name: Record<'zh-TW' | 'en', string>;
  region: Region;
  media: MediaKind;
  feedKind: FeedKind;
  /** 個人頁網址樣板，{handle} 會被代換 */
  homeTemplate?: string;
  /** feed 網址樣板，{handle} 會被代換。lookup-required 的平台不給樣板 */
  feedTemplate?: string;
  /** feedKind 為 'bridge' 時，RSSHub 的路由 */
  bridgeRoute?: string;
  confidence: Confidence;
  /** handle 欄位該填什麼形式的值；沒寫就是 'username' */
  handleShape?: HandleShape;
  /**
   * 驗證用的公開帳號 —— 一個「明顯不是她、而且大家都知道」的帳號，
   * 只用來確認 feedTemplate 還有效（見 scripts/verify-sources.mjs --patterns）。
   * 不會出現在網站上，也不會被同步。
   */
  probeHandle?: string;
  /** 品牌色，用於平台標籤 */
  color: string;
  /** 備註：踩過的坑、限制、注意事項 */
  note?: string;
}

export const PLATFORMS = RAW as Platform[];

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

export function getPlatform(id: string): Platform | undefined {
  return BY_ID.get(id);
}

/** 找不到平台時給一個安全的預設值，不讓頁面爆掉 */
export function platformOrFallback(id: string): Platform {
  return (
    BY_ID.get(id) ?? {
      id,
      name: { 'zh-TW': id, en: id },
      region: 'global',
      media: 'article',
      feedKind: 'manual',
      confidence: 'documented',
      color: '#8C8578',
    }
  );
}

/** 把樣板裡的 {handle} 換掉 */
export function fillTemplate(template: string | undefined, handle: string): string | undefined {
  return template?.replaceAll('{handle}', handle);
}

/** 依媒體類型分組，給 /elsewhere 用 */
export function groupByMedia(): Map<MediaKind, Platform[]> {
  const out = new Map<MediaKind, Platform[]>();
  for (const p of PLATFORMS) {
    const list = out.get(p.media) ?? [];
    list.push(p);
    out.set(p.media, list);
  }
  return out;
}
