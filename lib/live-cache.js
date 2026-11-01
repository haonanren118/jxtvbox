/**
 * 直播模块专用的大对象 TTL 缓存（播放列表 / EPG 节目单等）。
 * 移植自 LibreTV src/lib/live-cache.ts：
 * 独立实例 + 按字节数与条目数双重上限，超限逐出最旧条目
 * （不与搜索缓存混用，避免一个几十 MB 的 EPG 条目清掉热点数据）。
 */

const MAX_ENTRIES = 10;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256MB

const store = new Map();

export function getLiveCache(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setLiveCache(key, value, ttlMs, sizeHint) {
  const now = Date.now();
  const bytes = Math.max(sizeHint ?? 0, 64 * 1024);

  for (const [k, v] of store.entries()) {
    if (now > v.expiresAt) store.delete(k);
  }

  while (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  let total = 0;
  for (const v of store.values()) total += v.bytes;
  while (total + bytes > MAX_TOTAL_BYTES && store.size > 0) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    total -= store.get(oldest).bytes;
    store.delete(oldest);
  }

  store.set(key, { value, expiresAt: now + ttlMs, bytes });
}
