'use strict';

/**
 * 轻量 API 访问日志中间件（仅记录 /api 调用，避免刷屏）。
 */
function apiLogger(ctx) {
  return (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      ctx.logEvent({
        event_type: 'api_access',
        ip: ctx.clientIp(req),
        target: req.method + ' ' + req.path,
        result: 'success',
      });
    }
    next();
  };
}

module.exports = { apiLogger };
