'use strict';
// 本地代理 + winCodeSign 修复镜像。
// 用法：把 ELECTRON_BUILDER_BINARIES_MIRROR 指向本服务。
//  - 请求路径含 winCodeSign 时，返回本地已修复（去掉 darwin 符号链接）的 7z；
//  - 其余请求透明代理到 npmmirror 的 electron-builder-binaries。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const FIXED = path.join(__dirname, '..', 'wcs_fixed.7z');
const PORT = process.env.WCS_PORT ? parseInt(process.env.WCS_PORT, 10) : 9231;
const UPSTREAM = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries';

const server = http.createServer((req, res) => {
  if (req.url.indexOf('winCodeSign') !== -1) {
    fs.readFile(FIXED, (err, data) => {
      if (err) { res.writeHead(500); res.end('no fixed 7z: ' + err.message); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
      res.end(data);
    });
    return;
  }
  // 代理到上游
  const target = UPSTREAM + req.url;
  https.get(target, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  }).on('error', (e) => {
    res.writeHead(502);
    res.end('proxy error: ' + e.message);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[serve-wcs] proxy on http://127.0.0.1:' + PORT + '  (winCodeSign -> local fixed 7z, others -> ' + UPSTREAM + ')');
});
