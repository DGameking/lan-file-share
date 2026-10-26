# 局域网文件共享平台 · 桌面客户端

> 参加 WorkBuddy「1024 造物挑战」程序员节应用创作大赛的参赛作品。
> 基于 PRD《局域网文件共享平台》实现的跨平台桌面客户端（MVP）。

## 一句话介绍

一台电脑，一键把任意文件夹共享到局域网；同网内的手机、平板、其他电脑，用浏览器扫码即开即看、即点即下，无需安装、无需注册、端到端加密可控。

## 核心特性（对齐 PRD）

- **一键共享**：选择文件夹即可生成可访问链接与二维码，支持只读 / 可写 / 管理三种权限。
- **统一会话框（1.1.0 新增）**：
  - 所有连接到本机服务的设备（桌面客户端 / 手机浏览器）**自动进入同一个会话框**，无需手动添加；
  - 支持文字聊天、输入状态（"正在输入…"）、消息历史持久化（本机 SQLite）；
  - 聊天中可直接发送**任意类型文件与整个文件夹**（保留目录结构），图片/视频/音频自动内联预览，接收文件存入可管理的共享目录；
  - **音视频通话**：WebRTC P2P 直连（媒体流不经过服务器，纯局域网零延迟），支持多人语音 / 视频通话、静音、来电接听 / 拒绝。
- **多端免装访问**：接收方用任意浏览器（含手机）打开链接即可浏览、预览（图片/视频/音频/PDF/文本）、下载、批量打包下载、拖拽上传。
- **Web 管理控制台（1.2.0 新增）**：
  - 任意设备浏览器打开 `http://服务IP:端口/admin` 即可管理：概览（速度/流量/设备）、共享增删改与二维码、设备信任/拉黑/测速、日志、设置；
  - **安全模型**：本机回环免登录（桌面端走 IPC 不受影响）；远程设备需管理密码登录（SCrypt 加盐存储，24 小时 HMAC 令牌），未设密码时远程一律拒绝；
  - 管理密码哈希不随设置/WS 广播泄露；`/chat` 等访客接口不纳入管理鉴权；
  - 根路径升级为门户页：统一会话、管理控制台、共享列表三入口。
- **自动设备发现**：同时采用 `mDNS (Bonjour/Zeroconf)` 与 `UDP 广播心跳` 双通道，局域网设备互相可见。
- **安全可控**：
  - 每台设备生成 `RSA-2048` 密钥对，对外展示 SHA-256 指纹用于身份确认；
  - 共享可设密码，密码以 `AES-256-CBC` 用本机主密钥加密存储；
  - 支持 IP 白名单（CIDR）、拉黑、仅信任设备可见；
  - 首次连接二次确认 / 自动信任开关。
- **邀请码 / 手动连接**：生成 6 位限时邀请码，或手动输入 IP:端口 加入。
- **系统托盘 & 自启动**：关闭最小化到托盘，可选开机自启。
- **实时日志**：所有访问、上下线、连接动作均记录并可查看。
- **WebDAV 子集**：对外暴露 `PROPFIND/GET/PUT/DELETE/MKCOL`，可被系统/播放器挂载。
- **断点续传**：下载支持 `Range` 请求与限速。

## 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 桌面壳 | Electron | 跨 Windows / macOS / Linux |
| 前端 | Vue 3（全局构建，离线无打包器） | 纯 HTML/JS/CSS，随包分发 |
| 引擎 | Node.js + Express | 文件服务 / API / WebSocket 推送 |
| 数据库 | sql.js（SQLite WASM） | 零原生编译、跨平台、可离线 |
| 发现 | bonjour + dgram UDP 广播 | mDNS + 心跳双通道 |
| 传输 | ws / archiver / busboy / qrcode | 实时推送 / 批量下载 / 上传 / 二维码 |

> 选用 `sql.js` 而非 `better-sqlite3`：避免原生编译工具链依赖，保证开箱即跑、跨平台一致。

## 目录结构

```
lan-file-share/
├── main/                 # Electron 主进程
│   ├── index.js          # 窗口 / 引擎启动 / IPC 桥接 / 托盘 / 自启
│   ├── preload.js        # 安全暴露 window.lan API（contextBridge）
│   └── tray.js           # 系统托盘
├── renderer/             # Vue 3 桌面界面（无需打包）
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── vendor/vue.global.js   # 由 scripts/copy-vendor.js 自动拷贝
├── server/               # 核心引擎（不依赖 Electron，可独立运行）
│   ├── index.js          # LanFileShare 引擎
│   ├── api.js            # 管理 API
│   ├── chat.js           # 统一会话：聊天 / 会话文件 / WebRTC 信令中继
│   ├── handlers/         # browse / download / upload / webdav / zip
│   ├── middleware/       # auth / ip-filter / rate-limit / logger
│   └── static/           # share.html 访客页 + chat.html 统一会话页 + admin.html 管理控制台（浏览器 / 桌面 / NAS 共用）
├── discovery/            # 设备发现：UDP 广播 / mDNS / 配对 / 邀请码
├── security/             # 加密 / 防火墙 / 自签证书
├── database/             # sql.js 数据访问层 + schema
├── shared/               # 常量 / 工具
├── scripts/copy-vendor.js
├── test/smoke.js         # 后端引擎冒烟测试（纯 Node）
└── package.json
```

## 运行与构建

```bash
# 1. 安装依赖（会自动执行 postinstall 把 vue.global.js 拷到 renderer/vendor）
npm install

# 2. 开发模式启动桌面客户端
npm start

# 3. 仅启动引擎（无任何界面，等价于局域网文件服务）
npm run server

# 4. 运行后端冒烟测试（引擎 17 项 + 会话 10 项）
npm test
node test/chat.test.js   # 仅会话模块

# 5. 打包
npm run dist:win     # Windows NSIS 安装包
npm run dist:mac     # macOS dmg（需在 macOS 上执行）
npm run dist         # 按当前平台打包
```

### macOS dmg 构建（三种方式）

1. **GitHub Actions 云端构建（推荐，零环境成本）**：仓库已带 `.github/workflows/build-mac.yml`——推送到 GitHub 后在 Actions 页手动触发，或推送 `v*` 标签自动构建，产出 x64 + arm64 双架构 dmg（未签名，需右键打开或允许"任何来源"）。
2. **WSL2 + OSX-KVM 本地虚拟机**：在 WSL2 中启用嵌套虚拟化（`/dev/kvm`），按 kholia/OSX-KVM 安装 macOS，装 Node 20 + Xcode CLT 后执行 `npx electron-builder --mac`。
3. **真实 Mac**：克隆仓库后 `npm install && npm run dist:mac`。

> 注意：electron-builder 只需要 **Xcode Command Line Tools**（`xcode-select --install`，约 1.5GB），无需完整 Xcode。未签名 dmg 首次打开需右键 → 打开。

### 飞牛 fnOS（fpk 应用包）

```bash
# 1. 一键准备 target（同步源码 + 安装生产依赖）
node scripts/build-fpk.js

# 2. 打包（fnpack 下载地址 https://developer.fnnas.com/docs/cli/fnpack，
#    Windows 版重命名为 fnpack.exe 放入 tools/）
cd fnos-app && ../tools/fnpack.exe build
# 产出 LanFileShare.fpk，在飞牛「应用中心 → 手动安装」导入
```

NAS 端说明：
- NAS 作为**常驻中心节点**，桌面端 / 手机浏览器访问 `http://NAS-IP:18180` 即可使用全部功能（含会话）；
- 运行时依赖 `nodejs_v22`（manifest 已声明 `install_dep_apps`），首次安装会自动装运行时；
- 会话接收的文件落在共享目录 `lanfileshare/received`，可在文件管理器中直接管理；
- 环境变量约定：`LFS_PORT`（端口）、`LFS_DATA_DIR`（数据目录）、`LFS_CHAT_FILES`（会话文件目录）。

> **打包说明（Windows）**：`build.win` 已设置 `signAndEditExecutable: false`，跳过 Authenticode 代码签名与图标注入（即产物使用 Electron 默认图标、不做签名）。原因：本机沙箱环境无法创建 `winCodeSign` 工具包内的 darwin `.dylib` 符号链接，而 rcedit 图标注入依赖该工具链；跳过它即可正常产出安装包。若需在可签名环境打包带自定义图标的安装包，删去该选项并自备代码签名证书即可。产物位于 `dist/`：`* Setup *.exe`（安装包）与可解包目录 `win-unpacked`（便携离线版，可直接压缩分发）。

## 使用流程

1. 打开客户端，在「共享」页选择要分享的文件夹，可设权限与密码；
2. 复制链接或扫码，把链接发给同一局域网的同事 / 手机；
3. 对方浏览器打开即看到文件，可预览、下载、批量打包、上传；
4. 在「设备」页能看到彼此，可信任 / 拉黑 / Ping / 手动连接；
5. 在「设置」页调整发现方式、自启动、最小化到托盘、查看本机 RSA 指纹。

## 安全说明

- 所有密钥、主密钥、密码均仅存储在本机数据库（`data/app.db`，sql.js 落盘文件），不上传任何服务器。
- 传输默认 HTTP（局域网内低延迟）；如本机具备 `openssl`，可开关 HTTPS 自签证书（自动回退）。
- 建议仅在可信局域网内共享；对外暴露请配合 VPN / 反向代理。

## 已知边界（MVP 范围）

- 跨网段 / 跨公网需自行组网（VPN / 内网穿透），本 MVP 聚焦同局域网；
- HTTPS 自签证书为可选增强，默认回退 HTTP；
- macOS 安装包需在 macOS 上构建（或用 CI），Windows 无法交叉产出 dmg；
- 音视频通话基于 WebRTC 网状（mesh），适合 2–6 人小规模通话；更大规模需 SFU（后续阶段）。

---

参赛信息：WorkBuddy「1024 造物挑战」· 局域网文件共享平台桌面客户端
