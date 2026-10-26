'use strict';

const { EventEmitter } = require('events');
const dgram = require('dgram');
const { UDP_PORT, PROTOCOL, UDP_PORT_RANGE, getBroadcastAddresses } = require('../shared/constants');

/**
 * UDP 广播心跳发现。
 * - 每隔 interval 秒向各网卡广播心跳包（JSON over UDP）
 * - 监听同端口收到其他设备心跳，解析后 emit('device', info)
 * - 支持主动探测 probe()：发送一次心跳，对端回应
 * 端口冲突时自动在 UDP_PORT_RANGE 内重试。
 */
class UdpDiscovery extends EventEmitter {
  constructor({ port = UDP_PORT, interval = 3, selfId = null } = {}) {
    super();
    this.port = port;
    this.interval = interval;
    this.selfId = selfId;
    this.sock = null;
    this.getHeartbeat = null;
    this._timer = null;
  }

  start({ getHeartbeat, portRange = UDP_PORT_RANGE }) {
    this.getHeartbeat = getHeartbeat;
    return new Promise((resolve, reject) => {
      const ports = portRange && portRange.length ? portRange : [this.port];
      let idx = 0;
      const attempt = () => {
        const p = ports[idx];
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        sock.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && idx < ports.length - 1) {
            idx++;
            attempt();
          } else {
            reject(err);
          }
        });
        sock.bind(p, () => {
          try {
            sock.setBroadcast(true);
          } catch (e) {}
          this.sock = sock;
          this.port = p;
          sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
          sock.on('error', (err) => this.emit('error', err));
          resolve();
        });
      };
      attempt();
    });
  }

  _onMessage(msg, rinfo) {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (e) {
      return;
    }
    if (!data || data.protocol !== PROTOCOL) return;
    if (this.selfId && data.deviceId === this.selfId) return;
    this.emit('device', {
      deviceId: data.deviceId,
      deviceName: data.deviceName,
      host: rinfo.address,
      port: data.port || this.port,
      os: data.os,
      version: data.version,
      sharedCount: data.sharedCount,
      status: data.status,
    });
  }

  _send() {
    if (!this.getHeartbeat) return;
    const payload = Buffer.from(JSON.stringify(this.getHeartbeat()));
    const addrs = getBroadcastAddresses();
    for (const addr of addrs) {
      try {
        this.sock.send(payload, 0, payload.length, this.port, addr);
      } catch (e) {
        /* ignore */
      }
    }
  }

  startHeartbeat() {
    this._send();
    this._timer = setInterval(() => this._send(), this.interval * 1000);
  }

  stopHeartbeat() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** 主动探测一轮 */
  probe() {
    this._send();
  }

  stop() {
    this.stopHeartbeat();
    if (this.sock) {
      try {
        this.sock.close();
      } catch (e) {}
      this.sock = null;
    }
  }
}

module.exports = UdpDiscovery;
