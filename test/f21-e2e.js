'use strict';
/**
 * v1.21.0 专项 e2e：
 *  A. 设备别名持久化：db.setDeviceAlias → hydrate 恢复 → setAlias/恢复原名 → upsert 不冲掉 alias
 *  B. LocalSend 拉取 PIN（offerPin）：默认空 / 链接带 pin / 无 pin 链接直接可拉
 *  C. 远端聊天消息上报引擎事件（桌面系统通知数据源）
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const PORT = 18778;
const DATA = path.join(__dirname, '..', 'tmp-f21-test');
let pass = 0, fail = 0;
const ok = (name, cond) => { console.log(`${cond ? '  ✅' : '  ❌'} ${name}`); cond ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonReq(mod, { host, port, urlPath, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = mod.request({ host, port, path: urlPath, method, headers, rejectUnauthorized: false, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body != null) req.end(body); else req.end();
  });
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  /* ---------- A. 设备别名持久化 ---------- */
  console.log('\nA. 设备别名持久化');
  const Database = require('../database/index.js');
  const db = await Database.create(path.join(DATA, 'data.db'));
  db.upsertDevice({ device_id: 'dev-a', device_name: 'DESKTOP-ABC', os: 'win32', host: '1.1.1.1', port: 80, version: '1', is_online: 1 });
  db.upsertDevice({ device_id: 'dev-b', device_name: 'Phone-X', os: 'android', host: '2.2.2.2', port: 80, version: '1', is_online: 1 });
  db.setDeviceAlias('dev-a', '书房台式机');
  ok('setDeviceAlias 持久化', db.getDevice('dev-a').alias === '书房台式机');
  ok('未设置的设备 alias 为空', !db.getDevice('dev-b').alias);
  ok('别名超长截断 40 字', (() => { db.setDeviceAlias('dev-b', '长'.repeat(50)); return db.getDevice('dev-b').alias.length === 40; })());

  // 心跳 upsert 不冲掉 alias（UPDATE 语句不含 alias 列）
  db.upsertDevice({ ...db.getDevice('dev-a'), device_name: 'DESKTOP-ABC', host: '3.3.3.3' });
  ok('设备信息更新后 alias 保留', db.getDevice('dev-a').alias === '书房台式机');

  const DeviceManager = require('../discovery/device-manager.js');
  const dm = new DeviceManager();
  dm.hydrate(db.listDevices());
  ok('hydrate 恢复 alias', dm.get('dev-a').alias === '书房台式机');
  dm.setAlias('dev-b', '客厅电视');
  ok('setAlias 生效', dm.get('dev-b').alias === '客厅电视');
  dm.upsert({ deviceId: 'dev-b', deviceName: 'Phone-X', host: '2.2.2.2', port: 80 });
  ok('心跳 upsert 后 alias 保留（内存侧）', dm.get('dev-b').alias === '客厅电视');
  dm.setAlias('dev-b', '');
  ok('空串恢复原名', dm.get('dev-b').alias === '');
  ok('未知设备 setAlias 返回 false', dm.setAlias('dev-none', 'x') === false);
  db.close();

  /* ---------- B. LocalSend 拉取 PIN ---------- */
  console.log('\nB. LocalSend 拉取 PIN（offerPin）');
  const LanFileShare = require('../server/index.js');
  const engine = new LanFileShare({ httpPort: PORT, dataDir: DATA, silent: true });
  await engine.init();
  ok('offerPin 默认为空', String(engine.settings.offerPin || '') === '');
  await sleep(800);
  const ls = engine.localsend;
  ok('LocalSend 网关已启动', !!ls && !!ls.httpServer);
  const proto = ls.protocol === 'https' ? https : http;
  const base = { host: '127.0.0.1', port: ls.port };

  const srcDir = path.join(DATA, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const content = Buffer.from('LFS-pin-test-'.repeat(800)); // 10400 字节
  const srcFile = path.join(srcDir, 'pin-me.bin');
  fs.writeFileSync(srcFile, content);

  // 场景 1：设置了 offerPin（渲染层会读取并传入）
  const offerPin = ls.createDownloadOffer(
    [{ path: srcFile, name: 'pin-me.bin', size: content.length, mime: '' }],
    { pin: '9988' }
  );
  ok('带 PIN 链接含 pin= 参数', !!offerPin && offerPin.url.includes('pin=9988'));
  const fid1 = Object.keys(offerPin.files)[0];
  const prepBody = (fid) => JSON.stringify({ info: { alias: 'tester' }, files: { [fid]: { fileName: 'pin-me.bin', size: content.length } } });

  const noPin = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/prepare-download?sessionId=${offerPin.sessionId}`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: prepBody(fid1) });
  ok('带 PIN 供给 · 无 PIN 请求 → 401', noPin.status === 401);
  const badPin = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/prepare-download?sessionId=${offerPin.sessionId}&pin=1111`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: prepBody(fid1) });
  ok('带 PIN 供给 · 错 PIN → 401', badPin.status === 401);
  const goodPin = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/prepare-download?sessionId=${offerPin.sessionId}&pin=9988`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: prepBody(fid1) });
  ok('带 PIN 供给 · 对 PIN → 200 + token', goodPin.status === 200 && !!JSON.parse(goodPin.text).files);
  const token1 = (JSON.parse(goodPin.text).files || {})[fid1];
  const dl1 = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/download?sessionId=${offerPin.sessionId}&fileId=${fid1}&token=${encodeURIComponent(token1)}` });
  ok('token 下载逐字节一致', dl1.status === 200 && dl1.body.equals(content));

  // 场景 2：未设 PIN（offerPin 留空）→ 链接持有人即可下载
  const offerNo = ls.createDownloadOffer(
    [{ path: srcFile, name: 'pin-me.bin', size: content.length, mime: '' }],
    { pin: '' }
  );
  ok('无 PIN 链接不含 pin= 参数', !!offerNo && !offerNo.url.includes('pin='));
  const fid2 = Object.keys(offerNo.files)[0];
  const openPull = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/prepare-download?sessionId=${offerNo.sessionId}`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: prepBody(fid2) });
  ok('无 PIN 供给 · 直接请求 → 200', openPull.status === 200);

  /* ---------- C. 远端聊天消息上报引擎事件 ---------- */
  console.log('\nC. 远端消息 → 引擎 chat.msg 事件（系统通知数据源）');
  const seen = [];
  engine.on('chat.msg', (rec) => seen.push(rec));
  engine.chat.deliverRemote('chat.msg', { id: 'm1', ts: Date.now(), sender_id: 'u1', sender_name: '手机端', kind: 'text', text: '你好，桌面端' }, 'abcd1234');
  await sleep(200);
  ok('引擎收到 chat.msg 事件', seen.length >= 1 && seen[seen.length - 1].id === 'm1-abcd1234');
  ok('事件记录含发送者与文本', seen[seen.length - 1].sender_name === '手机端' && seen[seen.length - 1].text === '你好，桌面端');

  engine.chat.deliverRemote('chat.msg', { id: 'm2', ts: Date.now(), sender_id: 'u1', sender_name: '手机端', kind: 'text', text: '私密的话', to: Object.keys(engine.chat.members)[0] || 'someone' }, 'abcd1234');
  await sleep(200);
  const m2 = seen.find((r) => String(r.id).startsWith('m2-'));
  ok('私聊记录同样上报（to 保留）', !!m2 && !!m2.to);

  // 落库验证（重启后历史可查）
  engine.chat.deliverRemote('chat.msg', { id: 'm3', ts: Date.now(), sender_id: 'u2', sender_name: '平板', kind: 'text', text: '持久化检查' }, 'beef5678');
  await sleep(200);
  const hist = engine.db.listChatMessages(10);
  ok('远端消息已落库', hist.some((r) => String(r.id || '').startsWith('m3-')));

  await engine.stop().catch(() => {});
  console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('e2e 异常:', e); process.exit(1); });
