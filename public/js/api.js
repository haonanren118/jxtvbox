/**
 * API 客户端：统一错误处理与流式搜索。
 */

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  status: () => request('/api/status'),

  login: (password) =>
    request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  logout: () => request('/api/logout', { method: 'POST' }),

  search: (wd, sources, filterAdult = true) =>
    request('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wd, sources, filterAdult }),
    }),

  detail: (id, source, wd) =>
    request(`/api/detail?id=${encodeURIComponent(id)}&source=${encodeURIComponent(JSON.stringify(source))}${wd ? `&wd=${encodeURIComponent(wd)}` : ''}`),

  proxyUrl: (url, stripAd = true) => `/api/proxy?url=${encodeURIComponent(url)}${stripAd ? '' : '&ad=0'}`,

  // —— 点播源管理 ——

  listSources: () => request('/api/sources'),

  addSource: (body) =>
    request('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),

  updateSource: (body) =>
    request('/api/sources/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),

  deleteSource: (key) =>
    request('/api/sources/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }),

  resetHealth: (url) =>
    request('/api/sources/reset-health', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }),

  testSource: (url) =>
    request('/api/source/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }),

  // —— 直播 ——

  livePlaylist: (url) => request(`/api/live/playlist?url=${encodeURIComponent(url)}`),
  liveEpg: (url, channelId) => request(`/api/live/epg?url=${encodeURIComponent(url)}&channelId=${encodeURIComponent(channelId)}`),
  liveStreamUrl: (url) => `/api/live/stream?url=${encodeURIComponent(url)}`,

  addLiveSource: (body) =>
    request('/api/live-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  deleteLiveSource: (key) =>
    request('/api/live-sources/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }),

  // —— 短剧（源管理与点播源同协议：Apple CMS 采集站） ——

  dramaSources: () => request('/api/drama-sources'),

  addDramaSource: (body) =>
    request('/api/drama-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),

  updateDramaSource: (body) =>
    request('/api/drama-sources/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),

  deleteDramaSource: (key) =>
    request('/api/drama-sources/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }),

  dramaCategories: (sourceKey) => request(`/api/drama/categories?source=${encodeURIComponent(sourceKey)}`),

  dramaList: (sourceKey, { t = '', pg = 1, wd = '' } = {}) => {
    const params = new URLSearchParams({ source: sourceKey, pg: String(pg) });
    if (t) params.set('t', t);
    if (wd) params.set('wd', wd);
    return request(`/api/drama/list?${params.toString()}`);
  },

  // —— 媒体库（网盘 / 本地 / NAS / Emby） ——

  mediaSources: () => request('/api/media/sources'),
  mediaList: (source, path) => request(`/api/media/list?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path || '/')}`),
  mediaScan: (source) => request(`/api/media/scan?source=${encodeURIComponent(source)}`),
  mediaStreamUrl: (source, path) => `/api/media/stream?source=${encodeURIComponent(source)}&path=${encodeURIComponent(path)}`,
  mediaEmbyStreamUrl: (source, id) => `/api/media/stream?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`,

  addMediaSource: (body) =>
    request('/api/media/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  deleteMediaSource: (key) =>
    request('/api/media/sources/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }),

  // —— 豆瓣热播推荐 ——

  doubanHot: (type = 'movie') => request(`/api/douban/hot?type=${encodeURIComponent(type)}`),
  doubanCoverUrl: (cover) => `/api/douban/cover?url=${encodeURIComponent(cover)}`,
};
