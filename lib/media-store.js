/**
 * 媒体源存储（网盘 / 本地 / NAS）。
 * 持久化到 DATA_DIR/media-sources.json，原子写入。
 *
 * 源类型：
 * - local   本地/NAS 目录（由 MEDIA_DIRS 环境变量声明，docker 卷挂载或 fpk 共享目录接入）
 * - webdav  WebDAV（NAS / 坚果云 / Alist-WebDAV 等）
 * - alist   Alist / OpenList（聚合网盘：阿里云盘、夸克、115、天翼等）
 * - emby    Emby / Jellyfin 媒体库
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'media-sources.json');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.webm', '.rmvb', '.iso', '.mpg', '.mpeg', '.3gp', '.f4v']);
const SUBTITLE_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub']);

export function isVideoFile(name) {
  return VIDEO_EXT.has(path.extname(name).toLowerCase());
}

export function isSubtitleFile(name) {
  return SUBTITLE_EXT.has(path.extname(name).toLowerCase());
}

/** 人类可读的文件大小 */
export function humanSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function readJson() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJson(list) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}

function sanitize(raw) {
  const type = raw?.type;
  if (!['local', 'webdav', 'alist', 'emby'].includes(type)) return null;
  const url = String(raw?.url ?? '').trim();
  if (type !== 'local' && !/^https?:\/\//.test(url)) return null;
  if (type === 'local' && !url) return null;
  return {
    key: typeof raw?.key === 'string' && raw.key ? raw.key : `media_${Date.now().toString(36)}`,
    type,
    name: String(raw?.name ?? '').trim() || (type === 'local' ? path.basename(url) : new URL(url).hostname),
    url: type === 'local' ? url.replace(/\/+$/, '') : url.replace(/\/+$/, ''),
    user: typeof raw?.user === 'string' ? raw.user : undefined,
    pass: typeof raw?.pass === 'string' ? raw.pass : undefined,
    token: typeof raw?.token === 'string' ? raw.token : undefined,
    apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey : undefined,
    userId: typeof raw?.userId === 'string' ? raw.userId : undefined,
    dirPassword: typeof raw?.dirPassword === 'string' ? raw.dirPassword : undefined,
    enabled: raw?.enabled !== false,
  };
}

export function listMediaSources() {
  return readJson().map(sanitize).filter(Boolean);
}

export function saveMediaSources(list) {
  const cleaned = list.map(sanitize).filter(Boolean);
  writeJson(cleaned);
  return cleaned;
}

export function findMediaSource(key) {
  return listMediaSources().find((s) => s.key === key) ?? null;
}

/** MEDIA_DIRS 环境变量 → local 源列表（逗号分隔的目录；Docker 卷 / fpk 共享目录挂载点） */
export function envMediaDirs() {
  const raw = process.env.MEDIA_DIRS || process.env.MEDIA_DIR || '';
  return raw
    .split(/[,;]/)
    .map((d) => d.trim())
    .filter(Boolean);
}

/** 启动时确保 MEDIA_DIRS 声明的本地目录以 local 源形式存在 */
export function mergeEnvMediaDirsOnBoot() {
  const dirs = envMediaDirs();
  if (dirs.length === 0) return;
  const current = readJson();
  const have = new Set(current.filter((s) => s?.type === 'local').map((s) => String(s.url).replace(/\/+$/, '')));
  let changed = false;
  for (const dir of dirs) {
    const norm = dir.replace(/\/+$/, '');
    if (!have.has(norm)) {
      current.push({ key: `media_local_${norm.replace(/[^\w]/g, '_')}`, type: 'local', name: path.basename(norm) || norm, url: norm, enabled: true });
      changed = true;
    }
  }
  if (changed) writeJson(current);
}

/** 递归扫描本地目录中的视频文件（有深度与数量上限，防止巨型库拖垮请求） */
export function scanLocalVideos(root, { maxDepth = 4, maxFiles = 2000 } = {}) {
  const out = [];
  const walk = (dir, depth, rel) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (depth < maxDepth) walk(abs, depth + 1, relPath);
      } else if (ent.isFile() && isVideoFile(ent.name)) {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(abs);
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* 忽略 */ }
        out.push({ name: ent.name, path: relPath, size, mtime });
      }
    }
  };
  walk(root, 1, '');
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
