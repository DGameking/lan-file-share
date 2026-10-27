# 局域网文件共享平台 · 桌面客户端

> 参加 WorkBuddy「1024 造物挑战」程序员节应用创作大赛的参赛作品。
> 基于 PRD《局域网文件共享平台》实现的跨平台桌面客户端（MVP）。

## 一句话介绍

一台电脑，一键把任意文件夹共享到局域网；同网内的手机、平板、其他电脑，用浏览器扫码即开即看、即点即下，无需安装、无需注册、端到端加密可控。

## 下载（各平台 · 双架构）

| 平台 | 文件 | 架构 |
|---|---|---|
| Windows 安装包 | `LanFileShare-Setup-x.y.z-x64.exe` / `LanFileShare-Setup-x.y.z-arm64.exe` | x64 / ARM64 |
| Windows 便携包 | `LanFileShare-Portable-x.y.z-x64.zip` / `LanFileShare-Portable-x.y.z-arm64.zip` | x64 / ARM64 |
| macOS 安装 | `LanFileShare-x.y.z-x64.dmg` / `LanFileShare-x.y.z-arm64.dmg` | Intel / Apple Silicon |
| macOS 便携 | `LanFileShare-x.y.z-x64.zip` / `LanFileShare-x.y.z-arm64.zip` | Intel / Apple Silicon |
| Linux | `LanFileShare-x.y.z-x64.AppImage` / `LanFileShare-x.y.z-arm64.AppImage` | x64 / ARM64 |
| 飞牛 fnOS | `LanFileShare.fpk` | 单包通用 |

前往 [Releases](https://github.com/DGameking/lan-file-share/releases) 下载。

## ⚠️ macOS 首次打开提示“恶意软件 / 无法验证”怎么办？

这是 macOS Gatekeeper 的安全机制：本应用**未经 Apple 公证**（公证需要 Apple 开发者账号，99 美元/年）。应用本身没有安全问题，按下面任一方法放行即可：

- **方法一（推荐）**：双击打开提示“无法验证”后，打开 **系统设置 → 隐私与安全性**，下拉到安全提示处点 **“仍要打开”**；
- **方法二**：右键点击 App → **打开** → 再点 **打开**（仅首次需要）；
- **方法三（命令行）**：`xattr -cr /Applications/局域网文件共享.app`，之后正常双击打开。

### 提示「已阻止使用恶意软件并移到废纸篓」？

macOS 15+ 对未签名应用更严格，可能直接把 App 扔进废纸篓（且右键打开的入口被移除）。恢复步骤：

1. 从废纸篓把 `局域网文件共享.app` 拖回「应用程序」文件夹（或重新解压 dmg/zip）；
2. **先不要双击打开**，打开「终端」执行：`xattr -cr /Applications/局域网文件共享.app`（清除隔离标记）；
3. 再双击打开。若仍被拦，去 **系统设置 → 隐私与安全性 → 安全性** 找到提示点 **“仍要打开”**。

> 正规化路线：后续若申请 Apple Developer ID 并配置 GitHub Actions 密钥公证（notarytool），安装包将不再触发该提示。

## ⚠️ Windows 杀毒软件报毒 / SmartScreen 提示怎么办？

本应用**未做代码签名**（个人开发者签名证书费用较高），部分杀软对无签名程序的启发式引擎会误报。应用源码全部开源可查证，处理方法：

- **校验文件完整性**：每个 Release 附带 `SHA256SUMS.txt`，用 `certutil -hashfile 文件名 SHA256`（Windows）比对，一致即为原始构建产物；
- **加入白名单**：Windows 安全中心 → 病毒和威胁防护 → 保护历史记录 → 允许；第三方杀软在隔离恢复中添加信任；
- **提交误报**（帮助所有用户，1-3 天即可全球放行）：
  - [微软误报提交](https://www.microsoft.com/en-us/wdsi/filesubmission)
  - [360 误报提交](https://fubao.360.cn/) / [腾讯误报提交](https://bbs.qcloud.com/)
- **根治方案**：购买代码签名证书（OV 约 ¥600-1500/年，EV 可免 SmartScreen 名声期），我可以直接接入 GitHub Actions 自动签名。

## 📱 手机 / 平板怎么用（Android / iOS）

三种方式，按需选择：

1. **浏览器直开（全平台通用）**：手机浏览器打开 `http://服务IP:端口/chat` 即可：聊天、发文件、图片视频预览、音视频通话全功能可用，并可从根页或管理控制台扫码直达。
2. **Android App（v1.9.8 起）**：下载 Release 里的 `LanFileShare-<版本>-android.apk` 安装（系统会提示"未知来源"，允许即可）。打开后填一次服务器地址（如 `http://192.168.1.20:8080`），连接记忆在本地，之后点开即进会话。
3. **PWA 添加到主屏幕（iOS 推荐）**：
   - **iOS（Safari）**：打开 `/chat` → 分享 → **"添加到主屏幕"**，全屏 App 化使用（页面内会有一次性安装引导）；
   - **Android（Chrome/Edge）**：菜单 → **"添加到主屏幕"**。

> iOS 原生 App 上架 App Store 需要 Apple 开发者账号（$99/年）+ macOS 签名环境；PWA 是当前 iOS 的完整形态。`mobile/` 目录为 Capacitor 工程，iOS 壳可在具备条件时用 `npx cap add ios` 生成。

## 核心特性（对齐 PRD）

- **一键共享**：选择文件夹即可生成可访问链接与二维码，支持只读 / 可写 / 管理三种权限。
- **快速投送（1.5.0 新增）**：LocalSend 式体验 —— 桌面端「投送」页把文件**一拖一放**到设备卡片即直接发送，实时进度条，对方立即收到并弹窗提示；也支持一键投送剪贴板文本。**大文件（>16MB）自动分块（8MB/块）上传，失败重试、断点续传（1.6.0）**。接收文件存入数据目录 `received` 文件夹。
- **快捷投送入口（1.6.0 新增）**：托盘菜单「快速投送」或全局快捷键 `Alt+Shift+D` 直达投送页（Windows 系统限制：托盘图标本身无法接收文件拖放，故以快捷键直达替代）。
- **屏幕共享（1.6.0 新增）**：会话页一键发起屏幕共享，其他成员实时观看（WebRTC P2P 直连；需在设置中开启 HTTPS，浏览器安全策略要求）。
- **HTTPS 加密传输（1.6.0 新增）**：设置一键开关（自签证书，重启生效），传输全程加密，且为屏幕共享 / PWA 提供安全上下文。
- **PWA（1.6.0 新增）**：手机浏览器可“添加到主屏幕”当 App 用（需 HTTPS）。
- **跨设备剪贴板同步（1.5.0 新增）**：桌面客户端之间复制即同步 —— 本机复制，其他设备剪贴板自动更新并弹窗提示（可在设置中关闭）。
- **跨设备统一会话（1.5.0 增强 / 1.7.0 修复）**：会话桥（Session Bridge）让局域网内所有运行本程序的设备**自动联邦进同一个会话** —— 任一设备上的消息实时出现在所有设备的会话框中，成员列表聚合全部设备（含浏览器访客），聊天记录全端一致；**跨设备文件经本机同源代理下载（1.7.0）**，修复跨源下载失效 / HTTPS 混合内容拦截 / 对端换 IP 后历史链接失效的问题。
- **跨设备共享目录 + 磁盘挂载（1.9.0 新增）**：其他设备共享的文件夹自动出现在本机「共享」页（实时刷新）；一键**挂载为本机磁盘**（WebDAV / Windows 网络盘符）——在对方电脑把 D 盘、E 盘等盘符根目录添加为共享，本机即可像本地硬盘一样直接访问。
- **运行日志 + 一键自诊断（1.7.0 新增）**：关键链路日志按天落盘（保留 7 天），管理控制台「诊断」页可实时查看；「一键自检与修复」检查数据目录 / 数据库 / 发现服务 / 会话桥 / 接收目录 / 磁盘等 12 项子系统，可修复项自动处理（重建目录、重启 UDP）；桌面端设置页同样入口；主进程 / 渲染进程崩溃自动记入日志。
- **自动检查更新（1.8.0 新增）**：桌面端「设置 → 更新」手动或自动（每天一次）检查 GitHub 最新版本，发现新版本仅在概览页/管理控制台轻提示，不打扰使用；点击直达下载页。
- **服务器模式（1.8.0 新增）**：设置页一键开启 —— 启动时不弹主界面，共享服务在后台持续运行（托盘驻留 + 系统通知），把本机变成局域网文件服务器；配合开机自启动，设备开机即自动提供共享与会话服务；服务地址一键复制、直达管理控制台。会话中的文件由发送方设备点对点提供下载。
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

### macOS / Linux 构建（GitHub Actions 云端，推荐）

仓库已带 `.github/workflows/build-mac.yml`（build-desktop）：
- **macOS**：macos-14 runner 产出 **x64 + arm64** 双架构 dmg 与 .app zip（未签名，首次打开需右键 → 打开）；
- **Linux**：ubuntu runner 产出 **x64 + arm64** 双架构 AppImage；
- **推送 `v*` 标签自动创建 GitHub Release**，mac / Linux 产物自动挂到 Release 供下载（Windows 安装包与 fpk 由本地构建后 `gh release upload` 补挂）。

本机构建替代方案：真实 Mac 上 `npm run dist:mac`；WSL2 + OSX-KVM 虚拟机亦可。

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

> **打包说明**：应用已内置自绘 Logo（`build/icon.ico / icon.icns`，exe 图标由 rcedit 注入、托盘图标 `main/assets/tray.png`）。Windows 本地沙箱打包需预置 winCodeSign 缓存（见 scripts 注释）；Linux AppImage 依赖符号链接，建议走 GitHub Actions。产物命名均带架构后缀：`-x64` / `-arm64`。

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
