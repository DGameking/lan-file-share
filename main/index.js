'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
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
}

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

async function boot() {
  const dataDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(__dirname, '..', 'data');

  engine = new LanFileShare({ dataDir });
  await engine.init();
  bridgeEngineEvents();
  registerIpc();
  applyAutostart();

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

  tray = new TrayManager({
    onShow: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    onHide: () => mainWindow && mainWindow.hide(),
    onQuit: () => { willQuit = true; app.quit(); },
    onOpenHome: () => engine && shell.openExternal(`http://${engine.localIp}:${engine.httpPort}`),
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
  if (engine) {
    e.preventDefault();
    willQuit = true;
    try { await engine.stop(); } catch (_) {}
    app.exit(0);
  }
});
