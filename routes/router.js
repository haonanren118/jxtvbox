/**
 * 极简路由：按 method + pathname 精确匹配（无路径参数，全部走查询串）。
 * 处理器返回值约定：
 *   { status, body }              → application/json
 *   { status, body, headers }     → JSON + 自定义响应头
 *   { status, text }              → text/plain
 *   { status, text, headers }     → 文本 + 自定义响应头（Content-Type 以 headers 为准）
 *   { status, stream, headers }   → 流式响应体
 *   Response 实例                  → 直接返回
 */

export class Router {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.routes = [];
  }

  get(path, handler) {
    this.routes.push({ method: 'GET', path: this.prefix + path, handler });
    return this;
  }

  post(path, handler) {
    this.routes.push({ method: 'POST', path: this.prefix + path, handler });
    return this;
  }

  /** 返回匹配的路由与 pathname；未命中返回 null */
  match(method, pathname) {
    return this.routes.find((r) => r.method === method && r.path === pathname) ?? null;
  }

  /** 统一执行并产出 Response */
  async dispatch(req) {
    const url = new URL(req.url, 'http://localhost');
    const route = this.match(req.method, url.pathname);
    if (!route) return null;

    const result = await route.handler(req);
    if (result instanceof Response) return result;

    const { status = 200, body, text, stream, headers = {} } = result;

    if (stream !== undefined) {
      return new Response(stream, { status, headers });
    }
    if (text !== undefined) {
      const h = new Headers(headers);
      if (!h.has('Content-Type')) h.set('Content-Type', 'text/plain; charset=utf-8');
      return new Response(text, { status, headers: h });
    }
    const h = new Headers(headers);
    h.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(body ?? {}), { status, headers: h });
  }
}
