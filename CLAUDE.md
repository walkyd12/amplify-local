# CLAUDE.md

## Project Overview

amplify-local is a local emulator for AWS Amplify Gen 2. It reads TypeScript
backend definitions from `amplify/data/resource.ts` (plus optional auth /
storage resources) and spins up local replacements for AppSync, DynamoDB,
S3, REST APIs, and — for the zero-code-change path — a Cognito-shaped
JSON-RPC endpoint the Amplify SDK can talk to directly.

## Tech Stack

- **Runtime:** Node.js >= 18, ESM modules
- **CLI:** Commander.js
- **Servers:** Express 5 (path-to-regexp v8 — use `*splat`, not bare `*`)
- **GraphQL:** graphql + @graphql-tools/schema
- **Database:** DynamoDB Local (Docker) + AWS SDK v3
- **Auth:** jose (RSA-2048 JWT signing/verification), RFC 5054 3072-bit SRP
- **Schema Import:** tsx (runtime TypeScript import)
- **Tests:** vitest + supertest (forks pool; see "Development Notes")

## Architecture

```
CLI (src/cli.js)
  -> config.js (defaults ∪ amplify-local.config.js ∪ CLI flags ∪ env)
  -> parser/ (tsx import of amplify/*, extract models/auth/indexes/enums)
  -> orchestrator.js (coordinate every service, intercept console → logger)
      -> auth/token-manager.js   (pre-generated JWTs written to tokens.json)
      -> auth/jwt.js             (RSA-2048 signer/verifier, JWKS)
      -> dynamo/table-creator.js (DynamoDB tables with GSIs)
      -> services/graphql/       (GraphQL API + auth enforcer wrapper)
      -> services/storage/       (S3-compatible filesystem server)
      -> services/rest/          (configurable REST mock)
      -> services/cognito/       (UserPool-shaped endpoint: SRP + password + refresh)
      -> services/dashboard/     (health/tokens/schema/tables/logs UI)
      -> generator/outputs.js    (write amplify_outputs.json)
```

## Key Modules

- **src/parser/** -- Imports `amplify/data/resource.ts` via tsx, walks
  schema objects to extract models, fields, relationships, auth rules
  (via `Symbol(data)`), secondary indexes, and enums.
- **src/auth/** -- RSA key generation (persisted at
  `.amplify-local/keys/`), Cognito-compatible JWT signing (issuer is
  derived from poolId region so the fake-region path works), Express
  middleware for auth context extraction, per-model auth rule
  enforcement (public/private/groups/owner).
- **src/services/graphql/** -- Schema generator (parsed schema → SDL;
  `hasMany` emits `ModelXConnection { items, nextToken }` to match
  the Amplify SDK), resolver factory (CRUD + `belongsTo`/`hasMany`
  backed by DynamoDB with a shared `fetchRelatedItems` helper), filter
  builder (GraphQL filters → DynamoDB FilterExpressions), auth enforcer
  wrapper.
- **src/services/storage/** -- S3-compatible filesystem server with
  path-based access control; `.__meta__` sidecars hidden from LIST.
- **src/services/rest/** -- Mock REST endpoints from config-defined
  routes + responses with `:param` substitution.
- **src/services/cognito/** -- Cognito-shaped JSON-RPC server.
  - `srp.js` — SRP-6a math (RFC 5054 3072-bit group, SHA-256, HKDF
    "Caldera Derived Key"), matches amazon-cognito-identity-js byte-
    for-byte.
  - `user-store.js` — in-memory registry, precomputes salt+verifier
    per user at startup, supports runtime SignUp.
  - `server.js` — `POST /` dispatches on `X-Amz-Target`: `InitiateAuth`
    (USER_SRP_AUTH / USER_PASSWORD_AUTH / REFRESH_TOKEN_AUTH),
    `RespondToAuthChallenge` (PASSWORD_VERIFIER), `SignUp`/ConfirmSignUp
    (auto-confirmed), `GetUser`, `GlobalSignOut`, `RevokeToken`,
    `ForgotPassword`/`ConfirmForgotPassword`. Unsupported actions
    return `NotImplementedException`.
- **src/services/dashboard/** -- Express app + single static HTML
  (`public/index.html`, vanilla JS polling). Endpoints:
  `/api/health`, `/api/tokens`, `/api/schema`, `/api/tables`,
  `/api/tables/:name?limit=N`, `/api/logs?since=N`.
- **src/logger.js** -- 500-entry ring buffer keyed by monotonic `seq`.
  `interceptConsole()` mirrors `console.log/warn/error` into the buffer
  (ANSI stripped) while preserving terminal output. The orchestrator
  calls it before anything else starts so every log line is captured.
- **src/dynamo/** -- DynamoDB client factory, table creator (maps
  Amplify types to DynamoDB with GSIs), seed data loader.
- **src/generator/** -- Builds `amplify_outputs.json` with auth, data
  (model_introspection), storage, and custom sections. **Auth region
  is the fake `local-1`** so a hosts-file override for
  `cognito-idp.local-1.amazonaws.com` cannot collide with real Cognito.
- **src/docker.js** -- Wraps `docker compose`. Health check is a
  host-side `ListTables` POST — the compose file has no
  Cognito-style healthcheck because `amazon/dynamodb-local` lacks
  `curl`. Container runs as `user: "0:0"` so named volumes stay
  writable in non-ephemeral mode.

## Commands

```bash
# Day-to-day (via the Makefile — `make help` lists all)
make up                # docker-start + amplify-local (foreground)
make down              # stop amplify-local + docker-stop -v
make start / stop / status / generate
make test-unit / test-integration / test-all
make tls-server                         # server-side: mkcert + Caddyfile
make tls-caddy                          # sudo caddy on :443
make tls-client SERVER=<ip> [CA=<src>]  # per-client: hosts + trust store

# Or directly
npx amplify-local start [--no-storage] [--no-rest] [--no-dashboard]
                         [--no-cognito] [--ephemeral]
npx amplify-local stop | status | generate | setup-tables
npx amplify-local seed --file X [--reset]
npx amplify-local docker:start [--ephemeral] | docker:stop [-v]
```

## Default Ports

- GraphQL: 4502
- Storage: 4503
- REST: 4504
- Cognito: 4500
- Dashboard: 4501
- DynamoDB Local: 8000

Override via `amplify-local.config.js` (`ports.*`) or env vars
(`AMPLIFY_LOCAL_{GRAPHQL,STORAGE,REST,COGNITO,DASHBOARD,DYNAMODB}_PORT`).

## State Files

- `.amplify-local/state.json` -- running service PIDs and URLs
  (written on start, read by stop/status)
- `.amplify-local/tokens.json` -- pre-generated JWT tokens per configured user
- `.amplify-local/keys/` -- RSA key pair for JWT signing
- `.amplify-local/storage/` -- local filesystem storage data
- `.amplify-local/tls/` -- mkcert leaf cert + `rootCA.pem` + `Caddyfile`

## Testing

- Unit suite (`npm run test:unit`): ~130 tests, no external deps. Covers
  parser, filters, auth enforcer, schema generator, introspection,
  storage server (supertest), REST server, logger, dashboard endpoints
  (supertest with fake Dynamo clients), SRP primitives, Cognito
  endpoint full flow.
- Integration suite (`npm run test:integration`): 12 tests against a
  real DynamoDB Local. Covers CRUD, belongsTo, hasMany connection
  shape, GSI queries (including named), filters, auth enforcement.
- CI: `.github/workflows/test.yml` runs both; integration uses an
  `amazon/dynamodb-local` service container.

## Development Notes

- All source is plain JS (ESM) -- no build step required.
- Express 5 / path-to-regexp v8 rejects bare `*` — use named splats
  (`/:bucket/*splat`, `req.params.splat.join('/')`).
- The parser uses `tsx` to dynamically import TypeScript files at
  runtime; this means integration tests must run with
  `server.deps.inline: [/@graphql-tools/, /^graphql$/, /graphql\//]`
  and `pool: 'forks'` — otherwise `@graphql-tools/schema`'s CJS build
  loads a distinct `graphql` module and `makeExecutableSchema`'s output
  fails `instanceof` checks in `graphql()`. See `vitest.config.js`.
- The unit project also uses `pool: 'forks'` — `src/auth/jwt.js` caches
  keys at module level, and shared-thread module state leaks across
  test files (it flakes the Cognito GlobalSignOut test specifically).
- The GraphQL schema is generated as SDL strings, not code-first.
- Resolvers interact with DynamoDB via the AWS SDK v3 DocumentClient.
- The orchestrator writes a state file so `stop` and `status` can find
  running services, and calls `interceptConsole()` first so the
  dashboard's log tab captures every startup line.
- SignUp'd users are in-memory only — lost on restart. Users from the
  config are persisted across restarts via their static tokens.json
  entry (but the SRP verifier is recomputed from the password each
  time the process starts).
- The Cognito endpoint's fake region (`local-1`) means hosts-file +
  mkcert setup only hijacks a hostname AWS never uses — real Cognito
  traffic on `us-east-1` / `eu-west-1` / etc. is unaffected on the
  same machine.

## Claude Code skill

`skills/amplify-local.md` ships with the package. `npx amplify-local
install-skill` copies it to the consuming repo's `.claude/skills/`
directory (or `~/.claude/skills/` with `--user`). The installer stamps
the amplify-local version into the frontmatter so stale copies can be
detected; `--force` updates in place. Implementation lives in
`src/skill-installer.js`.

## Key reference docs

- `docs/cognito-setup.md` — full Cognito endpoint guide (supported
  actions, hosts + TLS setup, single-machine and 2-machine recipes,
  CI runner notes)
- `README.md` — user-facing quick start + feature overview
- `skills/amplify-local.md` — Claude Code skill content
