'use strict';

/**
 * 管理 API（供桌面客户端前端调用）。
 * 所有路由挂载在 /api 下。
 */
function registerApi(ctx) {
  const { app } = ctx;

  // ---------------- 共享文件夹 ----------------
  app.get('/api/shares', (req, res) => res.json(ctx.listShares()));

  app.post('/api/shares', (req, res) => {
    try {
      const share = ctx.addShare(req.body || {});
      res.json(share);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/shares/:id', (req, res) => {
    const updated = ctx.updateShare(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'not_found' });
    res.json(updated);
  });

  app.delete('/api/shares/:id', (req, res) => {
    ctx.removeShare(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/shares/:id/start', (req, res) => {
    ctx.startShare(req.params.id);
    res.json(ctx.getShare(req.params.id));
  });

  app.post('/api/shares/:id/stop', (req, res) => {
    ctx.stopShare(req.params.id);
    res.json(ctx.getShare(req.params.id));
  });

  app.get('/api/shares/:id/qrcode', async (req, res) => {
    try {
      const dataUrl = await ctx.getShareQrcode(req.params.id);
      res.json({ dataUrl });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------- 更新检查 ----------------
  app.get('/api/update/check', async (req, res) => {
    const auto = req.query.auto === '1';
    res.json(await ctx.checkUpdate(!auto ? false : true).catch((e) => ({ checked: false, error: e.message })));
  });

  // ---------------- 设备 ----------------
  app.get('/api/devices', (req, res) => res.json(ctx.deviceManager.list()));

  app.post('/api/devices/discover', (req, res) => {
    ctx.discover();
    res.json({ ok: true });
  });

  app.post('/api/devices/connect', (req, res) => {
    try {
      const d = ctx.connectManual(req.body || {});
      res.json(d);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/devices/:id/trust', (req, res) => {
    ctx.trustDevice(req.params.id, true);
    res.json({ ok: true });
  });

  app.post('/api/devices/:id/blacklist', (req, res) => {
    ctx.blacklistDevice(req.params.id, true);
    res.json({ ok: true });
  });

  app.get('/api/devices/:id/ping', async (req, res) => {
    const ms = await ctx.pingDevice(req.params.id);
    res.json({ ms });
  });

  // ---------------- 邀请码 ----------------
  app.post('/api/invite/create', (req, res) => {
    const code = ctx.inviteCreate();
    res.json({ code });
  });

  app.post('/api/invite/join', (req, res) => {
    const r = ctx.inviteJoin((req.body || {}).code);
    res.json(r);
  });

  // ---------------- 日志 / 统计 / 设置 ----------------
  app.get('/api/logs', (req, res) => res.json(ctx.db.listLogs(200, 0)));
  app.delete('/api/logs', (req, res) => {
    ctx.db.clearLogs();
    res.json({ ok: true });
  });
  app.get('/api/stats', (req, res) => res.json(ctx.stats()));
  app.get('/api/settings', (req, res) => res.json(ctx.getSettings()));
  app.put('/api/settings', (req, res) => {
    ctx.updateSettings(req.body || {});
    res.json(ctx.getSettings());
  });

  // 本机信息
  app.get('/api/self', (req, res) => res.json(ctx.selfInfo()));
}

module.exports = { registerApi };
