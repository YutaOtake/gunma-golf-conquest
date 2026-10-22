// courses.json に「コース別の難易度」の材料（layout）を入れ、4段階の難易度（difficulty）を付け直す（開発用）
//
// 使い方：
//   node apply-layouts.mjs <調べた結果.json>   … layout を入れ替えてから難易度を付け直す
//   node apply-layouts.mjs                      … courses.json の layout から難易度だけ付け直す
//   どちらも --dry-run を付けると、書き込まずに変更点だけ表示する（--out=<パス> で別のファイルへ書く）
//
// 判定は ../rating.js だけで行う（アプリと同じ関数）。公式レート（ティの分かるもの）が無いコースは
// 元の難易度を残す。難易度・layout・legend.difficulty 以外は1文字も変えない（キーの順番・73.0 の書き方も保つ）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, LEVELS } from '../rating.js';
import { parseOrdered, dumpNode, toNode as toNodeWith, get, set } from './ordered-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COURSES = path.join(ROOT, 'courses.json');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const inputPath = args.find((a) => !a.startsWith('--'));
const outPath = (args.find((a) => a.startsWith('--out=')) || '').slice(6) || COURSES;

const TEES = new Set(['チャンピオン', 'フルバック', 'バック', 'レギュラー', 'フロント', 'レディース', '不明']);
const FLOAT_KEYS = new Set(['course_rating_back', 'gdo_upper_avg', 'cr']);
const toNode = (v) => toNodeWith(v, FLOAT_KEYS);

const original = fs.readFileSync(COURSES, 'utf8');
const tree = parseOrdered(original);
if (dumpNode(tree) !== original) {
  console.error('中止：courses.json の書式をそのまま再現できません（書式が変わった可能性）。');
  process.exit(1);
}
const data = JSON.parse(original); // 判定用（値だけ使う）
const courseNodes = get(tree, 'courses').items;
const nodeById = new Map(courseNodes.map((n) => [Number(get(n, 'id').raw), n]));

// ---------- 調べた結果の検査 ----------
function validate(item) {
  const errs = [];
  const nines = Array.isArray(item.nines) ? item.nines : [];
  const names = new Set(nines.map((n) => n.name));
  for (const n of nines) {
    if (typeof n.name !== 'string' || !n.name) errs.push('9Hの名前が空');
    if (n.par != null && !(Number.isInteger(n.par) && n.par >= 27 && n.par <= 40)) errs.push(`${n.name}：パーが範囲外 ${n.par}`);
    for (const k of ['yards_back', 'yards_reg']) {
      if (n[k] != null && !(Number.isInteger(n[k]) && n[k] >= 1500 && n[k] <= 4500)) errs.push(`${n.name}：${k} が範囲外 ${n[k]}`);
    }
    if (n.yards_back != null && n.yards_reg != null && n.yards_reg > n.yards_back) errs.push(`${n.name}：レギュラーがバックより長い`);
    for (const t of n.ratings || []) {
      if (!TEES.has(t.tee)) errs.push(`${n.name}：9Hレートのティ名が想定外「${t.tee}」`);
      if (t.cr != null && !(typeof t.cr === 'number' && t.cr >= 27 && t.cr <= 40)) errs.push(`${n.name}：9Hレートが範囲外 ${t.cr}`);
    }
  }
  if (!Array.isArray(item.rounds) || !item.rounds.length) errs.push('18Hの組み合わせが無い');
  for (const r of item.rounds || []) {
    for (const nm of r.nines || []) if (nines.length && !names.has(nm)) errs.push(`${r.name}：9H「${nm}」が nines に無い`);
    for (const t of r.ratings || []) {
      if (!TEES.has(t.tee)) errs.push(`${r.name}：ティ名が想定外「${t.tee}」`);
      if (t.cr != null && !(typeof t.cr === 'number' && t.cr >= 55 && t.cr <= 80)) errs.push(`${r.name}：レートが範囲外 ${t.cr}`);
      if (t.slope != null && !(Number.isInteger(t.slope) && t.slope >= 55 && t.slope <= 155)) errs.push(`${r.name}：スロープが範囲外 ${t.slope}`);
    }
  }
  return errs;
}

if (inputPath) {
  const items = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  const byId = new Map(data.courses.map((c) => [c.id, c]));
  let bad = 0;
  const seen = new Set();
  for (const item of items) {
    const course = byId.get(item.id);
    if (!course) { console.log(`NG  id ${item.id}：courses.json に無い`); bad += 1; continue; }
    if (seen.has(item.id)) { console.log(`NG  id ${item.id}：重複`); bad += 1; continue; }
    seen.add(item.id);
    if (item.name && item.name !== course.name) console.log(`注意 id ${item.id}：名前が違う「${item.name}」／courses.json「${course.name}」`);
    const errs = validate(item);
    if (errs.length) { console.log(`NG  id ${item.id} ${course.name}：${errs.join('／')}`); bad += 1; continue; }
    // レート1件：調査で足された呼び名（label / tee_label / tee_raw）・グリーン・対象ヤードも残す
    const rating = (t) => {
      const o = { tee: t.tee, cr: t.cr, slope: t.slope ?? null };
      const label = t.label || t.tee_label || t.tee_raw;
      if (label) o.label = label;
      if (t.green) o.green = t.green;
      if (t.yards != null) o.yards = t.yards;
      o.src = t.src || '';
      return o;
    };
    const conflicts = [...(item.conflicts || [])];
    for (const t of item.ratings_unassigned || []) {
      conflicts.push(`組み合わせが特定できないレート：${t.label || t.tee_label || t.tee} ${t.cr}${t.green ? `（${t.green}）` : ''}（${t.src || '出典不明'}）`);
    }
    const layout = {
      nines: (item.nines || []).map((n) => {
        const o = { name: n.name, par: n.par ?? null, yards_back: n.yards_back ?? null, yards_reg: n.yards_reg ?? null };
        const rs = (n.ratings || []).filter((t) => t.cr != null).map(rating);
        if (rs.length) o.ratings = rs;
        o.src = n.src || [];
        return o;
      }),
      rounds: item.rounds.map((r) => ({
        name: r.name,
        nines: r.nines || [],
        ratings: (r.ratings || []).filter((t) => t.cr != null).map(rating),
      })),
      tee_names: item.tee_names ?? null,
      conflicts,
      note: item.note || '',
    };
    course.layout = layout;
    set(nodeById.get(item.id), 'layout', toNode(layout));
  }
  const missing = data.courses.filter((c) => !seen.has(c.id)).map((c) => `${c.id} ${c.name}`);
  if (missing.length) console.log(`注意 調べた結果に無いコース ${missing.length} 件：${missing.join('、')}`);
  if (bad) {
    console.error(`中止：検査に通らない項目が ${bad} 件あります（上の NG）。直してからもう一度。`);
    process.exit(1);
  }
}

// ---------- 難易度の付け直し ----------
const changes = [];
let kept = 0;
let rated = 0;
for (const c of data.courses) {
  const an = analyze(c);
  if (an && an.level != null) {
    rated += 1;
    if (an.level !== c.difficulty) changes.push(`${c.id} ${c.name}：${c.difficulty} → ${an.level}（本来 ${an.honrai.cr.toFixed(1)}・${an.honrai.round}・${an.honrai.tee}）`);
    c.difficulty = an.level;
    set(nodeById.get(c.id), 'difficulty', toNode(an.level));
  } else {
    kept += 1;
  }
}
const range = (lv) => {
  const i = LEVELS.findIndex((l) => l.level === lv);
  const lo = LEVELS[i].min;
  const hi = i > 0 ? (LEVELS[i - 1].min - 0.1).toFixed(1) : null;
  if (lo === -Infinity) return `${hi}以下`;
  return hi ? `${lo.toFixed(1)}〜${hi}` : `${lo.toFixed(1)}以上`;
};
const legendDiff = new Map([4, 3, 2, 1].map((lv) => [String(lv), `${LEVELS.find((l) => l.level === lv).label}：本来のレート${range(lv)}`]));
legendDiff.set('note', '本来のレート＝そのゴルフ場で最も難しい18Hの組み合わせを、いちばん後ろのティ（チャンピオン／フルバック／バック）で回ったときのコースレート。公式のレート（ティの分かるもの）が見つからないコースは、旧基準（バックCR・GDO上級者平均）の4段階のまま。');
set(get(tree, 'legend'), 'difficulty', toNode(legendDiff));

// ---------- 書き出しと、変えてはいけない部分の照合 ----------
const out = dumpNode(tree);
const strip = (d) => {
  delete d.legend.difficulty;
  for (const c of d.courses) { delete c.difficulty; delete c.layout; }
  return JSON.stringify(d);
};
if (strip(JSON.parse(original)) !== strip(JSON.parse(out))) {
  console.error('中止：難易度・layout・legend.difficulty 以外のフィールドが変わっています。');
  process.exit(1);
}
const check = JSON.parse(out);
for (const c of check.courses) {
  const an = analyze(c);
  if (an && an.level != null && an.level !== c.difficulty) {
    console.error(`中止：書き出し後の難易度が判定と合いません（id ${c.id}）。`);
    process.exit(1);
  }
}

console.log(`公式レートで判定 ${rated} 件／旧基準のまま ${kept} 件／難易度が変わる ${changes.length} 件`);
for (const line of changes) console.log(`  ${line}`);
if (dryRun) {
  console.log('（--dry-run：書き込みはしていません）');
} else {
  fs.writeFileSync(outPath, out);
  console.log(`${path.basename(outPath)} を書き込みました（${Buffer.byteLength(out)} バイト）`);
}
