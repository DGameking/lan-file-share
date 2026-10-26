'use strict';

const fs = require('fs');
const path = require('path');
const busboy = require('busboy');

const { shortId } = require('../shared/utils');

/**
 * multipart 文件接收的共用实现（chat 会话上传 / drop 投送共用）：
 * 安全文件名、写盘完成计数、超限按最旧清理。
 */
function saveMultipartFiles(req, dir, { maxBytes } = {}) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers: req.headers, defParamCharset: 'utf8' });
    } catch (e) {
      return reject(new Error('bad_request'));
    }
    const saved = [];
    let pending = 0;
    let closed = false;
    const done = () => {
      if (!closed || pending > 0) return;
      if (!saved.length) return reject(new Error('no_files'));
      if (maxBytes) pruneDir(dir, maxBytes);
      resolve(saved);
    };
    bb.on('file', (fieldname, file, info) => {
      const rawName = info.filename || fieldname || 'file';
      const safeName = path.basename(rawName).replace(/[\\/:*?"<>|]/g, '_') || 'file';
      const id = shortId() + '_' + safeName;
      const out = fs.createWriteStream(path.join(dir, id));
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
    bb.on('error', () => reject(new Error('bad_request')));
    req.pipe(bb);
  });
}

/** 目录总大小超过 maxBytes 时按最旧删除 */
function pruneDir(dir, maxBytes) {
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
      if (total <= maxBytes) break;
      try {
        fs.unlinkSync(it.p);
        total -= it.size;
      } catch (e) {}
    }
  } catch (e) {}
}

module.exports = { saveMultipartFiles, pruneDir };
