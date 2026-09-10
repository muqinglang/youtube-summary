import { describe, expect, it } from 'vitest';
import { issueToken, readToken } from '../../server/auth/tokens';
import { CONFIG, createHarness, googleToken } from './harness';

const EMAIL = 'reader@example.com';

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
  const signIn = (app: ReturnType<typeof createHarness>['app'], payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/auth/google', payload });

  it('creates the account on first sign-in and returns to the same one after', async () => {
    const { app, store } = createHarness();
    const first = await signIn(app, { idToken: googleToken(EMAIL) });
    expect(first.statusCode).toBe(200);
    const created = first.json<{ token: string; user: { id: string; email: string } }>();
    expect(created.user.email).toBe(EMAIL);
    expect(created.token).toBeTruthy();

    const again = await signIn(app, { idToken: googleToken(EMAIL) });
    // The same Google account is the same account here; a second sign-in must not fork it.
    expect(again.json<{ user: { id: string } }>().user.id).toBe(created.user.id);
    expect(await store.users.byId(created.user.id)).toMatchObject({ email: EMAIL });
  });

  it('follows the person when Google changes their address', async () => {
    const { app } = createHarness();
    const before = await signIn(app, { idToken: `sub-stable|old@example.com` });
    const after = await signIn(app, { idToken: `sub-stable|new@example.com` });
    const id = before.json<{ user: { id: string } }>().user.id;
    // Keyed by Google's subject, so the library and usage stay with the person.
    expect(after.json<{ user: { id: string; email: string } }>().user).toEqual({
      id,
      email: 'new@example.com',
    });
  });

  it('refuses a token the verifier rejects, and a malformed request', async () => {
    const { app } = createHarness();
    expect((await signIn(app, { idToken: 'x'.repeat(40) })).statusCode).toBe(401);
    expect((await signIn(app, {})).statusCode).toBe(400);
    // Too short to be a JWT at all, so it never reaches the verifier.
    expect((await signIn(app, { idToken: 'short' })).statusCode).toBe(400);
  });

  it('requires the token to carry the nonce the request asked for', async () => {
    const { app } = createHarness();
    // Binds Google's answer to this sign-in, so a token captured elsewhere cannot be replayed.
    expect((await signIn(app, { idToken: googleToken(EMAIL, 'n1'), nonce: 'n1' })).statusCode).toBe(
      200,
    );
    expect((await signIn(app, { idToken: googleToken(EMAIL, 'n1'), nonce: 'n2' })).statusCode).toBe(
      401,
    );
  });

  it('throttles repeated bad tokens from one address', async () => {
    const { app } = createHarness();
    for (let attempt = 0; attempt < 10; attempt += 1)
      expect((await signIn(app, { idToken: 'y'.repeat(40) })).statusCode).toBe(401);
    // Verification is signature work against a remote key set; it is not free to spam.
    const blocked = await signIn(app, { idToken: googleToken(EMAIL) });
    expect(blocked.statusCode).toBe(429);
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
