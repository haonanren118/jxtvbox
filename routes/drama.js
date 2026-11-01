/**
 * 短剧 API 路由：分类浏览 + 分页列表（Apple CMS 协议，与点播搜索同族）。
 *
 * 背景：金果TV（红果短剧重打包）类应用验证了「短剧」作为独立内容形态的需求。
 * JXTVbox 不引入私有短剧 API，而是复用已验证的 Apple CMS 采集站协议：
 * - 短剧源在「设置 → 短剧源」单独管理（drama-sources.json），仅在短剧页使用；
 * - 分类：代理上游 ?ac=list（返回 class 分类树），缓存 24 小时；
 * - 列表：代理上游 ?ac=videolist[&t=分类][&wd=关键词][&pg=页码]，缓存 10 分钟；
 * - 播放：详情走既有 /api/detail（同一协议），前端跳 #/watch，播放器/换源/进度全复用。
 *
 * 安全与点播搜索对齐：登录守卫 + SSRF 校验 + 源健康度阶梯停用 + 成人过滤。
 */

import { Router } from './router.js';
import { cmsRequestHeaders, filterAdultResults, isAdultContent, parseSearchList } from '../lib/cms-parser.js';
import { fetchUpstream, getCache, setCache } from '../lib/fetch-utils.js';
import { checkUpstreamAllowed } from '../lib/ssrf.js';
import {
  listDramaSources,
  getHealthSnapshot,
  isSourceDisabled,
  sourceDisabledRemaining,
  markSourceOk,
  markSourceFail,
} from '../lib/source-store.js';
import { isPasswordConfigured, sessionFromCookieHeader } from '../lib/auth.js';

// 列表缓存 10 分钟（与点播搜索一致，翻页/切页回走不再重复打上游）
// 分类缓存 24 小时（分类树极少变，过期一次的成本远高于用户等一次分类请求）
const LIST_CACHE_TTL = 10 * 60 * 1000;
const CATEGORY_CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_PG = 50;

function guard(req) {
  if (!isPasswordConfigured()) {
    return { status: 503, body: { error: '服务器未设置 PASSWORD 环境变量' } };
  }
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) {
    return { status: 401, body: { error: '未登录' } };
  }
  return null;
}

/** 仅放行「已启用」的短剧源（设置里的停用开关） */
function findEnabledSource(key) {
  if (!key) return null;
  return listDramaSources().find((s) => s.key === key && s.enabled) ?? null;
}

export function registerDramaRoutes(app) {
  const drama = new Router('/api/drama');

  // —— 分类列表（代理 ac=list） ——

  drama.get('/categories', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    const url = new URL(req.url, 'http://localhost');
    const source = findEnabledSource(url.searchParams.get('source') || '');
    if (!source) return { status: 404, body: { error: '短剧源不存在或已停用' } };

    // 短剧页只展示短剧相关分类；成人过滤开启时剔除擦边类分类
    const filterAdult = url.searchParams.get('adult') !== '0';
    const cacheKey = `drama-cat:${source.url}\n${filterAdult ? 1 : 0}`;
    const cached = getCache(cacheKey);
    if (cached) return { status: 200, body: cached };

    const verdict = await checkUpstreamAllowed(source.url);
    if (!verdict.ok) return { status: 400, body: { error: verdict.reason } };

    try {
      const res = await fetchUpstream(`${source.url.replace(/\/+$/, '')}?ac=list`, {
        timeoutMs: 10000,
        headers: cmsRequestHeaders(),
      });
      if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
      const data = await res.json();
      const classes = Array.isArray(data?.class) ? data.class : [];
      const categories = classes
        .map((c) => ({
          id: String(c?.type_id ?? '').trim(),
          name: String(c?.type_name ?? '').trim(),
          pid: Number(c?.type_pid) || 0,
        }))
        // 只保留短剧分类（短剧大全 / 爽文短剧 / 古装仙侠短剧…），电影电视剧等一律不进短剧页
        .filter((c) => c.id && c.name && c.name.includes('短剧'))
        .filter((c) => !filterAdult || !isAdultContent(c.name));
      markSourceOk(source.url);
      const payload = { ok: true, categories };
      setCache(cacheKey, payload, CATEGORY_CACHE_TTL);
      return { status: 200, body: payload };
    } catch (err) {
      markSourceFail(source.url, err instanceof Error ? err.message : '分类获取失败');
      return { status: 502, body: { error: err instanceof Error ? err.message : '分类获取失败' } };
    }
  });

  // —— 短剧列表（分类 / 关键词 / 分页，代理 ac=videolist） ——

  drama.get('/list', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    const url = new URL(req.url, 'http://localhost');
    const source = findEnabledSource(url.searchParams.get('source') || '');
    if (!source) return { status: 404, body: { error: '短剧源不存在或已停用' } };

    const t = (url.searchParams.get('t') || '').trim();
    const wd = (url.searchParams.get('wd') || '').trim().slice(0, 50);
    let pg = parseInt(url.searchParams.get('pg') || '1', 10);
    if (!Number.isFinite(pg) || pg < 1) pg = 1;
    pg = Math.min(pg, MAX_PG);
    const filterAdult = url.searchParams.get('adult') !== '0';

    // 健康度自动停用：与点播搜索同一份 health.json，到点前直接跳过
    const health = getHealthSnapshot()[source.url];
    if (health && isSourceDisabled(health)) {
      const remain = sourceDisabledRemaining(health);
      const text = remain === Infinity ? '长期停用（连续失败）' : `停用中（约 ${Math.ceil(remain / 60000)} 分钟后恢复）`;
      return {
        status: 200,
        body: { ok: false, skipped: true, error: `源已自动${text}`, list: [], page: pg, pagecount: 0 },
      };
    }

    const verdict = await checkUpstreamAllowed(source.url);
    if (!verdict.ok) return { status: 400, body: { error: verdict.reason } };

    const params = new URLSearchParams({ ac: 'videolist', pg: String(pg) });
    if (t) params.set('t', t);
    if (wd) params.set('wd', wd);
    const apiUrl = `${source.url.replace(/\/+$/, '')}?${params.toString()}`;

    const cacheKey = `drama-list:${apiUrl}\n${filterAdult ? 1 : 0}`;
    const cached = getCache(cacheKey);
    if (cached) return { status: 200, body: cached };

    try {
      const res = await fetchUpstream(apiUrl, { timeoutMs: 10000, headers: cmsRequestHeaders() });
      if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
      const data = await res.json();
      const list = filterAdultResults(parseSearchList(data, source), filterAdult);
      const rawPageCount = parseInt(String(data?.pagecount ?? '1'), 10);
      const pagecount = Math.min(Number.isFinite(rawPageCount) ? Math.max(1, rawPageCount) : 1, MAX_PG);
      markSourceOk(source.url);
      const payload = { ok: true, list, page: pg, pagecount };
      setCache(cacheKey, payload, LIST_CACHE_TTL);
      return { status: 200, body: payload };
    } catch (err) {
      markSourceFail(source.url, err instanceof Error ? err.message : '获取失败');
      return { status: 502, body: { error: err instanceof Error ? err.message : '获取失败' } };
    }
  });

  return drama;
}
