/**
 * JSON Schema draft-07 的**一小塊**，夠驗 `src/data/syndication.schema.json` 用。
 *
 * 為什麼自己寫而不裝 ajv：這個 repo 的執行期相依是零，
 * 而要驗的那份 schema 只用了 8 個關鍵字（見 SUPPORTED）。
 *
 * 為什麼不直接把規則寫死在檢查腳本裡：那份 schema 已經存在了
 * （`syndication.json` 的 `$schema` 指著它，編輯器也讀它）。
 * 再手寫一份「必填有哪些」就是同一件事寫在兩個地方 ——
 * 兩邊遲早會不一樣，而不一樣的時候沒有人會發現。
 *
 * **沒實作的關鍵字不會被安靜略過。** `unsupported()` 會把它們找出來，
 * 呼叫端要大聲說「這一塊我沒驗」。理由是這種驗證器最糟的失敗不是漏報，
 * 是「schema 寫了一條、驗證器看不懂、於是綠燈」—— 那個綠燈會被讀成
 * 「資料合約有人在守」，而其實那一條從來沒有執行過。
 */

/** 這支看得懂的關鍵字。其餘一律回報成「沒驗到」。 */
export const SUPPORTED = new Set([
  'type', 'required', 'properties', 'additionalProperties', 'items',
  'enum', 'minimum', 'format',
  // 純註解，不影響判斷
  '$schema', '$id', 'title', 'description', 'examples', 'default',
]);

/** `format` 這支真的會檢查的那幾種；其餘的 format 值算「沒驗到」。 */
const FORMATS = {
  uri: (/** @type {string} */ v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  },
  'date-time': (/** @type {string} */ v) => !Number.isNaN(Date.parse(v)),
};

const typeOf = (/** @type {unknown} */ v) =>
  Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;

/**
 * schema 裡有哪些這支看不懂的東西？
 * @param {unknown} schema
 * @returns {string[]} 像 `properties.items.items.patternProperties` 這樣的路徑
 */
export function unsupported(schema) {
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} node @param {string} path */
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return;
    for (const [k, v] of Object.entries(node)) {
      const here = path ? `${path}.${k}` : k;
      if (!SUPPORTED.has(k)) {
        out.push(here);
        continue;
      }
      if (k === 'format' && typeof v === 'string' && !(v in FORMATS)) out.push(`${here}=${v}`);
      if (k === 'properties' || k === 'definitions') {
        for (const [p, s] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
          walk(s, `${here}.${p}`);
        }
      } else if (k === 'type' || k === 'enum' || k === 'required') {
        /* 這幾個的值是資料不是子 schema，不要往下走 */
      } else {
        walk(v, here);
      }
    }
  };
  walk(schema, '');
  return out;
}

/**
 * 拿 schema 驗資料。
 * @param {unknown} data
 * @param {any} schema
 * @returns {{ errors: string[], nodes: number }} `nodes` 是實際判斷過幾個節點
 */
export function validate(data, schema) {
  /** @type {string[]} */
  const errors = [];
  let nodes = 0;

  /** @param {any} node @param {any} sch @param {string} path */
  const check = (node, sch, path) => {
    if (!sch || typeof sch !== 'object') return;
    nodes += 1;

    if (sch.type !== undefined) {
      const want = /** @type {string[]} */ (Array.isArray(sch.type) ? sch.type : [sch.type]);
      const got = typeOf(node);
      const ok =
        want.includes(got) ||
        (want.includes('integer') && Number.isInteger(node)) ||
        (want.includes('number') && got === 'number');
      if (!ok) {
        errors.push(`${path}：型別應該是 ${want.join(' 或 ')}，實際是 ${got}`);
        return; // 型別就錯了，再往下驗只會噴一堆衍生的錯
      }
    }

    if (sch.enum !== undefined && !sch.enum.includes(node)) {
      errors.push(`${path}：只能是 ${sch.enum.map((/** @type {unknown} */ x) => JSON.stringify(x)).join(' 或 ')}，實際是 ${JSON.stringify(node)}`);
    }

    if (typeof sch.minimum === 'number' && typeof node === 'number' && node < sch.minimum) {
      errors.push(`${path}：不能小於 ${sch.minimum}，實際是 ${node}`);
    }

    if (typeof sch.format === 'string' && typeof node === 'string') {
      const fn = FORMATS[/** @type {keyof typeof FORMATS} */ (sch.format)];
      if (fn && !fn(node)) errors.push(`${path}：不是合法的 ${sch.format} —— ${JSON.stringify(node)}`);
    }

    const isObj = node !== null && typeof node === 'object' && !Array.isArray(node);

    if (Array.isArray(sch.required) && isObj) {
      for (const k of sch.required) {
        if (!(k in node)) errors.push(`${path}：少了必填的 ${k}`);
      }
    }

    if (sch.properties && isObj) {
      for (const [k, s] of Object.entries(sch.properties)) {
        if (k in node) check(node[k], s, path ? `${path}.${k}` : k);
      }
    }

    if (sch.additionalProperties && typeof sch.additionalProperties === 'object' && isObj) {
      for (const [k, v] of Object.entries(node)) {
        if (sch.properties && k in sch.properties) continue;
        check(v, sch.additionalProperties, path ? `${path}.${k}` : k);
      }
    }

    if (sch.items && Array.isArray(node)) {
      node.forEach((v, i) => check(v, sch.items, `${path}[${i}]`));
    }
  };

  check(data, schema, '');
  return { errors, nodes };
}
