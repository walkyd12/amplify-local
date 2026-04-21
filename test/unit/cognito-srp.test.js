import { describe, it, expect } from 'vitest';
import { createHash, createHmac, randomBytes, hkdfSync } from 'node:crypto';
import {
  padHex,
  computeVerifier,
  generateSalt,
  computeServerB,
  computeServerSessionKey,
  computeExpectedSignature,
  _internals,
} from '../../src/services/cognito/srp.js';

const { N, g } = _internals;

// ---------------------------------------------------------------------------
// A minimal client-side SRP helper written to mirror the server. If both
// implementations agree on the session key, the signature round-trip works.
// ---------------------------------------------------------------------------

function clientSignIn({ poolName, username, password, saltHex, BHex, secretBlockB64, timestamp }) {
  // a = random 256-bit private
  const a = BigInt('0x' + randomBytes(32).toString('hex')) % (N - 1n) + 1n;
  const A = bigIntModPow(g, a, N);
  const AHex = bigIntToHex(A);

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

  // k = H(PAD(N) | PAD(g)) — same as server
  const k = BigInt(
    '0x' +
      createHash('sha256')
        .update(Buffer.from(padHex(N.toString(16)) + padHex(g.toString(16)), 'hex'))
        .digest('hex')
  );

  const B = BigInt('0x' + BHex);
  const u = BigInt(
    '0x' + createHash('sha256').update(Buffer.from(padHex(AHex) + padHex(BHex), 'hex')).digest('hex')
  );

  // S = (B - k*g^x)^(a + u*x) mod N, carefully handling the underflow path.
  const kgx = (k * bigIntModPow(g, x, N)) % N;
  const base = ((B + N - kgx) % N + N) % N;
  const exp = a + u * x;
  const S = bigIntModPow(base, exp, N);

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
  const signature = mac.digest('base64');

  return { AHex, signature };
}

function bigIntModPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}
function bigIntToHex(n) {
  let h = n.toString(16);
  if (h.length % 2 !== 0) h = '0' + h;
  return h;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SRP primitives', () => {
  it('padHex pads to even length and prepends 00 when the high bit is set', () => {
    expect(padHex('abc')).toBe('0abc');
    expect(padHex('80')).toBe('0080');
    expect(padHex('7f')).toBe('7f');
    expect(padHex('ff')).toBe('00ff');
  });

  it('computeVerifier is deterministic for the same salt+password', () => {
    const salt = 'a'.repeat(32);
    const v1 = computeVerifier('ABC', 'alice', 'hunter2', salt);
    const v2 = computeVerifier('ABC', 'alice', 'hunter2', salt);
    expect(v1).toBe(v2);
  });

  it('generateSalt returns 32 hex chars (128 bits)', () => {
    const s = generateSalt();
    expect(s).toMatch(/^[0-9a-f]{32}$/);
  });

  it('computeServerB returns B < N and a private bHex of reasonable size', () => {
    const verifier = computeVerifier('POOL', 'user', 'pw', generateSalt());
    const { BHex, bHex } = computeServerB(verifier);
    expect(BigInt('0x' + BHex)).toBeLessThan(N);
    expect(bHex.length).toBeGreaterThan(30);
  });
});

describe('SRP round-trip (client mirror matches server)', () => {
  const poolName = 'ABC123';
  const username = 'alice@test.local';
  const password = 'Hunter2!';
  const saltHex = generateSalt();
  const verifier = computeVerifier(poolName, username, password, saltHex);

  it('derives the same session key and verifies the signature', () => {
    const { BHex, bHex } = computeServerB(verifier);
    const secretBlock = randomBytes(48).toString('base64');
    const timestamp = 'Tue Apr 21 02:00:00 UTC 2026';

    const { AHex, signature } = clientSignIn({
      poolName,
      username,
      password,
      saltHex,
      BHex,
      secretBlockB64: secretBlock,
      timestamp,
    });

    const K = computeServerSessionKey({ AHex, BHex, bHex, verifier });
    const expected = computeExpectedSignature(K, poolName, username, secretBlock, timestamp);
    expect(signature).toBe(expected);
  });

  it('rejects a wrong password — signatures do not match', () => {
    const { BHex, bHex } = computeServerB(verifier);
    const secretBlock = randomBytes(48).toString('base64');
    const timestamp = 'Tue Apr 21 02:00:00 UTC 2026';

    const { AHex, signature } = clientSignIn({
      poolName,
      username,
      password: 'WrongPassword!',
      saltHex,
      BHex,
      secretBlockB64: secretBlock,
      timestamp,
    });

    const K = computeServerSessionKey({ AHex, BHex, bHex, verifier });
    const expected = computeExpectedSignature(K, poolName, username, secretBlock, timestamp);
    expect(signature).not.toBe(expected);
  });
});
