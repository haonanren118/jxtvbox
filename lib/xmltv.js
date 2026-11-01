/**
 * XMLTV 节目单解析。
 * 移植自 LibreTV src/lib/xmltv.ts：
 * XMLTV 文件常达数十 MB，不做完整 DOM 解析，而是单趟正则扫描 <programme> 节点，
 * 按频道索引、按时间窗裁剪并丢弃原始文本。
 * 时间格式：`20240101120000 +0800`（秒可带毫秒小数，时区可省略或为 Z / ±hhmm）。
 */

import { gunzipSync } from 'node:zlib';

const PROGRAMME_RE = /<programme\s+([^>]*?)\/>|<programme\s+([^>]*?)>([\s\S]*?)<\/programme>/g;
const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i;
const DESC_RE = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/i;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 安全解码码点：畸形实体（越界/NaN）返回空串而非抛 RangeError */
function safeCodePoint(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** 解析 XMLTV 实体（含 CDATA 与数字实体） */
function decodeXmlText(raw) {
  let text = raw.trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 解析 `YYYYMMDDHHmmss(.fff)?( +hhmm | Z)?` 为 epoch ms；无法解析返回 NaN */
export function parseXmltvTime(raw) {
  const m = raw
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.(\d{1,3}))?(?:\s*([+-])(\d{2})(\d{2})|Z)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, frac, sign, tzh, tzm] = m;
  const utcMs = Date.UTC(
    +y, +mo - 1, +d, +(h || 0), +(mi || 0), +(s || 0),
    frac ? +(frac.padEnd(3, '0')) : 0
  );
  if (!sign) return utcMs;
  const offsetMin = (+tzh) * 60 + (+tzm);
  const offsetMs = offsetMin * 60 * 1000 * (sign === '-' ? -1 : 1);
  return utcMs - offsetMs;
}

function extractAttrs(attrText) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrText))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

/**
 * 解析 XMLTV 内容。string 直接入扫描；Buffer 自动识别 gzip（1f 8b 魔数）解压。
 * 只保留 [now, now + windowMs] 窗口内的节目，按频道分组并按开播时间排序。
 */
export function parseXmltv(content, windowMs = DEFAULT_WINDOW_MS, now = Date.now()) {
  let text;
  if (Buffer.isBuffer(content)) {
    text =
      content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b
        ? gunzipSync(content).toString('utf8')
        : content.toString('utf8');
  } else {
    text = content;
  }

  const result = new Map();
  const windowEnd = now + windowMs;

  PROGRAMME_RE.lastIndex = 0;
  let m;
  while ((m = PROGRAMME_RE.exec(text))) {
    const attrText = m[1] ?? m[2] ?? '';
    const inner = m[3] ?? '';
    const attrs = extractAttrs(attrText);
    const channelId = attrs['channel']?.trim();
    if (!channelId) continue;
    const start = parseXmltvTime(attrs['start'] || '');
    const stop = parseXmltvTime(attrs['stop'] || '');
    if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
    if (stop <= now || start >= windowEnd) continue;

    const titleMatch = inner.match(TITLE_RE);
    const descMatch = inner.match(DESC_RE);
    const program = {
      channelId,
      start,
      stop,
      title: titleMatch ? decodeXmlText(titleMatch[1]) : '',
    };
    if (descMatch) program.desc = decodeXmlText(descMatch[1]);
    if (!program.title) continue;

    const list = result.get(channelId);
    if (list) list.push(program);
    else result.set(channelId, [program]);
  }

  for (const list of result.values()) list.sort((a, b) => a.start - b.start);
  return result;
}

/** 取某频道当前正在播出的节目与下一个节目 */
export function currentAndNext(programs, at = Date.now()) {
  let current;
  let next;
  for (const p of programs) {
    if (p.start <= at && p.stop > at) {
      current = p;
      continue;
    }
    if (p.start > at) {
      next = p;
      break;
    }
  }
  return { current, next };
}
