'use strict';

const EventEmitter = require('events');

/**
 * 首次配对管理器：维护待确认请求，UI 决定允许/拒绝后回调。
 */
class PairingManager extends EventEmitter {
  constructor() {
    super();
    this.pending = new Map();
  }

  /** 收到陌生设备，发起配对请求 */
  request(device) {
    this.pending.set(device.device_id || device.deviceId, device);
    this.emit('request', device);
  }

  /** UI 决策结果 */
  resolve(deviceId, allowed) {
    const d = this.pending.get(deviceId);
    if (d) {
      this.pending.delete(deviceId);
      this.emit('resolved', { device: d, allowed });
    }
    return d;
  }

  isPending(deviceId) {
    return this.pending.has(deviceId);
  }
}

module.exports = PairingManager;
