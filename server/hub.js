'use strict';

const fs = require('fs');
const path = require('path');

const { shortId } = require('../shared/utils');
const { saveMultipartFiles } = require('./recv-util');

const PEER_TTL = 30 * 1000; // 注册保活窗口（客户端 5s 轮询）
const RELAY_TTL = 24 * 60 * 60 * 1000;

/**
 * 会合点中心端（Rendezvous Hub）——跑在跨网段可达的设备上（如光猫层的飞牛 NAS）。
 * 各网段设备主动出站注册（NAT 只拦入站，出站必然可达），中心聚合设备表并做
 * 文件暂存转发：发送方 → 中心（出站）→ 接收方轮询拉取（出站），全程无需 NAT 穿透。
 * - POST /api/hub/register  心跳注册，返回 {peers, incoming}
 * - GET  /api/hub/devices   调试用：当前设备表
 * - POST /api/hub/relay?target=&from=  中继投送（multipart）
 * - GET  /api/hub/relay/:id?token=&deviceId=  接收方拉取（一次性，取后即删）
 */
function register(engine) {
  const dir = path.join(engine.dataDir, 'relay');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}

  const peers = new Map(); // deviceId -> {deviceId, deviceName, os, version, port, ip, ts}
  const relays = new Map(); // relayId -> {target, from, name, size, sha256, mtime, file, token, ts}

  setInterval(() => {
    const now = Date.now();
    for (const [id, p] of peers) if (now - p.ts > PEER_TTL) peers.delete(id);
    for (const [id, r] of relays) if (now - r.ts > RELAY_TTL) { try { fs.unlinkSync(r.file); } catch (e) {} relays.delete(id); }
  }, 10 * 1000).unref();

  const self = () => ({ deviceId: engine.deviceId, deviceName: engine.deviceName, version: engine.version, port: engine.port, ip: '127.0.0.1', os: process.platform });

  /* ---------- 守卫：每 IP 限流 + 中继并发上限（防滥用打满磁盘/带宽） ---------- */
  const buckets = new Map(); // ip -> {tokens, ts}
  const RATE_WINDOW = 60 * 1000;
  let activeRelays = 0;
  const MAX_CONCURRENT = 3;
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (now - b.ts > RATE_WINDOW * 2) buckets.delete(ip);
  }, 120 * 1000).unref();
  function rateOk(req, res, max) {
    const ip = engine.clientIp(req);
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.ts > RATE_WINDOW) b = { tokens: max, ts: now };
    b.tokens -= 1;
    b.ts = now;
    buckets.set(ip, b);
    if (b.tokens < 0) {
      res.status(429).json({ error: 'rate_limited' });
      return false;
    }
    return true;
  }
  const guard = (handler, { rate = 120, trackRelay = false } = {}) => (req, res) => {
    if (!rateOk(req, res, rate)) return;
    if (trackRelay) {
      if (activeRelays >= MAX_CONCURRENT) return res.status(429).json({ error: 'busy' });
      activeRelays++;
      res.on('finish', () => { activeRelays--; });
    }
    handler(req, res);
  };

  engine.app.post('/api/hub/register', guard((req, res) => {
    const b = req.body || {};
    if (!b.deviceId) return res.status(400).json({ error: 'bad_request' });
    const now = Date.now();
    peers.set(b.deviceId, {
      deviceId: String(b.deviceId), deviceName: String(b.deviceName || '未知设备').slice(0, 60),
      os: String(b.os || '').slice(0, 30), version: String(b.version || '').slice(0, 20),
      deviceType: String(b.deviceType || '').slice(0, 20), alias: String(b.alias || '').slice(0, 40),
      port: Number(b.port) || 8080, ip: engine.clientIp(req), ts: now,
    });
    const peerList = [...peers.values()].filter((p) => p.deviceId !== b.deviceId && now - p.ts <= PEER_TTL);
    const incoming = [...relays.values()]
      .filter((r) => r.target === b.deviceId)
      .map((r) => ({ relayId: r.id, token: r.token, from: r.from, fromName: (peers.get(r.from) || {}).deviceName || r.from, name: r.name, size: r.size, sha256: r.sha256, mtime: r.mtime }));
    res.json({ ok: true, peers: peerList, incoming, hub: self() });
  }, { rate: 60 }));

  engine.app.get('/api/hub/devices', (req, res) => {
    const now = Date.now();
    res.json({ ok: true, devices: [...peers.values()].filter((p) => now - p.ts <= PEER_TTL), hub: self() });
  });

  engine.app.post('/api/hub/relay', guard(async (req, res) => {
    const target = String(req.query.target || '');
    const from = String(req.query.from || '');
    if (!target || target === from) return res.status(400).json({ error: 'bad_args' });
    if (!peers.has(target) && target !== engine.deviceId) return res.status(404).json({ error: 'target_not_registered' });
    try {
      const saved = await saveMultipartFiles(req, dir, {});
      const out = [];
      for (const f of saved) {
        const id = shortId();
        relays.set(id, {
          id, target, from, name: f.name, size: f.size, mime: f.mime,
          sha256: String(req.query.sha256 || ''), mtime: Number(req.query.mtime) || 0,
          file: path.join(dir, f.fileId), token: shortId(), ts: Date.now(),
        });
        out.push({ relayId: id, name: f.name, size: f.size });
      }
      engine.logEvent({ event_type: 'hub_relay', device_name: from, ip: engine.clientIp(req), target, result: 'success', detail: { count: out.length } });
      res.json({ ok: true, relays: out });
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: e.message || 'bad_request' });
    }
  }, { rate: 30, trackRelay: true }));

  engine.app.get('/api/hub/relay/:id', (req, res) => {
    const r = relays.get(String(req.params.id || ''));
    if (!r) return res.status(404).json({ error: 'relay_not_found' });
    if (req.query.token !== r.token || req.query.deviceId !== r.target) return res.status(403).json({ error: 'forbidden' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="relay.bin"`);
    res.setHeader('X-Relay-Name', encodeURIComponent(r.name));
    fs.createReadStream(r.file)
      .pipe(res)
      .on('finish', () => { try { fs.unlinkSync(r.file); } catch (e) {} relays.delete(r.id); });
  });

  /* ---------- 中继分块上传（大文件断点续传；拼装后进入一次性拉取流程） ---------- */
  const partsRoot = path.join(dir, '.parts');
  try { fs.mkdirSync(partsRoot, { recursive: true }); } catch (e) {}
  const hubChunkSha256 = (file) =>
    new Promise((resolve) => {
      const h = require('crypto').createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(''));
    });

  // 分块暂存目录清理：超 24h 的未完成中继按最旧删除
  setInterval(() => {
    const now = Date.now();
    try {
      for (const n of fs.readdirSync(partsRoot)) {
        const p = path.join(partsRoot, n);
        try {
          if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
        } catch (e) {}
      }
    } catch (e) {}
  }, 60 * 60 * 1000).unref();

  engine.app.post('/api/hub/relay-chunk', guard((req, res) => {
    const uploadId = String(req.query.uploadId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const index = Number.parseInt(req.query.index, 10);
    if (!uploadId || !(index >= 0) || index > 100000) return res.status(400).json({ error: 'bad_args' });
    const uDir = path.join(partsRoot, uploadId);
    try { fs.mkdirSync(uDir, { recursive: true }); } catch (e) {}
    const out = fs.createWriteStream(path.join(uDir, `${index}.part`));
    req.pipe(out);
    out.on('finish', async () => {
      const want = String(req.query.sha256 || '');
      if (want) {
        const actual = await hubChunkSha256(path.join(uDir, `${index}.part`));
        if (actual && actual.toLowerCase() !== want.toLowerCase()) {
          try { fs.unlinkSync(path.join(uDir, `${index}.part`)); } catch (e) {}
          return res.status(422).json({ error: 'chunk_checksum_mismatch', index });
        }
      }
      res.json({ ok: true });
    });
    out.on('error', () => { if (!res.headersSent) res.status(500).json({ error: 'write_failed' }); });
  }, { rate: 600 }));

  engine.app.get('/api/hub/relay-chunk/status', (req, res) => {
    const uploadId = String(req.query.uploadId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    if (!uploadId) return res.status(400).json({ error: 'bad_args' });
    let received = [];
    try {
      received = fs.readdirSync(path.join(partsRoot, uploadId)).filter((n) => n.endsWith('.part')).map((n) => Number.parseInt(n, 10)).filter(Number.isFinite);
    } catch (e) {}
    res.json({ ok: true, received });
  });

  engine.app.post('/api/hub/relay-chunk/finish', guard(async (req, res) => {
    const target = String(req.query.target || '');
    const from = String(req.query.from || '');
    if (!target || target === from) return res.status(400).json({ error: 'bad_args' });
    if (!peers.has(target) && target !== engine.deviceId) return res.status(404).json({ error: 'target_not_registered' });
    const b = req.body || {};
    const uploadId = String(b.uploadId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const total = Number(b.total);
    const size = Number(b.size) || 0;
    if (!uploadId || !(total >= 1) || total > 100000) return res.status(400).json({ error: 'bad_args' });
    const uDir = path.join(partsRoot, uploadId);
    let parts = [];
    try {
      parts = fs.readdirSync(uDir).filter((n) => n.endsWith('.part')).map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n) && n < total).sort((a, b2) => a - b2);
    } catch (e) {}
    if (parts.length !== total) return res.status(409).json({ error: 'incomplete', have: parts.length, total });

    const safeName = path.basename(String(b.name || 'file')).replace(/[\\/:*?"<>|]/g, '_') || 'file';
    const id = shortId();
    const assembled = path.join(dir, id + '.bin');
    // 配额预检：中继目录超限时拒收
    const quotaBytes = Math.round((Number(engine.settings.dropQuotaGB) > 0 ? Number(engine.settings.dropQuotaGB) : 2) * 1024 * 1024 * 1024);
    let relayTotal = 0;
    try { for (const n of fs.readdirSync(dir)) { try { relayTotal += fs.statSync(path.join(dir, n)).size; } catch (e) {} } } catch (e) {}
    if (relayTotal >= quotaBytes) return res.status(413).json({ error: 'quota_exceeded' });

    try {
      const out = fs.createWriteStream(assembled);
      for (const i of parts) {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(path.join(uDir, `${i}.part`));
          rs.pipe(out, { end: false });
          rs.on('end', resolve);
          rs.on('error', reject);
        });
      }
      await new Promise((r) => out.end(r));
      fs.rmSync(uDir, { recursive: true, force: true });
    } catch (e) {
      try { fs.unlinkSync(assembled); } catch (e2) {}
      return res.status(500).json({ error: 'assemble_failed' });
    }
    // 全量 sha256 校验（发送端 ≤64MB 时提供）
    const want = String(b.sha256 || '');
    if (want) {
      const actual = await hubChunkSha256(assembled);
      if (!actual || actual.toLowerCase() !== want.toLowerCase()) {
        try { fs.unlinkSync(assembled); } catch (e) {}
        return res.status(422).json({ error: 'checksum_mismatch' });
      }
    }
    const rid = shortId();
    relays.set(rid, {
      id: rid, target, from, name: safeName, size: fs.existsSync(assembled) ? fs.statSync(assembled).size : size, mime: 'application/octet-stream',
      sha256: want, mtime: Number(b.mtime) || 0, file: assembled, token: shortId(), ts: Date.now(),
    });
    engine.logEvent({ event_type: 'hub_relay', device_name: from, ip: engine.clientIp(req), target, result: 'success', detail: { count: 1, chunked: true, size } });
    res.json({ ok: true, relays: [{ relayId: rid, name: safeName, size }] });
  }, { rate: 60, trackRelay: true }));
}

module.exports = { register };
