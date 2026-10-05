import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

// Versioned parameters keep existing accounts readable when the work factor changes.
const N = 32768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const OPTIONS = { N, r: R, p: P, maxmem: 64 * 1024 * 1024 };
const PREFIX = `$scrypt$v1$${N}$${R}$${P}$`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, OPTIONS, (err, key) => err ? reject(err) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${PREFIX}${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function isLegacyPasswordHash(hash: string): boolean {
  return /^\$2[aby]\$/.test(hash);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Never silently rehash legacy bcrypt on login: historical >72-byte passwords
  // have no recoverable suffix, and choosing the supplied suffix could lock out
  // the real password. An explicit password change upgrades the whole input.
  if (isLegacyPasswordHash(hash)) return bcrypt.compare(password, hash);
  if (!hash.startsWith(PREFIX)) return false;
  const [saltText, keyText, extra] = hash.slice(PREFIX.length).split('$');
  if (extra !== undefined || !/^[A-Za-z0-9_-]{22}$/.test(saltText ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(keyText ?? '')) return false;
  const expected = Buffer.from(keyText, 'base64url');
  const actual = await derive(password, Buffer.from(saltText, 'base64url'));
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

const dummySalt = Buffer.from('0123456789abcdef');
export const DUMMY_PASSWORD_HASH = `${PREFIX}${dummySalt.toString('base64url')}$${scryptSync('tsmusicbot-nonexistent-user-placeholder', dummySalt, KEY_LENGTH, OPTIONS).toString('base64url')}`;
