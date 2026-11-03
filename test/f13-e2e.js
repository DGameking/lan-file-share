'use strict';

/**
 * v1.13.0 新功能端到端验证：
 * 逐 IP 降级发现（ip-scan）、访客分块上传续传（chunk/status/finish + 逐块 sha256 + 422 重传）、
 * 设备元数据（deviceType/alias 心跳与 selfInfo）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const LanFileShare = require('../server');
const ipScan = require('../discovery/ip-scan');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanfs-f13-'));
const PORT = 18205;

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
    const r = http.request(`http://127.0.0.1:${port}${p}`, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let out = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(out).toString() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function raw(port, method, p, buf) {
  return new Promise((resolve, reject) => {
    const r = http.request(`http://127.0.0.1:${port}${p}`, { method, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length } }, (res) => {
      let out = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(out).toString() }));
    });
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

async function main() {
  setTimeout(() => { console.log('WATCHDOG: 超时强退'); process.exit(2); }, 60000);
  const engine = new LanFileShare({ httpPort: PORT, dataDir: path.join(TMP, 'data'), deviceName: 'F13-Engine' });
  await engine.init();
  let pass = 0, fail = 0;
  const assert = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ✅' : '  ❌') + ' ' + name); };

  /* ---------- 设备元数据 ---------- */
  let r = await req(PORT, 'GET', '/api/self');
  let j = JSON.parse(r.body);
  assert('selfInfo 含 deviceType/alias 字段', typeof j.deviceType === 'string' && 'alias' in j);

  engine.settings.deviceAlias = '书房台式机';
  engine.settings.deviceType = 'pc';
  r = await req(PORT, 'GET', '/api/self');
  j = JSON.parse(r.body);
  assert('设置别名/类型后 selfInfo 反映', j.alias === '书房台式机' && j.deviceType === 'pc');

  /* ---------- 逐 IP 降级发现 ---------- */
  const hits = await ipScan.scan({ ips: ['127.0.0.1'], ports: [PORT], timeout: 500, concurrency: 64 });
  assert('ip-scan 探测本机引擎命中', hits.length === 1 && hits[0].deviceId === engine.deviceId && hits[0].deviceName === 'F13-Engine');

  const deep = await engine.deepScan();
  assert('engine.deepScan 执行成功', deep.ok === true && typeof deep.hits === 'number');

  /* ---------- 访客分块上传续传 ---------- */
  const shareDir = path.join(TMP, 'share-target');
  fs.mkdirSync(shareDir, { recursive: true });
  const share = engine.addShare({ name: '测试', path: shareDir, permission: 'write' });

  // 3 块模拟分块：c0/c1 正常，c2 先错后对（422 重传路径）
  const c0 = Buffer.from('A'.repeat(1024));
  const c1 = Buffer.from('B'.repeat(1024));
  const c2 = Buffer.from('C'.repeat(512));
  const full = Buffer.concat([c0, c1, c2]);
  const shaOf = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const uid = 'e2eupload1';
  const base = `/s/${share.id}`;

  r = await raw(PORT, 'POST', `${base}/api/upload/chunk?uploadId=${uid}&index=0&sha256=${shaOf(c0)}`, c0);
  assert('分块 0 上传 + 校验通过', r.status === 200 && JSON.parse(r.body).ok);

  r = await raw(PORT, 'POST', `${base}/api/upload/chunk?uploadId=${uid}&index=1&sha256=${shaOf(c0)}`, c1);
  assert('分块 1 sha256 不符返回 422 且未落盘', r.status === 422 && JSON.parse(r.body).error === 'chunk_checksum_mismatch');

  r = await raw(PORT, 'POST', `${base}/api/upload/chunk?uploadId=${uid}&index=1&sha256=${shaOf(c1)}`, c1);
  assert('分块 1 重传通过', r.status === 200);

  r = await req(PORT, 'GET', `${base}/api/upload/chunk/status?uploadId=${uid}`);
  j = JSON.parse(r.body);
  assert('status 返回已收分块 [0,1]', r.status === 200 && JSON.stringify(j.have.sort()) === '[0,1]');

  r = await req(PORT, 'POST', `${base}/api/upload/finish?uploadId=${uid}&name=resumed.bin&path=&total=3&sha256=${shaOf(full)}&mtime=1700000000000`);
  assert('缺块 finish 报 incomplete（409）', r.status === 409);

  r = await raw(PORT, 'POST', `${base}/api/upload/chunk?uploadId=${uid}&index=2&sha256=${shaOf(c2)}`, c2);
  assert('分块 2 上传通过', r.status === 200);

  r = await req(PORT, 'POST', `${base}/api/upload/finish?uploadId=${uid}&name=resumed.bin&path=sub&total=3&sha256=${shaOf(full)}&mtime=1700000000000`);
  j = JSON.parse(r.body);
  assert('finish 合并落盘成功（子目录）', r.status === 200 && j.ok && j.files[0].includes('sub'));
  const assembled = fs.readFileSync(path.join(shareDir, 'sub', 'resumed.bin'));
  const mtime = fs.statSync(path.join(shareDir, 'sub', 'resumed.bin')).mtimeMs;
  assert('拼装内容逐字节一致', assembled.equals(full));
  assert('mtime 已还原（±1天）', Math.abs(mtime - 1700000000000) < 86400000);

  // 整文件 sha256 不符 → 422
  const uid2 = 'e2eupload2';
  await raw(PORT, 'POST', `${base}/api/upload/chunk?uploadId=${uid2}&index=0&sha256=${shaOf(c0)}`, c0);
  r = await req(PORT, 'POST', `${base}/api/upload/finish?uploadId=${uid2}&name=bad.bin&sha256=${shaOf(Buffer.from('wrong'))}`);
  assert('整文件校验不符 422 且未落盘', r.status === 422 && !fs.existsSync(path.join(shareDir, 'bad.bin')));

  // 权限拦截：read 权限共享分块上传应 403
  const roDir = path.join(TMP, 'ro');
  fs.mkdirSync(roDir, { recursive: true });
  const roShare = engine.addShare({ name: '只读', path: roDir, permission: 'read' });
  r = await raw(PORT, 'POST', `/s/${roShare.id}/api/upload/chunk?uploadId=rotest&index=0`, c0);
  assert('只读共享分块上传 403', r.status === 403);

  try { await engine.stop(); } catch (e) {}
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 异常:', e);
  process.exit(1);
});
