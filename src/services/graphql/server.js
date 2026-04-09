import express from 'express';
import { graphql } from 'graphql';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { generateSDL } from './schema-generator.js';
import { buildResolvers } from './resolver-factory.js';
import { wrapResolversWithAuth } from './auth-enforcer.js';
import { buildCustomQueryResolvers } from './custom-queries.js';
import { createAuthMiddleware } from '../../auth/middleware.js';

/**
 * Create an Express app serving a GraphQL endpoint with auth enforcement.
 *
 * - POST /graphql — execute queries/mutations with auth context
 * - GET  /graphql — serve GraphQL Playground UI
 * - CORS enabled for all origins (local dev)
 * - AppSync-compatible error format: { data, errors: [{ message, errorType }] }
 *
 * @param {object} options
 * @param {object} options.config - Merged config (ports, customResolvers, etc.)
 * @param {object} options.parsedSchema - Output of parseSchema()
 * @param {DynamoDBDocumentClient} options.docClient - DynamoDB document client
 * @param {object} options.enforcer - Auth enforcer from createAuthEnforcer()
 * @param {string} options.apiKey - The local API key string
 * @returns {express.Express} Express app (not yet listening)
 */
export function createGraphQLServer({ config, parsedSchema, docClient, enforcer, apiKey }) {
  const app = express();

  // Middleware
  app.use(express.json({ limit: '10mb' }));
  app.use(cors());
  app.use(createAuthMiddleware(apiKey));

  // Build schema with resolvers
  const schema = buildExecutableSchema(parsedSchema, docClient, enforcer, config);

  // POST /graphql — execute GraphQL operations
  app.post('/graphql', async (req, res) => {
    try {
      const { query, variables, operationName } = req.body || {};

      if (!query) {
        return res.status(400).json({
          errors: [{ message: 'Missing query in request body', errorType: 'BadRequest' }],
        });
      }

      const result = await graphql({
        schema,
        source: query,
        variableValues: variables || {},
        operationName: operationName || undefined,
        contextValue: {
          authContext: req.authContext,
        },
      });

      // Format errors to match AppSync format
      const response = { data: result.data || null };
      if (result.errors && result.errors.length > 0) {
        response.errors = result.errors.map(formatError);
      }

      res.json(response);
    } catch (err) {
      res.status(500).json({
        errors: [{ message: err.message, errorType: 'InternalError' }],
      });
    }
  });

  // GET /graphql — serve GraphQL Playground
  app.get('/graphql', (_req, res) => {
    res.type('html').send(playgroundHTML(config.ports?.graphql || 4502));
  });

  return app;
}

/**
 * Build the complete executable schema with auth-wrapped resolvers
 * and custom query stubs merged in.
 */
function buildExecutableSchema(parsedSchema, docClient, enforcer, config) {
  // Generate SDL and base resolvers
  const sdl = generateSDL(parsedSchema);
  const baseResolvers = buildResolvers(parsedSchema, docClient);

  // Build custom query resolvers
  const { queryResolvers: customQueryResolvers } = buildCustomQueryResolvers(parsedSchema, config);

  // Merge custom query resolvers into the base resolvers
  if (Object.keys(customQueryResolvers).length > 0) {
    baseResolvers.Query = { ...baseResolvers.Query, ...customQueryResolvers };
  }

  // Wrap all resolvers with auth enforcement
  const wrappedResolvers = wrapResolversWithAuth(baseResolvers, parsedSchema, enforcer);

  // Build executable schema
  return makeExecutableSchema({
    typeDefs: sdl,
    resolvers: wrappedResolvers,
  });
}

/**
 * Format a GraphQL error to match AppSync error shape.
 */
function formatError(error) {
  const formatted = {
    message: error.message,
    errorType: error.extensions?.errorType || 'ExecutionError',
  };

  if (error.locations) {
    formatted.locations = error.locations;
  }

  if (error.path) {
    formatted.path = error.path;
  }

  return formatted;
}

/**
 * Simple CORS middleware for local development.
 */
function cors() {
  return (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (_req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    next();
  };
}

/**
 * HTML page that loads GraphQL Playground from a CDN.
 */
function playgroundHTML(port) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>amplify-local GraphQL Playground</title>
  <link rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.26/build/static/css/index.css" />
  <link rel="shortcut icon"
    href="https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.26/build/favicon.png" />
  <script
    src="https://cdn.jsdelivr.net/npm/graphql-playground-react@1.7.26/build/static/js/middleware.js">
  </script>
</head>
<body>
  <div id="root"></div>
  <script>
    window.addEventListener('load', function() {
      GraphQLPlayground.init(document.getElementById('root'), {
        endpoint: 'http://localhost:${port}/graphql',
        settings: {
          'request.credentials': 'omit',
        },
        tabs: [
          {
            endpoint: 'http://localhost:${port}/graphql',
            name: 'API Key Auth',
            headers: { 'x-api-key': 'local-api-key-000000' },
          },
        ],
      });
    });
  </script>
</body>
</html>`;
}
