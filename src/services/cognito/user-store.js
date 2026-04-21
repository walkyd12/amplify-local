import { computeVerifier, generateSalt } from './srp.js';

/**
 * In-memory registry of Cognito-style users.
 *
 * Built from config.users at startup (each with optional password). SignUp
 * adds new users at runtime. All state is lost on process restart — this is
 * local dev only.
 *
 * Record shape:
 * {
 *   email, sub, username,
 *   password,                  // kept so USER_PASSWORD_AUTH can match plainly
 *   saltHex, verifierHex,      // for SRP
 *   groups: string[],
 *   confirmed: boolean,
 *   attributes: Record<string, string>,
 *   pendingChallenges: Map<sessionId, { flow, data }>,
 *   refreshTokens: Set<string>,
 * }
 */
export function createUserStore({ poolId, poolName, users = [] }) {
  const byUsername = new Map(); // username or email → record
  const sessions = new Map(); // sessionId → { username, BHex, bHex, verifier }

  /**
   * Register a user. `password` is optional — without it the user can still
   * be impersonated via the static JWT in tokens.json but can't sign in via
   * the Cognito-shaped endpoint.
   */
  function addUser({ email, sub, password, groups = [], username, attributes = {} }) {
    const name = username || email;
    if (!name) throw new Error('addUser requires email or username');

    const saltHex = generateSalt();
    const verifierHex = password
      ? computeVerifier(poolName, name, password, saltHex).toString(16)
      : null;

    const record = {
      email: email || name,
      sub: sub || randomSub(),
      username: name,
      password: password || null,
      saltHex,
      verifierHex,
      groups,
      confirmed: true, // auto-confirm — local dev only
      attributes: {
        email: email || name,
        email_verified: 'true',
        ...attributes,
      },
      refreshTokens: new Set(),
    };
    byUsername.set(name, record);
    if (email && email !== name) byUsername.set(email, record);
    return record;
  }

  /**
   * Look up a user by their username or email.
   */
  function findUser(name) {
    return byUsername.get(name) || null;
  }

  /**
   * Store an SRP challenge the client is expected to respond to.
   * Returns an opaque session identifier.
   */
  function openChallenge(data) {
    const sid = randomSub();
    sessions.set(sid, data);
    return sid;
  }

  function takeChallenge(sid) {
    const data = sessions.get(sid);
    if (data) sessions.delete(sid);
    return data || null;
  }

  // Seed initial users
  for (const u of users) addUser(u);

  return {
    poolId,
    poolName,
    addUser,
    findUser,
    openChallenge,
    takeChallenge,
    // Test helpers
    _all: () => Array.from(new Set(byUsername.values())),
  };
}

/**
 * Generate a pseudo-random v4-ish UUID. Not cryptographically important —
 * it's just a handle for the sessions map and newly-created user subs.
 */
function randomSub() {
  const h = Array.from({ length: 8 }, () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
