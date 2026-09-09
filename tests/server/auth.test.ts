import { describe, expect, it } from 'vitest';
import { issueToken, readToken } from '../../server/auth/tokens';
import { hashPassword, verifyPassword } from '../../server/auth/passwords';
import { CONFIG, createHarness, register } from './harness';

const EMAIL = 'reader@example.com';
const PASSWORD = 'a-long-enough-password';

describe('password hashing', () => {
  it('produces a salted verifiable hash and rejects the wrong password', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash.startsWith('scrypt$')).toBe(true);
    // A distinct salt per hash: two hashes of one password must not match each other.
    expect(await hashPassword(PASSWORD)).not.toBe(hash);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('a-long-enough-passwerd', hash)).toBe(false);
  });

  it('rejects a malformed record instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$1$2$3', 'argon2$1$1$1$c2FsdA$aGFzaA'])
      await expect(verifyPassword(PASSWORD, bad)).resolves.toBe(false);
  });
});

describe('session tokens', () => {
  it('round-trips a user id and refuses tampering or expiry', () => {
    const token = issueToken('user-1', CONFIG.sessionSecret, 60_000);
    const read = (value: string) => readToken(value, CONFIG.sessionSecret);
    // Deterministic by design: the token is a MAC over {uid, exp}, not a random session id.
    expect(read(issueToken('user-2', CONFIG.sessionSecret, 60_000))).toBe('user-2');
    expect(read(token)).toBe('user-1');
    const [payload, signature] = token.split('.');
    expect(read(`${payload}.${signature!.slice(0, -2)}xx`)).toBeUndefined();
    expect(
      read(issueToken('user-1', 'a-different-secret-of-sufficient-length', 60_000)),
    ).toBeUndefined();
    // An already-expired token is refused even though its signature is genuine.
    expect(read(issueToken('user-1', CONFIG.sessionSecret, -1_000))).toBeUndefined();
  });
});

describe('accounts', () => {
  it('registers, then authenticates the same credentials', async () => {
    const { app } = createHarness();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json<{ token: string }>().token;

    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ user: { email: string } }>().user.email).toBe(EMAIL);
    expect(me.json<{ usage: { dailyJobLimit: number } }>().usage.dailyJobLimit).toBe(
      CONFIG.dailyJobLimit,
    );

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: EMAIL.toUpperCase(), password: PASSWORD },
    });
    // Addresses are matched case-insensitively so a capitalised login still works.
    expect(login.statusCode).toBe(200);
    expect(login.json<{ token: string }>().token).toBeTruthy();
  });

  it('refuses a duplicate address and a too-short password', async () => {
    const { app } = createHarness();
    await register(app, EMAIL);
    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(duplicate.statusCode).toBe(409);
    const weak = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'other@example.com', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
  });

  it('does not reveal whether an address exists', async () => {
    const { app } = createHarness();
    await register(app, EMAIL);
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: EMAIL, password: 'a-long-enough-passwerd' },
    });
    const unknownAddress = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@example.com', password: PASSWORD },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAddress.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownAddress.json());
  });

  it('throttles repeated failures for one address', async () => {
    const { app } = createHarness();
    await register(app, EMAIL);
    let last = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: EMAIL, password: 'a-long-enough-passwerd' },
      });
      last = response.statusCode;
    }
    expect(last).toBe(429);
    // The throttle must not lock out the real password holder forever, but it does apply now.
    const correct = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect(correct.statusCode).toBe(429);
  });

  it('guards every private route', async () => {
    const { app } = createHarness();
    for (const url of ['/v1/me', '/v1/jobs/whatever']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const tampered = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(tampered.statusCode).toBe(401);
    }
    // A validly signed token for an account that no longer exists is refused too.
    const orphan = issueToken('11111111-1111-1111-1111-111111111111', CONFIG.sessionSecret, 60_000);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${orphan}` },
    });
    expect(response.statusCode).toBe(401);
  });
});
