# amplify-local - Project Plan

## Executive Summary

### Business Context
AWS Amplify Gen 2 has no local emulation story. `npx ampx sandbox` still provisions real AWS resources. Developers need a way to run their full Amplify backend locally for testing, CI, and offline development. `amplify-local` is an open-source npm package that reads an Amplify Gen 2 project's TypeScript backend definitions (`amplify/` directory) and spins up local replacements for AppSync (GraphQL), DynamoDB, and S3 — producing an `amplify_outputs.json` that the frontend consumes with zero code changes.

### Current State
- No official Amplify local emulator exists for Gen 2
- `ampx sandbox` provisions real cloud resources (slow, costs money, needs credentials)
- Existing tools like `cognito-local` or `dynamodb-local` solve individual pieces but nothing ties them together
- Every Amplify Gen 2 project has this same pain point

### Goals
1. Single CLI command to start a full local Amplify backend from `amplify/` directory
2. Works with any Amplify Gen 2 project — no project-specific configuration needed
3. Generates an `amplify_outputs.json` the frontend consumes with zero code changes
4. Supports GraphQL CRUD with auth rule enforcement via static tokens
5. Supports S3-compatible storage via local filesystem
6. Provides seed/reset utilities for deterministic testing
7. Works in CI without Docker-in-Docker
8. Zero live AWS credentials required — reads only TypeScript source definitions
9. Publishable to npm with minimal dependency surface

### Non-Goals
- Full Cognito sign-in flow emulation (opt-in tier 2 via `cognito-local`)
- Full AppSync VTL resolver compatibility
- GraphQL subscriptions via WebSocket in v1
- Lambda function execution (custom resolvers return configurable mocks)
- CloudFormation/CDK emulation
- Gen 1 support
- MinIO/full S3 API compatibility (opt-in tier 2)

## Design Philosophy: Tiered Auth & Storage

### Auth Tiers

**Tier 1 — Static Tokens (ships with amplify-local):**
The harness does not emulate Cognito at all. Instead, it generates pre-signed JWTs for test users defined in config. The GraphQL and Storage servers validate these tokens and enforce auth rules (groups, owner, public). This tests that your auth *rules* work correctly without testing the sign-in *flow*. Zero external auth dependencies.

```javascript
// amplify-local.config.js
users: [
  { email: 'admin@test.com', sub: 'admin-uuid-1', groups: ['admins'] },
  { email: 'customer@test.com', sub: 'cust-uuid-1', groups: ['customers'] },
  { email: 'driver@test.com', sub: 'driver-uuid-1', groups: ['drivers'] },
]
```

On startup, the harness generates JWT tokens for each user and writes them to `.amplify-local/tokens.json`:
```json
{
  "admin@test.com": {
    "idToken": "eyJ...",
    "accessToken": "eyJ..."
  }
}
```

Tests grab tokens from this file (or via a helper function) and pass them as `Authorization` headers. The GraphQL server validates them against a local RSA key pair and enforces the model auth rules extracted from the backend definition.

**Tier 2 — cognito-local (opt-in, project-specific):**
Users who need actual `signIn()`/`signUp()` flow testing install `cognito-local` separately and configure the harness to delegate to it. Not shipped as a dependency, not in the plan scope for v0.1.

**Tier 3 — Real AWS (project-specific):**
Full auth integration (SRP, MFA, token refresh) uses a real Cognito sandbox. Runs in CI with AWS credentials. Out of scope for this package.

### Storage Tiers

**Tier 1 — Local Filesystem (ships with amplify-local):**
A minimal S3-compatible HTTP server backed by the local filesystem. Handles the API surface the Amplify SDK actually uses: PUT, GET, DELETE, HEAD, LIST. Files stored in `.amplify-local/storage/`. Path-based access rules enforced from the backend storage definition. Zero external dependencies.

**Tier 2 — MinIO (opt-in, project-specific):**
Users who need full S3 compatibility (presigned URL expiry, multipart upload, CORS) run MinIO themselves. The harness can proxy to it. Not shipped, not in scope for v0.1.

---

## Technical Overview

### Input: TypeScript Backend Definitions

Instead of reading `amplify_outputs.json` (which contains live credentials), the harness imports the project's TypeScript backend definitions at runtime using `tsx`. The Amplify DSL objects are fully inspectable:

```
data.props.schema.models          → all models
  model.data.fields               → scalar field definitions (fieldType, required, array, default)
  model.fields                    → all fields including relationships
    field.data.relatedModel       → relationship target (for belongsTo/hasMany)
    field.data.type               → 'belongsTo' | 'hasMany'
    field.data.references         → foreign key fields
  model.data.secondaryIndexes     → GSIs (partitionKey, sortKeys)
  model.data.authorization        → auth rules (via Symbol(data)):
    { strategy, provider, operations, groups, groupOrOwnerField }
  model.data.identifier           → primary key fields

data.props.schema.data.types      → enums and custom types
data.props.authorizationModes     → default auth mode, API key config
```

Auth rules are stored behind `Symbol(data)` on each authorization entry and contain:
- `strategy`: 'public' | 'private' | 'groups' | 'owner'
- `provider`: 'identityPool' | 'apiKey' | 'userPools'
- `operations`: ['read'] | ['create', 'update', 'delete', 'read']
- `groups`: ['admins'] | undefined
- `groupOrOwnerField`: field name for owner-based auth

### Output: Generated `amplify_outputs.json`

The harness generates a complete `amplify_outputs.json` from scratch — not rewriting an existing one. It constructs the `model_introspection` section from the parsed TypeScript definitions and points all endpoints to localhost. No live credentials are ever read or written.

### Package Structure

```
amplify-local/
├── package.json
├── bin/
│   └── amplify-local.js              # CLI entry point
├── src/
│   ├── cli.js                        # Command parser
│   ├── parser/
│   │   ├── index.js                  # Orchestrates TS import + extraction
│   │   ├── importer.js               # tsx-based import of amplify/ definitions
│   │   ├── models.js                 # Extract models, fields, relationships
│   │   ├── auth-rules.js             # Extract auth rules from Symbol(data)
│   │   ├── indexes.js                # Extract GSIs and primary keys
│   │   └── enums.js                  # Extract enum types
│   ├── generator/
│   │   ├── outputs.js                # Generate amplify_outputs.json
│   │   └── introspection.js          # Build model_introspection from parsed schema
│   ├── auth/
│   │   ├── jwt.js                    # RSA key gen, JWT signing, JWKS
│   │   ├── token-manager.js          # Generate tokens for configured test users
│   │   └── middleware.js             # Validate tokens, extract user context
│   ├── services/
│   │   ├── manager.js                # Start/stop/health-check all services
│   │   ├── graphql/
│   │   │   ├── server.js             # GraphQL endpoint
│   │   │   ├── schema-generator.js   # Parsed schema → GraphQL SDL
│   │   │   ├── resolver-factory.js   # Generic CRUD resolvers
│   │   │   ├── filters.js            # DynamoDB filter builder
│   │   │   ├── auth-enforcer.js      # Per-model auth rule enforcement
│   │   │   └── custom-queries.js     # Lambda query stubs
│   │   ├── storage/
│   │   │   ├── server.js             # S3-compatible filesystem server
│   │   │   └── policy.js             # Path-based access rules
│   │   └── rest/
│   │       ├── server.js             # Custom API mocks
│   │       └── handler.js            # Configurable responses
│   ├── dynamo/
│   │   ├── client.js                 # DynamoDB Local client
│   │   ├── table-creator.js          # Create tables from parsed schema
│   │   └── seeder.js                 # Batch-write seed data
│   └── utils/
│       ├── logger.js
│       ├── ports.js
│       └── health.js
├── docker/
│   └── docker-compose.yml            # Optional DynamoDB Local
├── templates/
│   ├── seed-example.json
│   └── config-example.js
└── test/
    ├── fixtures/
    │   └── minimal-amplify/          # Minimal amplify/ directory for testing
    ├── unit/
    └── integration/
```

### Tech Stack
- **Node.js 18+** (ESM)
- **tsx** — import TypeScript backend definitions at runtime
- **Express** — all emulated services
- **graphql** + **@graphql-tools/schema** — GraphQL execution
- **jose** — JWT creation/validation, JWKS
- **@aws-sdk/client-dynamodb** + **@aws-sdk/lib-dynamodb** — DynamoDB client
- **commander** — CLI
- **chalk** + **ora** — CLI output

### External Dependencies (user provides)
- **DynamoDB Local** — Docker or Java JAR (we detect & guide)

### Port Allocation (configurable)
| Service | Default Port | Env Override |
|---|---|---|
| GraphQL Server | 4502 | AMPLIFY_LOCAL_GRAPHQL_PORT |
| S3 Storage | 4503 | AMPLIFY_LOCAL_STORAGE_PORT |
| Custom API Mock | 4504 | AMPLIFY_LOCAL_REST_PORT |
| DynamoDB Local | 8000 | AMPLIFY_LOCAL_DYNAMODB_PORT |

---

## CLI Interface

```bash
npm install --save-dev amplify-local

# Start everything (reads ./amplify/ directory by default)
npx amplify-local start
npx amplify-local start --amplify-dir ./path/to/amplify
npx amplify-local start --no-storage --no-rest
npx amplify-local start --ephemeral     # in-memory DynamoDB, no persistence

# Generate amplify_outputs.json only (don't start services)
npx amplify-local generate
npx amplify-local generate --out ./amplify_outputs.json

# Create DynamoDB tables (useful for CI with sidecar DynamoDB)
npx amplify-local setup-tables
npx amplify-local setup-tables --reset

# Seed data
npx amplify-local seed --file ./test/seed-data.json
npx amplify-local seed --reset

# Health check
npx amplify-local status

# Stop
npx amplify-local stop

# Docker helper
npx amplify-local docker:start
npx amplify-local docker:stop
```

### Configuration File (optional `amplify-local.config.js`)

```javascript
export default {
  // Path to amplify/ directory (default: ./amplify)
  amplifyDir: './amplify',

  // Output path for generated amplify_outputs.json
  output: './amplify_outputs.json',

  // Port overrides
  ports: { graphql: 4502, storage: 4503, rest: 4504 },

  // Test users — tokens generated on startup
  users: [
    { email: 'admin@test.com', sub: 'admin-uuid-1', groups: ['admins'] },
    { email: 'customer@test.com', sub: 'cust-uuid-1', groups: ['customers'] },
    { email: 'driver@test.com', sub: 'driver-uuid-1', groups: ['drivers'] },
  ],

  // Custom API mock overrides
  rest: {
    ordersApiEndpoint: {
      'POST /': { status: 201, body: { id: 'mock-order-1', status: 'PENDING' } },
    },
  },

  // Seed data file
  seed: './test/fixtures/seed.json',

  // Storage backend
  storageBackend: 'filesystem',   // only option in v0.1
  storageDir: './.amplify-local/storage',

  // DynamoDB persistence
  dynamodbPersist: true,
  dynamodbDataDir: './.amplify-local/dynamodb-data',

  // Custom resolver overrides for Lambda-backed queries
  customResolvers: {},
};
```

### Test Usage Pattern

```javascript
// test/helpers.js
import { readFileSync } from 'fs';

const tokens = JSON.parse(readFileSync('.amplify-local/tokens.json', 'utf8'));

export const adminToken = tokens['admin@test.com'].idToken;
export const customerToken = tokens['customer@test.com'].idToken;

export async function graphql(query, variables, token) {
  const res = await fetch('http://localhost:4502/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : { 'x-api-key': 'local-api-key' }),
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// test/products.test.js
import { adminToken, customerToken, graphql } from './helpers.js';

test('admin can create product', async () => {
  const result = await graphql(
    `mutation { createProduct(input: { name: "Apples", price: 3.99 }) { id name } }`,
    {},
    adminToken
  );
  expect(result.data.createProduct.name).toBe('Apples');
});

test('customer cannot create product', async () => {
  const result = await graphql(
    `mutation { createProduct(input: { name: "Hack", price: 0 }) { id } }`,
    {},
    customerToken
  );
  expect(result.errors[0].errorType).toBe('Unauthorized');
});

test('public can read products via API key', async () => {
  const result = await graphql(`query { listProducts { items { id name } } }`);
  expect(result.data.listProducts.items.length).toBeGreaterThan(0);
});
```

---

## Epics

### Epic 1: Package Scaffold & CLI

**Business Value**: Users can install and run the CLI. Foundation for everything.

**Success Criteria**: `npx amplify-local --help` works, `npx amplify-local generate` produces an outputs file.

- [ ] **Story 1.1.1**: Initialize npm package with CLI entry point
  - package.json (name, type:module, bin, engines>=18), commander, stubbed subcommands, .gitignore, LICENSE (MIT)
  - **AC**: `amplify-local --help` shows all commands

- [ ] **Story 1.1.2**: Config loader
  - Find `amplify/` directory (CWD or --amplify-dir), load optional config file, merge defaults + config + CLI flags
  - **AC**: Parses config, errors clearly on missing amplify dir

---

### Epic 2: Schema Parser (TypeScript Backend → Parsed Schema)

**Business Value**: The core engine — reads TypeScript definitions and produces a structured schema object that all other components consume.

**Success Criteria**: Parser extracts all models, fields, relationships, auth rules, indexes, and enums from any Amplify Gen 2 backend definition.

- [ ] **Story 2.1.1**: TypeScript importer
  - Use `tsx` to import `amplify/data/resource.ts` at runtime
  - Navigate to `data.props.schema` and extract the schema object
  - Handle import errors gracefully (missing deps, syntax errors)
  - **AC**: Successfully imports and returns raw schema from a real Amplify project

- [ ] **Story 2.1.2**: Model and field extractor
  - Iterate `schema.models`, extract:
    - Scalar fields from `model.data.fields` (fieldType, required, array, default)
    - Relationship fields from `model.fields` where `data.fieldType === 'model'` (relatedModel, type, references)
    - Enum fields (where field has `type: 'enum'` and `values` array)
  - Produce normalized structure:
    ```javascript
    { modelName: { fields: { name: { type: 'String', required: true, ... } }, relationships: { store: { type: 'belongsTo', model: 'Store', references: ['storeId'] } } } }
    ```
  - **AC**: Extracts all 25+ models from Stocked schema with correct field types and relationships

- [ ] **Story 2.1.3**: Auth rule extractor
  - Read `model.data.authorization` array
  - For each entry, extract via `Object.getOwnPropertySymbols()` to find `Symbol(data)`
  - Produce normalized rules:
    ```javascript
    { modelName: { authorization: [{ strategy: 'public', provider: 'apiKey', operations: ['read'] }, { strategy: 'groups', groups: ['admins'], operations: ['create','read','update','delete'] }] } }
    ```
  - **AC**: Correctly extracts all auth strategies (public/apiKey, public/iam, private, groups, owner) from real schema

- [ ] **Story 2.1.4**: Index extractor
  - Read `model.data.secondaryIndexes` array
  - Extract partitionKey, sortKeys, indexName, queryField
  - Read `model.data.identifier` for primary key
  - **AC**: All GSIs extracted including composite keys (partition + sort)

- [ ] **Story 2.1.5**: Enum extractor
  - Extract from `schema.data.types` and from inline enum fields
  - **AC**: All enum types extracted with values

- [ ] **Story 2.1.6**: Auth and storage config extractor
  - Parse `data.props.authorizationModes` (defaultAuthMode, apiKey config)
  - Import and parse `amplify/auth/resource.ts` if present (groups, password policy)
  - Import and parse `amplify/storage/resource.ts` if present (bucket paths, permissions)
  - **AC**: Auth modes, user groups, storage paths all extracted

---

### Epic 3: Output Generator

**Business Value**: Produces a valid `amplify_outputs.json` from parsed schema — no live credentials needed.

**Success Criteria**: Generated file passes `Amplify.configure()` and makes frontend talk to local services.

- [ ] **Story 3.1.1**: Build model_introspection from parsed schema
  - Convert parsed models/fields/relationships/indexes/enums into the `model_introspection` format that the Amplify client expects (matching the structure in a real `amplify_outputs.json`)
  - This is the reverse of what the parser does — taking our normalized format and producing the Amplify introspection format
  - **AC**: Generated introspection matches the structure a real deployment produces

- [ ] **Story 3.1.2**: Generate complete amplify_outputs.json
  - Build full outputs file:
    - `auth` section with fake pool IDs, region, password policy, groups from parsed auth config
    - `data` section with localhost GraphQL URL, local API key, generated introspection
    - `storage` section with local bucket name, paths from parsed storage config
    - `custom` section with localhost REST endpoints
    - `version: "1.4"`
  - **AC**: Frontend boots with `Amplify.configure(outputs)` without errors

- [ ] **Story 3.1.3**: Wire `generate` CLI command
  - **AC**: `amplify-local generate` writes file and prints summary

---

### Epic 4: Auth — Static Token System

**Business Value**: Tests can authenticate as different user roles without Cognito. Auth rules enforced on GraphQL and Storage.

**Success Criteria**: Tokens generated for configured users, GraphQL server enforces model auth rules.

- [ ] **Story 4.1.1**: JWT infrastructure
  - Generate/persist RSA-2048 key pair in `.amplify-local/keys/`
  - `signIdToken(claims)` → JWT with iss, aud, token_use:id, sub, email, cognito:username, cognito:groups (RS256)
  - `signAccessToken(claims)` → JWT with token_use:access, client_id, scope
  - `getJwks()` → JWKS JSON with public key
  - `verifyToken(token)` → decoded claims
  - **AC**: Tokens decode correctly, JWKS valid, keys persist across restarts

- [ ] **Story 4.1.2**: Token manager
  - Read users from config
  - For each user, generate idToken and accessToken with correct claims (sub, email, groups)
  - Write to `.amplify-local/tokens.json`
  - Also generate a local API key string
  - **AC**: tokens.json contains valid JWTs for all configured users

- [ ] **Story 4.1.3**: Auth middleware
  - Express middleware that extracts auth context from request:
    - `x-api-key` header → API key auth context
    - `Authorization: Bearer {token}` → decode JWT, extract sub, email, groups
    - No auth → unauthenticated/IAM context
  - Attach auth context to request for downstream use
  - **AC**: Middleware correctly identifies auth type and extracts claims

- [ ] **Story 4.1.4**: Auth rule enforcer
  - Given a model name, operation (read/create/update/delete), and auth context:
    - Check parsed auth rules for the model
    - Evaluate: public+apiKey (check key), public+iam (allow), private (any valid token), groups (check cognito:groups), owner (match owner field to sub)
  - For list operations with owner rules: return filter to inject
  - `authorize(modelName, operation, authContext, item?)` → allowed/denied with reason
  - **AC**: Correctly allows/denies based on all strategy types from real schema

---

### Epic 5: DynamoDB Table Management

**Business Value**: Tables matching the schema exist in DynamoDB Local.

**Success Criteria**: `amplify-local setup-tables` creates all tables with correct keys and GSIs.

- [ ] **Story 5.1.1**: DynamoDB client factory
  - getDynamoClient/getDocClient with dummy creds, configurable endpoint

- [ ] **Story 5.1.2**: Table creator from parsed schema
  - For each parsed model:
    - Table name = model name (e.g., `Product`, `Order`) 
    - Primary key from parsed identifier
    - GSIs from parsed indexes (partitionKey → HASH, sortKeys[0] → RANGE)
    - Type mapping: ID/String/AWSDateTime/enum → S, Int/Float → N
    - On-demand billing
  - Idempotent + reset support
  - **AC**: Creates all tables, GSIs correct including composite keys

- [ ] **Story 5.1.3**: Wire `setup-tables` CLI command

---

### Epic 6: GraphQL Emulator

**Business Value**: All data operations work against local DynamoDB with auth enforcement.

**Success Criteria**: GraphQL CRUD with filtering, pagination, relationships, and auth.

- [ ] **Story 6.1.1**: Schema generator (parsed schema → GraphQL SDL)
  - Enums, object types (scalar + relationship fields), connection types, input types, filter types
  - Query type: get, list, GSI queries, custom queries
  - Mutation type: create, update, delete
  - NonModel types and custom query return types
  - **AC**: Valid executable GraphQL schema from real parsed schema

- [ ] **Story 6.2.1**: Generic CRUD resolver factory
  - get → GetCommand, list → ScanCommand+filters+pagination, GSI → QueryCommand
  - create → PutCommand+auto id/timestamps, update → UpdateCommand, delete → DeleteCommand
  - Association resolvers: belongsTo → GetCommand, hasMany → Query on GSI
  - Filter builder: eq, ne, gt, lt, contains, beginsWith, between, and/or/not → DynamoDB expressions
  - **AC**: CRUD, filters, pagination, GSI queries, associations all work

- [ ] **Story 6.2.2**: Custom query resolver stubs
  - Auto-detect from parsed schema custom queries
  - Generate scan-based resolvers with argument filtering
  - Config overrides via customResolvers
  - **AC**: Custom queries return plausible data, overrides work

- [ ] **Story 6.3.1**: GraphQL server
  - POST /graphql with auth middleware + auth enforcer
  - Auth context from x-api-key or Authorization header
  - GET /graphql → playground
  - AppSync-compatible error format
  - **AC**: Full CRUD with auth enforcement works

---

### Epic 7: Storage Emulator (Filesystem)

**Business Value**: S3 upload/download/list works locally with zero dependencies.

- [ ] **Story 7.1.1**: Filesystem S3 server
  - S3-compatible REST API on configurable port:
    - `PUT /{bucket}/{key}` → write to `.amplify-local/storage/{key}`
    - `GET /{bucket}/{key}` → read file with Content-Type
    - `DELETE /{bucket}/{key}` → delete
    - `GET /{bucket}?prefix=` → list (XML response matching S3 format)
    - `HEAD /{bucket}/{key}` → existence + metadata
  - Path-based access from parsed storage config
  - **AC**: Amplify SDK uploadData/getUrl/list work against it

---

### Epic 8: REST API Mock Server

**Business Value**: Custom API endpoints return configurable mock responses.

- [ ] **Story 8.1.1**: REST mock server
  - Route per custom endpoint key from parsed backend definition
  - Default mock responses, config overrides per method+path
  - **AC**: All custom endpoints return responses

---

### Epic 9: Seed & Data Utilities

**Business Value**: Deterministic test data.

- [ ] **Story 9.1.1**: Data seeder
  - JSON keyed by model name, validate against parsed schema
  - Auto-generate id/createdAt/updatedAt if missing
  - Batch-write (25/batch), reset via drop+recreate
  - **AC**: Seed + reset is deterministic

- [ ] **Story 9.1.2**: Templates (seed-example.json, config-example.js)

---

### Epic 10: Service Orchestration

**Business Value**: One command starts everything.

- [ ] **Story 10.1.1**: Service lifecycle manager
  - Check DynamoDB reachable → parse schema → create tables → generate tokens → start all servers (single process) → seed if configured → generate outputs → print summary
  - Summary includes:
    ```
    amplify-local is running:
      GraphQL:  http://localhost:4502/graphql  (playground available)
      Storage:  http://localhost:4503
      REST:     http://localhost:4504

      Outputs:  ./amplify_outputs.json
      Tokens:   .amplify-local/tokens.json

      Test users:
        admin@test.com    → groups: [admins]
        customer@test.com → groups: [customers]
    ```
  - Port conflict detection, PID file, stop/status commands

- [ ] **Story 10.1.2**: Docker Compose helper
  - docker/docker-compose.yml with DynamoDB Local + healthcheck
  - docker:start / docker:stop CLI commands

---

### Epic 11: Testing & Documentation

- [ ] **Story 11.1.1**: Unit tests
  - vitest, mock DynamoDB, minimal amplify/ fixture directory
  - Focus: parser (model/field/auth/index extraction), generator, filter builder, auth enforcer

- [ ] **Story 11.1.2**: Integration tests
  - Full lifecycle with DynamoDB Local: parse → tables → seed → tokens → GraphQL CRUD → auth enforcement
  - GitHub Actions CI workflow

- [ ] **Story 11.2.1**: README
  - Quickstart (5 steps), CLI ref, config ref, seed format, test pattern examples, CI guide, architecture diagram, auth tier explanation, limitations

---

## Dependency Graph

```
Epic 1 (CLI Scaffold)
  ├── 1.1.1 (Package)
  └── 1.1.2 (Config) ← 1.1.1

Epic 2 (Parser) ← 1
  ├── 2.1.1 (TS Importer) ← 1.1.2
  ├── 2.1.2 (Models/Fields) ← 2.1.1
  ├── 2.1.3 (Auth Rules) ← 2.1.1
  ├── 2.1.4 (Indexes) ← 2.1.1
  ├── 2.1.5 (Enums) ← 2.1.1
  └── 2.1.6 (Auth/Storage Config) ← 2.1.1

Epic 3 (Generator) ← 2
  ├── 3.1.1 (Introspection) ← 2.1.2-2.1.5
  ├── 3.1.2 (Outputs File) ← 3.1.1, 2.1.6
  └── 3.1.3 (CLI Wire) ← 3.1.2

Epic 4 (Auth Tokens) 
  ├── 4.1.1 (JWT)
  ├── 4.1.2 (Token Manager) ← 4.1.1
  ├── 4.1.3 (Middleware) ← 4.1.1
  └── 4.1.4 (Enforcer) ← 2.1.3

Epic 5 (DynamoDB) ← 2
  ├── 5.1.1 (Client)
  ├── 5.1.2 (Tables) ← 5.1.1, 2.1.2, 2.1.4
  └── 5.1.3 (CLI Wire) ← 5.1.2

Epic 6 (GraphQL) ← 2, 4, 5
  ├── 6.1.1 (Schema Gen) ← 2.1.2, 2.1.5
  ├── 6.2.1 (Resolvers) ← 6.1.1, 5.1.1
  ├── 6.2.2 (Custom Queries) ← 6.2.1
  └── 6.3.1 (Server) ← 6.2.1, 6.2.2, 4.1.3, 4.1.4

Epic 7 (Storage) ← 2
  └── 7.1.1 ← 2.1.6, 4.1.3

Epic 8 (REST) ← 1
  └── 8.1.1

Epic 9 (Seed) ← 5
  ├── 9.1.1 ← 5.1.1, 2.1.2
  └── 9.1.2

Epic 10 (Orchestration) ← all services
  ├── 10.1.1 ← 2-9
  └── 10.1.2

Epic 11 (Tests/Docs) ← all
```

## Sprint Plan

**Sprint 1 — Parse & Generate**: 1.1.1 → 1.1.2 → 2.1.1 → 2.1.2 → 2.1.3 → 2.1.4 → 2.1.5 → 2.1.6 → 3.1.1 → 3.1.2 → 3.1.3
*Can install, parse any Amplify project, generate valid outputs file*

**Sprint 2 — Auth + DynamoDB**: 4.1.1 → 4.1.2 → 4.1.3 → 4.1.4 → 5.1.1 → 5.1.2 → 5.1.3
*Static tokens work, tables created from parsed schema*

**Sprint 3 — GraphQL**: 6.1.1 → 6.2.1 → 6.2.2 → 6.3.1
*Full GraphQL CRUD with auth enforcement*

**Sprint 4 — Storage + REST + Seed**: 7.1.1 → 8.1.1 → 9.1.1 → 9.1.2
*All services functional*

**Sprint 5 — Ship**: 10.1.1 → 10.1.2 → 11.1.1 → 11.1.2 → 11.2.1
*One-command startup, tested, documented, published*

## Key Technical Decisions

1. **Input source**: TypeScript backend definitions (not amplify_outputs.json). Zero credentials in the package.
2. **Auth model**: Static pre-signed JWTs. No Cognito emulation in core. cognito-local is opt-in tier 2.
3. **Storage model**: Local filesystem. No MinIO in core. MinIO is opt-in tier 2.
4. **Single process**: All servers in one Node process, multiple ports.
5. **Symbol extraction**: Auth rules use `Object.getOwnPropertySymbols()` to read Symbol(data) properties.
6. **ESM**: type:module, Node 18+.
7. **tsx dependency**: Required to import TypeScript definitions at runtime. Small, well-maintained.

## Backlog (Future / Tier 2+)

- Tier 2 auth: cognito-local integration for sign-in flow testing
- Tier 2 storage: MinIO proxy for full S3 compat
- GraphQL subscriptions (graphql-ws)
- Lambda function runner
- `amplify-local import` (pull prod data into local)
- Admin UI web dashboard
- Testcontainers integration
- OpenSearch emulator
- Multi-environment named sandboxes
- Programmatic API (import in test files, not just CLI)
- Watch mode (re-parse schema on amplify/ file changes)

## Progress Log

| Date | Update |
|------|--------|
| 2026-04-08 | Plan v3 — TS definitions as input, tiered auth/storage |
