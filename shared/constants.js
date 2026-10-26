'use strict';

const os = require('os');

/** 协议与发现相关常量 */
const PROTOCOL = 'LanFileShare/1.0';
const MDNS_TYPE = '_lanfileshare._tcp';
const MDNS_PROTO = 'tcp';
const UDP_PORT = 9527;
const DEFAULT_HTTP_PORT = 8080;
const SERVICE_NAME = 'LanFileShare';

/** 共享权限枚举 */
const PERMISSION = {
  READ: 'read',
  WRITE: 'write',
  DELETE: 'delete',
};

/** 心跳间隔 / 离线判定 (秒) */
const HEARTBEAT_INTERVAL = 3;
const OFFLINE_TIMEOUT = 10;
const DISCOVER_TIMEOUT = 5000;

/** 备用 UDP 端口范围 */
const UDP_PORT_RANGE = [9527, 9528, 9529, 9530, 9531, 9532, 9533, 9534, 9535, 9536, 9537];

/** 大文件分块大小 (5MB) */
const CHUNK_SIZE = 5 * 1024 * 1024;

/** 获取所有非内部 IPv4 地址 */
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        result.push({ name, address: iface.address, mac: iface.mac });
      }
    }
  }
  return result;
}

/** 虚拟网卡识别 */
function isVirtualInterface(name) {
  return /(Virtual|VMware|VMnet|Hyper-V|vEthernet|docker|vbox|utun|tap|tun|ZeroTier|Tailscale|wg|Loopback|多开|模拟器|VirtualBox)/i.test(name);
}

/** 有线/无线物理网卡优先 */
function isPhysicalInterface(name) {
  return /(以太网|Ethernet|WLAN|Wi-?Fi|无线|本地连接|en0|eth0)/i.test(name);
}

/** 路由级主 IP 检测（异步预热，结果缓存）——多网卡/虚拟机环境下比启发式准确 */
let _routeIp = null;
function _warmRouteIp() {
  try {
    const dgram = require('dgram');
    const s = dgram.createSocket('udp4');
    const done = (addr) => {
      if (addr && addr !== '0.0.0.0' && !/^127\./.test(addr)) _routeIp = addr;
      try { s.close(); } catch (e) {}
    };
    s.on('error', () => done(null));
    s.connect(53, '8.8.8.8', () => {
      try { done(s.address().address); } catch (e) { done(null); }
    });
  } catch (e) {}
}
_warmRouteIp();

/** 选择主用 IP：优先默认路由网卡（异步预热结果），否则按「物理网卡 + 私网段」启发式 */
function getPrimaryIP() {
  const ips = getLocalIPs();
  const usable = ips.filter((i) => !/^169\.254\./.test(i.address) && !/^127\./.test(i.address));
  if (_routeIp) return _routeIp;
  const real = usable.filter((i) => !isVirtualInterface(i.name));
  const scored = (real.length ? real : usable).slice().sort((a, b) => {
    const s = (i) => {
      let v = 0;
      if (isPhysicalInterface(i.name)) v -= 4;
      if (/^192\.168\./.test(i.address) || /^10\./.test(i.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) v -= 2;
      return v;
    };
    return s(a) - s(b);
  });
  return scored.length ? scored[0].address : '127.0.0.1';
}

/** 获取所有广播地址（每个网卡对应一个） */
function getBroadcastAddresses() {
  const ifaces = os.networkInterfaces();
  const broadcasts = [];
  for (const name of Object.keys(ifaces)) {
    if (isVirtualInterface(name)) continue;
    for (const iface of ifaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const parts = iface.address.split('.');
      const maskParts = (iface.netmask || '255.255.255.0').split('.');
      const bcast = parts
        .map((p, i) => (parseInt(p, 10) | (~parseInt(maskParts[i], 10) & 255)) & 255)
        .join('.');
      if (!broadcasts.includes(bcast)) broadcasts.push(bcast);
    }
  }
  if (broadcasts.length === 0) broadcasts.push('255.255.255.255');
  return broadcasts;
}

module.exports = {
  PROTOCOL,
  MDNS_TYPE,
  MDNS_PROTO,
  UDP_PORT,
  DEFAULT_HTTP_PORT,
  SERVICE_NAME,
  PERMISSION,
  HEARTBEAT_INTERVAL,
  OFFLINE_TIMEOUT,
  DISCOVER_TIMEOUT,
  UDP_PORT_RANGE,
  CHUNK_SIZE,
  getLocalIPs,
  getPrimaryIP,
  getBroadcastAddresses,
  isVirtualInterface,
};
