import { createHash, createHmac, randomBytes, hkdfSync } from 'node:crypto';

// Cognito SRP-6a constants. See
// https://github.com/aws-amplify/amplify-js/blob/main/packages/amazon-cognito-identity-js/src/AuthenticationHelper.js
// for the canonical client-side implementation this mirrors.
//
// N is the 3072-bit MODP group from RFC 5054. g is 2.
const N_HEX = (
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74' +
  '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437' +
  '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05' +
  '98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB' +
  '9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718' +
  '3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33' +
  'A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864' +
  'D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2' +
  '08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF'
).toLowerCase();
const N = BigInt('0x' + N_HEX);
const g = 2n;

// k = H( PAD(N) | PAD(g) )
const k = BigInt('0x' + sha256Hex(padHex(N_HEX) + padHex(g.toString(16))));

/**
 * SHA-256 of a hex string, returns a hex string.
 */
function sha256Hex(hex) {
  return createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
}

/**
 * Left-pad a hex string to an even length and to match N's byte length (384).
 *
 * The canonical implementation prepends a leading '00' if the high bit is
 * set so the integer stays positive when parsed as a signed BigInteger in
 * the JVM/Android clients; we mirror that so hashes match byte-for-byte.
 */
export function padHex(hex) {
  let h = hex.toLowerCase();
  if (h.length % 2 !== 0) h = '0' + h;
  const firstByte = parseInt(h.slice(0, 2), 16);
  if (firstByte >= 0x80) h = '00' + h;
  return h;
}

/**
 * Derive the Cognito-specific "x" salted secret from the user's password.
 *
 *   x = H( salt | H( poolName + ':' + username + ':' + password ) )
 *
 * poolName is the segment of the userPoolId after the underscore (e.g.
 * 'us-east-1_ABC' → 'ABC').
 */
export function computeX(poolName, username, password, saltHex) {
  const inner = createHash('sha256')
    .update(`${poolName}${username}:${password}`)
    .digest();
  const combined = Buffer.concat([Buffer.from(padHex(saltHex), 'hex'), inner]);
  return BigInt('0x' + createHash('sha256').update(combined).digest('hex'));
}

/**
 * Compute the SRP verifier v = g^x mod N. Stored server-side (never sent
 * over the wire).
 */
export function computeVerifier(poolName, username, password, saltHex) {
  const x = computeX(poolName, username, password, saltHex);
  return bigIntModPow(g, x, N);
}

/**
 * Generate a random salt (128 bits, hex-encoded).
 */
export function generateSalt() {
  return randomBytes(16).toString('hex');
}

/**
 * Generate a random ephemeral private key b (256 bits). Cognito uses a
 * similarly-sized secret for SRP_B derivation.
 */
function generateEphemeralPrivate() {
  // Must be in [1, N-1]. 256 random bits is well below N so just mod it.
  return BigInt('0x' + randomBytes(32).toString('hex')) % (N - 1n) + 1n;
}

/**
 * Server-side SRP_B computation.
 *
 *   B = ( k*v + g^b ) mod N
 *
 * Returns { BHex, bHex } — `bHex` is the private ephemeral we must keep
 * until the client responds to the challenge.
 */
export function computeServerB(verifier) {
  const b = generateEphemeralPrivate();
  const B = (k * verifier + bigIntModPow(g, b, N)) % N;
  return { BHex: bigIntToHex(B), bHex: bigIntToHex(b) };
}

/**
 * Server-side session key derivation.
 *
 *   u = H( PAD(A) | PAD(B) )
 *   S = ( A * v^u )^b mod N
 *   K = HKDF-SHA256(PAD(S), "Caldera Derived Key", 16 bytes, salt = PAD(u))
 *
 * Returns K as a raw Buffer (16 bytes).
 */
export function computeServerSessionKey({ AHex, BHex, bHex, verifier }) {
  const A = BigInt('0x' + AHex);
  if (A % N === 0n) {
    throw new Error('SRP: client sent A ≡ 0 mod N');
  }
  const u = BigInt('0x' + sha256Hex(padHex(AHex) + padHex(BHex)));
  if (u === 0n) {
    throw new Error('SRP: u is zero');
  }
  const b = BigInt('0x' + bHex);
  const S = bigIntModPow(A * bigIntModPow(verifier, u, N), b, N);
  return hkdfDerive(S, u);
}

/**
 * Expected HMAC-SHA256 signature the client must send in PASSWORD_CLAIM_SIGNATURE.
 *
 *   M1 = HMAC_SHA256(K, poolName | username | SECRET_BLOCK | timestamp)
 */
export function computeExpectedSignature(K, poolName, username, secretBlockB64, timestamp) {
  const mac = createHmac('sha256', K);
  mac.update(poolName, 'utf8');
  mac.update(username, 'utf8');
  mac.update(Buffer.from(secretBlockB64, 'base64'));
  mac.update(timestamp, 'utf8');
  return mac.digest('base64');
}

/**
 * Cognito's HKDF wrapper.
 *
 * Conceptually HKDF(ikm = PAD(S), salt = PAD(u), info = "Caldera Derived Key",
 * length = 16). Implemented via node's hkdfSync for HKDF-SHA256.
 */
function hkdfDerive(S, u) {
  const ikm = Buffer.from(padHex(bigIntToHex(S)), 'hex');
  const salt = Buffer.from(padHex(bigIntToHex(u)), 'hex');
  const info = 'Caldera Derived Key';
  const out = hkdfSync('sha256', ikm, salt, info, 16);
  return Buffer.from(out);
}

/**
 * Modular exponentiation for BigInt — base^exp mod mod.
 */
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

/**
 * Re-exported for tests.
 */
export const _internals = { N, g, k, bigIntModPow, bigIntToHex, hkdfDerive };
