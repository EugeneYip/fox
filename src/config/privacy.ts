/**
 * 隱私設定 —— 整站唯一的「個資閘門」。
 *
 * ⚠️ 這個 repo 是公開的。所以這裡只放**開關**，不放**值**。
 *
 * 這個區別很重要。如果本名寫在這個檔案裡，就算 showRealName 是 false、
 * 網站上一個字都不顯示，任何人到 GitHub 上都讀得到 —— 那道閘門等於沒關。
 *
 * 真實的值放在 src/config/identity.local.ts，那個檔案在 .gitignore 裡，
 * 不會被推上去。沒有它的時候 reveal() 一律回傳 undefined，網站照常建置，
 * 只是顯示筆名而已。
 *
 * 設計原則：預設全部關閉。任何一則真實個資要出現在公開網站上，
 * 都必須有人明確把它打開，而不是「忘了關」就流出去。
 */

/** 地點揭露的粒度 */
export type LocationGranularity = 'none' | 'country' | 'region' | 'city';

export interface PrivacyConfig {
  /** 公開顯示本名。關閉時一律只用筆名「狐狸 / Fox」 */
  showRealName: boolean;
  /** 公開顯示學歷（校名、科系） */
  showEducation: boolean;
  /** 公開顯示年份區間 —— 年份可反推年齡，預設關 */
  showTimelineYears: boolean;
  /** 地點揭露到哪一層。'country' = 只說「臺灣」 */
  showLocation: LocationGranularity;
  /** 是否在頁面上放可點擊的 email */
  showEmail: boolean;
  /**
   * 是否顯示生日之類的識別性資訊。
   *
   * ⚠ **這一個目前沒有接到任何東西。** `Identity` 裡沒有生日這個欄位，
   * `reveal()` 也沒有對應的 key —— 把它改成 `true` **不會有任何效果**。
   * 留著是因為它記錄了一個決定（「不放生日」），但別把它當成閘門：
   * 真的有人把生日硬寫進頁面時，擋住他的是 `audit:privacy` 的身分規則，
   * 不是這一行。（第 5 輪〔第九圈〕量出來的。）
   */
  showBirthday: boolean;
  /**
   * 是否公開她與站主的關係。
   *
   * ⚠ 同上 —— **沒有接到任何東西**，改成 `true` 不會有效果。
   */
  showRelationship: boolean;

  /** 分析工具。'none' = 完全不載入任何第三方追蹤 */
  analytics: 'none';
  /**
   * 是否允許直接嵌入第三方 iframe（YouTube、Threads…）。
   * false = 一律用「點擊才載入」的預覽卡，避免使用者一進站就被第三方記錄 IP。
   *
   * ⚠ **翻成 `true` 的建置過不了關卡。** 第 5 輪（第十一圈）實際翻過去建了一次：
   * `audit:privacy` 當場報 `built-third-party-request`（「零第三方請求是硬性
   * 限制⋯⋯影片一律用 VideoFacade」），必須修正 1。
   *
   * 也就是說這個開關有三個地方在讀（隱私頁、關於本站、詩詞頁），
   * 但**任何能部署的建置裡它一定是 `false`** —— 它記錄的是一個決定，
   * 不是一個真的可以選的選項。要真的打開得先改掉那條稽核規則，
   * 而那條規則守的正是站主每一輪都會重申的硬性限制。
   */
  allowThirdPartyEmbeds: boolean;
  /**
   * 是否允許連到第三方 CDN 取字型（false = 只用系統字型，零外部請求）。
   *
   * ⚠ **沒有程式碼讀這一行。** 「零外部字型」這件事實際上是由兩個東西守的：
   * `tokens.css` 只寫系統字型堆疊，以及 `audit:privacy` 的 `google-fonts` 規則。
   * 把它改成 `true` 不會讓任何字型被載入 —— 要載入得自己去改 CSS，
   * 而那時稽核會擋下來。
   */
  allowRemoteFonts: boolean;

  /** 搜尋引擎索引策略 */
  indexing: 'allow' | 'noindex';
  /** 是否讓 AI 訓練爬蟲抓取（寫進 robots.txt） */
  allowAiCrawlers: boolean;
  /** 對外連結是否加上 rel="noreferrer" */
  strictReferrerPolicy: boolean;
  /**
   * 建置時是否清掉圖片 EXIF（GPS、機型、拍攝時間）。
   *
   * ⚠ **沒有程式碼讀這一行。** EXIF 實際上是被 Astro 的圖片管線清掉的 ——
   * 它會把圖重新編碼成 WebP，中繼資料在那一步就沒了（第 3 輪〔第八圈〕
   * 為了跑 `coverAlt` 放了一張圖，產出確實是 `.webp`）。
   * 也就是說結果是對的，但**不是這個開關造成的**；改成 `false` 也不會保留 EXIF。
   */
  stripImageExif: boolean;
}

/**
 * 目前**沒有接到任何東西**的開關。
 *
 * 上面每一個的註解都寫了它為什麼沒接、以及真正在守那件事的是誰。
 * 這份清單存在的理由是讓那件事**可以被檢查**：`audit:privacy` 會兩個方向都核對
 * ——名單裡的開關必須真的沒有人讀，名單外的開關必須真的有人讀。
 *
 * 為什麼不讓稽核直接讀註解：第 5 輪（第十五圈）試過，四個開關的註解用了
 * 兩種寫法（「沒有接到任何東西」與「沒有程式碼讀這一行」），
 * 依字串比對的版本把後兩個誤報成「沒有註記」。措辭會漂，清單不會。
 *
 * `keyof PrivacyConfig` 讓打錯的名字在 `npm run check` 就被擋下來。
 */
export const UNWIRED_SWITCHES: readonly (keyof PrivacyConfig)[] = [
  'showBirthday',
  'showRelationship',
  'allowRemoteFonts',
  'stripImageExif',
];

export const privacy: PrivacyConfig = {
  // ── 身分 ──────────────────────────────────────────────
  showRealName: false,
  showEducation: false,
  showTimelineYears: false,
  showLocation: 'country',
  showEmail: false,
  showBirthday: false,
  showRelationship: false,

  // ── 追蹤與第三方 ──────────────────────────────────────
  analytics: 'none',
  allowThirdPartyEmbeds: false,
  allowRemoteFonts: false,

  // ── 爬蟲與外連 ────────────────────────────────────────
  indexing: 'allow',
  allowAiCrawlers: false,
  strictReferrerPolicy: true,
  stripImageExif: true,
};

// ─────────────────────────────────────────────────────────
// 受保護的值
// ─────────────────────────────────────────────────────────

type Lang = 'zh' | 'en';

export interface Identity {
  realName?: Partial<Record<Lang, string>>;
  education?: Partial<
    Record<Lang, { school: string; dept: string; degree: string; years: string }>
  >;
  location?: Partial<Record<LocationGranularity, Partial<Record<Lang, string>>>>;
  email?: string;
}

/**
 * 用 import.meta.glob 去「試著」載入本機檔案。
 *
 * 直接 import 一個不存在的檔案會讓建置失敗；glob 找不到就回空物件，
 * 所以這個檔案可有可無 —— CI 上沒有它，網站一樣 build 得起來。
 */
const localModules = import.meta.glob<{ identity?: Identity }>('./identity.local.ts', {
  eager: true,
});

const identity: Identity = Object.values(localModules)[0]?.identity ?? {};

/** 這台機器上有沒有本機身分檔（給 /colophon 之類的地方判斷用） */
export const hasLocalIdentity = Object.keys(localModules).length > 0;

export type GuardedKey = 'realName' | 'education' | 'location' | 'email';

/**
 * 取用受保護資料的唯一入口。
 *
 * 兩道關卡都要過：privacy 的開關要開，而且 identity.local.ts 裡要真的有值。
 * 任何一個不成立就回 undefined，呼叫端必須自己處理「沒有值」的情況。
 *
 * @example
 * const name = reveal('realName', 'zh') ?? site.penName['zh-TW'];
 */
export function reveal(key: GuardedKey, lang: Lang = 'zh'): unknown | undefined {
  switch (key) {
    case 'realName':
      return privacy.showRealName ? identity.realName?.[lang] : undefined;
    case 'education':
      return privacy.showEducation ? identity.education?.[lang] : undefined;
    case 'location':
      return privacy.showLocation === 'none'
        ? undefined
        : identity.location?.[privacy.showLocation]?.[lang];
    case 'email':
      return privacy.showEmail ? identity.email : undefined;
    default:
      return undefined;
  }
}

/** 對外連結該用的 rel 屬性 */
export const externalLinkRel = privacy.strictReferrerPolicy
  ? 'noopener noreferrer'
  : 'noopener';
