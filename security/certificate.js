'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 可选 TLS 支持：尝试用系统 openssl 生成自签名证书。
 * 若不可用则返回 null，上层回退到 HTTP（MVP 默认传输）。
 */
function ensureSelfSignedCert(cacheDir, commonName = 'lan-file-share.local') {
  const keyPath = path.join(cacheDir, 'server.key');
  const certPath = path.join(cacheDir, 'server.cert');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  try {
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '365',
        '-subj',
        `/CN=${commonName}`,
      ],
      { stdio: 'ignore' }
    );
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch (e) {
    // openssl 不可用，回退 HTTP
    return null;
  }
}

module.exports = { ensureSelfSignedCert };
