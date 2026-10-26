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
  };
}

module.exports = { compareSemver, checkLatest, REPO };
