/**
 * Emby / Jellyfin 客户端（零依赖）。
 * NAS 本地影视库的标准管理方案；只需 api_key + userId 即可列媒体与取流地址。
 */

function apiUrl(base, path, apiKey, params = {}) {
  const u = new URL(base.replace(/\/+$/, '') + path);
  u.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.href;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 取用户信息（userId 为空时取第一个管理员用户） */
export async function embyResolveUser(source) {
  if (source.userId) return source.userId;
  const data = await getJson(apiUrl(source.url, '/Users', source.apiKey));
  const users = Array.isArray(data) ? data : [];
  const admin = users.find((u) => u.Policy?.IsAdministrator) ?? users[0];
  if (!admin?.Id) throw new Error('未找到可用用户');
  return admin.Id;
}

/** 媒体库（Views）列表 */
export async function embyViews(source) {
  const userId = await embyResolveUser(source);
  const data = await getJson(apiUrl(source.url, `/Users/${userId}/Views`, source.apiKey));
  return (data.Items ?? []).map((v) => ({ id: v.Id, name: v.Name, type: v.CollectionType }));
}

/** 影片/剧集列表（可按库过滤） */
export async function embyItems(source, { parentId, search, startIndex = 0, limit = 100 } = {}) {
  const userId = await embyResolveUser(source);
  const data = await getJson(apiUrl(source.url, `/Users/${userId}/Items`, source.apiKey, {
    Recursive: true,
    IncludeItemTypes: 'Movie,Episode',
    Fields: 'Overview,ProductionYear,CommunityRating,PrimaryImageAspectRatio',
    SortBy: 'DateCreated,SortName',
    SortOrder: 'Descending',
    StartIndex: startIndex,
    Limit: limit,
    ParentId: parentId,
    SearchTerm: search,
  }));
  return (data.Items ?? []).map((it) => ({
    id: it.Id,
    name: it.Name,
    type: it.Type, // Movie / Episode
    seriesName: it.SeriesName,
    season: it.ParentIndexNumber,
    episode: it.IndexNumber,
    year: it.ProductionYear,
    rating: it.CommunityRating,
    overview: it.Overview,
    container: it.Container,
    imageTag: it.ImageTags?.Primary,
  }));
}

/** 播放地址（服务端代理转发，避免 api_key 暴露给前端） */
export function embyStreamUrl(source, itemId) {
  return `/api/media/stream?source=${encodeURIComponent(source.key)}&id=${encodeURIComponent(itemId)}`;
}

/** 上游真实流地址 */
export function embyUpstreamStream(source, itemId, container = 'mp4') {
  return apiUrl(source.url, `/Videos/${itemId}/stream.${container}`, source.apiKey, { Static: true });
}

/** 封面地址 */
export function embyImageUrl(source, itemId, tag) {
  return apiUrl(source.url, `/Items/${itemId}/Images/Primary`, source.apiKey, { tag, quality: 90 });
}
