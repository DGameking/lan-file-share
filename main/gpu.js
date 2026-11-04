'use strict';

/* GPU 容错模块：自动降级软渲染（原 main/index.js 内联块外置） */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

let getLogger = () => null;

function initGpuFallback(loggerGetter) {
  getLogger = loggerGetter || getLogger;
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
    const eng = getLogger();
    try { if (eng && eng.logger) eng.logger.warn('electron', 'GPU 进程连续崩溃，已写入降级标记，重启进入软渲染模式'); } catch (e) {}
    app.relaunch();
    app.exit(0);
  }
});

}

module.exports = { initGpuFallback };
