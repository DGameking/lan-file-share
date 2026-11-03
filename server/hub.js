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

  engine.app.post('/api/hub/register', (req, res) => {
    const b = req.body || {};
    if (!b.deviceId) return res.status(400).json({ error: 'bad_request' });
    const now = Date.now();
    peers.set(b.deviceId, {
      deviceId: String(b.deviceId), deviceName: String(b.deviceName || '未知设备').slice(0, 60),
      os: String(b.os || '').slice(0, 30), version: String(b.version || '').slice(0, 20),
      port: Number(b.port) || 8080, ip: engine.clientIp(req), ts: now,
    });
    const peerList = [...peers.values()].filter((p) => p.deviceId !== b.deviceId && now - p.ts <= PEER_TTL);
    const incoming = [...relays.values()]
      .filter((r) => r.target === b.deviceId)
      .map((r) => ({ relayId: r.id, token: r.token, from: r.from, fromName: (peers.get(r.from) || {}).deviceName || r.from, name: r.name, size: r.size, sha256: r.sha256, mtime: r.mtime }));
    res.json({ ok: true, peers: peerList, incoming, hub: self() });
  });

  engine.app.get('/api/hub/devices', (req, res) => {
    const now = Date.now();
    res.json({ ok: true, devices: [...peers.values()].filter((p) => now - p.ts <= PEER_TTL), hub: self() });
  });

  engine.app.post('/api/hub/relay', async (req, res) => {
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
  });

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
}

module.exports = { register };
