// courses.json を「キーの順番と数字の書き方を保ったまま」読み書きする（開発用・apply-*.mjs が共用）
//
// JS のオブジェクトは "3","2","1" のような数字キーを昇順に並べ替え、73.0 は 73 になるため、
// 標準の JSON.parse / JSON.stringify では courses.json の書式を保てない。

export function parseOrdered(text) {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i])) i += 1; };
  function value() {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i += 1; const pairs = []; ws();
      if (text[i] === '}') { i += 1; return { t: 'o', pairs }; }
      for (;;) {
        ws(); const k = JSON.parse(str()); ws();
        if (text[i] !== ':') throw new Error(`':' が無い（${i}文字目）`);
        i += 1; pairs.push([k, value()]); ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return { t: 'o', pairs }; }
        throw new Error(`オブジェクトの区切りが不正（${i}文字目）`);
      }
    }
    if (ch === '[') {
      i += 1; const items = []; ws();
      if (text[i] === ']') { i += 1; return { t: 'a', items }; }
      for (;;) {
        items.push(value()); ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return { t: 'a', items }; }
        throw new Error(`配列の区切りが不正（${i}文字目）`);
      }
    }
    if (ch === '"') return { t: 'raw', raw: str() };
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new Error(`値が読めない（${i}文字目）`);
    i += m[0].length;
    return { t: 'raw', raw: m[0] };
  }
  function str() {
    const start = i; i += 1;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return text.slice(start, i);
  }
  const v = value(); ws();
  if (i !== text.length) throw new Error('末尾に余分な文字');
  return v;
}

export function dumpNode(node, indent = 0) {
  const pad = ' '.repeat(indent + 1);
  const end = ' '.repeat(indent);
  if (node.t === 'raw') return node.raw;
  if (node.t === 'a') {
    if (!node.items.length) return '[]';
    return `[\n${node.items.map((v) => pad + dumpNode(v, indent + 1)).join(',\n')}\n${end}]`;
  }
  if (!node.pairs.length) return '{}';
  return `{\n${node.pairs.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${dumpNode(v, indent + 1)}`).join(',\n')}\n${end}}`;
}

// 普通の値 → ノード（キー順は渡した順。floatKeys に入っているキーの整数は 73.0 の形で書く）
export function toNode(v, floatKeys = new Set(), key = null) {
  if (v === null || v === undefined) return { t: 'raw', raw: 'null' };
  if (typeof v === 'number') return { t: 'raw', raw: floatKeys.has(key) && Number.isInteger(v) ? v.toFixed(1) : String(v) };
  if (typeof v === 'string' || typeof v === 'boolean') return { t: 'raw', raw: JSON.stringify(v) };
  if (Array.isArray(v)) return { t: 'a', items: v.map((x) => toNode(x, floatKeys, key)) };
  if (v instanceof Map) return { t: 'o', pairs: [...v].map(([k, x]) => [k, toNode(x, floatKeys, k)]) };
  return { t: 'o', pairs: Object.keys(v).map((k) => [k, toNode(v[k], floatKeys, k)]) };
}

export const get = (obj, key) => obj.pairs.find(([k]) => k === key)?.[1];

export function set(obj, key, node) {
  const p = obj.pairs.find(([k]) => k === key);
  if (p) p[1] = node; else obj.pairs.push([key, node]);
}

export function remove(obj, key) {
  obj.pairs = obj.pairs.filter(([k]) => k !== key);
}
