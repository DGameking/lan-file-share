'use strict';
// 在单机上启动两个服务实例，验证 discovery + bridge 是否能自动发现对端并建立桥接
const { spawn } = require('child_process');
const fs = require('fs');

const REPO = 'C:/Users/mukui/lanfs-build';
const NODE = 'C:/Program Files/nodejs/node.exe';
const SERVER = REPO + '/server/index.js';

function start(tag, port, dataDir) {
  const env = Object.assign({}, process.env, {
    LFS_DATA_DIR: dataDir,
    LFS_PORT: String(port),
    LFS_BRIDGE_DEBUG: '1',
    LFS_DISABLE_TRAY: '1',
  });
  const p = spawn(NODE, [SERVER], {
    cwd: REPO,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const cap = (s) => {
    for (const ln of String(s).split('\n')) {
      lines.push(tag + ' | ' + ln);
    }
  };
  p.stdout.on('data', cap);
  p.stderr.on('data', cap);
  return { p, lines, tag };
}

const a = start('A', 18191, 'C:/Users/mukui/AppData/Local/Temp/lfsA');
const b = start('B', 18192, 'C:/Users/mukui/AppData/Local/Temp/lfsB');

setTimeout(() => {
  const all = [...a.lines, ...b.lines].join('\n');
  const keywords = ['桥接', '设备上线', 'discovery', 'discover', 'listen', 'EADDRINUSE', 'error', 'Error', 'started', 'listening', '1819'];
  const hit = all.split('\n').filter((l) => keywords.some((k) => l.includes(k)));
  console.log('===== 桥接/发现 相关日志 =====');
  console.log(hit.slice(0, 60).join('\n') || '(无匹配日志)');
  console.log('\n===== A 进程是否存活:', !a.p.atkilled, ' B 进程是否存活:', !b.p.killed, ' =====');
  try { a.p.kill('SIGKILL'); } catch (e) {}
  try { b.p.kill('SIGKILL'); } catch (e) {}
  process.exit(0);
}, 9000);
