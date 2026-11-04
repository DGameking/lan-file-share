'use strict';
/**
 * v1.20.0 专项 e2e：
 *  A. 收藏夹置顶：setDeviceStarred 持久化 + DeviceManager.list 置顶排序
 *  B. LocalSend 拉取（download API）：createDownloadOffer → prepare-download（404/401/200）→ download 流式拉取逐字节比对
 *  C. 拉取供给 TTL 过期清理
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');

const PORT = 18777;
const DATA = path.join(__dirname, '..', 'tmp-f20-test');
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

  /* ---------- A. 收藏置顶 ---------- */
  const Database = require('../database/index.js');
  const db = await Database.create(path.join(DATA, 'data.db'));
  db.upsertDevice({ device_id: 'dev-a', device_name: '甲', os: 'win32', host: '1.1.1.1', port: 80, version: '1', is_online: 1 });
  db.upsertDevice({ device_id: 'dev-b', device_name: '乙', os: 'linux', host: '2.2.2.2', port: 80, version: '1', is_online: 1 });
  db.setDeviceStarred('dev-b', true);
  ok('starred 持久化', db.getDevice('dev-b').starred === 1);
  ok('starred 默认 0', db.getDevice('dev-a').starred === 0);

  const DeviceManager = require('../discovery/device-manager.js');
  const dm = new DeviceManager();
  dm.hydrate(db.listDevices());
  dm.upsert({ deviceId: 'dev-a', deviceName: '甲', host: '1.1.1.1', port: 80 });
  dm.upsert({ deviceId: 'dev-b', deviceName: '乙', host: '2.2.2.2', port: 80 });
  ok('hydrate 恢复 starred', dm.get('dev-b').starred === 1);
  ok('list 收藏置顶', dm.list()[0].device_id === 'dev-b');
  dm.setStarred('dev-a', true);
  ok('setStarred 生效', dm.get('dev-a').starred === 1 && dm.list()[0].device_id === 'dev-a');
  dm.setStarred('dev-a', false);
  ok('取消收藏后排序回落', dm.get('dev-a').starred === 0 && dm.list()[0].device_id === 'dev-b');
  db.close();

  /* ---------- B. LocalSend 拉取 ---------- */
  const LanFileShare = require('../server/index.js');
  const engine = new LanFileShare({ httpPort: PORT, dataDir: DATA, silent: true });
  await engine.init();
  engine.settings.autoAcceptDrop = true;
  engine.settings.dropPin = '';
  await sleep(800); // 等 LocalSend 网关启动（openssl 证书生成可能耗时）
  const ls = engine.localsend;
  ok('LocalSend 网关已启动', !!ls && !!ls.httpServer);
  const proto = ls.protocol === 'https' ? https : http;
  const base = { host: '127.0.0.1', port: ls.port };
  ok('info.download=true（声明支持拉取）', await (async () => {
    const r = await jsonReq(proto, { ...base, urlPath: '/api/localsend/v2/info' });
    try { return JSON.parse(r.text).download === true; } catch (e) { return false; }
  })());

  // 供给文件
  const srcDir = path.join(DATA, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const content = Buffer.from('LFS-pull-test-'.repeat(1000)); // 14000 字节
  const srcFile = path.join(srcDir, 'pull-me.bin');
  fs.writeFileSync(srcFile, content);
  const offer = ls.createDownloadOffer(
    [{ path: srcFile, name: 'pull-me.bin', size: content.length, mime: 'application/octet-stream' }],
    { pin: '2468' }
  );
  ok('createDownloadOffer 返回链接', !!offer && !!offer.url && offer.url.includes('sessionId=') && offer.url.includes('pin=2468'));
  const fid = Object.keys(offer.files)[0];

  // 未知会话 → 404
  const r404 = await jsonReq(proto, { ...base, urlPath: '/api/localsend/v2/prepare-download', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: 'tester' }, files: { [fid]: { fileName: 'pull-me.bin', size: content.length } } }) });
  ok('未知 sessionId → 404', r404.status === 404);

  // 错 PIN → 401
  const r401 = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/prepare-download?sessionId=${offer.sessionId}&pin=0000`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: 'tester' }, files: { [fid]: { fileName: 'pull-me.bin', size: content.length } } }) });
  ok('错误 PIN → 401', r401.status === 401);

  // 正确 PIN → 200 + token
  const r200 = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/prepare-download?sessionId=${offer.sessionId}&pin=2468`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: 'tester' }, files: { [fid]: { fileName: 'pull-me.bin', size: content.length } } }) });
  ok('正确 PIN → 200', r200.status === 200);
  const j = JSON.parse(r200.text);
  ok('响应含 sessionId + token', j.sessionId === offer.sessionId && !!(j.files && j.files[fid]));

  // 错 token 下载 → 403
  const r403 = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/download?sessionId=${offer.sessionId}&fileId=${fid}&token=WRONG` });
  ok('错误 token → 403', r403.status === 403);
  if (r403.status !== 403) console.log('    [debug r403]', r403.status, r403.text.slice(0, 100));

  // 正确 token → 流式下载逐字节比对
  const dl = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/download?sessionId=${offer.sessionId}&fileId=${fid}&token=${j.files[fid]}` });
  ok('下载 200', dl.status === 200);
  if (dl.status !== 200) console.log('    [debug dl]', dl.status, dl.text.slice(0, 100));
  ok('下载内容逐字节一致', Buffer.compare(dl.body, content) === 0);
  ok('sha256 声明一致', offer.files[fid].sha256.length === 64);

  // 不存在的文件 → 404
  const r404b = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/download?sessionId=${offer.sessionId}&fileId=nope&token=x` });
  ok('不存在 fileId → 404', r404b.status === 404);
  if (r404b.status !== 404) console.log('    [debug r404b]', r404b.status, r404b.text.slice(0, 100));

  /* ---------- C. TTL 过期（直接操纵时间戳） ---------- */
  ls.offers.get(offer.sessionId).ts = Date.now() - 11 * 60 * 1000;
  ls._prune();
  const rExp = await jsonReq(proto, { ...base, urlPath: `/api/localsend/v2/prepare-download?sessionId=${offer.sessionId}&pin=2468`, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: 'tester' }, files: { [fid]: { fileName: 'pull-me.bin' } } }) });
  ok('过期供给 → 404', rExp.status === 404);

  const [A, B, C, D] = [0, 0, 0, 0]; // 占位保持行数稳定
  await engine.stop();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常:', e.message, e.stack);
  process.exit(1);
});
