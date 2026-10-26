'use strict';
/* 快速定位：单实例内 chat.send → 本地广播 + 历史持久化 是否正常 */
const WebSocket = require('ws');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = process.cwd();
const PORT = 18210;
const DATA = path.join(BASE, 'tmp-t3', 'a');
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const child = execFile(process.execPath, [path.join(BASE, 'server', 'index.js')], {
  env: { ...process.env, LFS_PORT: String(PORT), LFS_DATA_DIR: DATA },
});
child.stdout.on('data', (d) => process.stdout.write('[srv] ' + d));
child.stderr.on('data', (d) => process.stdout.write('[srv][err] ' + d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await wait(3000);
  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      events.push(m);
      console.log('  <- 收到事件:', m.event, JSON.stringify(m.payload).slice(0, 120));
    } catch (e) {}
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'chat.hello', clientId: 'u1', name: '测试用户' }));
  await wait(800);
  console.log('== 发送 chat.send ==');
  ws.send(JSON.stringify({ type: 'chat.send', text: '本地链路测试' }));
  await wait(1500);
  const hist = await (await fetch(`http://127.0.0.1:${PORT}/api/chat/history`)).json();
  console.log('== 历史:', JSON.stringify(hist).slice(0, 300));
  const mem = await (await fetch(`http://127.0.0.1:${PORT}/api/chat/members`)).json();
  console.log('== 成员:', JSON.stringify(mem));
  ws.close();
  child.kill();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
