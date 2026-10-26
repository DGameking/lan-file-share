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
        const desc = m.payload.kind === 'file' ? '[文件] ' + JSON.parse(m.payload.file_meta || '[]').map((f) => f.name).join(', ') : m.payload.text;
        console.log(`  ✔ [${name}] 收到消息: "${desc}" (来自 ${m.payload.sender_name})`);
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

  console.log('== 跨设备会话文件：A 上传 → B 通过代理下载 ==');
  const fd2 = new FormData();
  fd2.append('file', new Blob([Buffer.from('跨设备文件内容-hello')], { type: 'text/plain' }), '桥接文件.txt');
  const up = await (await fetch('http://127.0.0.1:18200/api/chat/upload', { method: 'POST', body: fd2 })).json();
  if (!up.ok) throw new Error('A 上传失败');
  const f0 = up.files[0];
  c1.ws.send(JSON.stringify({ type: 'chat.file', files: [{ fileId: f0.fileId, name: f0.name, size: f0.size, mime: f0.mime }] }));
  await wait(1500);
  const histB2 = await (await fetch('http://127.0.0.1:18201/api/chat/history')).json();
  const fileMsg = (histB2.rows || histB2).reverse().find((r) => r.kind === 'file');
  if (!fileMsg) throw new Error('B 历史中没有文件消息');
  const meta = JSON.parse(fileMsg.file_meta || '[]')[0];
  console.log('  B 收到文件消息:', meta.name, 'origin=', meta.origin);
  if (!meta.origin) throw new Error('远端文件未带 origin 标记');
  const proxied = await fetch(`http://127.0.0.1:18201/api/chat/remote/${selfA.deviceId}/${encodeURIComponent(meta.fileId)}`);
  const proxiedText = await proxied.text();
  console.log(proxied.ok && proxiedText === '跨设备文件内容-hello' ? '  ✔ 跨设备代理下载成功（内容一致）' : `  ✘ 代理下载失败 HTTP ${proxied.status}: ${proxiedText.slice(0, 80)}`);
  const prev = await fetch(`http://127.0.0.1:18201/api/chat/remote/${selfA.deviceId}/${encodeURIComponent(meta.fileId)}?mode=preview`);
  console.log(prev.ok ? '  ✔ 预览代理可用' : `  ✘ 预览代理失败 HTTP ${prev.status}`);

  console.log('== A 添加共享 → B 应自动收到远端共享目录 ==');
  const addRes = await fetch('http://127.0.0.1:18200/api/shares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.join(BASE, 'tmp-t2', 'a'), name: '测试共享' }),
  });
  const addedShare = await addRes.json();
  console.log('  A 添加共享:', addedShare.id ? '✔ ' + addedShare.name : '✘ ' + JSON.stringify(addedShare));
  await wait(2000);
  const rsEvent2 = c2.events.find((m) => m.event === 'remote.shares');
  const rsEntry = rsEvent2 && (rsEvent2.payload || []).find((e) => e.deviceId === selfA.deviceId);
  console.log(
    rsEntry && rsEntry.shares.some((s) => s.name === '测试共享')
      ? '  ✔ B 收到 A 的远端共享目录（自动刷新生效）'
      : '  ✘ B 未收到远端共享目录: ' + JSON.stringify(rsEvent2 && rsEvent2.payload)
  );

  console.log('== 跨设备成员：B 的成员列表应包含 A 的客户端 ==');
  const members2 = c2.events.filter((m) => m.event === 'chat.members').map((m) => m.payload).pop() || [];
  const hasRemoteMember = members2.some((m) => m.id.endsWith('@' + selfA.deviceId.slice(0, 8)));
  console.log(hasRemoteMember ? `  ✔ B 成员列表含 A 的远端成员（共 ${members2.length} 人）` : `  ✘ B 成员列表缺少 A 的远端成员: ${JSON.stringify(members2.map((m) => m.id))}`);

  console.log('== 设备常驻成员：B 应直接看到 A 的设备成员（设备名命名，kind=device） ==');
  const deviceMemberB = members2.find((m) => m.kind === 'device' && m.deviceId === selfA.deviceId);
  console.log(
    deviceMemberB
      ? `  ✔ B 看到 A 的设备常驻成员「${deviceMemberB.name}」`
      : `  ✘ B 未看到 A 的设备常驻成员: ${JSON.stringify(members2.map((m) => ({ id: m.id, kind: m.kind, deviceId: m.deviceId })))}`
  );
  const localDeviceA = await (await fetch('http://127.0.0.1:18200/api/chat/members')).json().catch(() => null);
  if (localDeviceA) {
    const list = localDeviceA.members || localDeviceA;
    const dm = (Array.isArray(list) ? list : []).find((m) => m.kind === 'device' && m.deviceId === selfA.deviceId);
    console.log(dm ? `  ✔ A 本机成员列表含设备常驻成员「${dm.name}」` : '  ✘ A 本机成员列表缺少设备常驻成员');
  }

  console.log('== 自诊断（实例 B） ==');
  const diag = await (await fetch('http://127.0.0.1:18201/api/admin/diagnose', { method: 'POST' })).json();
  console.log('  诊断结论:', diag.summary);
  for (const c of diag.checks) console.log(`   ${c.ok ? '✔' : '✘'}${c.fixed ? '(已修复)' : ''} ${c.name}: ${c.detail}`);
  const rt = await (await fetch('http://127.0.0.1:18201/api/admin/runtime-logs?lines=5')).json();
  console.log('  运行日志样例:', (rt.lines || []).slice(-2).join(' | ').slice(0, 200));

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
