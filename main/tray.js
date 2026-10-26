'use strict';

const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');

/**
 * 系统托盘管理：显示/隐藏窗口、打开共享目录、退出。
 * 传入的 callbacks 由 main 提供，避免循环依赖。
 */
class TrayManager {
  constructor({ onShow, onHide, onQuit, onOpenHome, onQuickDrop }) {
    this.onShow = onShow;
    this.onHide = onHide;
    this.onQuit = onQuit;
    this.onOpenHome = onOpenHome;
    this.onQuickDrop = onQuickDrop;
    this.tray = null;
  }

  /** 生成一张最简单的占位图标（1x1 透明 PNG），避免缺图标导致崩溃 */
  _defaultIcon() {
    // 16x16 蓝色圆点 PNG（base64）
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMElEQVR4nO3OMQEAAAgDoJk/aRZw0gJ6mUm3bdu2bdu2bdu2bdu2bdu2bQ0H0QwBAQQC/1Fg0QAAAABJRU5ErkJggg==';
    return nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
  }

  create() {
    let icon;
    try {
      const iconPath = path.join(__dirname, 'assets', 'tray.png');
      icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) icon = this._defaultIcon();
    } catch (e) {
      icon = this._defaultIcon();
    }
    this.tray = new Tray(icon);
    this.tray.setToolTip('局域网文件共享');

    const menu = Menu.buildFromTemplate([
      { label: '快速投送 (Alt+Shift+D)', click: () => this.onQuickDrop && this.onQuickDrop() },
      { label: '打开主界面', click: () => this.onShow && this.onShow() },
      { label: '隐藏到托盘', click: () => this.onHide && this.onHide() },
      { type: 'separator' },
      { label: '退出', click: () => this.onQuit && this.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.on('click', () => (this.onShow ? this.onShow() : null));
    return this.tray;
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = TrayManager;
