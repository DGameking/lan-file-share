'use strict';
/* 分块断点续传测试：2 块上传 → finish 合并 → 校验内容 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.cwd();
const NODE = process.execPath;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = path.join(BASE, 'tmp-t2', 'chunk');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const child = execFile(NODE, [path.join(BASE, 'server', 'index.js')], {
    env: { ...process.env, LFS_PORT: '18202', LFS_DATA_DIR: dataDir },
  });
  child.stderr.on('data', (d) => process.stdout.write('[err] ' + d));
  await wait(2500);

  const uploadId = 'utest123';
  const chunkA = Buffer.alloc(1024 * 100, 0x61); // 'a'
  const chunkB = Buffer.alloc(1024 * 50, 0x62); // 'b'

  let r = await fetch(`http://127.0.0.1:18202/api/drop/chunk?uploadId=${uploadId}&index=0`, { method: 'POST', body: chunkA });
  console.log('chunk0:', JSON.stringify(await r.json()));
  r = await fetch(`http://127.0.0.1:18202/api/drop/chunk?uploadId=${uploadId}&index=1`, { method: 'POST', body: chunkB });
  console.log('chunk1:', JSON.stringify(await r.json()));

  // 乱序补一块 index=3 应被忽略（finish 校验 total）
  r = await fetch(`http://127.0.0.1:18202/api/drop/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, name: '大文件.bin', total: 3, size: chunkA.length + chunkB.length + 10, from: '测试机' }),
  });
  console.log('finish(缺块):', r.status, JSON.stringify(await r.json()));

  r = await fetch(`http://127.0.0.1:18202/api/drop/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, name: '大文件.bin', total: 2, size: chunkA.length + chunkB.length, from: '测试机' }),
  });
  console.log('finish:', JSON.stringify(await r.json()));

  const recvDir = path.join(dataDir, 'received');
  const files = fs.readdirSync(recvDir).filter((n) => !n.startsWith('.'));
  console.log('接收目录:', files.join(', '));
  const buf = fs.readFileSync(path.join(recvDir, files[0]));
  const ok = buf.length === chunkA.length + chunkB.length && buf[0] === 0x61 && buf[buf.length - 1] === 0x62;
  console.log(ok ? '✔ 分块合并校验通过' : '✘ 内容校验失败');

  child.kill();
  await wait(500);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('测试失败:', e); process.exit(1); });
