'use strict';
/**
 * v1.19.0 专项测试：LocalSend 互通网关
 * - 协议端点：/info /register /prepare-upload /upload /cancel（PIN、403、sha256、409）
 * - 接收落收件箱 + drop.incoming 通知 + drop 历史
 * - 发送方 sendFiles（模拟 LocalSend 接收端：起一个符合协议的极简 HTTP 服务）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');

const DATA = path.join(os.tmpdir(), 'lfs-f19-test-' + Date.now());
const PORT = 18792;

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

(async () => {
  const LanFileShare = require('../server/index.js');
  const engine = new LanFileShare({ httpPort: PORT, dataDir: DATA, silent: true });
  await engine.init();
  engine.settings.autoAcceptDrop = true;
  engine.settings.dropPin = '';
  await sleep(600); // 等网关启动

  console.log('\n— 协议端点 —');
  const ls = engine.localsend;
  ok('网关已启动', !!ls);
  const proto = ls.protocol; // 沙箱内 openssl 可能缺失 → http 或 https 都允许
  const lsBase = `${proto}://127.0.0.1:${ls.port}`;
  ok('端口为 53317（同机多实例时自动让位递增）', ls.port >= 53317 && ls.port <= 53323);
  ok('指纹已生成', !!ls.fingerprint);

  // 用 node http/https 访问（https 自签需放宽校验）
  const call = (p, opts = {}) => new Promise((resolve, reject) => {
    const mod = proto === 'https' ? require('https') : http;
    const req = mod.request({ host: '127.0.0.1', port: ls.port, path: p, method: opts.method || 'GET', headers: opts.headers || {}, rejectUnauthorized: false, timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (opts.body) req.end(opts.body); else req.end();
  });

  // 1) info
  const info = await call('/api/localsend/v2/info');
  const infoJ = JSON.parse(info.body || '{}');
  ok('GET /info 返回 alias+version', info.status === 200 && !!infoJ.alias && /^2\.\d$/.test(infoJ.version || ''));

  // 2) register 双向发现
  const reg = await call('/api/localsend/v2/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: '模拟LocalSend', version: '2.1', fingerprint: 'fakefp1234567890', port: 53317, protocol: 'http', deviceType: 'desktop' }) });
  ok('POST /register 返回本机信息', reg.status === 200 && !!JSON.parse(reg.body || '{}').alias);

  // 3) prepare-upload → session
  const fileBuf = Buffer.from('LocalSend 互通测试内容 ' + Date.now());
  const fid = 'f1';
  const prep = await call('/api/localsend/v2/prepare-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: '模拟LocalSend', version: '2.1', fingerprint: 'fakefp1234567890', protocol: 'http' }, files: { [fid]: { id: fid, fileName: '互通测试.txt', size: fileBuf.length, fileType: 'text/plain', sha256: sha256(fileBuf) } } }) });
  ok('prepare-upload 返回 sessionId+token', prep.status === 200 && !!JSON.parse(prep.body || '{}').sessionId && !!JSON.parse(prep.body).files[fid]);
  const { sessionId, files: tokens } = JSON.parse(prep.body);

  // 裸流上传助手（协议自适应 + 自签放宽）
  const rawUpload = (query, data) => new Promise((resolve, reject) => {
    const mod = proto === 'https' ? require('https') : http;
    const r = mod.request({ host: '127.0.0.1', port: ls.port, path: '/api/localsend/v2/upload' + query, method: 'POST', rejectUnauthorized: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end(data);
  });

  // 4) upload：错误 token → 403
  const bad = await rawUpload(`?sessionId=${sessionId}&fileId=${fid}&token=WRONG`, 'x');
  ok('错误 token 被拒 403', bad === 403);

  // 5) upload 正确 token + sha256 校验
  const up = await rawUpload(`?sessionId=${sessionId}&fileId=${fid}&token=${tokens[fid]}`, fileBuf);
  ok('upload 成功（sha256 校验通过）', up === 200);
  await sleep(400);

  // 6) 落收件箱 + 历史 + 通知
  const recv = fs.readdirSync(engine.receivedDir).filter((f) => f.includes('互通测试'));
  ok('文件落收件箱', recv.length === 1 && fs.readFileSync(path.join(engine.receivedDir, recv[0])).equals(fileBuf));
  const hist = engine.db.listDropHistory(10);
  ok('drop 历史已记录', hist.some((h) => h.name === '互通测试.txt' && h.from_name === '模拟LocalSend'));
  ok('设备已注入设备表（via=localsend）', engine.deviceManager.list().some((d) => d.via === 'localsend' && d.device_name === '模拟LocalSend'));

  // 7) PIN 模式：dropPin 设置后无 pin → 401
  engine.settings.dropPin = '123456';
  const p401 = await call('/api/localsend/v2/prepare-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: 'x', fingerprint: 'fp2' }, files: { a: { id: 'a', fileName: 'a.txt', size: 1 } } }) });
  ok('PIN 缺失 → 401', p401.status === 401);
  const pOK = await call('/api/localsend/v2/prepare-upload?pin=123456', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: 'x', fingerprint: 'fp2' }, files: { a: { id: 'a', fileName: 'a.txt', size: 1 } } }) });
  ok('PIN 正确 → 200', pOK.status === 200);
  engine.settings.dropPin = '';

  // 8) 关闭自动接收 → 403
  engine.settings.autoAcceptDrop = false;
  const p403 = await call('/api/localsend/v2/prepare-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: 'x', fingerprint: 'fp2' }, files: { a: { id: 'a', fileName: 'a.txt', size: 1 } } }) });
  ok('关闭自动接收 → 403', p403.status === 403);
  engine.settings.autoAcceptDrop = true;

  // 9) sha256 不匹配 → 422
  const prep2 = await call('/api/localsend/v2/prepare-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ info: { alias: 'x', fingerprint: 'fp2' }, files: { f2: { id: 'f2', fileName: 'bad.txt', size: 5, sha256: 'deadbeef' + '0'.repeat(56) } } }) });
  const j2 = JSON.parse(prep2.body);
  const up2 = await rawUpload(`?sessionId=${j2.sessionId}&fileId=f2&token=${j2.files.f2}`, 'hello');
  ok('sha256 不匹配 → 422', up2 === 422);

  console.log('\n— 发送方（模拟 LocalSend 接收端） —');
  // 起一个符合协议的极简 LocalSend 接收端
  const rxDir = path.join(DATA, 'rx');
  fs.mkdirSync(rxDir, { recursive: true });
  const rxSessions = new Map();
  const rx = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/localsend/v2/prepare-upload' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const j = JSON.parse(b);
        const sid = 'rx-' + Date.now();
        const tokens = {};
        for (const fid of Object.keys(j.files || {})) tokens[fid] = 'tok-' + fid;
        rxSessions.set(sid, { files: Object.keys(j.files || {}) });
        res.end(JSON.stringify({ sessionId: sid, files: tokens }));
      });
    } else if (url.pathname === '/api/localsend/v2/upload' && req.method === 'POST') {
      const sid = url.searchParams.get('sessionId');
      const fid = url.searchParams.get('fileId');
      if (!rxSessions.has(sid) || !rxSessions.get(sid).files.includes(fid)) { res.statusCode = 403; return res.end(); }
      const out = fs.createWriteStream(path.join(rxDir, fid + '.bin'));
      req.pipe(out);
      out.on('finish', () => { res.statusCode = 200; res.end(); });
      out.on('error', () => { res.statusCode = 500; res.end(); });
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => rx.listen(15331, r));

  // 10) sendFiles → prepare + upload
  const sendPath = path.join(DATA, 'outgoing.bin');
  const outBuf = Buffer.from('从本工具发往 LocalSend 的内容 ' + Date.now());
  fs.writeFileSync(sendPath, outBuf);
  const sent = await ls.sendFiles({ host: '127.0.0.1', port: 15331, protocol: 'http' }, [{ path: sendPath, name: 'outgoing.bin', size: outBuf.length, mime: 'application/octet-stream' }]);
  ok('sendFiles 成功', sent.ok && sent.sent === 1);

  // 对端以 fileId 命名，核对内容
  const rxFiles = fs.readdirSync(rxDir);
  const rxHit = rxFiles.map((f) => fs.readFileSync(path.join(rxDir, f))).find((b) => b.equals(outBuf));
  ok('对端内容逐字节一致', !!rxHit);

  rx.close();
  await engine.stop();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
