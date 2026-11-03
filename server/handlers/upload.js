'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');
const { safeJoin } = require('../../shared/utils');
const { shareAuth } = require('../middleware/auth');

function register(ctx) {
  const { app, getShare, logEvent, clientIp } = ctx;
  const partsRoot = path.join(ctx.dataDir || process.cwd(), 'upload-parts');
  try {
    fs.mkdirSync(partsRoot, { recursive: true });
  } catch (e) {}

  const cleanId = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  async function sha256File(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      const s = fs.createReadStream(file);
      s.on('data', (c) => h.update(c));
      s.on('end', () => resolve(h.digest('hex')));
      s.on('error', reject);
    });
  }

  // 上传（multipart，支持多文件 / 文件夹结构）
  app.post('/s/:shareId/api/upload', shareAuth(ctx), (req, res) => {
    const share = req.share;
    if (share.permission === 'read') return res.status(403).json({ error: 'permission_denied' });
    const relDir = req.query.path || '';
    const destBase = safeJoin(share.path, relDir);
    if (!destBase) return res.status(400).json({ error: 'invalid_path' });
    try {
      fs.mkdirSync(destBase, { recursive: true });
    } catch (e) {}

    let bb;
    try {
      bb = busboy({ headers: req.headers });
    } catch (e) {
      return res.status(400).json({ error: 'bad_request' });
    }

    const uploaded = [];
    const errors = [];
    bb.on('file', (fieldname, file, info) => {
      const rawName = info.filename || fieldname || 'file';
      const safeName = path.basename(rawName);
      const target = path.join(destBase, safeName);
      const sub = path.dirname(fieldname || '');
      let finalTarget = target;
      if (sub && sub !== '.' && sub !== '/') {
        const subBase = safeJoin(destBase, sub);
        if (subBase) {
          fs.mkdirSync(subBase, { recursive: true });
          finalTarget = path.join(subBase, safeName);
        }
      }
      const out = fs.createWriteStream(finalTarget);
      file.pipe(out);
      file.on('end', () => uploaded.push(path.relative(share.path, finalTarget)));
      file.on('error', (err) => errors.push(String(err)));
    });
    bb.on('close', () => {
      logEvent({
        event_type: 'file_upload',
        ip: clientIp(req),
        target: `/s/${share.id}/${relDir}`,
        result: errors.length ? 'failed' : 'success',
        detail: { count: uploaded.length },
      });
      if (errors.length) return res.status(500).json({ ok: false, files: uploaded, errors });
      res.json({ ok: true, files: uploaded });
    });
    bb.on('error', (err) => res.status(500).json({ error: String(err) }));
    req.pipe(bb);
  });

  /* ---------- 分块上传（大文件断点续传；>16MB 走此路径） ---------- */

  // 写入分块：POST /s/:id/api/upload/chunk?uploadId=&index=&sha256=
  app.post('/s/:shareId/api/upload/chunk', shareAuth(ctx), (req, res) => {
    const share = req.share;
    if (share.permission === 'read') return res.status(403).json({ error: 'permission_denied' });
    const uploadId = cleanId(req.query.uploadId);
    const index = Number.parseInt(req.query.index, 10);
    if (!uploadId || !(index >= 0) || index > 100000) return res.status(400).json({ error: 'bad_args' });
    const uDir = path.join(partsRoot, uploadId);
    try {
      fs.mkdirSync(uDir, { recursive: true });
    } catch (e) {}
    const out = fs.createWriteStream(path.join(uDir, `${index}.part`));
    req.pipe(out);
    out.on('finish', async () => {
      const want = String(req.query.sha256 || '');
      if (want) {
        try {
          const actual = await sha256File(path.join(uDir, `${index}.part`));
          if (actual !== want.toLowerCase()) {
            try { fs.unlinkSync(path.join(uDir, `${index}.part`)); } catch (e) {}
            return res.status(422).json({ error: 'chunk_checksum_mismatch', index });
          }
        } catch (e) {}
      }
      res.json({ ok: true });
    });
    out.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'write_failed' });
    });
  });

  // 已收分块查询（续传用）：GET /s/:id/api/upload/chunk/status?uploadId=
  app.get('/s/:shareId/api/upload/chunk/status', shareAuth(ctx), (req, res) => {
    if (req.share.permission === 'read') return res.status(403).json({ error: 'permission_denied' });
    const uploadId = cleanId(req.query.uploadId);
    if (!uploadId) return res.status(400).json({ error: 'bad_args' });
    let have = [];
    try {
      have = fs
        .readdirSync(path.join(partsRoot, uploadId))
        .filter((n) => n.endsWith('.part'))
        .map((n) => Number.parseInt(n, 10))
        .filter(Number.isFinite);
    } catch (e) {}
    res.json({ ok: true, have });
  });

  // 合并落盘：POST /s/:id/api/upload/finish?uploadId=&name=&path=&sha256=&mtime=
  app.post('/s/:shareId/api/upload/finish', shareAuth(ctx), async (req, res) => {
    const share = req.share;
    if (share.permission === 'read') return res.status(403).json({ error: 'permission_denied' });
    const uploadId = cleanId(req.query.uploadId);
    const safeName = path.basename(String(req.query.name || '')).replace(/[\\/:*?"<>|]/g, '_') || 'file';
    const relDir = String(req.query.path || '');
    if (!uploadId) return res.status(400).json({ error: 'bad_args' });
    const destBase = safeJoin(share.path, relDir);
    if (!destBase) return res.status(400).json({ error: 'invalid_path' });
    const uDir = path.join(partsRoot, uploadId);
    let parts = [];
    try {
      parts = fs
        .readdirSync(uDir)
        .filter((n) => n.endsWith('.part'))
        .map((n) => Number.parseInt(n, 10))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    } catch (e) {}
    if (!parts.length) return res.status(409).json({ error: 'no_parts' });
    // 连续性校验：client 提供 total 时，要求 0..total-1 全部在位（缺块续传场景防漏拼）
    const total = Number.parseInt(req.query.total, 10);
    if (Number.isFinite(total) && total > 0) {
      const have = new Set(parts);
      for (let i = 0; i < total; i++) {
        if (!have.has(i)) return res.status(409).json({ error: 'incomplete', have: parts.length, total });
      }
    }
    // 拼装到临时文件再校验后落位
    const tmp = path.join(uDir, 'assembled.bin');
    try {
      const out = fs.createWriteStream(tmp);
      await new Promise((resolve, reject) => {
        out.on('error', reject);
        let i = 0;
        const next = () => {
          if (i >= parts.length) return out.end(resolve);
          const rs = fs.createReadStream(path.join(uDir, `${parts[i++]}.part`));
          rs.on('error', reject);
          rs.pipe(out, { end: false });
          rs.on('end', next);
        };
        next();
      });
      const want = String(req.query.sha256 || '');
      if (want) {
        const actual = await sha256File(tmp);
        if (actual !== want.toLowerCase()) {
          try { fs.unlinkSync(tmp); } catch (e) {}
          return res.status(422).json({ error: 'checksum_mismatch' });
        }
      }
      fs.mkdirSync(destBase, { recursive: true });
      const target = path.join(destBase, safeName);
      fs.renameSync(tmp, target);
      if (req.query.mtime) {
        const m = Number(req.query.mtime);
        if (Number.isFinite(m) && m > 0) {
          try { fs.utimesSync(target, new Date(), new Date(m)); } catch (e) {}
        }
      }
      logEvent({
        event_type: 'file_upload',
        ip: clientIp(req),
        target: `/s/${share.id}/${relDir}`,
        result: 'success',
        detail: { count: 1, chunked: true, name: safeName, size: fs.statSync(target).size },
      });
      try { fs.rmSync(uDir, { recursive: true, force: true }); } catch (e) {}
      res.json({ ok: true, files: [path.relative(share.path, target)] });
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      if (!res.headersSent) res.status(500).json({ error: 'assemble_failed' });
    }
  });

  // 分块暂存清理：超 24h 的未完成上传按最旧删除（防 upload-parts 无限增长）
  setInterval(() => {
    try {
      const now = Date.now();
      for (const n of fs.readdirSync(partsRoot)) {
        const p = path.join(partsRoot, n);
        try {
          if (fs.statSync(p).mtimeMs < now - 24 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
        } catch (e) {}
      }
    } catch (e) {}
  }, 6 * 3600 * 1000).unref();
}

module.exports = { register };
