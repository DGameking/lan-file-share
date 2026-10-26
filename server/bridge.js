'use strict';

const WebSocket = require('ws');

/**
 * 会话桥（Session Bridge）：
 * 让局域网内所有运行本程序的设备自动加入同一个会话。
 *
 * 工作方式：
 * - 每台设备都运行自己的 HTTP/WS 服务；发现对端在线后，设备 ID 较小的一端
 *   主动向对端 WS 发起「桥接」连接（避免双向重复通道）。
 * - 本机产生的会话事件（消息 / 成员 / 输入状态 / 撤回 / 剪贴板）通过桥发送给对端；
 *   对端只在本机内分发，不再转发 —— 全网状拓扑下天然无环路。
 * - 远端成员列表聚合进本机成员列表（ID 加设备前缀），实现「发现即入会」。
 */
class BridgeManager {
  constructor(engine) {
    this.engine = engine;
    /** @type {Map<String, WebSocket>} 对端 deviceId -> 本机主动发起的桥连接 */
    this.outbound = new Map();
    /** @type {Map<WebSocket, {deviceId:String,deviceName:String,host:String,port:Number}>} 对端主动连入的桥 */
    this.inbound = new Map();
    /** @type {Map<String, Array>} 远端成员表：origin deviceId -> members[] */
    this.remoteMembers = new Map();
    /** @type {Map<String, {host:String,port:Number}>} 对端地址信息（用于文件直链改写） */
    this.peerInfo = new Map();
    this._retry = new Map();
    this._destroyed = false;
  }

  /* ---------------- 生命周期 ---------------- */

  peerOnline(d) {
    if (!d || !d.device_id || d.device_id === this.engine.deviceId) return;
    this.peerInfo.set(d.device_id, { host: d.host, port: d.port });
    if (d.is_blacklisted) return;
    this._scheduleConnect(d, 600);
  }

  peerOffline(id) {
    const ws = this.outbound.get(id);
    if (ws) {
      try { ws.close(); } catch (e) {}
      this.outbound.delete(id);
    }
    for (const [s, info] of [...this.inbound]) {
      if (info.deviceId === id) {
        this.inbound.delete(s);
        try { s.close(); } catch (e) {}
      }
    }
    if (this.remoteMembers.delete(id)) this._refreshLocalMembers();
  }

  stop() {
    this._destroyed = true;
    for (const t of this._retry.values()) clearTimeout(t);
    this._retry.clear();
    for (const ws of this.outbound.values()) { try { ws.close(); } catch (e) {} }
    for (const ws of this.inbound.keys()) { try { ws.close(); } catch (e) {} }
    this.outbound.clear();
    this.inbound.clear();
    this.remoteMembers.clear();
  }

  /* ---------------- 连接管理 ---------------- */

  _scheduleConnect(d, delay) {
    // 约定：只有 deviceId 较小的一端主动发起，保证每对设备间只有一条通道
    if (String(this.engine.deviceId) >= String(d.device_id)) return;
    if (this.outbound.has(d.device_id) || this._retry.has(d.device_id)) return;
    const t = setTimeout(() => {
      this._retry.delete(d.device_id);
      if (!this._destroyed) this._connect(d);
    }, delay);
    this._retry.set(d.device_id, t);
  }

  _connect(d) {
    if (this._destroyed || d.is_blacklisted) return;
    const id = d.device_id;
    if (this.outbound.has(id)) return;
    const live = this.engine.deviceManager.get(id);
    if (!live || !live.is_online) return;

    let ws;
    try {
      ws = new WebSocket(`ws://${d.host}:${d.port}`, { handshakeTimeout: 4000 });
    } catch (e) {
      return this._scheduleConnect(d, 8000);
    }
    ws._bridgeDir = 'out';
    ws.on('open', () => {
      this.outbound.set(id, ws);
      this._send(ws, {
        type: 'bridge.hello',
        deviceId: this.engine.deviceId,
        deviceName: this.engine.deviceName,
        host: this.engine.localIp,
        port: this.engine.httpPort,
      });
      // 把本机当前成员列表同步给对方
      if (this.engine.chat) this.engine.chat.relayMembersTo(ws);
    });
    ws.on('message', (raw) => this._onData(ws, raw));
    ws.on('close', () => {
      if (this.outbound.get(id) === ws) this.outbound.delete(id);
      if (!this._destroyed) this._scheduleConnect(d, 8000);
    });
    ws.on('error', () => { /* close 会跟随触发 */ });
  }

  _onData(ws, raw) {
    let msg;
    if (typeof raw === 'string') {
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        return;
      }
    } else {
      msg = raw;
    }
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'bridge.hello') {
      const info = {
        deviceId: String(msg.deviceId || '').slice(0, 64),
        deviceName: String(msg.deviceName || '未知设备').slice(0, 60),
        host: String(msg.host || '').slice(0, 64),
        port: Number(msg.port) || 0,
      };
      if (!info.deviceId || info.deviceId === this.engine.deviceId) return false;

      if (ws._bridgeDir === 'out' || this.outbound.has(info.deviceId)) {
        // 是我方主动连接的对端在回应 —— 只记录地址信息，不重复登记
        this.peerInfo.set(info.deviceId, { host: info.host, port: info.port });
        return true;
      }
      // 对端主动连入
      this.inbound.set(ws, info);
      this.peerInfo.set(info.deviceId, { host: info.host, port: info.port });
      ws.on('close', () => {
        this.inbound.delete(ws);
        if (this.remoteMembers.delete(info.deviceId)) this._refreshLocalMembers();
      });
      // 同步本机成员给对方
      if (this.engine.chat) this.engine.chat.relayMembersTo(ws);
      return true;
    }

    if (msg.type === 'bridge.event') {
      const origin = String(msg.origin || '');
      if (!origin || origin === this.engine.deviceId) return false;
      const event = String(msg.event || '');
      // 只在本机内分发，绝不转发（无环）
      if (this.engine.chat && ['chat.msg', 'chat.members', 'chat.typing', 'chat.recall', 'clip.sync'].includes(event)) {
        this.engine.chat.deliverRemote(event, msg.payload, origin);
        return true;
      }
      return true;
    }
    return false;
  }

  /* ---------------- 事件发送 ---------------- */

  /** 将本机事件转发给所有已桥接的对端 */
  relay(event, payload) {
    const msg = JSON.stringify({ type: 'bridge.event', event, payload, origin: this.engine.deviceId });
    for (const ws of this.outbound.values()) this._send(ws, msg);
    for (const ws of this.inbound.keys()) this._send(ws, msg);
  }

  _send(ws, data) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } catch (e) {}
  }

  /* ---------------- 远端成员聚合 ---------------- */

  setRemoteMembers(origin, list) {
    if (!Array.isArray(list)) return;
    const tag = String(origin).slice(0, 8);
    this.remoteMembers.set(
      origin,
      list
        .filter((m) => m && m.id)
        .map((m) => ({
          id: `${m.id}@${tag}`,
          name: String(m.name || '未知设备').slice(0, 40),
          kind: m.kind === 'desktop' ? 'desktop' : 'web',
          deviceId: m.deviceId || null,
          remote: true,
        }))
    );
    this._refreshLocalMembers();
  }

  remoteMemberList() {
    const all = [];
    for (const list of this.remoteMembers.values()) all.push(...list);
    return all;
  }

  peerInfoOf(deviceId) {
    return this.peerInfo.get(deviceId) || null;
  }

  _refreshLocalMembers() {
    if (this.engine.chat) this.engine.chat.refreshMembers();
  }
}

module.exports = BridgeManager;
