/**
 * 前端 m3u8 工具：文档基址锚定 + 广告分片过滤。
 * stripAdGroups 移植自 LibreTV src/lib/m3u8.ts（保守判定语义完全一致）：
 * 1. URL 特征中插段（adjump 等，任意位置）；
 * 2. 长正片段之间的超短插入段（纯时长型中插广告）；
 * 3. 片头无特征插入段（dytt 式，位置+短小启发式）；
 * 最后统一清掉首分片前失去语义的 DISCONTINUITY。
 */

export function documentBaseURI() {
  return typeof document === 'undefined' ? undefined : document.baseURI;
}

const LEAD_AD_MAX_SECONDS = 90;
const LEAD_AD_MAX_SEGMENTS = 20;
const AD_URL_PATTERN = /adjump|advert|\/ads?\//i;
const INTERSTITIAL_MAX_SECONDS = 30;
const INTERSTITIAL_NEIGHBOR_MIN_SECONDS = 120;

function isDisc(l) { return l.trim() === '#EXT-X-DISCONTINUITY'; }
function isSegment(l) { const t = l.trim(); return t !== '' && !t.startsWith('#'); }

function stripLeadAdGroup(content) {
  if (!content) return '';
  const lines = content.split('\n');
  const discIdx = [];
  for (let i = 0; i < lines.length; i++) if (isDisc(lines[i])) discIdx.push(i);
  if (discIdx.length >= 4) {
    const groupSize = (from, to) => { let s = 0; for (let k = from; k < to; k++) if (isSegment(lines[k])) s += 1; return s; };
    const leadSize = groupSize(discIdx[0] + 1, discIdx[1]);
    const others = [];
    for (let g = 1; g < discIdx.length; g++) {
      others.push(groupSize(discIdx[g] + 1, g + 1 < discIdx.length ? discIdx[g + 1] : lines.length));
    }
    const sorted = [...others].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (Math.abs(leadSize - median) <= Math.max(3, median * 0.5)) return content;
  }
  const firstDisc = discIdx[0];
  if (firstDisc === undefined) return content;
  if (lines.slice(0, firstDisc).some(isSegment)) return content;
  const nextDisc = discIdx.slice(1).find((i) => i > firstDisc);
  if (nextDisc === undefined) return content;
  let seconds = 0;
  let count = 0;
  for (let i = firstDisc + 1; i < nextDisc; i++) {
    const m = lines[i].trim().match(/^#EXTINF:([\d.]+)/);
    if (m) seconds += parseFloat(m[1]) || 0;
    else if (isSegment(lines[i])) count += 1;
  }
  if (count === 0 || count > LEAD_AD_MAX_SEGMENTS) return content;
  if (seconds <= 0 || seconds > LEAD_AD_MAX_SECONDS) return content;
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

function stripMarkedAdGroups(content) {
  if (!content) return '';
  const lines = content.split('\n');
  const drop = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isDisc(lines[i])) { i += 1; continue; }
    let j = i + 1;
    let count = 0;
    let allAd = true;
    while (j < lines.length && !isDisc(lines[j])) {
      if (isSegment(lines[j])) {
        count += 1;
        if (!AD_URL_PATTERN.test(lines[j].trim())) allAd = false;
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
  if (!drop.some(Boolean)) return content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

function scanGroups(lines) {
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

function stripInterstitialAdGroups(content) {
  if (!content) return '';
  const lines = content.split('\n');
  const groups = scanGroups(lines);
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
  if (!drop.some(Boolean)) return content;
  return lines.filter((_, idx) => !drop[idx]).join('\n');
}

function stripLeadingDisc(content) {
  const lines = content.split('\n');
  const firstSeg = lines.findIndex(isSegment);
  if (firstSeg <= 0) return content;
  const kept = lines.filter((l, i) => !(i < firstSeg && l.trim() === '#EXT-X-DISCONTINUITY'));
  return kept.length === lines.length ? content : kept.join('\n');
}

export function stripAdGroups(m3u8Content) {
  if (!m3u8Content) return '';
  return stripLeadingDisc(stripLeadAdGroup(stripInterstitialAdGroups(stripMarkedAdGroups(m3u8Content))));
}
