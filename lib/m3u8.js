/**
 * m3u8 处理：代理路径重写与广告分片过滤。
 * 移植自 LibreTV src/lib/m3u8.ts，stripAdGroups 的保守判定语义完全保留
 * （片头插入段 / URL 特征中插段 / 时长型中插段三层启发式 + 首 DISCONTINUITY 清理）。
 */

/** 点播代理地址（查询串形式：路径形式会被部分网关的 URL 归一化破坏） */
export const PROXY_BASE = '/api/proxy?url=';
/** 直播流代理地址（查询串形式） */
export const LIVE_STREAM_BASE = '/api/live/stream?url=';

/** URI 已是本站代理地址时不再二次改写 */
export function isProxiedUri(uri) {
  return uri.startsWith('/api/proxy') || uri.startsWith('/api/live/stream');
}

export function documentBaseURI() {
  return typeof document === 'undefined' ? undefined : document.baseURI;
}

export function makeAbsolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** 将 m3u8 中的地址改写为经过本站代理的地址（分片/key/map 同样改写）。 */
export function rewriteM3u8(content, baseUrl, depth = 0, prefix = PROXY_BASE) {
  if (depth > 5) return content;
  const lines = content.split('\n');
  const out = lines.map((line) => {
    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
      return line.replace(/(URI=")([^"]+)(")/g, (m, p1, uri, p2) => {
        if (isProxiedUri(uri)) return m;
        return p1 + prefix + encodeURIComponent(makeAbsolute(uri, baseUrl)) + p2;
      });
    }
    if (line.startsWith('#') || line.trim() === '') return line;
    if (isProxiedUri(line)) return line;
    return prefix + encodeURIComponent(makeAbsolute(line, baseUrl));
  });
  return out.join('\n');
}

/**
 * 片头广告段判定上限。dytt 等采集站把固定一支广告（约 15-60s，10 片左右）
 * 作为首个 DISCONTINUITY 段混入所有视频；正片分段（每段 20-40s）与其结构相同，
 * 只能靠「位于片头 + 短小 + 之后仍有分段」这三个特征保守区分，超限即不动。
 */
const LEAD_AD_MAX_SECONDS = 90;
const LEAD_AD_MAX_SEGMENTS = 20;

export function stripLeadAdGroup(m3u8Content) {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const isDisc = (l) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  // 多分组封装（采集站把流按固定块切分、每个衔接处都打 DISCONTINUITY）不是广告。
  // 片头组与其余分组同构（大小一致）时跳过剔除——任何启发式都无法区分。
  const discIdx = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);
  if (discIdx.length >= 4) {
    const groupSize = (from, to) => {
      let seg = 0;
      for (let k = from; k < to; k++) if (isSegment(lines[k])) seg += 1;
      return seg;
    };
    const leadSize = groupSize(discIdx[0] + 1, discIdx[1]);
    const others = [];
    for (let g = 1; g < discIdx.length; g++) {
      others.push(groupSize(discIdx[g] + 1, g + 1 < discIdx.length ? discIdx[g + 1] : lines.length));
    }
    const sorted = [...others].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const typical = Math.abs(leadSize - median) <= Math.max(3, median * 0.5);
    if (typical) return m3u8Content;
  }

  const firstDisc = discIdx[0];
  if (firstDisc === undefined) return m3u8Content;
  if (lines.slice(0, firstDisc).some(isSegment)) return m3u8Content;

  const nextDisc = discIdx.slice(1).find((i) => i > firstDisc);
  if (nextDisc === undefined) return m3u8Content;

  let seconds = 0;
  let count = 0;
  for (let i = firstDisc + 1; i < nextDisc; i++) {
    const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
    if (m) seconds += parseFloat(m[1]) || 0;
    else if (isSegment(lines[i])) count += 1;
  }
  if (count === 0 || count > LEAD_AD_MAX_SEGMENTS) return m3u8Content;
  if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return m3u8Content;

  const kept = lines.filter((l, i) => {
    if (i < firstDisc || i >= nextDisc) return true;
    const t = l.trim();
    return t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP');
  });
  const out = [];
  let seenSegment = false;
  for (const l of kept) {
    if (!seenSegment && isDisc(l)) continue;
    if (isSegment(l)) seenSegment = true;
    out.push(l);
  }
  return out.join('\n');
}

/** 广告分片 URL 特征。暴风等采集云把中插广告放在明显的路径里（adjump/advert/ads）。 */
const AD_URL_PATTERN = /adjump|advert|\/ads?\//i;

function looksLikeAdUrl(line) {
  return AD_URL_PATTERN.test(line.trim());
}

/** 按 URL 特征剔除任意位置的 DISCONTINUITY 广告段（片头/中插均覆盖）。 */
function stripMarkedAdGroups(m3u8Content) {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const isDisc = (l) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  const drop = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isDisc(lines[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    let count = 0;
    let allAd = true;
    while (j < lines.length && !isDisc(lines[j])) {
      if (isSegment(lines[j])) {
        count += 1;
        if (!looksLikeAdUrl(lines[j])) allAd = false;
      }
      j += 1;
    }
    if (count > 0 && allAd) {
      drop[i] = true;
      for (let k = i + 1; k < j; k++) {
        const t = lines[k].trim();
        if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
        drop[k] = true;
      }
    }
    i = j;
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/** 中插广告段的时长判定阈值：两长夹一短才视为插入广告。 */
const INTERSTITIAL_MAX_SECONDS = 30;
const INTERSTITIAL_NEIGHBOR_MIN_SECONDS = 120;

function scanGroups(lines, isDisc, isSegment) {
  const discIdx = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);

  const groups = [];
  const bounds = [0, ...discIdx, lines.length];
  for (let k = 0; k < bounds.length - 1; k++) {
    const start = k === 0 ? 0 : bounds[k] + 1;
    const end = bounds[k + 1];
    let seconds = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
      if (m) seconds += parseFloat(m[1]) || 0;
      else if (isSegment(lines[i])) count += 1;
    }
    groups.push({ start, end, discLine: k === 0 ? -1 : bounds[k], seconds, count });
  }
  return groups;
}

/** 剔除「长正片段之间的超短插入段」（URL 无特征的纯时长型中插广告）。 */
function stripInterstitialAdGroups(m3u8Content) {
  if (!m3u8Content) return '';
  const lines = m3u8Content.split('\n');
  const isDisc = (l) => l.trim() === '#EXT-X-DISCONTINUITY';
  const isSegment = (l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  };

  const groups = scanGroups(lines, isDisc, isSegment);
  const drop = new Array(lines.length).fill(false);
  for (let k = 1; k < groups.length; k++) {
    const g = groups[k];
    const prev = groups[k - 1];
    const next = groups[k + 1];
    if (g.count === 0 || g.discLine < 0) continue;
    if (g.seconds <= 0 || g.seconds > INTERSTITIAL_MAX_SECONDS) continue;
    if (!prev || prev.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
    if (!next || next.seconds < INTERSTITIAL_NEIGHBOR_MIN_SECONDS) continue;
    drop[g.discLine] = true;
    for (let i = g.start; i < g.end; i++) {
      const t = lines[i].trim();
      if (t.startsWith('#EXT-X-KEY') || t.startsWith('#EXT-X-MAP')) continue;
      drop[i] = true;
    }
  }
  if (!drop.some(Boolean)) return m3u8Content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

/** 清除首个分片之前的 DISCONTINUITY：其前没有媒体内容，标记无语义。 */
function stripLeadingDisc(content) {
  const lines = content.split('\n');
  const firstSeg = lines.findIndex((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#');
  });
  if (firstSeg <= 0) return content;
  const kept = lines.filter((l, i) => !(i < firstSeg && l.trim() === '#EXT-X-DISCONTINUITY'));
  return kept.length === lines.length ? content : kept.join('\n');
}

/**
 * 广告过滤总入口，按可靠度依次：
 * 1. URL 特征中插段（adjump 等，任意位置）；
 * 2. 长正片段之间的超短插入段（纯时长型中插广告）；
 * 3. 片头无特征插入段（dytt 式，位置+短小启发式）；
 * 最后统一清掉首分片前失去语义的 DISCONTINUITY。
 */
export function stripAdGroups(m3u8Content) {
  if (!m3u8Content) return '';
  return stripLeadingDisc(stripLeadAdGroup(stripInterstitialAdGroups(stripMarkedAdGroups(m3u8Content))));
}
