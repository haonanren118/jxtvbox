/**
 * JXTVbox 电视 / 客厅遥控适配模块（独立运行，不依赖 app.js）。
 *
 * 能力：
 * 1. TV 模式管理 —— UA 自动识别 + 设置页手动三态（自动/开/关，localStorage 持久化）
 * 2. 空间导航 —— 方向键在可见可聚焦元素间按几何投影移动焦点（D-pad 友好）
 * 3. 可点击卡片增强 —— 为 div 卡片自动补 tabindex/role，支持 OK 键触发
 * 4. 遥控 media keys —— 播放/暂停、上下集、快进快退、换台、数字选台
 * 5. 播放器遥控控制 —— 焦点在播放器区域时：左右=快进快退、上下=音量、
 *    OK=播放/暂停、M/菜单键=剧集面板；返回键=退出播放（player.js 既有快捷键承接）
 * 6. 初始焦点 —— 路由切换后 TV 模式自动聚焦内容区第一个可聚焦元素
 *
 * 事件分层：本模块以 capture 阶段监听 document；不拦截时事件继续传播，
 * player.js 在 bubble 阶段注册的播放快捷键照常生效，互不冲突。
 *
 * 对外接口：window.jxTv = { isTv, getMode, setMode, refresh }
 */
(() => {
  'use strict';

  const TV_UA = /android[ _-]?tv|smart[ _-]?tv|googletv|google tv|aft[a-z]|hbbtv|netcast|webos|tizen|viera|bravia|roku|appletv|crkey|tv store|tv browser/i;
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const ARROWS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const LS_KEY = 'jx-tv-mode'; // 'on' | 'off' | 不存在=自动

  window.jxIsTouch = window.matchMedia('(pointer: coarse)').matches;

  const state = { tv: false };

  // —— 模式管理 ——

  function getMode() {
    try {
      const v = localStorage.getItem(LS_KEY);
      if (v === 'on' || v === '1') return 'on'; // '1' 兼容旧版键值
      if (v === 'off' || v === '0') return 'off';
    } catch { /* 隐私模式忽略 */ }
    return 'auto';
  }

  function applyTvClass(on) {
    state.tv = on;
    document.body.classList.toggle('jx-tv', on);
  }

  function refresh() {
    const mode = getMode();
    if (mode === 'on') applyTvClass(true);
    else if (mode === 'off') applyTvClass(false);
    else applyTvClass(TV_UA.test(navigator.userAgent || ''));
  }

  function setMode(mode) {
    try {
      if (mode === 'auto') localStorage.removeItem(LS_KEY);
      else localStorage.setItem(LS_KEY, mode);
    } catch { /* 隐私模式忽略 */ }
    refresh();
    return state.tv;
  }

  window.jxTv = {
    isTv: () => state.tv,
    getMode,
    setMode,
    refresh,
  };

  // —— 焦点收集与几何导航 ——

  function visible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }

  function collectFocusables() {
    // 弹窗/面板打开时只在其中导航（TV 剧集面板同样按弹窗处理）
    const mask = document.querySelector('.jx-picker-mask') ?? document.querySelector('.jx-tv-panel.open');
    const scope = mask ?? document;
    return [...scope.querySelectorAll(FOCUSABLE)].filter(visible);
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function findNext(dir) {
    const ae = document.activeElement;
    const list = collectFocusables();
    if (!ae || ae === document.body) {
      // 无焦点时：优先已激活态元素，否则取第一个
      return list.find((el) => el.classList.contains('active')) ?? list[0] ?? null;
    }
    const c = centerOf(ae);
    let best = null;
    let bestCost = Infinity;
    for (const el of list) {
      if (el === ae || el.contains(ae) || ae.contains(el)) continue;
      const p = centerOf(el);
      let along;
      let across;
      if (dir === 'right') { along = p.x - c.x; across = Math.abs(p.y - c.y); }
      else if (dir === 'left') { along = c.x - p.x; across = Math.abs(p.y - c.y); }
      else if (dir === 'down') { along = p.y - c.y; across = Math.abs(p.x - c.x); }
      else { along = c.y - p.y; across = Math.abs(p.x - c.x); }
      if (along <= 2) continue; // 必须在目标方向的半平面内
      const cost = along + across * 3; // 垂直偏差加权，避免串行
      if (cost < bestCost) { bestCost = cost; best = el; }
    }
    return best;
  }

  // —— 播放器遥控控制 ——

  /** 焦点是否落在播放器区域（此时方向键放行给 player.js 的 seek/音量快捷键） */
  function playerControlsActive() {
    if (!location.hash.startsWith('#/watch') && !location.hash.startsWith('#/live')) return false;
    // 剧集面板打开时方向键归面板导航
    if (document.querySelector('.jx-tv-panel.open')) return false;
    const inPlayerBox = !!document.activeElement?.closest?.('.jx-player-box, .art-video-player');
    if (inPlayerBox) return true;
    // 播放页未聚焦任何元素时也视为播放器控制态（TV 进入播放页自动聚焦播放器）
    const ae = document.activeElement;
    if (!ae || ae === document.body) {
      if (location.hash.startsWith('#/watch') && window.__jxPlayer?.art) return true;
      if (location.hash.startsWith('#/live') && document.querySelector('.jx-live-video')) return true;
    }
    return false;
  }

  function getArt() {
    return window.__jxPlayer?.art ?? null;
  }

  function toggleVideo() {
    const art = getArt();
    if (art) {
      art.toggle();
      window.__jxPlayer?.showHint?.(art.paused ? '已暂停' : '播放中');
      return;
    }
    const v = document.querySelector('.jx-live-video');
    if (v) {
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }
  }

  function seekBy(seconds) {
    const art = getArt();
    if (!art) return;
    const next = Math.max(0, Math.min(art.duration || 0, (art.currentTime || 0) + seconds));
    art.currentTime = next;
    window.__jxPlayer?.showHint?.(`${seconds > 0 ? '快进' : '快退'} ${Math.abs(seconds)}s`);
  }

  /** 直播：换到第 idx 个频道（0 起） */
  function playChannelByIndex(idx) {
    const live = window.__jxLive;
    if (!live || !Array.isArray(live.channels)) return false;
    if (idx < 0 || idx >= live.channels.length) return false;
    window.__jxPlayChannel?.(live.channels[idx]);
    return true;
  }

  function stepChannel(delta) {
    const live = window.__jxLive;
    if (!location.hash.startsWith('#/live') || !live || !Array.isArray(live.channels) || live.channels.length === 0) return false;
    const cur = live.channels.findIndex((c) => live.current && (c.id === live.current.id || c.url === live.current.url));
    const next = (cur < 0 ? 0 : cur + delta + live.channels.length) % live.channels.length;
    window.__jxPlayChannel?.(live.channels[next]);
    return true;
  }

  /** 数字选台：直播页累积数字，1.2s 内无后续输入执行 */
  const digitBuf = { value: '', timer: null };
  function onDigit(d) {
    if (!location.hash.startsWith('#/live')) return false;
    digitBuf.value += d;
    if (digitBuf.timer) clearTimeout(digitBuf.timer);
    digitBuf.timer = setTimeout(() => {
      const n = parseInt(digitBuf.value, 10);
      digitBuf.value = '';
      if (Number.isFinite(n) && n > 0) {
        if (playChannelByIndex(n - 1)) return;
        toast?.(`没有第 ${n} 个频道`, 'error');
      }
    }, 1200);
    return true;
  }
  function toast(msg, type) { window.jxToast?.(msg, type); }

  /** 播放/详情页：遥控 OK 之外的快捷键唤出剧集面板 */
  function toggleWatchPanel() {
    if (!location.hash.startsWith('#/watch')) return false;
    const panel = window.__jxWatchPanel;
    if (!panel) return false;
    if (panel.isOpen()) panel.close();
    else panel.open();
    return true;
  }

  // —— DOM 增强 ——

  /** div 卡片（h() 渲染、无原生键盘行为）补 tabindex/role，使 OK 键可触发 */
  function decorateClickables(root) {
    const sel = '.jx-card, .jx-media-item, .jx-channel, .jx-picker-item, .jx-src-item, .jx-history-item, .jx-live-player-wrap';
    root.querySelectorAll(sel).forEach((el) => {
      if (el.tagName === 'BUTTON' || el.tagName === 'A') return;
      if (!el.hasAttribute('tabindex')) {
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
      }
    });
  }

  /** 播放页：播放器容器可聚焦并自动聚焦，进入页面即可用遥控器操作 */
  function setupWatchPlayer() {
    if (!location.hash.startsWith('#/watch')) return;
    if (!document.querySelector('.jx-watch-info, .jx-tv-panel')) return;
    const box = document.querySelector('.jx-player-box');
    if (!box || box.hasAttribute('tabindex')) return;
    box.setAttribute('tabindex', '0');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', '播放器，方向键快进/音量，OK 播放暂停，M 键剧集面板');
    setTimeout(() => box.focus({ preventScroll: true }), 260);
  }

  /** TV 模式：路由切换后自动聚焦内容区第一个可聚焦元素（无鼠标场景的起点） */
  function autoFocusContent() {
    if (!state.tv) return;
    setTimeout(() => {
      if (!state.tv) return;
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement) return;
      // 弹窗/面板打开时不抢焦点
      if (document.querySelector('.jx-picker-mask, .jx-tv-panel.open')) return;
      const scope = document.querySelector('#view') ?? document.body;
      const first = [...scope.querySelectorAll(FOCUSABLE)].find(visible);
      if (first) first.focus({ preventScroll: true });
    }, 180);
  }

  let refreshQueued = false;
  function refreshDom() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => {
      refreshQueued = false;
      decorateClickables(document);
      setupWatchPlayer();
    });
  }

  // —— 键盘路由 ——

  function onKeyDown(e) {
    const key = e.key;
    const ae = document.activeElement;
    const inField = !!ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName);

    // 方向键：进入 TV 模式 + 空间导航
    if (ARROWS[key]) {
      if (getMode() !== 'off') {
        if (!state.tv) { refresh(); if (!state.tv) applyTvClass(true); }
      }
      if (playerControlsActive()) return; // 放行：player.js 处理 seek/音量
      if (inField && (key === 'ArrowLeft' || key === 'ArrowRight')) return; // 文本框内移动光标
      const next = findNext(ARROWS[key]);
      if (next) {
        e.preventDefault();
        next.focus();
        next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }

    // —— 遥控 media keys ——
    switch (key) {
      case 'MediaPlayPause':
        e.preventDefault(); toggleVideo(); return;
      case 'MediaPlay':
        e.preventDefault(); getArt()?.play(); return;
      case 'MediaPause':
        e.preventDefault(); getArt()?.pause(); return;
      case 'MediaFastForward': case 'BrowserForward':
        e.preventDefault(); seekBy(30); return;
      case 'MediaRewind': case 'BrowserBack':
        // BrowserBack 部分 TV 浏览器映射为返回键
        if (key === 'BrowserBack') break;
        e.preventDefault(); seekBy(-30); return;
      case 'MediaTrackNext': case 'ChannelUp':
        e.preventDefault();
        if (stepChannel(1)) return;
        window.__jxPlayer?.props?.onNextEpisode?.();
        return;
      case 'MediaTrackPrevious': case 'ChannelDown':
        e.preventDefault();
        if (stepChannel(-1)) return;
        window.__jxPlayer?.props?.onPrevEpisode?.();
        return;
      case 'ContextMenu': case 'BrowserFavorites': case 'm': case 'M':
        if (toggleWatchPanel()) { e.preventDefault(); return; }
        return;
      case 'BrowserHome': case 'BrowserRefresh':
        return; // 浏览器自身行为
    }
    if (/^\d$/.test(key)) {
      if (onDigit(key)) { e.preventDefault(); return; }
    }

    // OK / Enter
    if (key === 'Enter') {
      if (playerControlsActive()) {
        e.preventDefault();
        toggleVideo();
        return;
      }
      if (ae && ae.tagName === 'DIV' && ae.getAttribute('tabindex') === '0') {
        e.preventDefault(); // div 卡片无原生激活行为，手动触发
        ae.click();
      }
      return;
    }
    if (key === ' ' && playerControlsActive()) {
      e.preventDefault();
      toggleVideo();
      return;
    }

    // 返回键（TV 遥控常用 Backspace/GoBack/BrowserBack/Escape）
    if (key === 'Escape' || key === 'Backspace' || key === 'GoBack' || key === 'BrowserBack') {
      if (inField) return; // 输入框内 Backspace 是删字符
      const mask = document.querySelector('.jx-picker-mask');
      if (mask) {
        e.preventDefault();
        mask.remove();
        return;
      }
      // TV 剧集面板打开时：返回键先关面板
      const panel = document.querySelector('.jx-tv-panel.open');
      if (panel) {
        e.preventDefault();
        window.__jxWatchPanel?.close();
        return;
      }
      if (history.length > 1) {
        e.preventDefault();
        history.back();
      }
    }
  }

  // —— 启动 ——

  refresh();
  refreshDom();
  document.addEventListener('keydown', onKeyDown, true); // capture：先于 player.js 的 bubble 监听

  let moTimer = null;
  let firstContentDone = false;
  const mo = new MutationObserver(() => {
    // 首屏渲染完成（#app 出现内容）时补一次初始焦点——hashchange 不覆盖首次加载
    if (!firstContentDone) {
      const app = document.getElementById('app');
      if (app && app.childElementCount > 0) {
        firstContentDone = true;
        autoFocusContent();
      }
    }
    if (moTimer) return;
    moTimer = setTimeout(() => { moTimer = null; refreshDom(); }, 120);
  });
  mo.observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => setTimeout(() => { refreshDom(); autoFocusContent(); }, 80));
})();
