/**
 * IndexedDB 存储（零依赖，替代 LibreTV 的 Dexie）。
 * 库 jxtvbox-db：
 * - progress    播放进度 key=`${sourceKey}|${vodId}|${episode}` → {position,duration,updatedAt}
 * - history     观看历史 key=`${sourceKey}|${vodId}` → {...,episodeIndex,cover,title}
 * - searchHist  搜索历史 key=wd → {wd, updatedAt}
 * - settings    设置 key-value
 * - quality     画质记录 key=`${sourceKey}|${vodId}` → {height, from, timestamp}
 * - segmentMeta 分片缓存元数据 key=分片URL → {costMs, bytes, updatedAt}
 */

const DB_NAME = 'jxtvbox-db';
const DB_VERSION = 1;

let dbPromise = null;

export function getDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress');
        if (!db.objectStoreNames.contains('history')) db.createObjectStore('history');
        if (!db.objectStoreNames.contains('searchHist')) db.createObjectStore('searchHist');
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
        if (!db.objectStoreNames.contains('quality')) db.createObjectStore('quality');
        if (!db.objectStoreNames.contains('segmentMeta')) db.createObjectStore('segmentMeta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// —— 播放进度 ——

export function progressKeyOf(sourceKey, vodId, episode) {
  return `${sourceKey}|${vodId}|${episode ?? 0}`;
}

export async function getProgress(key) {
  const db = await getDB();
  return (await wrap(tx(db, 'progress', 'readonly').get(key))) ?? null;
}

export async function saveProgress(key, position, duration) {
  const db = await getDB();
  await wrap(tx(db, 'progress', 'readwrite').put({ position, duration, updatedAt: Date.now() }, key));
}

export async function clearProgress(key) {
  const db = await getDB();
  await wrap(tx(db, 'progress', 'readwrite').delete(key));
}

// —— 观看历史 ——

export async function upsertHistory(entry) {
  const db = await getDB();
  const store = tx(db, 'history', 'readwrite');
  const key = `${entry.sourceKey}|${entry.vodId}`;
  const prev = (await wrap(store.get(key))) ?? {};
  await wrap(store.put({ ...prev, ...entry, updatedAt: Date.now() }, key));
}

export async function listHistory(limit = 100) {
  const db = await getDB();
  const all = (await wrap(tx(db, 'history', 'readonly').getAll())) ?? [];
  return all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, limit);
}

export async function deleteHistory(key) {
  const db = await getDB();
  await wrap(tx(db, 'history', 'readwrite').delete(key));
}

export async function clearHistory() {
  const db = await getDB();
  await wrap(tx(db, 'history', 'readwrite').clear());
}

// —— 搜索历史 ——

export async function addSearchHistory(wd) {
  const db = await getDB();
  await wrap(tx(db, 'searchHist', 'readwrite').put({ wd, updatedAt: Date.now() }, wd));
}

export async function listSearchHistory(limit = 20) {
  const db = await getDB();
  const all = (await wrap(tx(db, 'searchHist', 'readonly').getAll())) ?? [];
  return all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, limit).map((x) => x.wd);
}

export async function removeSearchHistory(wd) {
  const db = await getDB();
  await wrap(tx(db, 'searchHist', 'readwrite').delete(wd));
}

export async function clearSearchHistory() {
  const db = await getDB();
  await wrap(tx(db, 'searchHist', 'readwrite').clear());
}

// —— 设置（key-value） ——

export async function getSetting(key, fallback) {
  try {
    const db = await getDB();
    const v = await wrap(tx(db, 'settings', 'readonly').get(key));
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export async function setSetting(key, value) {
  const db = await getDB();
  await wrap(tx(db, 'settings', 'readwrite').put(value, key));
}

// —— 画质记录 ——

export async function getQuality(key) {
  const db = await getDB();
  return (await wrap(tx(db, 'quality', 'readonly').get(key))) ?? null;
}

export async function saveQuality(key, height, from) {
  const db = await getDB();
  const prev = (await wrap(tx(db, 'quality', 'readonly').get(key))) ?? {};
  // play（播放器实测）优先级高于 probe；同来源取更大高度
  if (prev.from === 'play' && from === 'probe') return;
  if (prev.from === from && prev.height >= height) return;
  await wrap(tx(db, 'quality', 'readwrite').put({ height, from, timestamp: Date.now() }, key));
}

// —— 分片缓存元数据 ——

export async function getSegmentMeta(key) {
  const db = await getDB();
  return (await wrap(tx(db, 'segmentMeta', 'readonly').get(key))) ?? null;
}

export async function putSegmentMeta(key, meta) {
  const db = await getDB();
  await wrap(tx(db, 'segmentMeta', 'readwrite').put(meta, key));
}

export async function deleteSegmentMeta(key) {
  const db = await getDB();
  await wrap(tx(db, 'segmentMeta', 'readwrite').delete(key));
}

export async function clearSegmentMeta() {
  const db = await getDB();
  await wrap(tx(db, 'segmentMeta', 'readwrite').clear());
}
