'use strict';
/**
 * 生成/合并 Release 校验文件 SHA256SUMS.txt：
 *   node scripts/gen-checksums.js <file1> [file2 ...]
 * 行格式：`<sha256>  <文件名>`（sha256sum 兼容）。
 * 与 dist/SHA256SUMS.txt 中已有条目按文件名合并（本地新算的优先），
 * 供发版时随 `gh release upload --clobber` 上传，兑现 README 承诺。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/gen-checksums.js <file1> [file2 ...]');
  process.exit(1);
}
const outPath = path.join('dist', 'SHA256SUMS.txt');
const entries = new Map();
try {
  for (const line of fs.readFileSync(outPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m) entries.set(m[2].trim(), m[1].toLowerCase());
  }
} catch (e) {}

for (const f of files) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) {
    console.warn('[skip] not found:', p);
    continue;
  }
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  entries.set(path.basename(p), h.digest('hex'));
  console.log('[sum]', path.basename(p));
}

const lines = [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([n, s]) => `${s}  ${n}`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`[done] ${outPath} 共 ${lines.length} 条`);
