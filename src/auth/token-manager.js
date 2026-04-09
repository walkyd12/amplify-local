import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { initKeys, signIdToken, signAccessToken } from './jwt.js';

const DEFAULT_POOL_ID = 'us-east-1_localpool01';
const DEFAULT_CLIENT_ID = 'local-client-id-000000';
const DEFAULT_API_KEY = 'local-api-key-000000';

/**
 * Generate tokens for all configured test users.
 *
 * Initializes RSA keys, signs ID and access tokens for each user,
 * and writes them to .amplify-local/tokens.json.
 *
 * Returns { tokens, apiKey, poolId, clientId }.
 */
export async function generateTokens(users, authConfig, dataDir) {
  const resolvedDir = dataDir || '.amplify-local';

  // Initialize RSA keys (generates or loads from disk)
  await initKeys(resolvedDir);

  const poolId = DEFAULT_POOL_ID;
  const clientId = DEFAULT_CLIENT_ID;
  const apiKey = DEFAULT_API_KEY;

  const tokens = {};

  for (const user of users) {
    const { email, sub, groups } = user;

    const idToken = await signIdToken({
      sub,
      email,
      groups: groups || [],
      poolId,
      clientId,
    });

    const accessToken = await signAccessToken({
      sub,
      groups: groups || [],
      clientId,
    });

    tokens[email] = { idToken, accessToken };
  }

  // Write tokens to disk
  const tokensPath = join(resolvedDir, 'tokens.json');
  mkdirSync(dirname(tokensPath), { recursive: true });
  writeFileSync(tokensPath, JSON.stringify(tokens, null, 2), 'utf8');

  return { tokens, apiKey, poolId, clientId };
}
