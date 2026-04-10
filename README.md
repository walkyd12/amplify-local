# amplify-local

Local emulator for AWS Amplify Gen 2 -- run your backend locally with zero AWS credentials.

Reads your `amplify/` TypeScript backend definitions and spins up local replacements for AppSync (GraphQL), DynamoDB, S3, and REST APIs. Generates an `amplify_outputs.json` your frontend consumes with zero code changes.

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **Docker** (for DynamoDB Local)

### Install

```bash
npm install amplify-local
```

### 1. Start DynamoDB Local

```bash
npx amplify-local docker:start
```

### 2. Start the emulator

```bash
npx amplify-local start --amplify-dir ./amplify
```

This will:
- Parse your `amplify/data/resource.ts` schema
- Create DynamoDB tables matching your models
- Start a GraphQL server on `http://localhost:4502/graphql`
- Start an S3-compatible storage server on `http://localhost:4503`
- Generate `amplify_outputs.json` in your project root

### 3. Point your frontend

Your Amplify frontend libraries will automatically pick up the generated `amplify_outputs.json` -- no code changes needed.

### 4. Stop

```bash
npx amplify-local stop
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `start` | Start all emulated services |
| `stop` | Stop all running services |
| `status` | Health check running services |
| `generate` | Generate `amplify_outputs.json` without starting services |
| `setup-tables` | Create DynamoDB tables from schema |
| `seed` | Load seed data from a JSON file |
| `docker:start` | Start DynamoDB Local via Docker Compose |
| `docker:stop` | Stop DynamoDB Local container |

### Global Options

```
--amplify-dir <path>   Path to amplify/ directory (default: ./amplify)
--config <path>        Path to amplify-local.config.js
--verbose              Enable verbose error logging
```

### Start Options

```
--no-storage           Skip the storage server
--no-rest              Skip the REST mock server
--ephemeral            Use in-memory DynamoDB (no persistence)
```

## Configuration

Create an `amplify-local.config.js` in your project root:

```javascript
export default {
  amplifyDir: './amplify',
  output: './amplify_outputs.json',

  ports: {
    graphql: 4502,
    storage: 4503,
    rest: 4504,
    dynamodb: 8000,
  },

  // Test users -- tokens are auto-generated on startup
  users: [
    { email: 'admin@test.com', sub: 'admin-uuid-1', groups: ['admins'] },
    { email: 'user@test.com', sub: 'user-uuid-1', groups: ['customers'] },
  ],

  // Mock REST API endpoints
  rest: {
    ordersApiEndpoint: {
      'POST /': { status: 201, body: { id: 'mock-order-1', status: 'PENDING' } },
      'GET /:id': { status: 200, body: { id: ':id', status: 'DELIVERED' } },
    },
  },

  // Seed data file
  seed: './seed.json',

  // Storage settings
  storageBackend: 'filesystem',
  storageDir: './.amplify-local/storage',

  // DynamoDB persistence
  dynamodbPersist: true,
  dynamodbDataDir: './.amplify-local/dynamodb-data',

  // Override Lambda-backed custom query stubs
  customResolvers: {},
};
```

Ports can also be overridden via environment variables:

```bash
AMPLIFY_LOCAL_GRAPHQL_PORT=4502
AMPLIFY_LOCAL_STORAGE_PORT=4503
AMPLIFY_LOCAL_REST_PORT=4504
AMPLIFY_LOCAL_DYNAMODB_PORT=8000
```

## Authentication

amplify-local generates Cognito-compatible JWTs for configured test users. Tokens are written to `.amplify-local/tokens.json` on startup.

Use them in requests:

```bash
# API Key auth (public access)
curl http://localhost:4502/graphql \
  -H "x-api-key: local-api-key-000000" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ listProducts { items { id name } } }"}'

# User Pool auth (authenticated access)
TOKEN=$(jq -r '."admin@test.com".idToken' .amplify-local/tokens.json)
curl http://localhost:4502/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ listProducts { items { id name } } }"}'
```

Supported auth strategies: `public` (apiKey / identityPool), `private`, `groups`, and `owner`.

## Seed Data

Create a JSON file keyed by model name:

```json
{
  "Category": [
    { "name": "Electronics", "description": "Gadgets and devices" }
  ],
  "Product": [
    { "name": "Headphones", "price": 79.99, "categoryId": "cat-1" }
  ]
}
```

Missing `id`, `createdAt`, and `updatedAt` fields are auto-generated.

```bash
npx amplify-local seed --file ./seed.json
npx amplify-local seed --file ./seed.json --reset  # drop tables first
```

## What Gets Emulated

| Amplify Service | Local Replacement |
|-----------------|-------------------|
| AppSync (GraphQL) | Express + `@graphql-tools/schema` on port 4502 |
| DynamoDB | DynamoDB Local (Docker) on port 8000 |
| S3 Storage | Filesystem-backed Express server on port 4503 |
| Cognito Auth | Static JWT tokens with RSA-2048 signing |
| REST APIs | Express mock router on port 4504 |

### GraphQL Features

- Full CRUD mutations (create, update, delete) with auto-generated `id` and timestamps
- List queries with filtering (`eq`, `ne`, `gt`, `lt`, `contains`, `beginsWith`, `between`, etc.)
- Relationship resolution (`belongsTo`, `hasMany`)
- Secondary index queries
- Auth enforcement per model/operation
- GraphQL Playground at `GET /graphql`

### Storage Features

- `PUT`, `GET`, `DELETE`, `HEAD` for objects
- `ListObjectsV2`-compatible listing with prefix filtering
- Path-based access control matching Amplify storage rules

## Project Structure

```
amplify-local/
  bin/amplify-local.js        CLI entry point
  src/
    cli.js                    Commander.js CLI definition
    config.js                 Configuration loader
    orchestrator.js           Service startup/shutdown
    docker.js                 Docker Compose management
    parser/                   Amplify schema parser (TS import + extraction)
    auth/                     JWT generation, middleware, auth enforcement
    generator/                amplify_outputs.json generation
    dynamo/                   DynamoDB client, table creation, seeding
    services/
      graphql/                GraphQL server, schema gen, resolvers, filters
      storage/                S3-compatible storage server
      rest/                   REST API mock server
  docker/
    docker-compose.yml        DynamoDB Local service
  templates/                  Example config and seed files
```

## License

Apache-2.0
