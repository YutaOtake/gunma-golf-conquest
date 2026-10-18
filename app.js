// 群馬ゴルフ 全制覇トラッカー（ビルド不要の vanilla JS）
// データ源：courses.json（読むだけ・書き換えない）／記録：IndexedDB（この端末の中だけ）
import * as db from './db.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const WIDE = matchMedia('(min-width: 720px)');
const LS_UI = 'ggc.ui.v1';
const LS_DRAFT = 'ggc.draft.v1';
const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
const BACKUP_FORMAT = 'gunma-golf-conquest-backup';
const VIEWS = ['home', 'list', 'guide', 'settings'];

const SORTS = {
  area: 'エリア順',
  hard: '難しい順',
  elev: '標高順（高い順）',
  easy: 'やさしい順',
  name: '名前順（読み）',
};
const STATUS = { all: 'すべて', unplayed: '未プレー', played: 'プレー済' };

const state = {
  data: null,
  courses: [],
  byId: new Map(),
  yomi: {},
  hay: new Map(),
  rounds: [],
  roundsByCourse: new Map(),
  lastExport: null,
  persisted: undefined,
  view: 'home',
  selectedId: null,
  detailOpen: false,
  filters: { areas: [], cool: [], diff: [], status: 'all' },
  sort: 'area',
  q: '',
  dbError: null,
};

// ---------- 小道具 ----------
function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても動く */ }
}
function lsDel(key) {
  try { localStorage.removeItem(key); } catch { /* 同上 */ }
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const pad = (n) => String(n).padStart(2, '0');
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(s) {
  if (!isValidDate(s)) return String(s ?? '');
  const [y, m, d] = s.split('-').map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}/${pad(m)}/${pad(d)}（${w}）`;
}
function fmtDateShort(s) {
  return isValidDate(s) ? s.replaceAll('-', '/') : String(s ?? '');
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('ja-JP'));

// 検索用：全角半角・カタカナひらがな・大文字小文字・空白の違いを吸収
function norm(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '');
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-shown'), 2600);
}

// ---------- 凡例（courses.json の legend から読む） ----------
function coolSymbol(c) {
  const s = state.data?.legend?.cool?.[String(c)];
  return s ? s.trim().split(/\s/)[0] : '?';
}
function coolShort(c) {
  const s = state.data?.legend?.cool?.[String(c)];
  if (!s) return String(c);
  return s.trim().replace(/（.*?）/g, '');
}
function diffLabel(d) {
  const s = state.data?.legend?.difficulty?.[String(d)];
  return s ? s.split('：')[0] : String(d);
}
const areaName = (i) => state.data?.areas?.[i] ?? `エリア${i}`;
const yomiOf = (c) => state.yomi[c.name] || c.name;

// ---------- 達磨 ----------
function darumaSVG({ complete = false, painting = false, label = '' } = {}) {
  const pupil2 = complete
    ? `<circle class="d-pupil-2${painting ? ' is-painting' : ''}" cx="38" cy="41" r="5.6" fill="#1a1a1a"/>`
    : '';
  const aria = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg class="daruma" viewBox="0 0 100 100" ${aria}>
    <path d="M50 6 C75 6 90 26 90 52 C90 78 73 94 50 94 C27 94 10 78 10 52 C10 26 25 6 50 6 Z" fill="#d32f2f"/>
    <ellipse cx="30" cy="27" rx="6" ry="11" transform="rotate(-30 30 27)" fill="#ffffff" opacity=".22"/>
    <path d="M30 76 Q50 87 70 76" fill="none" stroke="#f2c14e" stroke-width="4" stroke-linecap="round"/>
    <path d="M38 84 Q50 90 62 84" fill="none" stroke="#f2c14e" stroke-width="3" stroke-linecap="round"/>
    <path d="M50 20 C66 20 76 30 76 44 C76 58 65 66 50 66 C35 66 24 58 24 44 C24 30 34 20 50 20 Z" fill="#fdf3e1"/>
    <path d="M29 31 Q38 23 46 30" fill="none" stroke="#1a1a1a" stroke-width="4.5" stroke-linecap="round"/>
    <path d="M54 30 Q62 23 71 31" fill="none" stroke="#1a1a1a" stroke-width="4.5" stroke-linecap="round"/>
    <circle cx="38" cy="41" r="8" fill="#ffffff" stroke="#1a1a1a" stroke-width="1.6"/>
    <circle cx="62" cy="41" r="8" fill="#ffffff" stroke="#1a1a1a" stroke-width="1.6"/>
    <circle cx="62" cy="41" r="5.6" fill="#1a1a1a"/>
    ${pupil2}
    <path d="M36 57 Q43 51 50 56 Q57 51 64 57" fill="none" stroke="#1a1a1a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M27 50 Q29 56 35 60" fill="none" stroke="#5a4a3a" stroke-width="2" stroke-linecap="round"/>
    <path d="M73 50 Q71 56 65 60" fill="none" stroke="#5a4a3a" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}
const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const BACK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---------- 記録の集計 ----------
function byDateDesc(a, b) {
  return b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at));
}
function rebuildIndex() {
  const m = new Map();
  for (const r of state.rounds) {
    if (!m.has(r.course_id)) m.set(r.course_id, []);
    m.get(r.course_id).push(r);
  }
  for (const list of m.values()) list.sort(byDateDesc);
  state.roundsByCourse = m;
}
function summary(courseId) {
  const list = state.roundsByCourse.get(courseId);
  if (!list || !list.length) return null;
  let first = list[0].date;
  let best = null;
  for (const r of list) {
    if (r.date < first) first = r.date;
    if (r.score != null && (best == null || r.score < best)) best = r.score;
  }
  return { count: list.length, first, best, last: list[0].date };
}
const isPlayed = (id) => state.roundsByCourse.has(id);
function progress() {
  const total = state.courses.length;
  const played = state.courses.filter((c) => isPlayed(c.id)).length;
  const kogen = state.courses.filter((c) => c.cool === 3);
  const nankan = state.courses.filter((c) => c.difficulty === 4);
  let best = null;
  for (const r of state.rounds) {
    if (r.score != null && state.byId.has(r.course_id) && (best == null || r.score < best.score)) best = r;
  }
  return {
    total,
    played,
    complete: total > 0 && played === total,
    kogen: { total: kogen.length, played: kogen.filter((c) => isPlayed(c.id)).length },
    nankan: { total: nankan.length, played: nankan.filter((c) => isPlayed(c.id)).length },
    rounds: state.rounds.filter((r) => state.byId.has(r.course_id)).length,
    best,
  };
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function setBars(root) {
  for (const el of $$('.progress-fill', root)) el.style.width = `${el.dataset.pct}%`;
}

// ---------- 絞り込み・並び替え ----------
function haystack(c) {
  if (!state.hay.has(c.id)) {
    state.hay.set(c.id, norm([c.name, yomiOf(c), c.city, c.type, c.feature, c.memo, areaName(c.area)].join(' ')));
  }
  return state.hay.get(c.id);
}
const collator = new Intl.Collator('ja');
function nullLast(a, b, dir) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir * (a - b);
}
const SORT_FN = {
  area: (a, b) => a.area - b.area || a.id - b.id,
  hard: (a, b) => b.difficulty - a.difficulty
    || nullLast(a.course_rating_back, b.course_rating_back, -1)
    || nullLast(a.gdo_upper_avg, b.gdo_upper_avg, -1) || a.id - b.id,
  easy: (a, b) => a.difficulty - b.difficulty
    || nullLast(a.gdo_upper_avg, b.gdo_upper_avg, 1)
    || nullLast(a.course_rating_back, b.course_rating_back, 1) || a.id - b.id,
  elev: (a, b) => nullLast(a.elevation_m, b.elevation_m, -1) || a.id - b.id,
  name: (a, b) => collator.compare(yomiOf(a), yomiOf(b)) || a.id - b.id,
};
function filteredCourses() {
  const { areas, cool, diff, status } = state.filters;
  const terms = String(state.q).normalize('NFKC').split(/\s+/).map(norm).filter(Boolean);
  const list = state.courses.filter((c) => {
    if (areas.length && !areas.includes(c.area)) return false;
    if (cool.length && !cool.includes(c.cool)) return false;
    if (diff.length && !diff.includes(c.difficulty)) return false;
    if (status === 'played' && !isPlayed(c.id)) return false;
    if (status === 'unplayed' && isPlayed(c.id)) return false;
    if (terms.length) {
      const h = haystack(c);
      if (!terms.every((t) => h.includes(t))) return false;
    }
    return true;
  });
  return list.sort(SORT_FN[state.sort] || SORT_FN.area);
}
function activeFilterCount() {
  const f = state.filters;
  return (f.areas.length ? 1 : 0) + (f.cool.length ? 1 : 0) + (f.diff.length ? 1 : 0) + (f.status !== 'all' ? 1 : 0);
}

// ---------- 画面の状態（ハッシュ・保存） ----------
function saveUI() {
  lsSet(LS_UI, {
    view: state.view,
    selectedId: state.selectedId,
    filters: state.filters,
    sort: state.sort,
    q: state.q,
  });
}
function restoreUI() {
  const ui = lsGet(LS_UI, null);
  if (!ui) return;
  if (VIEWS.includes(ui.view)) state.view = ui.view;
  if (state.byId.has(ui.selectedId)) state.selectedId = ui.selectedId;
  if (ui.filters) {
    const ints = (a) => (Array.isArray(a) ? a.map(Number).filter(Number.isInteger) : []);
    state.filters = {
      areas: ints(ui.filters.areas),
      cool: ints(ui.filters.cool),
      diff: ints(ui.filters.diff),
      status: STATUS[ui.filters.status] ? ui.filters.status : 'all',
    };
  }
  if (SORTS[ui.sort]) state.sort = ui.sort;
  if (typeof ui.q === 'string') state.q = ui.q;
}
function parseHash() {
  const m = /^#(home|list|guide|settings)(?:\/c(\d+))?$/.exec(location.hash);
  if (!m) return null;
  return { view: m[1], id: m[2] ? Number(m[2]) : null };
}
function hashFor() {
  if (state.view === 'list' && state.detailOpen && state.selectedId) return `#list/c${state.selectedId}`;
  return `#${state.view}`;
}

// ---------- 描画 ----------
function renderAll() {
  renderHeader();
  renderHome();
  renderList();
  renderDetail();
  renderGuide();
  renderSettings();
  applyView();
}

function renderHeader() {
  const p = progress();
  $('#appbar-count').innerHTML = `<span class="visually-hidden">達成 </span>${p.played} / ${p.total}`;
  $('#brand-daruma').innerHTML = darumaSVG({ complete: p.complete });
}

function applyView() {
  const app = $('#app');
  app.dataset.view = state.view;
  app.dataset.detail = state.detailOpen && state.selectedId ? 'open' : 'closed';
  for (const t of $$('.tab')) {
    if (t.dataset.view === state.view) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  }
}

function renderHome() {
  const p = progress();
  const root = $('#view-home');
  const areaRows = (state.data?.areas || []).map((name, i) => {
    const inArea = state.courses.filter((c) => c.area === i);
    const done = inArea.filter((c) => isPlayed(c.id)).length;
    return `<li class="area-row">
      <span>${esc(name)}</span><span class="n">${done} / ${inArea.length}</span>
      <span class="progress small" aria-hidden="true"><span class="progress-fill" data-pct="${pct(done, inArea.length)}"></span></span>
    </li>`;
  }).join('');

  const recent = state.rounds
    .filter((r) => state.byId.has(r.course_id))
    .sort(byDateDesc)
    .slice(0, 5)
    .map((r) => `<li><button type="button" class="recent-btn" data-open-course="${r.course_id}">
        <span class="d">${esc(fmtDate(r.date))}</span>
        <span>${esc(state.byId.get(r.course_id).name)}</span>
        <span class="s">${r.score ?? '—'}</span>
      </button></li>`).join('');

  const changed = changesSinceExport();
  const needBackup = state.rounds.length > 0 && (!state.lastExport || changed >= 3);
  const bestCourse = p.best ? state.byId.get(p.best.course_id)?.name : '';
  const heroLabel = p.complete ? '全制覇。達磨に両目が入っています' : '願掛けの片目が入った達磨。全制覇でもう片方の目が入ります';

  root.innerHTML = `<div class="page">
    <section class="card hero" aria-label="全制覇の進み具合">
      <div class="hero-art">${darumaSVG({ complete: p.complete, label: heroLabel })}</div>
      <div>
        <p class="hero-label">達成</p>
        <p class="hero-count"><strong>${p.played}</strong> / ${p.total} コース</p>
        <div class="progress" role="progressbar" aria-label="達成率" aria-valuemin="0" aria-valuemax="${p.total}" aria-valuenow="${p.played}" aria-valuetext="${p.played} / ${p.total} コース">
          <span class="progress-fill" data-pct="${pct(p.played, p.total)}"></span>
        </div>
        <p class="hero-sub">${p.complete ? '全制覇！ 両目が入りました' : `あと ${p.total - p.played} コース（${pct(p.played, p.total)}%）`}</p>
      </div>
    </section>
    <div class="stat-grid">
      <section class="card stat"><h3>高原◎コース</h3>
        <p class="stat-num">${p.kogen.played}<span> / ${p.kogen.total}</span></p>
        <p class="muted">標高1,000m以上</p>
        <span class="progress small" aria-hidden="true"><span class="progress-fill" data-pct="${pct(p.kogen.played, p.kogen.total)}"></span></span>
      </section>
      <section class="card stat"><h3>難関コース</h3>
        <p class="stat-num">${p.nankan.played}<span> / ${p.nankan.total}</span></p>
        <p class="muted">${esc(diffLabel(4))}（4段階の最上位）</p>
        <span class="progress small" aria-hidden="true"><span class="progress-fill" data-pct="${pct(p.nankan.played, p.nankan.total)}"></span></span>
      </section>
      <section class="card stat"><h3>ラウンド数</h3>
        <p class="stat-num">${p.rounds}<span> 回</span></p>
      </section>
      <section class="card stat"><h3>ベストスコア</h3>
        <p class="stat-num">${p.best ? p.best.score : '—'}</p>
        <p class="muted">${esc(bestCourse || '記録なし')}</p>
      </section>
    </div>
    ${needBackup ? `<section class="card"><p class="note-warn">${state.lastExport ? `前回の書き出しから ${changed} 件の記録が増えています。` : 'まだバックアップを書き出していません。'}アンインストールすると記録は消えるので、設定画面から書き出しておきましょう。</p>
      <button type="button" class="btn btn-secondary" data-goto="settings">設定（バックアップ）へ</button></section>` : ''}
    <div class="home-grid">
      <section class="card"><h3>エリア別</h3><ul class="area-rows">${areaRows}</ul></section>
      <section class="card"><h3>最近のラウンド</h3>
        ${recent ? `<ul class="recent">${recent}</ul>` : '<p class="muted">まだ記録がありません。「一覧」でコースを選び、ラウンドを記録すると、ここに並びます。</p>'}
        <p><button type="button" class="btn btn-primary" data-goto="list">コース一覧へ</button></p>
      </section>
    </div>
  </div>`;
  setBars(root);
}

function cardHTML(c) {
  const s = summary(c.id);
  const current = c.id === state.selectedId ? ' aria-current="true"' : '';
  const played = s
    ? `<span class="cc-played"><span>初回 ${esc(fmtDateShort(s.first))}</span>${s.best != null ? `<span>ベスト ${s.best}</span>` : ''}${s.count > 1 ? `<span>${s.count}回</span>` : ''}</span>`
    : '';
  return `<li><button type="button" class="course-card${s ? ' is-played' : ''}" data-id="${c.id}"${current}>
    <span class="cc-status" aria-hidden="true">${s ? CHECK_SVG : ''}</span>
    <span class="cc-main">
      <span class="cc-name">${esc(c.name)}</span>
      <span class="cc-meta">${esc(c.city)} ・ ${c.holes}H ・ ${esc(c.type)}</span>
      ${played}
      <span class="visually-hidden">${s ? 'プレー済' : '未プレー'}</span>
    </span>
    <span class="cc-badges">
      <span class="badge-cool cool-${c.cool}">${esc(coolSymbol(c.cool))} ${fmtNum(c.elevation_m)}m</span>
      <span class="badge-diff diff-${c.difficulty}">${esc(diffLabel(c.difficulty))}</span>
    </span>
  </button></li>`;
}

function renderList() {
  const list = filteredCourses();
  const root = $('#course-list');
  let html = '';
  if (!list.length) {
    html = `<div class="empty"><p>条件に合うコースがありません。</p>
      <button type="button" class="btn btn-secondary" data-action="reset-filters">絞り込みと検索をリセット</button></div>`;
  } else if (state.sort === 'area') {
    const groups = new Map();
    for (const c of list) {
      if (!groups.has(c.area)) groups.set(c.area, []);
      groups.get(c.area).push(c);
    }
    for (const [area, items] of groups) {
      const all = state.courses.filter((c) => c.area === area);
      const done = all.filter((c) => isPlayed(c.id)).length;
      html += `<section class="area-group" aria-label="${esc(areaName(area))}">
        <h3 class="area-head"><span>${esc(areaName(area))}</span><span class="muted">達成 ${done} / ${all.length}</span></h3>
        <ul>${items.map(cardHTML).join('')}</ul></section>`;
    }
  } else {
    html = `<ul>${list.map(cardHTML).join('')}</ul>`;
  }
  root.innerHTML = html;

  const n = activeFilterCount();
  const parts = [`${list.length} / ${state.courses.length} コース`, SORTS[state.sort]];
  if (n) parts.push(`絞り込み ${n}件`);
  $('#list-summary').innerHTML = `<span>${esc(parts.join(' ・ '))}</span>${
    n || state.q ? '<button type="button" class="link-btn" data-action="reset-filters">条件をリセット</button>' : ''}`;
  const badge = $('#filter-badge');
  badge.hidden = !n;
  badge.textContent = n ? String(n) : '';
  if ($('#q').value !== state.q) $('#q').value = state.q;
  $('#q-clear').hidden = !state.q;
  updateFilterDone(list.length);
}

function renderDetail() {
  const root = $('#detail');
  const c = state.byId.get(state.selectedId);
  if (!c) {
    delete root.dataset.courseId;
    root.innerHTML = `<div class="detail-empty">${darumaSVG()}<p>一覧からコースを選ぶと、ここに詳しい情報と記録が出ます。</p></div>`;
    return;
  }
  // 同じコースを描き直すとき（記録の保存後など）はスクロール位置を保つ
  const keepScroll = root.dataset.courseId === String(c.id) ? ($('.detail-scroll', root)?.scrollTop ?? 0) : 0;
  root.dataset.courseId = String(c.id);
  const s = summary(c.id);
  const rounds = state.roundsByCourse.get(c.id) || [];
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name)}`;
  const cr = c.course_rating_back == null ? '<small>未取得</small>' : Number(c.course_rating_back).toFixed(1);
  const gdo = c.gdo_upper_avg == null ? '<small>未取得</small>' : Number(c.gdo_upper_avg).toFixed(1);
  const status = s
    ? `<p class="status-pill is-played"><span>✓ プレー済</span><span>初回 ${esc(fmtDate(s.first))}</span><span>ベスト ${s.best ?? '—'}</span><span>${s.count}回</span></p>`
    : '<p class="status-pill"><span>未プレー</span></p>';
  const roundItems = rounds.map((r) => `<li class="round-item">
      <span><span class="round-date">${esc(fmtDate(r.date))}</span>　<span class="round-score">${r.score != null ? `${r.score}` : 'スコアなし'}</span>
      ${r.memo ? `<span class="round-memo">${esc(r.memo)}</span>` : ''}</span>
      <button type="button" class="btn btn-secondary" data-edit-round="${esc(r.id)}" aria-label="${esc(fmtDate(r.date))} の記録を編集">編集</button>
    </li>`).join('');

  root.innerHTML = `
    <div class="detail-head">
      <button type="button" class="icon-btn back-btn" data-action="close-detail" aria-label="一覧に戻る">${BACK_SVG}</button>
      <h2 tabindex="-1" id="detail-title">${esc(c.name)}</h2>
    </div>
    <div class="detail-scroll">
      <p class="detail-sub">${esc(areaName(c.area))} ・ ${esc(c.city)}</p>
      ${status}
      <dl class="facts">
        <div><dt>標高</dt><dd>${fmtNum(c.elevation_m)}m <small>（概算）</small><br><span class="badge-cool cool-${c.cool}">${esc(coolShort(c.cool))}</span></dd></div>
        <div><dt>ホール数</dt><dd>${c.holes}ホール</dd></div>
        <div><dt>タイプ</dt><dd>${esc(c.type)}</dd></div>
        <div><dt>アクセス</dt><dd>${esc(c.access)}</dd></div>
        <div><dt>難易度</dt><dd><span class="badge-diff diff-${c.difficulty}">${esc(diffLabel(c.difficulty))}</span> <small>${c.difficulty} / 4</small></dd></div>
        <div><dt>バックCR</dt><dd>${cr}</dd></div>
        <div><dt>GDO上級者平均</dt><dd>${gdo}</dd></div>
      </dl>
      <section class="detail-section"><h3>特徴</h3><p>${esc(c.feature)}</p></section>
      ${c.memo ? `<section class="detail-section"><h3>メモ</h3><p>${esc(c.memo)}</p></section>` : ''}
      <div class="link-row">
        ${c.url
          ? `<a class="btn btn-secondary" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">公式サイト</a>`
          : '<span class="no-link">公式サイトの登録なし</span>'}
        <a class="btn btn-secondary" href="${esc(maps)}" target="_blank" rel="noopener noreferrer">Googleマップでルート</a>
      </div>
      <section class="detail-section rounds"><h3>ラウンド記録（${rounds.length}）</h3>
        ${rounds.length ? `<ul>${roundItems}</ul>` : '<p class="muted">まだ記録がありません。</p>'}
      </section>
    </div>
    <div class="detail-actions">
      <button type="button" class="btn btn-primary" data-action="add-round-here">＋ このコースのラウンドを記録</button>
    </div>`;
  if (keepScroll) $('.detail-scroll', root).scrollTop = keepScroll;
}

function renderGuide() {
  const d = state.data;
  if (!d) return;
  const lg = d.legend || {};
  const coolItems = ['3', '2', '1', '0'].filter((k) => lg.cool?.[k]).map((k) => {
    const text = lg.cool[k];
    return `<li><span class="badge-cool cool-${k}">${esc(coolSymbol(k))}</span><span>${esc(text)}</span></li>`;
  }).join('');
  const diffItems = ['4', '3', '2', '1'].filter((k) => lg.difficulty?.[k]).map((k) => {
    const text = lg.difficulty[k];
    return `<li><span class="badge-diff diff-${k}">${esc(diffLabel(k))}</span><span>${esc(text)}</span></li>`;
  }).join('');
  const extra = (d.extra_not_counted || []).map((e) =>
    `<li>${esc(e.name)}（${esc(e.city)}）— ${esc(e.note)}</li>`).join('');
  const closed = (d.closed_excluded || []).map((s) => `<li>${esc(s)}</li>`).join('');
  $('#view-guide').innerHTML = `<div class="page">
    <h2 class="page-title">見方</h2>
    <section class="card"><h3>${esc(d.title)}</h3>
      <dl class="kv">
        <dt>対象</dt><dd>${esc(d.scope)}</dd>
        <dt>時点</dt><dd>${esc(d.as_of)}</dd>
        <dt>コース数</dt><dd>${state.courses.length}コース（${(d.areas || []).length}エリア）</dd>
      </dl>
      <p>1回でもラウンドを記録したコースが「プレー済」になり、全コースがプレー済になると全制覇です。一覧には初回プレー日とベストスコアが出ます。</p>
    </section>
    <section class="card"><h3>涼しさ（標高）</h3><ul class="legend-list">${coolItems}</ul></section>
    <section class="card"><h3>難易度（4段階）</h3><ul class="legend-list">${diffItems}</ul></section>
    <section class="card"><h3>数字の出どころと注意</h3>
      <dl class="kv">
        <dt>バックCR</dt><dd>${esc(lg.course_rating_back)}</dd>
        <dt>GDO上級者平均</dt><dd>${esc(lg.gdo_upper_avg)}</dd>
        <dt>標高</dt><dd>${esc(lg.elevation_m)}</dd>
      </dl>
    </section>
    <section class="card"><h3>全制覇に数えないコース</h3>
      ${extra ? `<ul class="plain-list">${extra}</ul>` : '<p class="muted">なし</p>'}
    </section>
    <section class="card"><h3>閉鎖のため対象外のコース（${(d.closed_excluded || []).length}）</h3>
      ${closed ? `<ul class="plain-list">${closed}</ul>` : '<p class="muted">なし</p>'}
    </section>
  </div>`;
}

function changesSinceExport() {
  if (!state.lastExport) return state.rounds.length;
  return state.rounds.filter((r) => String(r.updated_at) > state.lastExport).length;
}

function renderSettings() {
  const n = state.rounds.length;
  $('#backup-status').textContent = state.lastExport
    ? `前回の書き出し：${fmtDateTime(state.lastExport)}（その後に追加・編集した記録 ${changesSinceExport()} 件）／現在の記録 ${n} 件`
    : `まだ書き出していません／現在の記録 ${n} 件`;

  let persistText = 'このブラウザでは確認できません。';
  if (state.persisted === true) persistText = '消えにくい保存（永続化）が許可されています。端末の空き容量が少なくなっても、ブラウザが勝手に記録を消すことはありません（アンインストールでは消えます）。';
  else if (state.persisted === false) persistText = 'まだ許可されていません。空き容量が少ないとブラウザが記録を消す場合があります。ホーム画面にインストールすると許可されやすくなります。';
  if (state.dbError) persistText = `記録の保存先が使えません：${state.dbError}`;
  $('#persist-status').textContent = persistText;
  $('#persist-btn').hidden = state.persisted === true || state.persisted === undefined;

  const orphans = state.rounds.filter((r) => !state.byId.has(r.course_id));
  const orphanEl = $('#orphan-status');
  orphanEl.hidden = !orphans.length;
  orphanEl.textContent = orphans.length
    ? `いまのコース一覧に無いコースの記録が ${orphans.length} 件あります（${[...new Set(orphans.map((r) => r.course_name || `id ${r.course_id}`))].slice(0, 3).join('、')} など）。進捗には数えていませんが、消さずに保存しており、書き出しにも含まれます。`
    : '';

  $('#about-list').innerHTML = `
    <dt>アプリの版</dt><dd id="app-version">${esc(appVersion || '確認中')}</dd>
    <dt>コースデータ</dt><dd>${esc(state.data?.as_of ?? '')}時点・${state.courses.length}コース</dd>
    <dt>記録</dt><dd>${n}件</dd>`;
}

function updateFilterDone(count) {
  const btn = $('#filter-done');
  if (btn) btn.textContent = `${count}件を表示`;
}

// ---------- 一覧と詳細の操作 ----------
function selectCourse(id, { focus = true } = {}) {
  if (!state.byId.has(id)) return;
  state.selectedId = id;
  state.detailOpen = true;
  if (WIDE.matches) history.replaceState(null, '', `#list/c${id}`);
  else history.pushState({ detail: true }, '', `#list/c${id}`);
  saveUI();
  renderDetail();
  for (const el of $$('.course-card')) {
    if (Number(el.dataset.id) === id) el.setAttribute('aria-current', 'true');
    else el.removeAttribute('aria-current');
  }
  applyView();
  if (focus && !WIDE.matches) $('#detail-title')?.focus({ preventScroll: true });
  if (WIDE.matches) $('.detail-scroll')?.scrollTo(0, 0);
}

function closeDetail() {
  if (history.state?.detail) {
    history.back(); // popstate で閉じる
    return;
  }
  state.detailOpen = false;
  history.replaceState(null, '', '#list');
  applyView();
  focusSelectedCard();
}

function focusSelectedCard() {
  const card = $(`.course-card[data-id="${state.selectedId}"]`);
  card?.focus({ preventScroll: true });
}

function setView(view) {
  if (!VIEWS.includes(view)) return;
  state.view = view;
  if (view !== 'list') state.detailOpen = false;
  else if (WIDE.matches && state.selectedId) state.detailOpen = true; // 広い画面では右ペインに出ている＝開いている扱い
  history.replaceState(null, '', hashFor());
  saveUI();
  applyView();
  window.scrollTo(0, 0);
}

function openCourseFromElsewhere(id) {
  state.view = 'list';
  state.detailOpen = false;
  history.replaceState(null, '', '#list');
  applyView();
  selectCourse(id);
}

function onPopState() {
  const h = parseHash();
  state.view = h?.view || 'home';
  if (h?.id && state.byId.has(h.id)) {
    state.selectedId = h.id;
    state.detailOpen = true;
  } else {
    state.detailOpen = false;
  }
  renderDetail();
  applyView();
  if (!state.detailOpen) focusSelectedCard();
}

function onLayoutChange() {
  // 折りたたみの開閉：選択中のコースはそのまま。狭い画面へ移ったら「戻る」で一覧へ戻れる履歴を作る
  if (!WIDE.matches && state.view === 'list' && state.detailOpen && state.selectedId && !history.state?.detail) {
    history.replaceState(null, '', '#list');
    history.pushState({ detail: true }, '', `#list/c${state.selectedId}`);
  }
  applyView();
}

// ---------- 絞り込みダイアログ ----------
function chip(type, name, value, label, checked) {
  return `<label class="chip"><input type="${type}" name="${name}" value="${esc(value)}"${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`;
}
function renderFilterBody() {
  const f = state.filters;
  const areas = (state.data?.areas || []).map((a, i) => chip('checkbox', 'area', i, a, f.areas.includes(i))).join('');
  const cool = [3, 2, 1, 0].map((k) => chip('checkbox', 'cool', k, coolShort(k), f.cool.includes(k))).join('');
  const diff = [4, 3, 2, 1].map((k) => chip('checkbox', 'diff', k, diffLabel(k), f.diff.includes(k))).join('');
  const status = Object.entries(STATUS).map(([k, v]) => chip('radio', 'status', k, v, f.status === k)).join('');
  const sort = Object.entries(SORTS).map(([k, v]) => chip('radio', 'sort', k, v, state.sort === k)).join('');
  $('#filter-body').innerHTML = `
    <fieldset><legend>プレー状況</legend><div class="chips">${status}</div></fieldset>
    <fieldset><legend>エリア</legend><div class="chips">${areas}</div></fieldset>
    <fieldset><legend>涼しさ（標高）</legend><div class="chips">${cool}</div></fieldset>
    <fieldset><legend>難易度</legend><div class="chips">${diff}</div></fieldset>
    <fieldset><legend>並び替え</legend><div class="chips">${sort}</div></fieldset>`;
}
function onFilterChange(e) {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  const pick = (name) => $$(`#filter-body input[name="${name}"]:checked`).map((x) => Number(x.value));
  if (t.name === 'sort') state.sort = t.value;
  else if (t.name === 'status') state.filters.status = t.value;
  else state.filters = { ...state.filters, areas: pick('area'), cool: pick('cool'), diff: pick('diff') };
  saveUI();
  renderList();
}
function resetFilters() {
  state.filters = { areas: [], cool: [], diff: [], status: 'all' };
  state.sort = 'area';
  state.q = '';
  $('#q').value = '';
  saveUI();
  renderFilterBody();
  renderList();
}

// ---------- 記録ダイアログ ----------
let editingId = null;
function fillCourseSelect(selectedId) {
  const sel = $('#round-course');
  const groups = (state.data?.areas || []).map((a, i) => {
    const opts = state.courses.filter((c) => c.area === i).sort(SORT_FN.area)
      .map((c) => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${esc(c.name)}${isPlayed(c.id) ? '（プレー済）' : ''}</option>`).join('');
    return `<optgroup label="${esc(a)}">${opts}</optgroup>`;
  }).join('');
  sel.innerHTML = `<option value=""${selectedId ? '' : ' selected'}>コースを選んでください</option>${groups}`;
}
function openRoundDialog({ courseId = null, roundId = null, draft = null } = {}) {
  const round = roundId ? state.rounds.find((r) => r.id === roundId) : null;
  editingId = round ? round.id : null;
  const v = draft || {
    course_id: round ? round.course_id : courseId,
    date: round ? round.date : todayStr(),
    score: round?.score ?? '',
    memo: round?.memo ?? '',
  };
  fillCourseSelect(v.course_id ? Number(v.course_id) : null);
  $('#round-title').textContent = editingId ? '記録を編集' : 'ラウンドを記録';
  $('#round-date').value = v.date || todayStr();
  $('#round-date').max = todayStr();
  $('#round-score').value = v.score ?? '';
  $('#round-memo').value = v.memo ?? '';
  $('#round-error').textContent = '';
  $('#round-delete').hidden = !editingId;
  const dlg = $('#round-dialog');
  if (!dlg.open) dlg.showModal();
  saveDraft();
}
function saveDraft() {
  if (!$('#round-dialog').open) return;
  lsSet(LS_DRAFT, {
    editingId,
    course_id: $('#round-course').value ? Number($('#round-course').value) : null,
    date: $('#round-date').value,
    score: $('#round-score').value,
    memo: $('#round-memo').value,
    savedAt: Date.now(),
  });
}
function restoreDraft() {
  const d = lsGet(LS_DRAFT, null);
  if (!d || typeof d !== 'object') return;
  if (!d.savedAt || Date.now() - d.savedAt > DRAFT_TTL_MS) {
    lsDel(LS_DRAFT);
    return;
  }
  const stillExists = d.editingId && state.rounds.some((r) => r.id === d.editingId);
  openRoundDialog({ roundId: stillExists ? d.editingId : null, draft: d });
}
function closeRoundDialog() {
  lsDel(LS_DRAFT);
  editingId = null;
  const dlg = $('#round-dialog');
  if (dlg.open) dlg.close();
}
async function onRoundSubmit(e) {
  e.preventDefault();
  const err = $('#round-error');
  const courseId = Number($('#round-course').value);
  if (!state.byId.has(courseId)) { err.textContent = 'コースを選んでください。'; $('#round-course').focus(); return; }
  const date = $('#round-date').value;
  if (!isValidDate(date)) { err.textContent = '日付を入力してください。'; $('#round-date').focus(); return; }
  if (date > todayStr()) { err.textContent = '未来の日付は記録できません。'; $('#round-date').focus(); return; }
  const scoreRaw = String($('#round-score').value).trim();
  if ($('#round-score').validity.badInput) { err.textContent = 'スコアは数字で入力してください。'; $('#round-score').focus(); return; }
  let score = null;
  if (scoreRaw) {
    const n = Number(scoreRaw);
    if (!Number.isInteger(n) || n < 1 || n > 300) { err.textContent = 'スコアは1〜300の整数で入力してください。'; $('#round-score').focus(); return; }
    score = n;
  }
  const memo = $('#round-memo').value.trim();
  const now = new Date().toISOString();
  const prev = editingId ? state.rounds.find((r) => r.id === editingId) : null;
  const round = {
    id: prev?.id ?? uuid(),
    course_id: courseId,
    course_name: state.byId.get(courseId).name,
    date,
    score,
    memo,
    created_at: prev?.created_at ?? now,
    updated_at: now,
  };
  const before = progress();
  try {
    await db.putRounds([round]);
  } catch (ex) {
    err.textContent = `保存できませんでした：${ex.message || ex}`;
    return;
  }
  closeRoundDialog();
  await reloadRounds();
  toast(prev ? '記録を更新しました' : `${round.course_name} を記録しました`);
  afterRoundsChanged(before);
}
async function onRoundDelete() {
  const r = state.rounds.find((x) => x.id === editingId);
  if (!r) return;
  const ok = await confirmDialog({
    title: 'この記録を削除しますか？',
    message: `${r.course_name}　${fmtDate(r.date)}${r.score != null ? `　スコア ${r.score}` : ''}`,
    ok: '削除する',
    danger: true,
  });
  if (!ok) return;
  await db.deleteRound(r.id);
  closeRoundDialog();
  await reloadRounds();
  toast('記録を削除しました');
  renderAll();
}

async function reloadRounds() {
  state.rounds = await db.getAllRounds();
  rebuildIndex();
}
function afterRoundsChanged(before) {
  renderAll();
  const now = progress();
  if (!before.complete && now.complete) celebrate();
}

// ---------- 確認ダイアログ ----------
function confirmDialog({ title, message, ok = 'OK', danger = false }) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-msg').textContent = message;
  const okBtn = $('#confirm-ok');
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  return new Promise((resolve) => {
    const finish = (val) => {
      okBtn.onclick = null;
      $('#confirm-cancel').onclick = null;
      dlg.onclose = null;
      if (dlg.open) dlg.close();
      resolve(val);
    };
    okBtn.onclick = () => finish(true);
    $('#confirm-cancel').onclick = () => finish(false);
    dlg.onclose = () => finish(false);
    dlg.showModal();
    $('#confirm-cancel').focus();
  });
}

// ---------- 全制覇の演出 ----------
function celebrate() {
  const p = progress();
  $('#celebrate-art').innerHTML = `${darumaSVG({ complete: true, painting: true, label: '達磨に両目が入りました' })}<span class="spark"></span><span class="spark"></span><span class="spark"></span><span class="spark"></span>`;
  $('#celebrate-msg').textContent = `${state.data?.title ?? ''}の ${p.total} コースをすべて回りました。\n達磨にもう片方の目が入りました。`;
  const dlg = $('#celebrate-dialog');
  if (!dlg.open) dlg.showModal();
}

// ---------- バックアップ ----------
function buildBackup() {
  const rounds = [...state.rounds].sort((a, b) => a.date.localeCompare(b.date) || String(a.created_at).localeCompare(String(b.created_at)));
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    courses_as_of: state.data?.as_of ?? null,
    round_count: rounds.length,
    rounds,
  };
}
function backupName(ext) {
  const d = new Date();
  return `gunma-golf-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}
function downloadText(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function markExported(iso) {
  state.lastExport = iso;
  try { await db.setMeta('lastExport', iso); } catch { /* 表示だけの情報 */ }
  renderSettings();
  renderHome();
}
async function exportShare() {
  const backup = buildBackup();
  const text = JSON.stringify(backup, null, 2);
  const result = $('#backup-result');
  // JSON ファイルを共有できない端末では、中身は同じ JSON のまま .txt で共有を試す
  const candidates = [
    new File([text], backupName('json'), { type: 'application/json' }),
    new File([text], backupName('json.txt'), { type: 'text/plain' }),
  ];
  if (navigator.canShare && navigator.share) {
    for (const file of candidates) {
      let can = false;
      try { can = navigator.canShare({ files: [file] }); } catch { can = false; }
      if (!can) continue;
      try {
        await navigator.share({ files: [file], title: '群馬ゴルフ 全制覇 バックアップ' });
        await markExported(backup.exported_at);
        result.textContent = `共有しました：${file.name}（${backup.round_count}件）\n共有先（Googleドライブなど）に保存されたか確認してください。`;
        return;
      } catch (ex) {
        if (ex && ex.name === 'AbortError') {
          result.textContent = '共有をキャンセルしました。';
          return;
        }
        break; // 共有に失敗 → ダウンロードへ
      }
    }
  }
  downloadText(text, backupName('json'));
  await markExported(backup.exported_at);
  result.textContent = `この端末では共有が使えないため、ダウンロードしました：${backupName('json')}（${backup.round_count}件）\n「ダウンロード」フォルダに保存されます。`;
}
async function exportDownload() {
  const backup = buildBackup();
  const name = backupName('json');
  downloadText(JSON.stringify(backup, null, 2), name);
  await markExported(backup.exported_at);
  $('#backup-result').textContent = `ダウンロードしました：${name}（${backup.round_count}件）\n「ダウンロード」フォルダに保存されます。`;
}

function validateRound(raw, i) {
  if (!raw || typeof raw !== 'object') return { error: `${i + 1}件目：記録の形ではありません` };
  const courseId = Number(raw.course_id);
  if (!Number.isInteger(courseId) || courseId <= 0) return { error: `${i + 1}件目：course_id がありません` };
  if (!isValidDate(raw.date)) return { error: `${i + 1}件目：日付が読めません（${String(raw.date ?? '空')}）` };
  let score = null;
  if (raw.score !== null && raw.score !== undefined && raw.score !== '') {
    const n = Number(raw.score);
    if (!Number.isInteger(n) || n < 1 || n > 300) return { error: `${i + 1}件目：スコアが1〜300の整数ではありません（${String(raw.score)}）` };
    score = n;
  }
  const now = new Date().toISOString();
  return {
    round: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : uuid(),
      course_id: courseId,
      course_name: typeof raw.course_name === 'string' && raw.course_name
        ? raw.course_name
        : (state.byId.get(courseId)?.name ?? ''),
      date: raw.date,
      score,
      memo: typeof raw.memo === 'string' ? raw.memo : '',
      created_at: typeof raw.created_at === 'string' ? raw.created_at : now,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
    },
  };
}
const sameRound = (a, b) => ['course_id', 'course_name', 'date', 'score', 'memo', 'created_at', 'updated_at'].every((k) => a[k] === b[k]);

async function importFile(file) {
  const result = $('#backup-result');
  let obj;
  try {
    const text = (await file.text()).replace(/^﻿/, '');
    obj = JSON.parse(text);
  } catch {
    result.textContent = `読み込めませんでした：${file.name} は JSON の形式ではありません。`;
    return;
  }
  const rows = Array.isArray(obj) ? obj : obj?.rounds;
  if (!Array.isArray(rows) || (obj && !Array.isArray(obj) && obj.format && obj.format !== BACKUP_FORMAT)) {
    result.textContent = `読み込めませんでした：${file.name} はこのアプリのバックアップではありません。`;
    return;
  }
  const valid = [];
  const errors = [];
  rows.forEach((raw, i) => {
    const v = validateRound(raw, i);
    if (v.error) errors.push(v.error);
    else valid.push(v.round);
  });
  const existing = new Map(state.rounds.map((r) => [r.id, r]));
  let added = 0;
  let updated = 0;
  let same = 0;
  for (const r of valid) {
    const cur = existing.get(r.id);
    if (!cur) added += 1;
    else if (sameRound(cur, r)) same += 1;
    else updated += 1;
  }
  const unknown = valid.filter((r) => !state.byId.has(r.course_id)).length;
  if (!valid.length) {
    result.textContent = `読み込める記録がありませんでした（${rows.length}件中、形式の合わないもの ${errors.length}件）。${errors.slice(0, 3).map((e) => `\n・${e}`).join('')}`;
    return;
  }
  const lines = [
    `${file.name} から ${valid.length} 件を読み込みます。`,
    `新規 ${added} 件／上書き ${updated} 件／同じ内容 ${same} 件`,
    '今ある記録は消えません（同じ記録は上書き）。',
  ];
  if (errors.length) lines.push(`形式が合わず読み込めない記録：${errors.length} 件`);
  if (unknown) lines.push(`いまのコース一覧に無いコースの記録：${unknown} 件（保存はするが進捗には数えない）`);
  const ok = await confirmDialog({ title: 'バックアップを読み込みますか？', message: lines.join('\n'), ok: '読み込む' });
  if (!ok) {
    result.textContent = '読み込みをやめました。';
    return;
  }
  const before = progress();
  await db.putRounds(valid);
  await reloadRounds();
  result.textContent = [
    `読み込みました：新規 ${added} 件／上書き ${updated} 件／同じ内容 ${same} 件`,
    errors.length ? `読み込めなかった記録 ${errors.length} 件：${errors.slice(0, 3).join('／')}${errors.length > 3 ? ' ほか' : ''}` : '',
    unknown ? `コース一覧に無いコースの記録 ${unknown} 件は進捗に数えていません。` : '',
  ].filter(Boolean).join('\n');
  toast(`${valid.length}件を読み込みました`);
  afterRoundsChanged(before);
}

async function clearAll() {
  const n = state.rounds.length;
  if (!n) { toast('消去する記録がありません'); return; }
  const ok = await confirmDialog({
    title: 'すべての記録を消去しますか？',
    message: `${n} 件の記録をこの端末から消します。元に戻すにはバックアップの読み込みが必要です。\n先に「記録を書き出す」で保存しておくことをおすすめします。`,
    ok: '消去する',
    danger: true,
  });
  if (!ok) return;
  await db.clearRounds();
  await reloadRounds();
  $('#backup-result').textContent = `${n} 件の記録を消去しました。`;
  toast('すべての記録を消去しました');
  renderAll();
}

// ---------- 保存の永続化 ----------
async function requestPersist() {
  if (!navigator.storage?.persist) return undefined;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return undefined;
  }
}

// ---------- Service Worker と更新 ----------
let appVersion = '';
let waitingWorker = null;
let userAskedUpdate = false;
let lastUpdateCheck = 0;

function showBanner(text, onClick) {
  const banner = $('#banner');
  const btn = $('#banner-btn');
  btn.textContent = text;
  btn.onclick = onClick;
  banner.hidden = false;
}
function showUpdate(worker) {
  waitingWorker = worker;
  showBanner('新しいバージョンがあります — タップで更新', () => {
    userAskedUpdate = true;
    saveDraft();
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
  });
}
async function fetchVersion() {
  const sw = navigator.serviceWorker?.controller;
  if (!sw) return '';
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(''), 2000);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve(e.data?.version || ''); };
    sw.postMessage({ type: 'GET_VERSION' }, [ch.port2]);
  });
}
async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'DATA_UPDATED') {
      showBanner('コースデータが更新されました — タップで反映', () => { saveDraft(); location.reload(); });
    }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userAskedUpdate) location.reload();
    else fetchVersion().then((v) => { appVersion = v; const el = $('#app-version'); if (el) el.textContent = v || '—'; });
  });
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdate(nw);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastUpdateCheck > 30 * 60 * 1000) {
        lastUpdateCheck = Date.now();
        reg.update().catch(() => {});
      }
    });
    lastUpdateCheck = Date.now();
    return reg;
  } catch {
    return null;
  }
}
async function checkUpdate() {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) { toast('この環境では更新を確認できません'); return; }
  try {
    await reg.update();
  } catch {
    toast('更新を確認できませんでした（オフライン？）');
    return;
  }
  if (reg.waiting) showUpdate(reg.waiting);
  else if (reg.installing) toast('新しいバージョンを取得しています…');
  else toast('最新の状態です');
}

// ---------- イベント ----------
function wire() {
  $('.tabs').addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (t) setView(t.dataset.view);
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) { setView(go.dataset.goto); return; }
    const open = e.target.closest('[data-open-course]');
    if (open) { openCourseFromElsewhere(Number(open.dataset.openCourse)); return; }
    const act = e.target.closest('[data-action]');
    if (act) {
      const a = act.dataset.action;
      if (a === 'close-detail') closeDetail();
      else if (a === 'add-round-here') openRoundDialog({ courseId: state.selectedId });
      else if (a === 'reset-filters') resetFilters();
      return;
    }
    const edit = e.target.closest('[data-edit-round]');
    if (edit) openRoundDialog({ roundId: edit.dataset.editRound });
  });
  $('#course-list').addEventListener('click', (e) => {
    const card = e.target.closest('.course-card');
    if (card) selectCourse(Number(card.dataset.id));
  });

  let qTimer = 0;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = e.target.value; saveUI(); renderList(); }, 120);
  });
  $('#q-clear').addEventListener('click', () => {
    state.q = '';
    $('#q').value = '';
    saveUI();
    renderList();
    $('#q').focus();
  });

  $('#open-filter').addEventListener('click', () => {
    renderFilterBody();
    updateFilterDone(filteredCourses().length);
    $('#filter-dialog').showModal();
  });
  $('#filter-body').addEventListener('change', onFilterChange);
  $('#filter-reset').addEventListener('click', resetFilters);
  $('#add-round').addEventListener('click', () => openRoundDialog({ courseId: WIDE.matches ? state.selectedId : null }));

  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) {
        if (dlg.id === 'round-dialog') closeRoundDialog();
        else dlg.close();
      }
    });
  }
  const roundDlg = $('#round-dialog');
  roundDlg.addEventListener('cancel', () => { lsDel(LS_DRAFT); editingId = null; });
  $('#round-form').addEventListener('submit', onRoundSubmit);
  $('#round-form').addEventListener('input', saveDraft);
  $('#round-form').addEventListener('change', saveDraft);
  $('#round-delete').addEventListener('click', onRoundDelete);

  $('#export-share').addEventListener('click', () => exportShare().catch((ex) => { $('#backup-result').textContent = `書き出せませんでした：${ex.message || ex}`; }));
  $('#export-download').addEventListener('click', () => exportDownload().catch((ex) => { $('#backup-result').textContent = `書き出せませんでした：${ex.message || ex}`; }));
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) importFile(file).catch((ex) => { $('#backup-result').textContent = `読み込めませんでした：${ex.message || ex}`; });
  });
  $('#clear-all').addEventListener('click', () => clearAll().catch((ex) => toast(`消去できませんでした：${ex.message || ex}`)));
  $('#persist-btn').addEventListener('click', async () => {
    state.persisted = await requestPersist();
    renderSettings();
    toast(state.persisted ? '消えにくい保存が許可されました' : 'まだ許可されていません');
  });
  $('#check-update').addEventListener('click', () => checkUpdate());

  window.addEventListener('popstate', onPopState);
  WIDE.addEventListener('change', onLayoutChange);

  // ヘッダーの高さ（更新バナーが出ると伸びる）を検索欄の貼り付き位置に使う
  if ('ResizeObserver' in window) {
    new ResizeObserver(([entry]) => {
      const h = Math.round(entry.target.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--header-h', `${h}px`);
    }).observe($('.appbar'));
  }
}

// ---------- 起動 ----------
async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function init() {
  wire();
  const regPromise = registerSW();

  try {
    const [data, yomi] = await Promise.all([
      loadJSON('courses.json'),
      loadJSON('yomi.json').catch(() => ({})),
    ]);
    state.data = data;
    state.courses = Array.isArray(data.courses) ? data.courses : [];
    state.byId = new Map(state.courses.map((c) => [c.id, c]));
    state.yomi = yomi && typeof yomi === 'object' ? yomi : {};
  } catch (ex) {
    $('#main').innerHTML = `<div class="page"><div class="card"><h2>コースデータを読み込めませんでした</h2><p>${esc(ex.message || ex)}</p><p>通信できる場所で一度開くと、以後はオフラインでも使えます。</p></div></div>`;
    return;
  }

  try {
    state.rounds = await db.getAllRounds();
    state.lastExport = (await db.getMeta('lastExport')) || null;
  } catch (ex) {
    state.dbError = ex.message || String(ex);
    state.rounds = [];
    showBanner(`記録を保存できません：${state.dbError}`, () => setView('settings'));
  }
  rebuildIndex();

  restoreUI();
  const h = parseHash();
  if (h) {
    state.view = h.view;
    if (h.id && state.byId.has(h.id)) {
      state.selectedId = h.id;
      state.detailOpen = true;
    }
  }
  $('#q').value = state.q;
  renderAll();
  history.replaceState(null, '', state.view === 'list' && state.detailOpen ? '#list' : hashFor());
  if (state.view === 'list' && state.detailOpen && state.selectedId) {
    if (WIDE.matches) history.replaceState(null, '', hashFor());
    else history.pushState({ detail: true }, '', hashFor());
  }
  restoreDraft();

  state.persisted = await requestPersist();
  renderSettings();
  await regPromise;
  appVersion = await fetchVersion();
  renderSettings();
}

init();
