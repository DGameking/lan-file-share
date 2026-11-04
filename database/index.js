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
    this._migrate();
  }

  /** 轻量迁移：为旧库补齐后加的列（CREATE TABLE IF NOT EXISTS 不会更新已存在的表）。
   *  迁移失败直接抛出拒启——带缺失列运行会让后续写入静默丢数据，比启动失败更糟。 */
  _migrate() {
    const cols = (table) => this._query(`PRAGMA table_info(${table})`).map((r) => r.name);
    try {
      if (!cols('chat_messages').includes('reply_meta')) {
        this.db.run('ALTER TABLE chat_messages ADD COLUMN reply_meta TEXT');
      }
      if (!cols('chat_messages').includes('to_id')) {
        this.db.run('ALTER TABLE chat_messages ADD COLUMN to_id TEXT');
      }
      if (!cols('devices').includes('starred')) {
        this.db.run('ALTER TABLE devices ADD COLUMN starred INTEGER DEFAULT 0');
      }
      if (!cols('devices').includes('alias')) {
        this.db.run('ALTER TABLE devices ADD COLUMN alias TEXT');
      }
    } catch (e) {
      const msg = `数据库迁移失败（${this.dbPath}）: ${e.message}`;
      console.error('[database]', msg);
      throw new Error(msg);
    }
  }

  _persist() {
    try {
      fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    } catch (e) {
      /* ignore */
    }
  }

  /** 防抖落盘：高频写入（心跳/统计）合并为一次文件写，停顿时自动兜底。
   *  此前每条 UPDATE 都全量导出 SQLite 写盘，设备心跳链路每 3 秒写两次整库文件。 */
  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persist();
    }, 300);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  /** 立即落盘（退出前调用，防抖窗口内的变更不丢） */
  flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._persist();
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
    this._schedulePersist();
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
  setDeviceStarred(id, starred) {
    this._run('UPDATE devices SET starred=@s WHERE device_id=@id', { id, s: starred ? 1 : 0 });
  }
  setDeviceAlias(id, alias) {
    this._run('UPDATE devices SET alias=@a WHERE device_id=@id', { id, a: String(alias || '').slice(0, 40) });
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
      'INSERT INTO chat_messages (id,ts,sender_id,sender_name,kind,text,file_meta,reply_meta,to_id) VALUES (?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO NOTHING',
      [m.id, m.ts, m.sender_id, m.sender_name, m.kind || 'text', m.text || null, m.file_meta || null, m.reply_meta || null, m.to_id || null]
    );
  }
  /** 会话消息搜索（v1.17.0）：文本内容 + 文件名；v1.18.0 起过滤私聊可见性；倒序取最新 limit 条后正序返回 */
  searchChatMessages(q, limit = 50, selfId = null) {
    const kw = String(q || '').trim();
    if (!kw) return [];
    const esc = kw.replace(/[\\%_]/g, (c) => '\\' + c);
    const like = `%${esc}%`;
    if (selfId) {
      return this._query(
        "SELECT * FROM chat_messages WHERE ((kind='text' AND text LIKE ? ESCAPE '\\') OR (kind='file' AND file_meta LIKE ? ESCAPE '\\')) " +
          'AND (to_id IS NULL OR to_id = @self OR sender_id = @self) ORDER BY ts DESC LIMIT ?',
        [like, like, selfId, limit]
      ).reverse();
    }
    return this._query(
      "SELECT * FROM chat_messages WHERE (kind='text' AND text LIKE ? ESCAPE '\\') OR (kind='file' AND file_meta LIKE ? ESCAPE '\\') " +
        'ORDER BY ts DESC LIMIT ?',
      [like, like, limit]
    ).reverse();
  }
  /**
   * 会话历史（v1.18.0 起支持私聊过滤）：
   * selfId 传入时，只返回「群聊消息 + 我发出的私聊 + 发给我的私聊」
   */
  listChatMessages(limit = 200, beforeTs = null, selfId = null) {
    if (selfId) {
      if (beforeTs) {
        return this._query(
          'SELECT * FROM chat_messages WHERE ts < ? AND (to_id IS NULL OR to_id = @self OR sender_id = @self) ORDER BY ts DESC LIMIT ?',
          [beforeTs, limit, selfId]
        ).reverse();
      }
      return this._query(
        'SELECT * FROM chat_messages WHERE (to_id IS NULL OR to_id = @self OR sender_id = @self) ORDER BY ts DESC LIMIT ?',
        [selfId, limit]
      ).reverse();
    }
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

  /* ---------- 投送接收历史 ---------- */
  addDropHistory(e) {
    return this._run(
      'INSERT INTO drop_history (ts, from_name, file_id, name, size, mime, is_text, verified, via_relay) VALUES (?,?,?,?,?,?,?,?,?)',
      [e.ts || Date.now(), e.from_name || '', e.file_id || '', e.name || 'file', e.size || 0, e.mime || '', e.is_text ? 1 : 0, e.verified ? 1 : 0, e.via_relay ? 1 : 0]
    );
  }
  listDropHistory(limit = 200) {
    return this._query('SELECT * FROM drop_history ORDER BY ts DESC, id DESC LIMIT ?', [limit]);
  }
  removeDropHistory(id) {
    return this._run('DELETE FROM drop_history WHERE id = ?', [id]);
  }
  removeDropHistoryByFileId(fileId) {
    return this._run('DELETE FROM drop_history WHERE file_id = ?', [fileId]);
  }
  clearDropHistory() {
    return this._run('DELETE FROM drop_history');
  }
  pruneDropHistory(keep = 1000) {
    this._run('DELETE FROM drop_history WHERE id NOT IN (SELECT id FROM drop_history ORDER BY ts DESC, id DESC LIMIT ?)', [keep]);
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
