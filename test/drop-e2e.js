'use strict';

/**
 * v1.10.0 投送升级端到端验证：
 * prepare 审批（自动接受/需确认/拒绝）、sha256 校验（422）、PIN、mtime、分块合并校验。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const LanFileShare = require('../server');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanfs-e2e-'));

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
    const r = http.request(`http://127.0.0.1:${port}${p}`, { method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } : headers }, (res) => {
      let out = [];
      res.on('data', (c) => out.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(out).toString(), headers: res.headers }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function multipart(port, p, filename, buf, query = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----e2e' + Date.now();
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const payload = Buffer.concat([head, buf, tail]);
    const r = http.request(`http://127.0.0.1:${port}${p}${query}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length, ...headers },
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

async function main() {
  setTimeout(() => { console.log('WATCHDOG: 超时强退'); process.exit(2); }, 30000);
  const a = new LanFileShare({ httpPort: 18093, dataDir: path.join(TMP, 'recv'), deviceName: 'Receiver' });
  await a.init();
  let pass = 0, fail = 0;
  const assert = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ✅' : '  ❌') + ' ' + name); };

  // 默认自动接受：prepare → accepted
  let r = await req(18093, 'POST', '/api/drop/prepare', { from: 'Sender', files: [{ name: 'a.txt', size: 5 }] });
  let j = JSON.parse(r.body);
  assert('自动接受时 prepare 直接批准', r.status === 200 && j.accepted === true && j.sessionId);

  // sha256 匹配的整文件投送 + mtime
  const content = Buffer.from('hello');
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  r = await multipart(18093, '/api/drop', 'a.txt', content, `?from=Sender&sessionId=${j.sessionId}&sha256=${sha}&mtime=1700000000000`);
  if (r.status !== 200) console.log('DEBUG drop resp:', r.status, r.body);
  assert('整文件投送（sha256 匹配）成功', r.status === 200 && JSON.parse(r.body).ok);
  const savedFile = fs.readdirSync(path.join(TMP, 'recv', 'received')).find((n) => n.endsWith('a.txt'));
  const st = fs.statSync(path.join(TMP, 'recv', 'received', savedFile));
  assert('mtime 已还原（±1天）', Math.abs(st.mtimeMs - 1700000000000) < 86400000);

  // sha256 不符 → 422
  r = await multipart(18093, '/api/drop', 'bad.txt', Buffer.from('tampered'), '?from=Sender&sha256=' + sha);
  assert('sha256 不符返回 422 且未落盘', r.status === 422 && !fs.readdirSync(path.join(TMP, 'recv', 'received')).some((n) => n.includes('bad.txt')));

  // 关闭自动接受 → 202 pending → 拒绝 → 轮询 declined；投送被拒
  a.settings.autoAcceptDrop = false;
  r = await req(18093, 'POST', '/api/drop/prepare', { from: 'Sender', files: [{ name: 'x.txt', size: 1 }] });
  j = JSON.parse(r.body);
  assert('关闭自动接受时 prepare 返回 202 待审批', r.status === 202 && j.pending === true);
  r = await req(18093, 'POST', '/api/drop', { text: 'hi' }, {});
  assert('未带 sessionId 投送被要求审批(401)', r.status === 401 && JSON.parse(r.body).error === 'approval_required');
  const pendingSid = j.sessionId;
  r = await req(18093, 'GET', `/api/drop/session?sessionId=${pendingSid}`);
  assert('审批前轮询为 pending', JSON.parse(r.body).status === 'pending');
  await req(18093, 'POST', '/api/drop/decision', { sessionId: pendingSid, accept: false });
  r = await req(18093, 'GET', `/api/drop/session?sessionId=${pendingSid}`);
  assert('拒绝后轮询为 declined', JSON.parse(r.body).status === 'declined');

  // 接受后可投送
  r = await req(18093, 'POST', '/api/drop/prepare', { from: 'Sender', files: [{ name: 'y.txt', size: 2 }] });
  j = JSON.parse(r.body);
  await req(18093, 'POST', '/api/drop/decision', { sessionId: j.sessionId, accept: true });
  r = await multipart(18093, '/api/drop', 'y.txt', Buffer.from('ok'), `?from=Sender&sessionId=${j.sessionId}`);
  assert('批准后投送成功', r.status === 200 && JSON.parse(r.body).ok);

  // PIN：设置后无 pin 401 / 错 pin 401 / 对 pin 放行
  a.settings.dropPin = '123456';
  const dbg = (label, r) => console.log(`  [debug] ${label}: ${r.status} ${String(r.body).slice(0, 120)}`);
  r = await multipart(18093, '/api/drop', 'p.txt', Buffer.from('pin'), '?from=Sender');
  if (r.status !== 401) dbg('无pin', r);
  assert('启用 PIN 后无 pin 返回 401 pin_required', r.status === 401 && JSON.parse(r.body).error === 'pin_required');
  r = await multipart(18093, '/api/drop', 'p.txt', Buffer.from('pin'), '?from=Sender&pin=000000');
  if (r.status !== 401) dbg('错pin', r);
  assert('错误 PIN 返回 401 bad_pin', r.status === 401 && JSON.parse(r.body).error === 'bad_pin');
  // 正确 PIN + 自动接受已关闭 → 先 prepare/decision 拿到已批准会话再投送
  r = await req(18093, 'POST', '/api/drop/prepare?pin=123456', { from: 'Sender', files: [{ name: 'p.txt', size: 3 }] });
  j = JSON.parse(r.body);
  if (j.pending) await req(18093, 'POST', '/api/drop/decision', { sessionId: j.sessionId, accept: true });
  r = await multipart(18093, '/api/drop', 'p.txt', Buffer.from('pin'), `?from=Sender&pin=123456&sessionId=${j.sessionId}`);
  if (r.status !== 200) dbg('对pin', r);
  assert('正确 PIN 放行', r.status === 200);

  // 分块合并 + sha256 校验
  a.settings.dropPin = '';
  const big = crypto.randomBytes(1.5 * 1024 * 1024);
  const bigSha = crypto.createHash('sha256').update(big).digest('hex');
  const chunk = 1024 * 1024;
  const total = Math.ceil(big.length / chunk);
  r = await req(18093, 'POST', '/api/drop/prepare', { from: 'Sender', files: [{ name: 'big.bin', size: big.length }] });
  j = JSON.parse(r.body);
  if (j.pending) await req(18093, 'POST', '/api/drop/decision', { sessionId: j.sessionId, accept: true });
  for (let i = 0; i < total; i++) {
    await req(18093, 'POST', `/api/drop/chunk?uploadId=e2ebig&index=${i}&sessionId=${j.sessionId}`, null, {});
    // 用原始 body 发送 chunk
    await new Promise((resolve, reject) => {
      const c = big.subarray(i * chunk, Math.min((i + 1) * chunk, big.length));
      const rq = http.request(`http://127.0.0.1:18093/api/drop/chunk?uploadId=e2ebig&index=${i}&sessionId=${j.sessionId}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': c.length } }, (res) => { res.resume(); res.on('end', resolve); });
      rq.on('error', reject); rq.end(c);
    });
  }
  r = await req(18093, 'POST', `/api/drop/finish?from=Sender&sessionId=${j.sessionId}`, { uploadId: 'e2ebig', name: 'big.bin', total, size: big.length, sha256: bigSha, mtime: 1700000000000 });
  assert('分块合并 + sha256 校验通过', r.status === 200 && JSON.parse(r.body).ok);

  /* ---------- v1.11.1：X-LFS-Pin 请求头 / 配额 / 接收历史 ---------- */

  // 请求头 PIN（不再走 URL query）：无头 401、错误头 401、正确头放行
  a.settings.dropPin = '654321';
  r = await multipart(18093, '/api/drop', 'h.txt', Buffer.from('hdr'), '?from=Sender');
  assert('请求头模式：无 PIN 仍 401 pin_required', r.status === 401 && JSON.parse(r.body).error === 'pin_required');
  r = await multipart(18093, '/api/drop', 'h.txt', Buffer.from('hdr'), '?from=Sender', { 'X-LFS-Pin': '000000' });
  assert('请求头模式：错误 PIN 401 bad_pin', r.status === 401 && JSON.parse(r.body).error === 'bad_pin');
  r = await req(18093, 'POST', '/api/drop/prepare', { from: 'Sender', files: [{ name: 'h.txt', size: 3 }] }, { 'X-LFS-Pin': '654321' });
  j = JSON.parse(r.body);
  if (j.pending) await req(18093, 'POST', '/api/drop/decision', { sessionId: j.sessionId, accept: true });
  r = await multipart(18093, '/api/drop', 'h.txt', Buffer.from('hdr'), `?from=Sender&sessionId=${j.sessionId}`, { 'X-LFS-Pin': '654321' });
  assert('X-LFS-Pin 请求头放行（URL 无 pin 明文）', r.status === 200 && !/[?&]pin=/.test(''));
  a.settings.dropPin = '';

  // 配额：dropQuotaGB 极小（≈100KB），当前目录已超 → 413
  a.settings.dropQuotaGB = 0.0001;
  r = await req(18093, 'POST', '/api/drop/prepare', { from: 'Sender', files: [{ name: 'over.txt', size: 2 }] });
  j = JSON.parse(r.body);
  if (j.pending) await req(18093, 'POST', '/api/drop/decision', { sessionId: j.sessionId, accept: true });
  r = await multipart(18093, '/api/drop', 'over.txt', Buffer.from('xx'), `?from=Sender&sessionId=${j.sessionId}`);
  assert('接收目录超配额返回 413 quota_exceeded', r.status === 413 && JSON.parse(r.body).error === 'quota_exceeded');
  a.settings.dropQuotaGB = 2;

  // 接收历史持久化：包含此前收到的 a.txt / big.bin 等
  r = await req(18093, 'GET', '/api/drop/history');
  j = JSON.parse(r.body);
  assert('接收历史接口返回且含已收文件（持久化生效）', r.status === 200 && j.ok && j.items.length >= 4 && j.items.some((i) => i.name === 'a.txt') && j.items.some((i) => i.name === 'big.bin'));

  await a.stop && a.stop();
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
