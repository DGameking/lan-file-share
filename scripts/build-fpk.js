'use strict';

/**
 * 飞牛 fnOS fpk 打包准备脚本：
 * 1. 同步服务端源码到 fnos-app/app/target
 * 2. 安装生产依赖（node_modules 仅保留运行时）
 * 3. 提示执行 fnpack build
 *
 * 用法：node scripts/build-fpk.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'fnos-app', 'app', 'target');
const SRC_DIRS = ['server', 'database', 'discovery', 'security', 'shared'];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 1. 重建 target
fs.rmSync(TARGET, { recursive: true, force: true });
for (const dir of SRC_DIRS) copyDir(path.join(ROOT, dir), path.join(TARGET, dir));

// 2. 仅生产依赖的 package.json
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(TARGET, 'package.json'),
  JSON.stringify(
    { name: 'lan-file-share-nas', version: pkg.version, private: true, scripts: { start: 'node server/index.js' }, dependencies: pkg.dependencies },
    null,
    2
  )
);

// 3. 安装生产依赖
console.log('[fpk] 安装生产依赖…');
execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: TARGET, stdio: 'inherit' });

console.log('[fpk] target 就绪。下一步：cd fnos-app && ../tools/fnpack.exe build');
