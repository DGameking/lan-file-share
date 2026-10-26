'use strict';

const fs = require('fs');
const path = require('path');
const { safeJoin, getCategory, isHidden } = require('../../shared/utils');
const { shareAuth } = require('../middleware/auth');

function register(ctx) {
  const { app, getShare } = ctx;

  // 浏览器访问入口（外壳页面，不鉴权；具体数据接口鉴权）
  app.get('/s/:shareId', (req, res) => {
    const share = getShare(req.params.shareId);
    if (!share) return res.status(404).send('共享不存在或已停止');
    res.type('html').send(ctx.getSharePageHtml(req.params.shareId));
  });

  // 文件列表（树形 + 排序）
  app.get('/s/:shareId/api/list', shareAuth(ctx), (req, res) => {
    const share = req.share;
    const rel = req.query.path || '';
    const abs = safeJoin(share.path, rel);
    if (!abs) return res.status(400).json({ error: 'invalid_path' });
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (!stat.isDirectory()) {
      return res.json({
        type: 'file',
        name: path.basename(abs),
        size: stat.size,
        modified: stat.mtimeMs,
        category: getCategory(path.extname(abs)),
      });
    }
    let entries = [];
    try {
      entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((e) => !isHidden(path.join(abs, e.name)))
        .map((e) => {
          const full = path.join(abs, e.name);
          let s;
          try {
            s = fs.statSync(full);
          } catch (e2) {
            s = { size: 0, mtimeMs: 0 };
          }
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            size: e.isDirectory() ? null : s.size,
            modified: s.mtimeMs,
            category: e.isDirectory() ? 'dir' : getCategory(path.extname(e.name)),
          };
        })
        .sort((a, b) =>
          a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1
        );
    } catch (e) {
      return res.status(500).json({ error: 'read_fail' });
    }
    res.json({ type: 'dir', path: rel, entries, shareName: share.name });
  });
}

module.exports = { register };
