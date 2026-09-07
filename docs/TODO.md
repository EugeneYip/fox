# 待辦

> **這一份是會被「編輯」的，不是會被「複製貼上」的。**
>
> 在第四十六圈第 3 輪之前，待辦寫在 `docs/REVIEW-LOG.md` 每一筆紀錄的
> 「上一輪與更早的都還在（⋯）」那一段裡 —— **每一輪原封不動抄一次**。
> 抄到最後是 60 條、44 行，而且沒有人回頭看它們還成不成立
> （第四十五圈整整一圈在問這件事，量出四條早就不成立）。
>
> 現在改成這一份：做完就**刪掉那一行**，發現新的就**加一行**。
> 「還成不成立」從此是 `git log docs/TODO.md` 看得到的事。

## 怎麼用

- 一輪做完，把處理掉的那幾行刪掉，新發現的加進去 —— **不要在紀錄裡再抄一份**。
- 逐輪的完整經過仍然寫進 `docs/REVIEW-LOG.md`；那裡只留「這一輪新發現的待辦」，
  不留結轉清單。
- `（→ 站主）` 是「需要 Eugene 決定或親自做的」，我做不了。

## 需要站主的

- `:focus-visible` 拿掉沒人說話
- 剩下那 6 個沒配到的屬性名
- `tags.count_one` 還是沒有證據
- `docs/PRIVACY.md` 沒有規則清單
- `note` 的 `confidence` 還是 `verified`
- `CONTENT.md` 現在 588 行
- 「雜湊資源只有 `max-age=600`」是這個主機做不到
- 排程跑的 `sync:health` 沒有 `--strict`
- 那 4 條什麼都沒擋的豁免
- `--lh-loose` 要不要接上去

## 卡住最久、而且價值最高的三件（都需要站主）

- **她自己發文那條路沒有走完過。** `npm run write` 產出 markdown，
  但從那裡到「站上看得到」中間她要自己 `git` 三次。
- **英文那一半沒有人系統地讀過。** `check:copy` 守的是寫法（全形標點、空格），
  不守「讀起來對不對」。
- **螢幕閱讀器從來沒有人測過**（`docs/A11Y.md` 自己寫著「現況：沒有人做過」）。

## 工具與檢查

- 「拿掉會怎樣」這件事本身沒有東西在守
- `nav-label` 是 warn
- 「`aria-current` 有沒有看得見的對應」沒有東西在守
- `BORDERISH` 沒有反面案例
- 中途早退的 `process.exit()` 14 處
- 沒有人在守那 21% 的緩衝區餘裕
- 「跑完測試工作樹不能變」沒有人自動驗
- 第四十五圈第 7 輪的 `ci:sim` 有一次紅得莫名
- 同時跑兩份 `test-perf-budgets` 仍然會紅
- `membersOf` 只展開一層
- `gate-count-stale` 會把散文讀成宣稱
- 為什麼不讓 `check.yml` 直接跑三行
- `unbalanced-backtick` 只掃 `scan()` 進來的東西
- `EN_COVERAGE.pct` 仍然是手寫的 100
- 文字抽取只認單引號
- `SEVERITY` 那份表跟 `STRUCTURAL_IDS` 是第二份手寫清單
- `unscanned-tracked-file` 走了第二次 `filesToScan()`
- `repoCoverage` 那一行沒有測試
- `gen-platform-docs.mjs` 沒有測試檔
- `test-verify-sources.mjs` 的 helper 只收 stdout
- 「來源檢查」那一半沒有 0 筆的總結句
- `sync-feeds.mjs` 四個策略沒有匯出（第四十六圈第 4 輪量到：其中三條
  今天**一次都不會被執行到** —— 拿掉之後 `sync` 的輸出一模一樣。
  所以「抽出去好測」的價值比原本寫的低，等真的有第二個來源再說）
- `check-handle.mjs` 不能離線跑
- **節流與重試今天都不做事**（第四十六圈第 4 輪量到）：節流拿掉 `sync`
  從 2.5 秒變 1.6 秒、輸出一模一樣；重試在第一次就成功的時候不會發生。
  一個來源、一個主機的時候本來就這樣 —— 記著是為了「哪天多了來源要回來看」
- `manifest-drift` 現在是兩件事
- `icons[]` 沒驗 `sizes`
- `git` 那 5 個指令沒人驗
- 微網誌型平臺的退路
- `CNAME` 的 content-type 是 `octet-stream`
- `--w-prose`／`--w-content` 那兩份手抄值
- `test-contrast` 把 `#faf6ee` 寫死在 fixture 裡
- `images` 還是副檔名認的
- CSS 那三條沒有被 `sawTags` 涵蓋
- 這份檔案自己的頁首也是個沒人守的數字
- 「71～108 秒」也是一個沒人守的數字
- `MEASURED` 的日期沒有東西在守
- `probe:served` 只量 5 頁而且寫死
- `check:content` 那一半還是只看 `syndication.json`
- `CHANGE_ME` 那條路連 failures 都不加
- `SCHEMA_STRUCTURAL` 3 個什麼都沒擋
- 沒有東西在守「空狀態不要自相矛盾」
- 英文那一半沒有人系統地讀過
- `box-shadow` 算不算邊
- 自訂屬性帶顏色的間接層
- 那個查法只看得到「值一字不差」的複本
- 那 59 條「元件沒算繪過」沒有人在守
- 「要跑起來才有」那 25 條這個方法看不到
- 分類判準是兩條寫死的正則
- `writing-mode` 只有一個檔案在用
- 七支關卡只有兩支有 `--list-rules`

## 更早的

第二十三圈記的三件站主決定仍然有效，見 `docs/REVIEW-LOG.md` 第二十三圈的收尾。
