'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Readable } = require('stream');

const { shortId } = require('../shared/utils');

/**
 * 会合点客户端：向配置的中心端（NAS 等）出站注册，聚合跨网段设备并拉取中继文件。
 * - 每个会合点注册 {deviceId, port...} → 返回 peers 注入 deviceManager（标记 relay）
 * - 返回 incoming 中继清单 → 流式下载到接收目录 → sha256 校验 → drop.incoming 通知
 * - 暴露 status：连接状态/最后同步时间/失败原因（设置页状态灯与自检使用）
 * 全程出站连接，双 NAT 环境必然可达。
 */
class RendezvousClient {
  constructor(engine) {
    this.engine = engine;
    this.timer = null;
    this._stop = false;
    this.status = { enabled: false, hubs: [], connected: false, lastSync: 0, lastError: '', peers: 0 };
  }

  hubs() {
    const raw = String((this.engine.settings && this.engine.settings.rendezvous) || '');
    return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll().catch(() => {}), 5000);
    this.poll().catch(() => {});
  }

  stop() {
    this._stop = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  request(hub, method, p, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
      const r = http.request(`http://${hub}${p}`, {
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } : headers,
        timeout: 6000,
      }, (res) => {
        let out = [];
        res.on('data', (c) => out.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(out), headers: res.headers }));
      });
      r.on('error', reject);
      r.on('timeout', () => { try { r.destroy(new Error('timeout')); } catch (e) {} });
      if (data) r.write(data);
      r.end();
    });
  }

  async poll() {
    const engine = this.engine;
    const hubs = this.hubs();
    this.status.enabled = hubs.length > 0;
    this.status.hubs = hubs.slice();
    if (!hubs.length) {
      this.status.connected = false;
      this.status.lastError = '';
      return;
    }
    let okAny = false;
    let lastErr = '';
    let peerCount = 0;
    for (const hub of hubs) {
      let j;
      try {
        const r = await this.request(hub, 'POST', '/api/hub/register', {
          deviceId: engine.deviceId, deviceName: engine.deviceName,
          port: engine.httpPort || engine.port || 8080, os: process.platform, version: engine.version || '',
        });
        if (r.status !== 200) { lastErr = `${hub}: HTTP ${r.status}`; continue; }
        j = JSON.parse(r.body.toString());
      } catch (e) { lastErr = `${hub}: ${e.message || '网络不可达'}`; continue; }
      okAny = true;
      peerCount += (j.peers || []).length;

      // 跨网段对端注入设备表（标记 relay，直连地址保留供同网段时使用）
      for (const p of j.peers || []) {
        if (p.deviceId === engine.deviceId) continue;
        const dev = engine.deviceManager.upsert({
          deviceId: p.deviceId, deviceName: p.deviceName, os: p.os,
          host: p.ip, port: p.port, version: p.version,
          relay: true, relayHub: hub,
        });
      }

      // 拉取中继文件
      for (const inc of j.incoming || []) {
        this.fetchRelay(hub, inc).catch(() => {});
      }
    }
    if (okAny) {
      this.status.connected = true;
      this.status.lastSync = Date.now();
      this.status.lastError = '';
      this.status.peers = peerCount;
    } else {
      this.status.connected = false;
      this.status.lastError = lastErr || '未知的会合点错误';
    }
  }

  async fetchRelay(hub, inc) {
    const engine = this.engine;
    const dir = engine.receivedDir || path.join(engine.dataDir, 'received');
    fs.mkdirSync(dir, { recursive: true });
    const safeName = path.basename(String(inc.name || 'file')).replace(/[\\/:*?"<>|]/g, '_') || 'file';
    const target = path.join(dir, shortId() + '_' + safeName);

    await new Promise((resolve, reject) => {
      const r = http.get(`http://${hub}/api/hub/relay/${inc.relayId}?token=${encodeURIComponent(inc.token)}&deviceId=${encodeURIComponent(engine.deviceId)}`, { timeout: 120000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const out = fs.createWriteStream(target);
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      });
      r.on('error', reject);
    });

    // sha256 校验
    if (inc.sha256) {
      const actual = await new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(target).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
      });
      if (String(actual).toLowerCase() !== String(inc.sha256).toLowerCase()) {
        try { fs.unlinkSync(target); } catch (e) {}
        engine.logEvent({ event_type: 'hub_relay', device_name: inc.fromName || inc.from, result: 'checksum_mismatch' });
        return;
      }
    }
    if (inc.mtime > 0) {
      try {
        const d = new Date(Math.min(inc.mtime, Date.now() + 86400000));
        fs.utimesSync(target, d, d);
      } catch (e) {}
    }

    const from = String(inc.fromName || inc.from || '未知设备').slice(0, 60);
    engine.broadcast('drop.incoming', { from, files: [{ fileId: path.basename(target), name: safeName, size: inc.size || 0, relayed: true }], ts: Date.now(), relayed: true });
    engine.logger && engine.logger.info('hub', `经会合点收到中继文件（来自 ${from}）`, { name: safeName });
    engine.logEvent({ event_type: 'file_receive', device_name: from, result: 'success', detail: { count: 1, size: inc.size || 0, relayed: true } });
  }
}

module.exports = { RendezvousClient };
