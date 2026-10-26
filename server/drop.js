'use strict';

const fs = require('fs');
const path = require('path');

const { shortId } = require('../shared/utils');
const { saveMultipartFiles, pruneDir } = require('./recv-util');

const DROP_FILES_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 接收目录上限 2GB，超出按最旧清理

/**
 * 快速投送（Quick Drop）接收端：
 * - POST /api/drop        multipart 整文件投送（小文件）
 * - POST /api/drop/chunk  分块上传（大文件断点续传）
 * - GET  /api/drop/chunk/status?uploadId= 已收分块查询（续传用）
 * - POST /api/drop/finish 合并分块
 * - POST /api/drop        JSON {text} 剪贴板文本投送
 * 文件保存到「接收的文件」目录并实时通知。
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

  const notify = (ip, from, files, extra = {}) => {
    const payload = { from, files, ts: Date.now(), ...extra };
    engine.broadcast('drop.incoming', payload);
    engine.logger && engine.logger.info('drop', `收到投送（${files.length} 个文件）`, { from, ip, names: files.map((f) => f.name).slice(0, 5) });
    engine.logEvent({
      event_type: 'file_receive',
      device_name: from,
      ip,
      result: 'success',
      detail: { count: files.length, size: files.reduce((s, f) => s + (f.size || 0), 0), ...extra },
    });
  };

  /* ---------- 整文件 / 剪贴板文本 ---------- */
  engine.app.post('/api/drop', async (req, res) => {
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
          notify(engine.clientIp(req), from, [{ fileId: id, name: first + '.txt', size: Buffer.byteLength(text), mime: 'text/plain', isText: true }]);
          res.json({ ok: true, received: 1 });
        } catch (e) {
          res.status(400).json({ error: 'bad_request' });
        }
      });
      return;
    }

    try {
      const saved = await saveMultipartFiles(req, dir, { maxBytes: DROP_FILES_MAX_BYTES });
      notify(engine.clientIp(req), from, saved);
      res.json({ ok: true, received: saved.length, totalSize: saved.reduce((s, f) => s + f.size, 0) });
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: e.message || 'bad_request' });
    }
  });

  /* ---------- 分块上传（大文件断点续传） ---------- */
  engine.app.post('/api/drop/chunk', (req, res) => {
    if (engine.settings && engine.settings.autoAcceptDrop === false) {
      return res.status(403).json({ error: 'declined' });
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
  });

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

  engine.app.post('/api/drop/finish', (req, res) => {
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
      try {
        fs.rmSync(uDir, { recursive: true, force: true });
      } catch (e) {}
      pruneDir(dir, DROP_FILES_MAX_BYTES);
      notify(engine.clientIp(req), from, [{ fileId: id, name: safeName, size: finalSize || size, mime: 'application/octet-stream', resumable: true }]);
      res.json({ ok: true, received: 1 });
    })().catch(() => {
      if (!res.headersSent) res.status(500).json({ error: 'assemble_failed' });
    });
  });
}

module.exports = { register };
