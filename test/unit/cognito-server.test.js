import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createHash, createHmac, randomBytes, hkdfSync } from 'node:crypto';
import { initKeys } from '../../src/auth/jwt.js';
import { createCognitoServer } from '../../src/services/cognito/server.js';
import { padHex, _internals, computeVerifier } from '../../src/services/cognito/srp.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { N, g } = _internals;

// ---- tiny SRP client (same mirror as cognito-srp.test.js) ----------------
function bigIntModPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return r;
}
function bigIntToHex(n) {
  let h = n.toString(16);
  if (h.length % 2 !== 0) h = '0' + h;
  return h;
}

function clientBegin() {
  const a = (BigInt('0x' + randomBytes(32).toString('hex')) % (N - 1n)) + 1n;
  const A = bigIntModPow(g, a, N);
  return { a, AHex: bigIntToHex(A) };
}

function clientResponse({ poolName, username, password, saltHex, AHex, a, BHex, secretBlockB64, timestamp }) {
  const x = BigInt(
    '0x' +
      createHash('sha256')
        .update(
          Buffer.concat([
            Buffer.from(padHex(saltHex), 'hex'),
            createHash('sha256').update(`${poolName}${username}:${password}`).digest(),
          ])
        )
        .digest('hex')
  );
  const k = BigInt(
    '0x' + createHash('sha256').update(Buffer.from(padHex(N.toString(16)) + padHex(g.toString(16)), 'hex')).digest('hex')
  );
  const B = BigInt('0x' + BHex);
  const u = BigInt('0x' + createHash('sha256').update(Buffer.from(padHex(AHex) + padHex(BHex), 'hex')).digest('hex'));
  const kgx = (k * bigIntModPow(g, x, N)) % N;
  const base = ((B + N - kgx) % N + N) % N;
  const S = bigIntModPow(base, a + u * x, N);
  const K = hkdfSync(
    'sha256',
    Buffer.from(padHex(bigIntToHex(S)), 'hex'),
    Buffer.from(padHex(bigIntToHex(u)), 'hex'),
    'Caldera Derived Key',
    16
  );
  const mac = createHmac('sha256', K);
  mac.update(poolName, 'utf8');
  mac.update(username, 'utf8');
  mac.update(Buffer.from(secretBlockB64, 'base64'));
  mac.update(timestamp, 'utf8');
  return mac.digest('base64');
}

// ---- helpers for the supertest invocations -------------------------------
function action(app, target, body) {
  return request(app).post('/').set('X-Amz-Target', `AWSCognitoIdentityProviderService.${target}`).send(body);
}

// ---- setup ----------------------------------------------------------------
let app;
const poolId = 'us-east-1_TESTPOOL';
const poolName = 'TESTPOOL';

beforeAll(async () => {
  // JWT signer needs keys; stash them in a temp dir so we don't pollute the repo.
  const keyDir = mkdtempSync(join(tmpdir(), 'amplify-local-cognito-keys-'));
  await initKeys(keyDir);

  app = createCognitoServer({
    config: {
      authorizationModes: { userPoolId: poolId, userPoolClientId: 'local-client-1' },
      ports: {},
    },
    parsedSchema: { models: {} },
    users: [
      { email: 'alice@test.local', sub: 'alice-sub', password: 'Hunter2!', groups: ['admins'] },
      { email: 'bob@test.local', sub: 'bob-sub', password: 'Correct-Horse', groups: [] },
    ],
  });
});

describe('Cognito endpoint — USER_PASSWORD_AUTH', () => {
  it('issues tokens for valid credentials', async () => {
    const res = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: 'local-client-1',
      AuthParameters: { USERNAME: 'alice@test.local', PASSWORD: 'Hunter2!' },
    }).expect(200);
    expect(res.body.AuthenticationResult.IdToken).toMatch(/^eyJ/);
    expect(res.body.AuthenticationResult.AccessToken).toMatch(/^eyJ/);
    expect(res.body.AuthenticationResult.RefreshToken).toMatch(/^rt_/);
    expect(res.body.AuthenticationResult.TokenType).toBe('Bearer');
  });

  it('rejects wrong password with NotAuthorizedException', async () => {
    const res = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'alice@test.local', PASSWORD: 'wrong' },
    }).expect(400);
    expect(res.body.__type).toBe('NotAuthorizedException');
  });

  it('rejects unknown user with NotAuthorizedException (no info leak)', async () => {
    const res = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'ghost@test.local', PASSWORD: 'x' },
    }).expect(400);
    expect(res.body.__type).toBe('NotAuthorizedException');
  });
});

describe('Cognito endpoint — USER_SRP_AUTH full flow', () => {
  it('completes the 2-round-trip SRP dance and returns tokens', async () => {
    const { a, AHex } = clientBegin();

    const r1 = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_SRP_AUTH',
      ClientId: 'local-client-1',
      AuthParameters: { USERNAME: 'alice@test.local', SRP_A: AHex },
    }).expect(200);

    expect(r1.body.ChallengeName).toBe('PASSWORD_VERIFIER');
    const { SALT, SRP_B, SECRET_BLOCK, USER_ID_FOR_SRP } = r1.body.ChallengeParameters;
    const timestamp = 'Tue Apr 21 02:00:00 UTC 2026';

    const signature = clientResponse({
      poolName,
      username: USER_ID_FOR_SRP,
      password: 'Hunter2!',
      saltHex: SALT,
      AHex,
      a,
      BHex: SRP_B,
      secretBlockB64: SECRET_BLOCK,
      timestamp,
    });

    const r2 = await action(app, 'RespondToAuthChallenge', {
      ChallengeName: 'PASSWORD_VERIFIER',
      ClientId: 'local-client-1',
      Session: r1.body.Session,
      ChallengeResponses: {
        USERNAME: USER_ID_FOR_SRP,
        PASSWORD_CLAIM_SIGNATURE: signature,
        PASSWORD_CLAIM_SECRET_BLOCK: SECRET_BLOCK,
        TIMESTAMP: timestamp,
      },
    }).expect(200);

    expect(r2.body.AuthenticationResult.IdToken).toMatch(/^eyJ/);
  });

  it('fails with a wrong-password signature', async () => {
    const { a, AHex } = clientBegin();
    const r1 = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_SRP_AUTH',
      AuthParameters: { USERNAME: 'alice@test.local', SRP_A: AHex },
    }).expect(200);
    const { SALT, SRP_B, SECRET_BLOCK, USER_ID_FOR_SRP } = r1.body.ChallengeParameters;
    const ts = 'Tue Apr 21 02:00:00 UTC 2026';
    const signature = clientResponse({
      poolName,
      username: USER_ID_FOR_SRP,
      password: 'WRONG',
      saltHex: SALT,
      AHex,
      a,
      BHex: SRP_B,
      secretBlockB64: SECRET_BLOCK,
      timestamp: ts,
    });
    const r2 = await action(app, 'RespondToAuthChallenge', {
      ChallengeName: 'PASSWORD_VERIFIER',
      Session: r1.body.Session,
      ChallengeResponses: {
        USERNAME: USER_ID_FOR_SRP,
        PASSWORD_CLAIM_SIGNATURE: signature,
        PASSWORD_CLAIM_SECRET_BLOCK: SECRET_BLOCK,
        TIMESTAMP: ts,
      },
    }).expect(400);
    expect(r2.body.__type).toBe('NotAuthorizedException');
  });

  it('rejects reuse of a challenge session (single-use)', async () => {
    const { a, AHex } = clientBegin();
    const r1 = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_SRP_AUTH',
      AuthParameters: { USERNAME: 'alice@test.local', SRP_A: AHex },
    }).expect(200);
    const { SALT, SRP_B, SECRET_BLOCK, USER_ID_FOR_SRP } = r1.body.ChallengeParameters;
    const ts = 'Tue Apr 21 02:00:00 UTC 2026';
    const signature = clientResponse({
      poolName, username: USER_ID_FOR_SRP, password: 'Hunter2!',
      saltHex: SALT, AHex, a, BHex: SRP_B, secretBlockB64: SECRET_BLOCK, timestamp: ts,
    });
    const body = {
      ChallengeName: 'PASSWORD_VERIFIER',
      Session: r1.body.Session,
      ChallengeResponses: { USERNAME: USER_ID_FOR_SRP, PASSWORD_CLAIM_SIGNATURE: signature, PASSWORD_CLAIM_SECRET_BLOCK: SECRET_BLOCK, TIMESTAMP: ts },
    };
    await action(app, 'RespondToAuthChallenge', body).expect(200);
    const replay = await action(app, 'RespondToAuthChallenge', body).expect(400);
    expect(replay.body.__type).toBe('NotAuthorizedException');
  });
});

describe('Cognito endpoint — REFRESH_TOKEN_AUTH', () => {
  it('exchanges a refresh token for fresh id + access tokens', async () => {
    const signIn = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'bob@test.local', PASSWORD: 'Correct-Horse' },
    }).expect(200);
    const refreshToken = signIn.body.AuthenticationResult.RefreshToken;

    const refresh = await action(app, 'InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }).expect(200);
    expect(refresh.body.AuthenticationResult.IdToken).toMatch(/^eyJ/);
    expect(refresh.body.AuthenticationResult.AccessToken).toMatch(/^eyJ/);
  });

  it('rejects an unknown refresh token', async () => {
    const res = await action(app, 'InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: 'rt_unknown' },
    }).expect(400);
    expect(res.body.__type).toBe('NotAuthorizedException');
  });
});

describe('Cognito endpoint — SignUp / GetUser / GlobalSignOut', () => {
  it('SignUp auto-confirms, issues a sub, and the user can immediately sign in', async () => {
    const signUp = await action(app, 'SignUp', {
      ClientId: 'local-client-1',
      Username: 'new@test.local',
      Password: 'NewPass1!',
      UserAttributes: [{ Name: 'email', Value: 'new@test.local' }],
    }).expect(200);
    expect(signUp.body.UserConfirmed).toBe(true);
    expect(signUp.body.UserSub).toBeTruthy();

    const login = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'new@test.local', PASSWORD: 'NewPass1!' },
    }).expect(200);
    expect(login.body.AuthenticationResult.IdToken).toMatch(/^eyJ/);
  });

  it('rejects duplicate SignUp with UsernameExistsException', async () => {
    const res = await action(app, 'SignUp', {
      ClientId: 'local-client-1',
      Username: 'alice@test.local',
      Password: 'something',
      UserAttributes: [],
    }).expect(400);
    expect(res.body.__type).toBe('UsernameExistsException');
  });

  it('GetUser returns the current user given a valid access token', async () => {
    const login = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'alice@test.local', PASSWORD: 'Hunter2!' },
    }).expect(200);
    const accessToken = login.body.AuthenticationResult.AccessToken;

    const res = await action(app, 'GetUser', { AccessToken: accessToken }).expect(200);
    expect(res.body.Username).toBe('alice@test.local');
    expect(res.body.UserAttributes.find((a) => a.Name === 'email').Value).toBe('alice@test.local');
    expect(res.body.UserAttributes.find((a) => a.Name === 'sub').Value).toBe('alice-sub');
  });

  it('GlobalSignOut invalidates the refresh token', async () => {
    const login = await action(app, 'InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: 'bob@test.local', PASSWORD: 'Correct-Horse' },
    }).expect(200);
    const { AccessToken, RefreshToken } = login.body.AuthenticationResult;

    await action(app, 'GlobalSignOut', { AccessToken }).expect(200);

    const reused = await action(app, 'InitiateAuth', {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: RefreshToken },
    }).expect(400);
    expect(reused.body.__type).toBe('NotAuthorizedException');
  });
});

describe('Cognito endpoint — misc', () => {
  it('returns NotImplementedException for unsupported actions', async () => {
    const res = await action(app, 'AdminCreateUser', {}).expect(501);
    expect(res.body.__type).toBe('NotImplementedException');
  });

  it('exposes JWKS at /.well-known/jwks.json', async () => {
    const res = await request(app).get('/.well-known/jwks.json').expect(200);
    expect(Array.isArray(res.body.keys)).toBe(true);
    expect(res.body.keys[0].kty).toBe('RSA');
  });
});

// Suppress unused-import warnings from imports used only in the client helper.
void computeVerifier;
