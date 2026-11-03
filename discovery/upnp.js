'use strict';

const http = require('http');
const dgram = require('dgram');

/**
 * 零依赖 UPnP IGD 客户端（尽力而为）：
 * - discover(): SSDP M-SEARCH 发现网关设备描述 URL
 * - mapPorts(ports): AddPortMapping 把内网端口映射到网关 WAN 侧（同端口）
 * - externalIp(): GetExternalIPAddress
 * 所有调用带短超时，失败静默返回 null/false——UPnP 不可用时走既有会合点中继，互不影响。
 */

const SSDP_ADDR = '239.255.255.250:1900';
const SEARCH_TARGET = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';
const TIMEOUT = 3000;

function parseControlUrls(xml) {
  // 提取 WANIPConnection / WANPPPConnection 的 controlURL（可能位于子设备描述）
  const urls = [];
  const re = /<service>[\s\S]*?<\/service>/g;
  let m;
  while ((m = re.exec(xml))) {
    const svc = m[0];
    const type = (svc.match(/<serviceType>([^<]+)<\/serviceType>/) || [])[1] || '';
    const ctrl = (svc.match(/<controlURL>([^<]+)<\/controlURL>/) || [])[1] || '';
    if (ctrl && /WAN(IP|PPP)Connection/.test(type)) urls.push({ type, controlURL: ctrl.trim() });
  }
  return urls;
}

function resolveUrl(base, relative) {
  if (/^https?:\/\//i.test(relative)) return relative;
  const u = new URL(base);
  if (relative.startsWith('/')) return `${u.origin}${relative}`;
  const dir = u.pathname.replace(/\/[^/]*$/, '/');
  return `${u.origin}${dir}${relative}`;
}

/** 获取 XML（跟随一次重定向由 http 模块自动处理；短超时） */
function fetchText(url, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 512 * 1024) { req.destroy(); resolve(null); }
        body += c;
      });
      res.on('end', () => resolve(body || null));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function soapRequest(host, port, path, serviceType, action, bodyXml, timeout = TIMEOUT) {
  const body = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>${bodyXml}</s:Body>
</s:Envelope>`;
  return new Promise((resolve) => {
    const data = Buffer.from(body);
    const req = http.request(
      { host, port, path, method: 'POST', timeout,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"${serviceType}#${action}"`,
          'Content-Length': data.length,
        } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(data);
    req.end();
  });
}

/** SSDP 发现网关描述 URL（返回第一个可用 device XML） */
async function discover() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let descUrls = new Set();
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch (e) {}
      // 依次尝试拉取设备描述，找到含 WAN*Connection 控制地址的
      for (const url of descUrls) {
        const xml = await fetchText(url);
        if (!xml) continue;
        const ctrls = parseControlUrls(xml);
        if (ctrls.length) {
          // 子描述里 controlURL 可能相对子设备 XML（handle 不同），直接按该 XML 地址解析
          resolve({ base: url, xml, controls: ctrls.map((c) => ({ ...c, absolute: resolveUrl(url, c.controlURL) })) });
          return;
        }
        // 根描述可能只引用子设备描述 URL
        const scpdHint = (xml.match(/<(?:URLBase|friendlyName)>/g) || []).length;
        if (!scpdHint) continue;
      }
      resolve(null);
    };
    sock.on('message', (msg) => {
      const head = msg.toString();
      const loc = (head.match(/^LOCATION:\s*(.+)$/im) || [])[1];
      if (loc) descUrls.add(loc.trim());
    });
    sock.on('error', () => finish());
    sock.bind(() => {
      const query = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${SEARCH_TARGET}\r\n\r\n`
      );
      sock.send(query, 0, query.length, 1900, '239.255.255.250');
      sock.send(query, 0, query.length, 1900, '239.255.255.250');
      setTimeout(finish, 3500);
    });
  });
}

/**
 * 映射端口到网关。ports: [{ port, protocol }]（外部端口=内部端口，描述 lanfs）。
 * 返回 { ok, externalIp, mapped:[...] } 或 { ok:false, reason }。
 */
async function mapPorts(localIp, ports) {
  const gw = await discover();
  if (!gw) return { ok: false, reason: 'no_gateway' };
  const u = new URL(gw.controls[0].absolute);
  const mapped = [];
  for (const { port, protocol } of ports) {
    for (const c of gw.controls) {
      const body = `<u:AddPortMapping xmlns:u="${c.type}">
<NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort>
<NewProtocol>${protocol || 'TCP'}</NewProtocol><NewInternalPort>${port}</NewInternalPort>
<NewInternalClient>${localIp}</NewInternalClient><NewEnabled>1</NewEnabled>
<NewPortMappingDescription>lan-file-share</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>
</u:AddPortMapping>`;
      const r = await soapRequest(u.hostname, u.port || 80, u.pathname, c.type, 'AddPortMapping', body);
      if (r && r.status === 200) { mapped.push({ port, protocol: protocol || 'TCP' }); break; }
      if (r && /718/i.test(r.body)) { mapped.push({ port, protocol: protocol || 'TCP', conflictExisting: true }); break; } // 冲突=可能已映射
    }
  }
  let externalIp = null;
  const body = `<u:GetExternalIPAddress xmlns:u="${gw.controls[0].type}"></u:GetExternalIPAddress>`;
  const r = await soapRequest(u.hostname, u.port || 80, u.pathname, gw.controls[0].type, 'GetExternalIPAddress', body);
  if (r && r.status === 200) {
    externalIp = ((r.body.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/) || [])[1] || '').trim() || null;
  }
  return { ok: mapped.length > 0, externalIp, mapped, gateway: u.origin };
}

module.exports = { discover, mapPorts, parseControlUrls, resolveUrl };
