'use strict';

const fs = require('fs');
const path = require('path');
const { safeJoin, getCategory } = require('../../shared/utils');
const crypto = require('../../security/crypto');

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

/**
 * 基础 WebDAV 支持（RFC 4918 子集）：
 * PROPFIND / GET / PUT / DELETE / MKCOL / OPTIONS
 * 挂载点：/s/:shareId/webdav
 */
function register(ctx) {
  const { app, getShare, masterKey, clientIp, logEvent } = ctx;

  function checkPassword(share, req) {
    if (!share.password) return true;
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Basic ')) return false;
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const pass = decoded.split(':')[1] || '';
    let plain = null;
    try {
      plain = crypto.aesDecrypt(share.password, masterKey);
    } catch (e) {}
    return plain != null && pass === plain;
  }

  app.use('/s/:shareId/webdav', (req, res, next) => {
    const share = getShare(req.params.shareId);
    if (!share) return res.status(404).end();
    if (!share.enabled) return res.status(403).end();
    if (!checkPassword(share, req)) {
      res.set('WWW-Authenticate', 'Basic realm="LanFileShare"');
      return res.status(401).end();
    }
    req.share = share;
    next();
  });

  app.all('/s/:shareId/webdav', (req, res) => {
    const share = req.share;
    const prefix = `/s/${req.params.shareId}/webdav`;
    const rel = decodeURIComponent(req.path.slice(prefix.length).replace(/^\//, ''));
    const abs = safeJoin(share.path, rel);
    if (!abs) return res.status(400).end();
    const ip = clientIp(req);

    if (req.method === 'OPTIONS') {
      return res
        .set('DAV', '1,2')
        .set('Allow', 'PROPFIND, GET, PUT, DELETE, MKCOL, OPTIONS')
        .status(200)
        .end();
    }

    if (req.method === 'PROPFIND') {
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (e) {
        return res.status(404).end();
      }
      const depth = parseInt(req.headers.depth || '1', 10);
      const hrefBase = `http://${req.headers.host || ''}${prefix}`;
      const items = [];
      if (stat.isDirectory() && depth !== 0) {
        items.push({ href: hrefBase + (rel ? '/' + rel : ''), isDir: true, path: abs });
        try {
          for (const name of fs.readdirSync(abs)) {
            const f = path.join(abs, name);
            let s;
            try {
              s = fs.statSync(f);
            } catch (e2) {
              continue;
            }
            items.push({ href: hrefBase + (rel ? '/' + rel : '') + '/' + name, isDir: s.isDirectory(), path: f });
          }
        } catch (e) {}
      } else {
        items.push({ href: hrefBase + (rel ? '/' + rel : ''), isDir: stat.isDirectory(), path: abs });
      }
      let body = '<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">';
      for (const it of items) {
        let st;
        try {
          st = fs.statSync(it.path);
        } catch (e) {
          continue;
        }
        body +=
          `<D:response><D:href>${xmlEscape(it.href)}</D:href><D:propstat><D:prop>` +
          `<D:resourcetype>${it.isDir ? '<D:collection/>' : ''}</D:resourcetype>` +
          `<D:getcontentlength>${it.isDir ? 0 : st.size}</D:getcontentlength>` +
          `<D:getlastmodified>${new Date(st.mtime).toUTCString()}</D:getlastmodified>` +
          `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
      }
      body += '</D:multistatus>';
      return res.set('Content-Type', 'application/xml; charset=utf-8').status(207).send(body);
    }

    if (req.method === 'GET') {
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (e) {
        return res.status(404).end();
      }
      if (!stat.isFile()) return res.status(400).end();
      res.set('Content-Length', stat.size);
      res.set('Content-Type', 'application/octet-stream');
      fs.createReadStream(abs).pipe(res);
      logEvent({ event_type: 'file_download', ip, target: `/s/${share.id}/${rel}`, size: stat.size, result: 'success' });
      return;
    }

    if (req.method === 'PUT') {
      if (share.permission === 'read') return res.status(403).end();
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
      } catch (e) {}
      const out = fs.createWriteStream(abs);
      req.pipe(out);
      out.on('finish', () => {
        logEvent({ event_type: 'file_upload', ip, target: `/s/${share.id}/${rel}`, result: 'success' });
        res.status(201).end();
      });
      out.on('error', () => res.status(500).end());
      return;
    }

    if (req.method === 'DELETE') {
      if (share.permission === 'read') return res.status(403).end();
      try {
        const s = fs.statSync(abs);
        if (s.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
        else fs.unlinkSync(abs);
        logEvent({ event_type: 'file_delete', ip, target: `/s/${share.id}/${rel}`, result: 'success' });
        return res.status(204).end();
      } catch (e) {
        return res.status(404).end();
      }
    }

    if (req.method === 'MKCOL') {
      if (share.permission === 'read') return res.status(403).end();
      try {
        fs.mkdirSync(abs, { recursive: true });
        return res.status(201).end();
      } catch (e) {
        return res.status(409).end();
      }
    }

    res.status(405).end();
  });
}

module.exports = { register };
