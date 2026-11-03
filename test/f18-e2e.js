'use strict';
/**
 * v1.18.0 专项测试：私聊定向投递 / 历史可见性过滤 / 搜索过滤
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const DATA = path.join(os.tmpdir(), 'lfs-f18-test-' + Date.now());
const PORT = 18791;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const WebSocket = require('ws');
  const LanFileShare = require('../server/index.js');
  const engine = new LanFileShare({ httpPort: PORT, dataDir: DATA, silent: true });
  await engine.init();

  console.log('\n— 私聊定向投递 —');
  const open = () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const events = [];
    ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch (e) {} });
    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws timeout')), 5000);
  });
  const waitEvent = (events, pred, timeout = 4000) => new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const hit = events.find(pred);
      if (hit) { clearInterval(timer); resolve(hit); }
      else if (Date.now() - t0 > timeout) { clearInterval(timer); resolve(null); }
    }, 40);
  });

  const A = await open(); A.ws.send(JSON.stringify({ type: 'chat.hello', clientId: 'ua', name: '甲', kind: 'web', deviceId: 'd-a' }));
  const B = await open(); B.ws.send(JSON.stringify({ type: 'chat.hello', clientId: 'ub', name: '乙', kind: 'web', deviceId: 'd-b' }));
  const C = await open(); C.ws.send(JSON.stringify({ type: 'chat.hello', clientId: 'uc', name: '丙', kind: 'web', deviceId: 'd-c' }));
  await waitEvent(A.events, (m) => m.event === 'chat.init');
  await waitEvent(B.events, (m) => m.event === 'chat.init');
  await waitEvent(C.events, (m) => m.event === 'chat.init');
  ok('三人入会', true);

  const bId = 'ub';
  // 1) A 发私聊给 B：B 收到、C 收不到、A 收到直接回显
  A.ws.send(JSON.stringify({ type: 'chat.send', text: '乙你好这是私聊', clientMsgId: 'pm-1', to: bId }));
  const bGot = await waitEvent(B.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.text === '乙你好这是私聊');
  ok('B 收到私聊且带 to', !!(bGot && bGot.payload.to === bId));
  const aEcho = await waitEvent(A.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.clientMsgId === 'pm-1');
  ok('A 收到回显（clientMsgId 确认）', !!aEcho);
  await sleep(300);
  const cMissed = C.events.find((m) => m.event === 'chat.msg' && m.payload && m.payload.text === '乙你好这是私聊');
  ok('C 收不到私聊', !cMissed);

  // 2) 群聊：所有人可见
  A.ws.send(JSON.stringify({ type: 'chat.send', text: '大家好这是群聊' }));
  const cGotGroup = await waitEvent(C.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.text === '大家好这是群聊');
  ok('群聊 C 可见', !!cGotGroup);

  // 3) 历史过滤：B 能看到私聊，C 看不到
  await sleep(150);
  const histB = await (await fetch(`${BASE}/api/chat/history?self=ub`)).json();
  ok('B 历史含私聊', histB.some((r) => r.text === '乙你好这是私聊'));
  const histC = await (await fetch(`${BASE}/api/chat/history?self=uc`)).json();
  ok('C 历史不含私聊', !histC.some((r) => r.text === '乙你好这是私聊') && histC.some((r) => r.text === '大家好这是群聊'));
  ok('C 历史含群聊', histC.some((r) => r.text === '大家好这是群聊'));

  // 4) 搜索过滤
  const sB = await (await fetch(`${BASE}/api/chat/search?q=${encodeURIComponent('私聊')}&self=ub`)).json();
  ok('B 搜索命中私聊', sB.some((r) => r.text === '乙你好这是私聊'));
  const sC = await (await fetch(`${BASE}/api/chat/search?q=${encodeURIComponent('私聊')}&self=uc`)).json();
  ok('C 搜不到私聊', !sC.some((r) => r.text === '乙你好这是私聊'));

  // 5) 私聊文件（chat.file 带 to）
  A.ws.send(JSON.stringify({ type: 'chat.file', files: [{ fileId: 'f18_x_私密.txt', name: '私密.txt', size: 5, mime: 'text/plain', relPath: '' }], to: bId }));
  const bGotFile = await waitEvent(B.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.kind === 'file');
  ok('B 收到私聊文件', !!(bGotFile && bGotFile.payload.to === bId));
  await sleep(200);
  const histC2 = await (await fetch(`${BASE}/api/chat/history?self=uc`)).json();
  ok('C 历史不含私聊文件', !histC2.some((r) => r.kind === 'file' && r.to_id));

  // 6) B 撤回 A 发给他的私聊应被拒（归属权：仅发送者可撤）
  B.ws.send(JSON.stringify({ type: 'chat.recall', id: bGotFile.payload.id }));
  await sleep(200);
  const histB2 = await (await fetch(`${BASE}/api/chat/history?self=ub`)).json();
  ok('非发送者撤回无效', histB2.some((r) => r.id === bGotFile.payload.id));

  [A, B, C].forEach((c) => { try { c.ws.close(); } catch (e) {} });
  await engine.stop();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
