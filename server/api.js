'use strict';

/**
 * 管理 API（供桌面客户端前端调用）。所有路由挂载在 /api 下。
 * 统一约定：处理器抛错 → 400 + { error }；async 处理器同样安全。
 */
function registerApi(ctx) {
  const { app } = ctx;

  /** 统一错误包装：业务代码只写正常路径 */
  const w = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: e.message || String(e) });
    }
  };

  // ---------------- 共享文件夹 ----------------
  app.get('/api/shares', w((req, res) => res.json(ctx.listShares())));

  app.post('/api/shares', w((req, res) => res.json(ctx.addShare(req.body || {}))));

  app.put('/api/shares/:id', w((req, res) => {
    const updated = ctx.updateShare(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  }));

  app.delete('/api/shares/:id', w((req, res) => {
    ctx.removeShare(req.params.id);
    res.json({ ok: true });
  }));

  app.post('/api/shares/:id/start', w((req, res) => {
    ctx.startShare(req.params.id);
    res.json(ctx.getShare(req.params.id));
  }));

  app.post('/api/shares/:id/stop', w((req, res) => {
    ctx.stopShare(req.params.id);
    res.json(ctx.getShare(req.params.id));
  }));

  app.get('/api/shares/:id/qrcode', w(async (req, res) => {
    res.json({ dataUrl: await ctx.getShareQrcode(req.params.id) });
  }));

  // ---------------- 更新检查 ----------------
  app.get('/api/update/check', w(async (req, res) => {
    const auto = req.query.auto === '1';
    res.json(await ctx.checkUpdate(auto).catch((e) => ({ checked: false, error: e.message })));
  }));

  // ---------------- 设备 ----------------
  app.get('/api/devices', w((req, res) => res.json(ctx.deviceManager.list())));

  app.post('/api/devices/discover', w((req, res) => {
    ctx.discover();
    res.json({ ok: true });
  }));

  // connectManual 为 async（需探测对方 /api/self），必须 await 后再响应
  app.post('/api/devices/connect', w(async (req, res) => {
    res.json(await ctx.connectManual(req.body || {}));
  }));

  app.post('/api/devices/:id/trust', w((req, res) => {
    ctx.trustDevice(req.params.id, true);
    res.json({ ok: true });
  }));

  app.post('/api/devices/:id/blacklist', w((req, res) => {
    ctx.blacklistDevice(req.params.id, true);
    res.json({ ok: true });
  }));

  // 收藏/取消收藏（v1.20.0 收藏夹置顶）
  app.post('/api/devices/:id/star', w((req, res) => {
    const ok = ctx.starDevice(req.params.id, !!(req.body && req.body.starred));
    res.json({ ok });
  }));

  app.get('/api/devices/:id/ping', w(async (req, res) => {
    res.json({ ms: await ctx.pingDevice(req.params.id) });
  }));

  // ---------------- 邀请码 ----------------
  app.post('/api/invite/create', w((req, res) => {
    res.json({ code: ctx.inviteCreate() });
  }));

  app.post('/api/invite/join', w((req, res) => {
    res.json(ctx.inviteJoin((req.body || {}).code));
  }));

  // ---------------- 日志 / 统计 / 设置 ----------------
  app.get('/api/logs', w((req, res) => res.json(ctx.db.listLogs(200, 0))));
  app.delete('/api/logs', w((req, res) => {
    ctx.db.clearLogs();
    res.json({ ok: true });
  }));
  app.get('/api/stats', w((req, res) => res.json(ctx.stats())));
  app.get('/api/settings', w((req, res) => res.json(ctx.getSettings())));
  app.put('/api/settings', w((req, res) => {
    ctx.updateSettings(req.body || {});
    res.json(ctx.getSettings());
  }));

  // 本机信息
  app.get('/api/self', w((req, res) => res.json(ctx.selfInfo())));
}

module.exports = { registerApi };
