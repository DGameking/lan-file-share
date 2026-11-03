'use strict';
/**
 * v1.16.0 会话增强端到端验证：
 * 1. clientMsgId 确认回显（文本/文件）
 * 2. 撤回（本人可撤、他人不可撤）
 * 3. 设备身份记忆（清缓存窗口按 deviceId 认领历史身份）
 */
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const LanFileShare = require('../server/index.js');

const PORT = 18931;
const DATA = path.join(__dirname, '..', 'tmp-f16-test');
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function ok(name, cond) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name);
  if (cond) pass++; else fail++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsOpen() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const events = [];
    ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch (e) {} });
    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
  });
}
function hello(ws, clientId, name, deviceId, kind) {
  ws.send(JSON.stringify({ type: 'chat.hello', clientId, name, deviceId, kind: kind || 'web' }));
}
async function waitEvent(events, pred, timeout = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  const engine = new LanFileShare({ httpPort: PORT, dataDir: DATA, silent: true });
  await engine.init();

  // ---- 1. clientMsgId 确认 ----
  const A = await wsOpen();
  hello(A.ws, 'clientA', '甲', 'dev-1');
  await waitEvent(A.events, (m) => m.event === 'chat.init');
  A.ws.send(JSON.stringify({ type: 'chat.send', text: '你好世界', clientMsgId: 'cm-1' }));
  const ack = await waitEvent(A.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.clientMsgId === 'cm-1');
  ok('文本消息回显 clientMsgId', !!ack);
  ok('确认记录携带服务端消息 id', !!(ack && ack.payload.id));
  const msgId = ack && ack.payload.id;

  const B = await wsOpen();
  hello(B.ws, 'clientB', '乙', 'dev-2');
  await waitEvent(B.events, (m) => m.event === 'chat.init');
  // B 在线后再发一条，验证广播携带 clientMsgId（历史加载不携带：设计上不落库）
  A.ws.send(JSON.stringify({ type: 'chat.send', text: '第二条', clientMsgId: 'cm-1b' }));
  const bGot = await waitEvent(B.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.clientMsgId === 'cm-1b');
  ok('广播同样携带 clientMsgId', !!bGot);

  // ---- 2. 撤回 ----
  A.ws.send(JSON.stringify({ type: 'chat.recall', id: msgId }));
  const recalled = await waitEvent(A.events, (m) => m.event === 'chat.recall' && m.payload && m.payload.id === msgId);
  ok('本人撤回成功并广播', !!recalled);
  const hist = await (await fetch(`${BASE}/api/chat/history`)).json();
  ok('撤回后历史已删除', !hist.some((r) => r.id === msgId));

  const C = await wsOpen();
  hello(C.ws, 'clientC', '丙', 'dev-3');
  await waitEvent(C.events, (m) => m.event === 'chat.init');
  C.ws.send(JSON.stringify({ type: 'chat.send', text: '丙的消息', clientMsgId: 'cm-2' }));
  const cmsg = await waitEvent(C.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.clientMsgId === 'cm-2');
  A.ws.send(JSON.stringify({ type: 'chat.recall', id: cmsg.payload.id })); // 甲撤回丙的
  await sleep(400);
  const hist2 = await (await fetch(`${BASE}/api/chat/history`)).json();
  ok('非本人撤回被拒绝', hist2.some((r) => r.id === cmsg.payload.id));

  // ---- 3. 设备身份记忆（清缓存认领） ----
  const D = await wsOpen();
  hello(D.ws, '', '', 'dev-1'); // 无 clientId、无名称 → 应认领 dev-1 的 clientA / 甲
  const dInit = await waitEvent(D.events, (m) => m.event === 'chat.init');
  ok('清缓存窗口按 deviceId 认领历史身份', !!(dInit && dInit.payload.selfId === 'clientA'));

  // 身份记忆持久化
  engine.chat && ok('身份表已写入 db config', !!(engine.chat.identities && engine.chat.identities['dev-1'] && engine.chat.identities['dev-1'].id === 'clientA'));

  // ---- 4. 文件消息 clientMsgId（直接构造 chat.file） ----
  A.ws.send(JSON.stringify({ type: 'chat.file', files: [{ fileId: 'f_test.txt', name: 't.txt', size: 3, mime: 'text/plain' }], clientMsgId: 'cm-3' }));
  const fack = await waitEvent(A.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.clientMsgId === 'cm-3');
  ok('文件消息回显 clientMsgId', !!fack);

  // 收尾
  [A, B, C, D].forEach((c) => { try { c.ws.close(); } catch (e) {} });
  await engine.stop();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {} // 沙箱环境 trash 可能失败，忽略
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
