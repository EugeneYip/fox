// @ts-check
/**
 * 一個抓回來的網頁，要留多少、標題從哪裡找。
 *
 * 兩件事共用同一份字串就會出事，所以在這裡分開：
 *
 *   head   拿去掃「找不到這個帳號」那類字樣的。**必須切短** ——
 *          SPA 的 JS 內容裡到處都是 `page not found` 這種字串，
 *          掃全文會把存在的帳號報成不存在。
 *   title  從**全文**找。切短了會抓不到。
 *
 * 第 4 輪（第二十四圈）量過 `<title>` 落在第幾個字元：
 *
 *     blogger 264　sspai 1082　x 1111　medium 3063　github 17197　youtube 755061
 *
 * 差 2800 倍。原本兩件事共用切到 6000 字的同一份，於是 YouTube 的
 * 「狐說八道 - YouTube」永遠找不到，`npm run handle FoxPoetry` 印的是
 * 「只拿到平臺通用頁，看不出帳號在不在」—— 而頁面上就寫著。
 */

/** 掃「找不到」字樣時只看開頭這麼多字 */
export const HEAD_CHARS = 6000;

/** feed 裡的標題常常是雙重跳脫（&amp;amp;），所以解兩輪 */
/** @param {string} text */
export function decodeEntities(text) {
  let out = String(text);
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
      .replace(/&#x2022;/g, '·').replace(/&nbsp;/g, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** @param {string} html */
export function titleOf(html) {
  const m = html.match(/<title[^>]*>([^<]{0,140})<\/title>/i);
  return m ? decodeEntities(m[1]) : '';
}

/**
 * 一份完整的回應本文，切成「掃字樣用的開頭」與「從全文抽出來的標題」。
 * @param {string} full
 */
export function pageParts(full) {
  return { head: full.slice(0, HEAD_CHARS), title: titleOf(full) };
}
