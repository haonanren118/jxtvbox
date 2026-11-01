/**
 * 极简 WebDAV 客户端（零依赖）。
 * 覆盖 NAS / 网盘（Alist WebDAV、坚果云等）的目录列举与文件读取：
 * - PROPFIND（Depth: 1）列目录
 * - GET 读文件（Range 透传由调用方处理）
 */

const DEPTH_ONE_PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/><d:getcontenttype/></d:prop></d:propfind>`;

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user || ''}:${pass || ''}`).toString('base64');
}

/** 拼接 WebDAV URL：base + path（path 需以 / 开头，逐段编码） */
export function webdavUrl(base, path) {
  const root = base.replace(/\/+$/, '');
  const clean = ('/' + path).replace(/\/{2,}/g, '/');
  const encoded = clean.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return root + encoded;
}

/**
 * 列目录。返回 [{ name, path, isDir, size, mtime, contentType }]。
 * 过滤掉当前目录自身（response href 与请求路径一致者）。
 */
export async function webdavList(base, dirPath, auth) {
  const url = webdavUrl(base, dirPath);
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
      Authorization: basicAuth(auth?.user, auth?.pass),
    },
    body: DEPTH_ONE_PROPFIND,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status !== 207 && res.status !== 200) {
    throw new Error(`WebDAV PROPFIND 失败: HTTP ${res.status}`);
  }
  const xml = await res.text();
  return parsePropfind(xml, url, decodeURIComponent(new URL(url).pathname));
}

function parsePropfind(xml, requestUrl, requestPath) {
  const items = [];
  // 逐条 <d:response> 扫描（与 LibreTV XMLTV 解析同思路：正则单趟，不建 DOM）
  const responseRe = /<d:response(?:\s[^>]*)?>([\s\S]*?)<\/d:response>/gi;
  let m;
  while ((m = responseRe.exec(xml))) {
    const block = m[1];
    const hrefMatch = block.match(/<d:href(?:\s[^>]*)?>([\s\S]*?)<\/d:href>/i);
    if (!hrefMatch) continue;
    const href = decodeURIComponent(hrefMatch[1].trim());

    // 自指过滤：href 的路径部分与请求路径相同（忽略查询串）
    let hrefPath = href;
    try {
      hrefPath = new URL(href, requestUrl).pathname;
    } catch { /* 相对 href 按原样 */ }
    if (hrefPath.replace(/\/+$/, '') === requestPath.replace(/\/+$/, '')) continue;

    const prop = block.match(/<d:prop(?:\s[^>]*)?>([\s\S]*?)<\/d:prop>/i)?.[1] ?? '';
    const isDir = /<d:collection\s*\/?>/.test(prop);
    const sizeMatch = prop.match(/<d:getcontentlength(?:\s[^>]*)?>(\d+)<\/d:getcontentlength>/i);
    const mtimeMatch = prop.match(/<d:getlastmodified(?:\s[^>]*)?>([^<]+)<\/d:getlastmodified>/i);
    const name = hrefPath.split('/').filter(Boolean).pop() ?? '';

    items.push({
      name,
      path: hrefPath,
      isDir,
      size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
      mtime: mtimeMatch ? Date.parse(mtimeMatch[1].trim()) || 0 : 0,
    });
  }
  // 目录在前，其余按名称
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-Hans-CN') : a.isDir ? -1 : 1));
  return items;
}

/** 以流式 GET 读取文件（Range 由上游响应头自然带回） */
export async function webdavGet(base, filePath, auth, rangeHeader) {
  const url = webdavUrl(base, filePath);
  const headers = { Authorization: basicAuth(auth?.user, auth?.pass) };
  if (rangeHeader) headers.Range = rangeHeader;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  return res;
}
