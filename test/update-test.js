'use strict';
/* update-checker 单测：版本比较逻辑 */
const { compareSemver } = require('../server/update-checker');

const cases = [
  ['1.8.0', '1.7.0', 1],
  ['1.7.0', '1.7.0', 0],
  ['1.6.9', '1.7.0', -1],
  ['v2.0.0', '1.9.9', 1],
  ['1.10.0', '1.9.0', 1],
  ['1.7.0-beta', '1.7.0', 0],
  ['1.7.1', '1.7.0', 1],
];

let fail = 0;
for (const [a, b, expect] of cases) {
  const got = compareSemver(a, b);
  if (got !== expect) {
    console.error(`  ✘ compareSemver(${a}, ${b}) = ${got}，期望 ${expect}`);
    fail++;
  }
}
console.log(fail ? `结果: ${cases.length - fail} 通过, ${fail} 失败` : `结果: ${cases.length} 全部通过`);
process.exit(fail ? 1 : 0);
