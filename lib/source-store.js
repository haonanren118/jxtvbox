/**
 * 源配置存储（JXTVbox 优化点之一）。
 *
 * LibreTV 把点播源/直播源存在浏览器 localStorage——换设备要重配、无法统一管理。
 * JXTVbox 改为服务端 JSON 文件持久化：
 * - 多设备共享同一份源列表；
 * - 源健康度（连续失败自动停用）也在服务端记录，换设备同样生效；
 * - 文件原子写入（tmp + rename），避免崩溃写坏配置。
 *
 * 数据文件位于 DATA_DIR（默认 ./data）：
 * - sources.json      点播源 [{key,name,url,detail,isAdult,enabled}]
 * - drama-sources.json 短剧源 [{key,name,url,detail,isAdult,enabled}]（与点播源同协议，仅短剧页使用）
 * - live-sources.json 直播源 [{key,name,url,epg,enabled}]
 * - health.json       源健康度 {url: {fails, disabledUntil, disabledForever, lastError, lastOkAt}}
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

const FILES = {
  sources: path.join(DATA_DIR, 'sources.json'),
  dramaSources: path.join(DATA_DIR, 'drama-sources.json'),
  liveSources: path.join(DATA_DIR, 'live-sources.json'),
  health: path.join(DATA_DIR, 'health.json'),
};

/** 健康度阶梯：连续失败 1 次 → 停 30 分钟；2 次 → 24 小时；≥3 次 → 长期停用 */
export const HEALTH_LADDER_MS = [30 * 60 * 1000, 24 * 60 * 60 * 1000];

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file); // 原子替换，避免半截文件
}

let idCounter = 0;
function newKey(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function sanitizeCommon(raw, index, prefix) {
  const url = String(raw?.url ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) return null;
  return {
    key: typeof raw?.key === 'string' && raw.key ? raw.key : newKey(prefix),
    name: String(raw?.name ?? '').trim() || new URL(url).hostname,
    url,
    detail: typeof raw?.detail === 'string' && /^https?:\/\//.test(raw.detail.trim()) ? raw.detail.trim().replace(/\/+$/, '') : undefined,
    isAdult: raw?.isAdult === true,
    enabled: raw?.enabled !== false,
    _order: index,
  };
}

function sanitizeSource(raw, index) {
  return sanitizeCommon(raw, index, 'src');
}

// —— 点播源 ——

export function listSources() {
  const raw = readJson(FILES.sources, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, i) => sanitizeSource(item, i))
    .filter(Boolean)
    .sort((a, b) => a._order - b._order)
    .map(({ _order, ...rest }) => rest);
}

export function saveSources(list) {
  const cleaned = list
    .map((item, i) => sanitizeSource(item, i))
    .filter(Boolean)
    .map(({ _order, ...rest }) => rest);
  writeJson(FILES.sources, cleaned);
  return cleaned;
}

// —— 短剧源（与点播源同协议：Apple CMS 采集站；仅在「短剧」页使用） ——

function sanitizeDramaSource(raw, index) {
  return sanitizeCommon(raw, index, 'drama');
}

/**
 * 源地址规范化（仅用于去重比较）：协议/域名小写、去默认端口与尾斜杠、去 query/hash。
 * 手打输入时 http/https、尾斜杠、大小写、query 的差异不应产生重复源。
 */
export function normalizeSourceUrl(u) {
  try {
    const url = new URL(String(u ?? '').trim());
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return String(u ?? '').trim().replace(/\/+$/, '');
  }
}

export function listDramaSources() {
  const raw = readJson(FILES.dramaSources, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, i) => sanitizeDramaSource(item, i))
    .filter(Boolean)
    .sort((a, b) => a._order - b._order)
    .map(({ _order, ...rest }) => rest);
}

export function saveDramaSources(list) {
  const seen = new Set();
  const cleaned = list
    .map((item, i) => sanitizeDramaSource(item, i))
    .filter(Boolean)
    // 规范化 URL 去重（保留第一条），清理手打变体造成的重复源
    .filter((s) => {
      const norm = normalizeSourceUrl(s.url);
      if (seen.has(norm)) return false;
      seen.add(norm);
      return true;
    })
    .map(({ _order, ...rest }) => rest);
  writeJson(FILES.dramaSources, cleaned);
  return cleaned;
}

// —— 直播源 ——

function sanitizeLiveSource(raw, index) {
  const url = String(raw?.url ?? '').trim();
  if (!/^https?:\/\//.test(url)) return null;
  return {
    key: typeof raw?.key === 'string' && raw.key ? raw.key : newKey('live'),
    name: String(raw?.name ?? '').trim() || new URL(url).hostname,
    url,
    epg: typeof raw?.epg === 'string' && /^https?:\/\//.test(raw.epg.trim()) ? raw.epg.trim() : undefined,
    enabled: raw?.enabled !== false,
    _order: index,
  };
}

export function listLiveSources() {
  const raw = readJson(FILES.liveSources, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, i) => sanitizeLiveSource(item, i))
    .filter(Boolean)
    .sort((a, b) => a._order - b._order)
    .map(({ _order, ...rest }) => rest);
}

export function saveLiveSources(list) {
  const cleaned = list
    .map((item, i) => sanitizeLiveSource(item, i))
    .filter(Boolean)
    .map(({ _order, ...rest }) => rest);
  writeJson(FILES.liveSources, cleaned);
  return cleaned;
}

// —— 健康度 ——

function readHealth() {
  const raw = readJson(FILES.health, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function writeHealth(map) {
  writeJson(FILES.health, map);
}

/** 源当前是否被自动停用（到点自动恢复，长期停用需手动重置） */
export function isSourceDisabled(entry) {
  if (!entry) return false;
  if (entry.disabledForever) return true;
  if (entry.disabledUntil && Date.now() < entry.disabledUntil) return true;
  return false;
}

/** 源停用剩余毫秒（0 = 未停用；Infinity = 长期） */
export function sourceDisabledRemaining(entry) {
  if (!entry) return 0;
  if (entry.disabledForever) return Infinity;
  if (entry.disabledUntil && Date.now() < entry.disabledUntil) return entry.disabledUntil - Date.now();
  return 0;
}

/** 取健康度（附加快照：是否停用/剩余时间） */
export function getHealthSnapshot() {
  const map = readHealth();
  const out = {};
  for (const [url, entry] of Object.entries(map)) {
    out[url] = {
      ...entry,
      disabled: isSourceDisabled(entry),
      remainingMs: sourceDisabledRemaining(entry),
    };
  }
  return out;
}

/** 搜索成功：清零失败计数 */
export function markSourceOk(url) {
  const map = readHealth();
  const prev = map[url];
  if (!prev || prev.fails) {
    map[url] = { fails: 0, disabledUntil: 0, disabledForever: false, lastError: undefined, lastOkAt: Date.now() };
    writeHealth(map);
  } else if (prev.lastError) {
    prev.lastError = undefined;
    prev.lastOkAt = Date.now();
    writeHealth(map);
  }
}

/**
 * 搜索失败：按阶梯提升停用时长。
 * 返回本次判定后的停用剩余毫秒（0 = 未触发停用）。
 */
export function markSourceFail(url, error) {
  const map = readHealth();
  const prev = map[url] ?? { fails: 0, disabledUntil: 0, disabledForever: false };
  const fails = (prev.fails ?? 0) + 1;
  let disabledUntil = 0;
  let disabledForever = false;
  if (fails >= 3) {
    disabledForever = true;
  } else if (fails >= 1) {
    disabledUntil = Date.now() + HEALTH_LADDER_MS[Math.min(fails - 1, HEALTH_LADDER_MS.length - 1)];
  }
  map[url] = { ...prev, fails, disabledUntil, disabledForever, lastError: String(error || '请求失败').slice(0, 200) };
  writeHealth(map);
  return disabledForever ? Infinity : Math.max(0, disabledUntil - Date.now());
}

/** 重置单个源的健康度 */
export function resetSourceHealth(url) {
  const map = readHealth();
  delete map[url];
  writeHealth(map);
}

/** 重置全部源的健康度 */
export function resetAllHealth() {
  writeHealth({});
}

/** 部署者通过 DEFAULT_SOURCES 环境变量预置的采集站（首次运行写入） */
export function envSources() {
  const raw = process.env.DEFAULT_SOURCES;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, i) => sanitizeSource({ ...item, enabled: true }, 1000 + i))
      .filter(Boolean)
      .map(({ _order, ...rest }) => rest);
  } catch {
    console.warn('[JXTVbox] DEFAULT_SOURCES 解析失败，已忽略');
    return [];
  }
}

/** 部署者通过 DEFAULT_LIVE_SOURCES 环境变量预置的直播源 */
export function envLiveSources() {
  const raw = process.env.DEFAULT_LIVE_SOURCES;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, i) => sanitizeLiveSource({ ...item, enabled: true }, 1000 + i))
      .filter(Boolean)
      .map(({ _order, ...rest }) => rest);
  } catch {
    console.warn('[JXTVbox] DEFAULT_LIVE_SOURCES 解析失败，已忽略');
    return [];
  }
}

/** 部署者通过 DEFAULT_DRAMA_SOURCES 环境变量预置的短剧源 */
export function envDramaSources() {
  const raw = process.env.DEFAULT_DRAMA_SOURCES;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, i) => sanitizeDramaSource({ ...item, enabled: true }, 1000 + i))
      .filter(Boolean)
      .map(({ _order, ...rest }) => rest);
  } catch {
    console.warn('[JXTVbox] DEFAULT_DRAMA_SOURCES 解析失败，已忽略');
    return [];
  }
}

/**
 * 首次启动合并预置源：
 * - 点播源/直播源/短剧源文件不存在时，用环境变量预置值初始化；
 * - 文件已存在时不动（用户配置优先），但会把「环境变量里有、文件里没有」的源补进去。
 */
export function mergeEnvSourcesOnBoot() {
  const envVod = envSources();
  const envLive = envLiveSources();
  const envDrama = envDramaSources();
  if (envVod.length > 0) {
    const current = readJson(FILES.sources, null);
    if (!Array.isArray(current)) {
      saveSources(envVod);
    } else {
      const have = new Set(current.map((s) => String(s?.url ?? '').replace(/\/+$/, '')));
      const missing = envVod.filter((s) => !have.has(s.url));
      if (missing.length > 0) saveSources([...current, ...missing]);
    }
  }
  if (envDrama.length > 0) {
    const current = readJson(FILES.dramaSources, null);
    if (!Array.isArray(current)) {
      saveDramaSources(envDrama);
    } else {
      const have = new Set(current.map((s) => normalizeSourceUrl(s?.url)));
      const missing = envDrama.filter((s) => !have.has(normalizeSourceUrl(s.url)));
      if (missing.length > 0) saveDramaSources([...current, ...missing]);
    }
  }
  if (envLive.length > 0) {
    const current = readJson(FILES.liveSources, null);
    if (!Array.isArray(current)) {
      saveLiveSources(envLive);
    } else {
      const have = new Set(current.map((s) => String(s?.url ?? '')));
      const missing = envLive.filter((s) => !have.has(s.url));
      if (missing.length > 0) saveLiveSources([...current, ...missing]);
    }
  }
}
