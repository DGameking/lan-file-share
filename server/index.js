'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const express = require('express');
const WebSocket = require('ws');

const DB = require('../database');
const crypto = require('../security/crypto');
const { findAvailablePort, pingHost } = require('../security/firewall');
const {
  PROTOCOL,
  UDP_PORT_RANGE,
  DEFAULT_HTTP_PORT,
  getPrimaryIP,
} = require('../shared/constants');
const { shortId } = require('../shared/utils');
const DeviceManager = require('../discovery/device-manager');
const UdpDiscovery = require('../discovery/udp-broadcast');
const MdnsDiscovery = require('../discovery/mdns');
const PairingManager = require('../discovery/pairing');
const { createInvite, resolveInvite } = require('../discovery/invite-code');

const { registerApi } = require('./api');
const ChatManager = require('./chat');
const browseHandler = require('./handlers/browse');
const downloadHandler = require('./handlers/download');
const uploadHandler = require('./handlers/upload');
const webdavHandler = require('./handlers/webdav');
const zipHandler = require('./handlers/zip');

const OS_MAP = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/**
 * 局域网文件共享平台核心引擎。
 * 不依赖 Electron，可在纯 Node 环境下独立运行（用于测试 / 无界面服务模式）。
 */
class LanFileShare extends require('events').EventEmitter {
  constructor(opts = {}) {
    super();
    this.httpPort = opts.httpPort || DEFAULT_HTTP_PORT;
    this.dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
    this.dbPath = opts.dbPath || path.join(this.dataDir, 'app.db');
    this.deviceName = opts.deviceName || os.hostname();
    this.osType = opts.osType || OS_MAP[process.platform] || 'Unknown';
    this.version = opts.version || '1.0.0';
    this.useHttps = !!opts.https;

    this.masterKey = null;
    this.deviceId = null;
    this.keyPair = null;
    this.fingerprint = null;

    this.shares = new Map();
    this.deviceManager = new DeviceManager();
    this.pairing = new PairingManager();
    this.app = null;
    this.server = null;
    this.wss = null;
    this.udp = null;
    this.mdns = null;
    this.localIp = '127.0.0.1';
    this.udpPort = null;

    this.traffic = { up: 0, down: 0 };
    this._cumulative = { up: 0, down: 0 };
    this._speed = { up: 0, down: 0 };
    this._prev = { up: 0, down: 0 };
    this._sharePageHtml = '';

    // 绑定会被 handler 解构后独立调用的方法，避免 this 丢失
    this.logEvent = this.logEvent.bind(this);
    this.clientIp = this.clientIp.bind(this);
    this.getShare = this.getShare.bind(this);
  }

  async init() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    this.db = await DB.create(this.dbPath);

    // 主密钥
    let mk = this.db.getConfig('master_key');
    if (!mk) {
      mk = crypto.generateMasterKey();
      this.db.setConfig('master_key', mk);
    }
    this.masterKey = mk;

    // 设备 ID
    let did = this.db.getConfig('device_id');
    if (!did) {
      did = crypto.generateDeviceId();
      this.db.setConfig('device_id', did);
    }
    this.deviceId = did;

    // RSA 密钥对
    let priv = this.db.getConfig('rsa_private');
    let pub = this.db.getConfig('rsa_public');
    if (!priv || !pub) {
      const kp = crypto.generateRSAKeyPair();
      priv = kp.privateKey;
      pub = kp.publicKey;
      this.db.setConfig('rsa_private', priv);
      this.db.setConfig('rsa_public', pub);
    }
    this.keyPair = { publicKey: pub, privateKey: priv };
    this.fingerprint = crypto.fingerprint(pub);

    // 设置
    this.settings =
      JSON.parse(this.db.getConfig('settings') || 'null') ||
      {
        deviceName: this.deviceName,
        theme: 'system',
        language: 'zh',
        httpPort: this.httpPort,
        heartbeatInterval: 3,
        offlineTimeout: 10,
        mdns: true,
        udp: true,
        allowBeDiscovered: true,
        hiddenMode: false,
        onlyTrustedVisible: false,
        firstConnectConfirm: true,
        autoTrust: false,
        startup: false,
        minimizeToTray: true,
        speedLimitUpload: 0,
        speedLimitDownload: 0,
        defaultPermission: 'read',
        defaultEncrypt: false,
      };
    this.deviceName = this.settings.deviceName || this.deviceName;

    // 恢复共享与设备
    for (const r of this.db.listShares()) this.shares.set(r.id, r);
    this.deviceManager.hydrate(this.db.listDevices());

    // 共享页面模板
    try {
      this._sharePageHtml = fs.readFileSync(path.join(__dirname, 'static', 'share.html'), 'utf8');
    } catch (e) {
      this._sharePageHtml = '<h1>共享页面模板缺失</h1>';
    }

    this._wireDeviceManager();
    this._buildApp();
    await this._startHttp();
    this._startDiscovery();

    // 速度采样
    this._speedTimer = setInterval(() => {
      this._speed = {
        up: this._cumulative.up - this._prev.up,
        down: this._cumulative.down - this._prev.down,
      };
      this._prev = { up: this._cumulative.up, down: this._cumulative.down };
    }, 1000);

    this.emit('ready');
    return this;
  }

  _wireDeviceManager() {
    this.deviceManager.on('online', (d) =>
      this.logEvent({ event_type: 'device_online', device_id: d.device_id, device_name: d.device_name, ip: d.host, result: 'success' })
    );
    this.deviceManager.on('offline', (d) => {
      this.logEvent({ event_type: 'device_offline', device_id: d.device_id, device_name: d.device_name, ip: d.host, result: 'success' });
      this.db.setDeviceOnline(d.device_id, false);
    });
    this.deviceManager.on('update', (list) => this.broadcast('devices', list));

    this.pairing.on('request', (d) => {
      this.broadcast('pairing-request', d);
      this.emit('pairing-request', d);
    });
  }

  _buildApp() {
    const app = express();
    this.app = app;
    app.use(express.json({ limit: '5mb' }));
    app.use(express.urlencoded({ extended: true, limit: '5mb' }));

    app.get('/', (req, res) => res.type('html').send(this._rootPageHtml()));

    registerApi(this);
    this.chat = new ChatManager(this);
    this.chat.register();
    browseHandler.register(this);
    downloadHandler.register(this);
    uploadHandler.register(this);
    webdavHandler.register(this);
    zipHandler.register(this);
  }

  async _startHttp() {
    const port = await findAvailablePort(this.httpPort, [this.httpPort, this.httpPort + 1, this.httpPort + 2]);
    this.httpPort = port;
    this.localIp = getPrimaryIP();

    let server;
    if (this.useHttps) {
      // 可选 HTTPS：自带自签名证书（需 openssl）；不可用时安全回退到 HTTP
      let cert = null;
      try {
        cert = require('../security/certificate').ensureSelfSignedCert(this.dataDir);
      } catch (e) {
        cert = null;
      }
      if (cert && cert.key && cert.cert) {
        server = https.createServer({ key: cert.key, cert: cert.cert }, this.app);
      } else {
        server = http.createServer(this.app);
      }
    } else {
      server = http.createServer(this.app);
    }
    this.server = server;

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    this.wss = new WebSocket.Server({ server: this.server });
    this.wss.on('connection', (ws) => {
      ws._socketIp = ws._socket ? ws._socket.remoteAddress : '';
      if (this.chat) this.chat.attach(ws);
      ws.send(JSON.stringify({ event: 'init', payload: this._snapshot() }));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._onWsMessage(ws, msg);
        } catch (e) {}
      });
    });
  }

  _onWsMessage(ws, msg) {
    if (this.chat && this.chat.onMessage(ws, msg)) return;
    if (msg.type === 'trust' && msg.deviceId) this.trustDevice(msg.deviceId, true);
    if (msg.type === 'blacklist' && msg.deviceId) this.blacklistDevice(msg.deviceId, true);
  }

  _startDiscovery() {
    const buildHeartbeat = () => ({
      protocol: PROTOCOL,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      host: this.localIp,
      port: this.httpPort,
      os: this.osType,
      version: this.version,
      sharedCount: this.enabledShareCount(),
      status: 'online',
    });

    if (this.settings.udp) {
      this.udp = new UdpDiscovery({ selfId: this.deviceId, interval: this.settings.heartbeatInterval || 3 });
      this.udp.on('device', (info) => this._onPeer(info));
      this.udp
        .start({ getHeartbeat: buildHeartbeat, portRange: UDP_PORT_RANGE })
        .then(() => {
          this.udpPort = this.udp.port;
          this.udp.startHeartbeat();
        })
        .catch((e) => this.emit('warn', 'UDP 发现启动失败: ' + e.message));
    }

    if (this.settings.mdns) {
      this.mdns = new MdnsDiscovery();
      this.mdns.on('device', (info) => this._onPeer(info));
      this.mdns.on('down', (id) => {
        const d = this.deviceManager.get(id);
        if (d) this.deviceManager.markOffline(id);
      });
      try {
        this.mdns.publish({
          name: this.deviceName,
          port: this.httpPort,
          deviceId: this.deviceId,
          os: this.osType,
          version: this.version,
          sharedCount: this.enabledShareCount(),
        });
        this.mdns.browse();
      } catch (e) {
        this.emit('warn', 'mDNS 启动失败: ' + e.message);
      }
    }

    this._pruneTimer = setInterval(
      () => this.deviceManager.prune((this.settings.offlineTimeout || 10) * 1000),
      3000
    );
  }

  _onPeer(info) {
    if (!info || info.deviceId === this.deviceId) return;
    const existing = this.deviceManager.get(info.deviceId);
    if (existing && existing.is_blacklisted) return;

    const dev = this.deviceManager.upsert(info);
    this.db.upsertDevice(dev);
    this.db.setDeviceOnline(info.deviceId, true);

    if (!dev.is_trusted && !dev.is_blacklisted && this.settings.firstConnectConfirm && !this.settings.autoTrust) {
      if (!this.pairing.isPending(info.deviceId)) {
        this.pairing.request(dev);
      }
    }
    this.broadcast('devices', this.deviceManager.list());
  }

  /* ---------------- 共享管理 ---------------- */
  _decorate(row) {
    return { ...row, enabled: !!row.enabled, hasPassword: !!row.password };
  }

  listShares() {
    return this.db.listShares().map((r) => this._decorate(r));
  }

  getShare(id) {
    const r = this.db.getShare(id);
    return r ? this._decorate(r) : null;
  }

  addShare(body = {}) {
    const p = path.resolve(body.path || '');
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('路径不存在或不是目录');
    if (this.db.getShareByPath(p)) throw new Error('该路径已经共享');
    const id = body.id || shortId();
    const pw = body.password ? crypto.aesEncrypt(body.password, this.masterKey) : null;
    const share = this.db.addShare({
      id,
      name: body.name || path.basename(p),
      path: p,
      permission: body.permission || this.settings.defaultPermission || 'read',
      password: pw,
      expire_at: body.expire_at || null,
      ip_whitelist: JSON.stringify(body.ip_whitelist || []),
      max_connections: body.max_connections || 10,
      speed_limit: body.speed_limit || 0,
      enabled: body.enabled != null ? (body.enabled ? 1 : 0) : 1,
    });
    this.shares.set(id, share);
    this.broadcast('shares', this.listShares());
    this.logEvent({ event_type: 'share_start', target: p, result: 'success' });
    this._refreshMdnsSharedCount();
    return this._decorate(share);
  }

  updateShare(id, patch = {}) {
    const existing = this.db.getShare(id);
    if (!existing) return null;
    const update = { ...existing };
    if (patch.name != null) update.name = patch.name;
    if (patch.permission != null) update.permission = patch.permission;
    if (patch.path != null && patch.path !== existing.path) {
      const np = path.resolve(patch.path);
      if (!fs.existsSync(np) || !fs.statSync(np).isDirectory()) throw new Error('路径不存在或不是目录');
      update.path = np;
    }
    if (patch.password !== undefined) {
      update.password = patch.password ? crypto.aesEncrypt(patch.password, this.masterKey) : null;
    }
    if (patch.expire_at !== undefined) update.expire_at = patch.expire_at || null;
    if (patch.ip_whitelist !== undefined) update.ip_whitelist = JSON.stringify(patch.ip_whitelist || []);
    if (patch.max_connections != null) update.max_connections = patch.max_connections;
    if (patch.speed_limit != null) update.speed_limit = patch.speed_limit;
    if (patch.enabled != null) update.enabled = patch.enabled ? 1 : 0;
    const saved = this.db.updateShare(id, update);
    this.shares.set(id, saved);
    this.broadcast('shares', this.listShares());
    this._refreshMdnsSharedCount();
    return this._decorate(saved);
  }

  removeShare(id) {
    this.db.removeShare(id);
    this.shares.delete(id);
    this.broadcast('shares', this.listShares());
    this._refreshMdnsSharedCount();
  }

  startShare(id) {
    this.updateShare(id, { enabled: true });
  }

  stopShare(id) {
    this.updateShare(id, { enabled: false });
  }

  enabledShareCount() {
    return [...this.shares.values()].filter((s) => s.enabled).length;
  }

  _refreshMdnsSharedCount() {
    if (this.mdns && this.settings.mdns) {
      try {
        this.mdns.publish({
          name: this.deviceName,
          port: this.httpPort,
          deviceId: this.deviceId,
          os: this.osType,
          version: this.version,
          sharedCount: this.enabledShareCount(),
        });
      } catch (e) {}
    }
  }

  /* ---------------- 设备操作 ---------------- */
  discover() {
    if (this.udp) this.udp.probe();
  }

  async connectManual({ host, port }) {
    if (!host) throw new Error('缺少 host');
    port = port || this.httpPort;
    let info = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(`http://${host}:${port}/api/self`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) info = await res.json();
    } catch (e) {
      info = null;
    }
    const dev = {
      deviceId: info?.deviceId || `ip:${host}:${port}`,
      deviceName: info?.deviceName || host,
      host,
      port,
      os: info?.os || 'Unknown',
      version: info?.version || '',
      sharedCount: info?.sharedCount || 0,
    };
    const merged = this.deviceManager.upsert(dev);
    this.db.upsertDevice(merged);
    this.broadcast('devices', this.deviceManager.list());
    return merged;
  }

  trustDevice(id, trusted) {
    this.deviceManager.setTrust(id, trusted);
    this.db.setTrust(id, trusted);
    this.broadcast('devices', this.deviceManager.list());
  }

  blacklistDevice(id, black) {
    this.deviceManager.setBlacklist(id, black);
    this.db.setBlacklist(id, black);
    this.broadcast('devices', this.deviceManager.list());
  }

  async pingDevice(id) {
    const d = this.deviceManager.get(id);
    if (!d) return -1;
    return pingHost(d.host, d.port, 2000);
  }

  /* ---------------- 邀请码 ---------------- */
  inviteCreate() {
    return createInvite(this.db, this.deviceId);
  }

  inviteJoin(code) {
    const r = resolveInvite(this.db, code);
    if (!r.ok) return r;
    // 邀请方就是本机自己时，必然在线
    if (r.deviceId === this.deviceId) {
      this.db.markInviteUsed(code);
      return { ok: true, device: { device_id: this.deviceId, device_name: this.deviceName, host: this.localIp, port: this.httpPort } };
    }
    const dev = this.deviceManager.get(r.deviceId);
    if (!dev) return { ok: false, reason: 'device_offline' };
    this.db.markInviteUsed(code);
    return { ok: true, device: dev };
  }

  /* ---------------- 设置 ---------------- */
  getSettings() {
    return { ...this.settings, httpPort: this.httpPort, udpPort: this.udpPort, localIp: this.localIp };
  }

  updateSettings(patch = {}) {
    const before = { ...this.settings };
    this.settings = { ...this.settings, ...patch };
    this.db.setConfig('settings', JSON.stringify(this.settings));

    if (patch.deviceName && patch.deviceName !== before.deviceName) {
      this.deviceName = patch.deviceName;
      this._refreshMdnsSharedCount();
    }
    if (patch.heartbeatInterval && patch.heartbeatInterval !== before.heartbeatInterval && this.udp) {
      this.udp.interval = patch.heartbeatInterval;
      this.udp.stopHeartbeat();
      this.udp.startHeartbeat();
    }
    this.broadcast('settings', this.getSettings());
  }

  getShareQrcode(id) {
    const qrcode = require('qrcode');
    const share = this.getShare(id);
    if (!share) throw new Error('共享不存在');
    const url = `http://${this.localIp}:${this.httpPort}/s/${id}`;
    return qrcode.toDataURL(url);
  }

  /* ---------------- 信息 / 统计 ---------------- */
  selfInfo() {
    return {
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      host: this.localIp,
      port: this.httpPort,
      os: this.osType,
      version: this.version,
      fingerprint: this.fingerprint,
      sharedCount: this.enabledShareCount(),
    };
  }

  stats() {
    const list = this.deviceManager.list();
    return {
      shares: this.enabledShareCount(),
      totalShares: this.shares.size,
      onlineDevices: list.filter((d) => d.is_online).length,
      devices: list.length,
      traffic: { up: this.traffic.up, down: this.traffic.down },
      speed: this._speed,
    };
  }

  _snapshot() {
    return {
      self: this.selfInfo(),
      shares: this.listShares(),
      devices: this.deviceManager.list(),
      stats: this.stats(),
      settings: this.getSettings(),
    };
  }

  broadcast(event, payload) {
    if (!this.wss) return;
    const msg = JSON.stringify({ event, payload });
    for (const ws of this.wss.clients) {
      if (ws.readyState === 1) {
        try {
          ws.send(msg);
        } catch (e) {}
      }
    }
  }

  logEvent(entry) {
    if (!this.db) return;
    if (entry.event_type === 'file_download' && entry.size) {
      this.traffic.down += entry.size;
      this._cumulative.down += entry.size;
    }
    if (entry.event_type === 'file_upload' && entry.size) {
      this.traffic.up += entry.size;
      this._cumulative.up += entry.size;
    }
    this.db.addLog(entry);
    this.broadcast('logs', entry);
  }

  clientIp(req) {
    return ((req.socket && req.socket.remoteAddress) || req.ip || '')
      .replace('::ffff:', '')
      .replace('::1', '127.0.0.1');
  }

  getSharePageHtml(shareId) {
    return this._sharePageHtml.replace(/__SHARE_ID__/g, shareId).replace(/__SELF_HOST__/g, `${this.localIp}:${this.httpPort}`);
  }

  _rootPageHtml() {
    const shares = this.listShares()
      .map((s) => `<li><a href="/s/${s.id}">${s.name}</a> — ${s.path} ${s.enabled ? '🟢' : '🔴'}</li>`)
      .join('');
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>局域网文件共享</title>
      <style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px}li{margin:6px 0}a{color:#2563eb}</style></head>
      <body><h1>局域网文件共享平台</h1><p>本机地址：http://${this.localIp}:${this.httpPort}</p>
      <h3>已共享文件夹</h3><ul>${shares || '<li>暂无</li>'}</ul>
      <p><a href="/api/self">查看本机信息(JSON)</a></p></body></html>`;
  }

  async stop() {
    try {
      clearInterval(this._speedTimer);
      clearInterval(this._pruneTimer);
    } catch (e) {}
    if (this.udp) this.udp.stop();
    if (this.mdns) this.mdns.stop();
    if (this.wss) {
      // 先断开所有客户端连接，否则 server.close 会一直等待而无法退出
      for (const ws of this.wss.clients) {
        try {
          ws.terminate();
        } catch (e) {}
      }
      this.wss.close();
    }
    if (this.server) await new Promise((r) => this.server.close(() => r()));
    if (this.db) this.db.close();
  }
}

module.exports = LanFileShare;

// 独立运行入口（无 Electron 时可作为服务启动）
if (require.main === module) {
  // 支持 NAS（飞牛 fnOS fpk）等服务场景通过环境变量指定端口
  const envPort = Number(process.env.LFS_PORT || process.env.PORT);
  const inst = new LanFileShare({ httpPort: envPort || DEFAULT_HTTP_PORT, dataDir: process.env.LFS_DATA_DIR || undefined });
  inst
    .init()
    .then(() => {
      console.log('========================================');
      console.log(' 局域网文件共享服务已启动');
      console.log(` 本机地址: http://${inst.localIp}:${inst.httpPort}`);
      console.log(` 设备ID : ${inst.deviceId}`);
      console.log(` 指纹   : ${inst.fingerprint}`);
      console.log(' 管理 API: /api/shares, /api/devices, /api/self');
      console.log(' 按 Ctrl+C 停止');
      console.log('========================================');
    })
    .catch((e) => {
      console.error('启动失败:', e);
      process.exit(1);
    });
  process.on('SIGINT', () => {
    inst.stop().then(() => process.exit(0));
  });
}
