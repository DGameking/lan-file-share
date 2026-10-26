'use strict';
/* 双实例联调测试：验证 会话桥 / 投送 / 剪贴板同步事件 链路 */
process.env.LFS_CHAT_FILES = '';
const WebSocket = require('ws');

const BASE = process.cwd();
const { execFile } = require('child_process');
const path = require('path');
const NODE = process.execPath;

function startInstance(port, dataDir) {
  const child = execFile(NODE, [path.join(BASE, 'server', 'index.js')], {
    env: { ...process.env, LFS_PORT: String(port), LFS_DATA_DIR: dataDir },
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${port}] ` + d));
  child.stderr.on('data', (d) => process.stdout.write(`[${port}][err] ` + d));
  return child;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsClient(port, name, clientId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const events = [];
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      events.push(m);
      if (m.event === 'chat.msg' && m.payload.sender_id !== clientId) {
        console.log(`  ✔ [${name}] 收到消息: "${m.payload.text}" (来自 ${m.payload.sender_name})`);
      }
      if (m.event === 'chat.members') {
        console.log(`  ✔ [${name}] 成员列表(${m.payload.length}): ${m.payload.map((x) => x.name).join(', ')}`);
      }
      if (m.event === 'clip.sync') {
        console.log(`  ✔ [${name}] 剪贴板同步事件: "${String(m.payload.text).slice(0, 30)}" 来自 ${m.payload.deviceName}`);
      }
    } catch (e) {}
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'chat.hello', clientId, name }));
  return { ws, events };
}

async function main() {
  const fs = require('fs');
  for (const d of ['tmp-t2/a', 'tmp-t2/b']) fs.rmSync(path.join(BASE, d), { recursive: true, force: true });
  fs.mkdirSync(path.join(BASE, 'tmp-t2/a'), { recursive: true });
  fs.mkdirSync(path.join(BASE, 'tmp-t2/b'), { recursive: true });

  console.log('== 启动实例 A(18200) / B(18201) ==');
  const a = startInstance(18200, path.join(BASE, 'tmp-t2', 'a'));
  const b = startInstance(18201, path.join(BASE, 'tmp-t2', 'b'));
  await wait(4000);

  console.log('== 检查互相发现 ==');
  const selfA = await (await fetch('http://127.0.0.1:18200/api/self')).json();
  const selfB = await (await fetch('http://127.0.0.1:18201/api/self')).json();
  console.log('A 设备ID:', selfA.deviceId);
  console.log('B 设备ID:', selfB.deviceId);
  await wait(6000); // 等待 UDP 心跳互见 + 桥接建立（含重试）
  const devA = (await (await fetch('http://127.0.0.1:18200/api/devices')).json());
  const devB = (await (await fetch('http://127.0.0.1:18201/api/devices')).json());
  const listA = devA.devices || devA;
  const listB = devB.devices || devB;
  console.log('A 发现设备:', listA.map((d) => `${d.device_name}(${d.is_online ? '在线' : '离线'})`).join(', '));
  console.log('B 发现设备:', listB.map((d) => `${d.device_name}(${d.is_online ? '在线' : '离线'})`).join(', '));

  console.log('== 客户端连入 A、B ==');
  const c1 = await wsClient(18200, 'A页面用户', 'ua1');
  const c2 = await wsClient(18201, 'B页面用户', 'ub1');
  await wait(4000); // 等待成员桥接同步

  console.log('== A 发消息，B 应能收到 ==');
  c1.ws.send(JSON.stringify({ type: 'chat.send', text: '跨设备桥测试消息' }));
  await wait(1500);

  console.log('== 检查 B 的历史中是否有 A 的消息 ==');
  const histB = await (await fetch('http://127.0.0.1:18201/api/chat/history')).json();
  const found = (histB.rows || histB).some((r) => r.text === '跨设备桥测试消息');
  console.log(found ? '  ✔ 历史已同步' : '  ✘ 历史未同步', JSON.stringify((histB.rows || histB).slice(-3)));

  console.log('== 投送文件到 B ==');
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('hello drop')], { type: 'text/plain' }), '测试投送.txt');
  const dropRes = await fetch('http://127.0.0.1:18201/api/drop?from=设备A', { method: 'POST', body: fd });
  console.log('  drop 响应:', JSON.stringify(await dropRes.json()));
  const recvDir = path.join(BASE, 'tmp-t2', 'b', 'received');
  console.log('  接收目录:', fs.existsSync(recvDir) ? fs.readdirSync(recvDir).join(', ') : '(不存在)');

  console.log('== 完成，清理 ==');
  c1.ws.close(); c2.ws.close();
  a.kill(); b.kill();
  await wait(800);
  process.exit(0);
}

main().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
