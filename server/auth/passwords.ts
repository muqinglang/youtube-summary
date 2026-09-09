import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// 128 * N * r bytes of memory, so this pair must stay in step with maxmem below.
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAX_MEM = 128 * N * R * 2;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      KEY_LENGTH,
      { N, r: R, p: P, maxmem: MAX_MEM },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** `scrypt$N$r$p$salt$key`, so the cost parameters travel with the hash and can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(rawSalt!, 'base64url');
  const expected = Buffer.from(rawKey!, 'base64url');
  if (!salt.length || !expected.length) return false;
  const actual = await new Promise<Buffer | undefined>((resolve) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      expected.length,
      { N: n, r, p, maxmem: 128 * n * r * 2 },
      (error, key) => resolve(error ? undefined : key),
    );
  });
  // Comparing lengths first keeps timingSafeEqual from throwing on a malformed record.
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
