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
  return /(Virtual|VMware|Hyper-V|vEthernet|docker|vbox|utun|tap|tun|ZeroTier|Tailscale|wg)/i.test(name);
}

/** 选择主用 IP：优先真实网卡，排除链路本地与虚拟网卡 */
function getPrimaryIP() {
  const ips = getLocalIPs();
  const real = ips.filter((i) => !/^169\.254\./.test(i.address) && !isVirtualInterface(i.name));
  const pick = real[0] || ips[0];
  return pick ? pick.address : '127.0.0.1';
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
