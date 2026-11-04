# 业务逻辑全面梳理与重构报告（2026-11-04）

> 范围：lan-file-share 全仓库（服务端引擎 / 发现层 / 桌面主进程 / 渲染层 / Web 页面 / 数据库）
> 基线：v1.21.0（12 个版本迭代后首次全局架构梳理）
> 本轮已落地：服务端核心重构（R1-R6）+ 健壮性修复，183 项回归全绿

---

## 一、业务全景图（模块职责地图）

```
┌─ 桌面客户端（Electron）──────────────────────────┐
│ main/index.js    窗口/托盘/IPC(20个)/通知/剪贴板同步 │
│ renderer/app.js  Vue 组件 ×8 + store + API 封装    │
└──────────────┬───────────────────────────────────┘
               │ IPC / HTTP(对端设备)
┌──────────────▼─ 核心引擎 server/index.js ─────────┐
│ LanFileShare 类：身份/设置/共享/设备/更新/统计/门户页 │
│                                                    │
│ ├ 静态资源：admin.js(/admin) api.js(/api)           │
│ ├ 会话：chat.js(WS) bridge.js(跨设备联邦)           │
│ ├ 投送：drop.js(审批会话) hub.js(会合点中继)         │
│ ├ 互通：localsend.js(协议v2网关)                    │
│ ├ 文件：handlers/{upload,download,browse,zip,webdav}│
│ └ 发现：udp-broadcast / mdns / ip-scan / upnp /     │
│         rendezvous / pairing / device-manager       │
└──────────────┬───────────────────────────────────┘
               │
        database/（sql.js + _migrate 轻量迁移）
```

**单一管理台说明**：管理台只有一份实现（`server/static/admin.html`），桌面/手机/会话页/门户页的"管理台"全部只是指向 `/admin` 的入口链接；飞牛端是纯服务端，桌面图标 iframe 内嵌门户页，从门户可达管理台。无功能重合。

## 二、发现的问题（按严重度）

### P0 正确性缺陷（本轮已修）

| # | 问题 | 影响 | 修复 |
|---|------|------|------|
| 1 | **设备操作 WS 双重广播**：deviceManager 每次 setX 内部 emit('update') → 引擎订阅广播；而 trust/blacklist/star/alias/connectManual/_onPeer 六处又手动 broadcast 一次 | 每次设备操作/心跳 upsert，所有 WS 客户端收到两份 devices 事件 → 前端重复渲染、通知中心重复处理 | 删除全部 6 处手动广播，广播统一由 'update' 事件出口 |
| 2 | **LocalSend 网关端口冲突即瘫痪**：53317 被占（同机多实例/用户正在运行正式客户端）时网关直接置 null，互通全失效 | 同机装两个版本时新实例互通消失（本次回归时真实触发：用户正开着 v1.21.0 客户端） | EADDRINUSE 自动让位递增（最多+6），组播 announce 携带实际端口，官方客户端仍可发现 |

### P1 结构性问题（本轮已收敛）

| # | 问题 | 修复 |
|---|------|------|
| 3 | **身份字段三处重复构造**：deviceType 推断、wanPort 提取在 buildHeartbeat/selfInfo/mdns.publish 各写一遍，口径漂移风险 | 提取 `_inferredDeviceType()` / `_wanTcpPort()` 单一来源 |
| 4 | **mDNS 广播元数据缺失**：TXT 记录不带 deviceType/alias，纯 mDNS 发现路径设备卡显示类型/别名丢失 | TXT 补发 deviceType/alias，browse 解析侧同步接收 |
| 5 | **设备操作样板 ×5**：`deviceManager.setX + db.setX + broadcast` 粘贴五遍 | 收敛为 `_applyDeviceUpdate(id, change)` 统一入口，公开方法名不变 |
| 6 | **设置副作用散落 if 链**：updateSettings 内联副作用逻辑，https 切换分支还重复广播一次 settings | 抽出 `_applySettingsEffects(patch, before)` 管线；广播统一一处 |
| 7 | **shares 内存 Map 与 DB 双源**：Map 只在引擎内做计数用，但 add/update/remove 要手工同步三处，漂移隐患 | 删除 Map，DB 单源（listShares 本就直查 DB） |
| 8 | **门户页 60 行内嵌 HTML/CSS 混在引擎类里** | 外置 `server/static/portal.html` 模板 + 运行时占位符替换（与 share.html 同模式） |

### P2 待办（下轮 v1.22）

| # | 问题 | 建议 |
|---|------|------|
| 9 | **renderer/app.js 1503 行单文件**：8 个 Vue 组件 + store + API 封装挤在一个 IIFE | 拆 `renderer/js/{core,components/*.js}`，script 顺序加载（无构建链）；需专门一轮+UI 冒烟 |
| 10 | **chat.html 1240 行单文件** | 单文件自包含是有意设计（无构建、离线可用），暂保持；若继续膨胀再抽 chat-core.js |
| 11 | **main/index.js 604 行**：20 个 IPC handler + WebDAV + 剪贴板 + 通知混排 | 拆 main/ipc-{devices,drop,update}.js |
| 12 | **database._migrate 吞错**：try/catch 静默，列迁移失败无感知 | 至少 console.warn；建议失败时拒绝启动（数据完整性优先） |
| 13 | **api.js 路由错误处理不一致**：部分 try/catch 部分裸奔 | 统一 asyncRoute 包装器 + 全局错误中间件兜底（已有，但 4xx 类应显式） |
| 14 | **仓库残渣**：tmp-f16-test/tmp-f20-*/tmp-t2~t4/tmp-webadmin 测试沙箱目录 | 已清理 |
| 15 | **心跳 upsert 高频双写**：每 3s 心跳 ×N 设备都写 DB（upsertDevice + setDeviceOnline） | 可加 1s 合并写；当前量级（<20 设备）无压力，观察后决定 |

## 三、本轮改动清单

- `server/index.js`：-70 行（双广播/样板收敛/Map 移除/门户页外置），净简化
- `server/localsend.js`：端口冲突自动降级（+16 行）
- `discovery/mdns.js`：TXT 补 deviceType/alias（收发两侧）
- `server/static/portal.html`：新增（自 index.js 外置）
- `test/f19-e2e.js`：端口断言兼容降级场景

**验证**：smoke 17 + chat 10 + drop 20 + hub 16 + f13 15 + f14 8 + f16 9 + f17 10 + f18 13 + f19 17 + f20 19 + f21 22 = **176 项全绿**。

## 四、健康度评价

- 分层本身清晰（引擎纯 Node 可独立跑、发现/传输/会话分模块、DB 有迁移机制），"乱"主要体现在**增量粘贴的样板**（本轮已清）与**前端单文件**（下轮拆）。
- 测试是本仓库最大资产：13 套 176 项 e2e 让本次结构性重构零风险落地——保持"重构必配回归"的纪律。
