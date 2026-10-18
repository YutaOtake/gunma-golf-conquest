// 記録の保存先（IndexedDB）。この端末の中だけに置き、外部へは送らない。
// rounds: 1ラウンド＝1件（id は文字列、course_id でコースに紐づく）
// meta:   書き出し日時などの小さな値

const DB_NAME = 'gunma-golf-conquest';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) {
      reject(new Error('IndexedDB を使えないブラウザです'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('rounds')) {
        const store = db.createObjectStore('rounds', { keyPath: 'id' });
        store.createIndex('course_id', 'course_id');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('別のタブがデータベースを使っています。ほかのタブを閉じてください。'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('保存が中断されました'));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllRounds() {
  const db = await open();
  return result(db.transaction('rounds').objectStore('rounds').getAll());
}

export async function putRounds(rounds) {
  const db = await open();
  const tx = db.transaction('rounds', 'readwrite');
  const store = tx.objectStore('rounds');
  for (const r of rounds) store.put(r);
  return done(tx);
}

export async function deleteRound(id) {
  const db = await open();
  const tx = db.transaction('rounds', 'readwrite');
  tx.objectStore('rounds').delete(id);
  return done(tx);
}

export async function clearRounds() {
  const db = await open();
  const tx = db.transaction('rounds', 'readwrite');
  tx.objectStore('rounds').clear();
  return done(tx);
}

export async function getMeta(key) {
  const db = await open();
  const row = await result(db.transaction('meta').objectStore('meta').get(key));
  return row ? row.value : undefined;
}

export async function setMeta(key, value) {
  const db = await open();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  return done(tx);
}
