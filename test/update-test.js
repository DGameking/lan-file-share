'use strict';
/* update-checker 单测：版本比较 + 资产匹配 + 校验和解析 */
const { compareSemver, matchAsset, parseChecksum } = require('../server/update-checker');

let fail = 0;
function check(name, got, expect) {
  if (got !== expect) {
    console.error(`  ✘ ${name} = ${JSON.stringify(got)}，期望 ${JSON.stringify(expect)}`);
    fail++;
  }
}

// 版本比较
const cases = [
  ['1.8.0', '1.7.0', 1],
  ['1.7.0', '1.7.0', 0],
  ['1.6.9', '1.7.0', -1],
  ['v2.0.0', '1.9.9', 1],
  ['1.10.0', '1.9.0', 1],
  ['1.7.0-beta', '1.7.0', 0],
  ['1.7.1', '1.7.0', 1],
];
for (const [a, b, expect] of cases) check(`compareSemver(${a}, ${b})`, compareSemver(a, b), expect);

// 资产匹配
const assets = [
  { name: 'LanFileShare-Setup-1.9.0-x64.exe', url: 'u1', size: 100 },
  { name: 'LanFileShare-Setup-1.9.0-arm64.exe', url: 'u2', size: 90 },
  { name: 'SHA256SUMS-win-1.9.0.txt', url: 'u3', size: 5 },
  { name: 'LanFileShare-mac-1.9.0-arm64.dmg', url: 'u4', size: 80 },
  { name: 'LanFileShare-linux-1.9.0-x86_64.AppImage', url: 'u5', size: 85 },
];
const m1 = matchAsset(assets, { platform: 'win32', arch: 'x64', version: '1.9.0' });
const m2 = matchAsset(assets, { platform: 'win32', arch: 'arm64', version: '1.9.0' });
const m3 = matchAsset(assets, { platform: 'darwin', arch: 'arm64', version: '1.9.0' });
const m4 = matchAsset(assets, { platform: 'linux', arch: 'x64', version: '1.9.0' });
if (!m1 || m1.installer.url !== 'u1' || !m1.checksumAsset) { console.error('  ✘ win x64 匹配失败'); fail++; }
if (!m2 || m2.installer.url !== 'u2') { console.error('  ✘ win arm64 匹配失败'); fail++; }
if (!m3 || m3.installer.url !== 'u4') { console.error('  ✘ mac arm64 匹配失败'); fail++; }
if (!m4 || m4.installer.url !== 'u5' || m4.checksumAsset) { console.error('  ✘ linux 匹配失败'); fail++; }

// 校验和解析
const sha = parseChecksum(
  'deadbeef  other-file\n' + '5f'.repeat(32) + '  LanFileShare-Setup-1.9.0-x64.exe',
  'LanFileShare-Setup-1.9.0-x64.exe'
);
check('parseChecksum', sha, '5f'.repeat(32));

console.log(fail ? `结果: 有 ${fail} 项失败` : '结果: 全部通过');
process.exit(fail ? 1 : 0);
