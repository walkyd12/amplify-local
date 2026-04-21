import { describe, it, expect, beforeAll } from 'vitest';
import { createAuthMiddleware } from '../../src/auth/middleware.js';
import { initKeys, signIdToken } from '../../src/auth/jwt.js';

const POOL_ID = 'local-1_localpool01';
const CLIENT_ID = 'local-client-id-000000';
const API_KEY = 'test-api-key';

describe('auth middleware', () => {
  let token;

  beforeAll(async () => {
    await initKeys('./.amplify-local-test-keys-middleware');
    token = await signIdToken({
      sub: 'admin-001',
      email: 'admin@test.local',
      groups: ['admins'],
      poolId: POOL_ID,
      clientId: CLIENT_ID,
    });
  });

  function run(headers) {
    const req = { headers };
    const middleware = createAuthMiddleware(API_KEY);
    return new Promise((resolve) => middleware(req, {}, () => resolve(req.authContext)));
  }

  it('accepts a raw JWT in Authorization (no Bearer prefix) — the shape AppSync/Amplify actually sends', async () => {
    const ctx = await run({ authorization: token });
    expect(ctx.type).toBe('userPool');
    expect(ctx.sub).toBe('admin-001');
    expect(ctx.groups).toEqual(['admins']);
    expect(ctx.invalid).toBeUndefined();
  });

  it('also accepts a Bearer-prefixed JWT (curl-style clients)', async () => {
    const ctx = await run({ authorization: `Bearer ${token}` });
    expect(ctx.type).toBe('userPool');
    expect(ctx.sub).toBe('admin-001');
    expect(ctx.groups).toEqual(['admins']);
  });

  it('marks the context invalid when the token is garbage', async () => {
    const ctx = await run({ authorization: 'not-a-real-jwt' });
    expect(ctx.type).toBe('userPool');
    expect(ctx.invalid).toBe(true);
    expect(ctx.groups).toEqual([]);
  });

  it('uses the apiKey branch when x-api-key is present', async () => {
    const ctx = await run({ 'x-api-key': API_KEY });
    expect(ctx.type).toBe('apiKey');
    expect(ctx.valid).toBe(true);
  });

  it('falls through to iam when nothing is present', async () => {
    const ctx = await run({});
    expect(ctx.type).toBe('iam');
    expect(ctx.authenticated).toBe(false);
  });
});
