'use strict';

const { EventEmitter } = require('events');
const bonjour = require('bonjour')();
const { MDNS_TYPE, PROTOCOL } = require('../shared/constants');

/**
 * mDNS (Bonjour / Zeroconf) 服务发现。
 * 发布 _lanfileshare._tcp.local 服务，并浏览局域网内同类服务。
 */
class MdnsDiscovery extends EventEmitter {
  constructor() {
    super();
    this.publisher = null;
    this.browser = null;
  }

  publish({ name, port, deviceId, os, version, sharedCount }) {
    if (this.publisher) {
      try { this.publisher.stop(); } catch (e) {}
    }
    this.publisher = bonjour.publish({
      name: `LanFileShare_${deviceId}`,
      type: MDNS_TYPE,
      port,
      txt: {
        protocol: PROTOCOL,
        deviceId,
        os: os || 'Unknown',
        version: version || '1.0.0',
        sharedCount: String(sharedCount || 0),
      },
    });
    // mDNS 名称与局域网内其他实例冲突时 bonjour 会抛 error，
    // 该通道为辅助发现（UDP 广播为主），冲突不致命，吞掉即可避免进程崩溃。
    this.publisher.on('error', (err) => {
      this.emit('warning', err);
    });
  }

  browse() {
    this.browser = bonjour.find({ type: MDNS_TYPE }, () => {});
    this.browser.on('up', (svc) => {
      const txt = svc.txt || {};
      this.emit('device', {
        deviceId: txt.deviceId,
        deviceName: svc.name ? svc.name.replace(/^LanFileShare_/, '') : svc.name,
        host: svc.host,
        port: svc.port,
        os: txt.os,
        version: txt.version,
        sharedCount: parseInt(txt.sharedCount || '0', 10),
      });
    });
    this.browser.on('down', (svc) => {
      const txt = svc.txt || {};
      this.emit('down', txt.deviceId);
    });
  }

  stop() {
    try {
      if (this.publisher) this.publisher.stop();
    } catch (e) {}
    try {
      if (this.browser) this.browser.stop();
    } catch (e) {}
    try {
      bonjour.destroy();
    } catch (e) {}
  }
}

module.exports = MdnsDiscovery;
