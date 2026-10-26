'use strict';

const fs = require('fs');
const path = require('path');
const busboy = require('busboy');
const { safeJoin } = require('../../shared/utils');
const { shareAuth } = require('../middleware/auth');

function register(ctx) {
  const { app, getShare, logEvent, clientIp } = ctx;

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
}

module.exports = { register };
