'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { shortId } = require('../shared/utils');
const { saveMultipartFiles, pruneDir } = require('./recv-util');

const DROP_FILES_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 默认接收配额 2GB（可经 settings.dropQuotaGB 调整）
const SESSION_TTL = 90 * 1000; // 审批会话有效期

/**
 * 快速投送（Quick Drop）接收端：
 * - POST /api/drop/prepare      元数据先行：清单审批（自动接收关闭时对端确认）
 * - GET  /api/drop/session      发送端轮询审批结果
 * - POST /api/drop/decision     接收端接受/拒绝
 * - POST /api/drop              multipart 整文件投送（小文件）
 * - POST /api/drop/chunk        分块上传（大文件断点续传）
 * - GET  /api/drop/chunk/status 已收分块查询（续传用）
 * - POST /api/drop/finish       合并分块（含 sha256 校验）
 * - POST /api/drop              JSON {text} 剪贴板文本投送
 * 安全：可选 PIN（settings.dropPin）；自动接收关闭时必须持已批准会话；
 *       提供 sha256 时落盘后校验（422 拒收）。
 */
function register(engine) {
  const dir = process.env.LFS_DROP_DIR || path.join(engine.dataDir, 'received');
  const partsDir = path.join(dir, '.parts');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(partsDir, { recursive: true });
  } catch (e) {}
  engine.receivedDir = dir;

  const cleanId = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const sessions = new Map(); // sessionId -> {status, from, files, text, ts}

  /* ---------- 接收配额（settings.dropQuotaGB，默认 2GB，超出按最旧清理） ---------- */
  const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
  const quotaBytes = () => {
    const gb = Number(getSettings().dropQuotaGB);
    return gb > 0 ? Math.round(gb * 1024 * 1024 * 1024) : DEFAULT_QUOTA_BYTES;
  };
  const dirSize = (d) => {
    let total = 0;
    try {
      for (const n of fs.readdirSync(d)) {
        try { total += fs.statSync(path.join(d, n)).size; } catch (e) {}
      }
    } catch (e) {}
    return total;
  };

  // 分块暂存目录清理：超 24h 的未完成上传按最旧删除（防 .parts 无限增长）
  setInterval(() => {
    const now = Date.now();
    try {
      for (const n of fs.readdirSync(partsDir)) {
        const p = path.join(partsDir, n);
        try {
          if (now - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
        } catch (e) {}
      }
    } catch (e) {}
  }, 60 * 60 * 1000).unref();

  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.ts > SESSION_TTL) sessions.delete(id);
  }, 30 * 1000).unref();

  const getSettings = () => engine.settings || {};

  /** PIN 校验；优先 X-LFS-Pin 请求头（避免明文 URL 泄露到日志/嗅探），query 兼容保留；失败时已响应并返回 false */
  function checkPin(req, res) {
    const pin = String(getSettings().dropPin || '').trim();
    if (!pin) return true;
    const headerPin = req.headers['x-lfs-pin'];
    const given = headerPin != null && headerPin !== '' ? String(headerPin) : req.query.pin != null ? String(req.query.pin) : '';
    if (given === pin) return true;
    res.status(401).json({ error: given ? 'bad_pin' : 'pin_required' });
    return false;
  }

  /* ---------- 守卫：拉黑 IP 拦截 + 每 IP 令牌桶限流 + 并发传输上限 ---------- */
  const buckets = new Map(); // ip -> {tokens, ts}
  const RATE_MAX = 120; // 每分钟令牌
  const RATE_WINDOW = 60 * 1000;
  let activeTransfers = 0;
  const MAX_CONCURRENT = 3;
  setInterval(() => {
    const now = Date.now();
    for (const [ip, b] of buckets) if (now - b.ts > RATE_WINDOW * 2) buckets.delete(ip);
  }, 120 * 1000).unref();

  function rateOk(req, res) {
    // 拉黑设备所在 IP 直接拒绝
    const ip = engine.clientIp(req);
    try {
      const blocked = (engine.deviceManager.list() || []).some((d) => d.is_blacklisted && d.host === ip);
      if (blocked) {
        res.status(403).json({ error: 'ip_blocked' });
        return false;
      }
    } catch (e) {}
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now - b.ts > RATE_WINDOW) b = { tokens: RATE_MAX, ts: now };
    b.tokens -= 1;
    b.ts = now;
    buckets.set(ip, b);
    if (b.tokens < 0) {
      res.status(429).json({ error: 'rate_limited' });
      return false;
    }
    return true;
  }

  function guard(handler, { trackTransfer = false } = {}) {
    return (req, res) => {
      if (!rateOk(req, res)) return;
      if (trackTransfer) {
        if (activeTransfers >= MAX_CONCURRENT) return res.status(429).json({ error: 'busy' });
        activeTransfers++;
        res.on('finish', () => { activeTransfers--; });
      }
      handler(req, res);
    };
  }

  /** 会话校验：自动接收关闭时必须持已批准会话；通过返回会话对象，失败已响应并返回 null */
  function checkSession(req, res, { required = true } = {}) {
    const sid = cleanId(req.query.sessionId || (req.body && req.body.sessionId));
    const autoAccept = getSettings().autoAcceptDrop !== false;
    if (autoAccept && !sid) return { implicit: true };
    if (!sid) {
      if (!required) return null;
      res.status(401).json({ error: 'approval_required' });
      return null;
    }
    const s = sessions.get(sid);
    if (!s || s.status !== 'accepted') {
      res.status(s ? 403 : 404).json({ error: s ? 'declined' : 'session_not_found' });
      return null;
    }
    s.ts = Date.now();
    return s;
  }

  /** sha256 大小写不敏感比对 */
  function hashMatch(a, b) {
    return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  }

  function sha256File(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(file);
      rs.on('data', (d) => h.update(d));
      rs.on('end', () => resolve(h.digest('hex')));
      rs.on('error', reject);
    });
  }

  const setMtime = (file, ms) => {
    const t = Number(ms);
    if (!(t > 0)) return;
    try {
      const d = new Date(Math.min(t, Date.now() + 86400000));
      fs.utimesSync(file, d, d);
    } catch (e) {}
  };

  const notify = (ip, from, files, extra = {}) => {
    const payload = { from, files, ts: Date.now(), ...extra };
    engine.broadcast('drop.incoming', payload);
    engine.logger && engine.logger.info('drop', `收到投送（${files.length} 个文件）`, { from, ip, names: files.map((f) => f.name).slice(0, 5) });
    // 接收历史持久化（重启不丢，供收件箱回溯）
    try {
      for (const f of files) {
        engine.db.addDropHistory({
          ts: payload.ts, from_name: from, file_id: f.fileId || '', name: f.name || 'file',
          size: f.size || 0, mime: f.mime || '', is_text: !!f.isText,
          verified: !!f.verified, via_relay: !!extra.via_relay,
        });
      }
      engine.db.pruneDropHistory(1000);
    } catch (e) {}
    engine.logEvent({
      event_type: 'file_receive',
      device_name: from,
      ip,
      result: 'success',
      detail: { count: files.length, size: files.reduce((s, f) => s + (f.size || 0), 0), ...extra },
    });
  };

  /* ---------- 接收历史（收件箱回溯） ---------- */
  engine.app.get('/api/drop/history', (req, res) => {
    res.json({ ok: true, items: engine.db.listDropHistory(Math.min(Number(req.query.limit) || 200, 500)) });
  });
  engine.app.delete('/api/drop/history/:id', (req, res) => {
    engine.db.removeDropHistory(Number(req.params.id));
    res.json({ ok: true });
  });
  engine.app.delete('/api/drop/history', (req, res) => {
    engine.db.clearDropHistory();
    res.json({ ok: true });
  });

  /* ---------- 元数据先行：清单审批（注意：全局 express.json 已解析 body） ---------- */
  engine.app.post('/api/drop/prepare', guard((req, res) => {
    if (!checkPin(req, res)) return;
    if (getSettings().autoAcceptDrop === false) {
      const manifest = req.body || {};
      const sid = shortId();
      sessions.set(sid, {
        status: 'pending',
        from: String(manifest.from || engine.clientIp(req)).slice(0, 60) || '未知设备',
        files: Array.isArray(manifest.files) ? manifest.files.slice(0, 500) : [],
        text: !!manifest.text,
        ts: Date.now(),
      });
      engine.broadcast('drop.request', { sessionId: sid, from: sessions.get(sid).from, files: sessions.get(sid).files, text: sessions.get(sid).text });
      return res.status(202).json({ sessionId: sid, pending: true });
    }
    const sid = shortId();
    sessions.set(sid, {
      status: 'accepted',
      from: String((req.body && req.body.from) || engine.clientIp(req)).slice(0, 60) || '未知设备',
      files: [],
      text: false,
      ts: Date.now(),
    });
    res.json({ sessionId: sid, accepted: true });
  }));

  /* ---------- 发送端轮询审批结果 ---------- */
  engine.app.get('/api/drop/session', (req, res) => {
    const sid = cleanId(req.query.sessionId);
    const s = sessions.get(sid);
    if (!s) return res.json({ status: 'expired' });
    res.json({ status: s.status });
  });

  /* ---------- 接收端决定 ---------- */
  engine.app.post('/api/drop/decision', (req, res) => {
    const sid = cleanId(req.body && req.body.sessionId);
    const s = sessions.get(sid);
    if (!s) return res.status(404).json({ error: 'session_not_found' });
    s.status = req.body && req.body.accept ? 'accepted' : 'declined';
    s.ts = Date.now();
    engine.broadcast('drop.request.result', { sessionId: sid, accepted: s.status === 'accepted' });
    engine.logEvent({ event_type: 'drop_decision', device_name: s.from, ip: engine.clientIp(req), result: s.status });
    res.json({ ok: true, status: s.status });
  });

  /* ---------- 整文件 / 剪贴板文本 ---------- */
  engine.app.post('/api/drop', guard(async (req, res) => {
    if (!checkPin(req, res)) return;
    if ((req.headers['content-type'] || '').includes('application/json')) {
      const s = checkSession(req, res);
      if (!s) return;
      // body 已被全局 express.json 解析，直接取 req.body
      const text = String((req.body && req.body.text) || '').slice(0, 100000);
      if (!text) return res.status(400).json({ error: 'no_text' });
      const first = text.trim().split(/\r?\n/)[0].slice(0, 24).replace(/[\\/:*?"<>|]/g, '_') || '剪贴板';
      const id = shortId() + '_' + first + '.txt';
      fs.writeFileSync(path.join(dir, id), text, 'utf8');
      notify(engine.clientIp(req), (s.from) || String(req.query.from || engine.clientIp(req)).slice(0, 60), [{ fileId: id, name: first + '.txt', size: Buffer.byteLength(text), mime: 'text/plain', isText: true }]);
      return res.json({ ok: true, received: 1 });
    }

    const s = checkSession(req, res);
    if (!s) return;
    // 配额预检：目录已超配额时拒收（413），避免先写满再清理
    if (dirSize(dir) >= quotaBytes()) return res.status(413).json({ error: 'quota_exceeded', quotaBytes: quotaBytes() });
    try {
      const saved = await saveMultipartFiles(req, dir, { maxBytes: quotaBytes() });
      // sha256 校验：不符则删除并拒收（422）
      const want = String(req.query.sha256 || '');
      if (want) {
        for (const f of saved) {
          const actual = await sha256File(path.join(dir, f.fileId));
          if (!hashMatch(actual, want)) {
            try { fs.unlinkSync(path.join(dir, f.fileId)); } catch (e) {}
            return res.status(422).json({ error: 'checksum_mismatch', fileId: f.fileId });
          }
        }
      }
      const mtime = req.query.mtime;
      if (mtime) for (const f of saved) setMtime(path.join(dir, f.fileId), mtime);
      notify(engine.clientIp(req), (s && s.from) || String(req.query.from || engine.clientIp(req)).slice(0, 60), saved, { verified: !!want });
      res.json({ ok: true, received: saved.length, totalSize: saved.reduce((s2, f) => s2 + f.size, 0) });
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: e.message || 'bad_request' });
    }
  }));

  /* ---------- 分块上传（大文件断点续传） ---------- */
  engine.app.post('/api/drop/chunk', guard((req, res) => {
    if (!checkPin(req, res)) return;
    if (getSettings().autoAcceptDrop === false && !cleanId(req.query.sessionId)) {
      return res.status(401).json({ error: 'approval_required' });
    }
    const uploadId = cleanId(req.query.uploadId);
    const index = Number.parseInt(req.query.index, 10);
    if (!uploadId || !(index >= 0) || index > 100000) return res.status(400).json({ error: 'bad_args' });
    const uDir = path.join(partsDir, uploadId);
    try {
      fs.mkdirSync(uDir, { recursive: true });
    } catch (e) {}
    const out = fs.createWriteStream(path.join(uDir, `${index}.part`));
    req.pipe(out);
    out.on('finish', () => res.json({ ok: true }));
    out.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'write_failed' });
    });
  }));

  engine.app.get('/api/drop/chunk/status', (req, res) => {
    const uploadId = cleanId(req.query.uploadId);
    if (!uploadId) return res.status(400).json({ error: 'bad_args' });
    let received = [];
    try {
      received = fs
        .readdirSync(path.join(partsDir, uploadId))
        .filter((n) => n.endsWith('.part'))
        .map((n) => Number.parseInt(n, 10))
        .filter(Number.isFinite);
    } catch (e) {}
    res.json({ ok: true, received });
  });

  engine.app.post('/api/drop/finish', guard(async (req, res) => {
    if (!checkPin(req, res)) return;
    const s = checkSession(req, res);
    if (!s) return;
    const uploadId = cleanId(req.body && req.body.uploadId);
    const total = Number(req.body && req.body.total);
    const size = Number(req.body && req.body.size) || 0;
    const from = String(req.body && req.body.from || engine.clientIp(req)).slice(0, 60) || '未知设备';
    const rawName = String((req.body && req.body.name) || 'file').slice(0, 200);
    if (!uploadId || !(total >= 1) || total > 100000) return res.status(400).json({ error: 'bad_args' });

    const uDir = path.join(partsDir, uploadId);
    let parts = [];
    try {
      parts = fs
        .readdirSync(uDir)
        .filter((n) => n.endsWith('.part'))
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n < total)
        .sort((a, b) => a - b);
    } catch (e) {}
    if (parts.length !== total) {
      return res.status(409).json({ error: 'incomplete', have: parts.length, total });
    }

    const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_') || 'file';
    const id = shortId() + '_' + safeName;
    const target = path.join(dir, id);

    // 配额预检：接收目录已超配额时拒收（413）
    if (dirSize(dir) >= quotaBytes()) return res.status(413).json({ error: 'quota_exceeded', quotaBytes: quotaBytes() });

    (async () => {
      const out = fs.createWriteStream(target);
      for (const i of parts) {
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(path.join(uDir, `${i}.part`));
          rs.pipe(out, { end: false });
          rs.on('end', resolve);
          rs.on('error', reject);
        });
      }
      await new Promise((r) => out.end(r));
      const finalSize = fs.existsSync(target) ? fs.statSync(target).size : 0;

      // sha256 校验（发送端在小文件场景提供；分块场景可选）
      const want = String((req.body && req.body.sha256) || '');
      if (want) {
        const actual = await sha256File(target);
        if (!hashMatch(actual, want)) {
          try { fs.unlinkSync(target); } catch (e) {}
          return res.status(422).json({ error: 'checksum_mismatch' });
        }
      }
      // 大小一致性：与 prepare 声明偏差 > 1% 且 > 1MB 视为损坏
      if (size > 0 && Math.abs(finalSize - size) > Math.max(1024 * 1024, size * 0.01)) {
        try { fs.unlinkSync(target); } catch (e) {}
        return res.status(422).json({ error: 'size_mismatch', expected: size, actual: finalSize });
      }
      setMtime(target, req.body && req.body.mtime);

      try {
        fs.rmSync(uDir, { recursive: true, force: true });
      } catch (e) {}
      pruneDir(dir, quotaBytes());
      notify(engine.clientIp(req), (s && s.from) || from, [{ fileId: id, name: safeName, size: finalSize || size, mime: 'application/octet-stream', resumable: true, verified: !!want }]);
      res.json({ ok: true, received: 1 });
    })().catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'assemble_failed' });
    });
  }));
}

module.exports = { register };
