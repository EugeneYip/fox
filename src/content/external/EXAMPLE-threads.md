---
# ── 手動登錄外站文章的範本 ──────────────────────────────
#
# 抓不到 RSS 的平台（Instagram、微信公眾號、Behance）用這種方式登錄。
# Threads 有 RSSHub 路由，但沒設 RSSHUB_BASE 的時候也一樣要手動 —— 就像這個檔案。
# 複製這個檔案、改個檔名、把內容換掉就好。
#
# draft: true 代表這只是範本，不會出現在正式網站上。
# 真的要用的時候把 draft 拿掉或改成 false。

title: 讀《文心雕龍》讀到一半想到的事
description: 一則發在 Threads 上的短想法
lang: zh-TW
publishedAt: 2026-08-20
draft: true

platform: threads          # 必須對應 src/config/platforms.data.mjs 裡的 id
url: https://www.threads.net/@example/post/EXAMPLE

excerpt: >-
  劉勰說「操千曲而後曉聲，觀千劍而後識器」。
  意思是你得先看夠多爛的，才知道好的好在哪裡。

why: 這則討論串下面有人補了一段很好的反駁，值得留著。

tags: [文心雕龍, 文論]
---

如果想寫幾句「為什麼把這篇挑出來」，可以寫在這裡。
上面 frontmatter 的 `why` 會顯示在列表上；這裡的內文目前不會顯示，
當作自己的備忘就好。
