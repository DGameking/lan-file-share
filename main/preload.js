'use strict';

/**
 * 预加载脚本：在渲染进程沙箱中安全地暴露受控 API。
 * 渲染进程通过 window.lan 与 Electron 主进程通信（调用引擎方法、订阅实时事件）。
 * 严格只暴露白名单方法，避免直接暴露 Node / ipcRenderer。
 */
const { contextBridge, ipcRenderer } = require('electron');

const API = {
  // 请求-响应（调用引擎方法）
  invoke(channel, ...args) {
    return ipcRenderer.invoke(channel, ...args);
  },
  // 订阅引擎广播事件（devices / shares / logs / settings / stats / pairing-request / warn）
  onEvent(event, callback) {
    const listener = (_e, payload) => callback(payload);
    ipcRenderer.on('engine:' + event, listener);
    return () => ipcRenderer.removeListener('engine:' + event, listener);
  },
  // 应用重启（HTTPS 等设置生效）
  relaunch() {
    ipcRenderer.send('app:relaunch');
  },
  // 窗口控制
  minimize() {
    ipcRenderer.send('win:minimize');
  },
  toggleVisible() {
    ipcRenderer.send('win:toggle');
  },
  quit() {
    ipcRenderer.send('win:quit');
  },
  // 运行平台（darwin/win32/linux）：渲染层据此做平台化 UI 适配（如 macOS 红绿灯）
  platform: process.platform,
  // 主题（system/light/dark）：同步 Electron nativeTheme，让标题栏与页面主题一致
  setTheme(mode) {
    ipcRenderer.send('app:setTheme', mode);
  },
  // v1.20.0 打开会话气泡窗口
  openChat() {
    ipcRenderer.send('chat:open');
  },
};

contextBridge.exposeInMainWorld('lan', API);
