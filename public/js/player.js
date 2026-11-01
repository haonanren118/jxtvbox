/**
 * 播放器外壳：ArtPlayer + hls.js（移植自 LibreTV src/components/player-shell.tsx）。
 *
 * 保留能力：
 * - 片段缓存命中（cache-first loader，广告过滤已在服务端完成）
 * - 播放链路错误恢复（退避重试 / recoverMedia / 换源）
 * - 直连致命错误自动改走 /api/proxy 代理重试
 * - 进度恢复（URL position > IndexedDB）、5s 节流回写、暂停/卸载回写
 * - 前向预取 + 下一集预热、卡顿让出带宽
 * - 快捷键（空格/←→/↑↓/F/Alt+←→）、移动端长按 3 倍速
 * - 起播黑屏有声自愈（video error 重建一次）
 * - 实测画质回写（videoHeight）
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集只「切换 HLS 源」不销毁重建，
 * 否则网页全屏下整实例重建会丢失全屏上下文，触发「黑屏有声」渲染竞态。
 */

import { PlaybackRecovery, describeHlsError } from './playback-recovery.js';
import { createHlsLoader } from './hls-loader.js';
import { getVideoPrefetcher, getNextEpisodePrefetcher } from './video-prefetcher.js';
import { loadCacheSettings } from './video-cache.js';
import { getProgress, saveProgress, getQuality, saveQuality } from './db.js';

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export class JXPlayer {
  /**
   * @param {HTMLElement} container
   * @param {object} options
   *   url, title, episodeKey, nextUrl, nextEpisodeKey,
   *   getRestorePosition(), onTimeUpdate(pos,dur), onEnded(), onPause(pos,dur),
   *   onQuality(height), onRequestSwitchSource(reason),
   *   onPrevEpisode(), onNextEpisode(), hasPrevEpisode, hasNextEpisode
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.props = { ...options };
    this.art = null;
    this.hls = null;
    this.error = '';
    this.hint = '';
    this.hintTimer = null;
    this.showPoster = true;
    this.mediaHealthy = true;
    this.playbackStarted = false;
    this.videoErrorRetryUsed = false;
    this.restored = false;
    this.restoreCleanup = null;
    this.lastPrefetchEnsure = 0;
    this.currentMediaUrl = options.url;
    this.recovery = null;
    this.ended = false;
    this.lastSave = 0;
    // 全屏控制器状态
    this.fsActive = false;
    this.fsAuto = false;
    this.pendingFs = false;
    this.fsPrevStyle = null;
    this.fsHadGlass = false;
    this.fsVerifyTimer = null;
    this.fsRotateHinted = false;
    this.mount();
  }

  setProps(next) {
    this.props = { ...this.props, ...next };
  }

  showHint(text, ms = 2500) {
    this.hint = text;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => { this.hint = ''; this.renderHint(); }, ms);
    this.renderHint();
  }

  renderHint() {
    let el = this.container.querySelector('.jx-hint');
    if (!this.hint) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'jx-hint';
      this.container.appendChild(el);
    }
    el.textContent = this.hint;
  }

  setError(msg) {
    this.error = msg;
    let el = this.container.querySelector('.jx-error');
    if (!msg) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'jx-error';
      el.innerHTML = '<p class="jx-error-msg"></p><button class="jx-error-retry">重新加载</button>';
      el.querySelector('button').addEventListener('click', () => location.reload());
      this.container.appendChild(el);
    }
    el.querySelector('.jx-error-msg').textContent = msg;
  }

  reportQuality(height) {
    if (height > 0) this.props.onQuality?.(height);
  }

  /**
   * 播放器盒子贴合视频真实宽高比：
   * - 横版视频（16:9 等）：100% 宽 + 16/9，桌面/手机横屏一致；
   * - 竖版视频（短剧 720×1280）：按视频比例收窄居中，最高 78vh，
   *   避免盒子被拉爆把信息区/剧集列表挤出屏外（手机上沉浸看短剧）。
   * 在 loadedmetadata / 横竖屏切换 / resize 时重算。
   */
  applyVideoAspect() {
    const box = this.container;
    const video = this.art?.video;
    if (!box || !video) return;
    // TV 模式播放页直接全屏铺满（竖剧黑边由全屏 + 比例设置处理），不做收窄重塑
    if (window.jxTv?.isTv()) {
      box.style.width = '';
      box.style.height = '';
      box.style.aspectRatio = '';
      box.style.removeProperty('--jx-ratio');
      box.dataset.videoOrientation = 'tv';
      return;
    }
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    if (!vw || !vh) return;

    const portrait = vh > vw;
    const ratio = vw / vh;
    if (portrait) {
      // 宽度由 CSS 的 min(100%, 78svh*ratio) 决定、高度由 aspect-ratio 反推，
      // iOS 地址栏收放（innerHeight 剧变）不会让播放中的画面忽大忽小。
      box.style.width = '';
      box.style.height = '';
      box.style.aspectRatio = `${vw} / ${vh}`;
      box.style.setProperty('--jx-ratio', String(ratio));
      box.dataset.videoOrientation = 'portrait';
    } else {
      box.style.width = '';
      box.style.height = '';
      box.style.aspectRatio = `${vw} / ${vh}`;
      box.style.removeProperty('--jx-ratio');
      box.dataset.videoOrientation = 'landscape';
      // 横版且宽高比接近 16/9 时移除内联比例，交回 CSS 默认（减少重排差异）
      if (Math.abs(ratio - 16 / 9) < 0.01) box.style.aspectRatio = '';
    }
  }

  /**
   * 横屏全屏（仅触屏设备）：
   * - 手机转横屏 → 自动进入 ArtPlayer 网页全屏（不依赖浏览器 Fullscreen API，
   *   iOS Safari 兼容；控制条/手势与手动全屏完全一致），并尝试锁定方向；
   * - 转回竖屏 → 退出网页全屏并解锁。
   * 桌面端不启用（桌面横屏窗口不应劫持全屏）。
   */
  syncLandscapeFullscreen() {
    const art = this.art;
    if (!art || !this.isTouchDevice || window.jxTv?.isTv()) return;
    // 用 innerWidth/innerHeight 判断方向：华为/鸿蒙内核对
    // matchMedia('(orientation: landscape)') 的更新时机不一致，实测会漏判。
    const landscape = this.isLandscapeViewport();
    if (landscape) {
      // 转横屏：没全屏就自动进；已全屏只更新几何（横过来后取消 90° 旋转）
      if (!this.isFullscreen()) this.enterFullscreen(true);
      else this.updateFullscreenGeometry();
    } else if (this.isFullscreen()) {
      // 自动全屏（转横屏触发）在转回竖屏时退出；
      // 手动点全屏进来的，转为「旋转兜底」继续保持全屏
      if (this.fsAuto) this.exitFullscreen();
      else this.updateFullscreenGeometry();
    }
  }

  // ————————————————————————— 全屏控制器 —————————————————————————
  // 为什么不用 ArtPlayer 自带全屏：
  //  · 华为/鸿蒙机型上 `$player.requestFullscreen()` 常被拒（ArkWeb 只放行 video），
  //    原生全屏按钮点了没反应，用户看到的就是「不能全屏」；
  //  · 网页全屏靠 CSS `.art-fullscreen-web`，而「撑满视口」依赖 `:has()` 取消
  //    .jx-player-box 的 sticky/z-index 层叠上下文，`:has()` 缺失（Chromium < 105）
  //    时播放器被压在 header 下面、只剩一小块，表现为「铺不满屏」。
  // 这里自建控制器：类名 + 内联像素几何，不依赖 :has() / 100vh / Fullscreen API。
  viewportSize() {
    return {
      w: Math.round(window.innerWidth || document.documentElement.clientWidth || 0),
      h: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
    };
  }

  isLandscapeViewport() {
    const { w, h } = this.viewportSize();
    return w > h;
  }

  /**
   * 片源方向：true=横版（正剧） / false=竖版（短剧） / null=未知（元数据未就绪）。
   * ⚠️ 未知时**不能**按横版处理：起播瞬间点全屏时 videoWidth 还是 0，
   * 按横版就会给竖版短剧锁横屏，表现成「短剧一进全屏就被转成横向」。
   * 所有依赖方向的决策都必须用 `=== true` 判断。
   */
  videoIsLandscape() {
    const v = this.art?.video;
    if (!v || !v.videoWidth || !v.videoHeight) return null;
    return v.videoWidth >= v.videoHeight;
  }

  isFullscreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    if (this.fsActive) return true;
    return !!(this.art?.fullscreenWeb || this.art?.fullscreen);
  }

  /** 进入全屏。auto=true 表示「转横屏自动进入」，转回竖屏时自动退出 */
  enterFullscreen(auto = false) {
    if (!this.art) return;
    this.fsAuto = !!auto;
    // 顺序很重要：先立刻用 CSS 铺满（必定成功、控制条还在），
    // 再在同一个用户手势里尝试「升级」为原生全屏 —— 只有进了原生全屏，
    // screen.orientation.lock('landscape') 才会被内核接受，手机才会真的横过来。
    // 反过来做（等原生、失败再降级）会让点全屏后好几百毫秒没反应，华为上还可能直接跳系统播放器。
    this.applyCssFullscreen();
    // ⚠️ 只有**明确横版**的片源才升级原生全屏。
    // 竖版短剧（以及方向未知时）必须留在「竖屏 CSS 全屏」：原生全屏会把方向交给系统，
    // 华为/鸿蒙上常见结果是画面被系统转成横向、或跳到系统播放器只剩画面没有控制条，
    // 用户看到的就是「短剧不能竖屏全屏」。
    if (!auto && this.videoIsLandscape() === true) this.tryUpgradeToNativeFullscreen();
  }

  /** 在同一用户手势内尝试进入原生全屏（成功就能锁横屏；失败就留在 CSS 全屏） */
  tryUpgradeToNativeFullscreen() {
    const $p = this.art?.template?.$player;
    if (!$p) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    const fn = $p.requestFullscreen || $p.webkitRequestFullscreen;
    if (!fn) return;
    this.pendingFs = true;
    const done = () => { this.pendingFs = false; };
    try {
      const ret = fn.call($p);
      if (ret && typeof ret.then === 'function') {
        ret.then(() => {
          done();
          // 原生全屏已生效：此时才有资格锁横屏
          this.hintLandscapeIfNeeded();
        }).catch(done);
      } else {
        done();
      }
    } catch { done(); }
  }

  /** 纯 CSS 全屏（不依赖 Fullscreen API）：类名 + 内联像素几何铺满视口 */
  applyCssFullscreen() {
    if (!this.art) return;
    this.fsActive = true;
    this.fsHadGlass = this.container.classList.contains('glass');
    const $p = this.art.template?.$player;
    if ($p && this.fsPrevStyle === null) this.fsPrevStyle = $p.getAttribute('style') || '';

    try { if (!this.art.fullscreenWeb) this.art.fullscreenWeb = true; } catch { /* 老内核 */ }
    this.container.classList.remove('glass'); // backdrop-filter 会成为 fixed 的包含块
    this.container.classList.add('jx-fs-box');
    document.documentElement.classList.add('jx-fs');
    document.body.classList.add('jx-fs');
    $p?.classList.add('jx-fs-forced');

    this.updateFullscreenGeometry();
    this.hintLandscapeIfNeeded();
    // 500ms 后自检：几何没铺满就再纠一次（华为上常见）
    if (this.fsVerifyTimer) clearTimeout(this.fsVerifyTimer);
    this.fsVerifyTimer = setTimeout(() => this.verifyFullscreenCoverage(), 500);
  }

  /**
   * 竖持手机 + 横版片源（正剧）：画面在竖屏里只能上下留大黑边，
   * 这里尝试锁定横屏并提示横过来。
   * 竖版片源（短剧）与方向未知时**一律不锁不提示** —— 短剧在竖屏本来就该竖着铺满，
   * 锁横屏会把它强行转成横向，这就是「短剧不能竖屏全屏」的根因。
   */
  hintLandscapeIfNeeded() {
    if (!this.isTouchDevice || this.isLandscapeViewport()) return;
    if (this.videoIsLandscape() !== true) return;
    this.tryLockLandscape();
    if (this.fsRotateHinted) return;
    this.fsRotateHinted = true;
    this.showHint('请横持手机：正剧横屏才能铺满', 6000);
  }

  exitFullscreen() {
    this.fsActive = false;
    this.fsAuto = false;
    this.fsRotateHinted = false;
    if (this.fsVerifyTimer) { clearTimeout(this.fsVerifyTimer); this.fsVerifyTimer = null; }
    try { if (this.art?.fullscreenWeb) this.art.fullscreenWeb = false; } catch { /* 忽略 */ }
    const native = document.fullscreenElement || document.webkitFullscreenElement;
    if (native) {
      try { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); } catch { /* 忽略 */ }
    }
    this.clearFullscreenLayout();
  }

  toggleFullscreen() {
    // 桌面端仍用浏览器原生全屏（有真正的全屏体验），只有触屏走自有控制器
    if (!this.isTouchDevice && this.art) {
      const native = document.fullscreenElement || document.webkitFullscreenElement;
      try { this.art.fullscreen = !native; return; } catch { /* 落到下面走 CSS 全屏 */ }
    }
    if (this.isFullscreen()) this.exitFullscreen();
    else this.enterFullscreen(false);
  }

  /**
   * 把播放器铺满视口。
   * ⚠️ 不要用 CSS transform 旋转来「让横版视频在竖屏铺满」：华为/鸿蒙把 <video>
   * 提升为独立合成层，transform 只带走容器不带走画面，实测现象是「画面跑到下面去了」。
   * 正确做法是原生全屏 + screen.orientation.lock('landscape')，让设备真的横过来。
   */
  updateFullscreenGeometry() {
    if (!this.fsActive) return;
    const $p = this.art?.template?.$player;
    if (!$p) return;
    this.pinGeometry($p);
  }

  pinGeometry($p) {
    const { w, h } = this.viewportSize();
    if (!w || !h) return;
    const s = $p.style;
    const set = (k, v) => s.setProperty(k, v, 'important');
    set('position', 'fixed');
    set('top', '0');
    set('left', '0');
    set('right', 'auto');
    set('bottom', 'auto');
    set('margin', '0');
    set('padding', '0');
    set('max-width', 'none');
    set('max-height', 'none');
    set('aspect-ratio', 'auto');
    set('border-radius', '0');
    set('background-color', '#000');
    set('transform', 'none');
    // 面板 z-index 10000 要盖在播放器之上，这里压到 9990
    set('z-index', '9990');
    set('width', `${w}px`);
    set('height', `${h}px`);
  }

  tryLockLandscape() {
    try {
      const p = screen.orientation?.lock?.('landscape');
      if (p?.catch) p.catch(() => { /* Huawei/HarmonyOS 常直接拒绝 */ });
    } catch { /* 不支持 */ }
  }

  /** 自检：进入全屏后播放器是否真的铺满视口；不满足则再纠一次几何 */
  verifyFullscreenCoverage() {
    if (!this.fsActive) return;
    const $p = this.art?.template?.$player;
    if (!$p) return;
    const r = $p.getBoundingClientRect();
    const { w, h } = this.viewportSize();
    const covered = r.width >= w * 0.85 && r.height >= h * 0.85;
    if (covered) return;
    if (!this.art?.fullscreenWeb) {
      try { this.art.fullscreenWeb = true; } catch { /* 忽略 */ }
    }
    this.updateFullscreenGeometry();
  }

  clearFullscreenLayout() {
    const $p = this.art?.template?.$player;
    if ($p) {
      $p.classList.remove('jx-fs-forced');
      if (this.fsPrevStyle !== null) {
        $p.setAttribute('style', this.fsPrevStyle); // 恢复进入前的内联样式，不留残渣
        this.fsPrevStyle = null;
      }
    }
    this.container.classList.remove('jx-fs-box');
    if (this.fsHadGlass) this.container.classList.add('glass');
    this.fsHadGlass = false;
    document.documentElement.classList.remove('jx-fs');
    document.body.classList.remove('jx-fs');
    try { screen.orientation?.unlock?.(); } catch { /* 忽略 */ }
    this.applyVideoAspect();
  }

  bindOrientationHandlers() {
    this.isTouchDevice = window.matchMedia('(pointer: coarse)').matches
      || /Android|HarmonyOS|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    this.onOrientationChange = () => {
      this.applyVideoAspect();
      // iOS/部分 Android：orientationchange 时布局与 media query 尚未更新，延后一帧
      setTimeout(() => {
        this.applyVideoAspect();
        // 统一交给 syncLandscapeFullscreen：它同时处理
        // 「转横屏自动进全屏 / 转竖屏自动退出 / 已全屏时重算几何」三种情况
        this.syncLandscapeFullscreen();
      }, 250);
    };
    this.onResizeAspect = () => {
      this.applyVideoAspect();
      // 地址栏收放会改变 innerHeight，全屏几何按新视口重算；
      // 自动全屏转回竖屏的情况交给方向回调去退出，避免先转 90° 再退出
      if (!this.fsActive) return;
      if (this.fsAuto && !this.isLandscapeViewport()) return;
      this.updateFullscreenGeometry();
    };
    window.addEventListener('orientationchange', this.onOrientationChange);
    window.addEventListener('resize', this.onResizeAspect);
    try {
      window.visualViewport?.addEventListener('resize', this.onResizeAspect);
    } catch { /* 老内核无 visualViewport */ }
    // iOS 16+ / Android 新版已不再稳定派发 orientationchange（已废弃），
    // 只靠它会出现「真机转横屏不自动全屏、Playwright 模拟却正常」。
    // matchMedia('(orientation: landscape)') 的 change 事件是当前可靠信号。
    try {
      this.orientationMedia = window.matchMedia('(orientation: landscape)');
      this.onOrientationMedia = () => this.onOrientationChange();
      this.orientationMedia.addEventListener?.('change', this.onOrientationMedia);
    } catch { /* 老浏览器无 matchMedia addEventListener */ }
  }

  buildHlsConfig() {
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!this.props.episodeKey;
    return {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      // 缓冲 60s：起播时服务端已预热第一片，此后命中内存缓存的分片 2ms 返回，
      // 60s 足够吸收源站出站波动（实测 ~200KB/s）。120s 会一次性把 20+ 片
      // 的预取压力全压到起播阶段，反而拖慢首片。
      maxBufferLength: cacheEnabled ? 60 : 30,
      maxMaxBufferLength: cacheEnabled ? 300 : 60,
      maxBufferSize: (cacheEnabled ? 90 : 30) * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500000,
      appendErrorMaxRetry: 5,
      loader: createHlsLoader(Hls, { blockAd: this.props.stripAd !== false }),
    };
  }

  ensurePrefetch(mediaUrl, currentTime, horizonSeconds) {
    if (!this.props.episodeKey) return;
    // iOS 原生播放：系统播放器自己管理请求，Cache Storage 预取不进它的缓存，
    // 反而与系统拉流抢同一条到 NAS 的连接/带宽 → 跳过（服务端预热仍然生效）。
    if (this.nativeHls) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: this.props.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        if (stats.state === 'done' && this.props.nextUrl && this.props.nextEpisodeKey) {
          getNextEpisodePrefetcher().ensure({
            m3u8Url: this.props.nextUrl,
            currentTime: 0,
            episodeKey: this.props.nextEpisodeKey,
            horizonSeconds: 420,
          });
        }
      },
    });
  }

  /**
   * 进度恢复 + 起播（hls.js 路径与 iOS 原生路径共用）。
   * 元数据到位（loadedmetadata/durationchange/canplay）后从 IndexedDB 取回进度，
   * 命中则 seek 续播；随后触发预取锚点并 play()。
   */
  bindRestoreEvents(video, mediaUrl) {
    let restoreInFlight = false;
    const restoreAndStart = async () => {
      if (this.restored || restoreInFlight) return;
      const duration = this.art?.duration || video.duration || 0;
      if (!Number.isFinite(duration) || duration <= 0) return;
      restoreInFlight = true;
      try {
        const saved = (await this.props.getRestorePosition?.()) ?? 0;
        const currentDuration = this.art?.duration || video.duration || duration;
        let prefetchAnchor = video.currentTime;
        if (saved > 10 && Number.isFinite(currentDuration) && saved < currentDuration - 2) {
          if (this.art) this.art.currentTime = saved;
          prefetchAnchor = saved;
          this.showHint(`已从 ${formatTime(saved)} 继续播放`);
        }
        this.restored = true;
        this.restoreCleanup?.();
        this.restoreCleanup = null;
        this.ensurePrefetch(mediaUrl, prefetchAnchor);
        video.play().catch(() => {});
      } catch { /* IndexedDB 读取失败不阻塞播放 */ } finally {
        restoreInFlight = false;
      }
    };
    this.restoreAndStart = () => restoreAndStart();
    const restoreEvents = ['loadedmetadata', 'durationchange', 'canplay'];
    const onRestoreEvent = () => { void restoreAndStart(); };
    restoreEvents.forEach((e) => video.addEventListener(e, onRestoreEvent));
    this.restoreCleanup = () => restoreEvents.forEach((e) => video.removeEventListener(e, onRestoreEvent));
  }

  setupHls(video, mediaUrl, allowProxyFallback) {
    this.restoreCleanup?.();
    this.restoreCleanup = null;
    this.hls?.destroy();
    this.hls = null;
    this.currentMediaUrl = mediaUrl;
    // iOS Safari/iPad 不支持 MSE（iPhone 一律不支持）：hls.js 无法 attachMedia，
    // 必须直接 video.src 走系统原生 HLS 播放（与直播路径同一策略）。
    // 播放地址已统一走 /api/proxy（服务端内存缓存 + 预热仍生效，分片命中 2ms 返回），
    // 原生路径只是把「客户端拉流」换成「系统播放器拉流」，抗卡顿能力不变。
    const nativeHls = !window.Hls || !Hls.isSupported();
    this.nativeHls = nativeHls;
    // 视频元数据到位后按真实宽高比重塑播放器盒子（竖版短剧不锁 16:9）
    video.removeEventListener('loadedmetadata', this.onMetaAspect);
    this.onMetaAspect = () => {
      this.applyVideoAspect();
      // 竖版片源（短剧）：清掉可能残留的方向锁（上一次看正剧时锁过横屏），
      // 保证短剧一定竖着看 —— 否则会表现成「短剧不能竖屏全屏」。
      if (this.videoIsLandscape() === false) {
        try { screen.orientation?.unlock?.(); } catch { /* 老内核无此 API */ }
      }
      // 起播瞬间就点了全屏（元数据还没到）：此刻才知道片源方向，
      // 补一次「正剧横持」提示；竖版短剧在这里仍然是 !== true，不会被锁横屏。
      if (this.fsActive) this.hintLandscapeIfNeeded();
    };
    video.addEventListener('loadedmetadata', this.onMetaAspect, { once: true });
    if (nativeHls) {
      // 原生播放：不建 hls.js 实例。清除上一次可能残留的 src 再加载
      try { video.removeAttribute('src'); video.load(); } catch { /* 忽略 */ }
      video.src = mediaUrl;
      this.bindRestoreEvents(video, mediaUrl);
      return;
    }
    const hls = new Hls(this.buildHlsConfig());
    this.hls = hls;
    this.bindRestoreEvents(video, mediaUrl);

    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.recovery?.markHealthy();
      const heights = hls.levels.map((l) => l.height).filter((h) => typeof h === 'number' && h > 0);
      if (heights.length > 0) this.reportQuality(Math.max(...heights));
      void this.restoreAndStart(mediaUrl);
    });
    hls.on(Hls.Events.FRAG_LOADED, () => this.recovery?.markHealthy());
    hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => {
      const height = data.levelInfo?.height;
      if (typeof height === 'number') this.reportQuality(height);
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => { this.mediaHealthy = true; });

    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      const recovery = this.recovery;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            this.showHint('直连失败，改用代理重试...');
            this.setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          this.showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          this.showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          if (this.playbackStarted) {
            this.showHint(message);
            this.props.onRequestSwitchSource?.(decision.reason);
          } else {
            this.setError(`视频加载失败，${message}，请尝试其他视频源`);
          }
          break;
        }
      }
    });
  }

  loadEpisode(targetUrl) {
    if (!targetUrl) return;
    this.mediaHealthy = true;
    this.playbackStarted = false;
    this.videoErrorRetryUsed = false;
    this.restored = false;
    this.lastPrefetchEnsure = 0;
    this.recovery = new PlaybackRecovery();
    getVideoPrefetcher().stop();
    this.setError('');
    this.showPoster = true;
    this.renderPoster();
    const art = this.art;
    if (!art) return;
    this.setupHls(art.video, targetUrl, true);
  }

  renderPoster() {
    let el = this.container.querySelector('.jx-poster');
    if (!this.showPoster || this.error) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'jx-poster';
      // iOS Safari 禁止无手势的有声自动播放：起播被拒时 poster 会一直盖着，
      // 之前没有点击处理，用户点 ▶ 毫无反应（看起来就是「不能播」）。
      // 这里把 poster 本身做成起播按钮：点一下即手动 play。
      el.addEventListener('click', () => {
        const art = this.art;
        if (!art?.video) return;
        try {
          if (art.video.paused) void art.play?.();
        } catch { /* 忽略 */ }
      });
      this.container.appendChild(el);
    }
  }

  mount() {
    if (!this.container || !this.props.url) return;
    const touchPointer = window.matchMedia('(pointer: coarse)').matches;
    Artplayer.CONTROL_HIDE_TIME = touchPointer ? 3000 : 800;

    this.mediaHealthy = true;
    this.playbackStarted = false;
    this.videoErrorRetryUsed = false;
    this.restored = false;
    this.recovery = new PlaybackRecovery();
    this.ended = false;

    window.__jxPlayer = this; // TV 遥控控制入口（tv-nav.js 通过它调 toggle/showHint）

    const art = new Artplayer({
      container: this.container,
      url: this.props.url,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      theme: '#3b82f6',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      controls: [
        {
          name: 'prev-episode',
          index: 11,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 6h2v12H6V6zm3.5 6l8.5 6V6l-8.5 6z"/></svg>',
          tooltip: '上一集 (Alt+←)',
          click: () => { if (this.props.hasPrevEpisode) this.props.onPrevEpisode?.(); },
        },
        {
          name: 'next-episode',
          index: 12,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>',
          tooltip: '下一集 (Alt+→)',
          click: () => { if (this.props.hasNextEpisode) this.props.onNextEpisode?.(); },
        },
        {
          name: 'episode-panel',
          index: 13,
          position: 'left',
          html: '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h18v2H3V5zm0 6h18v2H3v-2zm0 6h12v2H3v-2z"/></svg>',
          tooltip: '剧集面板 (M)',
          // TV/手机全屏时选集入口：唤出右侧剧集面板（桌面模式为 no-op，用页面内剧集区）
          click: () => window.__jxWatchPanel?.toggle?.(),
        },
      ],
      customType: {
        m3u8: (video, mediaUrl) => this.setupHls(video, mediaUrl, true),
      },
    });
    this.art = art;
    this.bindOrientationHandlers();

    // 起播时同步一次方向状态：横屏手机进入播放页即自动全屏
    const initialOrientationSync = () => {
      this.applyVideoAspect();
      setTimeout(() => this.syncLandscapeFullscreen(), 300);
      art.video?.removeEventListener('playing', initialOrientationSync);
    };
    art.video?.addEventListener('playing', initialOrientationSync, { once: true });

    // 全屏中切集后恢复全屏：renderWatch 重建播放器会丢全屏，
    // app.js 的 goEpisode 在跳转前打了 jx-fs-resume 标记。
    try {
      if (sessionStorage.getItem('jx-fs-resume') === '1') {
        sessionStorage.removeItem('jx-fs-resume');
        // 切集重建播放器后恢复全屏：没有用户手势，请求原生全屏会被内核拒绝，
        // 直接走 CSS 全屏（效果一致，且不会把浏览器 UI 状态搅乱）
        const resumeFs = () => { try { if (!this.isFullscreen()) this.applyCssFullscreen(); } catch { /* 忽略 */ } };
        art.on('ready', resumeFs);
        setTimeout(resumeFs, 600);
      }
    } catch { /* 无痕模式 sessionStorage 可能不可用 */ }

    // TV 模式：进入播放页即网页全屏（10-foot 场景无鼠标，信息/剧集走右侧面板按 M 唤出）
    if (window.jxTv?.isTv()) {
      const goTvFullscreen = () => { try { if (!art.fullscreenWeb) art.fullscreenWeb = true; } catch { /* 忽略 */ } };
      art.on('ready', goTvFullscreen);
      setTimeout(goTvFullscreen, 800); // ready 未触发时的兜底
      // TV 上退出全屏即退出播放（非全屏态信息全在面板里，无停留意义）
      art.on('fullscreenWeb', (state) => {
        if (!state && window.jxTv?.isTv() && location.hash.startsWith('#/watch')) history.back();
      });
    }

    const reportVideoHeight = () => {
      const height = art.video?.videoHeight;
      if (typeof height === 'number' && height > 0) this.reportQuality(height);
    };
    art.on('video:loadedmetadata', reportVideoHeight);
    art.on('video:canplay', reportVideoHeight);
    art.video?.addEventListener('resize', reportVideoHeight);

    art.on('video:playing', () => {
      this.playbackStarted = true;
      this.showPoster = false;
      this.renderPoster();
      if (this.mediaHealthy) this.setError('');
      reportVideoHeight();
      getVideoPrefetcher().setThrottled(false);
    });

    // 全屏态切换 glass：backdrop-filter 会成为 position:fixed 的包含块，
    // 导致网页全屏的播放器相对 .jx-player-box 而非视口定位（横屏全屏不撑满）。
    // 原生全屏发 'fullscreen' 事件、网页全屏发 'fullscreenWeb' 事件，两个都监听。
    const onFullscreenState = (state) => {
      if (this.fsActive) return; // 自有全屏控制器接管，避免把 glass 类又加回去
      this.container.classList.toggle('glass', !state);
      if (state) this.applyVideoAspect();
    };
    art.on('fullscreen', onFullscreenState);
    art.on('fullscreenWeb', onFullscreenState);

    // 触屏设备接管「全屏 / 网页全屏」两个按钮：统一走自有控制器。
    // 捕获阶段拦掉，避免 ArtPlayer 自己的 click（华为上请求原生全屏会被拒 → 点了没反应）。
    if (this.isTouchDevice && !window.jxTv?.isTv()) {
      const $root = art.template?.$player;
      const onFsClick = (e) => {
        const btn = e.target?.closest?.('.art-control-fullscreen, .art-control-fullscreenWeb');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        this.toggleFullscreen();
      };
      $root?.addEventListener('click', onFsClick, true);
      this.cleanupFsClick = () => $root?.removeEventListener('click', onFsClick, true);
    }
    // 浏览器原生全屏被系统手势退出时，把自有几何与 ArtPlayer 全屏态一起清掉
    this.onNativeFsChange = () => {
      const native = document.fullscreenElement || document.webkitFullscreenElement;
      if (!native && this.fsActive) this.exitFullscreen();
    };
    document.addEventListener('fullscreenchange', this.onNativeFsChange);
    document.addEventListener('webkitfullscreenchange', this.onNativeFsChange);
    art.on('video:error', () => {
      this.mediaHealthy = false;
      // 原生 HLS 路径（iOS）无需重建：src 已是代理地址，重建 hls.js 也帮不上忙
      if (!this.nativeHls && !this.playbackStarted && !this.videoErrorRetryUsed) {
        this.videoErrorRetryUsed = true;
        this.showHint('播放异常，正在重试...');
        this.setupHls(art.video, this.currentMediaUrl, true);
        return;
      }
      this.setError('视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const now = Date.now();
      if (now - this.lastSave > 5000) {
        this.lastSave = now;
        this.props.onTimeUpdate?.(art.currentTime, art.duration);
      }
      if (now - this.lastPrefetchEnsure > 30000) {
        this.lastPrefetchEnsure = now;
        this.ensurePrefetch(this.currentMediaUrl, art.currentTime);
      }
    });
    art.on('video:seeked', () => this.ensurePrefetch(this.currentMediaUrl, art.currentTime));
    art.on('video:pause', () => {
      this.props.onPause?.(art.currentTime, art.duration);
      getVideoPrefetcher().setThrottled(false);
      this.ensurePrefetch(this.currentMediaUrl, art.currentTime, 0);
    });
    art.on('video:waiting', () => getVideoPrefetcher().setThrottled(true));
    art.on('video:ended', () => {
      this.ended = true;
      this.props.onEnded?.();
    });

    // —— 键盘快捷键 ——
    this.shortcuts = (e) => {
      const target = e.target;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest?.('button')) return;
      const current = this.art;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          if (current.currentTime > 5) { current.currentTime -= 5; this.showHint('快退 5s'); e.preventDefault(); }
          break;
        case 'ArrowRight':
          if (current.duration - current.currentTime > 5) { current.currentTime += 5; this.showHint('快进 5s'); e.preventDefault(); }
          break;
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); this.showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); this.showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); this.showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          this.toggleFullscreen(); e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', this.shortcuts);

    // —— 移动端长按 3 倍速 ——
    let longPressTimer = null;
    let isLongPress = false;
    let originalRate = 1.0;
    const el = this.container;
    const onTouchStart = (e) => {
      if (art.video?.paused) return;
      if (isLongPress || longPressTimer) return;
      if (e.target.closest?.('.art-controls, .art-settings')) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        this.showHint('3 倍速');
      }, 500);
    };
    const onTouchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        this.showHint(`${originalRate} 倍速`);
      }
    };
    const onContextMenu = (e) => e.preventDefault();
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);
    el.addEventListener('contextmenu', onContextMenu);
    this.cleanupTouch = () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('contextmenu', onContextMenu);
    };

    // —— 页面隐藏 / 卸载时保存进度 ——
    this.saveOnHide = () => {
      if (document.visibilityState === 'hidden') {
        this.props.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', this.saveOnHide);

    this.cleanup = () => {
      if (!this.ended) {
        try { this.props.onPause?.(art.currentTime, art.duration); } catch { /* 忽略 */ }
      }
      // 全屏态下离开播放页：必须先把自有几何/类名还原，否则整页被锁在 overflow:hidden
      try { if (this.fsActive || this.art?.fullscreenWeb) this.exitFullscreen(); } catch { /* 忽略 */ }
      this.cleanupFsClick?.();
      document.removeEventListener('fullscreenchange', this.onNativeFsChange);
      document.removeEventListener('webkitfullscreenchange', this.onNativeFsChange);
      if (this.fsVerifyTimer) clearTimeout(this.fsVerifyTimer);
      try { window.visualViewport?.removeEventListener('resize', this.onResizeAspect); } catch { /* 忽略 */ }
      document.removeEventListener('keydown', this.shortcuts);
      document.removeEventListener('visibilitychange', this.saveOnHide);
      window.removeEventListener('orientationchange', this.onOrientationChange);
      window.removeEventListener('resize', this.onResizeAspect);
      try { this.orientationMedia?.removeEventListener?.('change', this.onOrientationMedia); } catch { /* 忽略 */ }
      art.video?.removeEventListener('loadedmetadata', this.onMetaAspect);
      try { screen.orientation?.unlock?.(); } catch { /* 忽略 */ }
      if (this.hintTimer) clearTimeout(this.hintTimer);
      this.cleanupTouch?.();
      this.restoreCleanup?.();
      this.restoreCleanup = null;
      Artplayer.CONTROL_HIDE_TIME = 3000;
      this.hls?.destroy();
      this.hls = null;
      this.recovery?.dispose();
      getVideoPrefetcher().stop();
      art.destroy();
      this.art = null;
    };
  }

  destroy() {
    if (window.__jxPlayer === this) window.__jxPlayer = null;
    this.cleanup?.();
  }
}

export { formatTime };
