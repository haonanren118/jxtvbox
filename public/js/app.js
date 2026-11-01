/**
 * JXTVbox 主应用：hash 路由 + 视图渲染。
 * 视图：#/ 首页搜索 · #/watch 播放 · #/live 直播 · #/drama 短剧 · #/media 媒体库（网盘/本地/Emby）
 *      #/history 历史 · #/settings 设置
 */

// 注意：被 import 的模块同样需要缓存炸弹参数（index.html 只覆盖直接引用的资源）
import { api } from './api.js?v=20261031k';
import {
  getProgress, saveProgress, clearProgress, progressKeyOf,
  upsertHistory, listHistory, deleteHistory, clearHistory,
  addSearchHistory, listSearchHistory, removeSearchHistory, clearSearchHistory,
  getSetting, setSetting,
  getQuality, saveQuality,
} from './db.js';
import { JXPlayer, formatTime } from './player.js';
import { loadCacheSettings, saveCacheSettings, clearVideoCache, estimateCacheBytes } from './video-cache.js';

// —— 基础 helpers ——

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

window.jxToast = toast; // tv-nav.js 数字选台等场景复用
function toast(msg, type = 'info') {
  let box = $('.jx-toast-box');
  if (!box) {
    box = h('div', { class: 'jx-toast-box' });
    document.body.appendChild(box);
  }
  const t = h('div', { class: `jx-toast jx-toast-${type}` }, msg);
  box.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 2600);
}

function fmtTime(sec) { return formatTime(sec); }

/** 源地址规范化：协议/域名小写、去默认端口与尾斜杠、去 query——仅用于去重比较 */
function normalizeSourceUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return String(u || '').trim().replace(/\/+$/, '');
  }
}

function coverUrl(item) {
  return item?.pic ? api.proxyUrl(item.pic, false) : '';
}

function groupByTitle(list) {
  // 跨源同名聚合：归一化标题分组，与 LibreTV 的卡片合并体验一致
  const norm = (s) => (s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const map = new Map();
  for (const item of list) {
    const key = norm(item.name) || `id:${item.sourceKey}:${item.vodId}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return [...map.entries()].map(([key, items]) => ({ key, items })).sort((a, b) => b.items.length - a.items.length);
}

// —— 全局状态 ——

const state = {
  verified: false,
  passwordRequired: false,
  sources: [],
  dramaSources: [],
  liveSources: [],
  mediaSources: [],
  searchResults: [],
  searchFailures: [],
  lastQuery: '',
};

const settings = {
  filterAdult: true,
  autoNext: true,
  stripAd: true,
  cache: loadCacheSettings(),
  imageMode: 'proxy',
};

async function loadSettings() {
  settings.filterAdult = await getSetting('filterAdult', true);
  settings.autoNext = await getSetting('autoNext', true);
  settings.stripAd = await getSetting('stripAd', true);
  settings.cache = loadCacheSettings();
}

async function refreshSources() {
  const data = await api.listSources();
  state.sources = data.sources.filter((s) => s.enabled);
  state.liveSources = data.liveSources.filter((s) => s.enabled);
}

async function refreshDramaSources() {
  const data = await api.dramaSources();
  state.dramaSources = data.sources.filter((s) => s.enabled);
}

async function refreshMediaSources() {
  const data = await api.mediaSources();
  state.mediaSources = data.sources.filter((s) => s.enabled);
}

// —— 布局骨架 ——

function renderShell(active) {
  $('#app').innerHTML = '';
  const header = h('header', { class: 'jx-header glass' },
    h('div', { class: 'jx-header-inner' },
      h('a', { class: 'jx-logo', href: '#/' }, 'JXTV', h('span', { class: 'jx-logo-box' }, 'box')),
      h('nav', { class: 'jx-nav' },
        h('a', { href: '#/', class: active === 'home' ? 'active' : '' }, '首页'),
        h('a', { href: '#/live', class: active === 'live' ? 'active' : '' }, '直播'),
        h('a', { href: '#/drama', class: active === 'drama' ? 'active' : '' }, '短剧'),
        h('a', { href: '#/media', class: active === 'media' ? 'active' : '' }, '媒体库'),
        h('a', { href: '#/history', class: active === 'history' ? 'active' : '' }, '历史'),
        h('a', { href: '#/settings', class: active === 'settings' ? 'active' : '' }, '设置'),
      ),
    ),
  );
  const main = h('main', { class: 'jx-main', id: 'view' });
  $('#app').append(header, main);
}

// —— 登录视图 ——

function renderLogin(status) {
  $('#app').innerHTML = '';
  if (status.passwordRequired) {
    $('#app').append(h('div', { class: 'jx-login glass' },
      h('h2', {}, 'JXTVbox'),
      h('p', { class: 'jx-muted' }, '服务器未设置 PASSWORD 环境变量。请在部署环境变量中配置访问密码后重启。'),
    ));
    return;
  }
  const input = h('input', { type: 'password', placeholder: '访问密码', id: 'login-password' });
  const form = h('form', { class: 'jx-login glass', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api.login(input.value);
      state.verified = true;
      await boot();
    } catch (err) {
      toast(err.message || '登录失败', 'error');
    }
  } },
    h('h2', {}, 'JXTVbox'),
    h('p', { class: 'jx-muted' }, '请输入访问密码'),
    input,
    h('button', { type: 'submit', class: 'jx-btn-primary' }, '进入'),
  );
  $('#app').append(form);
  setTimeout(() => input.focus(), 50);
}

// —— 首页 / 搜索 ——

function videoCard(item, allItems, onPick, showSource = true) {
  const quality = state.qualityCache?.[`${item.sourceKey}|${item.vodId}`];
  const badge = quality?.height ? `${quality.height}P` : '';
  return h('div', { class: 'jx-card glass', onclick: () => onPick(item, allItems) },
    h('div', { class: 'jx-card-cover' },
      item.pic ? h('img', { src: coverUrl(item), loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'jx-card-nocover' }, '无封面'),
      badge ? h('span', { class: 'jx-quality-badge' }, badge) : null,
      item.remarks ? h('span', { class: 'jx-card-remarks' }, item.remarks) : null,
    ),
    h('div', { class: 'jx-card-body' },
      h('div', { class: 'jx-card-title', title: item.name }, item.name),
      h('div', { class: 'jx-card-meta' },
        item.year ? h('span', {}, item.year) : null,
        item.area ? h('span', {}, item.area) : null,
        showSource ? h('span', { class: 'jx-src-tag' }, item.sourceName) : null,
      ),
    ),
  );
}

async function renderHome() {
  renderShell('home');
  const view = $('#view');

  // 继续观看
  const history = await listHistory(12);
  if (history.length > 0) {
    view.append(h('section', { class: 'jx-section' },
      h('h3', { class: 'jx-section-title' }, '继续观看'),
      h('div', { class: 'jx-row' }, history.map((entry) =>
        h('div', { class: 'jx-card glass jx-card-sm', onclick: () => { location.hash = `#/watch?source=${encodeURIComponent(entry.sourceKey)}&id=${encodeURIComponent(entry.vodId)}&index=${entry.episodeIndex ?? 0}&title=${encodeURIComponent(entry.title || '')}`; } },
          h('div', { class: 'jx-card-cover' },
            entry.cover ? h('img', { src: coverUrl({ pic: entry.cover }), loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('div', { class: 'jx-card-nocover' }, '无封面'),
            entry.position && entry.duration
              ? h('div', { class: 'jx-progress' }, h('div', { class: 'jx-progress-inner', style: `width:${Math.min(100, (entry.position / entry.duration) * 100)}%` }))
              : null,
          ),
          h('div', { class: 'jx-card-body' },
            h('div', { class: 'jx-card-title' }, entry.title || '未知视频'),
            h('div', { class: 'jx-card-meta' },
              h('span', {}, entry.position && entry.duration ? `${fmtTime(entry.position)} / ${fmtTime(entry.duration)}` : ''),
            ),
          ),
        ),
      )),
    ));
  }

  // 搜索区
  const searchHist = await listSearchHistory(10);
  const input = h('input', { type: 'search', placeholder: '搜索片名，如：庆余年', id: 'search-input' });
  const histBox = h('div', { class: 'jx-search-hist' });
  const renderHist = async () => {
    histBox.innerHTML = '';
    const list = await listSearchHistory(10);
    if (list.length === 0) return;
    histBox.append(h('span', { class: 'jx-muted' }, '最近搜索:'),
      ...list.map((wd) => h('button', { class: 'jx-chip', onclick: () => { input.value = wd; doSearch(wd); } }, wd)),
      h('button', { class: 'jx-chip jx-chip-clear', onclick: async () => { await clearSearchHistory(); renderHist(); } }, '清空'),
    );
  };
  await renderHist();

  const resultsBox = h('div', { class: 'jx-grid', id: 'results' });
  const statusBox = h('div', { class: 'jx-search-status' });

  const doSearch = async (wd) => {
    wd = (wd ?? input.value).trim();
    if (!wd) return;
    if (state.sources.length === 0) {
      statusBox.textContent = '尚未配置点播源，请先到「设置 → 点播源」添加采集站';
      resultsBox.innerHTML = '';
      return;
    }
    state.lastQuery = wd;
    statusBox.textContent = `正在搜索「${wd}」…（${state.sources.length} 个源）`;
    resultsBox.innerHTML = '';
    try {
      const data = await api.search(wd, state.sources, settings.filterAdult);
      state.searchResults = data.list;
      state.searchFailures = data.failures ?? [];
      await addSearchHistory(wd);
      renderHist();
      renderResults();
      const failCount = state.searchFailures.length;
      statusBox.textContent = `「${wd}」共 ${data.list.length} 条结果${failCount ? `，${failCount} 个源失败（健康度已记录，连续失败将自动停用）` : ''}`;
    } catch (err) {
      statusBox.textContent = `搜索失败：${err.message}`;
    }
  };

  const renderResults = () => {
    resultsBox.innerHTML = '';
    if (state.searchResults.length === 0) {
      statusBox.textContent = state.lastQuery ? `「${state.lastQuery}」没有找到相关结果` : statusBox.textContent;
      return;
    }
    const groups = groupByTitle(state.searchResults);
    for (const group of groups) {
      // 取信息最全的一条作主展示
      const main = group.items.reduce((a, b) => ((b.pic && !a.pic) || (b.remarks && !a.remarks) ? b : a), group.items[0]);
      const card = videoCard(main, group.items, (item, allItems) => {
        // 同名多源：弹出选择
        if (allItems.length > 1) {
          showSourcePicker(allItems);
        } else {
          location.hash = `#/watch?source=${encodeURIComponent(item.sourceKey)}&id=${encodeURIComponent(item.vodId)}&title=${encodeURIComponent(item.name || '')}`;
        }
      });
      if (group.items.length > 1) {
        card.append(h('div', { class: 'jx-card-sources' }, `${group.items.length} 个源`));
      }
      resultsBox.append(card);
    }
  };

  const showSourcePicker = (items) => {
    const existing = $('.jx-picker-mask');
    existing?.remove();
    const mask = h('div', { class: 'jx-picker-mask', onclick: (e) => { if (e.target === mask) mask.remove(); } },
      h('div', { class: 'jx-picker glass' },
        h('h3', {}, items[0].name),
        h('div', { class: 'jx-picker-list' }, items.map((it) =>
          h('button', { class: 'jx-picker-item', onclick: () => {
            mask.remove();
            location.hash = `#/watch?source=${encodeURIComponent(it.sourceKey)}&id=${encodeURIComponent(it.vodId)}&title=${encodeURIComponent(it.name || '')}`;
          } },
            h('span', { class: 'jx-src-tag' }, it.sourceName),
            h('span', {}, it.remarks || it.year || ''),
          ),
        )),
        h('button', { class: 'jx-btn-ghost', onclick: () => mask.remove() }, '取消'),
      ),
    );
    document.body.append(mask);
  };

  // 豆瓣热播推荐：电影/剧集切换，点击卡片以片名触发搜索（播放由采集源完成）
  const doubanRow = h('div', { class: 'jx-row', id: 'douban-row' });
  const doubanStatus = h('div', { class: 'jx-search-status' }, '正在获取豆瓣热播…');
  const doubanChips = h('div', { class: 'jx-douban-chips' });
  let doubanType = 'movie';

  const renderDoubanChips = () => {
    doubanChips.innerHTML = '';
    for (const [t, label] of [['movie', '电影'], ['tv', '剧集']]) {
      doubanChips.append(h('button', {
        class: `jx-chip${t === doubanType ? ' jx-chip-on' : ''}`,
        onclick: () => { if (t !== doubanType) { doubanType = t; renderDoubanChips(); loadDouban(); } },
      }, label));
    }
  };

  const renderDoubanCards = (items) => {
    doubanRow.innerHTML = '';
    for (const item of items) {
      doubanRow.append(h('div', {
        class: 'jx-card glass jx-card-sm jx-douban-card',
        onclick: () => { input.value = item.title; doSearch(item.title); },
      },
        h('div', { class: 'jx-card-cover' },
          item.cover
            ? h('img', { src: api.doubanCoverUrl(item.cover), loading: 'lazy' })
            : h('div', { class: 'jx-card-nocover' }, '无封面'),
          item.rate ? h('span', { class: 'jx-rate-badge' }, item.rate) : null,
          item.episodesInfo ? h('span', { class: 'jx-card-remarks' }, item.episodesInfo) : null,
        ),
        h('div', { class: 'jx-card-body' },
          h('div', { class: 'jx-card-title', title: item.title }, item.title),
        ),
      ));
    }
  };

  const loadDouban = async () => {
    doubanStatus.textContent = '正在获取豆瓣热播…';
    try {
      const data = await api.doubanHot(doubanType);
      if (!data.ok) throw new Error(data.error || '获取失败');
      renderDoubanCards(data.items);
      doubanStatus.textContent = data.stale
        ? '豆瓣暂不可达，显示缓存数据 · 点击卡片搜索片名'
        : `豆瓣${doubanType === 'tv' ? '剧集' : '电影'}热播 · 点击卡片搜索片名`;
    } catch (err) {
      doubanRow.innerHTML = '';
      doubanStatus.textContent = `豆瓣热播获取失败：${err.message}`;
    }
  };

  view.append(
    h('section', { class: 'jx-section jx-douban' },
      h('div', { class: 'jx-douban-head' },
        h('h3', { class: 'jx-section-title' }, '豆瓣热播'),
        doubanChips,
      ),
      doubanRow,
      doubanStatus,
    ),
    h('section', { class: 'jx-section' },
      h('form', { class: 'jx-searchbar glass', onsubmit: (e) => { e.preventDefault(); doSearch(); } },
        input,
        h('button', { type: 'submit', class: 'jx-btn-primary' }, '搜索'),
      ),
      histBox,
      statusBox,
    ),
    h('section', { class: 'jx-section' }, resultsBox),
  );

  renderDoubanChips();
  loadDouban();

  // 恢复上次搜索结果（从播放页返回时）
  if (state.lastQuery && state.searchResults.length > 0) {
    input.value = state.lastQuery;
    renderResults();
  }
}

// —— 播放页 ——

let currentPlayer = null;

function parseHashQuery() {
  const hash = location.hash.slice(1);
  const qi = hash.indexOf('?');
  if (qi < 0) return { path: hash, params: new URLSearchParams() };
  return { path: hash.slice(0, qi), params: new URLSearchParams(hash.slice(qi + 1)) };
}

async function renderWatch() {
  renderShell('');
  const view = $('#view');
  const { params } = parseHashQuery();
  const sourceKey = params.get('source') || '';
  const vodId = params.get('id') || '';
  const directUrl = params.get('url') || '';
  const titleParam = params.get('title') || '';
  const indexParam = parseInt(params.get('index') || '0', 10) || 0;

  currentPlayer?.destroy();
  currentPlayer = null;
  window.__jxWatchPanel = null;

  // TV 模式：播放器全屏 + 右侧剧集/信息面板（10-foot 场景无鼠标，信息区做成可聚焦面板）
  const isTvMode = !!window.jxTv?.isTv();
  if (isTvMode) view.classList.add('jx-tv-watch');

  const source = state.sources.find((s) => s.key === sourceKey)
    ?? state.dramaSources.find((s) => s.key === sourceKey)
    ?? (params.get('sourceUrl') ? { key: sourceKey, name: sourceKey, url: params.get('sourceUrl'), detail: params.get('detail') || undefined } : null);

  const playerBox = h('div', { class: 'jx-player-box glass' });
  const infoBox = h('div', { class: `jx-watch-info${isTvMode ? ' jx-tv-panel' : ''}` });
  view.append(playerBox, infoBox);

  let episodes = [];
  let videoInfo = null;

  if (source && vodId) {
    infoBox.append(h('div', { class: 'jx-loading' }, '正在获取剧集…'));
    let detailError = '';
    try {
      const detail = await api.detail(vodId, source, titleParam);
      episodes = detail.episodes ?? [];
      videoInfo = detail.videoInfo ?? null;
    } catch (err) {
      detailError = err.message || '获取详情失败';
    }
    infoBox.innerHTML = '';
    if (detailError) {
      infoBox.append(h('div', { class: 'jx-error-inline' }, `获取详情失败：${detailError}`));
    }
  }

  const currentUrl = episodes.length > 0 ? episodes[Math.min(Math.max(indexParam, 0), episodes.length - 1)] : directUrl;
  const currentIndex = episodes.length > 0 ? Math.min(Math.max(indexParam, 0), episodes.length - 1) : indexParam;
  const title = titleParam || videoInfo?.title || '未知视频';

  // 点播播放地址统一走服务端代理：
  // - 命中服务端内存缓存的分片 2ms 返回，NAS 内网千兆分发，无外网波动；
  // - 起播时服务端同步预热第一片（m3u8 代理内嵌），首片不再等 3.5-7s 出站；
  // - 实测源站对单 IP 限速 ~200KB/s，低于 2000kbps 片源所需 250KB/s，裸连必卡，
  //   代理 + 缓存是唯一供得上的路径。本地媒体（/api/local/...）与非 http 地址不包。
  const proxyPlayUrl = (u) => (/^https?:\/\//i.test(u || '') ? `/api/proxy?url=${encodeURIComponent(u)}` : (u || ''));
  const playUrl = proxyPlayUrl(currentUrl);

  const goEpisode = (index) => {
    // 全屏中切集：hash 跳转会重建播放器，全屏态随之丢失 → 标记一次，新播放器就绪后恢复
    try {
      if (window.__jxPlayer?.isFullscreen?.()) sessionStorage.setItem('jx-fs-resume', '1');
    } catch { /* 无痕模式 sessionStorage 可能不可用 */ }
    const sp = new URLSearchParams(location.hash.slice(location.hash.indexOf('?') + 1));
    sp.set('index', String(index));
    if (episodes[index]) sp.set('url', episodes[index]);
    sp.delete('position');
    location.hash = `#/watch?${sp.toString()}`;
  };

  // 剧集面板：开合 + 焦点管理（tv-nav 的 M/菜单键、播放器控制条的剧集按钮都走这里）
  // - TV：右侧滑出面板（.jx-tv-panel），信息区本身就是面板；
  // - 手机：页面内本就是信息区，只有「全屏状态」下才浮层显示（全屏时页面内列表不可见，
  //   之前只在 TV 创建面板，手机上全屏点剧集按钮是 no-op）；非全屏则滚动到剧集列表。
  let closeTvPanel = () => {};
  {
    const isFullscreenNow = () => !!window.__jxPlayer?.isFullscreen?.();
    const openPanel = () => {
      if (!isTvMode && !isFullscreenNow()) {
        (infoBox.querySelector('.jx-episodes') ?? infoBox).scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      infoBox.classList.add('open');
      document.body.classList.add(isTvMode ? 'jx-tv-panel-open' : 'jx-mobile-panel-open');
      if (isTvMode) setTimeout(focusFirst, 60);
    };
    const focusFirst = () => {
      const first = infoBox.querySelector('button:not([disabled]), [tabindex="0"]');
      first?.focus({ preventScroll: true });
    };
    closeTvPanel = () => {
      infoBox.classList.remove('open');
      document.body.classList.remove('jx-tv-panel-open', 'jx-mobile-panel-open');
      if (isTvMode) setTimeout(() => playerBox.focus({ preventScroll: true }), 30);
    };
    window.__jxWatchPanel = {
      open: openPanel,
      close: closeTvPanel,
      toggle: () => (infoBox.classList.contains('open') ? closeTvPanel() : openPanel()),
      isOpen: () => infoBox.classList.contains('open'),
    };
  }

  // 信息区（TV 模式为右侧滑出面板，默认隐藏；普通模式为页面内信息区）
  infoBox.innerHTML = '';
  infoBox.append(
    h('div', { class: 'jx-watch-title-row' },
      h('h2', { class: 'jx-watch-title' }, title),
      h('div', { class: 'jx-watch-actions' },
        // 合集单 URL（episodes=1）同样给换源入口：烧录广告剧只能靠其他源的干净版本规避
        source ? h('button', { class: 'jx-btn-ghost', onclick: () => { closeTvPanel(); showSwitchSource(title); } }, '换源') : null,
        h('button', {
          class: `jx-btn-ghost${isTvMode ? '' : ' jx-panel-close'}`,
          onclick: () => closeTvPanel(),
        }, '收起'),
        h('button', { class: 'jx-btn-ghost', onclick: () => history.back() }, '返回'),
      ),
    ),
    videoInfo ? h('div', { class: 'jx-watch-meta jx-muted' },
      [videoInfo.year, videoInfo.area, videoInfo.typeName, videoInfo.remarks].filter(Boolean).join(' · '),
    ) : null,
    videoInfo?.desc ? h('p', { class: 'jx-watch-desc jx-muted' }, videoInfo.desc.replace(/<[^>]*>/g, '').slice(0, 300)) : null,
  );

  // 剧集列表（TV 模式选集后面板收起，焦点回播放器）
  if (episodes.length > 0) {
    const epBox = h('div', { class: 'jx-episodes' },
      h('div', { class: 'jx-episodes-head' }, `剧集（${episodes.length}）`),
      h('div', { class: 'jx-episodes-grid' }, episodes.map((url, i) =>
        h('button', {
          class: `jx-ep-btn ${i === currentIndex ? 'active' : ''}`,
          onclick: () => { closeTvPanel(); goEpisode(i); },
        }, String(i + 1)),
      )),
    );
    infoBox.append(epBox);
  }

  // 播放器
  if (!currentUrl) {
    playerBox.append(h('div', { class: 'jx-player-empty' }, '没有可播放的地址'));
    return;
  }

  const qualityKey = `${sourceKey}|${vodId}`;
  const episodeKey = `${sourceKey}|${vodId}:${currentIndex}`;

  currentPlayer = new JXPlayer(playerBox, {
    url: playUrl,
    title,
    episodeKey,
    stripAd: settings.stripAd,
    getRestorePosition: async () => {
      const urlPos = parseInt(params.get('position') || '0', 10) || 0;
      if (urlPos > 0) return urlPos;
      if (!vodId) return 0;
      const entry = await getProgress(progressKeyOf(sourceKey, vodId, currentIndex));
      return entry?.position ?? 0;
    },
    onTimeUpdate: (pos, dur) => {
      if (vodId) {
        saveProgress(progressKeyOf(sourceKey, vodId, currentIndex), pos, dur);
        upsertHistory({
          sourceKey, sourceUrl: source?.url, vodId,
          title, cover: videoInfo?.cover,
          episodeIndex: currentIndex, position: pos, duration: dur,
        });
      }
    },
    onPause: (pos, dur) => {
      if (vodId) saveProgress(progressKeyOf(sourceKey, vodId, currentIndex), pos, dur);
    },
    onEnded: () => {
      if (vodId) {
        clearProgress(progressKeyOf(sourceKey, vodId, currentIndex));
        upsertHistory({ sourceKey, vodId, title, cover: videoInfo?.cover, episodeIndex: currentIndex, position: 0, duration: 0 });
      }
      if (settings.autoNext && currentIndex + 1 < episodes.length) {
        toast('即将播放下一集…');
        setTimeout(() => goEpisode(currentIndex + 1), 1500);
      }
    },
    onQuality: async (height) => {
      await saveQuality(qualityKey, height, 'play');
    },
    onRequestSwitchSource: () => showSwitchSource(title),
    onPrevEpisode: () => { if (currentIndex > 0) goEpisode(currentIndex - 1); },
    onNextEpisode: () => { if (currentIndex + 1 < episodes.length) goEpisode(currentIndex + 1); },
    hasPrevEpisode: currentIndex > 0,
    hasNextEpisode: currentIndex + 1 < episodes.length,
    nextUrl: episodes[currentIndex + 1] ? proxyPlayUrl(episodes[currentIndex + 1]) : undefined,
    nextEpisodeKey: `${sourceKey}|${vodId}:${currentIndex + 1}`,
  });

  // 画质徽章（历史记录）
  const q = await getQuality(qualityKey);
  if (q?.height) {
    infoBox.querySelector('.jx-watch-title-row')?.append(h('span', { class: 'jx-quality-badge lg' }, `${q.height}P`));
  }
}

async function showSwitchSource(title) {
  if (!state.lastQuery && !title) {
    toast('请从首页搜索进入以启用换源', 'info');
    return;
  }
  const wd = state.lastQuery || title;
  // 换源搜索范围：点播源 + 短剧源（短剧页进入的剧靠短剧源之间互換）
  const searchSources = [...state.sources, ...state.dramaSources.filter((s) => !state.sources.some((v) => v.url === s.url))];
  if (searchSources.length === 0) {
    toast('没有可用的点播源或短剧源', 'error');
    return;
  }
  toast('正在跨源搜索同名资源…');
  try {
    const data = await api.search(wd, searchSources, settings.filterAdult);
    const norm = (s) => (s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const target = norm(title);
    const same = data.list.filter((it) => norm(it.name) === target);
    const candidates = same.length > 0 ? same : data.list.slice(0, 10);
    if (candidates.length === 0) {
      toast('未找到其他源的同名资源', 'info');
      return;
    }
    const mask = h('div', { class: 'jx-picker-mask', onclick: (e) => { if (e.target === mask) mask.remove(); } },
      h('div', { class: 'jx-picker glass' },
        h('h3', {}, `换源 · ${title}`),
        h('div', { class: 'jx-picker-list' }, candidates.map((it) =>
          h('button', { class: 'jx-picker-item', onclick: () => {
            mask.remove();
            location.hash = `#/watch?source=${encodeURIComponent(it.sourceKey)}&id=${encodeURIComponent(it.vodId)}&title=${encodeURIComponent(it.name || '')}`;
          } },
            h('span', { class: 'jx-src-tag' }, it.sourceName),
            h('span', {}, it.remarks || ''),
          ),
        )),
        h('button', { class: 'jx-btn-ghost', onclick: () => mask.remove() }, '取消'),
      ),
    );
    document.body.append(mask);
  } catch (err) {
    toast(`换源搜索失败：${err.message}`, 'error');
  }
}

// —— 直播页 ——

const liveState = { sourceKey: null, channels: [], groups: [], current: null, epgTimer: null, orientationHandler: null };
let liveFullscreenEl = null;

function isLiveFullscreen() {
  if (!liveFullscreenEl) return false;
  // iOS webkit 全屏不走 document.fullscreenElement，用 webkitFullscreenElement 兜底判断
  if (document.fullscreenElement === liveFullscreenEl) return true;
  if (document.webkitFullscreenElement === liveFullscreenEl) return true;
  return liveFullscreenEl.dataset.fs === '1';
}

/** 直播全屏：iOS 走 video 系统级全屏（唯一可靠路径），其余走 wrap 原生 Fullscreen API */
function toggleLiveFullscreen(wrap, video) {
  if (isLiveFullscreen()) { exitLiveFullscreen(); return; }
  liveFullscreenEl = wrap;
  wrap.dataset.fs = '1';
  const done = () => { try { screen.orientation?.lock?.('landscape').catch?.(() => {}); } catch { /* 忽略 */ } };
  if (typeof video.webkitEnterFullscreen === 'function') {
    // iOS：系统全屏仅作用于 video 元素本身
    liveFullscreenEl = video;
    video.addEventListener('webkitendfullscreen', () => { liveFullscreenEl = null; delete wrap.dataset.fs; }, { once: true });
    try { video.webkitEnterFullscreen(); done(); } catch { liveFullscreenEl = null; delete wrap.dataset.fs; }
    return;
  }
  Promise.resolve(wrap.requestFullscreen?.()).then(done).catch(() => {
    liveFullscreenEl = null;
    delete wrap.dataset.fs;
  });
}

function exitLiveFullscreen() {
  const el = liveFullscreenEl;
  liveFullscreenEl = null;
  if (el) delete el.dataset.fs;
  try { screen.orientation?.unlock?.(); } catch { /* 忽略 */ }
  if (document.fullscreenElement) document.exitFullscreen?.().catch?.(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
  else if (typeof el?.webkitExitFullscreen === 'function') el.webkitExitFullscreen();
}

async function renderLive() {
  renderShell('live');
  const view = $('#view');
  if (liveState.epgTimer) { clearInterval(liveState.epgTimer); liveState.epgTimer = null; }
  if (liveState.orientationHandler) {
    window.removeEventListener('orientationchange', liveState.orientationHandler);
    liveState.orientationHandler = null;
  }

  if (state.liveSources.length === 0) {
    view.append(h('div', { class: 'jx-empty glass' }, '尚未配置直播源，请先到「设置 → 直播源」添加 M3U 订阅地址'));
    return;
  }

  const sourceTabs = h('div', { class: 'jx-tabs' });
  const channelBox = h('div', { class: 'jx-live-body' });
  const playerBox = h('div', { class: 'jx-player-box glass' });

  const renderTabs = () => {
    sourceTabs.innerHTML = '';
    for (const s of state.liveSources) {
      sourceTabs.append(h('button', {
        class: `jx-tab ${liveState.sourceKey === s.key ? 'active' : ''}`,
        onclick: () => loadPlaylist(s),
      }, s.name));
    }
  };

  const loadPlaylist = async (s) => {
    liveState.sourceKey = s.key;
    liveState.channels = [];
    renderTabs();
    channelBox.innerHTML = '<div class="jx-loading">正在加载频道列表…</div>';
    try {
      const data = await api.livePlaylist(s.url);
      liveState.channels = data.channels ?? [];
      liveState.groups = data.groups ?? [];
      renderChannels();
    } catch (err) {
      channelBox.innerHTML = `<div class="jx-error-inline">频道列表加载失败：${err.message}</div>`;
    }
  };

  const renderChannels = () => {
    channelBox.innerHTML = '';
    const searchInput = h('input', { type: 'search', placeholder: '搜索频道', class: 'jx-live-search' });
    const groupTabs = h('div', { class: 'jx-tabs jx-tabs-sm' });
    const listBox = h('div', { class: 'jx-channel-list' });

    let activeGroup = '';
    const renderGroups = () => {
      groupTabs.innerHTML = '';
      groupTabs.append(h('button', { class: `jx-tab ${activeGroup === '' ? 'active' : ''}`, onclick: () => { activeGroup = ''; renderGroups(); renderList(); } }, '全部'));
      for (const g of liveState.groups) {
        groupTabs.append(h('button', { class: `jx-tab ${activeGroup === g ? 'active' : ''}`, onclick: () => { activeGroup = g; renderGroups(); renderList(); } }, g));
      }
    };

    const renderList = () => {
      const kw = searchInput.value.trim().toLowerCase();
      listBox.innerHTML = '';
      const filtered = liveState.channels.filter((c) =>
        (!activeGroup || c.group === activeGroup) && (!kw || c.name.toLowerCase().includes(kw)));
      if (filtered.length === 0) {
        listBox.append(h('div', { class: 'jx-muted' }, '没有匹配的频道'));
        return;
      }
      for (const c of filtered) {
        listBox.append(h('button', {
          class: `jx-channel ${liveState.current?.id === c.id ? 'active' : ''}`,
          onclick: () => playChannel(c),
        },
          c.logo ? h('img', { src: c.logo, loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'jx-channel-dot' }),
          h('span', { class: 'jx-channel-name' }, c.name),
        ));
      }
    };

    searchInput.addEventListener('input', renderList);
    renderGroups();
    renderList();
    channelBox.append(h('div', { class: 'jx-live-sidebar glass' }, searchInput, groupTabs, listBox));
  };

  const playChannel = (c) => {
    liveState.current = c;
    renderChannels();
    playerBox.innerHTML = '';
    const url = api.liveStreamUrl(c.url);
    const video = h('video', { class: 'jx-live-video', controls: true, autoplay: true, playsinline: true });
    // 外壳承载原生全屏：手动按钮 + 手机横屏自动全屏（与点播播放器行为一致）
    const liveWrap = h('div', { class: 'jx-live-player-wrap' },
      h('div', { class: 'jx-live-now' }, c.name),
      video,
      h('button', { class: 'jx-live-fs', onclick: () => toggleLiveFullscreen(liveWrap, video) }, '全屏'),
    );
    playerBox.append(liveWrap);

    // TV 模式不自动全屏：TV 本身即横屏大屏，频道列表常驻便于方向键选台，
    // 追台用遥控数字键 / ChannelUp+Down（tv-nav.js），全屏留给手动按钮。

    // 手机横屏 → 自动全屏；转回竖屏 → 退出（桌面不启用）
    if (liveState.orientationHandler) window.removeEventListener('orientationchange', liveState.orientationHandler);
    if (window.matchMedia('(pointer: coarse)').matches) {
      const sync = () => {
        setTimeout(() => {
          const landscape = window.matchMedia('(orientation: landscape)').matches;
          if (landscape && !isLiveFullscreen()) toggleLiveFullscreen(liveWrap, video);
          else if (!landscape && isLiveFullscreen()) exitLiveFullscreen();
        }, 250);
      };
      liveState.orientationHandler = sync;
      window.addEventListener('orientationchange', sync);
      sync(); // 进入即横屏的（如从全屏返回后再进入）也生效
    }

    // HLS 优先；FLV 走 mpegts.js
    if (/\.flv(\?|$)/i.test(c.url)) {
      if (window.mpegts) {
        try {
          const player = mpegts.createPlayer({ type: 'flv', url, isLive: true }, { enableStashBuffer: false, liveBufferLatencyChasing: true });
          player.attachMedia(video);
          player.load();
        } catch {
          video.src = url;
        }
      } else {
        video.src = url;
      }
    } else if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true, liveSyncDuration: 3 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          try { hls.destroy(); } catch { /* 忽略 */ }
          video.src = url; // 降级原生播放
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
    }

    // EPG（频道带 tvg-id 且源配置了 epg 时展示）
    const src = state.liveSources.find((s) => s.key === liveState.sourceKey);
    const epgBox = h('div', { class: 'jx-epg' });
    playerBox.append(epgBox);
    const loadEpg = async () => {
      if (!src?.epg || !c.tvgId) { epgBox.textContent = ''; return; }
      try {
        const data = await api.liveEpg(src.epg, c.tvgId);
        const cur = data.current ? `正在播：${data.current.title}（${new Date(data.current.start).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）` : '暂无节目单';
        const next = data.next ? `接下来：${data.next.title}` : '';
        epgBox.innerHTML = '';
        epgBox.append(h('div', {}, cur), h('div', { class: 'jx-muted' }, next));
      } catch { /* EPG 失败不阻塞播放 */ }
    };
    loadEpg();
    if (liveState.epgTimer) clearInterval(liveState.epgTimer);
    liveState.epgTimer = setInterval(loadEpg, 60000);
  };

  view.append(
    h('div', { class: 'jx-live-head' }, h('h2', {}, '直播 / IPTV'), sourceTabs),
    channelBox,
    playerBox,
  );

  // TV 遥控：数字选台 / 上下频道换台入口（tv-nav.js 通过 window.__jxLive 读取状态）
  window.__jxLive = liveState;
  window.__jxPlayChannel = playChannel;

  if (!liveState.sourceKey) loadPlaylist(state.liveSources[0]);
  else renderTabs();
}

// —— 短剧页（分类浏览 + 搜索 + 连播，源来自「设置 → 短剧源」） ——

const dramaState = { sourceKey: null, categories: [], activeT: '', wd: '', page: 1, pagecount: 1 };

async function renderDrama() {
  renderShell('drama');
  const view = $('#view');
  await refreshDramaSources();

  if (state.dramaSources.length === 0) {
    view.append(h('div', { class: 'jx-empty glass' },
      h('h3', {}, '还没有配置短剧源'),
      h('p', { class: 'jx-muted' }, '短剧源采用 Apple CMS（采集站）协议，与点播源相同；添加后即可在此浏览分类、搜索片名、自动连播。'),
      h('p', {}, h('a', { href: '#/settings' }, '前往「设置 → 短剧源」添加 →')),
    ));
    return;
  }

  const sourceTabs = h('div', { class: 'jx-tabs' });
  const catChips = h('div', { class: 'jx-douban-chips' });
  const statusBox = h('div', { class: 'jx-search-status' });
  const grid = h('div', { class: 'jx-grid' });
  const moreBtn = h('button', { class: 'jx-btn-ghost jx-drama-more', onclick: () => loadPage(dramaState.page + 1, true) }, '加载更多');
  moreBtn.style.display = 'none';
  const searchInput = h('input', { type: 'search', placeholder: '搜索短剧片名', class: 'jx-live-search' });
  const doSearch = () => {
    dramaState.wd = searchInput.value.trim();
    loadPage(1);
  };
  const searchRow = h('div', { class: 'jx-drama-search-row' }, searchInput,
    h('button', { class: 'jx-btn-primary jx-drama-search-btn', onclick: doSearch }, '搜索'));

  const renderTabs = () => {
    sourceTabs.innerHTML = '';
    // 同一地址只保留一个标签（历史数据可能存在手打变体导致的重复源）
    const seen = new Set();
    for (const s of state.dramaSources) {
      const norm = normalizeSourceUrl(s.url);
      if (seen.has(norm)) continue;
      seen.add(norm);
      sourceTabs.append(h('button', {
        class: `jx-tab ${dramaState.sourceKey === s.key ? 'active' : ''}`,
        onclick: () => selectSource(s),
      }, s.name));
    }
  };

  const renderChips = () => {
    catChips.innerHTML = '';
    if (dramaState.categories.length === 0) {
      catChips.append(h('span', { class: 'jx-muted' }, '该源暂无短剧分类'));
      return;
    }
    for (const c of dramaState.categories) {
      catChips.append(h('button', {
        class: `jx-chip${c.id === dramaState.activeT ? ' jx-chip-on' : ''}`,
        onclick: () => {
          if (c.id !== dramaState.activeT) {
            dramaState.activeT = c.id;
            dramaState.wd = '';
            searchInput.value = '';
            writeCatMem(state.dramaSources.find((x) => x.key === dramaState.sourceKey), c.id);
            renderChips();
            loadPage(1);
          }
        },
      }, c.name));
    }
  };

  const renderCards = (items, append) => {
    if (!append) grid.innerHTML = '';
    for (const item of items) {
      // 短剧页单源浏览：源标签栏已点选源，卡片不再重复标注来源
      grid.append(videoCard(item, [item], (it) => {
        location.hash = `#/watch?source=${encodeURIComponent(it.sourceKey)}&id=${encodeURIComponent(it.vodId)}&title=${encodeURIComponent(it.name || '')}`;
      }, false));
    }
  };

  const loadPage = async (pg, append = false) => {
    const src = state.dramaSources.find((s) => s.key === dramaState.sourceKey);
    if (!src) return;
    statusBox.textContent = append ? '正在加载更多…' : '正在加载…';
    if (!append) grid.innerHTML = '';
    moreBtn.style.display = 'none';
    try {
      const data = await api.dramaList(src.key, { t: dramaState.activeT, pg, wd: dramaState.wd });
      if (!data.ok) throw new Error(data.error || '获取失败');
      dramaState.page = data.page ?? pg;
      dramaState.pagecount = data.pagecount ?? 1;
      renderCards(data.list ?? [], append);
      moreBtn.style.display = dramaState.page < dramaState.pagecount ? '' : 'none';
      statusBox.textContent = `${src.name}${dramaState.wd ? ` · 搜索「${dramaState.wd}」` : ''} · 第 ${dramaState.page}/${dramaState.pagecount} 页 · 点击卡片播放`;
    } catch (err) {
      if (!append) grid.innerHTML = '';
      statusBox.textContent = `加载失败：${err.message}`;
    }
  };

  // 每个源记住上次选中的分类（按源 URL 存：增删源后 key 会变，URL 不变）
  const catMemKey = (s) => `jxtvbox_drama_cat:${s.url}`;
  const readCatMem = (s) => { try { return localStorage.getItem(catMemKey(s)) || ''; } catch { return ''; } };
  const writeCatMem = (s, t) => { try { t ? localStorage.setItem(catMemKey(s), t) : localStorage.removeItem(catMemKey(s)); } catch { /* 隐私模式等场景忽略 */ } };

  const selectSource = async (s) => {
    dramaState.sourceKey = s.key;
    // 持久化点选的源（按 URL 存储），刷新/切页再回来保持
    try { localStorage.setItem('jxtvbox_drama_source', s.url); } catch { /* 隐私模式等场景忽略 */ }
    dramaState.wd = '';
    dramaState.page = 1;
    dramaState.pagecount = 1;
    searchInput.value = '';
    renderTabs();
    catChips.innerHTML = '<span class="jx-muted">正在获取分类…</span>';
    statusBox.textContent = '';
    grid.innerHTML = '';

    // 冷启动并行关键：列表不必等分类回来——用上次在该源选过的分类立即发请求
    const savedT = readCatMem(s);
    dramaState.activeT = savedT;

    const catPromise = api.dramaCategories(s.key).then((data) => {
      dramaState.categories = (data.categories ?? []).filter((c) => c.id && c.name);
      renderChips();
    }).catch((err) => {
      dramaState.categories = [];
      catChips.innerHTML = `<span class="jx-muted">分类获取失败：${err.message}</span>`;
    });
    const listPromise = loadPage(1);
    await Promise.all([catPromise, listPromise]);

    // 分类回来后校正：记忆失效（源调整过分类）或从未选过 → 落到第一个短剧分类
    const valid = dramaState.categories.some((c) => c.id === dramaState.activeT);
    if (!valid && dramaState.categories.length > 0 && dramaState.activeT !== dramaState.categories[0].id) {
      dramaState.activeT = dramaState.categories[0].id;
      writeCatMem(s, dramaState.activeT);
      renderChips();
      await loadPage(1);
    } else if (valid) {
      writeCatMem(s, dramaState.activeT);
    }
  };

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  });

  view.append(
    h('div', { class: 'jx-live-head' }, h('h2', {}, '短剧'), sourceTabs),
    h('div', { class: 'jx-drama-toolbar' }, searchRow, catChips),
    statusBox,
    grid,
    moreBtn,
  );

  // 恢复上次点选的短剧源；没有记录或该源已不存在时回退到第一个
  let savedUrl = null;
  try { savedUrl = localStorage.getItem('jxtvbox_drama_source'); } catch { /* 忽略 */ }
  const savedSource = savedUrl ? state.dramaSources.find((s) => s.url === savedUrl) : null;
  selectSource(savedSource ?? state.dramaSources[0]);
}

// —— 媒体库页（网盘 / 本地 / Emby） ——

const mediaState = { sourceKey: null, path: '/', parentId: null, items: [], views: [] };

async function renderMedia() {
  renderShell('media');
  const view = $('#view');
  await refreshMediaSources();

  if (state.mediaSources.length === 0) {
    view.append(h('div', { class: 'jx-empty glass' },
      h('h3', {}, '还没有挂载任何媒体源'),
      h('p', { class: 'jx-muted' }, '支持：本地/NAS 目录（MEDIA_DIRS 环境变量）、WebDAV（NAS/坚果云）、Alist/OpenList（阿里云盘/夸克/115 等网盘聚合）、Emby/Jellyfin 媒体库。'),
      h('p', {}, h('a', { href: '#/settings' }, '前往「设置 → 媒体源」添加 →')),
    ));
    return;
  }

  const sourceTabs = h('div', { class: 'jx-tabs' });
  const breadcrumb = h('div', { class: 'jx-breadcrumb' });
  const listBox = h('div', { class: 'jx-media-list' });

  const typeLabel = { local: '本地', webdav: 'WebDAV', alist: '网盘', emby: 'Emby' };

  const renderTabs = () => {
    sourceTabs.innerHTML = '';
    for (const s of state.mediaSources) {
      sourceTabs.append(h('button', {
        class: `jx-tab ${mediaState.sourceKey === s.key ? 'active' : ''}`,
        onclick: () => { mediaState.sourceKey = s.key; mediaState.path = '/'; mediaState.parentId = null; renderTabs(); loadDir(); },
      }, `${typeLabel[s.type] || s.type} · ${s.name}`));
    }
  };

  const renderBreadcrumb = () => {
    breadcrumb.innerHTML = '';
    breadcrumb.append(h('button', { class: 'jx-crumb', onclick: () => { mediaState.path = '/'; loadDir(); } }, '根目录'));
    if (mediaState.path !== '/') {
      const parts = mediaState.path.split('/').filter(Boolean);
      let acc = '';
      for (const p of parts) {
        acc += '/' + p;
        const target = acc;
        breadcrumb.append(h('span', { class: 'jx-muted' }, '/'),
          h('button', { class: 'jx-crumb', onclick: () => { mediaState.path = target; loadDir(); } }, p));
      }
    }
  };

  const playFile = (item) => {
    const src = state.mediaSources.find((s) => s.key === mediaState.sourceKey);
    const url = src.type === 'emby'
      ? api.mediaEmbyStreamUrl(src.key, item.path)
      : api.mediaStreamUrl(src.key, item.path);
    location.hash = `#/watch?url=${encodeURIComponent(url)}&title=${encodeURIComponent(item.name)}`;
  };

  const loadDir = async () => {
    renderBreadcrumb();
    listBox.innerHTML = '<div class="jx-loading">加载中…</div>';
    try {
      const params = new URLSearchParams({ source: mediaState.sourceKey, path: mediaState.path });
      if (mediaState.parentId) params.set('parentId', mediaState.parentId);
      const data = await api.mediaList(mediaState.sourceKey, mediaState.path + (mediaState.parentId ? `&parentId=${mediaState.parentId}` : ''));
      mediaState.items = data.items ?? [];
      mediaState.views = data.views ?? [];
      renderList();
    } catch (err) {
      listBox.innerHTML = `<div class="jx-error-inline">加载失败：${err.message}</div>`;
    }
  };

  const renderList = () => {
    listBox.innerHTML = '';
    // Emby 媒体库视图
    for (const v of mediaState.views) {
      listBox.append(h('button', { class: 'jx-media-item', onclick: () => { mediaState.parentId = v.id; loadDir(); } },
        h('span', { class: 'jx-media-icon' }, '🗂'),
        h('span', { class: 'jx-media-name' }, v.name),
      ));
    }
    if (mediaState.items.length === 0 && mediaState.views.length === 0) {
      listBox.append(h('div', { class: 'jx-muted' }, '此目录下没有视频文件'));
      return;
    }
    for (const item of mediaState.items) {
      if (item.isDir) {
        listBox.append(h('button', { class: 'jx-media-item', onclick: () => { mediaState.path = item.path; mediaState.parentId = null; loadDir(); } },
          h('span', { class: 'jx-media-icon' }, '📁'),
          h('span', { class: 'jx-media-name' }, item.name),
        ));
      } else {
        listBox.append(h('button', { class: 'jx-media-item jx-media-video', onclick: () => playFile(item) },
          h('span', { class: 'jx-media-icon' }, '🎬'),
          h('span', { class: 'jx-media-name' }, item.name),
          h('span', { class: 'jx-media-size jx-muted' }, item.sizeText || ''),
        ));
      }
    }
  };

  view.append(
    h('div', { class: 'jx-live-head' }, h('h2', {}, '媒体库'), sourceTabs),
    breadcrumb,
    listBox,
  );

  if (!mediaState.sourceKey) mediaState.sourceKey = state.mediaSources[0].key;
  renderTabs();
  loadDir();
}

// —— 历史页 ——

async function renderHistory() {
  renderShell('history');
  const view = $('#view');
  const history = await listHistory(200);
  if (history.length === 0) {
    view.append(h('div', { class: 'jx-empty glass' }, '还没有观看记录'));
    return;
  }
  const list = h('div', { class: 'jx-history-list' });
  for (const entry of history) {
    list.append(h('div', { class: 'jx-history-item glass' },
      h('button', { class: 'jx-history-play', onclick: () => {
        location.hash = `#/watch?source=${encodeURIComponent(entry.sourceKey)}&id=${encodeURIComponent(entry.vodId)}&index=${entry.episodeIndex ?? 0}&title=${encodeURIComponent(entry.title || '')}`;
      } }, '▶'),
      h('div', { class: 'jx-history-body' },
        h('div', { class: 'jx-history-title' }, entry.title || '未知视频'),
        h('div', { class: 'jx-muted' }, `第 ${(entry.episodeIndex ?? 0) + 1} 集 · ${entry.position && entry.duration ? `${fmtTime(entry.position)} / ${fmtTime(entry.duration)}` : ''} · ${new Date(entry.updatedAt).toLocaleString('zh-CN')}`),
      ),
      h('button', { class: 'jx-btn-ghost', onclick: async () => {
        await deleteHistory(`${entry.sourceKey}|${entry.vodId}`);
        renderHistory();
      } }, '删除'),
    ));
  }
  view.append(
    h('div', { class: 'jx-live-head' }, h('h2', {}, '观看历史'),
      h('button', { class: 'jx-btn-ghost', onclick: async () => { await clearHistory(); renderHistory(); } }, '清空历史')),
    list,
  );
}

// —— 设置页 ——

async function renderSettings() {
  renderShell('settings');
  const view = $('#view');
  await refreshSources();
  await refreshDramaSources();
  await refreshMediaSources();

  // —— 点播源管理 ——
  const vodList = h('div', { class: 'jx-src-list' });
  const renderVodSources = () => {
    vodList.innerHTML = '';
    if (state.sources.length === 0) {
      vodList.append(h('div', { class: 'jx-muted' }, '没有点播源'));
    }
    const all = (async () => (await api.listSources()).sources)();
    all.then((allSources) => {
      for (const s of allSources) {
        const health = s.health;
        vodList.append(h('div', { class: `jx-src-item glass ${s.enabled ? '' : 'disabled'}` },
          h('div', { class: 'jx-src-info' },
            h('div', {}, s.name, s.isAdult ? h('span', { class: 'jx-badge-adult' }, '18+') : null,
              !s.enabled ? h('span', { class: 'jx-badge-off' }, '已停用') : null),
            h('div', { class: 'jx-muted jx-src-url' }, s.url),
            health?.disabled
              ? h('div', { class: 'jx-src-health warn' }, `连续失败 ${health.fails} 次${health.remainingMs === Infinity ? '，已长期停用' : `，${Math.ceil(health.remainingMs / 60000)} 分钟后恢复`}${health.lastError ? `（${health.lastError}）` : ''}`)
              : null,
          ),
          h('div', { class: 'jx-src-actions' },
            h('button', { class: 'jx-btn-ghost', onclick: async () => {
              const r = await api.testSource(s.url);
              toast(r.ok ? `可用（${r.ms}ms，返回 ${r.count ?? 0} 条）` : `不可用：${r.error}`, r.ok ? 'success' : 'error');
            } }, '测速'),
            h('button', { class: 'jx-btn-ghost', onclick: async () => {
              await api.updateSource({ key: s.key, name: s.name, url: s.url, detail: s.detail, isAdult: s.isAdult, enabled: !s.enabled });
              await refreshSources(); renderVodSources();
            } }, s.enabled ? '停用' : '启用'),
            health?.disabled || health?.fails
              ? h('button', { class: 'jx-btn-ghost', onclick: async () => { await api.resetHealth(s.url); renderVodSources(); toast('健康度已重置', 'success'); } }, '恢复')
              : null,
            h('button', { class: 'jx-btn-ghost danger', onclick: async () => {
              if (!confirm(`删除点播源「${s.name}」？`)) return;
              await api.deleteSource(s.key);
              await refreshSources(); renderVodSources();
            } }, '删除'),
          ),
        ));
      }
    });
  };
  renderVodSources();

  const nameInput = h('input', { placeholder: '名称（可选）' });
  const urlInput = h('input', { placeholder: 'https://example.com/api.php/provide/vod' });
  const detailInput = h('input', { placeholder: '详情页地址（可选，部分源需要）' });
  vodList.append(h('div', { class: 'jx-src-add glass' },
    h('div', { class: 'jx-src-add-row' }, nameInput, urlInput),
    h('div', { class: 'jx-src-add-row' }, detailInput,
      h('button', { class: 'jx-btn-primary', onclick: async () => {
        try {
          await api.addSource({ name: nameInput.value, url: urlInput.value, detail: detailInput.value });
          nameInput.value = ''; urlInput.value = ''; detailInput.value = '';
          await refreshSources(); renderVodSources();
          toast('点播源已添加', 'success');
        } catch (err) { toast(err.message, 'error'); }
      } }, '添加点播源'),
    ),
  ));

  // —— 短剧源管理（与点播源同协议，仅「短剧」页使用） ——
  const dramaList = h('div', { class: 'jx-src-list' });
  const renderDramaSources = async () => {
    dramaList.innerHTML = '';
    const allSources = (await api.dramaSources()).sources;
    if (allSources.length === 0) {
      dramaList.append(h('div', { class: 'jx-muted' }, '没有短剧源'));
    }
    for (const s of allSources) {
      const health = s.health;
      dramaList.append(h('div', { class: `jx-src-item glass ${s.enabled ? '' : 'disabled'}` },
        h('div', { class: 'jx-src-info' },
          h('div', {}, s.name,
            !s.enabled ? h('span', { class: 'jx-badge-off' }, '已停用') : null),
          h('div', { class: 'jx-muted jx-src-url' }, s.url),
          health?.disabled
            ? h('div', { class: 'jx-src-health warn' }, `连续失败 ${health.fails} 次${health.remainingMs === Infinity ? '，已长期停用' : `，${Math.ceil(health.remainingMs / 60000)} 分钟后恢复`}${health.lastError ? `（${health.lastError}）` : ''}`)
            : null,
        ),
        h('div', { class: 'jx-src-actions' },
          h('button', { class: 'jx-btn-ghost', onclick: async () => {
            const r = await api.testSource(s.url);
            toast(r.ok ? `可用（${r.ms}ms，返回 ${r.count ?? 0} 条）` : `不可用：${r.error}`, r.ok ? 'success' : 'error');
          } }, '测速'),
          h('button', { class: 'jx-btn-ghost', onclick: async () => {
            await api.updateDramaSource({ key: s.key, name: s.name, url: s.url, detail: s.detail, isAdult: s.isAdult, enabled: !s.enabled });
            await refreshDramaSources(); await renderDramaSources();
          } }, s.enabled ? '停用' : '启用'),
          health?.disabled || health?.fails
            ? h('button', { class: 'jx-btn-ghost', onclick: async () => { await api.resetHealth(s.url); await renderDramaSources(); toast('健康度已重置', 'success'); } }, '恢复')
            : null,
          h('button', { class: 'jx-btn-ghost danger', onclick: async () => {
            if (!confirm(`删除短剧源「${s.name}」？`)) return;
            await api.deleteDramaSource(s.key);
            await refreshDramaSources(); await renderDramaSources();
          } }, '删除'),
        ),
      ));
    }
  };
  await renderDramaSources();

  const dName = h('input', { placeholder: '名称（可选）' });
  const dUrl = h('input', { placeholder: 'https://example.com/api.php/provide/vod' });
  const dDetail = h('input', { placeholder: '详情页地址（可选，部分源需要）' });
  dramaList.append(h('div', { class: 'jx-src-add glass' },
    h('div', { class: 'jx-src-add-row' }, dName, dUrl),
    h('div', { class: 'jx-src-add-row' }, dDetail,
      h('button', { class: 'jx-btn-primary', onclick: async () => {
        try {
          await api.addDramaSource({ name: dName.value, url: dUrl.value, detail: dDetail.value });
          dName.value = ''; dUrl.value = ''; dDetail.value = '';
          await refreshDramaSources(); await renderDramaSources();
          toast('短剧源已添加', 'success');
        } catch (err) { toast(err.message, 'error'); }
      } }, '添加短剧源'),
    ),
    h('p', { class: 'jx-muted jx-tip' }, '短剧源与点播源同协议（Apple CMS 采集站），单独管理、仅在「短剧」页使用。'),
  ));

  // —— 直播源管理 ——
  const liveList = h('div', { class: 'jx-src-list' });
  const renderLiveSources = () => {
    liveList.innerHTML = '';
    if (state.liveSources.length === 0) liveList.append(h('div', { class: 'jx-muted' }, '没有直播源'));
    for (const s of state.liveSources) {
      liveList.append(h('div', { class: 'jx-src-item glass' },
        h('div', { class: 'jx-src-info' },
          h('div', {}, s.name),
          h('div', { class: 'jx-muted jx-src-url' }, s.url, s.epg ? ` · EPG: ${s.epg}` : ''),
        ),
        h('div', { class: 'jx-src-actions' },
          h('button', { class: 'jx-btn-ghost danger', onclick: async () => {
            if (!confirm(`删除直播源「${s.name}」？`)) return;
            await api.deleteLiveSource(s.key);
            await refreshSources(); renderLiveSources();
          } }, '删除'),
        ),
      ));
    }
  };
  renderLiveSources();

  const liveName = h('input', { placeholder: '名称（可选）' });
  const liveUrl = h('input', { placeholder: 'M3U 订阅地址 https://...' });
  const liveEpg = h('input', { placeholder: 'XMLTV 节目单地址（可选）' });
  liveList.append(h('div', { class: 'jx-src-add glass' },
    h('div', { class: 'jx-src-add-row' }, liveName, liveUrl),
    h('div', { class: 'jx-src-add-row' }, liveEpg,
      h('button', { class: 'jx-btn-primary', onclick: async () => {
        try {
          await api.addLiveSource({ name: liveName.value, url: liveUrl.value, epg: liveEpg.value });
          liveName.value = ''; liveUrl.value = ''; liveEpg.value = '';
          await refreshSources(); renderLiveSources();
          toast('直播源已添加', 'success');
        } catch (err) { toast(err.message, 'error'); }
      } }, '添加直播源'),
    ),
  ));

  // —— 媒体源管理（网盘 / NAS / Emby） ——
  const mediaList = h('div', { class: 'jx-src-list' });
  const renderMediaSources = () => {
    mediaList.innerHTML = '';
    if (state.mediaSources.length === 0) mediaList.append(h('div', { class: 'jx-muted' }, '没有媒体源'));
    for (const s of state.mediaSources) {
      const typeLabel = { local: '本地/NAS', webdav: 'WebDAV', alist: '网盘(Alist)', emby: 'Emby/Jellyfin' };
      mediaList.append(h('div', { class: 'jx-src-item glass' },
        h('div', { class: 'jx-src-info' },
          h('div', {}, `${typeLabel[s.type] || s.type} · ${s.name}`),
          h('div', { class: 'jx-muted jx-src-url' }, s.url, s.hasApiKey ? ' · 已配置 API Key' : '', s.hasAuth ? ' · 已配置账号' : ''),
        ),
        h('div', { class: 'jx-src-actions' },
          h('button', { class: 'jx-btn-ghost danger', onclick: async () => {
            if (!confirm(`删除媒体源「${s.name}」？`)) return;
            await api.deleteMediaSource(s.key);
            await refreshMediaSources(); renderMediaSources();
          } }, '删除'),
        ),
      ));
    }
  };
  renderMediaSources();

  const mType = h('select', {}, h('option', { value: 'webdav' }, 'WebDAV（NAS/坚果云）'), h('option', { value: 'alist' }, 'Alist/OpenList（网盘聚合）'), h('option', { value: 'emby' }, 'Emby/Jellyfin'));
  const mName = h('input', { placeholder: '名称（可选）' });
  const mUrl = h('input', { placeholder: 'https://...' });
  const mUser = h('input', { placeholder: '账号（可选）' });
  const mPass = h('input', { placeholder: '密码 / Token / API Key', type: 'password' });
  mediaList.append(h('div', { class: 'jx-src-add glass' },
    h('div', { class: 'jx-src-add-row' }, mType, mName, mUrl),
    h('div', { class: 'jx-src-add-row' }, mUser, mPass,
      h('button', { class: 'jx-btn-primary', onclick: async () => {
        try {
          const body = { type: mType.value, name: mName.value, url: mUrl.value, user: mUser.value, pass: mPass.value };
          if (mType.value === 'alist') body.token = mPass.value;
          if (mType.value === 'emby') body.apiKey = mPass.value;
          await api.addMediaSource(body);
          mName.value = ''; mUrl.value = ''; mUser.value = ''; mPass.value = '';
          await refreshMediaSources(); renderMediaSources();
          toast('媒体源已添加', 'success');
        } catch (err) { toast(err.message, 'error'); }
      } }, '添加媒体源'),
    ),
    h('p', { class: 'jx-muted jx-tip' }, '本地/NAS 目录源通过 MEDIA_DIRS 环境变量声明（Docker 卷挂载或 fpk 共享目录），无需在此添加。'),
  ));

  // —— 播放设置 ——
  const adultChk = h('input', { type: 'checkbox', checked: settings.filterAdult });
  const autoNextChk = h('input', { type: 'checkbox', checked: settings.autoNext });
  const stripAdChk = h('input', { type: 'checkbox', checked: settings.stripAd });
  const cacheChk = h('input', { type: 'checkbox', checked: settings.cache.enabled });
  const cacheSize = h('span', { class: 'jx-muted' }, '计算中…');

  adultChk.addEventListener('change', async () => { settings.filterAdult = adultChk.checked; await setSetting('filterAdult', adultChk.checked); });
  autoNextChk.addEventListener('change', async () => { settings.autoNext = autoNextChk.checked; await setSetting('autoNext', autoNextChk.checked); });
  stripAdChk.addEventListener('change', async () => { settings.stripAd = stripAdChk.checked; await setSetting('stripAd', stripAdChk.checked); });

  // TV 模式三态：自动（UA 识别）/ 始终开启 / 始终关闭（设备本地偏好，存 localStorage）
  const tvMode = window.jxTv?.getMode?.() ?? 'auto';
  const tvSelect = h('select', { class: 'jx-select' },
    h('option', { value: 'auto', selected: tvMode === 'auto' }, '自动（按设备 UA 识别）'),
    h('option', { value: 'on', selected: tvMode === 'on' }, '始终开启（大按钮 + 焦点环）'),
    h('option', { value: 'off', selected: tvMode === 'off' }, '始终关闭'),
  );
  tvSelect.addEventListener('change', () => {
    const on = window.jxTv?.setMode(tvSelect.value);
    toast(`TV 模式已设为「${tvSelect.value === 'auto' ? '自动' : tvSelect.value === 'on' ? '开启' : '关闭'}」${on ? '（已生效）' : ''}`, 'success');
  });
  cacheChk.addEventListener('change', async () => {
    settings.cache = saveCacheSettings({ enabled: cacheChk.checked });
    toast(cacheChk.checked ? '分片缓存已开启' : '分片缓存已关闭', 'success');
  });

  estimateCacheBytes().then((b) => { cacheSize.textContent = b > 0 ? `约 ${(b / 1024 / 1024).toFixed(1)} MB` : '暂无数据'; });

  view.append(
    h('section', { class: 'jx-section' },
      h('h3', { class: 'jx-section-title' }, '点播源（Apple CMS 采集站）'),
      vodList,
    ),
    h('section', { class: 'jx-section' },
      h('h3', { class: 'jx-section-title' }, '短剧源（短剧采集站）'),
      dramaList,
    ),
    h('section', { class: 'jx-section' },
      h('h3', { class: 'jx-section-title' }, '直播源（M3U 订阅）'),
      liveList,
    ),
    h('section', { class: 'jx-section' },
      h('h3', { class: 'jx-section-title' }, '媒体源（网盘 / NAS / Emby）'),
      mediaList,
    ),
    h('section', { class: 'jx-section' },
      h('h3', { class: 'jx-section-title' }, '播放设置'),
      h('div', { class: 'jx-settings glass' },
        h('label', { class: 'jx-setting-row' }, adultChk, '成人内容过滤（按分类关键词过滤）'),
        h('label', { class: 'jx-setting-row' }, autoNextChk, '自动连播'),
        h('label', { class: 'jx-setting-row' }, stripAdChk, '广告分片过滤（m3u8 片头/中插广告）'),
        h('label', { class: 'jx-setting-row' }, tvSelect, 'TV 模式（Android TV / 客厅遥控：方向键导航、焦点环、遥控 media 键、播放页自动全屏 + 剧集面板）'),
        h('label', { class: 'jx-setting-row' }, cacheChk, h('span', {}, '分片缓存（播放/暂停时向前预取，卡顿自动让出带宽）'), cacheSize),
        h('div', { class: 'jx-setting-row' },
          h('button', { class: 'jx-btn-ghost', onclick: async () => {
            await clearVideoCache();
            cacheSize.textContent = '已清空';
            toast('分片缓存已清空', 'success');
          } }, '清空分片缓存'),
        ),
      ),
    ),
    h('section', { class: 'jx-section' },
      h('h3', { class: 'jx-section-title' }, '关于'),
      h('div', { class: 'jx-settings glass' },
        h('p', { class: 'jx-muted' }, 'JXTVbox —— 聚合搜索播放 + 短剧 + 直播 + 网盘/本地媒体库。服务端零依赖 Node，前端零构建。'),
        h('p', { class: 'jx-muted' }, '源配置与健康度保存在服务端（多设备共享）；播放进度与历史保存在本机浏览器 IndexedDB。'),
      ),
    ),
  );
}

// —— 全屏诊断（真机排查用）——
// 用法：地址后面加 ?fsdiag=1，例如 http://<nas>:8080/?fsdiag=1#/watch?...
// 输出内核能力（:has() / Fullscreen API / 方向锁）、视口尺寸、播放器实际矩形。
export function fsDiagText() {
  const p = window.__jxPlayer;
  const $p = p?.art?.template?.$player;
  const r = $p?.getBoundingClientRect();
  const vv = window.visualViewport;
  let hasSupport = false;
  try { hasSupport = CSS.supports('selector(:has(*))'); } catch { /* 老内核 */ }
  return [
    `UA: ${navigator.userAgent}`,
    `视口: ${window.innerWidth}×${window.innerHeight} (inner) / ${document.documentElement.clientWidth}×${document.documentElement.clientHeight} (doc) / ${vv ? `${Math.round(vv.width)}×${Math.round(vv.height)}` : 'n/a'} (vv)`,
    `竖持: ${window.innerHeight > window.innerWidth}  dpr: ${window.devicePixelRatio}`,
    `:has() 支持: ${hasSupport}`,
    `Fullscreen API: ${document.fullscreenEnabled}  orientation.lock: ${typeof screen.orientation?.lock}`,
    `全屏态: active=${!!p?.fsActive} web=${!!p?.art?.fullscreenWeb} native=${!!document.fullscreenElement} pending=${!!p?.pendingFs}`,
    `播放器矩形: ${r ? `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}×${Math.round(r.height)}` : 'n/a'}`,
    `视频尺寸: ${p?.art?.video?.videoWidth ?? 0}×${p?.art?.video?.videoHeight ?? 0}`,
  ].join('\n');
}

function showFsDiag() {
  const box = document.createElement('pre');
  box.className = 'jx-fsdiag';
  box.textContent = `${fsDiagText()}\n\n（长按可复制，点右上角关闭）`;
  const close = document.createElement('button');
  close.textContent = '×';
  close.className = 'jx-fsdiag-close';
  close.onclick = () => box.remove();
  box.append(close);
  document.body.append(box);
}

// —— 路由器 ——

let booted = false;

async function route() {
  if (!state.verified) return;
  const { path } = parseHashQuery();
  // 离开直播页：清理横屏全屏监听，避免对已销毁的播放器元素发全屏请求
  if (path !== '/live' && liveState.orientationHandler) {
    window.removeEventListener('orientationchange', liveState.orientationHandler);
    liveState.orientationHandler = null;
    if (isLiveFullscreen()) exitLiveFullscreen();
  }
  switch (path) {
    case '/watch': await renderWatch(); break;
    case '/live': await renderLive(); break;
    case '/drama': await renderDrama(); break;
    case '/media': await renderMedia(); break;
    case '/history': await renderHistory(); break;
    case '/settings': await renderSettings(); break;
    default: await renderHome();
  }
}

async function boot() {
  await loadSettings();
  try {
    const status = await api.status();
    state.passwordRequired = status.passwordRequired;
    state.verified = status.verified;
    if (!status.passwordRequired && !status.verified) {
      renderLogin(status);
      return;
    }
    if (status.passwordRequired) {
      renderLogin(status);
      return;
    }
  } catch (err) {
    toast('无法连接服务器', 'error');
    return;
  }
  await refreshSources();
  await refreshDramaSources();
  booted = true;
  await route();
  if (/[?&]fsdiag=1/.test(location.search)) setTimeout(showFsDiag, 1500);
}

window.addEventListener('hashchange', () => {
  if (booted) route();
});

// 画质徽章缓存（首页卡片用）
state.qualityCache = {};

boot();
