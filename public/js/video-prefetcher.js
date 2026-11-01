/**
 * 分片预取器（移植自 LibreTV src/lib/video-prefetcher.ts 的核心语义）。
 *
 * 职责：解析 m3u8 → 按当前播放位置向前铺设定量分片写入 Cache Storage。
 * - 幂等 ensure：窗口已覆盖足够余量则不重建；
 * - 并发受限（默认 2）+ 片间节奏（250ms）：预取与播放共用服务端出站（源站单 IP
 *   限速 ~200KB/s），无节奏叠加会把播放的分片出站拖慢，反而更卡；
 * - 卡顿（waiting）时让出带宽（1.2s 延时）；
 * - 暂停 = 黄金窗口：解除限速并无限铺满整集。
 */

import { documentBaseURI } from './m3u8-util.js';
import { buildSegmentCacheKey, readCachedSegment, writeCachedSegment } from './video-cache.js';
import { loadCacheSettings } from './video-cache.js';

const CONCURRENCY = 2;
const REST_INTERVAL_MS = 250; // 片间节奏：与播放分片出站错峰
const THROTTLE_DELAY_MS = 1200; // waiting 时让出带宽

/** 解析 m3u8 媒体播放列表 → 分片 URL 列表（相对地址按 manifest 地址锚定） */
export function parseSegments(m3u8Text, manifestUrl) {
  const lines = m3u8Text.split('\n');
  const segments = [];
  let pendingDuration = 0;
  let total = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    let abs;
    try {
      abs = new URL(line, manifestUrl).href;
    } catch {
      continue;
    }
    segments.push({ url: abs, duration: pendingDuration, start: total });
    total += pendingDuration;
    pendingDuration = 0;
  }
  return { segments, duration: total };
}

class Prefetcher {
  constructor() {
    this.state = 'idle'; // idle | running | done
    this.m3u8Url = null;
    this.episodeKey = null;
    this.horizonSeconds = 300;
    this.throttled = false;
    this.aborted = false;
  }

  stop() {
    this.aborted = true;
    this.state = 'idle';
    this.m3u8Url = null;
  }

  setThrottled(on) {
    this.throttled = on;
  }

  /**
   * 确保预取窗口覆盖 currentTime + horizonSeconds。
   * horizonSeconds = 0 表示铺满到片尾（暂停黄金窗口）。
   */
  async ensure({ m3u8Url, currentTime, episodeKey, horizonSeconds, onProgress }) {
    const settings = loadCacheSettings();
    if (!settings.enabled || !episodeKey) return;
    if (this.state === 'running' && this.m3u8Url === m3u8Url) {
      // 已在进行中：仅更新目标时间窗
      this.horizonSeconds = horizonSeconds ?? settings.horizonSeconds;
      return;
    }
    this.aborted = false;
    this.state = 'running';
    this.m3u8Url = m3u8Url;
    this.episodeKey = episodeKey;
    this.horizonSeconds = horizonSeconds ?? settings.horizonSeconds;
    this.onProgress = onProgress;

    try {
      const res = await fetch(m3u8Url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const text = await res.text();
      const { segments } = parseSegments(text, m3u8Url);

      // 找到 currentTime 所在分片，从那里开始向后铺
      let startIdx = segments.findIndex((s, i) => currentTime >= s.start && currentTime < s.start + s.duration);
      if (startIdx < 0) startIdx = Math.max(0, segments.findIndex((s) => s.start > currentTime) - 1);

      const horizon = this.horizonSeconds;
      const targets = [];
      for (let i = startIdx; i < segments.length; i++) {
        const s = segments[i];
        if (horizon > 0 && s.start > currentTime + horizon) break;
        targets.push(s);
      }

      let done = 0;
      const worker = async () => {
        while (!this.aborted) {
          const next = targets[done];
          if (!next) return;
          done += 1;
          if (this.throttled) await new Promise((r) => setTimeout(r, THROTTLE_DELAY_MS));
          else await new Promise((r) => setTimeout(r, REST_INTERVAL_MS));
          const key = buildSegmentCacheKey(next.url);
          const hit = await readCachedSegment(key);
          if (hit) continue;
          const started = performance.now();
          try {
            const r = await fetch(next.url, { credentials: 'same-origin' });
            if (!r.ok) continue;
            const buf = await r.arrayBuffer();
            if (this.aborted) return;
            await writeCachedSegment(key, buf, Math.round(performance.now() - started));
          } catch { /* 单分片失败不影响整体 */ }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));

      if (!this.aborted) {
        this.state = 'done';
        this.onProgress?.({ state: 'done', total: targets.length });
      }
    } catch (err) {
      if (!this.aborted) {
        this.state = 'idle';
        this.onProgress?.({ state: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

let current = null;
let nextEpisode = null;

export function getVideoPrefetcher() {
  if (!current) current = new Prefetcher();
  return current;
}

export function getNextEpisodePrefetcher() {
  if (!nextEpisode) nextEpisode = new Prefetcher();
  return nextEpisode;
}
