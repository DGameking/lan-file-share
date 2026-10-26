'use strict';

function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n))) return null;
  return ((p[0] << 24) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

/** 判断 IP 是否落在 CIDR / 单 IP / 子网掩码 规则内 */
function ipInCidr(ip, rule) {
  if (!rule) return false;
  rule = String(rule).trim();
  if (!rule.includes('/')) return ip === rule;
  const [base, maskStr] = rule.split('/');
  let mask;
  if (maskStr.includes('.')) {
    mask = ipToInt(maskStr);
  } else {
    const bits = parseInt(maskStr, 10);
    mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  }
  const ipI = ipToInt(ip);
  const baseI = ipToInt(base);
  if (ipI === null || baseI === null) return false;
  return (ipI & mask) === (baseI & mask);
}

module.exports = { ipInCidr, ipToInt };
