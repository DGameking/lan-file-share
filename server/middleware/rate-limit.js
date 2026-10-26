'use strict';

const stream = require('stream');

/**
 * 按字节速率限制的数据流（用于下载限速）。
 * bytesPerSec <= 0 时退化为直通流。
 */
function createThrottle(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return new stream.PassThrough();
  const ts = new stream.Transform({
    transform(chunk, enc, cb) {
      this.push(chunk);
      const delay = (chunk.length / bytesPerSec) * 1000;
      if (delay > 0) setTimeout(cb, delay);
      else cb();
    },
  });
  return ts;
}

module.exports = { createThrottle };
