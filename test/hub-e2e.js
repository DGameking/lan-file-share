'use strict';

/**
 * v1.11.0 会合点跨网段 e2e：
 * Hub(模拟NAS) + 客户端A + 客户端B（不同端口模拟不同网段）。
 * 验证：注册/互见（relay 标记）/中继投送/拉取校验/落盘通知。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const LanFileShare = require('../server');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanfs-hub-'));

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
    const r = http.request(`http://127.0.0.1:${port}${p}`, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } : headers, timeout: 8000 }, (res) => {
      let out = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(out), headers: res.headers }));
    });
    r.on('error', reject);
    r.on('timeout', () => { try { r.destroy(new Error('timeout')); } catch (e) {} reject(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

function multipart(port, p, filename, buf, query = '') {
  return new Promise((resolve, reject) => {
    const boundary = '----hube2e' + Date.now();
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([head, buf, tail]);
    const r = http.request(`http://127.0.0.1:${port}${p}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length },
      timeout: 15000,
    }, (res) => {
      let out = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(out).toString() }));
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  setTimeout(() => { console.log('WATCHDOG 超时'); process.exit(2); }, 60000).unref();
  const hub = new LanFileShare({ httpPort: 18301, dataDir: path.join(TMP, 'hub'), deviceName: 'Hub-NAS' });
  const a = new LanFileShare({ httpPort: 18302, dataDir: path.join(TMP, 'a'), deviceName: 'NetA-PC' });
  const b = new LanFileShare({ httpPort: 18303, dataDir: path.join(TMP, 'b'), deviceName: 'NetB-PC' });
  await hub.init(); await a.init(); await b.init();
  a.settings.rendezvous = '127.0.0.1:18301';
  b.settings.rendezvous = '127.0.0.1:18301';

  let pass = 0, fail = 0;
  const assert = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ✅' : '  ❌') + ' ' + name); };

  // 等双方完成一次注册轮询（客户端 5s 间隔，配置在 init 后设置，需等下一轮 tick）
  await sleep(6500);

  // 1. Hub 设备表包含 A、B
  let j = JSON.parse((await req(18301, 'GET', '/api/hub/devices')).body.toString());
  const ids = (j.devices || []).map((d) => d.deviceId);
  assert('Hub 设备表含 A 与 B', ids.includes(a.deviceId) && ids.includes(b.deviceId));

  // 2. A 的设备表注入 B（relay 标记 + 会合点地址）——轮询等待双方相位对齐
  let devB = null, devA = null;
  for (let i = 0; i < 4 && !(devB && devB.relay && devA && devA.relay); i++) {
    await sleep(3000);
    devB = a.deviceManager.get(b.deviceId);
    devA = b.deviceManager.get(a.deviceId);
  }
  assert('A 侧注入 B（relay=true, hub 地址正确）', !!devB && devB.relay === true && devB.relay_hub === '127.0.0.1:18301');
  assert('B 侧注入 A（relay=true）', !!devA && devA.relay === true);

  // 3. 中继投送：模拟 A → Hub → B（大文件 1.2MB + mtime + sha256）
  const content = crypto.randomBytes(1.2 * 1024 * 1024);
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const r = await multipart(18301, '/api/hub/relay', 'cross.bin', content, `?target=${b.deviceId}&from=NetA-PC&sha256=${sha}&mtime=1700000000000`);
  j = JSON.parse(r.body);
  assert('A 向 Hub 中继投送成功', r.status === 200 && (j.relays || []).length === 1);

  // 4. B 轮询拉取（等一个轮询周期）
  await sleep(6000);
  const received = fs.readdirSync(path.join(TMP, 'b', 'received'));
  const got = received.find((n) => n.endsWith('cross.bin'));
  assert('B 经中继收到文件', !!got);
  if (got) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(TMP, 'b', 'received', got))).digest('hex');
    assert('B 收到的文件 sha256 一致', actual === sha);
    const st = fs.statSync(path.join(TMP, 'b', 'received', got));
    assert('B 收到的文件 mtime 已还原(±1天)', Math.abs(st.mtimeMs - 1700000000000) < 86400000);
  }

  // 5. 一次性拉取：再次拉取应 404（取后即删）
  const again = await req(18301, 'GET', `/api/hub/relay/${(JSON.parse(r.body).relays[0].relayId)}?token=x&deviceId=${b.deviceId}`);
  assert('中继文件取后即删（再次拉取 404）', again.status === 404);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
