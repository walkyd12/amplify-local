import { generateKeyPair, exportPKCS8, exportSPKI, importPKCS8, importSPKI, SignJWT, jwtVerify, exportJWK } from 'jose';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ALG = 'RS256';

let privateKey = null;
let publicKey = null;
let jwksCache = null;

/**
 * Initialize RSA-2048 key pair. Generates new keys on first run,
 * loads existing keys from disk on subsequent runs.
 */
export async function initKeys(dataDir) {
  const keysDir = join(dataDir, 'keys');
  const privatePath = join(keysDir, 'private.pem');
  const publicPath = join(keysDir, 'public.pem');

  if (existsSync(privatePath) && existsSync(publicPath)) {
    const privatePem = readFileSync(privatePath, 'utf8');
    const publicPem = readFileSync(publicPath, 'utf8');
    privateKey = await importPKCS8(privatePem, ALG);
    publicKey = await importSPKI(publicPem, ALG);
  } else {
    mkdirSync(keysDir, { recursive: true });
    const pair = await generateKeyPair(ALG, { modulusLength: 2048, extractable: true });
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;

    const privatePem = await exportPKCS8(privateKey);
    const publicPem = await exportSPKI(publicKey);
    writeFileSync(privatePath, privatePem, 'utf8');
    writeFileSync(publicPath, publicPem, 'utf8');
  }

  // Reset JWKS cache when keys change
  jwksCache = null;
}

/**
 * Sign an ID token with Cognito-compatible claims.
 */
export async function signIdToken({ sub, email, groups, poolId, clientId }) {
  const now = Math.floor(Date.now() / 1000);
  // Cognito pool IDs are `<region>_<pool>`; derive the region so the issuer
  // matches the hostname the Amplify SDK calls (real or fake).
  const region = poolId.includes('_') ? poolId.split('_')[0] : 'local-1';
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;

  const jwt = await new SignJWT({
    sub,
    email,
    'cognito:username': sub,
    'cognito:groups': groups || [],
    token_use: 'id',
    auth_time: now,
  })
    .setProtectedHeader({ alg: ALG, kid: 'local-key-1' })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime('24h')
    .sign(privateKey);

  return jwt;
}

/**
 * Sign an access token with Cognito-compatible claims.
 */
export async function signAccessToken({ sub, groups, clientId, poolId, username }) {
  const now = Math.floor(Date.now() / 1000);
  const region = poolId && poolId.includes('_') ? poolId.split('_')[0] : 'local-1';
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId || 'local-1_localpool01'}`;

  const jwt = await new SignJWT({
    sub,
    'cognito:groups': groups || [],
    token_use: 'access',
    client_id: clientId,
    username: username || sub,
    scope: 'aws.cognito.signin.user.admin',
    auth_time: now,
    jti: randomId(),
  })
    .setProtectedHeader({ alg: ALG, kid: 'local-key-1' })
    .setIssuer(issuer)
    .setIssuedAt(now)
    .setExpirationTime('24h')
    .sign(privateKey);

  return jwt;
}

function randomId() {
  return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Get JWKS JSON containing the public key for token verification.
 */
export async function getJwks() {
  if (jwksCache) return jwksCache;

  const jwk = await exportJWK(publicKey);
  jwk.kid = 'local-key-1';
  jwk.alg = ALG;
  jwk.use = 'sig';

  jwksCache = { keys: [jwk] };
  return jwksCache;
}

/**
 * Verify a JWT token and return the decoded payload.
 */
export async function verifyToken(token) {
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: [ALG],
  });
  return payload;
}
