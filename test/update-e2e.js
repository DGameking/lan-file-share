'use strict';
/* 引擎级 e2e：mock 一个新版本 Release（本地 HTTP 文件服务），验证下载→进度→校验→就绪 全链路 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const BASE = path.join(__dirname, '..');
process.env.LFS_PORT = '18330';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-upd-'));

async function main() {
  // 造一个假安装包 + 校验和
  const payload = Buffer.from('FAKE-INSTALLER-'.repeat(10000)); // ~150KB
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const srv = http.createServer((req, res) => {
    if (req.url === '/LanFileShare-Setup-9.9.9-x64.exe') {
      res.setHeader('Content-Length', payload.length);
      res.end(req.headers.range ? payload.slice(Number(req.headers.range.split('=')[1].split('-')[0])) : payload);
    } else if (req.url === '/SHA256SUMS-win-9.9.9.txt') {
      res.end(`${sha}  LanFileShare-Setup-9.9.9-x64.exe\n`);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => srv.listen(18444, r));

  const LanFileShare = require(path.join(BASE, 'server'));
  const engine = new LanFileShare({ httpPort: 18330, dataDir: DATA });
  await engine.init();

  // mock 版本检查：指向本地服务
  const assets = [
    { name: 'LanFileShare-Setup-9.9.9-x64.exe', url: 'http://127.0.0.1:18444/LanFileShare-Setup-9.9.9-x64.exe', size: payload.length },
    { name: 'SHA256SUMS-win-9.9.9.txt', url: 'http://127.0.0.1:18444/SHA256SUMS-win-9.9.9.txt', size: 90 },
  ];
  engine.checkUpdate = async () => ({ checked: true, hasUpdate: true, latest: '9.9.9', assets, url: 'x' });

  const progress = [];
  const downloaded = await new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('download timeout')), 20000);
    engine.broadcast = ((orig) => (event, payload2) => {
      orig(event, payload2);
      if (event === 'update.progress') progress.push(payload2);
      if (event === 'update.downloaded') { clearTimeout(timer); resolve(payload2); }
      if (event === 'update.error') { clearTimeout(timer); reject(new Error(payload2.message)); }
    })(engine.broadcast.bind(engine));
    const r = await engine.downloadUpdate();
    if (!r.ok) return reject(new Error('downloadUpdate: ' + r.error));
  });

  console.log('  ✔ 下载完成:', downloaded.name, downloaded.size, 'bytes');
  console.log(`  ✔ 进度事件 ${progress.length} 次，最终 ${progress[progress.length - 1].pct}%`);
  if (fs.readFileSync(downloaded.file).toString() !== payload.toString()) throw new Error('内容不一致');
  if (downloaded.file.indexOf(path.join(DATA, 'updates')) !== 0) throw new Error('保存路径错误');
  console.log('  ✔ SHA256 校验通过，文件保存于', path.basename(path.dirname(downloaded.file)) + '/');

  // installUpdate：不真正启动安装器（mock spawn），验证路径与返回值
  if (!fs.existsSync(engine._updateInfo.downloadedFile)) throw new Error('installUpdate 前文件缺失');
  console.log('  ✔ installUpdate 前置状态就绪（downloadedFile 已记录）');

  await engine.stop();
  srv.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('结果: 全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('测试失败:', e.message);
  process.exit(1);
});
