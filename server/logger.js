'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 运行日志（区别于 DB 里的业务事件日志）：
 * - 按天写文件 dataDir/logs/lfs-YYYY-MM-DD.log，自动清理 7 天前的旧日志
 * - 内存环形缓冲（默认 800 行）供管理控制台实时查看，无需读文件
 * - 引擎各模块在关键路径（启动/发现/桥接/上传/下载/错误）调用，用于远程排障与自诊断
 */
class Logger {
  constructor(logDir, { keepDays = 7, bufferSize = 800 } = {}) {
    this.logDir = logDir;
    this.keepDays = keepDays;
    this.bufferSize = bufferSize;
    this.buffer = [];
    this._day = '';
    this._stream = null;
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch (e) {}
    this._cleanOld();
    // 每小时尝试清理一次旧日志
    this._cleanTimer = setInterval(() => this._cleanOld(), 3600 * 1000);
    if (this._cleanTimer.unref) this._cleanTimer.unref();
  }

  _cleanOld() {
    try {
      const cutoff = Date.now() - this.keepDays * 24 * 3600 * 1000;
      for (const name of fs.readdirSync(this.logDir)) {
        if (!/^lfs-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
        const p = path.join(this.logDir, name);
        if (fs.statSync(p).mtimeMs < cutoff) {
          try { fs.unlinkSync(p); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  _streamFor(day) {
    if (this._day === day && this._stream) return this._stream;
    try {
      if (this._stream) { try { this._stream.end(); } catch (e) {} }
      this._day = day;
      this._stream = fs.createWriteStream(path.join(this.logDir, `lfs-${day}.log`), { flags: 'a' });
      this._stream.on('error', () => { this._stream = null; });
      return this._stream;
    } catch (e) {
      this._stream = null;
      return null;
    }
  }

  /** level: info | warn | error | debug；scope: 模块名 */
  log(level, scope, message, detail) {
    const now = new Date();
    const ts = now.toISOString();
    const day = ts.slice(0, 10);
    let line = `[${ts}] [${level}] [${scope}] ${message}`;
    if (detail !== undefined) {
      try {
        line += ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail));
      } catch (e) {}
    }
    if (line.length > 4000) line = line.slice(0, 4000) + '…';

    this.buffer.push(line);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();

    const stream = this._streamFor(day);
    if (stream) { try { stream.write(line + '\n'); } catch (e) {} }

    if (level === 'error' || level === 'warn') {
      // 错误同步打到控制台，便于无界面场景（NAS ssh）排障
      try { console.error(line); } catch (e) {}
    }
  }

  info(scope, message, detail) { this.log('info', scope, message, detail); }
  warn(scope, message, detail) { this.log('warn', scope, message, detail); }
  error(scope, message, detail) { this.log('error', scope, message, detail); }
  debug(scope, message, detail) { this.log('debug', scope, message, detail); }

  /** 最近 n 行（默认全部缓冲） */
  recent(n = 800) {
    const arr = this.buffer;
    return n >= arr.length ? [...arr] : arr.slice(arr.length - n);
  }

  /** 日志目录内的文件清单（供前端下载/查看） */
  files() {
    try {
      return fs
        .readdirSync(this.logDir)
        .filter((n) => /^lfs-\d{4}-\d{2}-\d{2}\.log$/.test(n))
        .sort()
        .reverse()
        .map((n) => {
          const p = path.join(this.logDir, n);
          return { name: n, size: fs.statSync(p).size, path: p };
        });
    } catch (e) {
      return [];
    }
  }

  stop() {
    clearInterval(this._cleanTimer);
    try { if (this._stream) this._stream.end(); } catch (e) {}
  }
}

module.exports = Logger;
