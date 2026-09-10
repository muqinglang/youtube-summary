import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/**
 * Verifies a Google ID token locally, against Google's published signing keys.
 *
 * The alternative — handing the token to Google's tokeninfo endpoint — puts a live credential in
 * a URL query string, where it reaches access logs on the way. An ID token is a signed statement
 * that can be checked offline, and it travels here in a request body.
 */

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** Google rotates these slowly; a day is well inside their published lifetime. */
const KEY_TTL_MS = 6 * 60 * 60 * 1000;
/** Tolerates a small clock difference between this machine and Google's. */
const CLOCK_SKEW_S = 120;

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

const jwkSchema = z.object({
  kid: z.string().min(1).max(200),
  kty: z.literal('RSA'),
  n: z.string().min(1).max(2000),
  e: z.string().min(1).max(100),
  alg: z.string().max(20).optional(),
});
const certsSchema = z.object({ keys: z.array(jwkSchema).min(1).max(20) });

const headerSchema = z.object({
  alg: z.literal('RS256'),
  kid: z.string().min(1).max(200),
});
const claimsSchema = z.object({
  iss: z.string().max(200),
  aud: z.string().max(500),
  sub: z.string().min(1).max(255),
  exp: z.number(),
  iat: z.number().optional(),
  email: z.string().email().max(320),
  // Google sends this as a boolean in an ID token, but a string has been seen in the wild.
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional(),
  nonce: z.string().max(500).optional(),
});

export interface GoogleIdentity {
  /** Google's stable, opaque account id. The address can change; this cannot. */
  subject: string;
  email: string;
}

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, 'base64url').toString('utf8');
  return JSON.parse(json) as unknown;
}

export interface GoogleVerifierOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface GoogleVerifier {
  verify(idToken: string, expectedNonce?: string): Promise<GoogleIdentity>;
}

export function createGoogleVerifier(
  clientId: string,
  options: GoogleVerifierOptions = {},
): GoogleVerifier {
  const fetcher = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function keyFor(kid: string): Promise<KeyObject> {
    // One refresh on a miss, so a rotated key is picked up without waiting for the TTL, but a
    // token naming a key that does not exist cannot make us hammer Google.
    if (!keys.has(kid) || now() - fetchedAt > KEY_TTL_MS) {
      const response = await fetcher(CERTS_URL);
      if (!response.ok)
        throw new GoogleAuthError(`无法获取 Google 签名公钥（${response.status}）。`);
      const parsed = certsSchema.safeParse(await response.json());
      if (!parsed.success) throw new GoogleAuthError('Google 返回的公钥格式无法识别。');
      keys = new Map(
        parsed.data.keys.map((jwk) => [
          jwk.kid,
          createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }),
        ]),
      );
      fetchedAt = now();
    }
    const key = keys.get(kid);
    if (!key) throw new GoogleAuthError('登录凭证的签名密钥不在 Google 的公钥列表中。');
    return key;
  }

  return {
    async verify(idToken, expectedNonce) {
      const parts = idToken.split('.');
      if (parts.length !== 3) throw new GoogleAuthError('登录凭证格式不正确。');
      const [rawHeader, rawClaims, rawSignature] = parts as [string, string, string];

      let header: z.infer<typeof headerSchema>;
      let claims: z.infer<typeof claimsSchema>;
      try {
        header = headerSchema.parse(decodeSegment(rawHeader));
        claims = claimsSchema.parse(decodeSegment(rawClaims));
      } catch {
        // Includes an unexpected `alg`: only RS256 is accepted, so "alg":"none" never gets here.
        throw new GoogleAuthError('登录凭证无法解析，或使用了不支持的签名算法。');
      }

      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${rawHeader}.${rawClaims}`);
      verifier.end();
      if (!verifier.verify(await keyFor(header.kid), Buffer.from(rawSignature, 'base64url')))
        throw new GoogleAuthError('登录凭证签名校验失败。');

      if (!ISSUERS.has(claims.iss)) throw new GoogleAuthError('登录凭证不是 Google 签发的。');
      // Without this check any Google application's token would be accepted here, which would
      // let a third-party app sign its users into this one.
      if (claims.aud !== clientId) throw new GoogleAuthError('登录凭证不是为本服务签发的。');
      if (claims.exp * 1000 + CLOCK_SKEW_S * 1000 < now())
        throw new GoogleAuthError('登录凭证已过期，请重新登录。');
      if (claims.email_verified === false || claims.email_verified === 'false')
        throw new GoogleAuthError('该 Google 账号的邮箱尚未验证。');
      // Binds the token to the request that asked for it, so one captured elsewhere cannot be
      // replayed here.
      if (expectedNonce !== undefined && claims.nonce !== expectedNonce)
        throw new GoogleAuthError('登录请求已失效，请重新登录。');

      return { subject: claims.sub, email: claims.email.toLowerCase() };
    },
  };
}
