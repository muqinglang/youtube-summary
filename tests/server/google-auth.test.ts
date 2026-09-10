import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleVerifier, GoogleAuthError } from '../../server/auth/google';

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const KID = 'test-key-1';
const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signWith: KeyObject = privateKey,
): string {
  const head = b64({ alg: 'RS256', kid: KID, typ: 'JWT', ...header });
  const body = b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '110248495921238986420',
    email: 'Viewer@Example.com',
    email_verified: true,
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000),
    ...claims,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${head}.${body}`);
  signer.end();
  return `${head}.${body}.${signer.sign(signWith).toString('base64url')}`;
}

function certs() {
  const jwk = publicKey.export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] };
}

function verifier(fetchImpl?: typeof globalThis.fetch) {
  const fetcher =
    fetchImpl ?? (vi.fn(async () => Response.json(certs())) as unknown as typeof globalThis.fetch);
  return { verifier: createGoogleVerifier(CLIENT_ID, { fetch: fetcher, now: () => NOW }), fetcher };
}

describe('google identity', () => {
  it('accepts a token this service was actually issued, and normalises the address', async () => {
    const identity = await verifier().verifier.verify(token());
    expect(identity).toEqual({ subject: '110248495921238986420', email: 'viewer@example.com' });
  });

  it('refuses a token issued for a different application', async () => {
    // Without this check any Google app could sign its users into this one.
    await expect(
      verifier().verifier.verify(token({ aud: 'someone-else.apps.googleusercontent.com' })),
    ).rejects.toThrow('不是为本服务签发的');
  });

  it('refuses a forged signature and one signed by the wrong key', async () => {
    const { verifier: check } = verifier();
    const good = token();
    const tampered = `${good.slice(0, good.lastIndexOf('.'))}.${Buffer.from('nope').toString('base64url')}`;
    await expect(check.verify(tampered)).rejects.toThrow('签名校验失败');
    await expect(check.verify(token({}, {}, otherKey))).rejects.toThrow('签名校验失败');
  });

  it('refuses an unsigned token, which is the classic way past a verifier', async () => {
    const head = b64({ alg: 'none', kid: KID });
    const body = b64({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'x' });
    await expect(verifier().verifier.verify(`${head}.${body}.`)).rejects.toThrow(GoogleAuthError);
  });

  it('refuses the wrong issuer, an expired token and an unverified address', async () => {
    const { verifier: check } = verifier();
    await expect(check.verify(token({ iss: 'https://evil.test' }))).rejects.toThrow(
      '不是 Google 签发的',
    );
    await expect(check.verify(token({ exp: Math.floor(NOW / 1000) - 3600 }))).rejects.toThrow(
      '已过期',
    );
    await expect(check.verify(token({ email_verified: false }))).rejects.toThrow('尚未验证');
    // A hair past expiry still passes: clocks differ, and Google says to allow for it.
    await expect(check.verify(token({ exp: Math.floor(NOW / 1000) - 30 }))).resolves.toBeTruthy();
  });

  it('binds the token to the request that asked for it', async () => {
    const { verifier: check } = verifier();
    await expect(check.verify(token({ nonce: 'abc' }), 'abc')).resolves.toBeTruthy();
    await expect(check.verify(token({ nonce: 'abc' }), 'xyz')).rejects.toThrow('请求已失效');
    // A token with no nonce at all cannot satisfy a caller that required one.
    await expect(check.verify(token(), 'xyz')).rejects.toThrow('请求已失效');
  });

  it('refuses a key it has never seen rather than trusting the token', async () => {
    await expect(verifier().verifier.verify(token({}, { kid: 'unknown-key' }))).rejects.toThrow(
      '不在 Google 的公钥列表中',
    );
  });

  it('caches Google’s keys instead of fetching them on every sign-in', async () => {
    const fetcher = vi.fn(async () => Response.json(certs()));
    const { verifier: check } = verifier(fetcher as unknown as typeof globalThis.fetch);
    await check.verify(token());
    await check.verify(token());
    await check.verify(token());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports a key server that is down instead of letting anyone in', async () => {
    const failing = vi.fn(async () => new Response('nope', { status: 503 }));
    const { verifier: check } = verifier(failing as unknown as typeof globalThis.fetch);
    await expect(check.verify(token())).rejects.toThrow('无法获取 Google 签名公钥');
  });
});
