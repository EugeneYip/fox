#!/usr/bin/env node
// @ts-check
/**
 * 同步編排層的測試 —— `npm run test:sync-core`
 *
 * `sync-feeds.mjs` 的每一塊零件本來都有測試（剖析、正規化、節流、User-Agent），
 * **只有把它們串起來的那一層沒有**。第 4 輪（第六圈）之前，驗證方式一直是
 * 「跑一次 `npm run sync:dry` 看輸出」—— 要有網路，而且只走得到成功那條路。
 *
 * 這裡測的是失敗那條路，因為那條路上有這個站的招牌性質：
 * **平臺掛掉不影響網站**。零網路請求。
 */
import { syncSources, buildPayload, sameAndAlreadyToday } from './lib/sync-core.mjs';

const NOW = '2026-09-02T12:00:00.000Z';
const OLD = '2026-08-01T09:00:00.000Z';

const platform = /** @type {any} */ ({
  id: 'youtube',
  name: { 'zh-TW': 'YouTube', en: 'YouTube' },
  feedKind: 'hybrid',
  media: 'video',
});
const getPlatform = (/** @type {string} */ id) => (id === 'youtube' ? platform : undefined);
const source = /** @type {any} */ ({ id: 'yt', platform: 'youtube', handle: 'FoxPoetry', limit: 50 });

const item = (/** @type {string} */ id, /** @type {string} */ publishedAt) => ({
  id,
  title: `影片 ${id}`,
  url: `https://www.youtube.com/watch?v=${id}`,
  publishedAt,
  summary: '',
  tags: [],
});

/** 上一次的產出：這個來源抓到過兩筆，而且成功過 */
const previous = () => ({
  items: [
    { ...item('a', OLD), sourceId: 'yt', firstSeenAt: OLD },
    { ...item('b', OLD), sourceId: 'yt', firstSeenAt: OLD },
  ],
  sources: { yt: { status: 'ok', platform: 'youtube', itemCount: 2, lastSuccessAt: OLD, message: null } },
});

let failed = 0;
/** @param {string} name @param {boolean} ok @param {unknown} [detail] */
function check(name, ok, detail) {
  console.log(`  ${ok ? '✓' : 'X'} ${name}`);
  if (!ok) {
    failed++;
    if (detail !== undefined) console.log('      實際：', JSON.stringify(detail));
  }
}

console.log('\n同步編排層（零網路）\n' + '─'.repeat(64));

// ── 1. 正常抓到東西 ────────────────────────────────────
{
  const r = await syncSources({
    targets: [source],
    previous: previous(),
    getPlatform,
    runStrategy: async () => [item('c', '2026-09-01T00:00:00.000Z')],
    now: () => NOW,
  });
  check('成功：新項目進來、狀態記成 ok', r.added === 1 && r.failures === 0 && r.sourceStatus.yt.status === 'ok', r);
  check('成功：lastSuccessAt 更新', r.sourceStatus.yt.lastSuccessAt === NOW, r.sourceStatus.yt);
  check('成功：舊的兩筆還在', r.byId.size === 3, [...r.byId.keys()]);
}

// ── 2. 來源掛掉 —— 這一條就是「平臺掛掉不影響網站」 ──
{
  /*
   * 快取裡刻意混一筆**別的來源**的東西。
   *
   * 少了它，`kept` 算成「快取全部的筆數」跟「這個來源的筆數」得到一樣的答案，
   * 於是「itemCount 記的是還留著的筆數」那一條證明不了它在講的事
   * —— 突變掃描實際上就是這樣靜靜通過的。
   */
  const withOther = previous();
  withOther.items.push({ ...item('z', OLD), sourceId: 'other', firstSeenAt: OLD });
  const r = await syncSources({
    targets: [source],
    previous: withOther,
    getPlatform,
    runStrategy: async () => {
      throw new Error('HTTP 404（網址或帳號可能不對，重試無益）');
    },
    now: () => NOW,
  });
  check('失敗：不會把例外往外丟', true);
  check('失敗：快取原封不動（含別的來源那一筆，共 3）', r.byId.size === 3, [...r.byId.keys()]);
  check('失敗：狀態記成 error 並留下訊息', r.sourceStatus.yt.status === 'error' && /404/.test(r.sourceStatus.yt.message ?? ''), r.sourceStatus.yt);
  /*
   * 這一條最容易在重構時被弄丟：失敗時把 lastSuccessAt 覆蓋成 null，
   * 「上次成功是什麼時候」就沒了 —— 而那是判斷
   * 「暫時掛掉」還是「真的沒了」唯一的依據。
   */
  check('失敗：lastSuccessAt 沿用舊值（不能被抹掉）', r.sourceStatus.yt.lastSuccessAt === OLD, r.sourceStatus.yt);
  check('失敗：itemCount 記的是還留著的筆數', r.sourceStatus.yt.itemCount === 2, r.sourceStatus.yt);
}

// ── 3. 一個來源掛掉不該拖垮其他來源 ────────────────────
{
  const other = /** @type {any} */ ({ id: 'yt2', platform: 'youtube', handle: 'x', limit: 50 });
  const r = await syncSources({
    targets: [source, other],
    previous: previous(),
    getPlatform,
    runStrategy: async (s) => {
      if (s.id === 'yt') throw new Error('掛了');
      return [item('z', '2026-09-01T00:00:00.000Z')];
    },
    now: () => NOW,
  });
  check('第一個掛掉，第二個照樣跑完', r.failures === 1 && r.added === 1 && r.sourceStatus.yt2.status === 'ok', r);
}

// ── 4. 平臺表裡沒有這個平臺 ────────────────────────────
{
  let called = false;
  const r = await syncSources({
    targets: [/** @type {any} */ ({ id: 'x', platform: '不存在的平臺', handle: 'a' })],
    previous: { items: [], sources: {} },
    getPlatform,
    runStrategy: async () => {
      called = true;
      return [];
    },
    now: () => NOW,
  });
  check('未知平臺算失敗，而且不會去打網路', r.failures === 1 && !called, { failures: r.failures, called });
}

// ── 5. CHANGE_ME 是「還沒填」，不是錯誤 ────────────────
{
  const r = await syncSources({
    targets: [/** @type {any} */ ({ id: 'tpl', platform: 'youtube', handle: 'CHANGE_ME' })],
    previous: { items: [], sources: {} },
    getPlatform,
    runStrategy: async () => [item('q', NOW)],
    now: () => NOW,
  });
  /* 算成失敗的話，--strict 會在完全正常的狀態下紅燈 */
  check('handle 是 CHANGE_ME：略過且不算失敗', r.failures === 0 && r.added === 0, r);
}

// ── 6. limit 與「沒有 url 的項目」 ─────────────────────
{
  const r = await syncSources({
    targets: [{ ...source, limit: 2 }],
    previous: { items: [], sources: {} },
    getPlatform,
    runStrategy: async () => [
      item('1', NOW),
      { ...item('2', NOW), url: '' }, // 沒有 url 的先被濾掉，才輪到 limit
      item('3', NOW),
      item('4', NOW),
    ],
    now: () => NOW,
  });
  /*
   * 只數「兩筆」證明不了這件事：拿掉 url 過濾之後 `raw.slice(0, 2)` 也是兩筆
   * （1 與沒有網址的 2），數量一模一樣。突變掃描第一次就是這樣靜靜通過的。
   * 所以要問**是哪兩筆**。
   */
  const kept6 = [...r.byId.values()].map((/** @type {any} */ i) => i.externalId ?? i.id).sort();
  check(
    '沒有 url 的被濾掉、limit 才生效（留下 1 與 3）',
    r.added === 2 && r.byId.size === 2 && [...r.byId.values()].every((/** @type {any} */ i) => i.url),
    kept6,
  );
  /* itemCount 記的是過濾＋limit 之後的筆數，不是抓回來的原始筆數 */
  check('itemCount 記的是實際收下的筆數（2，不是 4）', r.sourceStatus.yt.itemCount === 2, r.sourceStatus.yt);
}

/*
 * ── 快取裡沒有網址的舊資料要被丟掉 ──────────────────
 *
 * 新抓回來的有 `raw.filter(i => i.url)` 擋著，快取原本沒有 ——
 * 所以第 4 輪（第十圈）那道過濾之前留下的一筆會**永遠**跟著搬。
 * 真實的快取現在 9 筆全部有網址，這條守的是還沒發生過的狀態，
 * 只能靠這裡測。
 */
{
  const stale = previous();
  stale.items.push({ ...item('bad', OLD), url: '', sourceId: 'yt', firstSeenAt: OLD });
  const r = await syncSources({
    targets: [source],
    previous: stale,
    getPlatform,
    runStrategy: async () => [item('c', NOW)],
    now: () => NOW,
  });
  check(
    '快取裡沒有網址的一筆會被丟掉（留下 a、b、c）',
    r.staleDropped === 1 && r.byId.size === 3 && [...r.byId.values()].every((/** @type {any} */ i) => i.url),
    [...r.byId.values()].map((/** @type {any} */ i) => i.url),
  );
}

// ── 7. 排序：新的在前，沒有日期的排最後 ────────────────
{
  const byId = new Map([
    ['old', { id: 'old', publishedAt: OLD }],
    ['none', { id: 'none', publishedAt: undefined }],
    ['new', { id: 'new', publishedAt: '2026-09-01T00:00:00.000Z' }],
  ]);
  const payload = buildPayload({ byId, sourceStatus: {}, now: () => NOW });
  check(
    '排序：新 → 舊 → 沒有日期',
    payload.items.map((/** @type {any} */ i) => i.id).join(',') === 'new,old,none',
    payload.items.map((/** @type {any} */ i) => i.id),
  );
  check('payload 的 itemCount 跟實際筆數一致', payload.itemCount === 3, payload.itemCount);
}

/** 這一段的斷言順序是「條件在前、說明在後」，轉接到上面的 check() */
const CHK = (/** @type {boolean} */ cond, /** @type {string} */ name) => check(name, cond);

/*
 * ── 沒有變的時候不要動檔案 ──────────────────────────
 *
 * 第 7 輪（第二十三圈）量到：跑一次真的 sync，結果是「新增 0、更新 0、
 * 來源失敗 0」，而 `git diff` 有兩行（兩個時間戳）。而 `sync-feeds.yml`
 * 那一步的守衛是 `git diff --quiet` —— 名字叫「有變動就 commit」，
 * 而這個檔案每次都會變。一天兩次、永遠。
 */
{
  const base = {
    generatedAt: '2026-09-04T01:00:00.000Z',
    itemCount: 2,
    sources: { a: { status: 'ok', itemCount: 2, lastSuccessAt: '2026-09-04T01:00:00.000Z' } },
    items: [{ id: 'x' }, { id: 'y' }],
  };
  /** @param {Partial<typeof base>} over */
  const like = (over) => ({ ...JSON.parse(JSON.stringify(base)), ...over });

  CHK(
    sameAndAlreadyToday(base, like({ generatedAt: '2026-09-04T09:00:00.000Z' })),
    '內容一樣、同一個臺北日 → 不用寫',
  );

  /*
   * 09-04T01:00Z 是臺北的 9/4 上午 9 點；09-04T17:00Z 是臺北的 **9/5** 凌晨 1 點。
   * 所以這兩個是不同的臺北日，該寫 —— 畫面上那個日期要跟著動。
   */
  CHK(
    !sameAndAlreadyToday(base, like({ generatedAt: '2026-09-04T17:00:00.000Z' })),
    '內容一樣但跨到臺北的下一天 → 要寫',
  );

  CHK(
    !sameAndAlreadyToday(base, like({ itemCount: 3, items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] })),
    '內容變了 → 要寫',
  );

  /* 來源從 ok 變成 error 也是內容變了 —— /colophon 上看得到 */
  CHK(
    !sameAndAlreadyToday(
      base,
      like({ sources: { a: { status: 'error', itemCount: 2, lastSuccessAt: base.generatedAt } } }),
    ),
    '來源狀態變了 → 要寫',
  );

  CHK(!sameAndAlreadyToday(null, base), '讀不到舊檔 → 要寫（不要猜）');

  /*
   * 反向的另一半：`lastSuccessAt` 自己變不算內容變。
   * 少了這一格，把 strip() 拿掉會讓這條規則永遠回 false —— 也就是回到舊行為，
   * 而上面那幾格全部照樣綠。
   */
  CHK(
    sameAndAlreadyToday(
      base,
      like({ sources: { a: { status: 'ok', itemCount: 2, lastSuccessAt: '2026-09-04T09:00:00.000Z' } } }),
    ),
    'lastSuccessAt 自己變不算內容變',
  );
}

console.log('─'.repeat(64));
console.log(failed === 0 ? '全部通過。\n' : `${failed} 項失敗。\n`);
process.exit(failed > 0 ? 1 : 0);
