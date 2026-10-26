'use strict';

const net = require('net');

/** 检测指定 TCP 端口是否可绑定（未被占用） */
function isPortAvailable(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(false);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/** 在备选范围内寻找一个可用端口 */
async function findAvailablePort(preferred, range) {
  if (await isPortAvailable(preferred)) return preferred;
  for (const p of range || []) {
    if (p === preferred) continue;
    if (await isPortAvailable(p)) return p;
  }
  // 兜底：随机高端口
  const rnd = 10000 + Math.floor(Math.random() * 20000);
  if (await isPortAvailable(rnd)) return rnd;
  throw new Error('未找到可用端口');
}

/** 探测目标主机端口是否可达（用于设备在线 Ping） */
function pingHost(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout });
    const start = Date.now();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch (e) {}
      resolve(ok ? Date.now() - start : -1);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

module.exports = { isPortAvailable, findAvailablePort, pingHost };
