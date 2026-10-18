// 公開前の検証（開発用）。GitHub Pages と同じサブパス配信を手元で再現し、Chrome で一通り操作して確かめる。
// 使い方：cd dev && npm install && node verify.mjs [出力フォルダ]
// 出力：スクリーンショット（*.png）と results.json。1つでも NG があれば終了コード 1。
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../rating.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dev', 'out'));
const SITE = path.join(OUT, 'site');
const PREFIX = '/gunma-golf-conquest/';
const SITE_FILES = ['index.html', 'styles.css', 'app.js', 'db.js', 'rating.js', 'sw.js', 'courses.json', 'yomi.json', 'manifest.webmanifest', 'icons'];

fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(SITE, { recursive: true });
for (const f of SITE_FILES) fs.cpSync(path.join(ROOT, f), path.join(SITE, f), { recursive: true });
const DATA = JSON.parse(fs.readFileSync(path.join(SITE, 'courses.json'), 'utf8'));
const COURSES = DATA.courses;
const byId = new Map(COURSES.map((c) => [c.id, c]));
// 難しい順の期待値：難易度（4段階）→ 本来のレート（ティの分かる公式値）→ GDO上級者平均 → id
const honraiCR = (c) => { const h = analyze(c)?.honrai; return h && h.basis === 'tee' ? h.cr : null; };
const desc = (a, b) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : b - a);
const EXPECTED_HARDEST = [...COURSES].sort((a, b) => b.difficulty - a.difficulty
  || desc(honraiCR(a), honraiCR(b)) || desc(a.gdo_upper_avg, b.gdo_upper_avg) || a.id - b.id)[0];
const LAYOUT_SAMPLE = COURSES.find((c) => c.layout && analyze(c)?.rounds.length > 1) || COURSES.find((c) => c.layout);

// ---------- 配信（GitHub Pages 相当：サブパス・max-age=600・ETag） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};
let offline = false;
const reqLog = [];
const server = http.createServer((req, res) => {
  res.on('finish', () => reqLog.push(`${res.statusCode} ${req.url}`));
  if (offline) { req.socket.destroy(); return; }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === PREFIX.slice(0, -1)) { res.writeHead(301, { Location: PREFIX }); res.end(); return; }
  if (!u.pathname.startsWith(PREFIX)) { res.writeHead(404); res.end('not found'); return; }
  let rel = decodeURIComponent(u.pathname.slice(PREFIX.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(SITE, rel));
  if (!file.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
  const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
  const headers = { 'Cache-Control': 'max-age=600', ETag: etag, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}${PREFIX}`;

// ---------- 判定の記録 ----------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? 'OK' : 'NG'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- インストール要件（Chrome 自身の判定） ----------
// 下のメイン検証はシークレット相当のコンテキスト（in-incognito で必ず弾かれる）なので、
// ふつうのプロファイルの Chrome を先に単独で起動して判定する（2つ同時に動かすと不安定だった）。
async function checkInstallability() {
  const name = 'Chrome のインストール要件エラーなし（Page.getInstallabilityErrors・通常プロファイル）';
  const profileDir = path.join(OUT, 'profile');
  fs.rmSync(profileDir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: true, viewport: { width: 390, height: 844 }, locale: 'ja-JP', timeout: 60000,
  });
  const within = (promise, ms, what) => Promise.race([
    promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}が${ms / 1000}秒で終わらない`)), ms)),
  ]);
  try {
    const p = ctx.pages()[0] || await ctx.newPage();
    await within(p.goto(BASE), 30000, '表示');
    let state = null;
    for (let i = 0; i < 30; i += 1) {
      state = await within(p.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return { active: reg?.active?.state ?? null, controlled: !!navigator.serviceWorker.controller };
      }), 5000, 'SWの状態確認');
      if (state.active === 'activated') break;
      await sleep(500);
    }
    if (state?.active !== 'activated') throw new Error(`SWが有効にならない ${JSON.stringify(state)}`);
    await within(p.reload(), 30000, '再読み込み');
    const cdp = await ctx.newCDPSession(p);
    let errs = null;
    for (let i = 0; i < 10; i += 1) {
      errs = (await within(cdp.send('Page.getInstallabilityErrors'), 10000, 'インストール要件の確認')).installabilityErrors;
      if (!errs.length) break;
      await sleep(500);
    }
    check(name, errs.length === 0, JSON.stringify(errs));
  } catch (e) {
    const tail = reqLog.slice(-20).join(', ');
    check(name, false, `${e.message.slice(0, 200)} ／ 配信記録：${tail}`);
  } finally {
    await within(ctx.close(), 15000, '終了').catch(() => {});
  }
}
await checkInstallability();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
  locale: 'ja-JP', timezoneId: 'Asia/Tokyo', colorScheme: 'light', acceptDownloads: true,
});
const page = await context.newPage();
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));

const shot = (name, opts = {}) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
const visible = (sel) => page.locator(sel).first().isVisible();
async function noHScroll(label) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  check(`${label}：横スクロールなし`, r.sw <= r.w, `scrollWidth ${r.sw} / 幅 ${r.w}`);
}
async function tapTargets(label) {
  const bad = await page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, summary, .chip span');
    for (const el of els) {
      if (el.matches('.chip input')) continue; // 見えている span 側で測る
      if (el.closest('dialog:not([open])')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (r.bottom < 0 || r.top > innerHeight * 3) continue;
      if (r.width < 44 || r.height < 44) {
        const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 18);
        out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} 「${name}」 ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  });
  check(`${label}：タップ領域が44px以上`, bad.length === 0, bad.slice(0, 6).join(' | '));
}
async function focusVisible(label) {
  await page.keyboard.press('Tab');
  const r = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return { tag: el.tagName, style: cs.outlineStyle, width: cs.outlineWidth };
  });
  check(`${label}：キーボードフォーカスが見える`, r && r.style !== 'none' && parseFloat(r.width) >= 2, JSON.stringify(r));
}
async function idbDump() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('gunma-golf-conquest');
    req.onsuccess = () => {
      const all = req.result.transaction('rounds').objectStore('rounds').getAll();
      all.onsuccess = () => { req.result.close(); resolve(all.result.sort((a, b) => a.id.localeCompare(b.id))); };
      all.onerror = () => reject(all.error);
    };
    req.onerror = () => reject(req.error);
  }));
}
const cardCount = () => page.locator('.course-card').count();
async function tab(view) {
  await page.click(`.tab[data-view="${view}"]`);
  await page.waitForFunction((v) => document.getElementById('app').dataset.view === v, view);
}
async function openCourse(id) {
  await page.click(`.course-card[data-id="${id}"]`);
  await page.waitForFunction((cid) => document.getElementById('detail').dataset.courseId === String(cid), id);
}
async function fillRound({ course, date, score = '', memo = '' }) {
  if (course != null) await page.selectOption('#round-course', String(course));
  await page.fill('#round-date', date);
  await page.fill('#round-score', String(score));
  await page.fill('#round-memo', memo);
}
async function saveRound() {
  await page.click('#round-form button[type="submit"]');
  await page.waitForFunction(() => !document.getElementById('round-dialog').open);
}
async function back() {
  await page.evaluate(() => history.back());
  await sleep(250);
}
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

try {
  // ===== 1. 起動と Service Worker =====
  await page.goto(BASE);
  await page.waitForSelector('#view-home .hero');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  check('Service Worker が登録され、ページを制御している', true);
  const cacheKeys = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys[0]);
    return { keys, n: (await c.keys()).length };
  });
  check('キャッシュに全ファイルが入っている', cacheKeys.n >= 15, `${cacheKeys.keys.join(',')} / ${cacheKeys.n}件`);
  check('全コース数がヘッダーに出る', (await page.textContent('#appbar-count')).includes(`0 / ${COURSES.length}`));
  await shot('n390-home-empty');
  await noHScroll('390 進捗');
  await tapTargets('390 進捗');
  await focusVisible('390 進捗');

  // ===== 2. 一覧 =====
  await tab('list');
  check('一覧に62コース', (await cardCount()) === COURSES.length, await cardCount());
  check('エリア別に5グループ', (await page.locator('.area-group').count()) === DATA.areas.length);
  await shot('n390-list');
  await noHScroll('390 一覧');
  await tapTargets('390 一覧');

  await page.fill('#q', 'あかぎ');
  await sleep(300);
  const akagi = await cardCount();
  check('ひらがな検索「あかぎ」で赤城系が出る', akagi >= 4, `${akagi}件`);
  await page.fill('#q', '草津 温泉');
  await sleep(300);
  check('複数語のAND検索「草津 温泉」', (await cardCount()) === 1);
  await page.click('#q-clear');
  await sleep(200);

  // 絞り込み
  await page.click('#open-filter');
  await page.waitForSelector('#filter-dialog[open]');
  await shot('n390-filter');
  await tapTargets('390 絞り込み');
  const cool3 = COURSES.filter((c) => c.cool === 3).length;
  await page.click('#filter-body label.chip:has(input[name="cool"][value="3"])');
  await sleep(150);
  check('涼しさ◎で絞り込み', (await cardCount()) === cool3, `${await cardCount()} / 期待 ${cool3}`);
  const diff4cool3 = COURSES.filter((c) => c.cool === 3 && c.difficulty === 4).length;
  await page.click('#filter-body label.chip:has(input[name="diff"][value="4"])');
  await sleep(150);
  check('◎かつ難関で絞り込み', (await cardCount()) === diff4cool3, `${await cardCount()} / 期待 ${diff4cool3}`);
  await page.click('#filter-reset');
  await page.click('#filter-body label.chip:has(input[name="sort"][value="hard"])');
  await sleep(150);
  const firstHardId = Number(await page.locator('.course-card').first().getAttribute('data-id'));
  check('難しい順の先頭が「難易度→本来のレート」の最上位', firstHardId === EXPECTED_HARDEST.id, `${byId.get(firstHardId).name} / 期待 ${EXPECTED_HARDEST.name}`);
  await page.click('#filter-body label.chip:has(input[name="sort"][value="elev"])');
  await sleep(150);
  const maxElev = Math.max(...COURSES.map((c) => c.elevation_m));
  const firstElev = await page.locator('.course-card').first().getAttribute('data-id');
  check('標高順の先頭が最高標高', byId.get(Number(firstElev)).elevation_m === maxElev, byId.get(Number(firstElev)).name);
  for (const [key, valueOf, label] of [
    ['reg', (c) => analyze(c)?.regular?.cr ?? null, 'レギュラー'],
    ['gdo', (c) => c.gdo_upper_avg ?? null, '上級者平均'],
  ]) {
    await page.click(`#filter-body label.chip:has(input[name="sort"][value="${key}"])`);
    await sleep(150);
    const withV = COURSES.filter((c) => valueOf(c) != null);
    const min = Math.min(...withV.map(valueOf));
    const firstId = Number(await page.locator('.course-card').first().getAttribute('data-id'));
    const firstKey = await page.locator('.course-card .cc-key').first().textContent();
    check(`${label}順：先頭が最小値で「県内1位」`, valueOf(byId.get(firstId)) === min && firstKey.includes('県内1位') && firstKey.includes(min.toFixed(1)), `${byId.get(firstId).name} ${firstKey}`);
    const keyed = await page.locator('.course-card .cc-key').count();
    check(`${label}順：値のあるコースに順位、無いコースは末尾にまとめる`, keyed === withV.length && (await page.locator('.area-group .area-head').count()) === (withV.length < COURSES.length ? 1 : 0), `${keyed} / ${withV.length}`);
    await shot(`n390-list-sort-${key}`);
  }
  await page.click('#filter-body label.chip:has(input[name="sort"][value="name"])');
  await sleep(150);
  const firstName = await page.locator('.course-card .cc-name').first().textContent();
  check('名前順（読み）の先頭は「あ」行', /赤城|熱海/.test(firstName), firstName);
  await page.click('#filter-reset');
  await page.click('#filter-done');
  await page.waitForFunction(() => !document.getElementById('filter-dialog').open);

  // ===== 3. 詳細と記録 =====
  await openCourse(1);
  check('390：詳細が全画面で開く', await page.evaluate(() => document.getElementById('app').dataset.detail === 'open'));
  const c1 = byId.get(1);
  const mapsHref = await page.getAttribute('#detail a:has-text("Googleマップでルート")', 'href');
  check('Googleマップのリンク', mapsHref === `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c1.name)}`, mapsHref);
  const offHref = await page.getAttribute('#detail a:has-text("公式サイト")', 'href');
  check('公式サイトのリンク', offHref === c1.url, offHref);
  const detailText = await page.textContent('#detail');
  for (const [label, val] of [['標高', '1,300m'], ['アクセス', c1.access], ['特徴', c1.feature], ['メモ', c1.memo]]) {
    check(`詳細に${label}が出る`, detailText.includes(val), val);
  }
  await shot('n390-detail');
  if (LAYOUT_SAMPLE) {
    await back();
    await openCourse(LAYOUT_SAMPLE.id);
    const an = analyze(LAYOUT_SAMPLE);
    const rows = await page.locator('#detail .layout-sec table.rt').first().locator('tbody tr').count();
    check('詳細：18Hの組み合わせが全部並ぶ', rows === LAYOUT_SAMPLE.layout.rounds.length, `${LAYOUT_SAMPLE.name} ${rows} / ${LAYOUT_SAMPLE.layout.rounds.length}`);
    const nineRows = await page.locator('#detail .layout-sec table.rt').nth(1).locator('tbody tr').count().catch(() => 0);
    check('詳細：9Hごとの行が全部並ぶ', !LAYOUT_SAMPLE.layout.nines.length || nineRows === LAYOUT_SAMPLE.layout.nines.length, `${nineRows} / ${LAYOUT_SAMPLE.layout.nines.length}`);
    if (an.honrai && an.honrai.basis === 'tee') {
      const facts = await page.textContent('#detail .facts');
      check('詳細：本来のレートと組み合わせ名', facts.includes(an.honrai.cr.toFixed(1)) && facts.includes(an.honrai.round), `${an.honrai.cr} ${an.honrai.round}`);
    }
    await page.locator('#detail details.src summary').first().click().catch(() => {});
    await shot('n390-detail-layout', { fullPage: false });
    await page.evaluate(() => document.querySelector('#detail .layout-sec')?.scrollIntoView());
    await shot('n390-detail-layout-table');
    await noHScroll('390 詳細（コース別の難易度）');
    await tapTargets('390 詳細（コース別の難易度）');
    await back();
    await openCourse(1);
  }
  await noHScroll('390 詳細');
  await tapTargets('390 詳細');

  await page.click('[data-action="add-round-here"]');
  await page.waitForSelector('#round-dialog[open]');
  check('記録ダイアログでコースが選ばれている', (await page.inputValue('#round-course')) === '1');
  await fillRound({ date: '2026-05-03', score: 92, memo: 'テスト記録' });
  await shot('n390-round-dialog');
  await tapTargets('390 記録ダイアログ');
  await saveRound();
  await page.click('[data-action="add-round-here"]');
  await fillRound({ date: '2026-08-10', score: 88, memo: '2回目' });
  await saveRound();
  const pill = await page.textContent('#detail .status-pill');
  check('詳細：プレー済・初回・ベスト・回数', pill.includes('プレー済') && pill.includes('2026/05/03') && pill.includes('88') && pill.includes('2回'), pill);
  await shot('n390-detail-played');
  await back();
  check('戻る操作で詳細が閉じて一覧へ', await page.evaluate(() => document.getElementById('app').dataset.detail === 'closed' && document.getElementById('app').dataset.view === 'list'));
  const card1 = await page.textContent('.course-card[data-id="1"]');
  check('一覧に初回プレー日とベストスコア', card1.includes('初回 2026/05/03') && card1.includes('ベスト 88') && card1.includes('2回'), card1.replace(/\s+/g, ' '));

  await page.click('#add-round');
  await page.waitForSelector('#round-dialog[open]');
  check('一覧の＋記録はコース未選択で開く', (await page.inputValue('#round-course')) === '');
  await page.click('#round-form button[type="submit"]');
  check('コース未選択では保存できない', (await page.textContent('#round-error')).includes('コース'));
  await fillRound({ course: 3, date: '2026-07-20' });
  await saveRound();
  const card3 = await page.textContent('.course-card[data-id="3"]');
  check('スコアなしでもプレー済になる', card3.includes('初回 2026/07/20') && !card3.includes('ベスト'), card3.replace(/\s+/g, ' '));
  check('ヘッダーの達成数が2', (await page.textContent('#appbar-count')).includes(`2 / ${COURSES.length}`));
  await shot('n390-list-played');

  // 編集と削除
  await openCourse(2);
  await page.click('[data-action="add-round-here"]');
  await page.waitForSelector('#round-dialog[open]');
  check('新規の記録では削除ボタンが出ない', await page.locator('#round-delete').isHidden());
  await fillRound({ date: '2026-06-01', score: 100, memo: '編集前' });
  await saveRound();
  await page.click('#detail [data-edit-round]');
  await page.waitForSelector('#round-dialog[open]');
  check('編集では削除ボタンが出る', await page.locator('#round-delete').isVisible());
  check('編集ダイアログに元の値', (await page.inputValue('#round-score')) === '100' && (await page.inputValue('#round-memo')) === '編集前');
  await page.fill('#round-score', '97');
  await saveRound();
  check('編集が反映される（件数は増えない）', (await page.textContent('#detail .rounds')).includes('97') && (await idbDump()).filter((r) => r.course_id === 2).length === 1);
  await page.click('#detail [data-edit-round]');
  await page.waitForSelector('#round-dialog[open]');
  await page.click('#round-delete');
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => !document.getElementById('round-dialog').open);
  check('削除で未プレーに戻る', (await page.textContent('#detail .status-pill')).includes('未プレー') && (await idbDump()).filter((r) => r.course_id === 2).length === 0);
  await back();

  // ===== 4. 折りたたみの開閉（390 ⇄ 840） =====
  await openCourse(16);
  await page.click('[data-action="add-round-here"]');
  await page.waitForSelector('#round-dialog[open]');
  await page.fill('#round-score', '101');
  await page.fill('#round-memo', '折りたたみテスト');
  await page.setViewportSize({ width: 840, height: 900 });
  await sleep(400);
  const afterOpen = await page.evaluate(() => ({
    dlg: document.getElementById('round-dialog').open,
    score: document.getElementById('round-score').value,
    memo: document.getElementById('round-memo').value,
    course: document.getElementById('round-course').value,
    title: document.getElementById('detail-title')?.textContent,
    listX: document.getElementById('list-pane').getBoundingClientRect().width,
    detailX: document.getElementById('detail').getBoundingClientRect().left,
  }));
  check('開く（840px）：入力中の内容が残る', afterOpen.dlg && afterOpen.score === '101' && afterOpen.memo === '折りたたみテスト' && afterOpen.course === '16', JSON.stringify(afterOpen));
  check('開く（840px）：左に一覧・右に選択中のコース', afterOpen.title === byId.get(16).name && afterOpen.listX > 250 && afterOpen.detailX >= afterOpen.listX - 1, JSON.stringify(afterOpen));
  await shot('w840-fold-open-dialog');
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  const afterClose = await page.evaluate(() => ({
    dlg: document.getElementById('round-dialog').open,
    score: document.getElementById('round-score').value,
    memo: document.getElementById('round-memo').value,
    detail: document.getElementById('app').dataset.detail,
  }));
  check('閉じる（390px）：入力中の内容と選択中のコースが残る', afterClose.dlg && afterClose.score === '101' && afterClose.memo === '折りたたみテスト' && afterClose.detail === 'open', JSON.stringify(afterClose));
  await shot('n390-fold-closed-dialog');
  await page.click('#round-dialog .sheet-actions [data-close]');
  check('キャンセル後も詳細はそのコース', await page.evaluate(() => document.getElementById('app').dataset.detail === 'open' && document.getElementById('detail').dataset.courseId === '16'));
  await back();
  check('開閉のあとも戻る操作で一覧へ', await page.evaluate(() => document.getElementById('app').dataset.detail === 'closed'));

  // 下書き：再読み込みしても入力中の内容が戻る
  await openCourse(20);
  await page.click('[data-action="add-round-here"]');
  await page.fill('#round-score', '95');
  await page.fill('#round-memo', 'リロード中の下書き');
  await page.reload();
  await page.waitForSelector('#round-dialog[open]', { timeout: 5000 }).catch(() => {});
  const draft = await page.evaluate(() => ({
    dlg: document.getElementById('round-dialog').open,
    course: document.getElementById('round-course').value,
    score: document.getElementById('round-score').value,
    memo: document.getElementById('round-memo').value,
    detail: document.getElementById('detail').dataset.courseId,
  }));
  check('再読み込みしても下書きと選択中のコースが戻る', draft.dlg && draft.course === '20' && draft.score === '95' && draft.memo === 'リロード中の下書き' && draft.detail === '20', JSON.stringify(draft));
  await page.click('#round-dialog .sheet-actions [data-close]');
  await back();

  // ===== 5. 見方・設定 =====
  await tab('guide');
  const guide = await page.textContent('#view-guide');
  const missing = [
    ...DATA.closed_excluded,
    ...DATA.extra_not_counted.map((e) => e.name),
    ...DATA.extra_not_counted.map((e) => e.note),
    ...Object.values(DATA.legend.cool),
    ...Object.values(DATA.legend.difficulty),
    DATA.legend.course_rating_back, DATA.legend.gdo_upper_avg, DATA.legend.elevation_m,
  ].filter((s) => !guide.includes(s));
  check('見方に legend / closed_excluded / extra_not_counted を全部表示', missing.length === 0, missing.join(' | '));
  await shot('n390-guide');
  await shot('n390-guide-full', { fullPage: true });
  await noHScroll('390 見方');
  await tapTargets('390 見方');
  await tab('settings');
  await shot('n390-settings');
  await shot('n390-settings-full', { fullPage: true });
  await noHScroll('390 設定');
  await tapTargets('390 設定');

  // ===== 6. バックアップ：記録 → 書き出し → 全消去 → 読み込み =====
  const before = await idbDump();
  check('記録が3件ある', before.length === 3, before.length);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
  const backupPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(backupPath);
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  check('書き出したJSONに全件', backup.format === 'gunma-golf-conquest-backup' && backup.rounds.length === 3, dl.suggestedFilename());
  const share = await page.evaluate(() => {
    if (!navigator.canShare) return 'canShare なし';
    const t = (f) => { try { return navigator.canShare({ files: [f] }); } catch (e) { return `例外 ${e.name}`; } };
    return {
      json: t(new File(['{}'], 'a.json', { type: 'application/json' })),
      txt: t(new File(['{}'], 'a.json.txt', { type: 'text/plain' })),
    };
  });
  check('（参考）canShare の結果', true, JSON.stringify(share));
  // 共有が使えない端末のつもりで、共有ボタンがダウンロードに切り替わるか
  await page.evaluate(() => { Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }); });
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#export-share')]);
  check('共有が使えないときはダウンロードになる', dl2.suggestedFilename().endsWith('.json'), dl2.suggestedFilename());

  await page.click('#clear-all');
  await page.waitForSelector('#confirm-dialog[open]');
  await shot('n390-confirm-clear');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.getElementById('appbar-count').textContent.includes('0 /'));
  check('全消去で0件', (await idbDump()).length === 0);
  await page.setInputFiles('#import-file', backupPath);
  await page.waitForSelector('#confirm-dialog[open]');
  const importMsg = await page.textContent('#confirm-msg');
  check('読み込み前に件数を確認', importMsg.includes('新規 3 件'), importMsg.replace(/\n/g, ' / '));
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.getElementById('appbar-count').textContent.includes('2 /'));
  const after = await idbDump();
  check('読み込みで元どおり（全項目一致）', JSON.stringify(after) === JSON.stringify(before), `${after.length}件`);
  await page.setInputFiles('#import-file', backupPath);
  await page.waitForSelector('#confirm-dialog[open]');
  check('同じファイルの再読み込みは「同じ内容」', (await page.textContent('#confirm-msg')).includes('同じ内容 3 件'));
  await page.click('#confirm-cancel');
  const brokenPath = path.join(OUT, 'broken.json');
  fs.writeFileSync(brokenPath, JSON.stringify({ format: 'gunma-golf-conquest-backup', rounds: [{ id: 'x', course_id: 1, date: '2026-13-40' }, { id: 'y', course_id: 2, date: '2026-06-01', score: 'abc' }] }));
  await page.setInputFiles('#import-file', brokenPath);
  await sleep(300);
  const brokenMsg = await page.textContent('#backup-result');
  check('壊れた記録は読み込まず理由を出す', brokenMsg.includes('形式の合わないもの 2件'), brokenMsg.replace(/\n/g, ' / '));

  // ===== 7. オフライン =====
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#appbar-count');
  await page.waitForFunction(() => /\d+ \/ \d+/.test(document.getElementById('appbar-count').textContent));
  check('オフラインで再読み込みしても起動', (await page.textContent('#appbar-count')).includes(`2 / ${COURSES.length}`));
  await tab('list');
  check('オフライン：一覧62件', (await cardCount()) === COURSES.length);
  await openCourse(5);
  await page.click('[data-action="add-round-here"]');
  await fillRound({ date: '2026-09-01', score: 90, memo: 'オフラインで記録' });
  await saveRound();
  check('オフライン：記録できる', (await page.textContent('#appbar-count')).includes(`3 / ${COURSES.length}`));
  await back();
  await page.click('#open-filter');
  await page.click('#filter-body label.chip:has(input[name="status"][value="played"])');
  await sleep(150);
  check('オフライン：絞り込みできる', (await cardCount()) === 3);
  await page.click('#filter-reset');
  await page.click('#filter-done');
  await shot('n390-offline-list');
  await page.goto(`${BASE}#guide`);
  await page.waitForSelector('#view-guide .card');
  check('オフライン：見方', (await page.textContent('#view-guide')).includes(DATA.closed_excluded[0]));
  await tab('settings');
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#export-download')]);
  check('オフライン：書き出しできる', dl3.suggestedFilename().endsWith('.json'));
  offline = false;
  await context.setOffline(false);

  // ===== 8. インストール要件 =====
  const cdp = await context.newCDPSession(page);
  const man = await cdp.send('Page.getAppManifest');
  check('マニフェストの解析エラーなし', man.errors.length === 0, JSON.stringify(man.errors));
  const mj = JSON.parse(man.data);
  check('マニフェスト：name / short_name / display / start_url / scope / theme_color',
    mj.name && mj.short_name && mj.display === 'standalone' && mj.start_url && mj.scope && mj.theme_color,
    `${mj.name} / ${mj.short_name} / ${mj.display}`);
  const need = [['192x192', 'any'], ['512x512', 'any'], ['192x192', 'maskable'], ['512x512', 'maskable']];
  for (const [size, purpose] of need) {
    const ic = mj.icons.find((i) => i.sizes === size && i.purpose === purpose);
    let ok = false;
    let detail = 'なし';
    if (ic) {
      const buf = fs.readFileSync(path.join(SITE, ic.src));
      const s = pngSize(buf);
      ok = `${s.w}x${s.h}` === size;
      detail = `${ic.src} 実寸 ${s.w}x${s.h}`;
    }
    check(`アイコン ${size} ${purpose}`, ok, detail);
  }
  const swInfo = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { scope: reg?.scope, active: reg?.active?.state, controlled: !!navigator.serviceWorker.controller };
  });
  check('SW のスコープが start_url を含み、起動ページを制御', swInfo.scope === BASE && swInfo.active === 'activated' && swInfo.controlled, JSON.stringify(swInfo));

  // ===== 9. 全制覇の演出 =====
  const full = {
    format: 'gunma-golf-conquest-backup', version: 1,
    rounds: COURSES.map((c, i) => ({
      id: `full-${c.id}`, course_id: c.id, course_name: c.name,
      date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 27)).padStart(2, '0')}`,
      score: 80 + (i % 20), memo: '',
    })),
  };
  const fullPath = path.join(OUT, 'full-62.json');
  fs.writeFileSync(fullPath, JSON.stringify(full));
  await page.setInputFiles('#import-file', fullPath);
  await page.waitForSelector('#confirm-dialog[open]');
  await page.click('#confirm-ok');
  await page.waitForSelector('#celebrate-dialog[open]', { timeout: 5000 }).catch(() => {});
  check('全制覇で演出が出る', await page.evaluate(() => document.getElementById('celebrate-dialog').open));
  await sleep(2600);
  await shot('n390-celebrate');
  check('演出の達磨にもう片方の目', (await page.locator('#celebrate-art .d-pupil-2').count()) === 1);
  await page.click('#celebrate-dialog [data-close]');
  await tab('home');
  check('進捗の達磨も両目', (await page.locator('#view-home .hero .d-pupil-2').count()) === 1);
  await shot('n390-home-complete');

  // ===== 10. 広い画面（840px） =====
  await page.setViewportSize({ width: 840, height: 900 });
  await sleep(300);
  await shot('w840-home');
  await noHScroll('840 進捗');
  await tapTargets('840 進捗');
  await tab('list');
  await openCourse(29);
  await shot('w840-list-detail');
  await noHScroll('840 一覧＋詳細');
  await tapTargets('840 一覧＋詳細');
  const panes = await page.evaluate(() => {
    const l = document.getElementById('list-pane').getBoundingClientRect();
    const d = document.getElementById('detail').getBoundingClientRect();
    return { l: [Math.round(l.left), Math.round(l.width)], d: [Math.round(d.left), Math.round(d.width)] };
  });
  check('840：2ペイン（左に一覧、右に詳細）', panes.l[0] === 0 && panes.d[0] >= panes.l[1] - 1 && panes.d[1] > 300, JSON.stringify(panes));
  await page.click('#open-filter');
  await shot('w840-filter');
  await page.click('#filter-done');
  await page.click('#add-round');
  check('840：＋記録は選択中のコースで開く', (await page.inputValue('#round-course')) === '29');
  await shot('w840-round-dialog');
  await page.click('#round-dialog .sheet-actions [data-close]');
  await tab('guide');
  await shot('w840-guide');
  await noHScroll('840 見方');
  await tab('settings');
  await shot('w840-settings');
  await noHScroll('840 設定');
  await tapTargets('840 設定');

  // ===== 11. ダークモード・コントラスト・動きを減らす =====
  const pairs = [
    ['--text', '--bg'], ['--text', '--surface'], ['--muted', '--surface'], ['--muted', '--bg'],
    ['--on-primary', '--primary'], ['--primary', '--surface'], ['--on-bar', '--bar'], ['--on-primary-soft', '--primary-soft'],
    ['--on-primary-soft', '--surface'], ['--red', '--surface'], ['--on-red', '--red'], ['--on-warn', '--warn-bg'], ['--on-banner', '--banner-bg'],
    ['--cool-3', '--surface'], ['--cool-2', '--surface'], ['--cool-1', '--surface'], ['--cool-0', '--surface'],
    ['--diff-4-fg', '--diff-4-bg'], ['--diff-3-fg', '--diff-3-bg'], ['--diff-2-fg', '--diff-2-bg'], ['--diff-1-fg', '--diff-1-bg'],
  ];
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const low = await page.evaluate((ps) => {
      const cs = getComputedStyle(document.documentElement);
      const lum = (hex) => {
        const h = hex.trim().replace('#', '');
        const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
      };
      return ps.map(([f, b]) => {
        const a = lum(cs.getPropertyValue(f));
        const c = lum(cs.getPropertyValue(b));
        return [f, b, (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05)];
      }).filter((x) => x[2] < 4.5).map((x) => `${x[0]}/${x[1]} ${x[2].toFixed(2)}`);
    }, pairs);
    check(`コントラスト4.5:1以上（${scheme}）`, low.length === 0, low.join(' | '));
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await tab('list');
  await shot('w840-dark-list-detail');
  await tab('home');
  await shot('w840-dark-home');
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  await shot('n390-dark-home');
  await tab('list');
  await shot('n390-dark-list');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const dur = await page.evaluate(() => {
    const d = document.createElement('div');
    d.innerHTML = '<svg><circle class="d-pupil-2 is-painting" r="1"/></svg>';
    document.body.append(d);
    const v = getComputedStyle(d.querySelector('circle')).animationDuration;
    d.remove();
    return v;
  });
  check('動きを減らす設定で演出アニメーションを止める', parseFloat(dur) < 0.001, dur);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ===== 12. 更新の通知 =====
  const swPath = path.join(SITE, 'sw.js');
  fs.writeFileSync(swPath, fs.readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']+';/, "const VERSION = '9.9.9-verify';"));
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForFunction(() => !document.getElementById('banner').hidden && document.getElementById('banner-btn').textContent.includes('新しいバージョン'), null, { timeout: 15000 });
  check('アプリ更新時に「新しいバージョンがあります」', true);
  await shot('n390-update-banner');
  await Promise.all([page.waitForEvent('load'), page.click('#banner-btn')]);
  await tab('settings');
  await page.waitForFunction(() => document.getElementById('app-version')?.textContent === '9.9.9-verify', null, { timeout: 10000 }).catch(() => {});
  check('タップで新しい版に切り替わる', (await page.textContent('#app-version')) === '9.9.9-verify', await page.textContent('#app-version'));
  check('更新後も記録が残る', (await page.textContent('#appbar-count')).includes(`${COURSES.length} / ${COURSES.length}`));

  const dataPath = path.join(SITE, 'courses.json');
  fs.writeFileSync(dataPath, fs.readFileSync(dataPath, 'utf8').replace(`"as_of": "${DATA.as_of}"`, '"as_of": "2099-01-verify"'));
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('banner').hidden && document.getElementById('banner-btn').textContent.includes('コースデータ'), null, { timeout: 15000 });
  check('courses.json だけ差し替えても「コースデータが更新されました」', true);
  await Promise.all([page.waitForEvent('load'), page.click('#banner-btn')]);
  await tab('guide');
  check('タップで新しいコースデータになる', (await page.textContent('#view-guide')).includes('2099-01-verify'));

  check('コンソールエラーなし', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  check('検証スクリプトが最後まで走った', false, e.stack || e);
  await shot('failure').catch(() => {});
} finally {
  await browser.close();
  server.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const ng = results.filter((r) => !r.ok);
  console.log(`\n${results.length - ng.length} / ${results.length} OK${ng.length ? `、NG ${ng.length} 件` : ''}`);
  process.exitCode = ng.length ? 1 : 0;
}
