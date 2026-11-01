/**
 * hls.js loader 工厂：片段缓存命中（cache-first）。
 * 广告过滤已在服务端代理（/api/proxy）完成 stripAdGroups，前端 loader 只做缓存。
 *
 * 关键细节：缓存命中时用预取阶段记录的真实耗时（costMs）合成 hls.js 的
 * loader stats——如果让加载时长为 0，ABR 会把它当成无限带宽，错误地拉高码率。
 */

import { buildSegmentCacheKey, readCachedSegment, touchMeta } from './video-cache.js';
import { stripAdGroups } from './m3u8-util.js';

export function createHlsLoader(HlsCtor, options = {}) {
  const { onProbe, blockAd = false } = options;

  return class CacheFirstHlsLoader extends HlsCtor.DefaultConfig.loader {
    constructor(config) {
      super(config);
      this.destroyed = false;
      const load = this.load.bind(this);

      this.load = (context, config, callbacks) => {
        const isPlaylist = context.type === 'manifest' || context.type === 'level';

        // 播放列表：网络加载 + 可选广告过滤（默认开启）
        if (isPlaylist) {
          if (blockAd) {
            const onSuccess = callbacks.onSuccess;
            callbacks.onSuccess = function (response, stats, ctx, networkDetails) {
              if (response.data && typeof response.data === 'string') {
                response.data = stripAdGroups(response.data);
              }
              onSuccess(response, stats, ctx, networkDetails);
            };
          }
          load(context, config, callbacks);
          return;
        }

        // BYTERANGE 分片（原文件切片）：无法独立缓存，直接回源
        if (context.rangeStart || context.rangeEnd) {
          load(context, config, callbacks);
          return;
        }

        // 片段：cache-first
        const key = buildSegmentCacheKey(context.url);
        readCachedSegment(key).then((hit) => {
          if (this.destroyed) return;
          if (hit) {
            void touchMeta(key);
            onProbe?.(true);
            const now = performance.now();
            Object.assign(this.stats, {
              loading: { start: now - hit.costMs, first: now - hit.costMs + 1, end: now },
              total: hit.data.byteLength,
              loaded: hit.data.byteLength,
            });
            callbacks.onSuccess({ url: context.url, data: hit.data }, this.stats, context, undefined);
            return;
          }
          onProbe?.(false);
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
            if (!this.destroyed) onSuccess(response, stats, ctx, networkDetails);
          };
          load(context, config, callbacks);
        });
      };
    }

    abort() {
      this.destroyed = true;
      super.abort();
    }

    destroy() {
      this.destroyed = true;
      super.destroy?.();
    }
  };
}
