/**
 * JXTVbox 服务端入口：零依赖 Node HTTP 服务。
 * - API 路由（/api/*）
 * - 静态文件（public/）+ SPA 回退
 * - 首次启动合并 DEFAULT_SOURCES / DEFAULT_LIVE_SOURCES 预置源
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerApiRoutes } from './routes/api.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerDoubanRoutes } from './routes/douban.js';
import { registerDramaRoutes } from './routes/drama.js';
import { mergeEnvSourcesOnBoot } from './lib/source-store.js';
import { mergeEnvMediaDirsOnBoot } from './lib/media-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  const h = new Headers(headers);
  if (!h.has('Content-Type') && typeof body === 'string' && !h.has('Content-Type')) {
    h.set('Content-Type', 'text/plain; charset=utf-8');
  }
  res.writeHead(status, h);
  res.end(body ?? null);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

/**
 * Node IncomingMessage → Web Request 兼容层。
 * routes/ 下的 handler 按 fetch 风格编写（req.headers.get / req.json），
 * 而 Node 原生 req.headers 是普通对象、无 json() 方法；在此集中补齐，
 * 避免每个 handler 各自适配。每请求调用一次，仅在缺失时挂载。
 */
function adaptReq(req) {
  const headers = req.headers;
  if (headers && typeof headers.get !== 'function') {
    headers.get = (name) => {
      const v = headers[String(name).toLowerCase()];
      return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v);
    };
    headers.has = (name) => headers[String(name).toLowerCase()] != null;
  }
  if (typeof req.json !== 'function') {
    req.json = async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? JSON.parse(raw) : {};
    };
  }
}

/** 静态文件服务：带 ETag/Last-Mified 条件请求与 Range 支持（视频分片代理不走这里，但 vendor 大文件可受益） */
function serveStatic(req, res, pathname) {
  // 防路径穿越：解码后必须仍在 PUBLIC_DIR 内
  let filePath;
  try {
    filePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  } catch {
    return send(res, 400, 'Bad Request');
  }
  if (filePath.includes('..')) return send(res, 400, 'Bad Request');

  let abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) return send(res, 400, 'Bad Request');

  let stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
  // SPA 回退：未命中且不像带扩展名的资源请求时返回 index.html
  if ((!stat || !stat.isFile()) && !path.extname(filePath)) {
    abs = path.join(PUBLIC_DIR, 'index.html');
    stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
  }
  if (!stat || !stat.isFile()) return send(res, 404, 'Not Found');

  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
  const headers = {
    'Content-Type': mime,
    'ETag': etag,
    'Last-Modified': stat.mtime.toUTCString(),
    // 零构建项目文件名无内容指纹，URL 不变而内容会变：no-store 彻底禁止浏览器
    // 留存旧副本（no-cache 仍允许缓存存储，个别场景会用到过期本地副本），
    // 保证每次加载都是当前构建的内容；vendor 大文件在局域网内重复拉取的代价可接受
    'Cache-Control': 'no-store',
  };

  // 条件请求
  if (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === stat.mtime.toUTCString()) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  // Range 请求（vendor 大文件 / 视频直接播放场景）
  const range = req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      if (start >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(abs, { start, end }).pipe(res);
      return;
    }
  }

  headers['Content-Length'] = stat.size;
  headers['Accept-Ranges'] = 'bytes';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(abs).pipe(res);
}

async function main() {
  mergeEnvSourcesOnBoot();
  mergeEnvMediaDirsOnBoot();

  const api = registerApiRoutes();
  const media = registerMediaRoutes();
  const douban = registerDoubanRoutes();
  const drama = registerDramaRoutes();

  const server = http.createServer(async (req, res) => {
    try {
      adaptReq(req);
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (url.pathname.startsWith('/api/')) {
        const apiRes = (url.pathname.startsWith('/api/media/') ? await media.dispatch(req) : null)
          ?? (url.pathname.startsWith('/api/drama/') ? await drama.dispatch(req) : null)
          ?? (await douban.dispatch(req))
          ?? (await api.dispatch(req));
        if (apiRes) {
          // Response → Node 响应
          const headers = {};
          apiRes.headers.forEach((v, k) => { headers[k] = v; });
          res.writeHead(apiRes.status, headers);
          if (apiRes.body) {
            const reader = apiRes.body.getReader();
            const pump = async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!res.write(value)) {
                  await new Promise((r) => res.once('drain', r));
                }
              }
              res.end();
            };
            pump().catch(() => res.destroy());
          } else {
            res.end();
          }
          return;
        }
        return sendJson(res, 404, { error: '接口不存在' });
      }

      // 健康检查（不鉴权，供 Docker healthcheck / 探活）
      if (url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }

      return serveStatic(req, res, url.pathname);
    } catch (err) {
      console.error('[JXTVbox] 请求处理异常:', err);
      if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
      else res.destroy();
    }
  });

  server.requestTimeout = 0; // 直播长连接不能按默认请求超时切断
  server.headersTimeout = 60_000;

  server.listen(PORT, HOST, () => {
    console.log(`[JXTVbox] 服务已启动: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (!process.env.PASSWORD) {
      console.warn('[JXTVbox] ⚠️ 未设置 PASSWORD 环境变量，站点将提示管理员配置，API 全部返回 503');
    }
  });
}

main().catch((err) => {
  console.error('[JXTVbox] 启动失败:', err);
  process.exit(1);
});
