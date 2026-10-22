// courses.json に「曲がっても安心度」の材料（じゃらんの統計と口コミ＝jalan）を入れる（開発用）
//
// 使い方：
//   node apply-jalan.mjs <調べた結果.json> --period=2024年10月〜2026年9月 --as-of=2026-10-22
//   --dry-run を付けると、書き込まずに結果だけ表示する（--out=<パス> で別のファイルへ書く）
//
// 調べた結果.json は配列。1件＝{ id, name, jalan_url, fairway_wide, reviews,
//   ob_rate_100_119_pct, fw_keep_100_119_pct, ob_rate_pct, fw_keep_pct }（値が無ければ null）。
// 値が1つも無いコースは jalan を外す（アプリには「じゃらんの統計なし」と出る）。結果に無いコースは触らない。
// 判定は ../rating.js の forgivingOf だけ（アプリと同じ関数）。jalan・legend.jalan 以外は1文字も変えない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgivingOf, compareForgiving, FORGIVING } from '../rating.js';
import { parseOrdered, dumpNode, toNode, get, set, remove } from './ordered-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COURSES = path.join(ROOT, 'courses.json');
const args = process.argv.slice(2);
const opt = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const dryRun = args.includes('--dry-run');
const inputPath = args.find((a) => !a.startsWith('--'));
const outPath = opt('out') || COURSES;
const period = opt('period');
const asOf = opt('as-of');
if (!inputPath || !period || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error('使い方：node apply-jalan.mjs <調べた結果.json> --period=<じゃらんの集計期間> --as-of=<取得日 YYYY-MM-DD> [--dry-run]');
  process.exit(1);
}

const PCT_KEYS = ['ob_rate_100_119_pct', 'fw_keep_100_119_pct', 'ob_rate_pct', 'fw_keep_pct'];
const FLOAT_KEYS = new Set(['fairway_wide', ...PCT_KEYS]);

const original = fs.readFileSync(COURSES, 'utf8');
const tree = parseOrdered(original);
if (dumpNode(tree) !== original) {
  console.error('中止：courses.json の書式をそのまま再現できません（書式が変わった可能性）。');
  process.exit(1);
}
const data = JSON.parse(original);
const byId = new Map(data.courses.map((c) => [c.id, c]));
const nodeById = new Map(get(tree, 'courses').items.map((n) => [Number(get(n, 'id').raw), n]));

function validate(x) {
  const errs = [];
  if (x.jalan_url != null && !/^https:\/\/golf-jalan\.net\/gc\d{5}\/$/.test(x.jalan_url)) errs.push(`URL が想定外「${x.jalan_url}」`);
  if (x.fairway_wide != null && !(typeof x.fairway_wide === 'number' && x.fairway_wide >= 1 && x.fairway_wide <= 5)) errs.push(`広さが範囲外 ${x.fairway_wide}`);
  if (x.reviews != null && !(Number.isInteger(x.reviews) && x.reviews >= 0)) errs.push(`口コミ件数が不正 ${x.reviews}`);
  for (const k of PCT_KEYS) if (x[k] != null && !(typeof x[k] === 'number' && x[k] >= 0 && x[k] <= 100)) errs.push(`${k} が範囲外 ${x[k]}`);
  return errs;
}

const items = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
const seen = new Set();
let bad = 0;
const dropped = [];
for (const x of items) {
  const c = byId.get(x.id);
  if (!c) { console.log(`NG  id ${x.id}：courses.json に無い`); bad += 1; continue; }
  if (seen.has(x.id)) { console.log(`NG  id ${x.id}：重複`); bad += 1; continue; }
  seen.add(x.id);
  if (x.name && x.name !== c.name) console.log(`注意 id ${x.id}：名前が違う「${x.name}」／courses.json「${c.name}」`);
  const errs = validate(x);
  if (errs.length) { console.log(`NG  id ${x.id} ${c.name}：${errs.join('／')}`); bad += 1; continue; }
  const jalan = {
    url: x.jalan_url ?? null,
    fairway_wide: x.fairway_wide ?? null,
    reviews: x.reviews ?? null,
    ob_rate_100_119_pct: x.ob_rate_100_119_pct ?? null,
    fw_keep_100_119_pct: x.fw_keep_100_119_pct ?? null,
    ob_rate_pct: x.ob_rate_pct ?? null,
    fw_keep_pct: x.fw_keep_pct ?? null,
  };
  const node = nodeById.get(x.id);
  if (Object.entries(jalan).every(([k, v]) => k === 'url' || v == null)) {
    delete c.jalan;
    remove(node, 'jalan');
    dropped.push(`${c.id} ${c.name}`);
  } else {
    c.jalan = jalan;
    set(node, 'jalan', toNode(jalan, FLOAT_KEYS));
  }
}
const missing = data.courses.filter((c) => !seen.has(c.id)).map((c) => `${c.id} ${c.name}`);
if (missing.length) console.log(`注意 調べた結果に無いコース ${missing.length} 件（触らない）：${missing.join('、')}`);
if (bad) {
  console.error(`中止：検査に通らない項目が ${bad} 件あります（上の NG）。直してからもう一度。`);
  process.exit(1);
}

const n = FORGIVING.national;
set(get(tree, 'legend'), 'jalan', toNode(
  `じゃらんゴルフの各コースのページ（${asOf}取得）。OB率・FWキープ率はスコア統計の「100〜119で回る人」の区分（集計期間 ${period}、同じ区分の全国平均はOB率${n.ob}%・FWキープ率${n.fw}%）。フェアウェイの広さは口コミの5段階評価の平均。0.0%の表示はデータ不足、FWキープ率52.7%はデータ不足時の仮の値とみて判定に使わない。`,
));

const out = dumpNode(tree);
const strip = (d) => {
  delete d.legend.jalan;
  for (const c of d.courses) delete c.jalan;
  return JSON.stringify(d);
};
if (strip(JSON.parse(original)) !== strip(JSON.parse(out))) {
  console.error('中止：jalan・legend.jalan 以外のフィールドが変わっています。');
  process.exit(1);
}

const check = JSON.parse(out).courses;
const rated = check.map((c) => [c, forgivingOf(c)]).filter(([, f]) => f).sort(([a, fa], [b, fb]) => compareForgiving(fa, fb) || a.id - b.id);
const dist = [3, 2, 1, 0].map((h) => `${h}/3＝${rated.filter(([, f]) => f.hits === h).length}`).join('・');
console.log(`統計あり ${rated.length} 件（${dist}）／統計なし ${check.length - rated.length} 件`);
if (dropped.length) console.log(`  値が1つも無いため jalan を外した：${dropped.join('、')}`);
console.log('  安心な順の上位：');
for (const [c, f] of rated.slice(0, 10)) {
  console.log(`    ${f.hits}/3 ${c.name}（OB ${f.ob ?? '—'}%・FWキープ ${f.fw ?? '—'}%・広さ ${f.wide ?? '—'}${f.reviews != null ? `／${f.reviews}件` : ''}）`);
}
if (dryRun) {
  console.log('（--dry-run：書き込みはしていません）');
} else {
  fs.writeFileSync(outPath, out);
  console.log(`${path.basename(outPath)} を書き込みました（${Buffer.byteLength(out)} バイト）`);
}
