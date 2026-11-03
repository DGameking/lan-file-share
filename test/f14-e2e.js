'use strict';

/**
 * v1.14.0 新功能端到端验证：
 * UPnP XML/SOAP 解析单测（离线）、Hub wanPort 传播 → rendezvous directPort 注入、聊天历史分页。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LanFileShare = require('../server');
const upnp = require('../discovery/upnp');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lanfs-f14-'));
const HUB_PORT = 18401, A_PORT = 18402, B_PORT = 18403;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  setTimeout(() => { console.log('WATCHDOG: 超时强退'); process.exit(2); }, 60000);
  let pass = 0, fail = 0;
  const assert = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '  ✅' : '  ❌') + ' ' + name); };

  /* ---------- UPnP 解析单测（离线） ---------- */
  const sampleXml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
<URLBase>http://192.168.1.1:5000</URLBase>
<device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<deviceList><device>
<serviceList>
<service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/ctl/L3F</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType><controlURL>/ctl/PPPConn</controlURL></service>
</serviceList>
</device></deviceList></device>
</root>`;
  const ctrls = upnp.parseControlUrls(sampleXml);
  assert('parseControlUrls 提取 WAN*Connection 两条', ctrls.length === 2 && ctrls.every((c) => /WAN(IP|PPP)Connection/.test(c.type)));
  assert('resolveUrl 相对路径基于描述 URL', upnp.resolveUrl('http://192.168.1.1:5000/igd.xml', '/ctl/IPConn') === 'http://192.168.1.1:5000/ctl/IPConn');
  assert('resolveUrl 绝对路径原样保留', upnp.resolveUrl('http://a/b.xml', 'http://x/y') === 'http://x/y');
  // discover() 无网关环境应静默返回 null（不抛异常）
  const none = await upnp.discover().catch(() => 'threw');
  assert('discover 无 IGD 静默返回 null', none === null);

  /* ---------- Hub wanPort 传播 + directPort 注入 ---------- */
  const hub = new LanFileShare({ httpPort: HUB_PORT, dataDir: path.join(TMP, 'hub'), deviceName: 'Hub' });
  const a = new LanFileShare({ httpPort: A_PORT, dataDir: path.join(TMP, 'a'), deviceName: 'A网段机' });
  const b = new LanFileShare({ httpPort: B_PORT, dataDir: path.join(TMP, 'b'), deviceName: 'B网段机' });
  await Promise.all([hub.init(), a.init(), b.init()]);

  a.settings.rendezvous = `127.0.0.1:${HUB_PORT}`;
  b.settings.rendezvous = `127.0.0.1:${HUB_PORT}`;
  a.rendezvous.poll(); b.rendezvous.poll();
  await sleep(600);
  // B 带 wanPort 再次注册（模拟 UPnP 映射成功）
  const http = require('http');
  await new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify({ deviceId: b.deviceId, deviceName: 'B网段机', port: B_PORT, os: 'win32', version: '1.14.0', wanPort: 39003, deviceType: 'pc', alias: 'B机' }));
    const r = http.request(`http://127.0.0.1:${HUB_PORT}/api/hub/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => { res.resume(); res.on('end', resolve); });
    r.on('error', resolve); r.write(data); r.end();
  });
  a.rendezvous.poll();
  await sleep(600);
  const devB = a.deviceManager.get(b.deviceId);
  assert('A 侧注入 B 含 directPort=wanPort', !!devB && devB.direct_port === 39003);
  assert('A 侧注入 B 保留 relay 标记', !!devB && devB.relay === true);

  /* ---------- 聊天历史分页 ---------- */
  // 直接写 250 条消息进 hub 的 DB
  for (let i = 1; i <= 250; i++) {
    hub.db.addChatMessage({ id: 'f14msg' + i, ts: 1700000000000 + i * 1000, sender_id: 'sys', sender_name: '系统', kind: 'text', text: `消息${i}` });
  }
  const get = (port, p) => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => { let out = []; res.on('data', (c) => out.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(out).toString()))); }).on('error', reject);
  });
  const page1 = await get(HUB_PORT, '/api/chat/history');
  assert('历史首页 200 条（正序）', page1.length === 200 && page1[0].text === '消息51');
  const page2 = await get(HUB_PORT, `/api/chat/history?before=${page1[0].ts}&limit=200`);
  assert('before 游标翻页拿到更早 50 条', page2.length === 50 && page2[0].text === '消息1');

  for (const e of [hub, a, b]) { try { await e.stop(); } catch (err) {} }
  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('E2E 异常:', e); process.exit(1); });
