import express from 'express';
import { randomBytes } from 'node:crypto';
import { signIdToken, signAccessToken, verifyToken, getJwks } from '../../auth/jwt.js';
import { createUserStore } from './user-store.js';
import {
  computeServerB,
  computeServerSessionKey,
  computeExpectedSignature,
  computeVerifier,
} from './srp.js';
import { info as logInfo, warn as logWarn } from '../../logger.js';

/**
 * Create an Express app that speaks enough of Cognito's UserPool JSON-RPC
 * protocol for the Amplify SDK to sign users in, sign them up, refresh
 * their tokens, and fetch their profile.
 *
 * Supported targets (via the X-Amz-Target header):
 *
 *   AWSCognitoIdentityProviderService.InitiateAuth
 *     - USER_SRP_AUTH       → returns PASSWORD_VERIFIER challenge
 *     - USER_PASSWORD_AUTH  → returns AuthenticationResult directly
 *     - REFRESH_TOKEN_AUTH  → returns a fresh id/access token pair
 *
 *   AWSCognitoIdentityProviderService.RespondToAuthChallenge
 *     - PASSWORD_VERIFIER (the SRP second round-trip)
 *
 *   AWSCognitoIdentityProviderService.SignUp           (auto-confirmed)
 *   AWSCognitoIdentityProviderService.ConfirmSignUp    (noop)
 *   AWSCognitoIdentityProviderService.GetUser
 *   AWSCognitoIdentityProviderService.GlobalSignOut
 *
 * This is deliberately a subset: no MFA, no password-reset-by-email, no
 * lambda triggers. Anything beyond this raises a NotImplementedException,
 * which the Amplify SDK surfaces as a recognisable error.
 */
export function createCognitoServer({ config, users, parsedSchema }) {
  const app = express();

  // OPTIONS must return 204 before the body parser sees it, because browsers
  // send OPTIONS for CORS preflight on every Cognito request.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    // Echo whatever headers the browser says it's about to send. AWS SDK v3
    // adds `amz-sdk-invocation-id` / `amz-sdk-request` beyond the classic
    // `x-amz-*` set, and the list grows over time — echoing avoids chasing.
    const requested = req.headers['access-control-request-headers'];
    res.setHeader(
      'Access-Control-Allow-Headers',
      requested ||
        'Content-Type, X-Amz-Target, X-Amz-User-Agent, Authorization, Accept, X-Amz-Date, amz-sdk-invocation-id, amz-sdk-request'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: '2mb', type: ['application/json', 'application/x-amz-json-1.1'] }));

  const poolId = config.authorizationModes?.userPoolId || 'local-1_localpool01';
  const poolName = poolId.includes('_') ? poolId.split('_')[1] : poolId;
  const clientId = config.authorizationModes?.userPoolClientId || 'local-client-id-000000';

  const store = createUserStore({
    poolId,
    poolName,
    users: (users || []).map((u) => ({
      email: u.email,
      sub: u.sub,
      password: u.password,
      groups: u.groups || [],
    })),
  });

  // ---- JWKS for token verification by downstream services -------------------
  // Amplify SDK's token verification hits /.well-known/jwks.json under the
  // user pool URL. We expose it so third-party Cognito tooling validates too.
  app.get('/.well-known/jwks.json', async (_req, res) => {
    res.json(await getJwks());
  });
  app.get(`/${poolId}/.well-known/jwks.json`, async (_req, res) => {
    res.json(await getJwks());
  });

  // ---- Main JSON-RPC dispatcher --------------------------------------------
  app.post('/', async (req, res) => {
    const target = req.headers['x-amz-target'] || '';
    const action = String(target).split('.').pop();

    try {
      switch (action) {
        case 'InitiateAuth':
          return res.json(await handleInitiateAuth(req.body || {}));
        case 'RespondToAuthChallenge':
          return res.json(await handleRespondToAuthChallenge(req.body || {}));
        case 'SignUp':
          return res.json(handleSignUp(req.body || {}));
        case 'ConfirmSignUp':
          return res.json({});
        case 'ResendConfirmationCode':
          return res.json({ CodeDeliveryDetails: { Destination: 'local', DeliveryMedium: 'EMAIL', AttributeName: 'email' } });
        case 'GetUser':
          return res.json(await handleGetUser(req.body || {}));
        case 'GlobalSignOut':
          return res.json(await handleGlobalSignOut(req.body || {}));
        case 'RevokeToken':
          return res.json({});
        case 'ForgotPassword':
          return res.json({ CodeDeliveryDetails: { Destination: 'local', DeliveryMedium: 'EMAIL', AttributeName: 'email' } });
        case 'ConfirmForgotPassword':
          return handleConfirmForgotPassword(req.body || {}, res);
        default:
          return cognitoError(res, 501, 'NotImplementedException', `Unsupported action: ${action}`);
      }
    } catch (err) {
      logWarn('cognito', `${action} failed: ${err.message}`);
      return cognitoError(res, err.statusCode || 400, err.name || 'InternalErrorException', err.message);
    }
  });

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async function handleInitiateAuth(body) {
    const flow = body.AuthFlow;
    const params = body.AuthParameters || {};

    if (flow === 'USER_SRP_AUTH') {
      return beginSrpChallenge(params);
    }
    if (flow === 'USER_PASSWORD_AUTH' || flow === 'ADMIN_USER_PASSWORD_AUTH') {
      return authenticateWithPassword(params);
    }
    if (flow === 'REFRESH_TOKEN_AUTH' || flow === 'REFRESH_TOKEN') {
      return refreshTokens(params);
    }
    throwCognitoError('InvalidParameterException', `Unsupported AuthFlow: ${flow}`);
  }

  function beginSrpChallenge(params) {
    const username = params.USERNAME;
    const AHex = normalizeHex(params.SRP_A);
    if (!username || !AHex) {
      throwCognitoError('InvalidParameterException', 'USERNAME and SRP_A are required');
    }
    const user = store.findUser(username);
    if (!user || !user.verifierHex) {
      // Cognito returns a generic NotAuthorizedException to avoid leaking
      // whether a user exists; we do the same.
      throwCognitoError('NotAuthorizedException', 'Incorrect username or password.');
    }

    const verifier = BigInt('0x' + user.verifierHex);
    const { BHex, bHex } = computeServerB(verifier);
    const secretBlockBuf = randomBytes(64);
    const secretBlock = secretBlockBuf.toString('base64');

    const sessionId = store.openChallenge({
      flow: 'USER_SRP_AUTH',
      username: user.username,
      sub: user.sub,
      AHex,
      BHex,
      bHex,
      verifierHex: user.verifierHex,
      secretBlock,
    });

    return {
      ChallengeName: 'PASSWORD_VERIFIER',
      Session: sessionId,
      ChallengeParameters: {
        SALT: user.saltHex,
        SRP_B: BHex,
        SECRET_BLOCK: secretBlock,
        USERNAME: user.username,
        USER_ID_FOR_SRP: user.username,
      },
    };
  }

  async function authenticateWithPassword(params) {
    const username = params.USERNAME;
    const password = params.PASSWORD;
    if (!username || !password) {
      throwCognitoError('InvalidParameterException', 'USERNAME and PASSWORD are required');
    }
    const user = store.findUser(username);
    if (!user || user.password !== password) {
      throwCognitoError('NotAuthorizedException', 'Incorrect username or password.');
    }
    return { AuthenticationResult: await issueTokens(user), ChallengeParameters: {} };
  }

  async function refreshTokens(params) {
    const token = params.REFRESH_TOKEN;
    if (!token) throwCognitoError('InvalidParameterException', 'REFRESH_TOKEN is required');
    const user = findUserByRefreshToken(token);
    if (!user) throwCognitoError('NotAuthorizedException', 'Refresh Token has been revoked');
    const idToken = await signIdToken({
      sub: user.sub,
      email: user.email,
      groups: user.groups,
      poolId,
      clientId,
    });
    const accessToken = await signAccessToken({
      sub: user.sub,
      groups: user.groups,
      clientId,
      poolId,
      username: user.username,
    });
    return {
      AuthenticationResult: {
        IdToken: idToken,
        AccessToken: accessToken,
        ExpiresIn: 86400,
        TokenType: 'Bearer',
      },
      ChallengeParameters: {},
    };
  }

  async function handleRespondToAuthChallenge(body) {
    const challenge = body.ChallengeName;
    const sessionId = body.Session;
    const responses = body.ChallengeResponses || {};

    if (challenge !== 'PASSWORD_VERIFIER') {
      throwCognitoError('InvalidParameterException', `Unsupported ChallengeName: ${challenge}`);
    }
    const session = store.takeChallenge(sessionId);
    if (!session) throwCognitoError('NotAuthorizedException', 'Invalid session for the user.');

    const { USERNAME, PASSWORD_CLAIM_SIGNATURE, PASSWORD_CLAIM_SECRET_BLOCK, TIMESTAMP } = responses;
    if (USERNAME !== session.username) {
      throwCognitoError('NotAuthorizedException', 'Incorrect username or password.');
    }
    if (PASSWORD_CLAIM_SECRET_BLOCK !== session.secretBlock) {
      throwCognitoError('NotAuthorizedException', 'Incorrect username or password.');
    }

    const K = computeServerSessionKey({
      AHex: session.AHex,
      BHex: session.BHex,
      bHex: session.bHex,
      verifier: BigInt('0x' + session.verifierHex),
    });
    const expected = computeExpectedSignature(
      K,
      poolName,
      session.username,
      session.secretBlock,
      TIMESTAMP
    );
    if (expected !== PASSWORD_CLAIM_SIGNATURE) {
      throwCognitoError('NotAuthorizedException', 'Incorrect username or password.');
    }

    const user = store.findUser(session.username);
    return { AuthenticationResult: await issueTokens(user), ChallengeParameters: {} };
  }

  function handleSignUp(body) {
    const { Username, Password, UserAttributes = [] } = body;
    if (!Username || !Password) {
      throwCognitoError('InvalidParameterException', 'Username and Password are required');
    }
    if (store.findUser(Username)) {
      throwCognitoError('UsernameExistsException', 'User already exists');
    }
    const attrs = Object.fromEntries(UserAttributes.map((a) => [a.Name, a.Value]));
    const user = store.addUser({
      email: attrs.email || Username,
      password: Password,
      username: Username,
      attributes: attrs,
    });
    logInfo('cognito', `SignUp: ${user.username} (auto-confirmed)`);
    return {
      UserConfirmed: true,
      UserSub: user.sub,
      CodeDeliveryDetails: { Destination: 'local', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
    };
  }

  async function handleGetUser(body) {
    const user = await userFromAccessToken(body.AccessToken);
    const attributes = Object.entries(user.attributes).map(([Name, Value]) => ({ Name, Value }));
    attributes.push({ Name: 'sub', Value: user.sub });
    return {
      Username: user.username,
      UserAttributes: attributes,
      MFAOptions: [],
      PreferredMfaSetting: '',
      UserMFASettingList: [],
    };
  }

  async function handleGlobalSignOut(body) {
    const user = await userFromAccessToken(body.AccessToken);
    user.refreshTokens.clear();
    return {};
  }

  function handleConfirmForgotPassword(body, res) {
    const user = store.findUser(body.Username);
    if (!user) return cognitoError(res, 404, 'UserNotFoundException', 'User does not exist');
    // Replace password: recompute verifier with the same salt.
    user.password = body.Password;
    user.verifierHex = computeVerifier(
      poolName,
      user.username,
      body.Password,
      user.saltHex
    ).toString(16);
    return res.json({});
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function issueTokens(user) {
    const idToken = await signIdToken({
      sub: user.sub,
      email: user.email,
      groups: user.groups,
      poolId,
      clientId,
    });
    const accessToken = await signAccessToken({
      sub: user.sub,
      groups: user.groups,
      clientId,
      poolId,
      username: user.username,
    });
    const refreshToken = mintRefreshToken(user);
    return {
      IdToken: idToken,
      AccessToken: accessToken,
      RefreshToken: refreshToken,
      ExpiresIn: 86400,
      TokenType: 'Bearer',
    };
  }

  function mintRefreshToken(user) {
    const token = 'rt_' + randomBytes(24).toString('hex');
    user.refreshTokens.add(token);
    return token;
  }

  function findUserByRefreshToken(token) {
    for (const user of store._all()) {
      if (user.refreshTokens.has(token)) return user;
    }
    return null;
  }

  async function userFromAccessToken(token) {
    let payload;
    try {
      payload = await verifyToken(token);
    } catch {
      throwCognitoError('NotAuthorizedException', 'Access Token has been revoked');
    }
    const user = store._all().find((u) => u.sub === payload.sub);
    if (!user) throwCognitoError('UserNotFoundException', 'User not found');
    return user;
  }

  return app;
}

/**
 * Raise a Cognito-shaped error by throwing — the dispatcher catches it and
 * writes the correct response.
 */
function throwCognitoError(name, message) {
  const err = new Error(message);
  err.name = name;
  err.statusCode = name === 'NotImplementedException' ? 501 : 400;
  throw err;
}

/**
 * Write a Cognito-shaped error response. The SDK looks at `__type` and
 * `message`, not the HTTP body structure.
 */
function cognitoError(res, status, name, message) {
  res.status(status).json({ __type: name, message });
}

/**
 * Big hex numbers from the SDK sometimes arrive with a leading "00" byte
 * padding or with uppercase digits. Normalise to lowercase with the pad
 * byte trimmed so we can match byte-for-byte when hashing.
 */
function normalizeHex(h) {
  if (!h) return h;
  let out = String(h).toLowerCase();
  if (out.length > 2 && out.startsWith('00')) out = out.slice(2);
  return out;
}
