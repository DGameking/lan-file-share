'use strict';
/* 双实例最小复现：A 发 chat.msg → B 是否收到；输出双方桥接日志 */
const WebSocket = require('ws');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = process.cwd();
const NODE = process.execPath;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function startInstance(port, dataDir) {
  const child = execFile(NODE, [path.join(BASE, 'server', 'index.js')], {
    env: { ...process.env, LFS_PORT: String(port), LFS_DATA_DIR: dataDir },
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stdout.write(`[${port}][err] ` + d));
  return child;
}

async function logs(port) {
  try {
    const r = await (await fetch(`http://127.0.0.1:${port}/api/admin/runtime-logs?lines=200`)).json();
    return (r.lines || []).filter((l) => /bridge|chat/i.test(l));
  } catch (e) { return ['(日志获取失败: ' + e.message + ')']; }
}

async function main() {
  const dirs = ['tmp-t4/a', 'tmp-t4/b'];
  for (const d of dirs) fs.rmSync(path.join(BASE, d), { recursive: true, force: true });
  for (const d of dirs) fs.mkdirSync(path.join(BASE, d), { recursive: true });
  const a = startInstance(18220, path.join(BASE, 'tmp-t4', 'a'));
  const b = startInstance(18221, path.join(BASE, 'tmp-t4', 'b'));
  await wait(4000);
  const selfA = await (await fetch('http://127.0.0.1:18220/api/self')).json();
  const selfB = await (await fetch('http://127.0.0.1:18221/api/self')).json();
  console.log('A =', selfA.deviceId, '| B =', selfB.deviceId);
  await wait(8000); // 等发现+桥接

  const evB = [];
  const wsB = new WebSocket('ws://127.0.0.1:18221');
  wsB.on('message', (raw) => { try { const m = JSON.parse(raw.toString()); if (m.event === 'chat.msg') evB.push(m.payload); } catch (e) {} });
  await new Promise((r) => wsB.on('open', r));
  wsB.send(JSON.stringify({ type: 'chat.hello', clientId: 'ub', name: 'B页' }));

  const wsA = new WebSocket('ws://127.0.0.1:18220');
  await new Promise((r) => wsA.on('open', r));
  wsA.send(JSON.stringify({ type: 'chat.hello', clientId: 'ua', name: 'A页' }));
  await wait(2000);

  console.log('== A 发送消息 ==');
  wsA.send(JSON.stringify({ type: 'chat.send', text: '桥接定位-' + Date.now() }));
  await wait(2500);
  console.log('B 收到 chat.msg 条数:', evB.length);
  const histB = await (await fetch('http://127.0.0.1:18221/api/chat/history')).json();
  console.log('B 历史:', JSON.stringify(histB).slice(0, 200));

  console.log('== A 桥接日志 ==');
  (await logs(18220)).slice(-10).forEach((l) => console.log('  [A]', l.slice(0, 160)));
  console.log('== B 桥接日志 ==');
  (await logs(18221)).slice(-10).forEach((l) => console.log('  [B]', l.slice(0, 160)));

  wsA.close(); wsB.close(); a.kill(); b.kill();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
