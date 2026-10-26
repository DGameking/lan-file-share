'use strict';

const path = require('path');
const archiver = require('archiver');
const { safeJoin } = require('../../shared/utils');
const { shareAuth } = require('../middleware/auth');

/** 批量下载：将多个文件/文件夹打包为 zip 流式下载 */
function register(ctx) {
  const { app, getShare } = ctx;

  app.get('/s/:shareId/api/zip', shareAuth(ctx), (req, res) => {
    const share = req.share;
    const paths = String(req.query.paths || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!paths.length) return res.status(400).json({ error: 'no_paths' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(share.name)}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => res.destroy());
    archive.pipe(res);
    let added = 0;
    for (const p of paths) {
      const abs = safeJoin(share.path, p);
      if (abs) {
        try {
          const st = require('fs').statSync(abs);
          if (st.isDirectory()) archive.directory(abs, path.basename(abs));
          else archive.file(abs, { name: path.basename(abs) });
          added++;
        } catch (e) {}
      }
    }
    if (!added) return res.status(404).end();
    archive.finalize();
  });
}

module.exports = { register };
