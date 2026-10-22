// コース別の難易度と「曲がっても安心度」の判定（アプリと dev/ の道具がこのファイルだけを読む）
//
// courses.json の各コースの layout（調べた事実）から、次を計算する：
//   - 18Hの組み合わせごとに採用するレート：
//       同じティに出典の違う値があれば、出典の信頼度（公式 ＞ 楽天GORA ＞ じゃらん ＞ ShotNavi ＞ PLUS ＞ GDO）で選ぶ。
//       検索結果の要約にしか出てこない値（src が「検索要約のみ」）は採用しない。
//       2グリーンのコースは、グリーンごとに選んでから難しい方を採る。
//   - 本来の難易度：最も難しい組み合わせを、いちばん後ろのティ（チャンピオン／フルバック ＞ バック）で回ったときのレート
//   - 9ホール別のレート：
//       公式の9H別レートがある → それを使う（白水GC・赤城CCの公式表で、18Hのレート＝前後9Hの和を確認済み）
//       27H で3通りのレートが同じティでそろっている → 逆算した「計算値」（18Hのレート＝前後9Hの和として）
//       それ以外 → その9Hを含む18Hのレートを、ヤード差で前後に振り分けた「推定値」（220ヤード≒1打）
//   - 4段階の難易度（本来のレートで決める。ティの分かる公式値が無いコースは決めない＝null）
//
// 副作用なし・ブラウザでも Node でも動く純粋な関数だけを置く。

export const YARDS_PER_STROKE = 220;

// 4段階のしきい値（本来のレート＝最難の組み合わせ×いちばん後ろのティ）
export const LEVELS = [
  { level: 4, min: 73.0, label: '難関' },
  { level: 3, min: 72.0, label: '手強い' },
  { level: 2, min: 70.5, label: '標準' },
  { level: 1, min: -Infinity, label: 'やさしめ' },
];

export function levelOf(cr) {
  if (typeof cr !== 'number' || !Number.isFinite(cr)) return null;
  return LEVELS.find((l) => cr >= l.min).level;
}

// ティの前後（大きいほど後ろ）
const TEE_DEPTH = { 'チャンピオン': 3, 'フルバック': 3, 'バック': 2, 'レギュラー': 1, 'フロント': 0, 'レディース': -1, '不明': null };
const BACK_TEES = ['チャンピオン', 'フルバック', 'バック'];

// 出典の種類（予約・会員権サイト以外は、そのゴルフ場・運営会社の公式とみなす）
const THIRD_PARTY = [
  ['booking.gora.golf.rakuten.co.jp', 1, '楽天GORA'],
  ['golf-jalan.net', 2, 'じゃらん'],
  ['shotnavi.jp', 3, 'ShotNavi'],
  ['plus-web.co.jp', 4, 'PLUS'],
  ['golfdigest.co.jp', 5, 'GDO'],
];
export function sourceInfo(src) {
  const s = String(src || '');
  if (s.startsWith('検索要約')) return { rank: 9, name: '検索要約', verified: false };
  const m = /https?:\/\/[^\s)）]+/.exec(s);
  if (!m) return { rank: 8, name: '出典不明', verified: true };
  let host = '';
  try { host = new URL(m[0]).hostname; } catch { return { rank: 8, name: '出典不明', verified: true }; }
  for (const [h, rank, name] of THIRD_PARTY) {
    if (host === h || host.endsWith(`.${h}`)) return { rank, name, verified: true };
  }
  return { rank: 0, name: '公式', verified: true };
}

const round1 = (x) => Math.round(x * 10) / 10;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function withSource(r) {
  return { ...r, source: sourceInfo(r.src) };
}

// 指定したティの中から1つ選ぶ：グリーンごとに（後ろのティ → 信頼できる出典 → 大きい値）で選び、グリーン間では大きい方
function choose(ratings, tees) {
  const cands = ratings.filter((r) => tees.includes(r.tee) && isNum(r.cr) && r.source.verified);
  if (!cands.length) return null;
  const byGreen = new Map();
  for (const r of cands) {
    const g = r.green || '';
    if (!byGreen.has(g)) byGreen.set(g, []);
    byGreen.get(g).push(r);
  }
  let best = null;
  for (const list of byGreen.values()) {
    list.sort((a, b) => (TEE_DEPTH[b.tee] ?? -9) - (TEE_DEPTH[a.tee] ?? -9) || a.source.rank - b.source.rank || b.cr - a.cr);
    if (!best || list[0].cr > best.cr) best = list[0];
  }
  return best;
}

function sumYards(nines, names, key) {
  let total = 0;
  for (const n of names) {
    const nine = nines.find((x) => x.name === n);
    if (!nine || !isNum(nine[key])) return null;
    total += nine[key];
  }
  return total;
}

// 1コース分の分析。layout が無ければ null
export function analyze(course) {
  const lay = course && course.layout;
  if (!lay || !Array.isArray(lay.rounds)) return null;
  const nines = Array.isArray(lay.nines) ? lay.nines : [];

  const rounds = lay.rounds.map((r) => {
    const all = (r.ratings || []).filter((t) => isNum(t.cr)).map(withSource);
    return {
      name: r.name,
      nines: r.nines || [],
      all,
      back: choose(all, BACK_TEES),
      reg: choose(all, ['レギュラー']),
      unknown: choose(all, ['不明']),
      yardsBack: sumYards(nines, r.nines || [], 'yards_back'),
      yardsReg: sumYards(nines, r.nines || [], 'yards_reg'),
    };
  });

  // 本来の難易度：採用したバック系のレートの最大。無ければティ不明の値を「参考」として使う
  let honrai = null;
  for (const r of rounds) {
    if (r.back && (!honrai || r.back.cr > honrai.cr)) {
      honrai = { cr: r.back.cr, tee: r.back.tee, green: r.back.green || null, round: r.name, source: r.back.source.name, basis: 'tee' };
    }
  }
  if (!honrai) {
    for (const r of rounds) {
      if (r.unknown && (!honrai || r.unknown.cr > honrai.cr)) {
        honrai = { cr: r.unknown.cr, tee: '不明', green: r.unknown.green || null, round: r.name, source: r.unknown.source.name, basis: 'tee-unknown' };
      }
    }
  }
  // レギュラーティの補足：本来と同じ組み合わせのレギュラー（無ければレギュラーの最大）
  let regular = null;
  if (honrai) {
    const same = rounds.find((r) => r.name === honrai.round && r.reg);
    if (same) regular = { cr: same.reg.cr, round: same.name, source: same.reg.source.name };
  }
  if (!regular) {
    for (const r of rounds) {
      if (r.reg && (!regular || r.reg.cr > regular.cr)) regular = { cr: r.reg.cr, round: r.name, source: r.reg.source.name };
    }
  }

  return {
    rounds,
    nines: nineRatings(nines, rounds, honrai?.green || ''),
    honrai,
    regular,
    level: honrai && honrai.basis === 'tee' ? levelOf(honrai.cr) : null,
  };
}

// 9ホール別のレート（その組み合わせで採用したレートのティ）
function nineRatings(nines, rounds, prefGreen) {
  const out = nines.map((n) => ({ ...n, cr: null, slope: null, basis: null, tee: null }));

  // 公式の9H別レートがあれば最優先（本来のレートと同じグリーンを選ぶ）
  for (const n of out) {
    const all = (n.ratings || []).filter((t) => isNum(t.cr)).map(withSource);
    const pool = prefGreen && all.some((t) => (t.green || '') === prefGreen) ? all.filter((t) => (t.green || '') === prefGreen) : all;
    const best = choose(pool, BACK_TEES);
    if (best) {
      n.cr = best.cr;
      n.slope = best.slope ?? null;
      n.basis = best.source.rank === 0 ? 'official' : 'published';
      n.tee = best.tee;
    }
  }
  if (out.length && out.every((n) => n.basis)) return out;
  for (const n of out) { n.cr = null; n.slope = null; n.basis = null; n.tee = null; }

  // 27H：3つの9Hと、それぞれを組み合わせた3通りのレートが同じティでそろっていれば逆算する
  if (out.length === 3) {
    for (const key of ['back', 'unknown']) {
      const pairs = rounds.filter((r) => r.nines.length === 2 && r[key]);
      if (pairs.length !== 3) continue;
      const tee = pairs[0][key].tee;
      const green = pairs[0][key].green || '';
      const same = pairs.every((r) => r[key].tee === tee && (r[key].green || '') === green);
      const covers = out.every((n) => pairs.filter((r) => r.nines.includes(n.name)).length === 2);
      if (!same || !covers) continue;
      const total = pairs.reduce((s, r) => s + r[key].cr, 0) / 2;
      for (const n of out) {
        const without = pairs.find((r) => !r.nines.includes(n.name));
        n.cr = round1(total - without[key].cr);
        n.basis = 'calc';
        n.tee = tee;
      }
      return out;
    }
  }

  // それ以外：その9Hを含む18Hのレートを、ヤード差で前後に振り分ける（複数あれば平均）
  for (const n of out) {
    const ests = [];
    for (const r of rounds) {
      const base = r.back || r.unknown;
      if (!base || !r.nines.includes(n.name) || r.nines.length !== 2) continue;
      if (!isNum(n.yards_back) || !isNum(r.yardsBack)) continue;
      ests.push({ cr: base.cr / 2 + (n.yards_back - r.yardsBack / 2) / YARDS_PER_STROKE, tee: base.tee });
    }
    if (ests.length) {
      n.cr = round1(ests.reduce((s, e) => s + e.cr, 0) / ests.length);
      n.basis = 'estimate';
      n.tee = ests[0].tee;
    }
  }
  return out;
}

// ---------- 曲がっても安心度（じゃらんの統計と口コミ） ----------
// courses.json の各コースの jalan（調べた事実）から、曲がる人でもスコアを崩しにくいかを3つの条件で見る。
// 統計はじゃらんの「100〜119で回る人」の区分。全国平均（同じ区分）と比べる：
//   1. OB率が全国平均（2.2%）の半分以下（1.0%以下）＝曲がってもOBになりにくい
//   2. 口コミ「フェアウェイが広い」の平均が4.0以上（口コミ30件以上のときだけ判定に使う）
//   3. FWキープ率が全国平均（50.3%）以上
// じゃらんが 0.0% と出す値はデータ不足、FWキープ率 52.7% はデータ不足時の仮の値とみて、どちらも「不明」にする。
export const FORGIVING = {
  national: { ob: 2.2, fw: 50.3 },
  obMax: 1.0,
  wideMin: 4.0,
  reviewsMin: 30,
  fwMin: 50.3,
  suspectFw: 52.7,
};

export function forgivingOf(course) {
  const j = course && course.jalan;
  if (!j) return null;
  const pct = (v) => (isNum(v) && v > 0 ? v : null);
  const ob = pct(j.ob_rate_100_119_pct);
  const fwRaw = pct(j.fw_keep_100_119_pct);
  const fwSuspect = fwRaw === FORGIVING.suspectFw;
  const fw = fwSuspect ? null : fwRaw;
  const wide = isNum(j.fairway_wide) ? j.fairway_wide : null;
  const reviews = Number.isInteger(j.reviews) ? j.reviews : null;
  if (ob == null && fw == null && wide == null) return null;
  const fewReviews = wide != null && (reviews ?? 0) < FORGIVING.reviewsMin;
  const conds = [
    { key: 'ob', ok: ob != null && ob <= FORGIVING.obMax, known: ob != null },
    { key: 'wide', ok: wide != null && !fewReviews && wide >= FORGIVING.wideMin, known: wide != null && !fewReviews },
    { key: 'fw', ok: fw != null && fw >= FORGIVING.fwMin, known: fw != null },
  ];
  return { ob, fw, fwSuspect, wide, reviews, fewReviews, conds, hits: conds.filter((c) => c.ok).length, url: j.url || null };
}

// 安心な順：満たす条件の数 → OB率（低い順）→ FWキープ率（高い順）→ 広さ（高い順）。不明は各段で後ろ
export function compareForgiving(a, b) {
  const nl = (x, y, dir) => (x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : dir * (x - y));
  return b.hits - a.hits || nl(a.ob, b.ob, 1) || nl(a.fw, b.fw, -1) || nl(a.wide, b.wide, -1);
}
