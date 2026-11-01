/**
 * HLS 播放错误恢复策略（移植自 LibreTV src/lib/playback-recovery.ts）。
 * 只做决策，不碰 hls 实例：调用方拿到决策后自行执行。
 * 计数语义：「连续失败次数」——FRAG_LOADED 即视为链路恢复，归零；
 * 动作后 3s 静默窗内的成功不清零（防重试成功瞬间的噪声）。
 */

export const HLS_ERROR_NETWORK = 'networkError';
export const HLS_ERROR_MEDIA = 'mediaError';

const HARD_FAIL_DETAILS = new Set([
  'manifestParsingError',
  'manifestIncompatibleCodecsError',
  'levelEmptyError',
]);

const DEFAULT_RECOVERY_POLICY = {
  maxNetworkRetries: 3,
  maxMediaRecoveries: 2,
  baseDelayMs: 800,
  maxDelayMs: 8000,
};

const HEALTHY_QUIET_MS = 3000;

export class PlaybackRecovery {
  constructor(policy = {}) {
    this.policy = { ...DEFAULT_RECOVERY_POLICY, ...policy };
    this.networkRetries = 0;
    this.mediaRecoveries = 0;
    this.lastActionAt = 0;
    this.disposed = false;
    this.timers = new Set();
  }

  markHealthy() {
    if (this.disposed) return;
    if (this.lastActionAt && Date.now() - this.lastActionAt < HEALTHY_QUIET_MS) return;
    this.networkRetries = 0;
    this.mediaRecoveries = 0;
  }

  onFatal(type, details) {
    if (this.disposed) return { action: 'ignore', reason: '已销毁' };
    this.lastActionAt = Date.now();

    if (HARD_FAIL_DETAILS.has(details)) {
      return { action: 'switch-source', reason: '播放列表格式无法解析，重试无意义' };
    }
    if (type === HLS_ERROR_MEDIA) {
      this.mediaRecoveries += 1;
      if (this.mediaRecoveries > this.policy.maxNetworkRetries && this.mediaRecoveries > this.policy.maxMediaRecoveries) {
        return { action: 'switch-source', reason: '媒体解码错误多次恢复无效' };
      }
      if (this.mediaRecoveries > this.policy.maxMediaRecoveries) {
        return { action: 'switch-source', reason: '媒体解码错误多次恢复无效' };
      }
      return {
        action: 'recover-media',
        swapAudio: this.mediaRecoveries >= 2,
        attempt: this.mediaRecoveries,
        reason: '媒体解码错误，尝试恢复',
      };
    }
    if (type === HLS_ERROR_NETWORK) {
      this.networkRetries += 1;
      if (this.networkRetries > this.policy.maxNetworkRetries) {
        return { action: 'switch-source', reason: `网络错误已重试 ${this.policy.maxNetworkRetries} 次仍未恢复` };
      }
      return {
        action: 'retry',
        attempt: this.networkRetries,
        delayMs: Math.min(this.policy.baseDelayMs * 2 ** (this.networkRetries - 1), this.policy.maxDelayMs),
        reason: '网络错误，退避重试',
      };
    }
    return { action: 'switch-source', reason: `未知的致命错误类型：${type}` };
  }

  schedule(delayMs, task) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposed) task();
    }, delayMs);
    this.timers.add(timer);
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

export function describeHlsError(type, details) {
  if (HARD_FAIL_DETAILS.has(details)) return '播放列表格式无法解析';
  switch (details) {
    case 'manifestLoadError':
    case 'manifestLoadTimeOut':
      return '播放列表加载失败';
    case 'manifestParsingError':
      return '播放列表解析失败';
    case 'fragLoadError':
    case 'fragLoadTimeOut':
      return '视频分片加载失败';
    case 'keyLoadError':
      return '解密密钥加载失败';
    case 'bufferStalledError':
      return '缓冲不足';
    default:
      return type === HLS_ERROR_MEDIA ? '媒体解码错误' : `播放错误（${details || type}）`;
  }
}
