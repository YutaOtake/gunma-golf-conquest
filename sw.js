// Service Worker：全ファイルを端末にキャッシュして完全オフラインで動かす。
//
// ■ アプリ（HTML/CSS/JS/アイコン）を直したとき → 下の VERSION を1つ上げて push する。
//   端末側では次の起動時に「新しいバージョンがあります」が出て、タップで切り替わる。
// ■ courses.json だけを差し替えたとき → VERSION は変えなくてよい。
//   起動のたびに裏で courses.json を見比べ、変わっていれば「コースデータが更新されました」が出る。

const VERSION = '1.3.0';
const CACHE_PREFIX = 'gunma-golf-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'db.js',
  'rating.js',
  'courses.json',
  'yomi.json',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-192.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
];

const DATA_URL = new URL('courses.json', self.location).href;
const INDEX_URL = new URL('index.html', self.location).href;

self.addEventListener('install', (event) => {
  // 新しい版は「待機」で止めておき、利用者がタップしたら切り替える（skipWaiting は message で）
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (msg.type === 'GET_VERSION' && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION });
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部サイト（地図・公式サイト）には触らない

  if (req.mode === 'navigate') {
    event.respondWith(appShell(req));
    return;
  }
  if (url.origin + url.pathname === DATA_URL) {
    event.respondWith(courseData(event));
    return;
  }
  event.respondWith(cacheFirst(req));
});

async function appShell(req) {
  const cache = await caches.open(CACHE);
  const hit = (await cache.match(INDEX_URL)) || (await cache.match(req, { ignoreSearch: true }));
  if (hit) return hit;
  return fetch(req);
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

// courses.json：手元の版をすぐ返し、裏でサーバーの版と見比べる（stale-while-revalidate）
async function courseData(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(DATA_URL);
  // 先に複製しておく（cached はページへ返すので、後からは複製できない）
  const oldText = cached ? cached.clone().text() : Promise.resolve(null);
  const refresh = (async () => {
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) return;
      const fresh = await res.clone().text();
      const old = await oldText;
      if (fresh === old) return;
      try {
        const parsed = JSON.parse(fresh);
        if (!Array.isArray(parsed.courses)) return; // 壊れたデータでは置き換えない
      } catch {
        return;
      }
      await cache.put(DATA_URL, res);
      if (old !== null) await notifyClients({ type: 'DATA_UPDATED' });
    } catch {
      // オフライン：手元の版のまま
    }
  })();

  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  await refresh;
  return (await cache.match(DATA_URL)) || fetch(DATA_URL);
}

async function notifyClients(msg) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(msg);
}
