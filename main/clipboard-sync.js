'use strict';

/* 剪贴板跨设备同步模块：本机变化推送出去，远端变化写入本机并通知 */
const { clipboard, Notification } = require('electron');

let getEngine = () => null;
let getMainWindow = () => null;

function initClipboardSync(ctx) {
  getEngine = ctx.getEngine || getEngine;
  getMainWindow = ctx.getMainWindow || getMainWindow;
}

const clipState = { last: '', timer: null };

function startClipboardSync() {
  if (clipState.timer) return;
  clipState.timer = setInterval(() => {
    try {
      const eng = getEngine();
      if (!eng || !eng.settings || !eng.settings.clipboardSync) return;
      const text = clipboard.readText();
      if (!text || text === clipState.last) return;
      clipState.last = text;
      eng.clipSync(text);
    } catch (e) {}
  }, 1500);
}

/** 收到其他设备的剪贴板 → 写入本机系统剪贴板并通知 */
function onIncomingClip(payload) {
  try {
    if (!payload || typeof payload.text !== 'string' || !payload.text) return;
    const eng = getEngine();
    if (payload.deviceId === (eng && eng.deviceId)) return;
    clipboard.writeText(payload.text);
    clipState.last = payload.text;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('engine:clip-incoming', { deviceName: payload.deviceName || '其他设备', text: payload.text });
    }
    try {
      if (Notification.isSupported()) {
        const n = new Notification({ title: '剪贴板已同步', body: `来自「${payload.deviceName || '其他设备'}」的内容已复制到本机` });
        n.on('click', () => { if (win) { win.show(); win.focus(); } });
        if (win && win.isVisible()) return; // 窗口可见时用 toast 即可
        n.show();
      }
    } catch (e) {}
  } catch (e) {}
}

module.exports = { initClipboardSync, startClipboardSync, onIncomingClip, clipState };
