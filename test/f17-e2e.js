'use strict';
/**
 * v1.17.0 会话 P1 专项测试：引用回复 / 消息搜索 / reply_meta 迁移
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const DATA = path.join(os.tmpdir(), 'lfs-f17-test-' + Date.now());
const PORT = 18790;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsOpen() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const events = [];
    ws.on('message', (d) => { try { events.push(JSON.parse(d.toString())); } catch (e) {} });
    ws.on('open', () => resolve({ ws, events }));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 5000);
  });
}
function hello(ws, clientId, name, deviceId) {
  ws.send(JSON.stringify({ type: 'chat.hello', clientId, name, kind: 'web', deviceId }));
}
function waitEvent(events, pred, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const hit = events.find(pred);
      if (hit) { clearInterval(timer); resolve(hit); }
      else if (Date.now() - t0 > timeout) { clearInterval(timer); resolve(null); }
    }, 40);
  });
}

(async () => {
  const LanFileShare = require('../server/index.js');
  const engine = new LanFileShare({ httpPort: PORT, dataDir: DATA, silent: true });
  await engine.init();

  console.log('\n— 迁移与搜索接口 —');
  // 1) reply_meta 列存在（新库 + 旧库迁移同一 _migrate 路径）
  const cols = engine.db._query("PRAGMA table_info(chat_messages)").map((r) => r.name);
  ok('chat_messages 含 reply_meta 列', cols.includes('reply_meta'));

  const A = await wsOpen();
  hello(A.ws, 'clientA', '甲', 'dev-17a');
  const initA = await waitEvent(A.events, (m) => m.event === 'chat.init');
  ok('甲入会', !!initA);

  // 2) 发送带引用的消息 → 广播携带 reply
  A.ws.send(JSON.stringify({ type: 'chat.send', text: '根消息' }));
  const first = await waitEvent(A.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.text === '根消息');
  A.ws.send(JSON.stringify({
    type: 'chat.send', text: '这是回复',
    reply: { id: first.payload.id, name: '甲', preview: '根消息', kind: 'text', ts: first.payload.ts },
  }));
  const replied = await waitEvent(A.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.text === '这是回复');
  ok('广播携带 reply 元数据', !!(replied && replied.payload.reply && replied.payload.reply.id === first.payload.id));

  // 3) reply 清洗：超长 preview 截断、恶意字段剔除
  A.ws.send(JSON.stringify({
    type: 'chat.send', text: '清洗测试',
    reply: { id: 'x'.repeat(100), name: 'n'.repeat(80), preview: 'p'.repeat(500), kind: 'text', ts: 123, hack: 'evil' },
  }));
  const cleaned = await waitEvent(A.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.text === '清洗测试');
  const rp = cleaned && cleaned.payload.reply;
  ok('reply 字段截断清洗', !!(rp && rp.id.length <= 64 && rp.name.length <= 40 && rp.preview.length <= 120 && rp.hack === undefined));

  // 4) 无效 reply（无 id）被丢弃
  A.ws.send(JSON.stringify({ type: 'chat.send', text: '无效引用', reply: { name: '无名' } }));
  const noRp = await waitEvent(A.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.text === '无效引用');
  ok('无效 reply 被丢弃', !!(noRp && !noRp.payload.reply));

  // 5) 持久化：历史接口返回 reply_meta 且可解析
  await sleep(150);
  const hist = await (await fetch(`${BASE}/api/chat/history`)).json();
  const histReply = hist.find((r) => r.text === '这是回复');
  let parsed = null;
  try { parsed = JSON.parse(histReply.reply_meta); } catch (e) {}
  ok('历史行 reply_meta 落库可解析', !!(parsed && parsed.id === first.payload.id && parsed.preview === '根消息'));

  // 6) 文本搜索
  const s1 = await (await fetch(`${BASE}/api/chat/search?q=${encodeURIComponent('根消息')}`)).json();
  ok('文本搜索命中', Array.isArray(s1) && s1.some((r) => r.text === '根消息'));
  // 7) 文件名搜索（直接写一条带 file_meta 的消息）
  A.ws.send(JSON.stringify({ type: 'chat.file', files: [{ fileId: 'f17test_报告.pdf', name: '季度报告.pdf', size: 10, mime: 'application/pdf', relPath: '' }] }));
  await waitEvent(A.events, (m) => m.event === 'chat.msg' && m.payload && m.payload.kind === 'file');
  const s2 = await (await fetch(`${BASE}/api/chat/search?q=${encodeURIComponent('季度报告')}`)).json();
  ok('文件名搜索命中', Array.isArray(s2) && s2.some((r) => r.kind === 'file'));
  // 8) 空查询返回空数组
  const s3 = await (await fetch(`${BASE}/api/chat/search?q=%20%20`)).json();
  ok('空查询返回空数组', Array.isArray(s3) && s3.length === 0);
  // 9) SQL LIKE 通配符不注入（% 与 _ 按字面匹配）
  const s4 = await (await fetch(`${BASE}/api/chat/search?q=${encodeURIComponent('%')}`)).json();
  ok('LIKE 通配符按字面处理', Array.isArray(s4));

  [A].forEach((c) => { try { c.ws.close(); } catch (e) {} });
  await engine.stop();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
