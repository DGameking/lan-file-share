'use strict';

const EventEmitter = require('events');

/**
 * 内存设备表，负责在线/离线状态、信任/黑名单、分组。
 * 不直接访问 DB，由上层（core）在事件回调中做持久化。
 */
class DeviceManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
  }

  /** 合并或更新设备信息，返回合并后的设备 */
  upsert(info) {
    const existing = this.devices.get(info.deviceId);
    const wasOnline = existing && existing.is_online;
    const merged = {
      device_id: info.deviceId || info.device_id,
      device_name: info.deviceName || info.device_name,
      os: info.os || 'Unknown',
      device_type: info.deviceType || (existing ? existing.device_type : ''),
      alias: info.alias != null ? info.alias : (existing ? existing.alias : ''),
      host: info.host || info.ip,
      port: info.port,
      version: info.version || '0.0.0',
      public_key: info.publicKey || info.public_key || null,
      fingerprint: info.fingerprint || null,
      group_name: existing ? existing.group_name : info.group_name || '默认',
      remark: existing ? existing.remark : info.remark || '',
      is_trusted: existing ? existing.is_trusted : 0,
      is_blacklisted: existing ? existing.is_blacklisted : 0,
      is_online: true,
      last_seen: Date.now(),
      latency: info.latency != null ? info.latency : existing ? existing.latency : null,
      relay: info.relay != null ? !!info.relay : existing ? !!existing.relay : false,
      relay_hub: info.relayHub || (existing ? existing.relay_hub : null),
      direct_port: info.directPort != null ? info.directPort : (existing ? existing.direct_port : null),
      via: info.via != null ? info.via : (existing ? existing.via : ''),
      ls_protocol: info.lsProtocol || (existing ? existing.ls_protocol : null),
      starred: info.starred != null ? (info.starred ? 1 : 0) : existing ? (existing.starred ? 1 : 0) : 0,
    };
    this.devices.set(merged.device_id, merged);
    if (!wasOnline) this.emit('online', merged);
    this.emit('update', this.list());
    return merged;
  }

  /** 标记离线 */
  markOffline(id) {
    const d = this.devices.get(id);
    if (!d) return;
    d.is_online = false;
    d.last_seen = Date.now();
    this.emit('offline', d);
    this.emit('update', this.list());
  }

  /** 清理超过 timeout 未心跳的设备 */
  prune(timeout = 10000) {
    const now = Date.now();
    for (const d of this.devices.values()) {
      if (d.is_online && now - d.last_seen > timeout) {
        this.markOffline(d.device_id);
      }
    }
  }

  setTrust(id, trusted) {
    const d = this.devices.get(id);
    if (!d) return;
    d.is_trusted = trusted ? 1 : 0;
    this.emit('update', this.list());
  }

  setBlacklist(id, black) {
    const d = this.devices.get(id);
    if (!d) return;
    d.is_blacklisted = black ? 1 : 0;
    if (black) d.is_online = false;
    this.emit('update', this.list());
  }

  /** 收藏/取消收藏（v1.20.0 收藏夹置顶） */
  setStarred(id, starred) {
    const d = this.devices.get(id);
    if (!d) return false;
    d.starred = starred ? 1 : 0;
    this.emit('update', this.list());
    return true;
  }

  /** 设置设备别名（v1.21.0 右键菜单；空串恢复原名） */
  setAlias(id, alias) {
    const d = this.devices.get(id);
    if (!d) return false;
    d.alias = String(alias || '').trim().slice(0, 40);
    this.emit('update', this.list());
    return true;
  }

  get(id) {
    return this.devices.get(id);
  }

  list() {
    // 收藏设备置顶，其余按在线优先 + 名称排序
    return [...this.devices.values()].sort((a, b) => {
      if ((b.starred ? 1 : 0) !== (a.starred ? 1 : 0)) return (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if ((b.is_online ? 1 : 0) !== (a.is_online ? 1 : 0)) return (b.is_online ? 1 : 0) - (a.is_online ? 1 : 0);
      return String(a.device_name || '').localeCompare(String(b.device_name || ''), 'zh-CN');
    });
  }

  /** 从持久化数据恢复（启动加载已信任/已拉黑设备） */
  hydrate(rows) {
    for (const r of rows) {
      this.devices.set(r.device_id, {
        device_id: r.device_id,
        device_name: r.device_name,
        os: r.os,
        host: r.host,
        port: r.port,
        version: r.version,
        public_key: r.public_key,
        fingerprint: r.fingerprint,
        group_name: r.group_name,
        remark: r.remark,
        is_trusted: r.is_trusted,
        is_blacklisted: r.is_blacklisted,
        starred: r.starred ? 1 : 0,
        alias: r.alias || '',
        is_online: false,
        last_seen: r.last_seen,
      });
    }
    this.emit('update', this.list());
  }
}

module.exports = DeviceManager;
