'use strict';

const crypto = require('../../security/crypto');
const { ipInCidr } = require('./ip-filter');

/**
 * 共享访问鉴权中间件工厂。
 * 校验：共享是否存在 / 是否已停止 / IP 白名单 / 访问密码。
 * 通过后将共享对象挂在 req.share。
 */
function shareAuth(ctx) {
  return (req, res, next) => {
    const shareId = req.params.shareId;
    const share = ctx.getShare(shareId);
    if (!share) return res.status(404).json({ error: 'share_not_found' });
    if (!share.enabled) return res.status(403).json({ error: 'share_stopped' });

    const clientIp = ctx.clientIp(req);

    // IP 白名单
    let whitelist = [];
    try {
      whitelist = share.ip_whitelist ? JSON.parse(share.ip_whitelist) : [];
    } catch (e) {
      whitelist = [];
    }
    if (Array.isArray(whitelist) && whitelist.length) {
      const ok = whitelist.some((c) => ipInCidr(clientIp, c));
      if (!ok) {
        ctx.logEvent({ event_type: 'connection_rejected', ip: clientIp, target: 'ip_filter', result: 'failed' });
        return res.status(403).json({ error: 'ip_denied' });
      }
    }

    // 访问密码
    if (share.password) {
      const provided = req.query.pwd || req.headers['x-share-password'] || (req.body && req.body.pwd);
      let plain = null;
      try {
        plain = crypto.aesDecrypt(share.password, ctx.masterKey);
      } catch (e) {
        plain = null;
      }
      if (!provided || provided !== plain) {
        ctx.logEvent({ event_type: 'auth_failed', ip: clientIp, target: share.id, result: 'failed' });
        return res.status(401).json({ error: 'password_required' });
      }
    }

    req.share = share;
    next();
  };
}

module.exports = { shareAuth };
