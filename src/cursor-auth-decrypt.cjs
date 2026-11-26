const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CURSOR_SAFE_PREFIX = 'cursor-safe-storage:v1:';
const SALT = 'saltysalt';
const MAC_ITERATIONS = 1003;
const LINUX_ITERATIONS = 1;
const KEY_LEN = 16;
const IV = Buffer.alloc(16, 0x20);
const WIN_VERSION = 'v10';
const WIN_NONCE_LEN = 12;
const WIN_TAG_LEN = 16;
const WIN_KEY_LEN = 32;
const DPAPI_PREFIX = 'DPAPI';
const LINUX_BASIC_PASSWORD = 'peanuts';

function cursorLocalStatePath(stateDb) {
  return path.join(path.dirname(path.dirname(path.dirname(path.resolve(stateDb)))), 'Local State');
}

function unwrapStoredValue(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
  } catch { /* plain string in ItemTable */ }
  return String(raw).replace(/^"|"$/g, '');
}

function decryptCursorAuthValue(stored, stateDb) {
  const value = unwrapStoredValue(stored);
  if (!value) return '';
  if (!value.startsWith(CURSOR_SAFE_PREFIX)) {
    return value;
  }
  const payload = value.slice(CURSOR_SAFE_PREFIX.length);
  let blob;
  try {
    blob = Buffer.from(payload, 'base64');
  } catch {
    return '';
  }
  if (!blob.length) return '';

  try {
    if (process.platform === 'win32') {
      const localState = cursorLocalStatePath(stateDb);
      const key32 = loadWindowsOsCryptKey(localState);
      return windowsAesGcmDecrypt(blob, key32);
    }
    if (process.platform === 'darwin') {
      const password = macReadMasterPassword();
      if (!password) return '';
      return aesDecrypt(blob, password, MAC_ITERATIONS);
    }
    return linuxDecrypt(blob);
  } catch {
    return '';
  }
}

function loadWindowsOsCryptKey(localStatePath) {
  const parsed = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encKeyB64 = parsed?.os_crypt?.encrypted_key;
  if (!encKeyB64) {
    throw new Error('Cursor Local State has no os_crypt.encrypted_key');
  }
  const encKey = Buffer.from(encKeyB64, 'base64');
  if (encKey.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) {
    throw new Error('Unsupported Cursor OSCrypt key format');
  }
  const key = windowsUnprotectBuffer(encKey.subarray(DPAPI_PREFIX.length));
  if (key.length !== WIN_KEY_LEN) {
    throw new Error('Cursor OSCrypt key has unexpected length');
  }
  return key;
}

function runPowerShell(script) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (r.status !== 0) return '';
  return (r.stdout || '').replace(/\r?\n/g, '').trim();
}

function windowsUnprotectBuffer(blob) {
  const b64 = blob.toString('base64');
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    '$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Convert]::ToBase64String($dec)'
  ].join(';');
  const out = runPowerShell(script);
  return out ? Buffer.from(out, 'base64') : Buffer.alloc(0);
}

function windowsAesGcmDecrypt(blob, key32) {
  const nonce = blob.subarray(WIN_VERSION.length, WIN_VERSION.length + WIN_NONCE_LEN);
  const tag = blob.subarray(blob.length - WIN_TAG_LEN);
  const ciphertext = blob.subarray(WIN_VERSION.length + WIN_NONCE_LEN, blob.length - WIN_TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function macReadMasterPassword() {
  const r = spawnSync('security', ['find-generic-password', '-s', 'Cursor Safe Storage', '-w'], {
    encoding: 'utf8'
  });
  if (r.status !== 0) return '';
  return (r.stdout || '').replace(/\n$/, '');
}

function deriveKey(masterPassword, iterations) {
  return crypto.pbkdf2Sync(masterPassword, SALT, iterations, KEY_LEN, 'sha1');
}

function aesDecrypt(blob, masterPassword, iterations) {
  const key = deriveKey(masterPassword, iterations);
  const body = blob.subarray(3);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function linuxSecretToolLookup(attrs) {
  const r = spawnSync('secret-tool', ['lookup', ...attrs], { encoding: 'utf8' });
  if (r.status === 0 && (r.stdout || '').length > 0) {
    return r.stdout.replace(/\n$/, '');
  }
  return '';
}

function linuxDecrypt(blob) {
  const version = blob.subarray(0, 3).toString('latin1');
  if (version === 'v11') {
    const password = linuxSecretToolLookup([
      'xdg:schema', 'chrome_libsecret_os_crypt_password_v2',
      'application', 'cursor'
    ]);
    if (password) return aesDecrypt(blob, password, LINUX_ITERATIONS);
  }
  return aesDecrypt(blob, LINUX_BASIC_PASSWORD, LINUX_ITERATIONS);
}

function looksLikeJwt(token) {
  return /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(token);
}

module.exports = {
  CURSOR_SAFE_PREFIX,
  cursorLocalStatePath,
  decryptCursorAuthValue,
  looksLikeJwt,
  unwrapStoredValue
};