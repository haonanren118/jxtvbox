# JXTVbox

[![Release](https://img.shields.io/github/v/release/haonanren118/jxtvbox?color=2ea043&label=release)](https://github.com/haonanren118/jxtvbox/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-orange)](LICENSE)
[![Docker](https://img.shields.io/badge/ghcr.io-jxtvbox-2496ED?logo=docker&logoColor=white)](https://github.com/haonanren118/jxtvbox/pkgs/container/jxtvbox)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-339933?logo=node.js&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-amd64%20%7C%20arm64-lightgrey)](#安装)
[![fnOS](https://img.shields.io/badge/%E9%A3%9E%E7%89%9B%20fnOS-fpk-00A0E9)](#方式一飞牛-nasfnos一键安装-fpk)
[![QQ群](https://img.shields.io/badge/QQ%E7%BE%A4-708144970-12B7F5?logo=tencentqq&logoColor=white)](#交流与反馈)

聚合影视搜索播放器：**点播聚合 + 短剧 + 直播 + 网盘/本地媒体库**，一个容器跑起来，浏览器、手机、电视盒子、Android TV 都能用。

服务端是**零依赖 Node**（没有 `npm install`、没有构建步骤），前端是**零构建原生 ES Module**，所以镜像只有 ~170MB，任何有 Docker 的设备（飞牛 NAS、群晖、极空间、软路由、树莓派、VPS）都能装。

> 本项目基于 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的核心逻辑重写与增强，遵循 **AGPL-3.0** 开源。

**搜索关键词**（方便你或别人找到它）：TVBox 替代、影视聚合、追剧、短剧、直播源、IPTV、EPG、苹果 CMS 采集、飞牛 fnOS、群晖 / 极空间 / 绿联 NAS、自建影视库、WebDAV / AList / Emby、Docker 影视、hls.js、ArtPlayer、Android TV 影视 App。

---

## ⚠️ 免责声明

- 本项目**不提供、不存储、不传播任何影视资源**，仅提供一个把用户**自行配置的第三方接口**（采集站 API、直播订阅、自建媒体库）聚合展示的客户端界面。
- 你通过本软件访问的一切内容均来自第三方，其合法性、准确性、安全性由该第三方负责；请自行确认所在地区法律法规，**仅用于个人学习与技术研究**。
- 请勿将本软件用于任何商业用途或公开传播侵权内容。因使用本软件产生的任何法律责任由使用者自行承担。
- 本项目不含任何破解、绕过付费墙或版权保护的功能。

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [首次配置](#首次配置)
- [配置项](#配置项)
- [使用指南](#使用指南)
- [常见问题](#常见问题)
- [数据与备份](#数据与备份)
- [架构](#架构)
- [与 LibreTV 的差异](#与-libretv-的差异)
- [已知限制](#已知限制)
- [交流与反馈](#交流与反馈)
- [致谢](#致谢)
- [License](#license)

---

## 功能

| 模块 | 说明 |
| --- | --- |
| **点播聚合** | 多源并行搜索，跨源同名结果自动聚合分组，一键换源；支持季/集解析 |
| **短剧** | 独立短剧页：分类浏览、分页列表、片名搜索、自动连播；短剧源独立管理，不与综合站混在一起 |
| **播放** | ArtPlayer + hls.js + mpegts.js；m3u8 广告分片三层过滤、分片缓存预取、播放错误自动恢复、进度记忆、自动连播 |
| **直播** | M3U 订阅 + XMLTV 节目单，HLS / FLV 自动切换，频道分组 |
| **媒体库** | 本地/NAS 目录、WebDAV、Alist/OpenList（阿里云盘/夸克/115 等）、Emby/Jellyfin，服务端流式代理（支持 Range） |
| **源管理** | 配置存服务端（多设备共享），源健康度阶梯停用（30 分钟 → 24 小时 → 长期）与一键测速恢复 |
| **安全** | 访问密码 + HMAC 会话、IP 限流、SSRF 防护（协议 / 私网 / DNS 解析 / 逐跳重定向校验） |

### 三端适配

- **桌面浏览器**：完整键盘快捷键、网页全屏
- **手机**：响应式布局、≥44px 触控区、刘海安全区、竖屏/横屏全屏、全屏内选集面板、长按 3 倍速
- **Android TV / 电视盒子**：遥控器方向键空间导航、大字号 10-foot UI、媒体键（播放/快进/上一集）、数字键选台

---

## 安装

四种方式任选其一。**推荐「飞牛 fpk」或「Docker Compose」。**

### 方式一：飞牛 NAS（fnOS）一键安装 FPK

1. 下载 [`jxtvbox.fpk`](https://github.com/haonanren118/jxtvbox/releases/latest)；
2. 飞牛「应用中心 → 手动安装」，选择该 fpk；
3. 安装向导填写：

   | 向导项 | 说明 |
   | --- | --- |
   | 访问端口 | 宿主机端口，默认 `8080`；装好后可在「应用设置」里改（改完自动重启） |
   | 访问密码 | 建议安装时直接设置；留空则站点提示未配置，API 全部停用 |
   | 本地媒体目录 | 容器内路径，默认 `/media`，多个用英文逗号分隔 |
   | 内网直播源 | 使用 udpxy / 内网 M3U 时必须选「允许」 |

4. 安装完成后桌面出现 **JXTVbox** 图标，点击即打开。

首次启动会从 `ghcr.io` 拉取镜像（约 170MB）。**国内网络拉取失败**时，先按「方式三」离线导入镜像，再安装 fpk —— compose 发现本地已有同名镜像就不会联网拉取。

> 应用会自动创建两个共享目录（飞牛「文件」里可见，卸载不会删除）：
> - `jxtvbox/data` → 容器 `/app/data`：源配置、健康度
> - `jxtvbox/media` → 容器 `/media`（只读）：把你自己的片子放进来

### 方式二：Docker Compose（群晖 / 极空间 / 软路由 / VPS 通用）

```bash
git clone https://github.com/haonanren118/jxtvbox.git
cd jxtvbox
cp .env.example .env      # 编辑 .env，至少改掉 PASSWORD
docker compose up -d
```

访问 `http://<设备IP>:8080`，输入密码即可。

不用 Git 也行，直接把仓库的 `docker-compose.yml`、`.env.example` 拷两个文件到一个空目录即可。

### 方式三：离线镜像（内网 / 无法访问 ghcr.io 时）

从 [Releases](https://github.com/haonanren118/jxtvbox/releases/latest) 下载对应架构的镜像包：

| 文件 | 适用 |
| --- | --- |
| `jxtvbox-1.0.0-amd64.tar.gz`（59MB） | x86_64：绝大多数 NAS、N100/N5105、群晖 Intel 机型、PC、VPS |
| `jxtvbox-1.0.0-arm64.tar.gz` | ARM64：树莓派 4/5、RK3588、部分 ARM NAS（由 GitHub Actions 构建） |

```bash
# 1) 导入镜像（包内已含 1.0.0 与 latest 两个标签）
gunzip -c jxtvbox-1.0.0-amd64.tar.gz | docker load

# 2) 起容器（或直接用仓库的 docker-compose.yml）
docker run -d --name jxtvbox \
  --restart unless-stopped \
  -p 8080:8080 \
  -e PASSWORD=你的密码 \
  -e TZ=Asia/Shanghai \
  -v $(pwd)/data:/app/data \
  ghcr.io/haonanren118/jxtvbox:1.0.0

# 需要接入 NAS 上的媒体目录时，再加 -v /你的/视频目录:/media:ro 并设置 -e MEDIA_DIRS=/media
```

> 包内已含 `1.0.0` 与 `latest` 两个标签，`docker load` 后可直接被 fpk 的 compose 复用，无需联网。

### 方式四：源码直接跑（开发调试）

```bash
PASSWORD=你的密码 node server.js     # 默认 0.0.0.0:8080
# 需要 Node ≥ 18.17，无需 npm install
```

---

## 首次配置

1. **设密码**：`PASSWORD` 环境变量（Docker）或应用设置（fpk）。未设置时站点会提示，且所有 API 返回 503。
2. **加点播源**：设置 → 点播源，粘贴 Apple CMS 采集接口（形如 `https://xxx.com/api.php/provide/vod`）。
3. **短剧（可选）**：设置 → 短剧源，同样是 Apple CMS 接口，只单独给「短剧」页用。
4. **直播（可选）**：设置 → 直播源，填 M3U 订阅地址（可带 XMLTV 节目单）。
5. **媒体库（可选）**：设置 → 媒体源，添加 WebDAV / Alist / Emby，或用 `MEDIA_DIRS` 挂本地目录。

> 也可以在部署时用 `DEFAULT_SOURCES` / `DEFAULT_DRAMA_SOURCES` / `DEFAULT_LIVE_SOURCES` 预置源，适合给家里人一次性配好。

---

## 配置项

全部通过环境变量配置，改完重启容器生效。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PASSWORD` | 空 | **必填**。访问密码；未设置时 API 全部返回 503 |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听地址（容器内固定 8080，改宿主机映射即可） |
| `DATA_DIR` | `./data` | 配置与健康度存储目录 |
| `MEDIA_DIRS` | 空 | 本地媒体目录，逗号分隔（如 `/media/local1,/media/nas`） |
| `DEFAULT_SOURCES` | 空 | 预置点播源，JSON 数组 |
| `DEFAULT_DRAMA_SOURCES` | 空 | 预置短剧源，JSON 数组 |
| `DEFAULT_LIVE_SOURCES` | 空 | 预置直播源，JSON 数组（支持 `epg` 字段） |
| `LIVE_ALLOW_PRIVATE` | 空 | 设 `1` 允许直播源使用内网地址（**udpxy / 内网 M3U 必须开启**） |
| `COOKIE_SECURE` | 自动 | `true` / `false` 强制会话 cookie 的 Secure 标记（反代 HTTPS 场景） |
| `SEARCH_MAX_PAGES` | `5` | 单源搜索最大翻页数 |
| `SEARCH_SOURCE_TIMEOUT_MS` | `10000` | 单源搜索总超时（毫秒） |
| `REQUEST_TIMEOUT` | `8000` | 上游请求超时（毫秒） |

源配置的 JSON 格式：

```json
[{"name": "示例源", "url": "https://example.com/api.php/provide/vod"}]
```

---

## 使用指南

### 手机

- 竖屏浏览；进入播放页可点全屏。**竖版短剧**在竖屏下铺满整屏；**横版正剧**会自动尝试锁定横屏，转横屏即满屏（上下黑边属正常，画面不裁切）。
- 全屏状态点控制条「选集」按钮可换集，换集后保持全屏。
- 视频区域长按可 3 倍速。

### Android TV / 电视盒子

用浏览器或 TVBox 类浏览器的「打开网址」访问即可，首次按方向键会自动进入 TV 模式（也可在 设置 → 播放设置 → TV 模式 强制开/关）。

| 按键 | 作用 |
| --- | --- |
| 方向键 | 移动焦点（弹窗打开时只在弹窗内导航） |
| OK / 确认 | 选中；焦点在播放器时为播放/暂停 |
| 播放页 ← / → | 快退 / 快进 5 秒 |
| 播放页 ↑ / ↓ | 音量 |
| 返回键 | 关闭弹窗 / 返回上一页 |
| 数字键 | 直播页快速选台 |
| `M` | 打开/关闭剧集面板 |

### 桌面键盘快捷键

| 按键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `←` / `→` | 快退 / 快进 5 秒 |
| `↑` / `↓` | 音量 |
| `F` | 全屏 / 退出全屏 |

### 源健康度

某个源连续失败会被**阶梯停用**（30 分钟 → 24 小时 → 长期），搜索时自动跳过；设置页可以一键测速并恢复。这样坏源不会拖慢每次搜索。

---

## 常见问题

**Q：`docker pull` 拉不下来 / 卡在 ghcr.io？**
用「方式三」的离线镜像包 `docker load` 导入即可，全程不需要外网。也可以给 Docker 配镜像加速器。

**Q：忘了密码怎么办？**
密码只存在环境变量里，没有写数据库。Docker：改 `.env` 的 `PASSWORD` 后 `docker compose up -d`；fpk：应用设置里重填密码保存，应用会自动重启。

**Q：内网直播源（udpxy / 内网 M3U）提示被拦截？**
SSRF 防护默认禁止私网地址。设 `LIVE_ALLOW_PRIVATE=1`（fpk 在向导里选「允许」）后重启。

**Q：搜索很慢 / 某个源总是失败？**
源本身响应慢或已失效，健康度机制会自动跳过它；在设置页把它删掉或替换掉即可。

**Q：`http://IP:8080` 打不开？**
先 `curl http://IP:8080/healthz` 应返回 `{"ok":true}`。返回不了说明容器没起来（`docker logs jxtvbox` 看原因）；端口被占用就改映射端口。

**Q：ARM NAS 能用吗？**
可以。GitHub Actions 自动构建 `linux/amd64` 与 `linux/arm64` 双架构镜像，离线包也分两个架构，注意下载对应版本。

**Q：fpk 安装后图标点开是空白页？**
镜像还没拉完或拉取失败。SSH 里 `docker ps` 看容器状态，`docker logs jxtvbox` 看日志；必要时先 `docker load` 离线包再重新打开应用。

---

## 数据与备份

所有状态都在 `DATA_DIR`（默认 `./data`，fpk 为共享目录 `jxtvbox/data`）：

| 文件 | 内容 |
| --- | --- |
| `sources.json` | 点播源 |
| `drama-sources.json` | 短剧源 |
| `live-sources.json` | 直播源 |
| `media-sources.json` | 媒体源（WebDAV / Alist / Emby 的地址与凭据） |
| `health.json` | 源健康度 |

**备份**：整个 `data` 目录拷走即可；**迁移**：把 `data` 目录放到新机器的挂载点，启动即恢复。

> 注意：媒体源里可能存有网盘 Token / Emby API Key，备份文件请勿外传。

---

## 架构

```
jxtvbox/
├── server.js              # HTTP 入口：API 分发 / 静态文件（ETag+Range+SPA 回退）/ /healthz
├── routes/
│   ├── api.js             # 登录、搜索、详情、代理、直播、源 CRUD、测速
│   ├── drama.js           # 短剧：分类 / 列表 / 搜索（代理上游 ac=list / ac=videolist）
│   ├── douban.js          # 豆瓣热播榜（服务端代理 + 10 分钟缓存）
│   ├── media.js           # 媒体库：四型源列表 / 扫描 / 流式播放
│   └── router.js          # 极简路由（method + pathname 精确匹配）
├── lib/                   # 零依赖服务端逻辑
│   ├── cms-parser.js      #   Apple CMS 解析（季数感知相关性 / 成人内容过滤）
│   ├── m3u8.js            #   m3u8 广告分片三层过滤 + 地址重写
│   ├── ssrf.js            #   SSRF 防护（协议 / 私网 / DNS / 逐跳重定向）
│   ├── auth.js            #   HMAC 会话 + IP 限流
│   ├── source-store.js    #   源配置持久化（原子写入）+ 健康度阶梯
│   ├── media-store.js     #   媒体源持久化 + 本地目录扫描
│   ├── webdav.js / alist.js / emby.js
│   └── m3u-parser.js / xmltv.js / live-cache.js / fetch-utils.js
└── public/                # 前端零构建
    ├── index.html
    ├── css/app.css        # 暗色毛玻璃 + TV / 触屏适配
    ├── js/
    │   ├── app.js         # SPA 路由与页面渲染
    │   ├── player.js      # 播放器封装：hls 装载、广告过滤、恢复、全屏控制
    │   ├── tv-nav.js      # 遥控器空间导航（几何投影 + 媒体键）
    │   ├── video-cache.js / video-prefetcher.js   # 分片缓存与预热
    │   └── db.js / api.js / m3u8-util.js / playback-recovery.js
    └── vendor/            # artplayer 5.2.3 / hls.js 1.5.17 / mpegts.js 1.8.2
```

---

## 与 LibreTV 的差异

1. **Next.js → 零依赖 Node**：没有 `node_modules`、没有构建步骤，镜像 ~170MB，任何 Node ≥18.17 环境可直接跑，也方便在 NAS 上长期维护。
2. **源配置服务端化**：LibreTV 把源存在浏览器 localStorage；本项目存服务端 JSON（原子写入），多设备共享，并增加健康度阶梯停用与一键恢复。
3. **短剧模块**：独立短剧源与短剧页（分类 / 分页 / 搜索 / 连播），与综合站点互不干扰。
4. **媒体库**：新增 WebDAV / Alist / Emby 挂载与流式播放。
5. **播放稳定性**：m3u8 走服务端代理并按顺序预热分片，弱网源（源站限速）也能起播秒开、连续播放不卡。
6. **TV / 手机适配**：遥控器空间导航 + 10-foot UI；手机触屏安全区、竖横屏全屏、全屏内选集。
7. 保留并加固：m3u8 三层广告过滤、分片缓存、播放恢复状态机、SSRF 防护、HMAC 会话。

---

## 已知限制

- **TV 端输入依赖遥控器全键盘**，建议先在桌面或手机把源配好，电视端只用来浏览和播放。
- 分片缓存使用服务端内存（默认上限 512MB / 30 分钟），不是持久化缓存；重启容器后需重新预热。
- 极弱源（源站总带宽 < 200KB/s）连续播放超长视频（>5 分钟）仍可能供给不足，靠播放器的缓冲策略兜底。
- 播放健壮性依赖第三方源质量，源失效属正常现象，用健康度与换源应对。

---

## 交流与反馈

| 渠道 | 用途 |
| --- | --- |
| **QQ 群：708144970** | 安装答疑、源配置交流、新版本尝鲜。装不上、打不开、播放异常，群里问最快 |
| [Issues](https://github.com/haonanren118/jxtvbox/issues) | 报 Bug、提需求。请附**版本号**（右下角/关于里可见）、**设备与系统**、**复现步骤** |
| [Releases](https://github.com/haonanren118/jxtvbox/releases) | 每个版本的安装包（fpk / 离线镜像）与变更说明。点 **Watch → Custom → Releases** 可只收版本通知 |
| [Discussions](https://github.com/haonanren118/jxtvbox/discussions) | 使用技巧、部署方案、源格式讨论 |

> 群里只聊安装、配置与使用，**不发任何影视资源与付费内容**，请遵守所在地区法律法规。

---

## 致谢

- [ArtPlayer](https://github.com/zhw2590582/ArtPlayer)、[hls.js](https://github.com/video-dev/hls.js)、[mpegts.js](https://github.com/xqq/mpegts.js) —— 播放内核
- 飞牛 fnOS 社区 —— fpk 打包规范与测试环境

## License

**AGPL-3.0**。衍生作品需以相同许可证开放源代码，详见 [LICENSE](LICENSE)。

---

<div align="center">

**如果这个项目帮到了你，点右上角 ⭐ Star —— 这是让更多人搜到它最直接的帮助。**

有问题欢迎进 QQ 群 **708144970** 交流。

</div>
