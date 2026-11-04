'use strict';

/* WebDAV 磁盘挂载模块（Windows：net use；WebClient 自动修复需一次 UAC） */
const { execFile } = require('child_process');

function runCmd(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      if (err) reject(new Error(out.trim() || err.message));
      else resolve(out);
    });
  });
}

/** 提权执行 PowerShell 命令（触发一次 UAC 授权弹窗） */
function runElevated(psCommand) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${psCommand.replace(/'/g, "''")}'`],
      { windowsHide: true, timeout: 120000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim()));
        else resolve(String(stdout || ''));
      }
    );
  });
}

async function mountWebdav({ url, password }) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'unsupported', hint: process.platform === 'darwin' ? 'macOS：访达 → 前往 → 连接服务器（⌘K）输入该地址' : 'Linux：文件管理器「连接到服务器」输入该地址' };
  }
  if (!/^http:\/\//.test(String(url || ''))) {
    return { ok: false, error: 'bad_url', hint: '仅支持 http 地址挂载（HTTPS 自签证书会被 Windows 拒绝）' };
  }

  // 1. 确认 WebClient 服务在运行；未运行或 BasicAuthLevel 不为 2 时提权修复（一次 UAC）
  let svc = '';
  try { svc = await runCmd('sc', ['query', 'WebClient'], 15000); } catch (e) { svc = String(e.message || ''); }
  const running = /RUNNING/.test(svc);
  let authLevel = '';
  try { authLevel = await runCmd('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters', '/v', 'BasicAuthLevel'], 15000); } catch (e) {}
  const needFix = !running || !/0x2/.test(authLevel);
  if (needFix) {
    try {
      await runElevated(
        'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\WebClient\\Parameters" /v BasicAuthLevel /t REG_DWORD /d 2 /f; ' +
        'sc config WebClient start= demand; ' +
        'net start WebClient'
      );
    } catch (e) {
      return { ok: false, error: 'elevation_denied', hint: '需要管理员授权启用 WebDAV 客户端（WebClient 服务）。可手动执行：services.msc 启动 WebClient，并将注册表 WebClient\\Parameters\\BasicAuthLevel 设为 2' };
    }
    try { svc = await runCmd('sc', ['query', 'WebClient'], 15000); } catch (e) {}
    if (!/RUNNING/.test(svc)) {
      return { ok: false, error: 'webclient_not_running', hint: 'WebClient 服务未能启动，请手动在服务中启动 WebClient 后重试' };
    }
  }

  // 2. net use 挂载（* 让 Windows 自动挑空闲盘符）
  const args = ['use', '*', url];
  if (password) args.push('/user:lanfileshare', String(password));
  args.push('/persistent:yes');
  let out;
  try {
    out = await runCmd('net', args, 60000);
  } catch (e) {
    const msg = String(e.message || '');
    if (/1326|密码|password/i.test(msg)) return { ok: false, error: 'auth_failed', hint: '密码错误：该共享设置了访问密码，请输入正确密码后重试' };
    if (/1223|85|已在使用|local name/i.test(msg)) return { ok: false, error: 'already_mapped', hint: '该共享已被挂载，或盘符被占用' };
    return { ok: false, error: 'net_use_failed', hint: msg.slice(0, 300) };
  }
  const m = out.match(/([A-Z]:)/);
  const letter = m ? m[1] : null;
  return { ok: true, data: { letter } };
}

module.exports = { mountWebdav, runCmd };
