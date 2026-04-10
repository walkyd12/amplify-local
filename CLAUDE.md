# CLAUDE.md

## Project Overview

amplify-local is a local emulator for AWS Amplify Gen 2. It reads TypeScript backend definitions from `amplify/data/resource.ts` and spins up local replacements for AppSync, DynamoDB, S3, and REST APIs.

## Tech Stack

- **Runtime:** Node.js >= 18, ESM modules
- **CLI:** Commander.js
- **Servers:** Express 5
- **GraphQL:** graphql + @graphql-tools/schema
- **Database:** DynamoDB Local (Docker) + AWS SDK v3
- **Auth:** jose (RSA-2048 JWT signing/verification)
- **Schema Import:** tsx (runtime TypeScript import)

## Architecture

```
CLI (src/cli.js)
  -> config.js (load + merge defaults/file/CLI options)
  -> parser/ (import TS schema, extract models/auth/indexes/enums)
  -> orchestrator.js (coordinate all services)
      -> auth/token-manager.js (generate test user JWTs)
      -> dynamo/table-creator.js (create DynamoDB tables)
      -> services/graphql/server.js (GraphQL API)
      -> services/storage/server.js (S3-compatible storage)
      -> services/rest/server.js (REST mock)
      -> generator/outputs.js (write amplify_outputs.json)
```

## Key Modules

- **src/parser/** -- Imports `amplify/data/resource.ts` via tsx, walks schema objects to extract models, fields, relationships, auth rules, secondary indexes, and enums.
- **src/auth/** -- RSA key generation, Cognito-compatible JWT signing, Express middleware for auth context extraction, per-model auth rule enforcement (public/private/groups/owner).
- **src/services/graphql/** -- Schema generator (parsed schema -> SDL), resolver factory (CRUD + relationships backed by DynamoDB), filter builder (GraphQL filters -> DynamoDB FilterExpressions), auth enforcer wrapper.
- **src/services/storage/** -- S3-compatible filesystem server with path-based access control.
- **src/services/rest/** -- Mock REST endpoints from config-defined routes + responses.
- **src/dynamo/** -- DynamoDB client factory, table creator (maps Amplify types to DynamoDB, handles GSIs), seed data loader.
- **src/generator/** -- Builds `amplify_outputs.json` with auth, data (model_introspection), storage, and custom sections matching Amplify SDK expectations.

## Commands

```bash
npm start                          # runs `amplify-local start`
npx amplify-local start            # parse schema, create tables, start all servers
npx amplify-local stop             # stop running services
npx amplify-local status           # health check services
npx amplify-local generate         # generate amplify_outputs.json only
npx amplify-local setup-tables     # create DynamoDB tables
npx amplify-local seed --file X    # load seed data
npx amplify-local docker:start     # start DynamoDB Local container
npx amplify-local docker:stop      # stop DynamoDB Local container
```

## Default Ports

- GraphQL: 4502
- Storage: 4503
- REST: 4504
- DynamoDB Local: 8000

## State Files

- `.amplify-local/state.json` -- running service PIDs and URLs (written on start, read by stop/status)
- `.amplify-local/tokens.json` -- generated JWT tokens for test users
- `.amplify-local/keys/` -- RSA key pair for JWT signing
- `.amplify-local/storage/` -- local filesystem storage data

## Testing

Test fixtures are in `test/fixtures/minimal-amplify/` with a 3-model schema (Category, Product, Review). No automated test suite yet.

## Development Notes

- All source is plain JS (ESM) -- no build step required
- The parser uses `tsx` to dynamically import TypeScript files at runtime
- Auth rules are extracted from `Symbol(data)` on Amplify schema objects
- The GraphQL schema is generated as SDL strings, not code-first
- Resolvers interact with DynamoDB via the AWS SDK v3 DocumentClient
- The orchestrator writes a state file so `stop` and `status` can find running services
