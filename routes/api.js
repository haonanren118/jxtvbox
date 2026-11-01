/**
 * API 路由：鉴权 / 聚合搜索 / 详情 / 代理 / 直播 / 源管理 / 状态。
 *
 * 与 LibreTV 的对应关系：
 * - /api/search   ← src/app/api/search/route.ts（并行 + 死线 + 多页 + 缓存 + 流式）
 *                  + 服务端健康度停用（LibreTV 此前逻辑在前端，JXTVbox 上移服务端）
 * - /api/detail   ← src/app/api/detail/route.ts（列表接口优先，详情页 HTML 兜底）
 * - /api/proxy    ← src/lib/proxy-handlers.ts（m3u8 重写 + 广告过滤 + 流式透传）
 * - /api/live/*   ← live/playlist · live/epg · live/stream
 * - /api/sources  ← 新增：服务端源配置持久化（优化点）
 */

import { Router } from './router.js';
import {
  cmsRequestHeaders,
  filterAdultResults,
  filterRelevantResults,
  normalizeTitle,
  parseDetail,
  parseDetailPageHtml,
  parseSearchList,
} from '../lib/cms-parser.js';
import { fetchUpstream, fetchUpstreamWithMeta, getCache, setCache } from '../lib/fetch-utils.js';
import { checkLiveUrlAllowed, checkUpstreamAllowed, isValidProxyUrl, isBlockedByDNS } from '../lib/ssrf.js';
import { rewriteM3u8, stripAdGroups } from '../lib/m3u8.js';
import { parseM3u } from '../lib/m3u-parser.js';
import { parseXmltv, currentAndNext } from '../lib/xmltv.js';
import { getLiveCache, setLiveCache } from '../lib/live-cache.js';
import {
  listSources,
  saveSources,
  listDramaSources,
  saveDramaSources,
  normalizeSourceUrl,
  listLiveSources,
  saveLiveSources,
  getHealthSnapshot,
  isSourceDisabled,
  sourceDisabledRemaining,
  markSourceOk,
  markSourceFail,
  resetSourceHealth,
  resetAllHealth,
  mergeEnvSourcesOnBoot,
} from '../lib/source-store.js';
import {
  SESSION_COOKIE,
  checkPassword,
  checkRateLimit,
  clearRateLimit,
  cookieSecure,
  getPassword,
  isPasswordConfigured,
  sessionFromCookieHeader,
  signSession,
} from '../lib/auth.js';
import pkg from '../package.json' with { type: 'json' };

// —— 可调参数（环境变量） ——

// 搜索/详情缓存 5 分钟：采集站内容更新不频繁，反复搜同一关键词、重复进同一影片
// 不再打上游；源侧内容变化最长 5 分钟后可见（手动刷新页面即可强制重取）
const SEARCH_CACHE_TTL = 5 * 60 * 1000;
const DETAIL_CACHE_TTL = 5 * 60 * 1000;

/** 每个源最多抓取的页数（1-50，默认 5） */
const SEARCH_MAX_PAGES = (() => {
  const n = parseInt(process.env.SEARCH_MAX_PAGES || '5', 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(50, Math.max(1, n));
})();

/** 单源总死线（毫秒，3s-60s，默认 10000） */
const SEARCH_SOURCE_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.SEARCH_SOURCE_TIMEOUT_MS || '10000', 10);
  if (!Number.isFinite(n)) return 10000;
  return Math.min(60000, Math.max(3000, n));
})();

const PROXY_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT || '8000', 10);
const PROXY_MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '1', 10);
const PROXY_HEADER_TIMEOUT_MS = 15_000;
const LIVE_PLAYLIST_TTL = 5 * 60 * 1000;
const LIVE_EPG_TTL = 10 * 60 * 1000;

// —— 代理图片内存缓存（封面等小图） ——
// 封面走代理出站每次 0.5-1s，一屏 30 张并发会把 NAS 出口打满、拖慢同期 API。
// 只缓存 image/* 的 200 响应（≤1MB）；m3u8 流式透传，绝不缓存。
// Range 请求（视频拖动）不读不写缓存，避免与上游 Range 语义冲突。
const IMG_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时
const IMG_CACHE_MAX_ITEMS = 600;
const IMG_CACHE_MAX_BYTES = 256 * 1024 * 1024; // 总量上限 256MB
const IMG_CACHE_MAX_ONE = 1024 * 1024; // 单张上限 1MB
const imgCache = new Map(); // url -> { buf, contentType, bytes, expiresAt }
let imgCacheBytes = 0;

function imgCacheGet(url) {
  const hit = imgCache.get(url);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    imgCache.delete(url);
    imgCacheBytes -= hit.bytes;
    return null;
  }
  // LRU：命中后移到队尾
  imgCache.delete(url);
  imgCache.set(url, hit);
  return hit;
}

function imgCacheSet(url, contentType, buf) {
  const old = imgCache.get(url);
  if (old) {
    imgCache.delete(url);
    imgCacheBytes -= old.bytes;
  }
  // 超量先淘汰队首（最久未用）
  while (
    imgCache.size > 0 &&
    (imgCache.size + 1 > IMG_CACHE_MAX_ITEMS || imgCacheBytes + buf.length > IMG_CACHE_MAX_BYTES)
  ) {
    const oldestKey = imgCache.keys().next().value;
    const evict = imgCache.get(oldestKey);
    imgCache.delete(oldestKey);
    imgCacheBytes -= evict.bytes;
  }
  imgCache.set(url, { buf, contentType, bytes: buf.length, expiresAt: Date.now() + IMG_CACHE_TTL });
  imgCacheBytes += buf.length;
}

// —— 视频分片 / AES key 内存缓存（点播播放抗卡顿） ——
// 分片内容静态，但代理原本每片都出站（实测 3.5-7s/片）：重播、拖动回看、连播下一集
// 的片头重复请求全部打在上游。命中缓存的分片 2ms 返回，播放器缓冲不再等出站。
// 约束：仅 200 完整响应、无 Range、URL 形如 *.ts/*.m4s/*.key；m3u8 与直播不碰。
// TTL 30min：上游 cache-control 为 30 天（分片静态），半小时内重播/回看/连播零出站。
const SEG_CACHE_TTL = 30 * 60 * 1000;
const SEG_CACHE_MAX_ITEMS = 240;
const SEG_CACHE_MAX_BYTES = 512 * 1024 * 1024; // 总量上限 512MB
const SEG_CACHE_MAX_ONE = 8 * 1024 * 1024; // 单片上限 8MB
const segCache = new Map(); // url -> { buf, contentType, bytes, expiresAt }
let segCacheBytes = 0;

function isCacheableSegmentUrl(targetUrl, contentType) {
  if (contentType.includes('mpegurl')) return false; // 播放列表不缓存
  if (/\?/.test(targetUrl)) {
    // 带 query 的分片 URL 多为签名/会话地址（一次性），不缓存
    return false;
  }
  return /\.(ts|m4s|mp4|aac|key)$/i.test(targetUrl) || contentType.includes('video/mp2t');
}

function segCacheGet(url) {
  const hit = segCache.get(url);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    segCache.delete(url);
    segCacheBytes -= hit.bytes;
    return null;
  }
  segCache.delete(url);
  segCache.set(url, hit); // LRU 移到队尾
  return hit;
}

function segCacheSet(url, contentType, buf) {
  const old = segCache.get(url);
  if (old) {
    segCache.delete(url);
    segCacheBytes -= old.bytes;
  }
  while (
    segCache.size > 0 &&
    (segCache.size + 1 > SEG_CACHE_MAX_ITEMS || segCacheBytes + buf.length > SEG_CACHE_MAX_BYTES)
  ) {
    const oldestKey = segCache.keys().next().value;
    const evict = segCache.get(oldestKey);
    segCache.delete(oldestKey);
    segCacheBytes -= evict.bytes;
  }
  segCache.set(url, { buf, contentType, bytes: buf.length, expiresAt: Date.now() + SEG_CACHE_TTL });
  segCacheBytes += buf.length;
}

// —— 上游分片出站调度 ——
// 实测（2026-10-31，juliang→jimaoys88 CDN）：源站对单 IP 总带宽约 200KB/s，
// 且高频并发会触发更狠的限速（单连接从 ~400KB/s 劣化到 ~100KB/s，同片二次
// 下载从 3.5s 劣化到 9s）。播放 miss、前端预取、服务端预热三条路径都会出站，
// 无调度叠加 6-8 并发反而更卡。
// 策略：
// 1) 全局最多 UPSTREAM_SEG_MAX_CONCURRENT 个分片出站（普通请求 FIFO 排队）；
// 2) 同 URL 出站合并（upstreamSegFlights）：预热与播放不双拉同一片；
// 3) 预热不排队——无空位直接放弃本轮，把出站让给播放请求。
const UPSTREAM_SEG_MAX_CONCURRENT = 3;
let upstreamSegInFlightCount = 0;
const upstreamSegWaiters = []; // FIFO：普通优先级（播放 miss / 前端预取）
const upstreamSegFlights = new Map(); // url -> Promise（同 URL 合并）

function releaseUpstreamSeg() {
  upstreamSegInFlightCount--;
  const next = upstreamSegWaiters.shift();
  if (next && upstreamSegInFlightCount < UPSTREAM_SEG_MAX_CONCURRENT) {
    upstreamSegInFlightCount++;
    next();
  }
}

function acquireUpstreamSeg() {
  return new Promise((resolve) => {
    if (upstreamSegInFlightCount < UPSTREAM_SEG_MAX_CONCURRENT) {
      upstreamSegInFlightCount++;
      resolve();
    } else {
      upstreamSegWaiters.push(resolve);
    }
  });
}

/**
 * 分片出站并写入缓存。queue=false（预热）时无空位直接返回，不排队。
 * 同 URL 并发调用复用同一次出站；排队期间他人可能已写入缓存，出站前再查一次。
 */
function fetchSegmentThroughCache(t, { queue = true } = {}) {
  const existing = upstreamSegFlights.get(t);
  if (existing) return existing;
  const p = (async () => {
    if (queue) {
      await acquireUpstreamSeg();
    } else if (upstreamSegInFlightCount < UPSTREAM_SEG_MAX_CONCURRENT) {
      upstreamSegInFlightCount++;
    } else {
      return; // 无空位：本次不预热，让位给播放
    }
    try {
      if (segCacheGet(t)) return; // 排队期间已被他人写入
      const res = await fetchUpstream(t, { timeoutMs: 15000, headers: { 'User-Agent': UA, Accept: '*/*' } });
      if (!res.ok) return;
      const ct = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length <= SEG_CACHE_MAX_ONE) segCacheSet(t, ct || 'video/mp2t', buf);
    } catch {
      /* 失败静默：请求方按原路径重试，只是多一次出站 */
    } finally {
      releaseUpstreamSeg();
      upstreamSegFlights.delete(t);
    }
  })();
  upstreamSegFlights.set(t, p);
  return p;
}

// —— m3u8 分片预热（VOD 首播抗卡顿）——
// 播放器拿到播放列表后才逐片拉取，每片出站 3.5-7s（源站限速 ~200KB/s），开头必卡。
// 策略：
// 1) 第一片同步等（deadline PREFETCH_FIRST_DEADLINE_MS）：这是起播必经路径，等它
//    不增加总起播时长（hls.js 本来也要先下这片），但播放器拿到 m3u8 时第一片已热；
// 2) 其余前 SEG_PREFETCH_COUNT 片异步节奏预热（每片间隔 150ms、无空位让位）。
// 窗口 24 片：起播阶段源站带宽全用于蓄水（hls.js 只等第一片，不影响起播速度），
// 起播即得约 70-170s 缓冲；此后 2000kbps 播放（250KB/s）vs 源站 ~200KB/s 的
// 供给缺口由厚缓冲 + 前端预取兜底。短剧（3-6s/片）≈ 72-144s，正剧（7s/片）≈ 168s。
// 实测：短剧源（jimaoys88）热连接快，6s 内 16 片全热；正剧源（maowushi）持续
// ~200KB/s，8s 热 5 片、38s 热 24 片——正剧码率低（668kbps 需 83.5KB/s），
// 60s hls 缓冲足以覆盖预热期，起播不卡。
// 3) 只对 VOD 列表预热（#EXT-X-ENDLIST / PLAYLIST-TYPE:VOD），直播分片一次性不碰。
const SEG_PREFETCH_COUNT = 24;
const PREFETCH_FIRST_DEADLINE_MS = 6000;
const PREFETCH_REST_INTERVAL_MS = 150;

function isVodPlaylist(text) {
  return /#EXT-X-ENDLIST/.test(text) || /#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text);
}

/** 从（已改写为 /api/proxy 的）播放列表行首抓分片 URL；行内 URI（如 EXT-X-KEY）不占额度 */
function collectSegmentTargets(rewrittenM3u8, count) {
  const targets = [];
  for (const m of rewrittenM3u8.matchAll(/^\/api\/proxy\?url=([^&\s"]+)/gm)) {
    let abs;
    try { abs = decodeURIComponent(m[1]); } catch { continue; }
    if (!/\?/.test(abs) && /\.(ts|m4s|mp4)$/i.test(abs) && !segCacheGet(abs)) targets.push(abs);
    if (targets.length >= count) break;
  }
  return targets;
}

/** 预热：等第一片（deadline）后 resolve；其余后台节奏预热，不阻塞响应 */
async function prefetchSegments(rewrittenM3u8) {
  if (!isVodPlaylist(rewrittenM3u8)) return; // 直播/滚动列表不预热
  const targets = collectSegmentTargets(rewrittenM3u8, SEG_PREFETCH_COUNT);
  if (targets.length === 0) return;

  // 第一片：同步等（起播必经路径）。deadline 到了也放行——hls.js 自己拉，多一次出站。
  await Promise.race([
    fetchSegmentThroughCache(targets[0]),
    new Promise((r) => setTimeout(r, PREFETCH_FIRST_DEADLINE_MS)),
  ]);

  // 其余片：节奏预热。无空位即让位（fetchSegmentThroughCache queue=false）。
  const rest = targets.slice(1);
  const step = (i) => {
    if (i >= rest.length) return;
    const t = rest[i];
    if (segCacheGet(t)) { step(i + 1); return; }
    fetchSegmentThroughCache(t, { queue: false }).finally(() =>
      setTimeout(() => step(i + 1), PREFETCH_REST_INTERVAL_MS));
  };
  step(0);
}

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function isTimeoutError(err) {
  const candidates = [err, err instanceof Error ? err.cause : undefined];
  return candidates.some((e) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError'));
}

// —— 鉴权守卫 ——

function guard(req) {
  if (!isPasswordConfigured()) {
    return { status: 503, body: { error: '服务器未设置 PASSWORD 环境变量' } };
  }
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) {
    return { status: 401, body: { error: '未登录' } };
  }
  return null;
}

// —— 聚合搜索（含服务端健康度） ——

function searchCacheKey(wd, sources, filterAdult) {
  const urls = sources.map((s) => s.url.replace(/\/+$/, '')).sort().join('|');
  return `search:${wd}\n${filterAdult ? 1 : 0}\n${urls}`;
}

/**
 * 单源搜索：先取第一页并读取 pagecount，再并行抓后续页（上限 SEARCH_MAX_PAGES），
 * 整源受 SEARCH_SOURCE_TIMEOUT_MS 总死线约束。成功/失败都会回写健康度。
 */
async function searchSource(source, wd) {
  const start = Date.now();
  const finish = (outcome) => ({ ...outcome, ms: Date.now() - start });

  if (!/^https?:\/\//.test(source.url || '')) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: '无效的源地址' });
  }
  // 健康度自动停用：到点前直接跳过，不浪费死线时间
  const health = getHealthSnapshot()[source.url];
  if (health?.disabled) {
    const remain = sourceDisabledRemaining(health);
    const text = remain === Infinity ? '长期停用（连续失败）' : `停用中（约 ${Math.ceil(remain / 60000)} 分钟后恢复）`;
    return finish({ sourceKey: source.key, ok: false, list: [], error: `源已自动${text}`, skipped: true });
  }
  // 用户可控地址发起服务端请求，必须先过 SSRF 校验
  const verdict = await checkUpstreamAllowed(source.url);
  if (!verdict.ok) {
    return finish({ sourceKey: source.key, ok: false, list: [], error: verdict.reason });
  }

  const controller = new AbortController();
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => {
      controller.abort(new DOMException('源搜索超时', 'TimeoutError'));
      resolve(finish({
        sourceKey: source.key,
        ok: false,
        list: [],
        error: `请求超时（>${Math.round(SEARCH_SOURCE_TIMEOUT_MS / 1000)}s）`,
        timedOut: true,
      }));
    }, SEARCH_SOURCE_TIMEOUT_MS);
  });

  const base = source.url.replace(/\/+$/, '');
  const fetchPage = async (page) => {
    const api = `${base}?ac=videolist&wd=${encodeURIComponent(wd)}&pg=${page}`;
    const res = await fetchUpstream(api, {
      timeoutMs: 8000,
      headers: cmsRequestHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const run = async () => {
    const first = await fetchPage(1);
    const list = parseSearchList(first, source);
    const rawPageCount = parseInt(String(first.pagecount ?? '1'), 10);
    const pageCount = Math.min(Number.isFinite(rawPageCount) ? Math.max(1, rawPageCount) : 1, SEARCH_MAX_PAGES);
    if (pageCount > 1) {
      const extraPages = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, i) => i + 2).map(async (page) => {
          try {
            return parseSearchList(await fetchPage(page), source);
          } catch {
            return [];
          }
        })
      );
      list.push(...extraPages.flat());
    }
    return { sourceKey: source.key, ok: true, list };
  };

  try {
    const runPromise = run()
      .then(finish)
      .catch((err) => finish({
        sourceKey: source.key,
        ok: false,
        list: [],
        error: err instanceof Error ? err.message : '请求失败',
        timedOut: isTimeoutError(err),
      }));
    const outcome = await Promise.race([runPromise, deadline]);
    if (outcome.ok) markSourceOk(source.url);
    else markSourceFail(source.url, outcome.error);
    return outcome;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/** 合并 + 去重 + 过滤 + 排序 */
function aggregateOutcomes(outcomes, wd, filterAdult) {
  const seen = new Set();
  let list = outcomes.flatMap((o) => o.list).filter((item) => {
    const key = `${item.sourceKey}_${item.vodId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  list = filterAdultResults(list, filterAdult);
  list = filterRelevantResults(list, wd);

  const exact = normalizeTitle(wd);
  list.sort((a, b) => {
    const aExact = normalizeTitle(a.name || '') === exact ? 0 : 1;
    const bExact = normalizeTitle(b.name || '') === exact ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const nameCompare = (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN');
    if (nameCompare !== 0) return nameCompare;
    return (a.sourceName || '').localeCompare(b.sourceName || '', 'zh-Hans-CN');
  });

  const failures = outcomes
    .filter((o) => !o.ok)
    .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut, skipped: o.skipped }));

  return { list, failures };
}

export function registerApiRoutes(app) {
  const api = new Router('/api');

  // —— 鉴权 ——

  api.post('/login', async (req) => {
    if (!isPasswordConfigured()) {
      return { status: 503, body: { error: '服务器未设置 PASSWORD 环境变量' } };
    }
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    if (!checkRateLimit(ip)) {
      return { status: 429, body: { error: '尝试次数过多，请 10 分钟后再试' } };
    }
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    if (!checkPassword(String(body?.password ?? ''))) {
      return { status: 401, body: { error: '密码错误' } };
    }
    clearRateLimit(ip);
    const { token, expiresAt } = signSession();
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}${cookieSecure(req) ? '; Secure' : ''}`,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  });

  api.post('/logout', async () => {
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  });

  api.get('/status', async (req) => {
    const configured = isPasswordConfigured();
    const verified = configured && sessionFromCookieHeader(req.headers.get('cookie'));
    return {
      status: 200,
      body: {
        passwordRequired: !configured,
        verified,
        version: pkg.version,
      },
    };
  });

  // —— 聚合搜索 ——

  api.post('/search', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }

    const wd = (body.wd || '').trim();
    if (!wd || wd.length > 100) {
      return { status: 400, body: { error: '搜索关键词无效' } };
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return { status: 400, body: { error: '请至少选择一个点播源' } };
    }
    const sources = body.sources.slice(0, 50);
    const filterAdult = body.filterAdult !== false;

    const cacheKey = searchCacheKey(wd, sources, filterAdult);
    const cached = getCache(cacheKey);
    if (cached) return { status: 200, body: cached };

    const outcomes = await Promise.all(sources.map((source) => searchSource(source, wd)));
    const payload = aggregateOutcomes(outcomes, wd, filterAdult);
    setCache(cacheKey, payload, SEARCH_CACHE_TTL);
    return { status: 200, body: payload };
  });

  // —— 视频详情 ——

  api.get('/detail', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    const url = new URL(req.url, 'http://localhost');
    const id = (url.searchParams.get('id') || '').trim();
    const source = (() => {
      const raw = url.searchParams.get('source');
      if (!raw) return null;
      try {
        const obj = JSON.parse(raw);
        if (!obj || !/^https?:\/\//.test(obj.url || '')) return null;
        return obj;
      } catch {
        return null;
      }
    })();
    const baseUrl = (url.searchParams.get('baseUrl') || '').trim();
    const wd = (url.searchParams.get('wd') || '').trim().slice(0, 60);

    if (!id || !/^[\w-]+$/.test(id)) {
      return { status: 400, body: { error: '无效的视频ID' } };
    }
    if (!source) {
      return { status: 400, body: { error: '无效的点播源配置' } };
    }

    try {
      const detailRoot = (source.detail || baseUrl || new URL(source.url).origin).replace(/\/+$/, '');
      const cacheKey = `detail:${source.url}|${detailRoot}|${id}`;
      const cached = getCache(cacheKey);
      if (cached) return { status: 200, body: cached };

      const listVerdict = await checkUpstreamAllowed(source.url);
      if (!listVerdict.ok) return { status: 400, body: { error: listVerdict.reason } };

      let resolved = null;

      // 1) 标准列表接口（按 ID 查询）
      const api = `${source.url.replace(/\/+$/, '')}?ac=videolist&ids=${encodeURIComponent(id)}`;
      const res = await fetchUpstream(api, { timeoutMs: 10000, headers: cmsRequestHeaders() });
      if (res.ok) {
        const data = await res.json();
        try {
          const detail = parseDetail(data, source);
          if (detail.episodes.length > 0) resolved = detail;
        } catch {
          // 列表接口无内容 → 继续尝试关键词查询
        }
      }

      // 2) 关键词回退查询：部分采集站（如巨量资源）禁用 ids 查询，但 wd 查询返回完整数据
      if (!resolved && wd) {
        const wdApi = `${source.url.replace(/\/+$/, '')}?ac=videolist&wd=${encodeURIComponent(wd)}`;
        const wdRes = await fetchUpstream(wdApi, { timeoutMs: 10000, headers: cmsRequestHeaders() });
        if (wdRes.ok) {
          const wdData = await wdRes.json();
          try {
            const detail = parseDetail(wdData, source);
            // 关键词可能命中多部同名剧：优先取 ID 精确匹配的条目
            const exact = Array.isArray(wdData?.list)
              ? wdData.list.find((v) => String(v?.vod_id ?? '') === id)
              : null;
            if (exact) {
              const picked = { ...wdData, list: [exact] };
              const detail2 = parseDetail(picked, source);
              if (detail2.episodes.length > 0) resolved = detail2;
            }
            if (!resolved && detail.episodes.length > 0 && wdData?.list?.length === 1) resolved = detail;
          } catch {
            // 关键词查询无内容 → 继续尝试详情页
          }
        }
      }

      // 2) 详情页 HTML 提取
      if (!resolved && /^https?:\/\//.test(detailRoot)) {
        const detailVerdict = await checkUpstreamAllowed(detailRoot);
        if (!detailVerdict.ok) return { status: 400, body: { error: detailVerdict.reason } };
        const detailUrl = `${detailRoot}/index.php/vod/detail/id/${id}.html`;
        const detailRes = await fetchUpstream(detailUrl, {
          timeoutMs: 10000,
          headers: { 'User-Agent': UA },
        });
        if (detailRes.ok) {
          const html = await detailRes.text();
          resolved = parseDetailPageHtml(html, source);
        }
      }

      if (!resolved || resolved.episodes.length === 0) {
        return { status: 404, body: { error: '未找到播放资源' } };
      }
      setCache(cacheKey, resolved, DETAIL_CACHE_TTL);
      return { status: 200, body: resolved };
    } catch (err) {
      return { status: 502, body: { error: err instanceof Error ? err.message : '获取详情失败' } };
    }
  });

  // —— 通用流式代理 ——

  api.get('/proxy', async (req) => {
    const url = new URL(req.url, 'http://localhost');
    const targetUrl = url.searchParams.get('url') || '';
    const stripAd = url.searchParams.get('ad') !== '0'; // 默认开启广告过滤

    const guarded = guard(req);
    if (guarded) return guarded;

    if (!isValidProxyUrl(targetUrl)) return { status: 400, text: '无效的 URL' };
    if (await isBlockedByDNS(targetUrl)) return { status: 403, text: '不允许访问私有/保留网络地址' };

    const headers = { 'User-Agent': UA, Accept: '*/*' };
    const range = req.headers.get('range');
    if (range) headers.Range = range;

    // 分片类 URL（.ts/.m4s/.mp4/.key）出站前占全局信号量：防止播放 miss + 前端预取 +
    // 服务端预热叠加并发触发源站限速。m3u8（每集一次）与 Range 拖动（低敏）不占。
    const gated = !range && isCacheableSegmentUrl(targetUrl, '');
    if (gated) await acquireUpstreamSeg();

    try {
      let response;
      let finalUrl = targetUrl;
      let lastError = null;
      for (let attempt = 0; attempt <= PROXY_MAX_RETRIES; attempt++) {
        try {
          const result = await fetchUpstreamWithMetaSafe(targetUrl, { headers });
          response = result.res;
          finalUrl = result.finalUrl;
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
        }
      }
      if (!response) {
        return { status: 502, text: `代理请求失败: ${lastError instanceof Error ? lastError.message : '未知错误'}` };
      }

      const contentType = response.headers.get('content-type') || '';
      const isM3u8 =
        contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
        targetUrl.toLowerCase().endsWith('.m3u8');

      // m3u8 文本：广告过滤 + 重写为代理地址；同步预热第一片（起播必经路径）
      if (isM3u8) {
        let text = await response.text();
        if (stripAd) text = stripAdGroups(text);
        const rewritten = rewriteM3u8(text, finalUrl);
        await prefetchSegments(rewritten); // 等第一片（deadline 6s），其余后台节奏预热
        return {
          status: response.status,
          text: rewritten,
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
          },
        };
      }

      // 图片/分片：命中内存缓存直接返回（零出站）；未命中读入内存并写入缓存
      const isImage = contentType.startsWith('image/');
      const cacheableImg = isImage && response.status === 200 && !range;
      const cacheableSeg = !cacheableImg && response.status === 200 && !range
        && isCacheableSegmentUrl(targetUrl, contentType);
      const cacheKind = cacheableImg ? 'IMG' : cacheableSeg ? 'SEG' : null;
      if (cacheKind) {
        const hit = (cacheableImg ? imgCacheGet : segCacheGet)(targetUrl);
        if (hit) {
          return new Response(hit.buf, {
            status: 200,
            headers: {
              'Content-Type': hit.contentType,
              'Cache-Control': 'public, max-age=86400',
              'X-Cache': `HIT-${cacheKind}`,
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
        // 同片正在出站（预热/其他播放请求）：等它完成复用缓存，避免双连接触发源站限速
        if (cacheableSeg && upstreamSegFlights.has(targetUrl)) {
          await Promise.race([
            upstreamSegFlights.get(targetUrl),
            new Promise((r) => setTimeout(r, 12000)),
          ]);
          const hit2 = segCacheGet(targetUrl);
          if (hit2) {
            return new Response(hit2.buf, {
              status: 200,
              headers: {
                'Content-Type': hit2.contentType,
                'Cache-Control': 'public, max-age=86400',
                'X-Cache': 'HIT-SEG-WAIT',
                'Access-Control-Allow-Origin': '*',
              },
            });
          }
        }
      }

      // 其余（JSON / 未知类型 / 带 Range）流式透传，保持原样
      const outHeaders = {};
      for (const name of ['content-type', 'accept-ranges', 'content-range', 'etag', 'last-modified']) {
        const v = response.headers.get(name);
        if (v) outHeaders[name] = v;
      }
      outHeaders['Access-Control-Allow-Origin'] = '*';

      if (cacheKind) {
        // 读入内存（图片几十 KB、分片几 MB，牺牲流式换取缓存）
        const buf = Buffer.from(await response.arrayBuffer());
        const maxOne = cacheableImg ? IMG_CACHE_MAX_ONE : SEG_CACHE_MAX_ONE;
        if (buf.length <= maxOne) {
          if (cacheableImg) imgCacheSet(targetUrl, contentType, buf);
          else segCacheSet(targetUrl, contentType, buf);
        }
        outHeaders['Content-Type'] = contentType;
        outHeaders['Cache-Control'] = 'public, max-age=86400';
        outHeaders['X-Cache'] = `MISS-${cacheKind}`;
        return new Response(buf, { status: 200, headers: outHeaders });
      }

      outHeaders['Cache-Control'] = 'public, max-age=3600';
      return { status: response.status, stream: response.body, headers: outHeaders };
    } finally {
      if (gated) releaseUpstreamSeg();
    }
  });

  // —— 直播：播放列表 ——

  api.get('/live/playlist', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    const url = new URL(req.url, 'http://localhost');
    const targetUrl = url.searchParams.get('url') || '';
    const verdict = await checkLiveUrlAllowed(targetUrl);
    if (!verdict.ok) return { status: 403, body: { error: verdict.reason } };

    const cacheKey = `playlist:${targetUrl}`;
    const cached = getLiveCache(cacheKey);
    if (cached) return { status: 200, body: cached };

    try {
      const { res, finalUrl } = await fetchUpstreamWithMetaSafe(targetUrl, {
        timeoutMs: 10000,
        headers: { 'User-Agent': UA, Accept: '*/*' },
      });
      if (!res.ok) return { status: 502, body: { error: `上游返回 HTTP ${res.status}` } };
      const text = await res.text();
      const channels = parseM3u(text, finalUrl);
      const groups = [...new Set(channels.map((c) => c.group).filter(Boolean))];
      const payload = { channels, groups };
      setLiveCache(cacheKey, payload, LIVE_PLAYLIST_TTL, text.length);
      return { status: 200, body: payload };
    } catch (err) {
      return { status: 502, body: { error: err instanceof Error ? err.message : '播放列表获取失败' } };
    }
  });

  // —— 直播：节目单（EPG） ——

  api.get('/live/epg', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    const url = new URL(req.url, 'http://localhost');
    const epgUrl = url.searchParams.get('url') || '';
    const channelId = url.searchParams.get('channelId') || '';
    const verdict = await checkLiveUrlAllowed(epgUrl);
    if (!verdict.ok) return { status: 403, body: { error: verdict.reason } };

    const cacheKey = `epg:${epgUrl}`;
    let map = getLiveCache(cacheKey);
    if (!map) {
      try {
        const { res } = await fetchUpstreamWithMetaSafe(epgUrl, {
          timeoutMs: 15000,
          headers: { 'User-Agent': UA, Accept: '*/*' },
        });
        if (!res.ok) return { status: 502, body: { error: `上游返回 HTTP ${res.status}` } };
        const buf = Buffer.from(await res.arrayBuffer());
        map = parseXmltv(buf);
        setLiveCache(cacheKey, map, LIVE_EPG_TTL, buf.length);
      } catch (err) {
        return { status: 502, body: { error: err instanceof Error ? err.message : '节目单获取失败' } };
      }
    }

    const programs = map.get(channelId) ?? [];
    const { current, next } = currentAndNext(programs);
    return { status: 200, body: { channelId, current, next, programs } };
  });

  // —— 直播：流代理（长连接） ——

  api.get('/live/stream', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    const url = new URL(req.url, 'http://localhost');
    const targetUrl = url.searchParams.get('url') || '';
    const verdict = await checkLiveUrlAllowed(targetUrl);
    if (!verdict.ok) return { status: 403, body: { error: verdict.reason } };

    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    req.signal.addEventListener('abort', onClientAbort, { once: true });

    let response;
    let finalUrl;
    try {
      const result = await fetchUpstreamWithMetaSafe(targetUrl, {
        headers: { 'User-Agent': UA, Accept: '*/*' },
        signal: controller.signal,
      }, { allowPrivate: true, headerTimeoutMs: PROXY_HEADER_TIMEOUT_MS });
      response = result.res;
      finalUrl = result.finalUrl;
    } catch (err) {
      return { status: 502, body: { error: `直播流连接失败: ${err instanceof Error ? err.message : '未知错误'}` } };
    }

    if (!response.ok && response.body) {
      try { await response.body.cancel(); } catch { /* 忽略 */ }
      return {
        status: response.status,
        body: { error: `直播流上游返回 ${response.status}` },
        headers: { 'Cache-Control': 'no-store', 'X-Live-Upstream-Status': String(response.status) },
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const isM3u8 =
      contentType.includes('mpegurl') || contentType.includes('x-mpegurl') ||
      targetUrl.toLowerCase().split('?')[0].endsWith('.m3u8');

    if (isM3u8) {
      const text = await response.text();
      return {
        status: response.status,
        text: rewriteM3u8(stripAdGroups(text), finalUrl, 0, LIVE_STREAM_BASE),
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
        },
      };
    }

    // FLV / TS 等流媒体：纯流式透传
    return {
      status: response.status,
      stream: response.body,
      headers: {
        'Content-Type': contentType || 'video/mp2t',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      },
    };
  });

  // —— 点播源管理 ——

  api.get('/sources', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    const health = getHealthSnapshot();
    return {
      status: 200,
      body: {
        sources: listSources().map((s) => ({
          ...s,
          health: health[s.url] ? {
            fails: health[s.url].fails ?? 0,
            disabled: health[s.url].disabled,
            remainingMs: health[s.url].remainingMs,
            lastError: health[s.url].lastError,
          } : undefined,
        })),
        liveSources: listLiveSources(),
      },
    };
  });

  api.post('/sources', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listSources();
    const url = String(body?.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) return { status: 400, body: { error: '源地址必须以 http:// 或 https:// 开头' } };
    if (current.some((s) => s.url === url)) return { status: 409, body: { error: '该源已存在' } };
    if (current.length >= 100) return { status: 400, body: { error: '点播源数量已达上限（100）' } };
    const source = {
      key: `src_${Date.now().toString(36)}`,
      name: String(body?.name ?? '').trim() || new URL(url).hostname,
      url,
      detail: /^https?:\/\//.test(String(body?.detail ?? '').trim()) ? String(body.detail).trim().replace(/\/+$/, '') : undefined,
      isAdult: body?.isAdult === true,
      enabled: true,
    };
    saveSources([...current, source]);
    return { status: 200, body: { ok: true, source } };
  });

  api.post('/sources/update', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listSources();
    const idx = current.findIndex((s) => s.key === body?.key);
    if (idx < 0) return { status: 404, body: { error: '源不存在' } };
    const next = [...current];
    next[idx] = {
      ...current[idx],
      name: String(body?.name ?? current[idx].name).trim() || current[idx].name,
      url: String(body?.url ?? current[idx].url).trim().replace(/\/+$/, ''),
      detail: /^https?:\/\//.test(String(body?.detail ?? '').trim()) ? String(body.detail).trim().replace(/\/+$/, '') : undefined,
      isAdult: body?.isAdult === true,
      enabled: body?.enabled !== false,
    };
    saveSources(next);
    return { status: 200, body: { ok: true } };
  });

  api.post('/sources/delete', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listSources();
    const next = current.filter((s) => s.key !== body?.key);
    if (next.length === current.length) return { status: 404, body: { error: '源不存在' } };
    saveSources(next);
    return { status: 200, body: { ok: true } };
  });

  api.post('/sources/reset-health', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    if (body?.url) resetSourceHealth(body.url);
    else resetAllHealth();
    return { status: 200, body: { ok: true } };
  });

  // —— 直播源管理 ——

  api.post('/live-sources', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listLiveSources();
    const url = String(body?.url ?? '').trim();
    if (!/^https?:\/\//.test(url)) return { status: 400, body: { error: '直播源地址必须以 http:// 或 https:// 开头' } };
    if (current.some((s) => s.url === url)) return { status: 409, body: { error: '该直播源已存在' } };
    if (current.length >= 50) return { status: 400, body: { error: '直播源数量已达上限（50）' } };
    const source = {
      key: `live_${Date.now().toString(36)}`,
      name: String(body?.name ?? '').trim() || new URL(url).hostname,
      url,
      epg: /^https?:\/\//.test(String(body?.epg ?? '').trim()) ? String(body.epg).trim() : undefined,
      enabled: true,
    };
    saveLiveSources([...current, source]);
    return { status: 200, body: { ok: true, source } };
  });

  api.post('/live-sources/delete', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listLiveSources();
    const next = current.filter((s) => s.key !== body?.key);
    if (next.length === current.length) return { status: 404, body: { error: '直播源不存在' } };
    saveLiveSources(next);
    return { status: 200, body: { ok: true } };
  });

  // —— 短剧源管理（与点播源同协议，仅在「短剧」页使用） ——

  api.get('/drama-sources', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    const health = getHealthSnapshot();
    return {
      status: 200,
      body: {
        sources: listDramaSources().map((s) => ({
          ...s,
          health: health[s.url] ? {
            fails: health[s.url].fails ?? 0,
            disabled: health[s.url].disabled,
            remainingMs: health[s.url].remainingMs,
            lastError: health[s.url].lastError,
          } : undefined,
        })),
      },
    };
  });

  api.post('/drama-sources', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listDramaSources();
    const url = String(body?.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) return { status: 400, body: { error: '源地址必须以 http:// 或 https:// 开头' } };
    // 规范化后查重：协议/域名大小写、默认端口、尾斜杠、query 的差异视为同一源
    const normUrl = normalizeSourceUrl(url);
    if (current.some((s) => normalizeSourceUrl(s.url) === normUrl)) return { status: 409, body: { error: '该短剧源已存在' } };
    if (current.length >= 100) return { status: 400, body: { error: '短剧源数量已达上限（100）' } };
    const source = {
      key: `drama_${Date.now().toString(36)}`,
      name: String(body?.name ?? '').trim() || new URL(url).hostname,
      url,
      detail: /^https?:\/\//.test(String(body?.detail ?? '').trim()) ? String(body.detail).trim().replace(/\/+$/, '') : undefined,
      isAdult: body?.isAdult === true,
      enabled: true,
    };
    saveDramaSources([...current, source]);
    return { status: 200, body: { ok: true, source } };
  });

  api.post('/drama-sources/update', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listDramaSources();
    const idx = current.findIndex((s) => s.key === body?.key);
    if (idx < 0) return { status: 404, body: { error: '短剧源不存在' } };
    const next = [...current];
    next[idx] = {
      ...current[idx],
      name: String(body?.name ?? current[idx].name).trim() || current[idx].name,
      url: String(body?.url ?? current[idx].url).trim().replace(/\/+$/, ''),
      detail: /^https?:\/\//.test(String(body?.detail ?? '').trim()) ? String(body.detail).trim().replace(/\/+$/, '') : undefined,
      isAdult: body?.isAdult === true,
      enabled: body?.enabled !== false,
    };
    saveDramaSources(next);
    return { status: 200, body: { ok: true } };
  });

  api.post('/drama-sources/delete', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listDramaSources();
    const next = current.filter((s) => s.key !== body?.key);
    if (next.length === current.length) return { status: 404, body: { error: '短剧源不存在' } };
    saveDramaSources(next);
    return { status: 200, body: { ok: true } };
  });

  // —— 源测试（探活） ——

  api.post('/source/test', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const url = String(body?.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) return { status: 400, body: { error: '无效的源地址' } };
    const verdict = await checkUpstreamAllowed(url);
    if (!verdict.ok) return { status: 400, body: { error: verdict.reason } };
    const start = Date.now();
    try {
      const res = await fetchUpstream(`${url}?ac=videolist&wd=test&pg=1`, {
        timeoutMs: 8000,
        headers: cmsRequestHeaders(),
      });
      const ms = Date.now() - start;
      if (!res.ok) return { status: 200, body: { ok: false, ms, error: `HTTP ${res.status}` } };
      const data = await res.json();
      const count = Array.isArray(data?.list) ? data.list.length : 0;
      return { status: 200, body: { ok: true, ms, count } };
    } catch (err) {
      return { status: 200, body: { ok: false, ms: Date.now() - start, error: err instanceof Error ? err.message : '请求失败' } };
    }
  });

  return api;
}

/** 带 meta 的安全上游请求（代理路由用；重试策略与 LibreTV 对齐） */
async function fetchUpstreamWithMetaSafe(url, init, options = {}) {
  const { timeoutMs = PROXY_TIMEOUT_MS, ...rest } = init;
  return fetchUpstreamWithMeta(url, { ...rest, timeoutMs }, options);
}
