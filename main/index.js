'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard, Notification, globalShortcut, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const LanFileShare = require('../server');
const TrayManager = require('./tray');
const { initGpuFallback } = require('./gpu');
const { initChatWindow, openChatWindow, isChatWindowOpen } = require('./chat-window');
const { initClipboardSync, startClipboardSync, onIncomingClip, clipState } = require('./clipboard-sync');
const { mountWebdav, runCmd } = require('./webdav');

initGpuFallback(() => engine);
initChatWindow(() => engine);
initClipboardSync({ getEngine: () => engine, getMainWindow: () => mainWindow });


// 单实例锁，避免重复启动多个共享服务
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let tray = null;
let engine = null;
let willQuit = false;
const startHidden = process.argv.includes('--hidden');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 880,
    minHeight: 600,
    title: '局域网文件共享',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f3f5f9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
  });

  // 关闭按钮 → 默认最小化到托盘（除非用户选择退出）
  mainWindow.on('close', (e) => {
    if (willQuit) return;
    const minimizeToTray = engine && engine.settings && engine.settings.minimizeToTray;
    if (minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 渲染进程崩溃 → 运行日志（远程排障）；自动 reload 恢复（最多 2 次，防循环）
  let rendererReloadCount = 0;
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (engine && engine.logger) engine.logger.error('electron', '渲染进程崩溃', details);
    if (details && details.reason === 'crashed' && rendererReloadCount < 2) {
      rendererReloadCount++;
      setTimeout(() => {
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); } catch (e) {}
      }, 500);
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (engine && engine.logger) engine.logger.warn('electron', '页面加载失败', { code, desc, url });
  });
}

/**

// 主进程未捕获异常 → 运行日志（不中断应用）
process.on('uncaughtException', (e) => {
  if (engine && engine.logger) engine.logger.error('electron', '主进程未捕获异常', String(e && e.stack || e));
});
process.on('unhandledRejection', (e) => {
  if (engine && engine.logger) engine.logger.error('electron', '未处理的 Promise 拒绝', String(e && (e.stack || e.message) || e));
});

/** 把引擎的广播事件同时转发给渲染进程（WebSocket 之外，本机窗口也实时刷新） */
function bridgeEngineEvents() {
  if (!engine) return;
  const original = engine.broadcast.bind(engine);
  engine.broadcast = (event, payload) => {
    original(event, payload);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine:' + event, payload);
    }
    if (event === 'settings') applyAutostart();
  };
  engine.on('pairing-request', (d) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine:pairing-request', d);
  });
  engine.on('warn', (m) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine:warn', m);
  });
}

/** 注册渲染进程可调用的引擎方法 */
function registerIpc() {
  const h = (channel, fn) => ipcMain.handle(channel, async (e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  h('engine:snapshot', () => engine._snapshot());
  h('engine:getSelf', () => engine.selfInfo());
  h('engine:getStats', () => engine.stats());
  h('engine:getSettings', () => engine.getSettings());
  h('engine:updateSettings', (patch) => { engine.updateSettings(patch || {}); return engine.getSettings(); });

  h('engine:listShares', () => engine.listShares());
  h('engine:addShare', (body) => engine.addShare(body || {}));
  h('engine:updateShare', (id, patch) => engine.updateShare(id, patch || {}));
  h('engine:removeShare', (id) => engine.removeShare(id));
  h('engine:startShare', (id) => engine.startShare(id));
  h('engine:stopShare', (id) => engine.stopShare(id));
  h('engine:getShareQrcode', (id) => engine.getShareQrcode(id));

  h('engine:listDevices', () => engine.deviceManager.list());
  h('engine:trustDevice', (id, trusted) => engine.trustDevice(id, !!trusted));
  h('engine:blacklistDevice', (id, black) => engine.blacklistDevice(id, !!black));
  h('engine:starDevice', (id, starred) => engine.starDevice(id, !!starred));
  h('engine:setDeviceAlias', (id, alias) => engine.setDeviceAlias(id, String(alias || '')));
  h('engine:pingDevice', (id) => engine.pingDevice(id));
  h('engine:remoteSharesSnapshot', () => (engine.bridge ? engine.bridge.remoteShareList() : []));
  h('engine:refreshRemoteShares', () => ({ requested: engine.bridge ? engine.bridge.requestSharesAll() : 0 }));
  h('engine:connectManual', (opts) => engine.connectManual(opts || {}));
  h('engine:discover', () => engine.discover());

  h('engine:getLogs', (limit) => engine.db.listLogs(limit || 200));
  h('engine:clearLogs', () => engine.db.clearLogs());

  h('engine:inviteCreate', () => engine.inviteCreate());
  h('engine:inviteJoin', (code) => engine.inviteJoin(code || ''));

  // 本地文件系统交互
  ipcMain.handle('engine:pickFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return { ok: true, data: null };
    return { ok: true, data: res.filePaths[0] };
  });
  ipcMain.handle('engine:openFolder', async (_e, p) => {
    if (p) shell.openPath(p);
    return { ok: true };
  });
  ipcMain.handle('engine:openReceivedFolder', async () => {
    if (engine && engine.receivedDir) shell.openPath(engine.receivedDir);
    return { ok: true };
  });
  // 收件箱单文件操作（路径严格限定在接收目录内，防目录穿越）
  const recvFilePath = (name) => {
    const dir = engine && engine.receivedDir;
    if (!dir) return null;
    const p = path.resolve(dir, path.basename(String(name || '')));
    return p.startsWith(path.resolve(dir) + path.sep) || p === path.resolve(dir) ? p : null;
  };
  ipcMain.handle('engine:openReceivedFile', async (_e, name) => {
    const p = recvFilePath(name);
    if (!p || !fs.existsSync(p)) return { ok: false, error: 'not_found' };
    shell.openPath(p);
    return { ok: true };
  });
  ipcMain.handle('engine:deleteReceivedFile', async (_e, name) => {
    const p = recvFilePath(name);
    if (!p || !fs.existsSync(p)) return { ok: false, error: 'not_found' };
    try {
      await shell.trashItem(p); // 优先移入系统回收站，可反悔
    } catch (e) {
      try { fs.unlinkSync(p); } catch (e2) { return { ok: false, error: e2.message }; }
    }
    try { engine.db.removeDropHistoryByFileId(String(name)); } catch (e) {}
    return { ok: true };
  });
  ipcMain.handle('engine:saveReceivedAs', async (_e, name) => {
    const p = recvFilePath(name);
    if (!p || !fs.existsSync(p)) return { ok: false, error: 'not_found' };
    const res = await dialog.showSaveDialog(mainWindow, { defaultPath: path.basename(p) });
    if (res.canceled || !res.filePath) return { ok: true, data: null };
    try {
      fs.copyFileSync(p, res.filePath);
      return { ok: true, data: res.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  // v1.20.0 LocalSend 拉取链接：选文件 → 生成 URL（对方 LS 客户端/浏览器可下载）
  ipcMain.handle('localsend:createOffer', async (_e, opts = {}) => {
    if (!engine || !engine.localsend) return { ok: false, error: 'LocalSend 网关未运行' };
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要分享给 LocalSend 设备的文件',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return { ok: true, data: null };
    const items = res.filePaths.map((p) => {
      let size = 0;
      try { size = fs.statSync(p).size; } catch (e) {}
      return { path: p, name: path.basename(p), size, mime: '' };
    });
    try {
      const offer = engine.localsend.createDownloadOffer(items, { pin: String(opts.pin || '') });
      if (!offer) return { ok: false, error: 'no_valid_files' };
      return { ok: true, data: offer };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  h('engine:diagnose', async () => require('../server/diagnostics').run(engine));
  h('engine:checkUpdate', (opts) => engine.checkUpdate(!!(opts && opts.auto)));
  h('engine:update:download', () => engine.downloadUpdate());
  h('engine:update:abort', () => engine.abortUpdate());
  h('engine:update:install', () => {
    const r = engine.installUpdate();
    if (r.ok && r.mode === 'manual') shell.showItemInFolder(r.file); // mac/linux：定位到安装文件
    return r;
  });
  h('engine:openExternal', (url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(String(url));
    return { ok: true };
  });

  // WebDAV 挂载为本地磁盘（Windows：net use；自动配置 WebClient 服务，需要一次 UAC 授权）
  ipcMain.handle('engine:mountWebdav', async (_e, opts = {}) => {
    return mountWebdav(opts);
  });
  ipcMain.handle('engine:unmountWebdav', async (_e, letter) => {
    if (process.platform !== 'win32' || !/^[A-Za-z]:$/.test(String(letter || ''))) return { ok: false, error: 'unsupported' };
    try {
      await runCmd('net', ['use', String(letter).toUpperCase(), '/delete', '/y']);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('engine:openLogsDir', async () => {
    if (engine) shell.openPath(require('path').join(engine.dataDir, 'logs'));
    return { ok: true };
  });

  // LocalSend 互通投送（v1.19.0）：渲染层无法连自签 HTTPS，由主进程代发
  ipcMain.handle('localsend:send', async (_e, payload = {}) => {
    if (!engine || !engine.localsend) return { ok: false, error: 'LocalSend 网关未运行' };
    const { host, port, protocol, files } = payload;
    if (!host || !Array.isArray(files) || !files.length) return { ok: false, error: 'bad_request' };
    try {
      const r = await engine.localsend.sendFiles(
        { host, port: Number(port) || 53317, protocol: protocol === 'http' ? 'http' : 'https' },
        files.map((f) => ({ path: String(f.path || ''), name: String(f.name || ''), size: Number(f.size) || 0, mime: String(f.mime || '') }))
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 剪贴板（供渲染层读取/写入系统剪贴板）
  ipcMain.handle('clip:read', () => ({ ok: true, data: clipboard.readText() || '' }));
  ipcMain.handle('clip:write', (_e, text) => {
    if (typeof text === 'string' && text) {
      clipboard.writeText(text);
      clipState.last = text;
    }
    return { ok: true };
  });

  // 应用重启（HTTPS 等设置切换后生效）
  ipcMain.on('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  // 主题同步（system/light/dark）：nativeTheme 驱动 prefers-color-scheme 与标题栏配色
  ipcMain.on('app:setTheme', (_e, mode) => {
    nativeTheme.themeSource = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'system';
  });

  // 窗口控制
  ipcMain.on('win:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('win:toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  });
  ipcMain.on('win:quit', () => { willQuit = true; app.quit(); });
}

function applyAutostart() {
  const startup = engine && engine.settings && engine.settings.startup;
  app.setLoginItemSettings({
    openAtLogin: !!startup,
    path: process.execPath,
    args: ['--hidden'],
  });
}

/* ---------------- 剪贴板同步 ---------------- */

/* ---------------- WebDAV 磁盘挂载（Windows） ---------------- */

async function boot() {
  const dataDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(__dirname, '..', 'data');

  engine = new LanFileShare({ dataDir, version: app.getVersion() });
  await engine.init();
  bridgeEngineEvents();
  registerIpc();
  applyAutostart();

  // 服务器模式：主界面不弹出，共享服务在后台持续运行（托盘驻留）
  if (engine.settings.serverMode && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: '局域网文件共享服务器已启动',
          body: `http://${engine.localIp}:${engine.httpPort} · 通过托盘图标或管理控制台管理`,
        }).show();
      }
    } catch (e) {}
  }

  // 剪贴板同步：本机变化 → 推送给所有设备；其他设备变化 → 写入本机剪贴板
  engine.on('clip-incoming', onIncomingClip);
  startClipboardSync();

  // 应用内更新：安装包已启动（Windows 静默安装）→ 稍候退出本应用，安装器接棒并自动重启
  engine.on('update.install', () => {
    setTimeout(() => {
      willQuit = true;
      try { globalShortcut.unregisterAll(); } catch (e) {}
      app.exit(0);
    }, 800);
  });

  // 引擎设置变化时同步自启动
  engine.on && engine.on('settings', () => applyAutostart());

  // v1.21.0 桌面聊天系统通知：远端消息到达且气泡窗口未开时弹系统通知（窗口开着时由页面内通知负责，避免重复）
  const chatNotifSeen = new Set(); // 消息 id 去重
  engine.on('chat.msg', (rec) => {
    try {
      if (!rec || chatNotifSeen.has(rec.id)) return;
      chatNotifSeen.add(rec.id);
      if (chatNotifSeen.size > 200) chatNotifSeen.delete(chatNotifSeen.values().next().value);
      if (isChatWindowOpen()) return; // 气泡窗口在：页面内已有通知
      let body = '';
      if (rec.kind === 'file') {
        try { body = '[文件] ' + JSON.parse(rec.file_meta || '[]').map((f) => f.name).join('、'); } catch (e) { body = '[文件]'; }
      } else {
        body = String(rec.text || '').slice(0, 100);
      }
      if (rec.to) body = '【私信】' + body;
      if (Notification.isSupported()) {
        const n = new Notification({ title: `💬 ${rec.sender_name || '局域网会话'}`, body });
        n.on('click', () => openChatWindow());
      }
    } catch (e) {}
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('engine:ready', engine._snapshot());
  }
}

app.whenReady().then(async () => {
  createWindow();
  Menu.setApplicationMenu(null);
  try {
    await boot();
  } catch (e) {
    console.error('引擎启动失败:', e);
    dialog.showErrorBox('启动失败', String(e && e.message || e));
  }

  /** 显示主窗口并跳转到指定页签 */
  const showAt = (tab) => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      if (tab) mainWindow.webContents.send('engine:nav', tab);
    }
  };

  // 全局快捷键：快速投送（注：Windows 系统限制，托盘图标本身无法接收文件拖放）
  try {
    globalShortcut.register('Alt+Shift+D', () => showAt('drop'));
  } catch (e) {}

  tray = new TrayManager({
    onShow: () => showAt(null),
    onHide: () => mainWindow && mainWindow.hide(),
    onQuit: () => { willQuit = true; app.quit(); },
    onOpenHome: () => engine && shell.openExternal(`http${engine.useHttps ? 's' : ''}://${engine.localIp}:${engine.httpPort}`),
    onQuickDrop: () => showAt('drop'),
    onChat: () => openChatWindow(),
  });
  tray.create();

  // 渲染层也可以唤起会话气泡
  ipcMain.on('chat:open', () => openChatWindow());

  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
});

app.on('before-quit', async (e) => {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  if (engine) {
    e.preventDefault();
    willQuit = true;
    try { await engine.stop(); } catch (_) {}
    app.exit(0);
  }
});
