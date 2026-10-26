'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 数据访问层。
 * 使用 sql.js（SQLite 的 WASM 实现，零原生编译、跨平台、可离线运行），
 * 满足 PRD 对 SQLite 的诉求，同时避免 better-sqlite3 的原生编译门槛。
 * 所有写入后自动落盘（导出为 .sqlite 文件）。
 */
class DB {
  static async create(dbPath) {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    return new DB(dbPath, SQL);
  }

  constructor(dbPath, SQL) {
    this.dbPath = dbPath;
    this.SQL = SQL;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let buf = null;
    try {
      buf = fs.readFileSync(dbPath);
    } catch (e) {
      buf = null;
    }
    this.db = buf && buf.length ? new SQL.Database(buf) : new SQL.Database();
    this._initSchema();
    this._persist();
  }

  _initSchema() {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(sql);
  }

  _persist() {
    try {
      fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    } catch (e) {
      /* ignore */
    }
  }

  _norm(params) {
    if (params == null) return undefined;
    if (Array.isArray(params)) return params.map((v) => (v === undefined ? null : v));
    const o = {};
    for (const k of Object.keys(params)) {
      const v = params[k];
      o['@' + k] = v === undefined ? null : v;
    }
    return o;
  }

  _rows(res) {
    if (!res || !res.length) return [];
    const { columns, values } = res[0];
    return values.map((v) => {
      const o = {};
      columns.forEach((c, i) => (o[c] = v[i]));
      return o;
    });
  }

  _query(sql, params) {
    return this._rows(this.db.exec(sql, this._norm(params)));
  }

  _run(sql, params) {
    this.db.run(sql, this._norm(params));
    this._persist();
  }

  /* ---------------- 共享文件夹 ---------------- */
  listShares() {
    return this._query('SELECT * FROM shared_folders ORDER BY created_at DESC');
  }
  getShare(id) {
    return this._query('SELECT * FROM shared_folders WHERE id = ?', [id])[0] || null;
  }
  getShareByPath(p) {
    return this._query('SELECT * FROM shared_folders WHERE path = ?', [p])[0] || null;
  }
  addShare(share) {
    const now = Date.now();
    this._run(
      `INSERT INTO shared_folders (id,name,path,permission,password,expire_at,ip_whitelist,max_connections,speed_limit,enabled,created_at,updated_at)
       VALUES (@id,@name,@path,@permission,@password,@expire_at,@ip_whitelist,@max_connections,@speed_limit,@enabled,@created_at,@updated_at)`,
      { ...share, created_at: now, updated_at: now }
    );
    return this.getShare(share.id);
  }
  updateShare(id, patch) {
    const existing = this.getShare(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch, id, updated_at: Date.now() };
    this._run(
      `UPDATE shared_folders SET name=@name,path=@path,permission=@permission,password=@password,
       expire_at=@expire_at,ip_whitelist=@ip_whitelist,max_connections=@max_connections,
       speed_limit=@speed_limit,enabled=@enabled,updated_at=@updated_at WHERE id=@id`,
      merged
    );
    return this.getShare(id);
  }
  removeShare(id) {
    return this._run('DELETE FROM shared_folders WHERE id = ?', [id]);
  }

  /* ---------------- 设备 ---------------- */
  listDevices() {
    return this._query('SELECT * FROM devices');
  }
  getDevice(id) {
    return this._query('SELECT * FROM devices WHERE device_id = ?', [id])[0] || null;
  }
  upsertDevice(device) {
    const now = Date.now();
    const existing = this.getDevice(device.device_id);
    if (existing) {
      this._run(
        `UPDATE devices SET device_name=@device_name,os=@os,host=@host,port=@port,version=@version,
         public_key=@public_key,fingerprint=@fingerprint,group_name=@group_name,remark=@remark,
         is_trusted=@is_trusted,is_blacklisted=@is_blacklisted,first_seen=@first_seen,last_seen=@last_seen,is_online=@is_online
         WHERE device_id=@device_id`,
        { ...device, first_seen: existing.first_seen, last_seen: now }
      );
      return this.getDevice(device.device_id);
    }
    this._run(
      `INSERT INTO devices (device_id,device_name,os,host,port,version,public_key,fingerprint,group_name,remark,is_trusted,is_blacklisted,first_seen,last_seen,is_online)
       VALUES (@device_id,@device_name,@os,@host,@port,@version,@public_key,@fingerprint,@group_name,@remark,@is_trusted,@is_blacklisted,@first_seen,@last_seen,@is_online)`,
      { ...device, first_seen: now, last_seen: now }
    );
    return this.getDevice(device.device_id);
  }
  setDeviceOnline(id, online) {
    this._run('UPDATE devices SET is_online=@online, last_seen=@ts WHERE device_id=@id', {
      id,
      online: online ? 1 : 0,
      ts: Date.now(),
    });
  }
  setTrust(id, trusted) {
    this._run('UPDATE devices SET is_trusted=@t WHERE device_id=@id', { id, t: trusted ? 1 : 0 });
  }
  setBlacklist(id, black) {
    this._run('UPDATE devices SET is_blacklisted=@b WHERE device_id=@id', { id, b: black ? 1 : 0 });
  }
  removeDevice(id) {
    return this._run('DELETE FROM devices WHERE device_id = ?', [id]);
  }

  /* ---------------- 日志 ---------------- */
  addLog(entry) {
    const now = Date.now();
    this._run(
      `INSERT INTO logs (timestamp,event_type,device_id,device_name,ip,target,size,result,detail)
       VALUES (@timestamp,@event_type,@device_id,@device_name,@ip,@target,@size,@result,@detail)`,
      {
        timestamp: now,
        event_type: entry.event_type,
        device_id: entry.device_id || null,
        device_name: entry.device_name || null,
        ip: entry.ip || null,
        target: entry.target || null,
        size: entry.size || null,
        result: entry.result || 'success',
        detail: entry.detail ? JSON.stringify(entry.detail) : null,
      }
    );
    return null;
  }
  listLogs(limit = 200, offset = 0) {
    return this._query('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ? OFFSET ?', [limit, offset]);
  }
  clearLogs() {
    this._run('DELETE FROM logs');
  }

  /* ---------------- 配置 ---------------- */
  getConfig(key, defaultValue = null) {
    const row = this._query('SELECT value FROM app_config WHERE key = ?', [key])[0];
    return row ? row.value : defaultValue;
  }
  setConfig(key, value) {
    this._run(
      'INSERT INTO app_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, String(value)]
    );
  }

  /* ---------------- 邀请码 ---------------- */
  addInvite(code, deviceId, expireAt) {
    const now = Date.now();
    this._run('INSERT INTO invite_codes (code,device_id,created_at,expire_at,used) VALUES (?,?,?,?,0)', [
      code,
      deviceId,
      now,
      expireAt,
    ]);
  }
  getInvite(code) {
    return this._query('SELECT * FROM invite_codes WHERE code = ?', [code])[0] || null;
  }
  markInviteUsed(code) {
    this._run('UPDATE invite_codes SET used=1 WHERE code=?', [code]);
  }
  pruneInvites() {
    const now = Date.now();
    this._run('DELETE FROM invite_codes WHERE expire_at < ? OR used=1', [now]);
  }

  /* ---------------- 会话聊天 ---------------- */
  addChatMessage(m) {
    this._run(
      'INSERT INTO chat_messages (id,ts,sender_id,sender_name,kind,text,file_meta) VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO NOTHING',
      [m.id, m.ts, m.sender_id, m.sender_name, m.kind || 'text', m.text || null, m.file_meta || null]
    );
  }
  listChatMessages(limit = 200, beforeTs = null) {
    if (beforeTs) {
      return this._query(
        'SELECT * FROM chat_messages WHERE ts < ? ORDER BY ts DESC LIMIT ?',
        [beforeTs, limit]
      ).reverse();
    }
    return this._query('SELECT * FROM chat_messages ORDER BY ts DESC LIMIT ?', [limit]).reverse();
  }
  pruneChatMessages(keep = 1000) {
    this._run(
      'DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY ts DESC LIMIT ?)',
      [keep]
    );
  }

  /** 关闭底层数据库连接（持久化最后一次写入）。 */
  close() {
    try {
      this._persist();
    } catch (e) {}
    try {
      if (this.db && typeof this.db.close === 'function') this.db.close();
    } catch (e) {}
  }
}

module.exports = DB;
