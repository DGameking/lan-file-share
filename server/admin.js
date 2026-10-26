'use strict';

/**
 * Web 管理端模块。
 *
 * 安全模型：
 * - 管理 API（/api 下除 chat 外的路由）默认仅允许本机回环（127.0.0.1/::1）直接访问——
 *   桌面客户端走 IPC 不受影响，本机浏览器直接可用。
 * - 局域网内其他设备访问管理 API 需持有管理令牌：先在「本机」设置管理密码，
 *   远程通过 POST /api/admin/login 换取 token（HMAC 签名，24 小时有效）。
 * - 未设置管理密码时，远程一律拒绝（fail-closed），回环不受影响。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 24 * 3600 * 1000;

function isLoopback(ip) {
  if (!ip) return false;
  const v = String(ip).replace(/^::ffff:/, '');
  return v === '127.0.0.1' || v === '::1' || v === 'localhost';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, hashHex] = String(stored).split('$');
    if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch (e) {
    return false;
  }
}

function signToken(ctx, exp) {
  const body = String(exp);
  const sig = crypto.createHmac('sha256', ctx.masterKey).update('admin-token:' + body).digest('hex');
  return `${body}.${sig}`;
}

function verifyToken(ctx, token) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return false;
    const expect = crypto.createHmac('sha256', ctx.masterKey).update('admin-token:' + body).digest('hex');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return Number(body) > Date.now();
  } catch (e) {
    return false;
  }
}

function hasAdminPassword(ctx) {
  return !!ctx.settings.adminPasswordHash;
}

/**
 * 管理 API 鉴权中间件。
 */
function adminAuth(ctx) {
  return (req, res, next) => {
    // 管理端自身的登录/状态接口单独处理（不要求 token）
    if (req.path.startsWith('/admin/login') || req.path.startsWith('/admin/status')) return next();
    // 统一会话面向所有局域网设备（含手机浏览器），不走管理鉴权
    if (req.path.startsWith('/chat/') || req.path === '/chat') return next();

    const ip = ctx.clientIp(req);
    if (isLoopback(ip)) return next(); // 本机放行

    const token = req.headers['x-admin-token'] || req.query.token;
    if (hasAdminPassword(ctx) && token && verifyToken(ctx, token)) return next();

    return res.status(401).json({ error: hasAdminPassword(ctx) ? 'admin_token_required' : 'admin_password_not_set' });
  };
}

function register(ctx) {
  const { app } = ctx;

  // 管理端页面
  let adminHtml = '<h1>admin.html 缺失</h1>';
  try {
    adminHtml = fs.readFileSync(path.join(__dirname, 'static', 'admin.html'), 'utf8');
  } catch (e) {}
  app.get('/admin', (req, res) => res.type('html').send(adminHtml));

  // 前端静态资源（Vue 本地文件，无 CDN 依赖）
  app.get('/vendor/vue.global.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(__dirname, '..', 'renderer', 'vendor', 'vue.global.js'));
  });

  // 登录（远程换 token；回环也可用，返回 ok）
  app.post('/api/admin/login', (req, res) => {
    const password = (req.body || {}).password;
    if (!hasAdminPassword(ctx)) {
      // 未设置密码：本机直接放行（无意义但无害），远程拒绝
      if (isLoopback(ctx.clientIp(req))) return res.json({ ok: true, loopback: true });
      return res.status(403).json({ error: 'admin_password_not_set' });
    }
    if (!password || !verifyPassword(password, ctx.settings.adminPasswordHash)) {
      ctx.logEvent({ event_type: 'auth_failed', ip: ctx.clientIp(req), target: 'admin_login', result: 'failed' });
      return res.status(401).json({ error: 'wrong_password' });
    }
    res.json({ ok: true, token: signToken(ctx, Date.now() + TOKEN_TTL_MS), expiresAt: Date.now() + TOKEN_TTL_MS });
  });

  // 设置/修改管理密码（本机，或已持有效 token 的远程管理员）
  app.post('/api/admin/password', (req, res) => {
    const ip = ctx.clientIp(req);
    const token = req.headers['x-admin-token'] || req.query.token;
    const authorized = isLoopback(ip) || (hasAdminPassword(ctx) && token && verifyToken(ctx, token));
    if (!authorized) return res.status(401).json({ error: 'admin_token_required' });

    const { oldPassword, newPassword } = req.body || {};
    if (hasAdminPassword(ctx) && isLoopback(ip) === false) {
      // 远程改密码必须验证旧密码
      if (!oldPassword || !verifyPassword(oldPassword, ctx.settings.adminPasswordHash)) {
        return res.status(401).json({ error: 'wrong_password' });
      }
    }
    if (hasAdminPassword(ctx) && oldPassword && !verifyPassword(oldPassword, ctx.settings.adminPasswordHash)) {
      return res.status(401).json({ error: 'wrong_password' });
    }
    if (!newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    ctx.settings.adminPasswordHash = hashPassword(newPassword);
    ctx.db.setConfig('settings', JSON.stringify(ctx.settings));
    ctx.logEvent({ event_type: 'admin_password_changed', ip, target: 'admin', result: 'success' });
    res.json({ ok: true });
  });

  // 查询是否已设置管理密码（供登录页提示，不泄露任何敏感信息）
  app.get('/api/admin/status', (req, res) => {
    res.json({ passwordSet: hasAdminPassword(ctx) });
  });

  // 管理 API 统一鉴权
  app.use('/api', adminAuth(ctx));
}

module.exports = { register, adminAuth, isLoopback };
