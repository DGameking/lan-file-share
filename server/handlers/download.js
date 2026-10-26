'use strict';

const fs = require('fs');
const path = require('path');
const { safeJoin, getCategory } = require('../../shared/utils');
const { shareAuth } = require('../middleware/auth');
const { createThrottle } = require('../middleware/rate-limit');

const MIME = {
  image: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon' },
  video: { mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', m4v: 'video/mp4' },
  audio: { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', m4a: 'audio/mp4' },
  pdf: { pdf: 'application/pdf' },
  text: { txt: 'text/plain', md: 'text/markdown', json: 'application/json', xml: 'application/xml', log: 'text/plain', csv: 'text/csv', yml: 'text/yaml', yaml: 'text/yaml', ini: 'text/plain', conf: 'text/plain', toml: 'text/plain' },
  code: { js: 'text/javascript', ts: 'text/typescript', jsx: 'text/javascript', tsx: 'text/typescript', vue: 'text/plain', py: 'text/x-python', java: 'text/x-java', go: 'text/x-go', c: 'text/x-c', cpp: 'text/x-c++', h: 'text/x-c', hpp: 'text/x-c++', rs: 'text/x-rust', rb: 'text/x-ruby', php: 'text/x-php', sh: 'text/x-sh', html: 'text/html', css: 'text/css', sql: 'text/x-sql', kt: 'text/x-kotlin', swift: 'text/x-swift' },
  office: { doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

function mimeFor(cat, ext) {
  ext = (ext || '').toLowerCase().replace(/^\./, '');
  if (MIME[cat] && MIME[cat][ext]) return MIME[cat][ext];
  return 'application/octet-stream';
}

function register(ctx) {
  const { app, getShare, logEvent, clientIp } = ctx;

  function pipe(req, res, share, abs, total, start, end, inline) {
    const mime = mimeFor(getCategory(path.extname(abs)), path.extname(abs));
    const disposition = (inline ? 'inline' : 'attachment') + `; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
    if (start > 0 || end < total - 1) {
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', end - start + 1);
    } else {
      res.status(200);
      res.set('Content-Length', total);
    }
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', mime);
    res.set('Content-Disposition', disposition);
    const throttle = createThrottle((share.speed_limit || 0) * 1024);
    const stream = fs.createReadStream(abs, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(throttle).pipe(res);
  }

  // 下载 / 内联预览（支持 Range 断点续传）
  app.get('/s/:shareId/api/download', shareAuth(ctx), (req, res) => {
    const share = req.share;
    const rel = req.query.path || '';
    const inline = req.query.inline === '1';
    const abs = safeJoin(share.path, rel);
    if (!abs) return res.status(400).json({ error: 'invalid_path' });
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (e) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (!stat.isFile()) return res.status(400).json({ error: 'not_file' });
    const total = stat.size;
    const ip = clientIp(req);
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start) || isNaN(end) || start > end || end >= total) {
        return res.status(416).set('Content-Range', `bytes */${total}`).end();
      }
      pipe(req, res, share, abs, total, start, end, inline);
    } else {
      pipe(req, res, share, abs, total, 0, total - 1, inline);
    }
    logEvent({
      event_type: 'file_download',
      ip,
      target: `/s/${share.id}/${rel}`,
      size: total,
      result: 'success',
      detail: { inline },
    });
  });

  // 预览元信息（文本文件附带内容用于高亮）
  app.get('/s/:shareId/api/preview', shareAuth(ctx), (req, res) => {
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
    if (!stat.isFile()) return res.status(400).json({ error: 'not_file' });
    const cat = getCategory(path.extname(abs));
    const info = { name: path.basename(abs), size: stat.size, modified: stat.mtimeMs, category: cat, mime: mimeFor(cat, path.extname(abs)) };
    if ((cat === 'text' || cat === 'code') && stat.size <= 1024 * 1024) {
      try {
        info.content = fs.readFileSync(abs, 'utf8');
        info.language = cat === 'code' ? path.extname(abs).replace(/^\./, '') : 'markdown';
      } catch (e) {}
    }
    res.json(info);
  });

  // 删除文件 / 文件夹
  app.delete('/s/:shareId/api/file', shareAuth(ctx), (req, res) => {
    const share = req.share;
    if (share.permission === 'read') return res.status(403).json({ error: 'permission_denied' });
    const rel = req.query.path || '';
    const abs = safeJoin(share.path, rel);
    if (!abs) return res.status(400).json({ error: 'invalid_path' });
    try {
      const s = fs.statSync(abs);
      if (s.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else fs.unlinkSync(abs);
      logEvent({ event_type: 'file_delete', ip: clientIp(req), target: `/s/${share.id}/${rel}`, result: 'success' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message) });
    }
  });
}

module.exports = { register };
