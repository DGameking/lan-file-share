'use strict';

/**
 * 会话（聊天）模块冒烟测试（纯 Node，不依赖 Electron）。
 * 验证：自动入会 / 文本消息广播 / 历史持久化 / 会话文件上传下载 / 信令路由。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const LanFileShare = require('../server');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanfs-chat-'));

function wsConnect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(m)) {
          waiters[i].resolve(m);
          waiters.splice(i, 1);
          return;
        }
      }
      inbox.push(m);
    });
    ws.once('open', resolve.bind(null, {
      ws,
      next(pred, timeout = 4000) {
        return new Promise((res, rej) => {
          const idx = inbox.findIndex((m) => pred(m));
          if (idx >= 0) return res(inbox.splice(idx, 1)[0]);
          const t = setTimeout(() => rej(new Error('timeout waiting for ws message')), timeout);
          waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
        });
      },
      send: (o) => ws.send(JSON.stringify(o)),
    }));
    ws.once('error', reject);
  });
}

function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function main() {
  const inst = new LanFileShare({ httpPort: 18099, dataDir: path.join(TMP, 'data'), deviceName: 'Chat-Node' });
  await inst.init();

  let pass = 0, fail = 0;
  const assert = (name, cond) => {
    if (cond) { pass++; console.log('  ✓', name); }
    else { fail++; console.error('  ✗', name); }
  };

  // 1. 两个客户端连入
  const A = await wsConnect(inst.httpPort);
  const B = await wsConnect(inst.httpPort);

  A.send({ type: 'chat.hello', clientId: 'client-a', name: '电脑A', kind: 'desktop' });
  B.send({ type: 'chat.hello', clientId: 'client-b', name: '手机B', kind: 'web' });
  const initA = await A.next((m) => m.event === 'chat.init');
  const initB = await B.next((m) => m.event === 'chat.init');
  assert('hello 后收到 chat.init', !!initA.payload.selfId && Array.isArray(initB.payload.history));

  const memEvt = await A.next((m) => m.event === 'chat.members' && m.payload.length >= 2);
  assert('成员自动入会（2 人）', memEvt.payload.length === 2);

  // 2. 文本消息广播
  A.send({ type: 'chat.send', text: '你好，局域网！' });
  const msgAtB = await B.next((m) => m.event === 'chat.msg');
  assert('消息广播到其他成员', msgAtB.payload.text === '你好，局域网！' && msgAtB.payload.sender_name === '电脑A');

  // 3. 输入状态
  B.send({ type: 'chat.typing', typing: true });
  const typingAtA = await A.next((m) => m.event === 'chat.typing');
  assert('输入状态转发', typingAtA.payload.name === '手机B' && typingAtA.payload.typing === true);

  // 4. 会话文件上传 + chat.file 广播 + 下载回读
  const boundary = '----lanfschat' + Date.now();
  const fileContent = 'chat-file-payload-' + 'x'.repeat(2048);
  const multipart =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="样例.txt"\r\nContent-Type: text/plain\r\n\r\n${fileContent}\r\n--${boundary}--\r\n`;
  const upRes = await post(inst.httpPort, '/api/chat/upload', multipart, {
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
  });
  const upJson = JSON.parse(upRes.body);
  assert('会话文件上传成功', upRes.status === 200 && upJson.ok && upJson.files.length === 1 && upJson.files[0].size === Buffer.byteLength(fileContent));

  B.send({ type: 'chat.file', files: upJson.files });
  const fileMsgAtA = await A.next((m) => m.event === 'chat.msg' && m.payload.kind === 'file');
  assert('文件消息广播', fileMsgAtA.payload.files[0].fileId === upJson.files[0].fileId);

  const dlRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${inst.httpPort}/api/chat/file/${upJson.files[0].fileId}`, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
  assert('会话文件下载回读一致', dlRes.status === 200 && dlRes.body === fileContent);

  // 5. 历史持久化（重启后仍在）
  const hist = JSON.parse((await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${inst.httpPort}/api/chat/history`, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve(b));
    }).on('error', reject);
  })));
  assert('历史接口含文本+文件消息', hist.length === 2 && hist[0].kind === 'text' && hist[1].kind === 'file');

  await inst.stop();
  const inst2 = new LanFileShare({ httpPort: 18099, dataDir: path.join(TMP, 'data'), deviceName: 'Chat-Node' });
  await inst2.init();
  const hist2 = inst2.db.listChatMessages(200);
  assert('重启后历史仍在（持久化）', hist2.length === 2);

  // 6. WebRTC 信令路由
  const C = await wsConnect(inst2.httpPort);
  C.send({ type: 'chat.hello', clientId: 'client-c', name: '电脑C', kind: 'web' });
  await C.next((m) => m.event === 'chat.init');
  const D = await wsConnect(inst2.httpPort);
  D.send({ type: 'chat.hello', clientId: 'client-d', name: '手机D', kind: 'desktop' });
  await D.next((m) => m.event === 'chat.init');
  C.send({ type: 'rtc.signal', to: 'client-d', data: { kind: 'invite', media: 'video' } });
  const sig = await D.next((m) => m.event === 'rtc.signal');
  assert('信令按目标路由', sig.payload.from === 'client-c' && sig.payload.data.kind === 'invite');

  await inst2.stop();

  console.log(`\n会话测试：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(1);
});
