'use strict';

const REPO = 'DGameking/lan-file-share';

/** 语义化版本比较：a > b 返回 1，相等 0，小于 -1（忽略非数字后缀） */
function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 查询 GitHub 最新 Release（8 秒超时，失败抛错由调用方兜底） */
async function checkLatest({ current }) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'LanFileShare', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('github_http_' + res.status);
  const j = await res.json();
  const latest = String(j.tag_name || '').replace(/^v/, '');
  return {
    latest,
    current: current,
    hasUpdate: compareSemver(latest, current) > 0,
    prerelease: !!j.prerelease || !!j.draft,
    url: j.html_url || `https://github.com/${REPO}/releases`,
    notes: String(j.body || '').slice(0, 2000),
    publishedAt: j.published_at || null,
    assets: (j.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  };
}

/** 按发布命名规则匹配当前平台/架构的安装包资产 */
function assetNameFor(platform, arch, version) {
  if (platform === 'win32') return `LanFileShare-Setup-${version}-${arch === 'arm64' ? 'arm64' : 'x64'}.exe`;
  if (platform === 'darwin') return `LanFileShare-${version}-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  if (platform === 'linux') return `LanFileShare-${version}-${arch === 'arm64' ? 'arm64' : 'x86_64'}.AppImage`;
  return null;
}

/** 从资产列表中找到当前平台的安装包与对应校验和文件 */
function matchAsset(assets, { platform, arch, version }) {
  const name = assetNameFor(platform, arch, version);
  if (!name) return null;
  const installer = (assets || []).find((a) => a.name === name);
  if (!installer) return null;
  let checksumAsset = null;
  if (platform === 'win32') {
    checksumAsset = (assets || []).find((a) => a.name === `SHA256SUMS-win-${version}.txt`) || null;
  }
  return { installer, checksumAsset };
}

/** 从 SHA256SUMS 文本中解析指定文件名的哈希 */
function parseChecksum(text, fileName) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return null;
}

module.exports = { compareSemver, checkLatest, matchAsset, parseChecksum, assetNameFor, REPO };
