/**
 * Alist / OpenList 客户端（零依赖）。
 * Alist 是国内 NAS 社区聚合网盘（阿里云盘 / 夸克 / 115 / 天翼等）的标准方案，
 * 其 REST API 可直接列目录与换取直链，无需 WebDAV 的整树遍历。
 *
 * API：
 * - POST {base}/api/auth/login  {username, password} → token
 * - POST {base}/api/fs/list     {path, password?, page, per_page} → content
 * - POST {base}/api/fs/get      {path} → raw_url（直链）
 */

const tokenCache = new Map(); // base → { token, expiresAt }

async function login(base, user, pass) {
  const cached = tokenCache.get(base);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user || '', password: pass || '' }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 200 || !data.data?.token) {
    throw new Error(`Alist 登录失败: ${data.message || `HTTP ${res.status}`}`);
  }
  tokenCache.set(base, { token: data.data.token, expiresAt: Date.now() + 50 * 60 * 1000 });
  return data.data.token;
}

async function authHeaders(source) {
  if (source.token) return { Authorization: source.token };
  if (source.user || source.pass) {
    const token = await login(source.url, source.user, source.pass);
    return { Authorization: token };
  }
  return {}; // 游客可访问的公开目录
}

/** 列目录：返回 [{ name, path, isDir, size, mtime }] */
export async function alistList(source, dirPath) {
  const base = source.url.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/fs/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders(source)) },
    body: JSON.stringify({ path: dirPath || '/', password: source.dirPassword || '', page: 1, per_page: 500, refresh: false }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 200) throw new Error(`Alist 列目录失败: ${data.message || `HTTP ${res.status}`}`);
  const content = Array.isArray(data.data?.content) ? data.data.content : [];
  return content
    .filter((it) => it && it.name)
    .map((it) => ({
      name: it.name,
      path: (dirPath === '/' ? '' : dirPath) + '/' + it.name,
      isDir: it.is_dir === true || it.isDir === true,
      size: Number(it.size) || 0,
      mtime: it.modified ? Date.parse(it.modified) || 0 : 0,
      sign: it.sign,
      thumb: it.thumb,
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.isDir ? -1 : 1));
}

/** 换取文件直链（部分网盘直链有效期短，随用随换） */
export async function alistGetRawUrl(source, filePath) {
  const base = source.url.replace(/\/+$/, '');
  const res = await fetch(`${base}/api/fs/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders(source)) },
    body: JSON.stringify({ path: filePath, password: source.dirPassword || '' }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 200 || !data.data?.raw_url) {
    throw new Error(`Alist 取直链失败: ${data.message || `HTTP ${res.status}`}`);
  }
  return { rawUrl: data.data.raw_url, name: data.data.name };
}
