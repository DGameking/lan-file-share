'use strict';

/**
 * Web 管理端冒烟测试。
 * 运行：node test/web-admin.test.js
 */
const http = require('http');
const assert = require('assert');

const LanFileShare = require('../server/index');
const { adminAuth, isLoopback } = require('../server/admin');

const PORT = 18190;
const TMP = 'tmp-webadmin';

let passed = 0;
function ok(name) { passed++; console.log('  ✓', name); }

function get(port, path, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => { try { return JSON.parse(data); } catch (e) { return null; } } }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- 中间件单元测试（模拟远程 IP） ----
function unitTests() {
  assert.strictEqual(isLoopback('127.0.0.1'), true, 'isLoopback v4');
  assert.strictEqual(isLoopback('::ffff:127.0.0.1'), true, 'isLoopback v4-mapped');
  assert.strictEqual(isLoopback('::1'), true, 'isLoopback v6');
  assert.strictEqual(isLoopback('192.168.1.55'), false, 'isLoopback lan');
  ok('isLoopback 判定');

  const fakeRes = () => {
    const res = { statusCode: 0, jsonBody: null, status(c) { this.statusCode = c; return this; }, json(b) { this.jsonBody = b; return this; } };
    return res;
  };
  const mw = adminAuth({
    clientIp: (req) => req._ip,
    settings: { adminPasswordHash: 'scrypt$aa$bb' },
    masterKey: 'k',
  });
  // 远程无 token → 401
  let res = fakeRes();
  mw({ path: '/shares', _ip: '192.168.1.55', headers: {}, query: {} }, res, () => {});
  assert.strictEqual(res.statusCode, 401);
  ok('远程无 token → 401');

  // 回环放行
  res = fakeRes();
  let nexted = false;
  mw({ path: '/shares', _ip: '127.0.0.1', headers: {}, query: {} }, res, () => (nexted = true));
  assert.ok(nexted);
  ok('回环放行');

  // chat 路径放行（远程）
  res = fakeRes(); nexted = false;
  mw({ path: '/chat/upload', _ip: '192.168.1.55', headers: {}, query: {} }, res, () => (nexted = true));
  assert.ok(nexted);
  ok('远程 chat 路径放行');
}

async function integrationTests() {
  const inst = new LanFileShare({ httpPort: PORT, dataDir: TMP, deviceName: 'AdminT' });
  await inst.init();

  // 管理端页面
  const page = await get(inst.httpPort, '/admin');
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes('管理控制台'));
  ok('GET /admin 页面');

  // Vue vendor
  const vue = await get(inst.httpPort, '/vendor/vue.global.js');
  assert.strictEqual(vue.status, 200);
  assert.ok(vue.body.length > 10000);
  ok('GET /vendor/vue.global.js');

  // 回环管理 API 直接可用
  const stats = await get(inst.httpPort, '/api/stats');
  assert.strictEqual(stats.status, 200);
  assert.ok('shares' in stats.json());
  ok('回环管理 API 放行');

  // settings 不泄露哈希
  const st = await get(inst.httpPort, '/api/settings');
  assert.strictEqual(st.json().adminPasswordHash, undefined);
  assert.strictEqual(st.json().adminPasswordSet, false);
  ok('settings 隐藏 adminPasswordHash');

  // 会话二维码接口
  const qr = await get(inst.httpPort, '/api/chat/qrcode');
  assert.strictEqual(qr.status, 200);
  assert.ok(qr.json().dataUrl.startsWith('data:image/png'));
  ok('GET /api/chat/qrcode');

  // 未设密码时设置管理密码（回环）
  const setPw = await get(inst.httpPort, '/api/admin/password', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ newPassword: 'test1234' }));
  assert.strictEqual(setPw.status, 200);
  ok('设置管理密码');

  // settings 现在显示已设置
  const st2 = await get(inst.httpPort, '/api/settings');
  assert.strictEqual(st2.json().adminPasswordSet, true);
  ok('adminPasswordSet 状态翻转');

  // 错误密码登录
  const bad = await get(inst.httpPort, '/api/admin/login', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ password: 'wrong' }));
  assert.strictEqual(bad.status, 401);
  ok('错误密码 → 401');

  // 正确密码登录得 token（远程模拟：直接走 login 后用中间件验证 token）
  const good = await get(inst.httpPort, '/api/admin/login', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ password: 'test1234' }));
  assert.strictEqual(good.status, 200);
  const token = good.json().token;
  assert.ok(/^[0-9]+\.[0-9a-f]{64}$/.test(token));
  ok('正确密码 → 签发 token');

  // token 可通过中间件远程校验（模拟远程 IP）
  const mw = adminAuth({ clientIp: (r) => r._ip, settings: inst.settings, masterKey: inst.masterKey });
  const res = { statusCode: 0, json() {} , status(c) { this.statusCode = c; return this; } };
  let nexted = false;
  mw({ path: '/shares', _ip: '192.168.1.66', headers: { 'x-admin-token': token }, query: {} }, res, () => (nexted = true));
  assert.ok(nexted);
  ok('远程持 token 放行');

  // 旧密码改新密码
  const rePw = await get(inst.httpPort, '/api/admin/password', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ oldPassword: 'test1234', newPassword: 'test5678' }));
  assert.strictEqual(rePw.status, 200);
  // 旧 token 是否仍有效（同一 masterKey，token 未变）——重新登录换新 token
  const reLogin = await get(inst.httpPort, '/api/admin/login', { 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ password: 'test5678' }));
  assert.strictEqual(reLogin.status, 200);
  ok('修改密码后可重新登录');

  // 门户页
  const root = await get(inst.httpPort, '/');
  assert.strictEqual(root.status, 200);
  assert.ok(root.body.includes('管理控制台') && root.body.includes('统一会话'));
  ok('门户页含双入口');

  await inst.stop();
}

(async () => {
  console.log('— 单元测试 —');
  unitTests();
  console.log('— 集成测试 —');
  await integrationTests();
  console.log(`\n全部通过：${passed} 项`);
  process.exit(0);
})().catch((e) => {
  console.error('✗ FAIL:', e.message);
  process.exit(1);
});
