'use strict';

const fs = require('fs');
const path = require('path');
const busboy = require('busboy');

const { shortId } = require('../shared/utils');

const DROP_FILES_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 接收目录上限 2GB，超出按最旧清理

/**
 * 快速投送（Quick Drop）接收端：
 * 其他设备把文件 POST 到 /api/drop，本机保存到「接收的文件」目录并实时通知。
 * 对应 LocalSend 式的「一拖一放」体验。
 */
function register(engine) {
  const dir = process.env.LFS_DROP_DIR || path.join(engine.dataDir, 'received');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
  engine.receivedDir = dir;

  engine.app.post('/api/drop', (req, res) => {
    if (engine.settings && engine.settings.autoAcceptDrop === false) {
      return res.status(403).json({ error: 'declined' });
    }
    const from = String(req.query.from || engine.clientIp(req)).slice(0, 60) || '未知设备';

    // JSON 文本投送（剪贴板）
    if ((req.headers['content-type'] || '').includes('application/json')) {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 200000) req.destroy();
      });
      req.on('end', () => {
        try {
          const j = JSON.parse(body || '{}');
          const text = String(j.text || '').slice(0, 100000);
          if (!text) return res.status(400).json({ error: 'no_text' });
          const first = text.trim().split(/\r?\n/)[0].slice(0, 24).replace(/[\\/:*?"<>|]/g, '_') || '剪贴板';
          const id = shortId() + '_' + first + '.txt';
          fs.writeFileSync(path.join(dir, id), text, 'utf8');
          const payload = { from, files: [{ fileId: id, name: first + '.txt', size: Buffer.byteLength(text), mime: 'text/plain', isText: true }], ts: Date.now() };
          engine.broadcast('drop.incoming', payload);
          engine.logEvent({ event_type: 'file_receive', device_name: from, ip: engine.clientIp(req), result: 'success', detail: { count: 1, kind: 'text' } });
          res.json({ ok: true, received: 1 });
        } catch (e) {
          res.status(400).json({ error: 'bad_request' });
        }
      });
      return;
    }

    let bb;
    try {
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8' });
    } catch (e) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const saved = [];
    let pending = 0;
    let closed = false;
    let totalSize = 0;
    const done = () => {
      if (!closed || pending > 0) return;
      if (!saved.length) return res.status(400).json({ error: 'no_files' });
      prune(dir);
      const payload = { from, files: saved, ts: Date.now() };
      engine.broadcast('drop.incoming', payload);
      engine.logEvent({
        event_type: 'file_receive',
        device_name: from,
        ip: engine.clientIp(req),
        result: 'success',
        detail: { count: saved.length, size: totalSize },
      });
      res.json({ ok: true, received: saved.length, totalSize });
    };
    bb.on('file', (fieldname, file, info) => {
      const rawName = info.filename || fieldname || 'file';
      const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_') || 'file';
      const id = shortId() + '_' + safeName;
      const target = path.join(dir, id);
      const out = fs.createWriteStream(target);
      let size = 0;
      pending++;
      file.on('data', (d) => {
        size += d.length;
      });
      file.pipe(out);
      out.on('finish', () => {
        pending--;
        totalSize += size;
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
}

/** 接收目录超过上限时按最旧删除 */
function prune(dir) {
  try {
    const items = fs
      .readdirSync(dir)
      .map((n) => {
        const p = path.join(dir, n);
        const st = fs.statSync(p);
        return { p, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = items.reduce((s, i) => s + i.size, 0);
    for (const it of items) {
      if (total <= DROP_FILES_MAX_BYTES) break;
      try {
        fs.unlinkSync(it.p);
        total -= it.size;
      } catch (e) {}
    }
  } catch (e) {}
}

module.exports = { register };
