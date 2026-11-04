'use strict';

/**
 * LocalSend 互通网关（v1.19.0）
 *
 * 与 LocalSend 官方客户端（https://localsend.org，协议 v2.x）双向互通：
 *
 * 【作为接收方】本机在 53317 端口（可配置）起 LocalSend 兼容服务：
 *   - POST /api/localsend/v2/register          双向发现
 *   - GET  /api/localsend/v2/info              调试信息
 *   - POST /api/localsend/v2/prepare-upload    审批会话（映射本站 autoAcceptDrop / dropPin 策略）
 *   - POST /api/localsend/v2/upload            文件流接收（落收件箱 + drop 历史 + 桌面通知）
 *   - POST /api/localsend/v2/cancel            取消会话
 *   传输层优先 HTTPS（openssl 自签证书，指纹=证书 SHA-256），失败降级 HTTP（指纹=随机串）。
 *
 * 【作为发送方】sendFiles() 向发现的 LocalSend 设备投送本机文件。
 *
 * 【发现】加入 LocalSend 默认组播 224.0.0.167:53317（UDP），周期 announce + 被动监听；
 *   发现的设备注入 DeviceManager（via='localsend'），与本站设备同列表展示。
 *   与本站 UDP 发现（9527-9537 端口）互不冲突。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const http = require('http');
const https = require('https');
const express = require('express');

const { shortId } = require('../shared/utils');

const LS_MULTICAST = '224.0.0.167';
const LS_UDP_PORT = 53317;
const LS_ANNOUNCE_INTERVAL = 5 * 1000;
const LS_SESSION_TTL = 10 * 60 * 1000;
const LS_DEVICE_TTL = 30 * 1000;

class LocalSendGateway {
  constructor(engine) {
    this.engine = engine;
    this.sessions = new Map(); // sessionId -> {status, from, ip, files:Map, ts}
    this.discovered = new Map(); // fingerprint -> {alias,host,port,protocol,deviceModel,deviceType,lastSeen}
    this.offers = new Map(); // sessionId -> {files:Map(fid->meta), pin, ts}（v1.20.0 拉取供给池）
    this.protocol = 'http';
    this.port = Number(engine.settings.localsendPort) || 53317;
    this.httpServer = null;
    this.sock = null;
    this.announceTimer = null;
    this.pruneTimer = null;
    this.stopped = false;
  }

  /** 本机在 LocalSend 协议里的自我描述 */
  selfInfo() {
    return {
      alias: this.engine.deviceName || 'LFS Device',
      version: '2.1',
      deviceModel: `${os.type()} ${os.arch()}`.trim(),
      deviceType: 'desktop',
      fingerprint: this.fingerprint || '',
      port: this.port,
      protocol: this.protocol,
      download: true, // v1.20.0 支持 prepare-download/download 拉取
    };
  }

  async start() {
    const engine = this.engine;
    // 证书：openssl 自签（尽力而为，失败降级 HTTP）
    let tls = null;
    try {
      tls = await this._ensureCert();
    } catch (e) {
      engine.logger && engine.logger.warn('localsend', '自签证书生成失败，降级 HTTP 模式', e.message);
    }
    if (tls) {
      this.protocol = 'https';
      this.fingerprint = crypto.createHash('sha256').update(tls.cert).digest('hex');
    } else {
      this.protocol = 'http';
      let fp = engine.db.getConfig('localsend_fingerprint');
      if (!fp) {
        fp = crypto.randomBytes(16).toString('hex');
        engine.db.setConfig('localsend_fingerprint', fp);
      }
      this.fingerprint = fp;
    }

    const app = express();
    app.use(express.json({ limit: '4mb' }));
    this._routes(app);

    this.httpServer = (this.protocol === 'https' ? https : http)
      .createServer(tls ? { key: tls.key, cert: tls.cert } : undefined, app);
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, () => resolve());
    });
    engine.logger && engine.logger.info('localsend', `LocalSend 兼容服务已启动（${this.protocol.toUpperCase()} :${this.port}）`);

    this._startUdp();
    this.pruneTimer = setInterval(() => this._prune(), 10 * 1000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.announceTimer);
    clearInterval(this.pruneTimer);
    try { this.sock && this.sock.close(); } catch (e) {}
    try { this.httpServer && this.httpServer.close(); } catch (e) {}
  }

  /* ---------------- 路由 ---------------- */
  _routes(app) {
    const engine = this.engine;

    app.get('/api/localsend/v2/info', (req, res) => {
      const info = this.selfInfo();
      delete info.port;
      delete info.protocol;
      res.json(info);
    });

    // 双向发现：LocalSend 端扫到我们（HTTP legacy 模式）时调用
    app.post('/api/localsend/v2/register', (req, res) => {
      try {
        const b = req.body || {};
        if (b.fingerprint && b.fingerprint !== this.fingerprint) {
          this._recordDevice(b, req.socket.remoteAddress);
        }
      } catch (e) {}
      const info = this.selfInfo();
      delete info.port;
      delete info.protocol;
      res.json(info);
    });

    // 审批会话：映射本站投送策略（PIN / 自动接收 / 拒绝）
    app.post('/api/localsend/v2/prepare-upload', (req, res) => {
      const ip = req.socket.remoteAddress;
      const body = req.body || {};
      const files = body.files && typeof body.files === 'object' ? body.files : null;
      if (!files || !Object.keys(files).length) return res.status(204).end();

      const settings = engine.settings || {};
      // PIN（本站投送 PIN 复用；LocalSend 规范用 ?pin= 查询参数）
      if (settings.dropPin) {
        const pin = String(req.query.pin || '');
        if (pin !== String(settings.dropPin)) {
          return res.status(401).json({ message: 'PIN required / invalid PIN' });
        }
      }
      if (settings.autoAcceptDrop === false) {
        return res.status(403).json({ message: '本工具未开启自动接收。请在管理台「设置」开启自动接收投送后重试' });
      }

      const from = (body.info && body.info.alias) || 'LocalSend 设备';
      const sessionId = shortId();
      const tokens = {};
      const metas = new Map();
      for (const [fid, meta] of Object.entries(files)) {
        const token = shortId();
        tokens[fid] = token;
        metas.set(String(fid), {
          id: String(fid).slice(0, 128),
          fileName: String((meta && meta.fileName) || 'file').slice(0, 200),
          size: Number(meta && meta.size) || 0,
          fileType: String((meta && meta.fileType) || '').slice(0, 100),
          sha256: (meta && meta.sha256) ? String(meta.sha256).slice(0, 64) : null,
          token,
          received: 0,
          path: null,
        });
      }
      this.sessions.set(sessionId, { status: 'waiting', from, ip, files: metas, ts: Date.now() });
      engine.logger && engine.logger.info('localsend', `LocalSend 会话已建立：${from} 发来 ${metas.size} 个文件`, { ip, sessionId });
      res.json({ sessionId, files: tokens });
    });

    // 文件流接收
    app.post('/api/localsend/v2/upload', (req, res) => {
      const sessionId = String(req.query.sessionId || '');
      const fileId = String(req.query.fileId || '');
      const token = String(req.query.token || '');
      const sess = this.sessions.get(sessionId);
      if (!sess || sess.status !== 'waiting') return res.status(409).json({ message: 'Blocked by another session / unknown session' });
      const meta = sess.files.get(fileId);
      if (!meta || meta.token !== token) return res.status(403).json({ message: 'Invalid token' });

      const dir = this.engine.receivedDir || path.join(this.engine.dataDir, 'received');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      const safe = meta.fileName.replace(/[/\\:*?"<>|]/g, '_').slice(0, 150) || 'file';
      let dest = path.join(dir, `ls_${Date.now()}_${safe}`);
      let n = 1;
      while (fs.existsSync(dest)) dest = path.join(dir, `ls_${Date.now()}_${n++}_${safe}`);

      const hash = meta.sha256 ? crypto.createHash('sha256') : null;
      const ws = fs.createWriteStream(dest);
      let aborted = false;
      req.on('data', (c) => { if (hash) hash.update(c); });
      req.on('aborted', () => { aborted = true; });
      req.pipe(ws);
      ws.on('finish', () => {
        if (aborted) return;
        const done = () => {
          meta.received = 1;
          meta.path = dest;
          meta.size = ws.bytesWritten;
          res.status(200).end();
          this._maybeFinish(sessionId);
        };
        if (hash && hash.digest('hex') !== meta.sha256) {
          try { fs.unlinkSync(dest); } catch (e) {}
          return res.status(422).json({ message: 'Checksum mismatch (sha256)' });
        }
        done();
      });
      ws.on('error', () => {
        try { fs.unlinkSync(dest); } catch (e) {}
        if (!res.headersSent) res.status(500).json({ message: 'Write failed' });
      });
    });

    // 取消会话（发送方主动）
    app.post('/api/localsend/v2/cancel', (req, res) => {
      const sess = this.sessions.get(String(req.query.sessionId || ''));
      if (sess) {
        sess.status = 'canceled';
        for (const m of sess.files.values()) {
          if (m.path) { try { fs.unlinkSync(m.path); } catch (e) {} }
        }
        this.sessions.delete(String(req.query.sessionId || ''));
      }
      res.status(200).end();
    });

    /* ---------------- v1.20.0 反向拉取（download API，本机作为提供方） ---------------- */

    // 对方请求拉取：body.files 列出想要的文件（fid 需命中供给池），PIN 走 ?pin=
    app.post('/api/localsend/v2/prepare-download', (req, res) => {
      const body = req.body || {};
      const files = body.files && typeof body.files === 'object' ? body.files : null;
      const offer = this.offers.get(String(req.query.sessionId || body.sessionId || ''));
      if (!offer) return res.status(404).json({ message: 'Unknown download session（会话不存在或已过期）' });
      if (!files || !Object.keys(files).length) return res.status(204).end();
      if (offer.pin && String(req.query.pin || '') !== String(offer.pin)) {
        return res.status(401).json({ message: 'PIN required / invalid PIN' });
      }
      const tokens = {};
      for (const fid of Object.keys(files)) {
        const meta = offer.files.get(String(fid));
        if (!meta) return res.status(404).json({ message: `File not found: ${String(fid).slice(0, 64)}` });
        tokens[fid] = meta.token;
      }
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      engine.logger && engine.logger.info('localsend', `LocalSend 拉取请求：${ip} 请求 ${Object.keys(tokens).length} 个文件`, { sessionId: offer.id });
      res.json({ sessionId: offer.id, files: tokens });
    });

    // 文件流下载（token 一次性校验即授权，不再重复验 PIN——prepare-download 已把关；流式发送）
    app.get('/api/localsend/v2/download', (req, res) => {
      const offer = this.offers.get(String(req.query.sessionId || ''));
      if (!offer) return res.status(404).json({ message: 'Unknown download session' });
      const meta = offer.files.get(String(req.query.fileId || ''));
      if (!meta) return res.status(404).json({ message: 'File not found' });
      if (meta.token !== String(req.query.token || '')) return res.status(403).json({ message: 'Invalid token' });
      let stat = null;
      try { stat = fs.statSync(meta.path); } catch (e) {}
      if (!stat || !stat.isFile()) return res.status(404).json({ message: 'File missing' });
      res.setHeader('Content-Type', meta.fileType || 'application/octet-stream');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`);
      const rs = fs.createReadStream(meta.path);
      rs.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.end(); });
      rs.pipe(res);
    });
  }

  /**
   * v1.20.0 创建拉取供给：本机选定文件 → 生成 sessionId 与下载链接。
   * LocalSend 官方客户端「打开链接」或浏览器直接访问均可拉取。
   * @param {Array<{path,name,size,mime,sha256?}>} items
   * @param {{pin?:string}} opts
   * @returns {{sessionId, url, files:{fid:{fileName,size,fileType,sha256}}}}
   */
  createDownloadOffer(items, opts = {}) {
    const id = shortId();
    const files = new Map();
    const declared = {};
    for (const it of items || []) {
      if (!it.path || !fs.existsSync(it.path)) continue;
      const fid = shortId();
      const sha = it.sha256 || this._sha256Sync(it.path);
      const meta = {
        id: fid,
        fileName: it.name || path.basename(it.path),
        size: it.size || fs.statSync(it.path).size,
        fileType: it.mime || 'application/octet-stream',
        sha256: sha,
        token: shortId(),
        path: it.path,
      };
      files.set(fid, meta);
      declared[fid] = { id: fid, fileName: meta.fileName, size: meta.size, fileType: meta.fileType, sha256: sha };
    }
    if (!files.size) return null;
    const pin = String(opts.pin || '').trim();
    const offer = { id, files, pin, ts: Date.now() };
    this.offers.set(id, offer);
    const engine = this.engine;
    const base = `${this.protocol}://${engine.localIp}:${this.port}`;
    const url = `${base}/#/p?sessionId=${encodeURIComponent(id)}${pin ? '&pin=' + encodeURIComponent(pin) : ''}`;
    engine.logger && engine.logger.info('localsend', `LocalSend 拉取链接已创建：${files.size} 个文件（TTL 10 分钟）`, { sessionId: id });
    return { sessionId: id, url, files: declared };
  }

  _sha256Sync(p) {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    } catch (e) {
      return null;
    }
  }

  /** 会话内全部文件到齐 → 走本站收件通知与历史 */
  _maybeFinish(sessionId) {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.status !== 'waiting') return;
    for (const m of sess.files.values()) if (!m.received) return;
    sess.status = 'finished';
    this.sessions.delete(sessionId);

    const engine = this.engine;
    const files = [...sess.files.values()].map((m) => ({
      fileId: path.basename(m.path || ''),
      name: m.fileName,
      size: m.size,
      mime: m.fileType || '',
      isText: false,
      verified: !!m.sha256,
    }));
    const ts = Date.now();
    try {
      engine.broadcast('drop.incoming', { from: sess.from, files, ts, via_localsend: true });
    } catch (e) {}
    try {
      for (const f of files) {
        engine.db.addDropHistory({ ts, from_name: sess.from, file_id: f.fileId, name: f.name, size: f.size, mime: f.mime, is_text: false, verified: f.verified, via_relay: false });
      }
      engine.db.pruneDropHistory(1000);
    } catch (e) {}
    try {
      engine.logEvent({ event_type: 'file_receive', device_name: sess.from, ip: sess.ip, result: 'success', detail: { count: files.length, via: 'localsend' } });
    } catch (e) {}
    engine.logger && engine.logger.info('localsend', `LocalSend 接收完成：${sess.from} 的 ${files.length} 个文件已入收件箱`);
  }

  /* ---------------- 发送方 ---------------- */
  /**
   * 向 LocalSend 设备发送本机文件
   * @param {{host,port,protocol}} target 发现的设备
   * @param {Array<{path,name,size,mime}>} items
   * @returns {Promise<{ok:boolean, sent:number, error?:string}>}
   */
  async sendFiles(target, items) {
    if (!items || !items.length) return { ok: false, sent: 0, error: 'no_files' };
    const files = {};
    for (const it of items) {
      const id = shortId();
      files[id] = { id, fileName: it.name || path.basename(it.path || 'file'), size: it.size || 0, fileType: it.mime || 'application/octet-stream' };
    }
    const body = JSON.stringify({ info: this.selfInfo(), files });
    const prep = await this._request(target, '/api/localsend/v2/prepare-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (prep.status === 204) return { ok: true, sent: 0 };
    if (prep.status === 401) throw Object.assign(new Error('对方要求 PIN（LocalSend 端开启了 PIN）'), { code: 'pin' });
    if (prep.status === 403) throw Object.assign(new Error('对方拒绝了本次投送'), { code: 'rejected' });
    if (prep.status === 409) throw Object.assign(new Error('对方正忙（有其他传输会话）'), { code: 'busy' });
    if (prep.status !== 200) throw new Error('prepare-upload 失败：HTTP ' + prep.status);
    const j = JSON.parse(prep.body || '{}');
    const tokens = j.files || {};
    let sent = 0;
    const ids = Object.keys(files);
    try {
      for (const fid of ids) {
        const it = items[ids.indexOf(fid)];
        const q = `?sessionId=${encodeURIComponent(j.sessionId)}&fileId=${encodeURIComponent(fid)}&token=${encodeURIComponent(tokens[fid] || '')}`;
        await this._request(target, '/api/localsend/v2/upload' + q, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, stream: it.path });
        sent++;
      }
    } catch (e) {
      // 失败即取消会话，避免对方挂起
      try { await this._request(target, '/api/localsend/v2/cancel?sessionId=' + encodeURIComponent(j.sessionId || ''), { method: 'POST' }); } catch (e2) {}
      throw e;
    }
    return { ok: true, sent };
  }

  /** http/https 请求（自签证书放宽校验） */
  _request(target, urlPath, { method = 'GET', headers = {}, body = null, stream = null } = {}) {
    const proto = (target.protocol || 'https') === 'http' ? http : https;
    return new Promise((resolve, reject) => {
      const req = proto.request(
        { host: target.host, port: target.port || 53317, path: urlPath, method, headers, timeout: 20000, rejectUnauthorized: false },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (stream) fs.createReadStream(stream).on('error', reject).pipe(req);
      else if (body != null) req.end(body);
      else req.end();
    });
  }

  /* ---------------- 发现 ---------------- */
  _startUdp() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => {
      this.engine.logger && this.engine.logger.warn('localsend', 'LocalSend 组播监听失败', e.message);
    });
    sock.on('message', (buf, rinfo) => {
      let msg = null;
      try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
      if (!msg || !msg.fingerprint || msg.fingerprint === this.fingerprint) return;
      const recorded = this._recordDevice(msg, rinfo.address);
      if (msg.announce && recorded) {
        // 回应注册（UDP announce:false 应答）
        const reply = Buffer.from(JSON.stringify({ ...this.selfInfo(), announce: false }));
        try { sock.send(reply, 0, reply.length, rinfo.port, rinfo.address); } catch (e) {}
      }
    });
    sock.bind(LS_UDP_PORT, () => {
      try { sock.addMembership(LS_MULTICAST); } catch (e) {}
      this._announce();
      this.announceTimer = setInterval(() => this._announce(), LS_ANNOUNCE_INTERVAL);
      this.engine.logger && this.engine.logger.info('localsend', 'LocalSend 组播发现已启动（224.0.0.167:53317）');
    });
  }

  _announce() {
    if (this.stopped || !this.sock) return;
    const payload = Buffer.from(JSON.stringify({ ...this.selfInfo(), announce: true }));
    try { this.sock.send(payload, 0, payload.length, LS_UDP_PORT, LS_MULTICAST); } catch (e) {}
  }

  /** 记录发现的 LocalSend 设备并注入本站设备表；返回是否为有效记录 */
  _recordDevice(msg, ip) {
    const host = (ip || '').replace(/^::ffff:/, '');
    if (!host || !msg.alias) return false;
    const fp = String(msg.fingerprint).slice(0, 64);
    const prev = this.discovered.get(fp);
    const entry = {
      fingerprint: fp,
      alias: String(msg.alias).slice(0, 40),
      host,
      port: Number(msg.port) || 53317,
      protocol: msg.protocol === 'http' ? 'http' : 'https',
      deviceModel: String(msg.deviceModel || '').slice(0, 60),
      deviceType: String(msg.deviceType || 'desktop').slice(0, 20),
      lastSeen: Date.now(),
    };
    this.discovered.set(fp, entry);
    const deviceId = 'ls-' + fp.slice(0, 16);
    const dm = this.engine.deviceManager;
    if (dm) {
      dm.upsert({
        deviceId,
        deviceName: entry.alias,
        os: entry.deviceModel || 'LocalSend',
        deviceType: entry.deviceType,
        host: entry.host,
        port: entry.port,
        version: String(msg.version || '2.x'),
        fingerprint: fp,
        via: 'localsend',
        lsProtocol: entry.protocol,
      });
    }
    return true;
  }

  /** 过期清理：会话 10 分钟、30 秒无心跳的 LocalSend 设备标记离线 */
  _prune() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.ts > LS_SESSION_TTL) {
        s.status = 'expired';
        for (const m of s.files.values()) if (m.path && !m.received) { try { fs.unlinkSync(m.path); } catch (e) {} }
        this.sessions.delete(id);
      }
    }
    // 拉取供给过期（10 分钟 TTL）
    for (const [id, o] of this.offers) {
      if (now - o.ts > LS_SESSION_TTL) this.offers.delete(id);
    }
    const dm = this.engine.deviceManager;
    for (const [fp, d] of this.discovered) {
      if (now - d.lastSeen > LS_DEVICE_TTL) {
        this.discovered.delete(fp);
        if (dm) {
          const dev = dm.get('ls-' + fp.slice(0, 16));
          if (dev && dev.via === 'localsend') dm.markOffline('ls-' + fp.slice(0, 16));
        }
      }
    }
  }

  /** openssl 自签证书（1 年有效期，复用已存在的） */
  _ensureCert() {
    const dir = path.join(this.engine.dataDir, 'localsend-cert');
    fs.mkdirSync(dir, { recursive: true });
    const keyPath = path.join(dir, 'key.pem');
    const certPath = path.join(dir, 'cert.pem');
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }
    const { execFile } = require('child_process');
    return new Promise((resolve, reject) => {
      const args = ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '3650', '-nodes', '-subj', '/CN=lan-file-share'];
      execFile('openssl', args, { timeout: 15000 }, (err) => {
        if (err) return reject(err);
        try { resolve({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }); } catch (e) { reject(e); }
      });
    }).then((r) => {
      this.engine.logger && this.engine.logger.info('localsend', '自签证书已生成（CN=lan-file-share，10 年）');
      return r;
    });
  }
}

module.exports = LocalSendGateway;
