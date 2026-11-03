'use strict';

const os = require('os');
const http = require('http');

/**
 * 逐 IP 降级发现：组播/广播在 AP 隔离、跨交换机、部分路由器安全策略下会丢包，
 * 此时退化为对同子网逐 IP 探测 /api/self（短超时 + 并发），命中即注入设备表。
 * 仅扫描 RFC1918 私网 /24 段，排除本机地址；探测并发 64，单地址 600ms 超时。
 */
const PRIVATE_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** 收集本机私网 IPv4 */
function localPrivateIps() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      if (PRIVATE_RE.test(it.address)) out.push(it.address);
    }
  }
  return out;
}

/** 由本机 IP 生成候选地址（同 /24，排除本机） */
function candidates(ips, extraPorts) {
  const seen = new Set();
  const addrs = new Set();
  for (const ip of ips) {
    const parts = ip.split('.');
    for (let i = 1; i <= 254; i++) {
      const cand = `${parts[0]}.${parts[1]}.${parts[2]}.${i}`;
      if (cand === ip || seen.has(cand)) continue;
      seen.add(cand);
      addrs.add(cand);
    }
  }
  const ports = Array.isArray(extraPorts) && extraPorts.length ? extraPorts : [8080];
  const list = [];
  for (const a of addrs) for (const p of ports) list.push({ host: a, port: p });
  return list;
}

/** 探测单个地址，返回对端 self 信息或 null */
function probe(host, port, timeout = 600) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { req.destroy(); } catch (e) {}
      resolve(v);
    };
    const req = http.get({ host, port, path: '/api/self', timeout }, (res) => {
      if (res.statusCode !== 200) return finish(null);
      let body = '';
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 8192) return finish(null);
        body += c;
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j && j.deviceId) finish({ ...j, host, port });
          else finish(null);
        } catch (e) { finish(null); }
      });
      res.on('error', () => finish(null));
    });
    req.on('timeout', () => finish(null));
    req.on('error', () => finish(null));
  });
}

/** 全量扫描：并发探测所有候选，返回命中列表（去重 deviceId） */
async function scan({ ips, ports, timeout = 600, concurrency = 64, onHit } = {}) {
  const list = candidates(ips || localPrivateIps(), ports);
  const found = new Map();
  let idx = 0;
  const worker = async () => {
    while (idx < list.length) {
      const { host, port } = list[idx++];
      const info = await probe(host, port, timeout);
      if (info && !found.has(info.deviceId)) {
        found.set(info.deviceId, info);
        if (onHit) onHit(info);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return [...found.values()];
}

module.exports = { localPrivateIps, candidates, probe, scan, PRIVATE_RE };
