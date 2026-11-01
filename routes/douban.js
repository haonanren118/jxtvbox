/**
 * 豆瓣热播推荐榜（电影 / 剧集）。
 * 数据源：豆瓣移动端 search_subjects 接口（返回 JSON：标题/评分/封面/条目 ID/更新集数）。
 * 服务端代理抓取并缓存：豆瓣有频率限制，且首页不应等待外网往返；
 * 缓存 10 分钟，失败时降级返回上一份缓存（标注 stale）。
 */

import { Router } from './router.js';
import { fetchUpstream } from '../lib/fetch-utils.js';
import { isPasswordConfigured, sessionFromCookieHeader } from '../lib/auth.js';

const CACHE_TTL = 10 * 60 * 1000;
const PAGE_SIZE = 30;
const FETCH_TIMEOUT_MS = 6000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const LABELS = { movie: '豆瓣热播 · 电影', tv: '豆瓣热播 · 剧集' };

/** type → { at, list } */
const cache = new Map();

function guard(req) {
  if (!isPasswordConfigured()) {
    return { status: 503, body: { error: '服务器未设置 PASSWORD 环境变量' } };
  }
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) {
    return { status: 401, body: { error: '未登录' } };
  }
  return null;
}

async function fetchHot(type) {
  const hit = cache.get(type);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.list;

  const url = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent('热门')}&page_limit=${PAGE_SIZE}&page_start=0`;
  const res = await fetchUpstream(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: { 'User-Agent': UA, 'Referer': 'https://movie.douban.com/' },
  });
  if (!res.ok) throw new Error(`豆瓣接口 HTTP ${res.status}`);
  const data = await res.json();
  const list = (Array.isArray(data?.subjects) ? data.subjects : [])
    .filter((s) => s && s.title)
    .map((s) => ({
      id: String(s.id || ''),
      title: String(s.title),
      rate: String(s.rate || ''),
      cover: String(s.cover || ''),
      url: String(s.url || ''),
      episodesInfo: String(s.episodes_info || ''),
      isNew: !!s.is_new,
    }));
  cache.set(type, { at: Date.now(), list });
  return list;
}

export function registerDoubanRoutes() {
  const r = new Router();

  r.get('/api/douban/hot', async (req) => {
    const denied = guard(req);
    if (denied) return denied;

    const url = new URL(req.url, 'http://localhost');
    const type = url.searchParams.get('type') === 'tv' ? 'tv' : 'movie';

    try {
      const items = await fetchHot(type);
      return { status: 200, body: { ok: true, type, label: LABELS[type], items } };
    } catch (err) {
      // 豆瓣暂不可达：有旧缓存就降级返回，否则明确报错让前端展示重试
      const stale = cache.get(type);
      if (stale) {
        return { status: 200, body: { ok: true, type, label: LABELS[type], items: stale.list, stale: true } };
      }
      return { status: 200, body: { ok: false, type, error: err instanceof Error ? err.message : '豆瓣数据获取失败' } };
    }
  });

  // 封面代理：豆瓣图片 CDN 有防盗链（无 Referer 418），浏览器直连必被拒，走服务端带 Referer 抓取
  r.get('/api/douban/cover', async (req) => {
    const denied = guard(req);
    if (denied) return denied;

    const url = new URL(req.url, 'http://localhost');
    const target = url.searchParams.get('url') || '';
    // 仅放行豆瓣图片域名，避免代理被当作任意 SSRF 出口
    if (!/^https:\/\/img\d*\.douban(io|com)\.com\//.test(target)) {
      return { status: 400, body: { error: '仅支持豆瓣图片地址' } };
    }
    try {
      const res = await fetchUpstream(target, {
        timeoutMs: 10000,
        headers: { 'User-Agent': UA, 'Referer': 'https://movie.douban.com/' },
      });
      if (!res.ok || !res.body) return { status: 502, body: { error: `封面获取失败 HTTP ${res.status}` } };
      return {
        status: 200,
        stream: res.body,
        headers: {
          'Content-Type': res.headers.get('content-type') || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        },
      };
    } catch (err) {
      return { status: 502, body: { error: err instanceof Error ? err.message : '封面获取失败' } };
    }
  });

  return r;
}
