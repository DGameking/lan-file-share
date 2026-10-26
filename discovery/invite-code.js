'use strict';

const crypto = require('../security/crypto');

/** 生成 6 位邀请码并写入 DB */
function createInvite(db, deviceId, ttlMs = 10 * 60 * 1000) {
  db.pruneInvites();
  let code;
  do {
    code = crypto.randomInviteCode();
  } while (db.getInvite(code));
  db.addInvite(code, deviceId, Date.now() + ttlMs);
  return code;
}

/** 校验邀请码，返回邀请方 deviceId */
function resolveInvite(db, code) {
  const inv = db.getInvite(code);
  if (!inv) return { ok: false, reason: 'not_found' };
  if (inv.expire_at < Date.now()) return { ok: false, reason: 'expired' };
  if (inv.used) return { ok: false, reason: 'used' };
  return { ok: true, code, deviceId: inv.device_id };
}

module.exports = { createInvite, resolveInvite };
