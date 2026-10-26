'use strict';

const path = require('path');
const fs = require('fs');

/** 生成短随机 ID（UUID 前 8 位风格） */
function shortId() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

/** 安全拼接共享根路径与相对路径，防止目录穿越 */
function safeJoin(root, relative) {
  const resolved = path.resolve(root, '.' + path.sep, relative || '');
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    return null; // 越界
  }
  return resolved;
}

/** 判断是否为隐藏文件 */
function isHidden(filepath) {
  const base = path.basename(filepath);
  return base.startsWith('.');
}

/** 格式化文件大小 */
function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    bytes /= 1024;
    i++;
  } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[i];
}

/** 格式化时间 */
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 判断 MIME 类型大类，用于预览与下载 */
function getCategory(ext) {
  ext = (ext || '').toLowerCase().replace(/^\./, '');
  const map = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'],
    video: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
    pdf: ['pdf'],
    text: ['txt', 'md', 'json', 'xml', 'log', 'csv', 'yml', 'yaml', 'ini', 'conf', 'toml'],
    code: ['js', 'ts', 'jsx', 'tsx', 'vue', 'py', 'java', 'go', 'c', 'cpp', 'h', 'hpp', 'rs', 'rb', 'php', 'sh', 'html', 'css', 'sql', 'kt', 'swift'],
    office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'],
  };
  for (const cat of Object.keys(map)) {
    if (map[cat].includes(ext)) return cat;
  }
  return 'other';
}

/** 递归计算目录大小与文件数 */
function dirStats(root) {
  let size = 0;
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const st = fs.statSync(full);
          size += st.size;
          count++;
        }
      } catch (e) {
        /* ignore */
      }
    }
  };
  walk(root);
  return { size, count };
}

/** 防抖 */
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

module.exports = {
  shortId,
  safeJoin,
  isHidden,
  formatSize,
  formatTime,
  getCategory,
  dirStats,
  debounce,
};
