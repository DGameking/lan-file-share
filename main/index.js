'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard, Notification, globalShortcut } = require('electron');
const path = require('path');
const LanFileShare = require('../server');
const TrayManager = require('./tray');

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
    backgroundColor: '#0f1115',
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

  // 渲染进程崩溃 → 运行日志（远程排障）
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (engine && engine.logger) engine.logger.error('electron', '渲染进程崩溃', details);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (engine && engine.logger) engine.logger.warn('electron', '页面加载失败', { code, desc, url });
  });
}

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
  h('engine:pingDevice', (id) => engine.pingDevice(id));
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
  h('engine:diagnose', async () => require('../server/diagnostics').run(engine));
  h('engine:checkUpdate', (opts) => engine.checkUpdate(!!(opts && opts.auto)));
  h('engine:openExternal', (url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(String(url));
    return { ok: true };
  });
  ipcMain.handle('engine:openLogsDir', async () => {
    if (engine) shell.openPath(require('path').join(engine.dataDir, 'logs'));
    return { ok: true };
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
const clipState = { last: '', timer: null };

function startClipboardSync() {
  if (clipState.timer) return;
  clipState.timer = setInterval(() => {
    try {
      if (!engine || !engine.settings || !engine.settings.clipboardSync) return;
      const text = clipboard.readText();
      if (!text || text === clipState.last) return;
      clipState.last = text;
      engine.clipSync(text);
    } catch (e) {}
  }, 1500);
}

/** 收到其他设备的剪贴板 → 写入本机系统剪贴板并通知 */
function onIncomingClip(payload) {
  try {
    if (!payload || typeof payload.text !== 'string' || !payload.text) return;
    if (payload.deviceId === (engine && engine.deviceId)) return;
    clipboard.writeText(payload.text);
    clipState.last = payload.text;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('engine:clip-incoming', { deviceName: payload.deviceName || '其他设备', text: payload.text });
    }
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: '剪贴板已同步', body: `来自「${payload.deviceName || '其他设备'}」的内容已复制到本机` });
        n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
        if (mainWindow && mainWindow.isVisible()) return; // 窗口可见时用 toast 即可
        n.show();
      }
    } catch (e) {}
  } catch (e) {}
}

async function boot() {
  const dataDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(__dirname, '..', 'data');

  engine = new LanFileShare({ dataDir });
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

  // 引擎设置变化时同步自启动
  engine.on && engine.on('settings', () => applyAutostart());

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
  });
  tray.create();

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
