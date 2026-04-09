/**
 * amplify-local configuration example.
 *
 * Copy this file to your project root as `amplify-local.config.js`
 * and customize as needed.
 *
 * All fields are optional — defaults are shown in comments.
 */
export default {
  // Path to your Amplify Gen 2 backend definitions
  // Default: './amplify'
  amplifyDir: './amplify',

  // Output path for the generated amplify_outputs.json
  // Default: './amplify_outputs.json'
  output: './amplify_outputs.json',

  // Port configuration
  // Override via env vars: AMPLIFY_LOCAL_GRAPHQL_PORT, etc.
  ports: {
    graphql: 4502,
    storage: 4503,
    rest: 4504,
    dynamodb: 8000,
  },

  // Test users — static JWT tokens generated on startup.
  // Tokens written to .amplify-local/tokens.json
  // Use these in tests to authenticate as different roles.
  users: [
    { email: 'admin@test.com', sub: 'admin-uuid-1', groups: ['admins'] },
    { email: 'customer@test.com', sub: 'cust-uuid-1', groups: ['customers'] },
    { email: 'driver@test.com', sub: 'driver-uuid-1', groups: ['drivers'] },
  ],

  // REST API mock responses.
  // Each key maps to an endpoint name from your Amplify backend.
  // Routes are matched by "METHOD /path" pattern.
  rest: {
    // Example: ordersApiEndpoint: {
    //   'POST /': { status: 201, body: { id: 'mock-order-1', status: 'PENDING' } },
    //   'GET /:id': { status: 200, body: { id: ':id', status: 'DELIVERED' } },
    // },
  },

  // Seed data file — loaded on `amplify-local seed` or during `start` if set.
  // JSON file keyed by model name with arrays of items.
  // See templates/seed-example.json for the format.
  seed: null, // e.g., './test/fixtures/seed.json'

  // Storage backend (only 'filesystem' supported in v0.1)
  storageBackend: 'filesystem',
  storageDir: './.amplify-local/storage',

  // DynamoDB persistence
  dynamodbPersist: true,
  dynamodbDataDir: './.amplify-local/dynamodb-data',

  // Custom resolver overrides for Lambda-backed queries.
  // Key is the query name, value is a resolver function (args, context) => result.
  customResolvers: {
    // Example:
    // searchProducts: (args) => ({
    //   items: [{ id: 'mock-1', name: 'Mock Product', price: 9.99 }],
    //   nextToken: null,
    // }),
  },
};
