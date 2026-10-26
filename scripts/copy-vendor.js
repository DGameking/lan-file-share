'use strict';

/**
 * 将 Vue 3 全局构建拷贝到 renderer/vendor，使桌面客户端可在离线环境下运行（无需 CDN）。
 * 即使失败也不阻断安装。
 */
const fs = require('fs');
const path = require('path');

function copy() {
  try {
    const src = path.join(__dirname, '..', 'node_modules', 'vue', 'dist', 'vue.global.js');
    const destDir = path.join(__dirname, '..', 'renderer', 'vendor');
    if (!fs.existsSync(src)) {
      console.log('[copy-vendor] vue.global.js 未找到，跳过');
      return;
    }
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, 'vue.global.js'));
    console.log('[copy-vendor] 已拷贝 vue.global.js -> renderer/vendor');
  } catch (e) {
    console.log('[copy-vendor] 拷贝失败（可忽略）:', e.message);
  }
}

copy();
