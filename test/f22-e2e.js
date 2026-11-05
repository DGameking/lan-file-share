'use strict';
/* f22-e2e：v1.22.3 会话成员联邦自愈对账
 * 覆盖：握手成员同步 / 双向可见 / 丢帧致盲后周期对账拉回 / 断连清理远端成员 */
const path = require('path');
const fs = require('fs');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}
const mk = async (port, name) => {
  const dataDir = path.join(__dirname, '..', 'tmp-f22-' + port);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const LanFileShare = require('../server/index.js');
  // 禁用 UDP/mDNS：隔离局域网真实设备（否则线上 NAS 会连入测试引擎造成干扰）
  const e = new LanFileShare({ httpPort: port, dataDir, silent: true, settings: { udp: false, mdns: false, upnp: false, localsend: false } });
  await e.init();
  e.updateSettings({ deviceName: name });
  return e;
};

(async () => {
  console.log('f22 会话成员联邦自愈对账');
  const A = await mk(18901, '主机A');
  const B = await mk(18902, '主机B');

  // 1) 建立桥接（localhost 双引擎收不到彼此 UDP 心跳，先注册再显式绕过 tie-breaker 发起，
  //    与真实环境「deviceId 较小一端发起」等价：总有且仅有一条通道）
  await A.connectManual({ host: '127.0.0.1', port: 18902 });
  A.bridge._connect({ device_id: B.deviceId, host: '127.0.0.1', port: 18902, is_blacklisted: false });
  await new Promise((r) => setTimeout(r, 1200));
  ok('A→B 桥接已建立（A 发起）', A.bridge.outbound.size === 1 && B.bridge.inbound.size >= 1);

  // 2) 握手后双方都能看到对方成员
  await new Promise((r) => setTimeout(r, 800));
  const aNames = () => A.chat._combinedMembers().map((m) => m.name);
  const bNames = () => B.chat._combinedMembers().map((m) => m.name);
  ok('A 能看到 B（握手同步）', aNames().includes('主机B'));
  ok('B 能看到 A（握手同步）', bNames().includes('主机A'));

  // 3) 模拟「丢帧致盲」：A 的远端成员表被清空（对应线上实际故障形态）
  A.bridge.remoteMembers.clear();
  A.bridge._refreshLocalMembers();
  ok('致盲后 A 看不到 B', !aNames().includes('主机B'));

  // 4) 周期对账拉回（不等 45s，直接触发一次 _resyncOnce）
  B.bridge._resyncOnce();
  A.bridge._resyncOnce();
  await new Promise((r) => setTimeout(r, 600));
  ok('对账后 A 重新看到 B（自愈）', aNames().includes('主机B'));
  ok('对账后 B 仍能看到 A', bNames().includes('主机A'));

  // 5) 断连清理：A 停止后 B 的远端成员表应清掉 A
  await A.stop().catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  ok('A 下线后 B 清理 A 的远端成员', !bNames().includes('主机A'));

  await B.stop().catch(() => {});
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  for (const p of [18901, 18902]) {
    try { fs.rmSync(path.join(__dirname, '..', 'tmp-f22-' + p), { recursive: true, force: true }); } catch (e) {}
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
