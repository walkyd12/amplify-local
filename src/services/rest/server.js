import express from 'express';

/**
 * Create an Express app that serves configurable REST API mock responses.
 *
 * Reads `config.rest` to mount routes per endpoint key. Each endpoint key
 * becomes a route prefix, and method+path combos map to configured responses.
 *
 * Config format:
 *   rest: {
 *     ordersApiEndpoint: {
 *       'POST /': { status: 201, body: { id: 'mock-order-1', status: 'PENDING' } },
 *       'GET /:id': { status: 200, body: { id: ':id', status: 'DELIVERED' } },
 *     },
 *     paymentsApiEndpoint: {
 *       'POST /charge': { status: 200, body: { success: true, chargeId: 'ch_mock_123' } },
 *     },
 *   }
 *
 * @param {object} config - Merged config object
 * @returns {express.Express}
 */
export function createRestServer(config) {
  const app = express();

  app.use(express.json({ limit: '10mb' }));

  // CORS — echo requested headers so AWS SDK v3 / Amplify headers pass.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    const requested = req.headers['access-control-request-headers'];
    res.setHeader(
      'Access-Control-Allow-Headers',
      requested ||
        'Content-Type, Authorization, x-api-key, x-amz-user-agent, amz-sdk-invocation-id, amz-sdk-request'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  const restConfig = config.rest || {};

  // Mount routes for each configured endpoint
  for (const [endpointKey, routes] of Object.entries(restConfig)) {
    const router = express.Router();

    for (const [routeSpec, responseConfig] of Object.entries(routes)) {
      const { method, path } = parseRouteSpec(routeSpec);
      const handler = createHandler(responseConfig, endpointKey);
      router[method](path, handler);
    }

    // Mount under /{endpointKey}/
    app.use(`/${endpointKey}`, router);
  }

  // Catch-all: return a default mock response for any unconfigured route
  app.all('/*splat', (req, res) => {
    // Extract endpoint key from URL (first path segment)
    const segments = req.path.split('/').filter(Boolean);
    const endpoint = segments[0] || 'unknown';
    const subPath = '/' + segments.slice(1).join('/');

    res.json({
      message: 'mock',
      endpoint,
      method: req.method,
      path: subPath || '/',
    });
  });

  return app;
}

/**
 * Parse a route spec like "POST /orders" into { method, path }.
 */
function parseRouteSpec(spec) {
  const parts = spec.trim().split(/\s+/);
  if (parts.length === 2) {
    return { method: parts[0].toLowerCase(), path: parts[1] };
  }
  // Default to GET if no method specified
  return { method: 'get', path: parts[0] || '/' };
}

/**
 * Create an Express route handler from a response config object.
 *
 * Response config can be:
 *   { status: 200, body: { ... } }
 *   { status: 200, body: { id: ':id' } }  — :param replaced with req.params
 *   A function (req, res) => { ... }
 */
function createHandler(responseConfig, endpointKey) {
  // If the config is a function, use it directly
  if (typeof responseConfig === 'function') {
    return responseConfig;
  }

  return (req, res) => {
    const status = responseConfig.status || 200;
    let body = responseConfig.body;

    if (body && typeof body === 'object') {
      // Deep clone and replace :param placeholders with actual values
      body = replaceParams(JSON.parse(JSON.stringify(body)), req.params);
    }

    const headers = responseConfig.headers || {};
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }

    res.status(status).json(body || { message: 'mock', endpoint: endpointKey });
  };
}

/**
 * Recursively replace ":paramName" string values in an object
 * with actual values from req.params.
 */
function replaceParams(obj, params) {
  if (typeof obj === 'string' && obj.startsWith(':') && params[obj.slice(1)] !== undefined) {
    return params[obj.slice(1)];
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => replaceParams(item, params));
  }

  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      obj[key] = replaceParams(value, params);
    }
  }

  return obj;
}
