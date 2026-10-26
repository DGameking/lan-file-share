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
const Logger = require('./logger');
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
const BridgeManager = require('./bridge');
const dropHandler = require('./drop');
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
    this.bridge = null;
    this.receivedDir = null;
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
    // 运行日志：关键链路落盘 + 内存缓冲（管理控制台可远程查看/自诊断）
    this.logger = new Logger(path.join(this.dataDir, 'logs'));
    this.logger.info('engine', `启动中 · 版本 ${this.version} · 平台 ${process.platform}/${process.arch} · Node ${process.version}`, {
      dataDir: this.dataDir,
      port: this.httpPort,
    });
    this.db = await DB.create(this.dbPath);
    this.logger.info('db', '数据库已打开', { path: this.dbPath });

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
        clipboardSync: true,
        autoAcceptDrop: true,
        https: false,
        serverMode: false,
        autoUpdateCheck: true,
      };
    this.deviceName = this.settings.deviceName || this.deviceName;
    // HTTPS 模式由设置控制（自签证书，重启生效）；屏幕共享 / PWA 需要安全上下文
    this.useHttps = !!this.settings.https;

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
    // 本机设备以设备名注册为会话常驻成员（跨设备联邦后对方上线即可见）
    if (this.chat) this.chat.setDeviceMember({ id: 'device-' + this.deviceId, name: this.deviceName, deviceId: this.deviceId });
    await this._startHttp();
    this._startDiscovery();

    this.logger.info('engine', `服务已就绪 · http://${this.localIp}:${this.httpPort}${this.useHttps ? '（HTTPS）' : ''} · 设备ID ${this.deviceId}`);

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
    // 会话桥：让所有发现的设备自动加入统一会话（跨设备消息联邦）
    this.bridge = new BridgeManager(this);

    this.deviceManager.on('online', (d) => {
      this.logEvent({ event_type: 'device_online', device_id: d.device_id, device_name: d.device_name, ip: d.host, result: 'success' });
      this.logger.info('discovery', `设备上线「${d.device_name}」`, { id: d.device_id, host: d.host, port: d.port, os: d.os, version: d.version });
      if (this.bridge) this.bridge.peerOnline(d);
    });
    this.deviceManager.on('offline', (d) => {
      this.logEvent({ event_type: 'device_offline', device_id: d.device_id, device_name: d.device_name, ip: d.host, result: 'success' });
      this.logger.info('discovery', `设备离线「${d.device_name}」`, { id: d.device_id, host: d.host });
      this.db.setDeviceOnline(d.device_id, false);
      if (this.bridge) this.bridge.peerOffline(d.device_id);
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

    // 局域网工具：开放跨源访问，桌面端渲染层可直接向其他设备投送文件
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });

    app.get('/', (req, res) => res.type('html').send(this._rootPageHtml()));

    // PWA：manifest / Service Worker / 图标（安全上下文下浏览器可“安装到主屏幕”）
    const staticDir = path.join(__dirname, 'static');
    app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(staticDir, 'manifest.webmanifest')));
    app.get('/sw.js', (req, res) => res.type('application/javascript').sendFile(path.join(staticDir, 'sw.js')));
    app.get('/icons/:name', (req, res) => {
      const name = path.basename(req.params.name || '');
      if (!/^icon-\d+\.png$/.test(name)) return res.status(404).end();
      res.sendFile(path.join(staticDir, 'icons', name));
    });

    // 管理端（/admin 页面 + /api 管理路由鉴权）—— 必须先于 registerApi 挂载
    require('./admin').register(this);

    registerApi(this);
    this.chat = new ChatManager(this);
    this.chat.register();
    dropHandler.register(this);
    browseHandler.register(this);
    downloadHandler.register(this);
    uploadHandler.register(this);
    webdavHandler.register(this);
    zipHandler.register(this);

    // 全局错误兜底：任何未捕获异常都进运行日志（远程排障的关键）
    app.use((err, req, res, next) => {
      if (this.logger) this.logger.error('http', `${req.method} ${req.originalUrl} 处理失败`, String((err && err.stack) || err));
      if (!res.headersSent) res.status(500).json({ error: 'internal_error', message: String(err && err.message) || 'internal_error' });
    });
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
    if (this.bridge && this.bridge._onData(ws, JSON.stringify(msg))) return;
    if (this.chat && this.chat.onMessage(ws, msg)) return;
    if (msg.type === 'trust' && msg.deviceId) this.trustDevice(msg.deviceId, true);
    if (msg.type === 'blacklist' && msg.deviceId) this.blacklistDevice(msg.deviceId, true);
  }

  /** 本机剪贴板变化 → 同步给所有设备（桥接 + 本机网页端提示） */
  clipSync(text) {
    const payload = { deviceId: this.deviceId, deviceName: this.deviceName, text: String(text || '').slice(0, 100000), ts: Date.now() };
    this.broadcast('clip.sync', payload);
    if (this.bridge) this.bridge.relay('clip.sync', payload);
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
          this.logger.info('discovery', `UDP 发现已启动`, { port: this.udpPort });
        })
        .catch((e) => {
          this.logger.error('discovery', 'UDP 发现启动失败', e.message);
          this.emit('warn', 'UDP 发现启动失败: ' + e.message);
        });
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
        this.logger.info('discovery', 'mDNS 已启动');
      } catch (e) {
        this.logger.error('discovery', 'mDNS 启动失败', e.message);
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
    this._relayShareCatalog();
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
    this._relayShareCatalog();
    this._refreshMdnsSharedCount();
    return this._decorate(saved);
  }

  removeShare(id) {
    this.db.removeShare(id);
    this.shares.delete(id);
    this.broadcast('shares', this.listShares());
    this._relayShareCatalog();
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

  /** 本机共享目录（对外广播用，不含路径等敏感信息） */
  shareCatalog() {
    return this.listShares()
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.id, name: s.name, permission: s.permission, hasPassword: s.hasPassword }));
  }

  /** 共享变化 → 同步给桥接对端 */
  _relayShareCatalog() {
    if (this.bridge) this.bridge.relay('shares.catalog', this.shareCatalog());
  }

  /** 合并的远端共享目录（其他设备广播来的），供本机 UI 展示 / 挂载 */
  remoteSharesList() {
    if (!this.bridge) return [];
    return this.bridge.remoteShareList();
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
    // adminPasswordHash 不对外暴露（WS 广播/快照都会带上 settings）
    const { adminPasswordHash, ...rest } = this.settings;
    return { ...rest, httpPort: this.httpPort, udpPort: this.udpPort, localIp: this.localIp, adminPasswordSet: !!adminPasswordHash };
  }

  updateSettings(patch = {}) {
    const before = { ...this.settings };
    this.settings = { ...this.settings, ...patch };
    this.db.setConfig('settings', JSON.stringify(this.settings));

    if (patch.deviceName && patch.deviceName !== before.deviceName) {
      this.deviceName = patch.deviceName;
      if (this.chat) this.chat.setDeviceMember({ id: 'device-' + this.deviceId, name: this.deviceName, deviceId: this.deviceId });
      this._refreshMdnsSharedCount();
    }
    if (patch.heartbeatInterval && patch.heartbeatInterval !== before.heartbeatInterval && this.udp) {
      this.udp.interval = patch.heartbeatInterval;
      this.udp.stopHeartbeat();
      this.udp.startHeartbeat();
    }
    if (!!patch.https !== !!before.https) {
      // HTTPS 切换需重启服务生效
      this.broadcast('settings', this.getSettings());
      this.emit('https-changed', !!patch.https);
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

  /* ---------------- 更新检查 ---------------- */
  /**
   * 检查 GitHub 最新版本。auto=true 时 24 小时节流（渲染层/管理端启动时调用），
   * 手动检查传 auto=false 强制执行。不引入后台定时器 —— 由客户端主动触发。
   */
  async checkUpdate(auto = false) {
    if (!this.settings.autoUpdateCheck) return { checked: false, reason: 'disabled' };
    if (auto) {
      const last = Number(this.db.getConfig('update_check_at') || 0);
      if (Date.now() - last < 24 * 3600 * 1000) {
        return { checked: false, reason: 'throttled', ...(this._updateInfo || {}) };
      }
    }
    try {
      const r = await require('./update-checker').checkLatest({ current: this.version });
      this.db.setConfig('update_check_at', String(Date.now()));
      this._updateInfo = r;
      if (r.hasUpdate) {
        this.logger && this.logger.info('update', `发现新版本 v${r.latest}（当前 v${this.version}）`);
        this.broadcast('update.available', r);
      }
      return { checked: true, ...r };
    } catch (e) {
      this.logger && this.logger.warn('update', '检查更新失败（离线或网络受限不影响使用）', e.message);
      return { checked: false, error: e.message };
    }
  }

  /* ---------------- 应用内更新：下载 / 安装 ---------------- */

  /** 下载最新版安装包（支持断点续传，进度经 update.progress 广播） */
  async downloadUpdate() {
    if (this._updateDl) return { ok: false, error: 'download_in_progress' };
    const uc = require('./update-checker');
    const r = await this.checkUpdate(false); // 强制刷新，拿最新资产列表
    if (!r.checked || !r.hasUpdate) return { ok: false, error: r.error || 'no_update' };
    const m = uc.matchAsset(r.assets, { platform: process.platform, arch: process.arch, version: r.latest });
    if (!m) return { ok: false, error: 'asset_not_found', hint: '该平台暂无对应的发布文件' };

    // Windows：取校验和用于完整性验证
    let sha = null;
    if (m.checksumAsset) {
      try {
        const cres = await fetch(m.checksumAsset.url, { signal: AbortSignal.timeout(15000) });
        if (cres.ok) sha = uc.parseChecksum(await cres.text(), m.installer.name);
      } catch (e) {}
    }

    const dir = path.join(this.dataDir, 'updates');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const file = path.join(dir, m.installer.name);
    this._updateDl = { abort: new AbortController(), file, asset: m.installer, sha, version: r.latest, received: 0, total: m.installer.size, lastEmit: 0 };
    this._pumpDownload();
    return { ok: true, name: m.installer.name, size: m.installer.size, version: r.latest };
  }

  async _pumpDownload() {
    const dl = this._updateDl;
    if (!dl) return;
    try {
      let start = 0;
      if (fs.existsSync(dl.file)) {
        start = fs.statSync(dl.file).size;
        if (start > dl.total) { try { fs.unlinkSync(dl.file); } catch (e) {} start = 0; }
      }
      dl.received = start;
      const headers = {};
      if (start > 0) headers.Range = `bytes=${start}-`;
      const res = await fetch(dl.asset.url, { headers, redirect: 'follow', signal: dl.abort.signal });
      if (!res.ok && res.status !== 206) throw new Error('download_http_' + res.status);
      const stream = fs.createWriteStream(dl.file, { flags: start > 0 ? 'a' : 'w' });
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!stream.write(Buffer.from(value))) await new Promise((r) => stream.once('drain', r));
        dl.received += value.length;
        const now = Date.now();
        if (now - dl.lastEmit > 300) {
          dl.lastEmit = now;
          this.broadcast('update.progress', { name: dl.asset.name, received: dl.received, total: dl.total, pct: Math.round((dl.received / dl.total) * 100) });
        }
      }
      await new Promise((r) => stream.end(r));
      // 完整性校验
      if (dl.sha) {
        const hash = require('crypto').createHash('sha256');
        hash.update(fs.readFileSync(dl.file));
        if (hash.digest('hex') !== dl.sha) {
          try { fs.unlinkSync(dl.file); } catch (e) {}
          throw new Error('checksum_mismatch');
        }
      }
      this._updateInfo = { ...(this._updateInfo || {}), downloadedFile: dl.file, downloadedVersion: dl.version };
      this.broadcast('update.downloaded', { file: dl.file, name: dl.asset.name, version: dl.version, size: dl.total });
      this.logger && this.logger.info('update', `新版本安装包下载完成：${dl.asset.name}`);
    } catch (e) {
      if (dl.aborted || (e && e.name === 'AbortError')) {
        this.broadcast('update.progress', { aborted: true });
      } else {
        this.logger && this.logger.warn('update', '更新包下载失败', e.message);
        this.broadcast('update.error', { message: e.message });
      }
    } finally {
      this._updateDl = null;
    }
  }

  abortUpdate() {
    if (this._updateDl) {
      this._updateDl.aborted = true;
      try { this._updateDl.abort.abort(); } catch (e) {}
    }
    return { ok: true };
  }

  /** 执行已下载的安装包（Windows 静默安装并自动重启；mac/linux 打开安装文件） */
  installUpdate() {
    const info = this._updateInfo || {};
    const file = info.downloadedFile;
    if (!file || !fs.existsSync(file)) throw new Error('no_downloaded_file');
    if (process.platform === 'win32') {
      const { spawn } = require('child_process');
      const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      this.emit('update.install');
      return { ok: true, mode: 'auto' };
    }
    return { ok: true, mode: 'manual', file };
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
      .map((s) => {
        const qs = s.password ? '?pwd=' : '';
        return `<div class="card"><div class="card-head"><span class="dot ${s.enabled ? 'on' : 'off'}"></span>
          <a href="/s/${s.id}${qs}">${s.name}</a><span class="perm">${s.permission === 'write' ? '可写' : s.permission === 'admin' ? '管理' : '只读'}${s.password ? ' · 密码' : ''}</span></div>
          <div class="path">${s.path}</div></div>`;
      })
      .join('');
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="theme-color" content="#4f8cff"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icons/icon-192.png">
      <title>局域网文件共享</title><style>
      :root{--bg:#0f1115;--panel:#1a1d24;--line:#2a2e38;--text:#e6e8ec;--muted:#9aa0aa;--accent:#4f8cff}
      *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
      .wrap{max-width:760px;margin:0 auto;padding:32px 20px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);font-size:14px;margin-bottom:24px}
      .entry{display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap}
      .entry a{flex:1;min-width:200px;display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;text-decoration:none;color:var(--text)}
      .entry a:hover{border-color:var(--accent)}.entry b{display:block;font-size:15px;margin-bottom:4px;color:var(--accent)}
      .entry span{font-size:13px;color:var(--muted)}
      h3{font-size:15px;color:var(--muted);margin:0 0 12px}
      .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:10px}
      .card-head{display:flex;align-items:center;gap:8px}.card-head a{color:var(--text);text-decoration:none;font-size:15px}
      .dot{width:8px;height:8px;border-radius:50%}.dot.on{background:#36c275}.dot.off{background:#ff5d5d}
      .perm{margin-left:auto;font-size:12px;color:var(--muted)}.path{font-size:12px;color:var(--muted);margin-top:6px;word-break:break-all}
      .empty{color:var(--muted);font-size:14px}</style></head>
      <body><div class="wrap"><h1>局域网文件共享平台</h1>
      <div class="sub">本机地址：http://${this.localIp}:${this.httpPort}</div>
      <div class="entry">
        <a href="/chat"><b>💬 统一会话</b><span>所有设备同框聊天 · 传文件 · 音视频通话</span></a>
        <a href="/admin"><b>🛠 管理控制台</b><span>共享 / 设备 / 日志 / 设置（本机免登录）</span></a>
      </div>
      <h3>共享文件夹</h3>
      ${shares || '<div class="empty">暂无共享 — 请在桌面客户端或管理控制台添加</div>'}
      </div><script>if('serviceWorker' in navigator && window.isSecureContext){navigator.serviceWorker.register('/sw.js').catch(function(){});}</script></body></html>`;
  }

  async stop() {
    try {
      clearInterval(this._speedTimer);
      clearInterval(this._pruneTimer);
    } catch (e) {}
    if (this.logger) this.logger.info('engine', '服务停止');
    if (this.bridge) this.bridge.stop();
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
    if (this.logger) this.logger.stop();
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
