'use strict';

/* 会话气泡窗口模块（v1.20.0）：独立小窗单例，外置自 main/index.js */
const { BrowserWindow, nativeTheme } = require('electron');
const path = require('path');

let chatWindow = null; // 单例
let getEngine = () => null;

function initChatWindow(engineGetter) { getEngine = engineGetter || getEngine; }

/**
 * v1.20.0 会话气泡窗口：独立小窗加载本机 /chat?kind=desktop&window=1。
 * 单例复用；HTTPS 自签证书仅对 127.0.0.1 放行（自有证书，无中间人风险）。
 */
function openChatWindow() {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) chatWindow.restore();
    chatWindow.show();
    chatWindow.focus();
    return;
  }
  const engine = getEngine();
  if (!engine) return;
  chatWindow = new BrowserWindow({
    width: 460,
    height: 700,
    minWidth: 360,
    minHeight: 480,
    title: '局域网会话',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f3f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 本机自签证书放行（仅限本窗口 session）
  chatWindow.webContents.session.setCertificateVerifyProc((req, cb) => {
    const host = (req.hostname || '').replace(/^\[|\]$/g, '');
    cb(host === '127.0.0.1' || host === '::1' || host === 'localhost' ? 0 : -2);
  });
  chatWindow.loadURL(`http${engine.useHttps ? 's' : ''}://127.0.0.1:${engine.httpPort}/chat?kind=desktop&window=1`);
  chatWindow.on('closed', () => { chatWindow = null; });
  chatWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (engine && engine.logger) engine.logger.warn('electron', '会话窗口加载失败', { code, desc, url });
  });
}

/** 气泡窗口是否开着（主进程通知去重用） */
function isChatWindowOpen() {
  return !!(chatWindow && !chatWindow.isDestroyed());
}

module.exports = { initChatWindow, openChatWindow, isChatWindowOpen };
