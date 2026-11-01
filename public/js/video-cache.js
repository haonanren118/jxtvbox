/**
 * 视频分片本地缓存层（移植自 LibreTV src/lib/video-cache.ts）。
 * Cache Storage 读写 + IndexedDB segmentMeta 元数据 + LRU 淘汰。
 *
 * 为什么不用 Service Worker：播放器本来就在替换 hls.js 的 loader，
 * 叠加 cache-first 零注册成本；跨域片段经 SW 拦截拿到的是 opaque response，
 * cache.put 存不了内容。
 *
 * key 一致性是缓存命中的前提：loader 侧与预取侧对同一分片必须生成同一个 key
 * （都经 new URL() 归一化，并以文档基址锚定本站根相对的代理形式）。
 */

import { documentBaseURI } from './m3u8-util.js';
import { getSegmentMeta, putSegmentMeta, deleteSegmentMeta, clearSegmentMeta } from './db.js';

export const VIDEO_CACHE_NAME = 'jxtvbox-video-v1';

export const DEFAULT_CACHE_SETTINGS = {
  enabled: true,
  // 预取窗口 90s：覆盖 hls.js 缓冲（60s）即可，再长只是与播放抢服务端出站
  // （源站单 IP 限速 ~200KB/s）。0 = 暂停时铺满整集（黄金窗口），仍支持。
  horizonSeconds: 90,
  maxBytesPerEpisode: 800 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

const SETTINGS_KEY = 'jxtvbox-video-cache-settings';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function normalizeCacheSettings(input) {
  const raw = input ?? {};
  return {
    enabled: raw.enabled !== false,
    horizonSeconds: raw.horizonSeconds === 0 ? 0 : clamp(raw.horizonSeconds ?? DEFAULT_CACHE_SETTINGS.horizonSeconds, 60, 7200),
    maxBytesPerEpisode: clamp(raw.maxBytesPerEpisode ?? DEFAULT_CACHE_SETTINGS.maxBytesPerEpisode, 50 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
    maxTotalBytes: clamp(raw.maxTotalBytes ?? DEFAULT_CACHE_SETTINGS.maxTotalBytes, 100 * 1024 * 1024, 20 * 1024 * 1024 * 1024),
  };
}

export function loadCacheSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return normalizeCacheSettings(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_CACHE_SETTINGS };
  }
}

export function saveCacheSettings(next) {
  const merged = normalizeCacheSettings({ ...loadCacheSettings(), ...next });
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  } catch { /* 隐私模式等场景忽略 */ }
  return merged;
}

/** 分片缓存 key：归一化成绝对地址（两侧一致，缓存命中的前提） */
export function buildSegmentCacheKey(segmentUrl) {
  try {
    return new URL(segmentUrl, documentBaseURI() ?? undefined).href;
  } catch {
    return segmentUrl;
  }
}

let cacheApi = null;
function getCacheApi() {
  if (!cacheApi && typeof caches !== 'undefined') {
    cacheApi = caches.open(VIDEO_CACHE_NAME);
  }
  return cacheApi;
}

/** 读缓存分片；命中返回 { data: ArrayBuffer, costMs } */
export async function readCachedSegment(key) {
  const api = getCacheApi();
  if (!api) return null;
  try {
    const cache = await api;
    const hit = await cache.match(key);
    if (!hit) return null;
    const data = await hit.arrayBuffer();
    const meta = await getSegmentMeta(key);
    return { data, costMs: meta?.costMs ?? 0 };
  } catch {
    return null;
  }
}

/** 写缓存分片 */
export async function writeCachedSegment(key, data, costMs) {
  const api = getCacheApi();
  if (!api) return;
  try {
    const cache = await api;
    await cache.put(key, new Response(data, { headers: { 'Content-Length': String(data.byteLength) } }));
    await putSegmentMeta(key, { costMs, bytes: data.byteLength, updatedAt: Date.now() });
  } catch { /* 配额超限等场景忽略 */ }
}

export async function touchMeta(key) {
  const meta = await getSegmentMeta(key);
  if (meta) await putSegmentMeta(key, { ...meta, updatedAt: Date.now() });
}

/** 清空分片缓存（设置页「清除缓存」用） */
export async function clearVideoCache() {
  const api = getCacheApi();
  if (api) {
    try {
      const cache = await api;
      const keys = await cache.keys();
      await Promise.all(keys.map((k) => cache.delete(k)));
    } catch { /* 忽略 */ }
  }
  await clearSegmentMeta();
}

/** 估算缓存占用（设置页展示） */
export async function estimateCacheBytes() {
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      return est.usage ?? 0;
    } catch { /* 忽略 */ }
  }
  return 0;
}
