'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 自诊断：对引擎各子系统做健康检查，能自动修复的当场修复（重建目录、重启 UDP、
 * 重新探测设备），并输出人类可读的结论 —— 管理控制台「一键自检」调用。
 */

function writableTest(dir) {
  try {
    const probe = path.join(dir, `.diag-${Date.now()}.tmp`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

async function run(engine) {
  const checks = [];
  const log = (name, ok, detail, fixed) => checks.push({ name, ok, detail, fixed: !!fixed });

  // 1. 数据目录
  try {
    fs.mkdirSync(engine.dataDir, { recursive: true });
    log('数据目录可写', writableTest(engine.dataDir), engine.dataDir);
  } catch (e) {
    log('数据目录可写', false, `创建/访问失败：${e.message}`);
  }

  // 2. 数据库
  try {
    engine.db.listShares();
    log('数据库连接', true, engine.dbPath);
  } catch (e) {
    log('数据库连接', false, e.message);
  }

  // 3. HTTP 服务
  log('HTTP 服务', !!engine.server && engine.server.listening, `端口 ${engine.httpPort}${engine.useHttps ? '（HTTPS）' : ''}`);

  // 4. 局域网地址
  const lanOk = engine.localIp && engine.localIp !== '127.0.0.1';
  log(
    '局域网地址',
    !!lanOk,
    lanOk ? engine.localIp : '未获取到局域网 IP（其他设备将无法发现本机）— 检查网络连接'
  );

  // 5. UDP 发现（失败自动重启）
  if (engine.settings.udp) {
    let udpOk = !!engine.udp && !!engine.udp.port;
    let fixed = false;
    if (!udpOk) {
      try {
        const UdpDiscovery = require('../discovery/udp-broadcast');
        const { UDP_PORT_RANGE } = require('../shared/constants');
        const buildHeartbeat = () => ({
          protocol: require('../shared/constants').PROTOCOL,
          deviceId: engine.deviceId,
          deviceName: engine.deviceName,
          host: engine.localIp,
          port: engine.httpPort,
          os: engine.osType,
          version: engine.version,
          sharedCount: engine.enabledShareCount(),
          status: 'online',
        });
        const udp = new UdpDiscovery({ selfId: engine.deviceId, interval: engine.settings.heartbeatInterval || 3 });
        udp.on('device', (info) => engine._onPeer(info));
        await udp.start({ getHeartbeat: buildHeartbeat, portRange: UDP_PORT_RANGE });
        engine.udp = udp;
        engine.udpPort = udp.port;
        udp.startHeartbeat();
        udpOk = true;
        fixed = true;
        engine.logger && engine.logger.warn('diagnose', 'UDP 未运行，已自动重启', { port: udp.port });
      } catch (e) {
        log('UDP 发现', false, `重启失败：${e.message}`);
        udpOk = null; // 已记录
      }
      if (udpOk) log('UDP 发现', true, `端口 ${engine.udpPort}`, fixed);
    } else {
      log('UDP 发现', true, `端口 ${engine.udpPort}`);
    }
  } else {
    log('UDP 发现', true, '设置中已关闭（跳过）');
  }

  // 6. mDNS
  if (engine.settings.mdns) {
    log('mDNS 发现', !!engine.mdns, engine.mdns ? '运行中' : '未运行（可能是系统服务缺失，不影响 UDP 发现）');
  } else {
    log('mDNS 发现', true, '设置中已关闭（跳过）');
  }

  // 7. 会话文件目录（自动重建）
  try {
    const chatDir = process.env.LFS_CHAT_FILES || path.join(engine.dataDir, 'chat-files');
    if (!fs.existsSync(chatDir)) {
      fs.mkdirSync(chatDir, { recursive: true });
      log('会话文件目录', true, `目录缺失已重建：${chatDir}`, true);
    } else {
      log('会话文件目录', writableTest(chatDir), chatDir);
    }
  } catch (e) {
    log('会话文件目录', false, e.message);
  }

  // 8. 投送接收目录（自动重建）
  try {
    const rDir = engine.receivedDir || process.env.LFS_DROP_DIR || path.join(engine.dataDir, 'received');
    if (!fs.existsSync(rDir)) {
      fs.mkdirSync(rDir, { recursive: true });
      engine.receivedDir = rDir;
      log('投送接收目录', true, `目录缺失已重建：${rDir}`, true);
    } else {
      log('投送接收目录', writableTest(rDir), rDir);
    }
  } catch (e) {
    log('投送接收目录', false, e.message);
  }

  // 9. 共享路径有效性（提醒，不自动修复）
  try {
    const stale = engine
      .listShares()
      .filter((s) => s.enabled && !fs.existsSync(s.path))
      .map((s) => s.name);
    log(
      '共享路径',
      stale.length === 0,
      stale.length ? `有 ${stale.length} 个运行中的共享路径不存在：${stale.join('、')}` : `全部有效（共 ${engine.listShares().length} 个）`
    );
  } catch (e) {
    log('共享路径', false, e.message);
  }

  // 10. 桥接对端连通性（会话文件跨设备依赖它）——优先以桥接 WS 真实状态为准
  try {
    const peers = [];
    if (engine.bridge) {
      for (const [id, info] of engine.bridge.peerInfo) peers.push({ id, ...info });
    }
    if (!peers.length) {
      log('会话桥', true, '当前没有已发现的设备（单机运行，跳过）');
    } else {
      let reachable = 0;
      const offline = [];
      for (const p of peers) {
        // 桥接通道本身在线即视为连通（最真实）
        let up = [...engine.bridge.outbound.entries()].some(([id, ws]) => id === p.id && ws.readyState === 1) ||
          [...engine.bridge.inbound.entries()].some(([ws, info]) => info.deviceId === p.id && ws.readyState === 1);
        if (!up && engine.deviceManager.get(p.id) && !engine.deviceManager.get(p.id).is_online) {
          // 设备已离线：不算异常，属正常状态
          up = 'offline';
        }
        if (up === 'offline') continue;
        if (up === true) {
          reachable++;
          continue;
        }
        // 有心跳但桥未建：再用 HTTP 兜底探测
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2000);
          const r = await fetch(`http://${p.host}:${p.port}/api/self`, { signal: ctrl.signal });
          clearTimeout(t);
          if (r.ok) reachable++;
          else offline.push(p.id);
        } catch (e) {
          offline.push(p.id);
        }
      }
      const total = peers.length - peers.filter((p) => engine.deviceManager.get(p.id) && !engine.deviceManager.get(p.id).is_online).length;
      log(
        '会话桥',
        offline.length === 0,
        offline.length
          ? `${reachable}/${total} 台连通 — 部分设备不可达，跨设备文件将无法打开`
          : total === 0
            ? '对端设备均离线'
            : `${reachable}/${total} 台对端连通`
      );
    }
  } catch (e) {
    log('会话桥', false, e.message);
  }

  // 11. 磁盘空间
  try {
    if (fs.statfs) {
      const st = fs.statfs(engine.dataDir);
      const freeGB = (st.bavail * st.bsize) / 1024 / 1024 / 1024;
      log('磁盘剩余空间', freeGB > 1, `${freeGB.toFixed(1)} GB${freeGB <= 1 ? '（不足 1GB，可能影响文件接收）' : ''}`);
    } else {
      log('磁盘剩余空间', true, '当前 Node 版本不支持查询（跳过）');
    }
  } catch (e) {
    log('磁盘剩余空间', true, '查询失败（跳过）');
  }

  // 12. 日志目录
  try {
    const logDir = path.join(engine.dataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    log('运行日志目录', writableTest(logDir), logDir);
  } catch (e) {
    log('运行日志目录', false, e.message);
  }

  const failed = checks.filter((c) => !c.ok);
  const fixed = checks.filter((c) => c.fixed);
  const summary = failed.length
    ? `${failed.length} 项异常${fixed.length ? `，自动修复 ${fixed.length} 项` : ''}`
    : fixed.length
      ? `全部正常（自动修复 ${fixed.length} 项）`
      : '全部正常';

  if (engine.logger) {
    engine.logger.info('diagnose', `自检完成：${summary}`, { failed: failed.map((f) => f.name) });
  }
  return { ok: failed.length === 0, summary, checks, ts: Date.now() };
}

module.exports = { run };
