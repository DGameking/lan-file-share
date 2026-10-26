'use strict';

/**
 * 后端引擎冒烟测试（纯 Node，不依赖 Electron）。
 * 验证：启动服务 / 添加共享 / 列出文件 / 下载（含 Range）/ 批量 zip / 设备发现互相可见。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const LanFileShare = require('../server');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanfs-test-'));
const DATA = path.join(TMP, 'data');
const SHARE_DIR = path.join(TMP, 'share');
fs.mkdirSync(SHARE_DIR, { recursive: true });
fs.writeFileSync(path.join(SHARE_DIR, 'hello.txt'), 'hello lan file share');
fs.mkdirSync(path.join(SHARE_DIR, 'sub'), { recursive: true });
fs.writeFileSync(path.join(SHARE_DIR, 'sub', 'note.md'), '# note\n内容');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${p}`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      })
      .on('error', reject);
  });
}

function getRange(port, p, range) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${p}`, { headers: { Range: range } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

async function main() {
  const a = new LanFileShare({ httpPort: 18080, dataDir: DATA + '-a', deviceName: 'Node-A' });
  await a.init();

  let pass = 0, fail = 0;
  const assert = (name, cond) => {
    if (cond) { pass++; console.log('  ✅', name); }
    else { fail++; console.log('  ❌', name); }
  };

  console.log('\n[1] 添加共享 & 列出');
  const share = a.addShare({ name: '测试共享', path: SHARE_DIR, permission: 'write', password: '1234' });
  assert('addShare 返回 id', !!share.id);
  const sharesRes = await get(a.httpPort, '/api/shares');
  assert('GET /api/shares 含 1 项', JSON.parse(sharesRes.body).length === 1);

  console.log('\n[2] 文件列表 API');
  const listRes = await get(a.httpPort, `/s/${share.id}/api/list`);
  assert('list 未带密码被拒(401)', listRes.status === 401);
  const listRes2 = await get(a.httpPort, `/s/${share.id}/api/list?pwd=1234`);
  assert('list 带密码成功(200)', listRes2.status === 200);
  const listData = JSON.parse(listRes2.body);
  assert('list 含 hello.txt 与 sub', listData.entries.some((e) => e.name === 'hello.txt') && listData.entries.some((e) => e.name === 'sub'));

  console.log('\n[3] 下载 & Range 断点续传');
  const dl = await get(a.httpPort, `/s/${share.id}/api/download?path=hello.txt&pwd=1234`);
  assert('下载 200', dl.status === 200);
  assert('下载内容正确', dl.body === 'hello lan file share');
  const ranged = await getRange(a.httpPort, `/s/${share.id}/api/download?path=hello.txt&pwd=1234`, 'bytes=0-4');
  assert('Range 206', ranged.status === 206);
  assert('Range 内容正确', ranged.body === 'hello');

  console.log('\n[4] 批量 zip');
  const zip = await get(a.httpPort, `/s/${share.id}/api/zip?paths=${encodeURIComponent('hello.txt')},${encodeURIComponent('sub')}&pwd=1234`);
  assert('zip 200', zip.status === 200);
  assert('zip 为 zip 类型', (zip.headers['content-type'] || '').includes('zip'));

  console.log('\n[5] 上传');
  const boundary = '----lanfstest' + Date.now();
  const mp = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.txt"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from('uploaded content'),
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const uploadRes = await new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${a.httpPort}/s/${share.id}/api/upload?path=&pwd=1234`,
      { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': mp.length } },
      (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    req.write(mp); req.end();
  });
  assert('上传成功(200)', uploadRes.status === 200);
  assert('上传文件落盘', fs.existsSync(path.join(SHARE_DIR, 'upload.txt')));

  console.log('\n[6] 设备互发现 (两个实例)');
  const b = new LanFileShare({ httpPort: 18090, dataDir: DATA + '-b', deviceName: 'Node-B' });
  await b.init();
  await new Promise((r) => setTimeout(r, 4500));
  const aDevices = a.deviceManager.list().filter((d) => d.device_id !== a.deviceId);
  const bDevices = b.deviceManager.list().filter((d) => d.device_id !== b.deviceId);
  assert('A 发现 B', aDevices.some((d) => d.device_name === 'Node-B'));
  assert('B 发现 A', bDevices.some((d) => d.device_name === 'Node-A'));

  console.log('\n[7] 邀请码');
  const code = a.inviteCreate();
  assert('邀请码 6 位', /^[A-Z0-9]{6}$/.test(code));
  const join = a.inviteJoin(code);
  assert('邀请码可解析', join.ok === true);

  await b.stop();
  await a.stop();

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
