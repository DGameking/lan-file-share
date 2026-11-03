'use strict';

/**
 * 跨网段发现可行性探测器（PoC，纯 Node 无依赖）。
 * 验证三条技术路线在当前组网下的可行性：
 *  R1 跨网段定向探测：枚举常见私网段，TCP 探测 8080/9527（覆盖 AP/桥接、已做端口映射/DMZ 的对端）
 *  R2 邻层路由器发现：探测其他网段的 .1/.2 网关（WAN 口可达即视为"同光猫另一台路由器"）
 *  R3 UPnP/NAT-PMP：SSDP M-SEARCH 检测本机所在路由器是否支持自动端口映射（双 NAT 打通的关键）
 * 用法：node scripts/cross-subnet-probe.js
 */
const os = require('os');
const net = require('net');
const dgram = require('dgram');

const PROBE_PORTS = [8080, 9527];
const GATEWAY_PORTS = [80, 443];
const GATEWAY_TIMEOUT = 400;
const PORT_TIMEOUT = 500;

function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address)) out.push(i.address);
    }
  }
  return out;
}

function segment(ip) {
  const p = ip.split('.');
  return { net: `${p[0]}.${p[1]}.${p[2]}`, prefix: `${p[0]}.${p[1]}.`, last: Number(p[3]) };
}

function tcpProbe(host, port, timeout) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (ok) => { try { s.destroy(); } catch (e) {} resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host);
  });
}

async function probeHost(host, ports, timeout) {
  const hits = [];
  for (const p of ports) if (await tcpProbe(host, p, timeout)) hits.push(p);
  return hits;
}

/** SSDP M-SEARCH 检测 UPnP IGD（Internet Gateway Device） */
function ssdpDiscover(timeout = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = [];
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: upnp:rootdevice\r\n\r\n'
    );
    sock.on('message', (data) => {
      const text = data.toString();
      const loc = /LOCATION:\s*(\S+)/i.exec(text);
      if (loc && !found.includes(loc[1])) found.push(loc[1]);
    });
    sock.on('error', () => {});
    sock.bind(() => {
      sock.send(msg, 0, msg.length, 1900, '239.255.255.250');
      setTimeout(() => {
        try { sock.close(); } catch (e) {}
        resolve(found);
      }, timeout);
    });
  });
}

async function main() {
  const ips = localIPv4s();
  console.log('== 本机网络形态 ==');
  for (const ip of ips) {
    const seg = segment(ip);
    console.log(`  本机 IP: ${ip}  (网段 ${seg.net}.0/24)`);
  }

  // R2: 常见私网段网关探测（跨网段路由可达时，对端路由器 WAN 口 ping 可达即通）
  // 仅排除与本机同"三段网段"的候选（含本机虚拟网卡网段），保留其余 192.168.x 候选
  const localNets = new Set(ips.map((ip) => segment(ip).net + '.'));
  const candidateNets = new Set();
  for (let i = 0; i <= 31; i++) candidateNets.add(`192.168.${i}.0.`);
  for (let i = 0; i <= 3; i++) candidateNets.add(`10.${i}.0.0.`);
  for (let i = 16; i <= 31; i++) candidateNets.add(`172.${i}.0.0.`);
  for (const netKey of [...candidateNets]) {
    for (const ip of ips) if (netKey.startsWith(segment(ip).net + '.')) candidateNets.delete(netKey);
  }
  const gwCandidates = [];
  for (const pre of candidateNets) {
    for (const last of [1, 2]) gwCandidates.push(`${pre}${last}`);
  }
  const foreignGw = gwCandidates;
  console.log(`\n== R2 邻层路由器探测（${foreignGw.length} 个候选网关，网关口 80/443） ==`);
  const aliveGw = [];
  const concurrency = 60;
  for (let i = 0; i < foreignGw.length; i += concurrency) {
    const batch = foreignGw.slice(i, i + concurrency);
    const rs = await Promise.all(batch.map(async (g) => {
      const hits = await probeHost(g, GATEWAY_PORTS, GATEWAY_TIMEOUT);
      return hits.length ? { host: g, ports: hits } : null;
    }));
    for (const r of rs) if (r) aliveGw.push(r);
  }
  if (aliveGw.length) {
    for (const g of aliveGw) console.log(`  ✅ 发现异网段网关/路由器: ${g.host} (端口 ${g.ports.join(',')})`);
  } else {
    console.log('  ⚠️ 未发现异网段网关——若确有两路由器不同网段，则出站路由被隔离（光猫隔离或路由模式限制）');
  }

  // R1: 跨网段 8080/9527 服务探测（对邻层网段常见 .2-.100 段抽样）
  console.log('\n== R1 跨网段服务探测（对发现的邻层网段抽样 .2-.99，端口 8080/9527） ==');
  if (aliveGw.length) {
    const segPrefixes = [...new Set(aliveGw.map((g) => g.host.split('.').slice(0, 3).join('.') + '.'))];
    const svcCandidates = [];
    for (const pre of segPrefixes) {
      // 网关所在网段（可能是光猫 LAN 层），同时抽其常见 LAN 候选网段
      for (const last of [2, 3, 10, 50, 100]) svcCandidates.push(`${pre}${last}`);
      const p2 = pre.split('.');
      for (const third of [0, 1, 2, 3, 31]) {
        for (const last of [2, 10, 100]) svcCandidates.push(`${p2[0]}.${p2[1]}.${third}.${last}`);
      }
    }
    const uniq = [...new Set(svcCandidates)].filter((h) => !ips.some((ip) => ip === h));
    console.log(`  抽样 ${uniq.length} 个地址...`);
    const found = [];
    for (let i = 0; i < uniq.length; i += concurrency) {
      const batch = uniq.slice(i, i + concurrency);
      const rs = await Promise.all(batch.map(async (h) => {
        const hits = await probeHost(h, PROBE_PORTS, PORT_TIMEOUT);
        return hits.length ? { host: h, ports: hits } : null;
      }));
      for (const r of rs) if (r) found.push(r);
    }
    if (found.length) for (const f of found) console.log(`  ✅ 发现跨网段本工具服务: ${f.host}:${f.ports.join('/')}`);
    else console.log('  ⚠️ 抽样未发现 8080/9527——对端若在 NAT 后且未映射，出站不可达（需 R3 UPnP 或端口映射）');
  } else {
    console.log('  （跳过：无邻层网关可达，路由层已被隔离）');
  }

  // R3: UPnP 可用性
  console.log('\n== R3 UPnP/NAT-PMP 检测（SSDP upnp:rootdevice） ==');
  const devices = await ssdpDiscover();
  if (devices.length) {
    console.log(`  ✅ 本机路由器支持 UPnP（发现 ${devices.length} 个 rootdevice 描述）`);
    for (const d of devices.slice(0, 3)) console.log(`     ${d}`);
    console.log('  → 可用 nat-api(npm, 纯JS) 自动添加 8080/9527 端口映射，双 NAT 场景可打通');
  } else {
    console.log('  ❌ 未发现 UPnP IGD——路由器关闭 UPnP 或不支持，R3 不可用（需在路由器开启，或手动端口映射/DMZ）');
  }

  console.log('\n== 结论判定 ==');
  console.log(`  R1 直连探测: ${aliveGw.length ? '路由层可达，可做' : '被隔离，纯软件难通'}`);
  console.log(`  R2 网关发现: ${aliveGw.length ? '可用' : '受限'}`);
  console.log(`  R3 UPnP 映射: ${devices.length ? '可用' : '不可用'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
