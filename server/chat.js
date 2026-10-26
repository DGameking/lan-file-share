'use strict';

const fs = require('fs');
const path = require('path');
const busboy = require('busboy');
const WebSocket = require('ws');

const { shortId } = require('../shared/utils');

const MAX_CHAT_MESSAGES = 1000; // 本地保留的聊天记录条数
const CHAT_FILES_DIR = 'chat-files';
const CHAT_FILES_MAX_BYTES = 1024 * 1024 * 1024; // 会话文件缓存上限 1GB

/**
 * 局域网会话模块：
 * - 所有连接到本机服务的客户端（桌面端 / 浏览器端）自动进入同一个会话框
 * - 文字消息、输入状态、文件/文件夹共享（复用 HTTP 上传，点对点直连局域网）
 * - WebRTC 音视频通话信令中继（媒体流在设备间 P2P 直连，不经过服务器）
 */
class ChatManager {
  constructor(ctx) {
    this.ctx = ctx; // LanFileShare 实例
    /** @type {Map<WebSocket, {id:String,name:String,kind:String,deviceId:String|null}>} */
    this.members = new Map();
    // NAS 场景可通过 LFS_CHAT_FILES 指向共享目录（用户可在文件管理器中直接管理接收的文件）
    this.filesDir = process.env.LFS_CHAT_FILES || path.join(ctx.dataDir, CHAT_FILES_DIR);
    try {
      fs.mkdirSync(this.filesDir, { recursive: true });
    } catch (e) {}
  }

  register() {
    const { app } = this.ctx;

    // 统一会话页（桌面端内嵌同一页面）
    app.get('/chat', (req, res) => {
      let html = '';
      try {
        html = fs.readFileSync(path.join(__dirname, 'static', 'chat.html'), 'utf8');
      } catch (e) {
        html = '<h1>会话页面缺失</h1>';
      }
      res.type('html').send(html);
    });

    // 聊天历史
    app.get('/api/chat/history', (req, res) => {
      const before = req.query.before ? Number(req.query.before) : null;
      res.json(this.ctx.db.listChatMessages(200, before));
    });

    // 会话页二维码（供管理端展示，手机扫码直达 /chat）
    app.get('/api/chat/qrcode', async (req, res) => {
      try {
        const url = String(req.query.url || `http://${this.ctx.localIp}:${this.ctx.httpPort}/chat`).slice(0, 300);
        const dataUrl = await require('qrcode').toDataURL(url, { margin: 1, width: 220 });
        res.json({ dataUrl, url });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    // 会话文件上传（multipart，支持多文件；文件夹由客户端逐个文件携带相对路径）
    app.post('/api/chat/upload', (req, res) => {
      let bb;
      try {
        bb = busboy({ headers: req.headers, defParamCharset: 'utf8' });
      } catch (e) {
        return res.status(400).json({ error: 'bad_request' });
      }
      const saved = [];
      let pending = 0;
      let closed = false;
      const done = () => {
        if (!closed || pending > 0) return;
        if (!saved.length) return res.status(400).json({ error: 'no_files' });
        this._pruneFiles();
        res.json({ ok: true, files: saved });
      };
      bb.on('file', (fieldname, file, info) => {
        const rawName = info.filename || fieldname || 'file';
        const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_') || 'file';
        const id = shortId() + '_' + safeName;
        const target = path.join(this.filesDir, id);
        const out = fs.createWriteStream(target);
        let size = 0;
        pending++;
        file.on('data', (d) => (size += d.length));
        file.pipe(out);
        out.on('finish', () => {
          pending--;
          saved.push({ fileId: id, name: safeName, size, mime: info.mimeType || 'application/octet-stream' });
          done();
        });
        out.on('error', () => {
          pending--;
          done();
        });
      });
      bb.on('close', () => {
        closed = true;
        done();
      });
      bb.on('error', () => {
        if (!res.headersSent) res.status(400).json({ error: 'bad_request' });
      });
      req.pipe(bb);
    });

    // 会话文件下载
    app.get('/api/chat/file/:id', (req, res) => {
      const id = path.basename(req.params.id || '');
      const target = path.join(this.filesDir, id);
      if (!fs.existsSync(target)) return res.status(404).json({ error: 'not_found' });
      const name = id.includes('_') ? id.slice(id.indexOf('_') + 1) : id;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      fs.createReadStream(target).pipe(res);
    });

    // 会话文件内联预览（图片/视频）
    app.get('/api/chat/preview/:id', (req, res) => {
      const id = path.basename(req.params.id || '');
      const target = path.join(this.filesDir, id);
      if (!fs.existsSync(target)) return res.status(404).end();
      const ext = path.extname(id).toLowerCase();
      const mime =
        { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' }[ext] ||
        'application/octet-stream';
      res.setHeader('Content-Type', mime);
      fs.createReadStream(target).pipe(res);
    });
  }

  /** 新 WS 连接进入会话（自动加入，无需手动操作） */
  attach(ws) {
    ws.on('close', () => {
      const m = this.members.get(ws);
      if (!m) return;
      this.members.delete(ws);
      this._broadcastMembers();
    });
  }

  /** 处理会话相关 WS 消息；返回 true 表示已处理 */
  onMessage(ws, msg) {
    switch (msg.type) {
      case 'chat.hello':
        this.members.set(ws, {
          id: String(msg.clientId || shortId()),
          name: String(msg.name || '未知设备').slice(0, 40),
          kind: msg.kind === 'desktop' ? 'desktop' : 'web',
          deviceId: msg.deviceId ? String(msg.deviceId) : null,
          ts: Date.now(),
        });
        ws.send(JSON.stringify({ event: 'chat.init', payload: { selfId: this.members.get(ws).id, history: this.ctx.db.listChatMessages(200) } }));
        this._broadcastMembers();
        return true;

      case 'chat.send': {
        const m = this.members.get(ws);
        if (!m || !msg.text || !String(msg.text).trim()) return true;
        const text = String(msg.text).slice(0, 4000);
        const record = {
          id: shortId(),
          ts: Date.now(),
          sender_id: m.id,
          sender_name: m.name,
          kind: 'text',
          text,
        };
        this._persist(record);
        this._broadcast('chat.msg', record);
        return true;
      }

      case 'chat.file': {
        const m = this.members.get(ws);
        if (!m || !Array.isArray(msg.files) || !msg.files.length) return true;
        const files = msg.files.slice(0, 50).map((f) => ({
          fileId: String(f.fileId || '').replace(/[/\\]/g, ''),
          name: String(f.name || 'file').slice(0, 200),
          size: Number(f.size) || 0,
          mime: String(f.mime || '').slice(0, 100),
          relPath: String(f.relPath || '').slice(0, 500), // 文件夹内的相对路径
        })).filter((f) => f.fileId);
        if (!files.length) return true;
        const record = {
          id: shortId(),
          ts: Date.now(),
          sender_id: m.id,
          sender_name: m.name,
          kind: 'file',
          files,
        };
        this._persist(record);
        this._broadcast('chat.msg', record);
        this.ctx.logEvent({ event_type: 'chat_file', device_name: m.name, ip: ws._socketIp || '', result: 'success', detail: { count: files.length } });
        return true;
      }

      case 'chat.typing': {
        const m = this.members.get(ws);
        if (!m) return true;
        this._broadcast('chat.typing', { id: m.id, name: m.name, typing: !!msg.typing });
        return true;
      }

      case 'chat.recall': {
        const m = this.members.get(ws);
        if (!m || !msg.id) return true;
        const row = this.ctx.db.listChatMessages(1000).find((r) => r.id === msg.id);
        if (!row || row.sender_id !== m.id) return true;
        this.ctx.db._run('DELETE FROM chat_messages WHERE id = ?', [msg.id]);
        this._broadcast('chat.recall', { id: msg.id });
        return true;
      }

      // ---- WebRTC 信令中继（媒体不经过服务器）----
      case 'rtc.signal': {
        const m = this.members.get(ws);
        if (!m) return true;
        const to = String(msg.to || '');
        for (const [peer, pm] of this.members) {
          if (pm.id === to && peer.readyState === WebSocket.OPEN) {
            peer.send(JSON.stringify({ event: 'rtc.signal', payload: { from: m.id, fromName: m.name, data: msg.data } }));
          }
        }
        return true;
      }

      default:
        return false;
    }
  }

  _persist(record) {
    try {
      this.ctx.db.addChatMessage({
        id: record.id,
        ts: record.ts,
        sender_id: record.sender_id,
        sender_name: record.sender_name,
        kind: record.kind,
        text: record.text || null,
        file_meta: record.files ? JSON.stringify(record.files) : null,
      });
      this.ctx.db.pruneChatMessages(MAX_CHAT_MESSAGES);
    } catch (e) {}
  }

  _broadcast(event, payload, opts = {}) {
    const msg = JSON.stringify({ event, payload });
    for (const [peer] of this.members) {
      if (peer.readyState === WebSocket.OPEN) {
        try {
          peer.send(msg);
        } catch (e) {}
      }
    }
    // 本机产生的事件同时桥接给其他设备（deliverRemote 分发的不再外发，避免环路）
    if (opts.bridge !== false && this.ctx.bridge) {
      this.ctx.bridge.relay(event, payload);
    }
  }

  _localMembers() {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, kind: m.kind, deviceId: m.deviceId }));
  }

  _combinedMembers() {
    return [...this._localMembers(), ...(this.ctx.bridge ? this.ctx.bridge.remoteMemberList() : [])];
  }

  /** 成员变化：本机广播合并列表（本地 + 远端），并把本地列表桥接给对端 */
  _broadcastMembers() {
    this._broadcast('chat.members', this._combinedMembers(), { bridge: false });
    if (this.ctx.bridge) this.ctx.bridge.relay('chat.members', this._localMembers());
  }

  /** 桥接层收到对端事件后调用：只在本机内分发 */
  deliverRemote(event, payload, origin) {
    if (!payload || typeof payload !== 'object') return;
    const tag = String(origin).slice(0, 8);
    switch (event) {
      case 'chat.msg': {
        const rec = {
          ...payload,
          id: `${payload.id || shortId()}-${tag}`,
          sender_id: `${payload.sender_id || 'u'}@${tag}`,
        };
        if (rec.kind === 'file' && Array.isArray(rec.files)) {
          const info = this.ctx.bridge ? this.ctx.bridge.peerInfoOf(origin) : null;
          const base = info && info.host && info.port ? `http://${info.host}:${info.port}` : '';
          rec.files = rec.files.map((f) => ({
            ...f,
            url: base ? `${base}/api/chat/file/${encodeURIComponent(f.fileId)}` : '',
          }));
        }
        rec.file_meta = rec.files ? JSON.stringify(rec.files) : rec.file_meta || null;
        this._persist(rec);
        this._broadcast('chat.msg', rec, { bridge: false });
        break;
      }
      case 'chat.members':
        if (this.ctx.bridge) this.ctx.bridge.setRemoteMembers(origin, payload);
        break;
      case 'chat.typing':
        this._broadcast('chat.typing', payload, { bridge: false });
        break;
      case 'chat.recall': {
        if (!payload.id) return;
        const id = `${payload.id}-${tag}`;
        try {
          this.ctx.db._run('DELETE FROM chat_messages WHERE id = ?', [id]);
        } catch (e) {}
        this._broadcast('chat.recall', { id }, { bridge: false });
        break;
      }
      case 'clip.sync':
        // 通知本机桌面端写入系统剪贴板 + 通知本机网页端展示
        this.ctx.emit('clip-incoming', { ...payload, origin });
        this._broadcast('clip.sync', { ...payload, origin }, { bridge: false });
        break;
    }
  }

  /** 把当前本地成员列表发给指定桥连接（握手后初始同步） */
  relayMembersTo(ws) {
    try {
      ws.send(JSON.stringify({ type: 'bridge.event', event: 'chat.members', payload: this._localMembers(), origin: this.ctx.deviceId }));
    } catch (e) {}
  }

  /** 会话文件缓存超过上限时，按最旧删除 */
  _pruneFiles() {
    try {
      const items = fs
        .readdirSync(this.filesDir)
        .map((n) => {
          const p = path.join(this.filesDir, n);
          const st = fs.statSync(p);
          return { p, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => a.mtime - b.mtime);
      let total = items.reduce((s, i) => s + i.size, 0);
      for (const it of items) {
        if (total <= CHAT_FILES_MAX_BYTES) break;
        try {
          fs.unlinkSync(it.p);
          total -= it.size;
        } catch (e) {}
      }
    } catch (e) {}
  }
}

module.exports = ChatManager;
