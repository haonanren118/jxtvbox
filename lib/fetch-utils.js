/**
 * 服务端上游请求工具：超时、重试、安全跳转、内存 TTL 缓存。
 * 移植自 LibreTV src/lib/fetch-utils.ts。
 *
 * 安全跳转（默认开启）：禁用 fetch 的自动跟随，改为手动逐跳跟随，
 * 每一跳重新执行 SSRF 校验——否则公网 URL 可 302 跳转到内网地址绕过预检。
 */

import { checkLiveUrlAllowed, checkUpstreamAllowed } from './ssrf.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_HOPS = 5;

/**
 * 手动逐跳跟随重定向，每一跳重新执行 SSRF 校验。
 */
export async function fetchWithSafeRedirects(url, init = {}, options = {}) {
  const { allowPrivate = false, headerTimeoutMs } = options;
  let current = url;
  const controller = new AbortController();
  if (init.signal) {
    if (init.signal.aborted) controller.abort(init.signal.reason);
    else init.signal.addEventListener('abort', () => controller.abort(init.signal?.reason), { once: true });
  }
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const verdict = allowPrivate
      ? await checkLiveUrlAllowed(current)
      : await checkUpstreamAllowed(current);
    if (!verdict.ok) {
      throw new Error(`跳转目标被拒绝: ${verdict.reason}`);
    }
    const timer = headerTimeoutMs ? setTimeout(() => controller.abort(), headerTimeoutMs) : null;
    let res;
    try {
      res = await fetch(current, { ...init, signal: controller.signal, redirect: 'manual' });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!REDIRECT_STATUSES.has(res.status)) return { res, finalUrl: current };
    const location = res.headers.get('location');
    if (!location) return { res, finalUrl: current };
    current = new URL(location, current).href;
  }
  throw new Error('重定向次数过多');
}

export async function fetchUpstream(url, options = {}) {
  return (await fetchUpstreamWithMeta(url, options)).res;
}

/** 同 fetchUpstream，额外返回重定向后的最终 URL（解析 manifest 相对地址必须用它） */
export async function fetchUpstreamWithMeta(url, options = {}) {
  const { timeoutMs = 8000, retries = 0, safeRedirects = true, allowPrivate = false, ...init } = options;
  // 外部 signal（调用方的总死线中断）与单次超时合并：任一触发即中断请求
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (!safeRedirects) {
        const res = await fetch(url, { ...init, signal, redirect: init.redirect ?? 'follow' });
        return { res, finalUrl: res.url || url };
      }
      return await fetchWithSafeRedirects(url, { ...init, signal }, { allowPrivate });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('上游请求失败');
}

/** 内存 TTL 缓存（搜索结果等热点数据） */
const cache = new Map();

export function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCache(key, value, ttlMs) {
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now > v.expiresAt) cache.delete(k);
    }
    if (cache.size > 500) cache.clear();
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
