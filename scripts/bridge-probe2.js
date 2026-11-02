'use strict';
const { spawn } = require('child_process');
const fs = require('fs');

const REPO = 'C:/Users/mukui/lanfs-build';
const NODE = 'C:/Program Files/nodejs/node.exe';
const SERVER = REPO + '/server/index.js';
const DA = 'C:/Users/mukui/AppData/Local/Temp/lfsA';
const DB = 'C:/Users/mukui/AppData/Local/Temp/lfsB';

function start(tag, port, dataDir) {
  const env = Object.assign({}, process.env, {
    LFS_DATA_DIR: dataDir, LFS_PORT: String(port), LFS_BRIDGE_DEBUG: '1', LFS_DISABLE_TRAY: '1',
  });
  const p = spawn(NODE, [SERVER], { cwd: REPO, env, windowsHide: true, stdio: 'ignore' });
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(port, path, body) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : '{}', signal: AbortSignal.timeout(4000),
    });
    return { status: r.status, text: await r.text().catch(() => '') };
  } catch (e) { return { status: 0, text: e.message }; }
}
function grepLog(dir, keys) {
  const f = `${dir}/logs/lfs-${new Date().toISOString().slice(0, 10)}.log`;
  if (!fs.existsSync(f)) return ['(日志文件不存在: ' + f + ')'];
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  return lines.filter((l) => keys.some((k) => l.includes(k)));
}

(async () => {
  const a = start('A', 18191, DA);
  const b = start('B', 18192, DB);
  await sleep(4000);

  // 1) A 添加一个共享（验证共享写入）
  const add = await post(18191, '/api/shares', { name: 'probe-share', path: DA, permission: 'read' });
  // 2) B 手动连接 A（绕过 UDP 发现，强制可达）
  const conn = await post(18192, '/api/devices/connect', { host: '127.0.0.1', port: 18191 });
  await sleep(6000);

  // 3) 取 B 的管理台自诊断（若有 bridge 状态）
  const diag = await post(18192, '/api/admin/diagnose', {});

  console.log('===== 结果摘要 =====');
  console.log('A 添加共享 ->', add.status, add.text.slice(0, 120));
  console.log('B 连接 A   ->', conn.status, conn.text.slice(0, 160));
  console.log('\n--- A 日志中与桥接/共享相关 ---');
  console.log(grepLog(DA, ['桥接', '共享目录', '设备上线', 'shares']).slice(-15).join('\n') || '(无)');
  console.log('\n--- B 日志中与桥接/共享相关 ---');
  console.log(grepLog(DB, ['桥接', '共享目录', '设备上线', 'shares', '对端']).slice(-15).join('\n') || '(无)');
  console.log('\n--- B 自诊断(截断) ---');
  console.log(diag.text.slice(0, 400));

  try { a.kill('SIGKILL'); } catch (e) {}
  try { b.kill('SIGKILL'); } catch (e) {}
  process.exit(0);
})();
