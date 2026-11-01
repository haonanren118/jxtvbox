/**
 * 媒体库 API 路由：网盘（Alist/WebDAV）/ 本地（含 NAS 卷）/ Emby 挂载与播放。
 *
 * 与点播聚合搜索的关系：媒体库是「自有片源」通道，与采集站搜索并列：
 * - 采集站结果 → /watch?source=..&id=..（Apple CMS 详情流程）
 * - 媒体库文件 → /watch?url=/api/media/stream?...&title=..（直链流程）
 */

import { Router } from './router.js';
import fs from 'node:fs';
import path from 'node:path';
import { webdavList, webdavGet, webdavUrl } from '../lib/webdav.js';
import { alistList, alistGetRawUrl } from '../lib/alist.js';
import { embyItems, embyStreamUrl, embyUpstreamStream, embyViews, embyResolveUser, embyImageUrl } from '../lib/emby.js';
import {
  listMediaSources,
  saveMediaSources,
  findMediaSource,
  scanLocalVideos,
  humanSize,
  isVideoFile,
  mergeEnvMediaDirsOnBoot,
} from '../lib/media-store.js';
import { fetchUpstreamWithMeta } from '../lib/fetch-utils.js';
import { checkUpstreamAllowed } from '../lib/ssrf.js';
import { isPasswordConfigured, sessionFromCookieHeader } from '../lib/auth.js';

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function guard(req) {
  if (!isPasswordConfigured()) return { status: 503, body: { error: '服务器未设置 PASSWORD 环境变量' } };
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) return { status: 401, body: { error: '未登录' } };
  return null;
}

/** 本地路径防穿越：解析后必须位于源根目录内 */
function resolveLocal(root, rel) {
  const r = String(rel || '/');
  // 拒绝盘符 / UNC 注入（如 C:\...、\\server\share），避免拼出绕过前缀检查的畸形路径
  if (/^[a-zA-Z]:/.test(r) || r.startsWith('\\\\')) return null;
  const abs = path.resolve(root, '.' + r);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

export function registerMediaRoutes(app) {
  const media = new Router('/api/media');

  // —— 媒体源管理 ——

  media.get('/sources', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    // 回显时剔除敏感字段（api_key / 密码），只告诉前端「已配置」
    const sources = listMediaSources().map((s) => ({
      key: s.key,
      type: s.type,
      name: s.name,
      url: s.url,
      enabled: s.enabled,
      hasAuth: Boolean(s.user || s.pass || s.token),
      hasApiKey: Boolean(s.apiKey),
      userId: s.userId,
    }));
    return { status: 200, body: { sources } };
  });

  media.post('/sources', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    if (body?.type === 'local') {
      return { status: 400, body: { error: '本地目录源请通过 MEDIA_DIRS 环境变量声明（Docker 卷 / fpk 共享目录）' } };
    }
    if (!['webdav', 'alist', 'emby'].includes(body?.type)) {
      return { status: 400, body: { error: '不支持的媒体源类型（webdav/alist/emby）' } };
    }
    if (!/^https?:\/\//.test(String(body?.url ?? '').trim())) {
      return { status: 400, body: { error: '地址必须以 http:// 或 https:// 开头' } };
    }
    const verdict = await checkUpstreamAllowed(String(body.url).trim());
    if (!verdict.ok) return { status: 400, body: { error: verdict.reason } };

    const current = listMediaSources();
    const source = {
      key: `media_${Date.now().toString(36)}`,
      type: body.type,
      name: String(body?.name ?? '').trim() || new URL(String(body.url).trim()).hostname,
      url: String(body.url).trim().replace(/\/+$/, ''),
      user: String(body?.user ?? '') || undefined,
      pass: String(body?.pass ?? '') || undefined,
      token: String(body?.token ?? '') || undefined,
      apiKey: String(body?.apiKey ?? '') || undefined,
      userId: String(body?.userId ?? '') || undefined,
      dirPassword: String(body?.dirPassword ?? '') || undefined,
      enabled: true,
    };
    saveMediaSources([...current, source]);
    return { status: 200, body: { ok: true, source: { ...source, pass: undefined, apiKey: undefined } } };
  });

  media.post('/sources/delete', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    let body;
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: '请求格式错误' } };
    }
    const current = listMediaSources();
    const next = current.filter((s) => s.key !== body?.key);
    if (next.length === current.length) return { status: 404, body: { error: '媒体源不存在' } };
    saveMediaSources(next);
    return { status: 200, body: { ok: true } };
  });

  // —— 目录浏览 ——

  media.get('/list', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    const url = new URL(req.url, 'http://localhost');
    const source = findMediaSource(url.searchParams.get('source') || '');
    if (!source || !source.enabled) return { status: 404, body: { error: '媒体源不存在或未启用' } };
    const dir = url.searchParams.get('path') || '/';

    try {
      if (source.type === 'local') {
        const abs = resolveLocal(source.url, dir);
        if (!abs) return { status: 400, body: { error: '非法的目录路径' } };
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          return { status: 404, body: { error: '目录不存在' } };
        }
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        const items = entries
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => {
            const childRel = (dir === '/' ? '' : dir) + '/' + e.name;
            let size = 0;
            let mtime = 0;
            try {
              const st = fs.statSync(path.join(abs, e.name));
              size = st.size;
              mtime = st.mtimeMs;
            } catch { /* 忽略 */ }
            return { name: e.name, path: childRel, isDir: e.isDirectory(), size, mtime };
          })
          .filter((it) => it.isDir || isVideoFile(it.name))
          .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.isDir ? -1 : 1))
          .map((it) => ({ ...it, sizeText: humanSize(it.size) }));
        return { status: 200, body: { items, parent: path.posix.dirname(dir) === '.' ? '/' : path.posix.dirname(dir) } };
      }

      if (source.type === 'webdav') {
        const items = (await webdavList(source.url, dir, source))
          .filter((it) => it.isDir || isVideoFile(it.name))
          .map((it) => ({ ...it, sizeText: humanSize(it.size) }));
        return { status: 200, body: { items, parent: path.posix.dirname(dir) === '.' ? '/' : path.posix.dirname(dir) } };
      }

      if (source.type === 'alist') {
        const items = (await alistList(source, dir))
          .filter((it) => it.isDir || isVideoFile(it.name))
          .map((it) => ({ ...it, sizeText: humanSize(it.size) }));
        return { status: 200, body: { items, parent: path.posix.dirname(dir) === '.' ? '/' : path.posix.dirname(dir) } };
      }

      if (source.type === 'emby') {
        // Emby 不走目录树：parentId 为空时列媒体库视图，否则列该库影片
        if (!url.searchParams.get('parentId')) {
          const views = await embyViews(source);
          return { status: 200, body: { views, items: [], parent: null } };
        }
        const items = await embyItems(source, { parentId: url.searchParams.get('parentId') });
        return {
          status: 200,
          body: {
            items: items.map((it) => ({
              name: it.seriesName ? `${it.seriesName} S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')}` : it.name,
              path: it.id,
              isDir: false,
              size: 0,
              mtime: 0,
              emby: it,
              sizeText: it.year ? String(it.year) : '',
            })),
            parent: null,
          },
        };
      }
      return { status: 400, body: { error: '不支持的媒体源类型' } };
    } catch (err) {
      return { status: 502, body: { error: err instanceof Error ? err.message : '浏览失败' } };
    }
  });

  // —— 扫描（本地库全量视频，用于「本地影片」列表） ——

  media.get('/scan', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    const url = new URL(req.url, 'http://localhost');
    const source = findMediaSource(url.searchParams.get('source') || '');
    if (!source || source.type !== 'local') return { status: 404, body: { error: '本地媒体源不存在' } };
    const files = scanLocalVideos(source.url);
    return {
      status: 200,
      body: {
        files: files.map((f) => ({ ...f, sizeText: humanSize(f.size), url: `/api/media/stream?source=${encodeURIComponent(source.key)}&path=${encodeURIComponent(f.path)}` })),
      },
    };
  });

  // —— 流式播放 ——

  media.get('/stream', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;

    const url = new URL(req.url, 'http://localhost');
    const source = findMediaSource(url.searchParams.get('source') || '');
    if (!source || !source.enabled) return { status: 404, body: { error: '媒体源不存在或未启用' } };
    const filePath = url.searchParams.get('path') || '';
    const itemId = url.searchParams.get('id') || '';
    const range = req.headers.get('range');

    try {
      if (source.type === 'local') {
        const abs = resolveLocal(source.url, filePath);
        if (!abs) return { status: 400, body: { error: '非法的文件路径' } };
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { status: 404, body: { error: '文件不存在' } };
        const stat = fs.statSync(abs);
        const ext = path.extname(abs).toLowerCase();
        const mime = {
          '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
          '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t',
          '.m2ts': 'video/mp2t', '.flv': 'video/x-flv', '.rmvb': 'video/x-pn-realaudio',
          '.wmv': 'video/x-ms-wmv', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp',
        }[ext] || 'application/octet-stream';

        if (range) {
          const m = range.match(/bytes=(\d+)-(\d*)/);
          if (m) {
            const start = parseInt(m[1], 10);
            const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
            return {
              status: 206,
              stream: fs.createReadStream(abs, { start, end }),
              headers: {
                'Content-Type': mime,
                'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store',
              },
            };
          }
        }
        return {
          status: 200,
          stream: fs.createReadStream(abs),
          headers: {
            'Content-Type': mime,
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          },
        };
      }

      if (source.type === 'webdav') {
        const res = await webdavGet(source.url, filePath, source, range);
        if (!res.ok || !res.body) {
          return { status: res.status === 404 ? 404 : 502, body: { error: `上游返回 HTTP ${res.status}` } };
        }
        const headers = {
          'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        };
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          const v = res.headers.get(name);
          if (v) headers[name] = v;
        }
        return { status: res.status, stream: res.body, headers };
      }

      if (source.type === 'alist') {
        const { rawUrl } = await alistGetRawUrl(source, filePath);
        // 直链多为 302 或带签名的短时效地址：逐跳安全跟随后透传
        const verdict = await checkUpstreamAllowed(rawUrl);
        if (!verdict.ok) return { status: 403, body: { error: verdict.reason } };
        const { res } = await fetchUpstreamWithMeta(rawUrl, {
          headers: { 'User-Agent': UA, Range: range || '' },
          timeoutMs: 15000,
        });
        if (!res.body) return { status: 502, body: { error: `上游返回 HTTP ${res.status}` } };
        const headers = {
          'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        };
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          const v = res.headers.get(name);
          if (v) headers[name] = v;
        }
        return { status: res.status, stream: res.body, headers };
      }

      if (source.type === 'emby') {
        if (!itemId) return { status: 400, body: { error: '缺少 Emby 影片 ID' } };
        const upstream = embyUpstreamStream(source, itemId);
        const { res } = await fetchUpstreamWithMeta(upstream, {
          headers: { 'User-Agent': UA, Range: range || '' },
          timeoutMs: 15000,
        });
        if (!res.body) return { status: 502, body: { error: `上游返回 HTTP ${res.status}` } };
        const headers = {
          'Content-Type': res.headers.get('content-type') || 'video/mp4',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        };
        for (const name of ['content-length', 'content-range', 'accept-ranges']) {
          const v = res.headers.get(name);
          if (v) headers[name] = v;
        }
        return { status: res.status, stream: res.body, headers };
      }
      return { status: 400, body: { error: '不支持的媒体源类型' } };
    } catch (err) {
      return { status: 502, body: { error: err instanceof Error ? err.message : '播放失败' } };
    }
  });

  // —— Emby 封面 ——

  media.get('/emby-image', async (req) => {
    const guarded = guard(req);
    if (guarded) return guarded;
    const url = new URL(req.url, 'http://localhost');
    const source = findMediaSource(url.searchParams.get('source') || '');
    if (!source || source.type !== 'emby') return { status: 404, body: { error: '媒体源不存在' } };
    const id = url.searchParams.get('id') || '';
    const tag = url.searchParams.get('tag') || '';
    try {
      const { res } = await fetchUpstreamWithMeta(embyImageUrl(source, id, tag), { timeoutMs: 10000 });
      if (!res.body) return { status: 502, body: { error: '封面获取失败' } };
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

  return media;
}
