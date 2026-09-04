// @ts-check
/**
 * `npm run write` 放進新檔案裡的範本文字 —— **一份，兩邊用**。
 *
 * ## 為什麼要抽出來
 *
 * 第 3 輪（第二十三圈）把「從 `npm run write` 到站上看得到」整條走了一次，
 * 順便走了失敗的那一支：**如果她忘了把範本文字換掉呢？**
 *
 * 實測：把一首詩的原文留成「這裡放原文，一行一句」、白話留成「這裡放白話。」，
 * 然後發佈 —— **六道關卡全綠、`check:copy` 與 `check:content` 都說沒有問題**。
 * 站上就會有一首「原文」是「請在這裡放原文」的詩。
 *
 * 原因很單純：範本文字寫在 `new-entry.mjs` 裡，而檢查寫在別的檔案裡，
 * **兩個檔案不知道對方存在**。`leftover-placeholder` 那條規則只認 `CHANGE_ME`
 * （那是設定檔的佔位字串，不是內容的）。
 *
 * 所以把字串放這裡，產生的那一支跟檢查的那一支都從這裡讀 ——
 * 改了範本，檢查自動跟著改。這個 repo 對「同一件事兩個地方」踩過很多次。
 */

/** frontmatter 裡的範本文字（詩詞用） */
export const TEMPLATE_FRONTMATTER = {
  original: '這裡放原文，一行一句',
  plain: '這裡放白話。',
};

/** 正文的範本文字，依集合 */
export const TEMPLATE_BODY = {
  poems: '（想說的話寫在這裡。原文與白話在上面的 frontmatter 裡。）\n',
  notes: '（短札的正文。）\n',
  posts: '（文章的正文。）\n',
};

/**
 * 全部的範本文字，給檢查用。
 *
 * 正文那幾個把換行去掉 —— 檢查要比對的是**產出裡的字**，
 * 而算繪之後不會有那個換行。
 */
export const ALL_TEMPLATE_TEXT = [
  ...Object.values(TEMPLATE_FRONTMATTER),
  ...Object.values(TEMPLATE_BODY).map((s) => s.trim()),
];
