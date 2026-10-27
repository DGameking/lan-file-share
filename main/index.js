'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, clipboard, Notification, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const LanFileShare = require('../server');
const TrayManager = require('./tray');

// ---- GPU 容错（自动降级到软渲染）----
// 现象：部分机器上 GPU 进程带沙箱启动即崩（exit_code=0xC0000005），渲染层无画面 → 主窗口全黑，
//       连 --disable-gpu 都无效（GPU 进程仍带沙箱），必须 --no-sandbox --disable-gpu 才能软渲染。
// 策略：① 曾触发过降级的机器（标记文件存在）或 LFS_DISABLE_GPU=1 → 启动即禁 GPU + 禁 GPU 沙箱；
//       ② 运行中 GPU 进程连续崩溃 ≥3 次 → 写标记并自动重启进入降级模式（降级模式下不再重启，防循环）。
const GPU_FLAG_FILE = path.join(app.getPath('userData'), 'gpu-fallback.flag');
function gpuFallbackActive() {
  return process.env.LFS_DISABLE_GPU === '1' || fs.existsSync(GPU_FLAG_FILE);
}
if (gpuFallbackActive()) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
}

let gpuCrashCount = 0;
app.on('child-process-gone', (_e, details) => {
  if (!details || details.type !== 'GPU' || details.reason !== 'crashed') return;
  if (gpuFallbackActive()) return; // 已降级仍崩（理论上不会）：只记日志不重启，防循环
  gpuCrashCount++;
  if (gpuCrashCount >= 3) {
    try { fs.writeFileSync(GPU_FLAG_FILE, new Date().toISOString()); } catch (e) {}
    try { if (engine && engine.logger) engine.logger.warn('electron', 'GPU 进程连续崩溃，已写入降级标记，重启进入软渲染模式'); } catch (e) {}
    app.relaunch();
    app.exit(0);
  }
});

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

/* ---------------- WebDAV 磁盘挂载（Windows） ---------------- */
const { execFile } = require('child_process');

function runCmd(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      if (err) reject(new Error(out.trim() || err.message));
      else resolve(out);
    });
  });
}

/** 提权执行 PowerShell 命令（触发一次 UAC 授权弹窗） */
function runElevated(psCommand) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${psCommand.replace(/'/g, "''")}'`],
      { windowsHide: true, timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(String(stdout || ''));
      }
    );
  });
}

async function mountWebdav({ url, password }) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'unsupported', hint: process.platform === 'darwin' ? 'macOS：访达 → 前往 → 连接服务器（⌘K）输入该地址' : 'Linux：文件管理器「连接到服务器」输入该地址' };
  }
  if (!/^http:\/\//.test(String(url || ''))) {
    return { ok: false, error: 'bad_url', hint: '仅支持 http 地址挂载（HTTPS 自签证书会被 Windows 拒绝）' };
  }

  // 1. 确认 WebClient 服务在运行；未运行或 BasicAuthLevel 不为 2 时提权修复（一次 UAC）
  let svc = '';
  try { svc = await runCmd('sc', ['query', 'WebClient'], 15000); } catch (e) { svc = String(e.message || ''); }
  const running = /RUNNING/.test(svc);
  let authLevel = '';
  try { authLevel = await runCmd('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters', '/v', 'BasicAuthLevel'], 15000); } catch (e) {}
  const needFix = !running || !/0x2/.test(authLevel);
  if (needFix) {
    try {
      await runElevated(
        'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters" /v BasicAuthLevel /t REG_DWORD /d 2 /f; ' +
        'sc config WebClient start= demand; ' +
        'net start WebClient'
      );
    } catch (e) {
      return { ok: false, error: 'elevation_denied', hint: '需要管理员授权启用 WebDAV 客户端（WebClient 服务）。可手动执行：services.msc 启动 WebClient，并将注册表 WebClient\\Parameters\\BasicAuthLevel 设为 2' };
    }
    try { svc = await runCmd('sc', ['query', 'WebClient'], 15000); } catch (e) {}
    if (!/RUNNING/.test(svc)) {
      return { ok: false, error: 'webclient_not_running', hint: 'WebClient 服务未能启动，请手动在服务中启动 WebClient 后重试' };
    }
  }

  // 2. net use 挂载（* 让 Windows 自动挑空闲盘符）
  const args = ['use', '*', url];
  if (password) args.push('/user:lanfileshare', String(password));
  args.push('/persistent:yes');
  let out;
  try {
    out = await runCmd('net', args, 60000);
  } catch (e) {
    const msg = String(e.message || '');
    if (/1326|密码|password/i.test(msg)) return { ok: false, error: 'auth_failed', hint: '密码错误：该共享设置了访问密码，请输入正确密码后重试' };
    if (/1223|85|已在使用|local name/i.test(msg)) return { ok: false, error: 'already_mapped', hint: '该共享已被挂载，或盘符被占用' };
    return { ok: false, error: 'net_use_failed', hint: msg.slice(0, 300) };
  }
  const m = out.match(/([A-Z]:)/);
  const letter = m ? m[1] : null;
  return { ok: true, data: { letter } };
}

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
