# LanFileShare 开放协议 v1

> 本文档描述局域网文件共享平台的设备发现与投送协议。任何第三方可实现本协议与本工具互通。
> 设计原则：无云端、无账号、单方可为服务端、多通道发现互相兜底。

## 1. 默认配置

| 项 | 默认值 | 说明 |
|---|---|---|
| HTTP 端口 | 8080（可配置） | 文件服务 / API |
| UDP 端口 | 9527（冲突时 9527-9537 自动重试） | 发现心跳，与广播/组播共用 |
| 广播 | 各网卡广播地址 | 传统通道 |
| 组播组 | 224.0.0.167 | 借鉴 LocalSend：选 224.0.0.0/24 段兼容部分 Android |
| 心跳间隔 | 3 秒 | 离线判定默认 10 秒 |

## 2. 设备发现

心跳为 JSON over UDP（广播 + 组播双发）：

```json
{
  "protocol": "LanFileShare/1.0",
  "deviceId": "设备唯一ID",
  "deviceName": "显示名",
  "port": 8080,
  "os": "win32",
  "version": "1.10.0",
  "sharedCount": 2,
  "status": "online"
}
```

- 双通道冗余：广播跨路由/AP 隔离易丢包，组播互补；mDNS（`_lanfileshare._tcp`）第三通道。
- 实际端口以心跳 `port` 为准（端口冲突自动改时接收端无需额外配置）。
- v1.1 规划：`deviceType`（mobile/desktop/web/headless/server）、`alias` 自动友好别名、多播失败逐 IP HTTP 探测降级（LocalSend Legacy 模式）。

## 3. 快速投送（Quick Drop）会话协议

三段式：**清单先行 → 审批 → 传输**。发送端为 HTTP 客户端，接收端为 HTTP 服务端。

### 3.1 prepare —— 元数据先行

`POST /api/drop/prepare`

```json
{ "from": "发送端名", "text": false, "files": [{ "name": "a.png", "size": 12345, "sha256": "…", "mime": "image/png" }] }
```

响应：
- `200 {sessionId, accepted: true}` —— 接收端开启自动接受；
- `202 {sessionId, pending: true}` —— 需对端确认（接收端 UI 弹窗，WebSocket `drop.request` 事件）；
- `401 {error: "pin_required" | "bad_pin"}` —— 接收端启用 PIN（`?pin=` 携带）。

### 3.2 审批轮询与决定

- 发送端轮询：`GET /api/drop/session?sessionId=` → `{status: "pending"|"accepted"|"declined"|"expired"}`
- 接收端决定：`POST /api/drop/decision` `{sessionId, accept: true|false}`（会话 90 秒过期）

### 3.3 传输

- 整文件（小文件）：`POST /api/drop?from=&sessionId=&sha256=&mtime=<ms>`，multipart 字段 `file`
- 分块（大文件断点续传）：`POST /api/drop/chunk?uploadId=&index=&sessionId=`（二进制 body）；`GET /api/drop/chunk/status?uploadId=` 查已收分块；`POST /api/drop/finish` `{uploadId, name, total, size, sha256?, mtime?}` 合并
- 剪贴板文本：`POST /api/drop`（JSON `{text, from}`）

### 3.4 校验与错误码

| 码 | 含义 |
|---|---|
| 401 | 需要 PIN / 缺已批准会话（`approval_required`） |
| 403 | 对方已拒绝（`declined`） |
| 404 | 会话不存在/过期 |
| 409 | 分块不全（`incomplete`，返回 have/total 支持续传） |
| 422 | sha256 不符（`checksum_mismatch`）或大小偏差超限（`size_mismatch`），接收端删除残留 |

约定：sha256 小文件（≤64MB）由发送端计算；分块合并后接收端整体校验；mtime 随传输还原文件时间戳。

## 4. 跨网段会合点（Rendezvous Hub，v1.1 实装）

同光猫下多路由器不同网段（双 NAT）场景：广播/组播不跨网段、对端 NAT 拦截入站。
方案：在跨网段可达的设备（光猫层 NAS/fpk 服务端）上启用 Hub，各网段设备**出站**注册与拉取——NAT 只拦入站，出站必然可达，全程无需穿透。

- `POST /api/hub/register` `{deviceId, deviceName, port, os, version}` → `{peers: [其他网段设备], incoming: [待收中继清单], hub}`
- `POST /api/hub/relay?target=<deviceId>&from=&sha256=&mtime=` multipart → 中心暂存（≤2GB/文件，24h TTL）
- `GET /api/hub/relay/:id?token=&deviceId=` 接收方拉取（一次性，取后即删，sha256 校验）
- 客户端 5s 轮询；发现的对端注入设备表并标记 `relay=true`（界面走中继路由）
- 前置配置：所有端「设置 → 跨网段会合点」填 Hub 地址（如 `192.168.10.5:8080`）

## 5. 兼容性

- 未带 `sessionId` 且接收端开启自动接受 → 视为隐式批准（兼容旧发送端）；
- 旧客户端直接 POST `/api/drop` 在自动接受模式下不受影响；自动接受关闭后旧客户端会收到 401，需升级。

## 6. 路线图（对齐竞品调研报告 docs/research-localsend-spacedesk.md）

- v1.2：与 LocalSend 协议互通网关（映射到 /api/localsend/v2/*）
- 远期：跨设备剪贴板增强、屏幕/输入扩展（借鉴 spacedesk，需立项评估）
