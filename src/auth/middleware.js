import { verifyToken } from './jwt.js';

/**
 * Create Express middleware that extracts auth context from the request.
 *
 * Sets req.authContext to one of:
 *   { type: 'apiKey' }
 *   { type: 'userPool', sub, email, groups }
 *   { type: 'iam', authenticated: false }
 *
 * Never rejects — just attaches context. Auth enforcement happens per-operation.
 */
export function createAuthMiddleware(apiKey) {
  return async (req, _res, next) => {
    // Check x-api-key header
    const requestApiKey = req.headers['x-api-key'];
    if (requestApiKey) {
      req.authContext = {
        type: 'apiKey',
        valid: requestApiKey === apiKey,
      };
      return next();
    }

    // Check Authorization header. AppSync / Amplify send the raw JWT with
    // no scheme (e.g. `Authorization: eyJ...`), but curl-style clients and
    // the docs examples use `Bearer <token>`. Accept both.
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (authHeader) {
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;
      try {
        const payload = await verifyToken(token);
        req.authContext = {
          type: 'userPool',
          sub: payload.sub,
          email: payload.email,
          groups: payload['cognito:groups'] || [],
        };
      } catch {
        // Invalid token — treat as unauthenticated
        req.authContext = {
          type: 'userPool',
          sub: null,
          email: null,
          groups: [],
          invalid: true,
        };
      }
      return next();
    }

    // No auth header — unauthenticated/IAM context
    req.authContext = {
      type: 'iam',
      authenticated: false,
    };
    next();
  };
}
