'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

/** 生成全局唯一设备 ID */
function generateDeviceId() {
  return 'uuid-' + uuidv4();
}

/** SHA-256 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** 生成 RSA-2048 密钥对（PEM） */
function generateRSAKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

/** 公钥指纹（SHA-256 前 16 位 hex） */
function fingerprint(publicKeyPem) {
  return sha256(publicKeyPem).slice(0, 16);
}

/** 生成 32 字节主密钥（base64） */
function generateMasterKey() {
  return crypto.randomBytes(32).toString('base64');
}

function _keyFromMaster(masterKeyB64) {
  return Buffer.from(masterKeyB64, 'base64');
}

/** AES-256-CBC 加密，返回 iv:data（base64） */
function aesEncrypt(plaintext, masterKeyB64) {
  const key = _keyFromMaster(masterKeyB64);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(String(plaintext), 'utf8', 'base64');
  enc += cipher.final('base64');
  return iv.toString('base64') + ':' + enc;
}

/** AES-256-CBC 解密 */
function aesDecrypt(payload, masterKeyB64) {
  if (!payload || !payload.includes(':')) return null;
  const key = _keyFromMaster(masterKeyB64);
  const [ivB64, dataB64] = payload.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let dec = decipher.update(dataB64, 'base64', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

/** 密码哈希（用于共享密码校验，避免明文） */
function hashPassword(pwd) {
  return sha256('lanfs::' + pwd);
}

/** 6 位邀请码 */
function randomInviteCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = {
  generateDeviceId,
  sha256,
  generateRSAKeyPair,
  fingerprint,
  generateMasterKey,
  aesEncrypt,
  aesDecrypt,
  hashPassword,
  randomInviteCode,
};
