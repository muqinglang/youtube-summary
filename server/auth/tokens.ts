import { createHmac, timingSafeEqual } from 'node:crypto';

interface Claims {
  uid: string;
  exp: number;
}

/**
 * An opaque HMAC-signed session token rather than a JWT: there is exactly one issuer and one
 * verifier, so a fixed algorithm avoids the whole class of JWT header-confusion mistakes.
 */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueToken(userId: string, secret: string, ttlMs: number): string {
  const claims: Claims = { uid: userId, exp: Date.now() + ttlMs };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function readToken(token: string, secret: string, now = Date.now()): string | undefined {
  const separator = token.indexOf('.');
  if (separator <= 0) return undefined;
  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = Buffer.from(sign(payload, secret), 'base64url');
  if (signature.length !== expected.length) return undefined;
  if (!timingSafeEqual(signature, expected)) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!claims || typeof claims !== 'object') return undefined;
  const { uid, exp } = claims as Partial<Claims>;
  if (typeof uid !== 'string' || !uid) return undefined;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) return undefined;
  return uid;
}
