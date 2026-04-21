# amplify-local

Local emulator for AWS Amplify Gen 2 — run your backend with zero AWS
credentials. Reads your `amplify/` TypeScript resource files and spins
up local replacements for AppSync (GraphQL), DynamoDB, S3, REST APIs,
**and** a Cognito-shaped auth endpoint the Amplify SDK can talk to
directly.

Your frontend consumes the generated `amplify_outputs.json` — no code
changes required.

## What you get

| Amplify service | Local replacement | Port |
|---|---|---|
| AppSync (GraphQL) | Express + `@graphql-tools/schema` | 4502 |
| DynamoDB | DynamoDB Local (Docker) | 8000 |
| S3 Storage | Filesystem-backed Express server | 4503 |
| Cognito UserPool | SRP + password auth JSON-RPC endpoint | 4500 |
| REST APIs | Express mock router | 4504 |
| — | Dashboard UI (health, tokens, logs, tables) | 4501 |

Plus:
- Cognito-compatible JWTs (RSA-2048, RS256) with the right issuer claim
  and a JWKS endpoint
- Pre-generated test-user tokens at `.amplify-local/tokens.json`
- `Auth.signIn()` works end-to-end via the SRP-6a flow — same protocol
  real Cognito uses

## Prerequisites

- **Node.js** >= 18
- **Docker** (for DynamoDB Local)

For the Cognito endpoint + browser zero-code path:
- **mkcert** (`brew install mkcert` on macOS; Linux: see
  [mkcert install docs](https://github.com/FiloSottile/mkcert))
- **caddy** (`brew install caddy`, or `sudo apt install caddy`)

## Quick start (single machine)

```bash
git clone <this-repo> && cd amplify-local
make install

# In one terminal — brings up DynamoDB + all amplify-local services
make up

# In another terminal — if you want Cognito-shaped sign-in from a browser
make tls-server
make tls-caddy
make tls-client SERVER=127.0.0.1 CA=.amplify-local/tls/rootCA.pem
```

Then point your Next.js / React / etc. app at the generated
`amplify_outputs.json` as usual. `Amplify.configure(outputs)` picks up
local URLs automatically.

Tear down: `make down`.

## Commands (Makefile wrapper)

`make help` for the canonical list. Highlights:

| Target | What it does |
|---|---|
| `make up` | Start DynamoDB + amplify-local (foreground) |
| `make down` | Stop amplify-local + tear down DynamoDB volume |
| `make start` / `make stop` / `make status` | Just the amplify-local side |
| `make docker-start` / `make docker-stop` | Just DynamoDB |
| `make docker-start-ephemeral` | In-memory DynamoDB (no persistence) |
| `make test` / `make test-integration` / `make test-all` | vitest suites |
| `make tls-server` | Generate TLS cert + Caddyfile (on the server) |
| `make tls-caddy` | Run Caddy on :443 (needs sudo) |
| `make tls-client SERVER=<ip>` | Wire this machine's browser at the server |

Or call the CLI directly: `npx amplify-local start | stop | status | generate | setup-tables | seed | docker:start | docker:stop`.

### Start flags

```
--no-storage        Skip the storage server
--no-rest           Skip the REST mock server
--no-dashboard      Skip the dashboard UI
--no-cognito        Skip the Cognito-shaped endpoint
--ephemeral         Use in-memory DynamoDB (no persistence)
```

## Configuration

`amplify-local.config.js` in your project root:

```javascript
export default {
  amplifyDir: './amplify',
  output: './amplify_outputs.json',

  ports: {
    graphql: 4502,
    storage: 4503,
    rest: 4504,
    cognito: 4500,
    dashboard: 4501,
    dynamodb: 8000,
  },

  // Test users. `password` unlocks the Cognito endpoint for that user.
  // Without `password`, the user is still usable via tokens.json.
  users: [
    { email: 'admin@test.local', sub: 'admin-001', password: 'Admin1!', groups: ['admins'] },
    { email: 'user@test.local',  sub: 'user-001',  password: 'User1!'                     },
  ],

  // Mock REST API endpoints
  rest: {
    ordersApiEndpoint: {
      'POST /':     { status: 201, body: { id: 'mock-order-1', status: 'PENDING' } },
      'GET /:id':   { status: 200, body: { id: ':id',         status: 'DELIVERED' } },
    },
  },

  seed: './seed.json',

  storageBackend: 'filesystem',
  storageDir: './.amplify-local/storage',

  dynamodbPersist: true,
  dynamodbDataDir: './.amplify-local/dynamodb-data',

  customResolvers: {},
};
```

Ports can also be overridden via env vars:

```bash
AMPLIFY_LOCAL_GRAPHQL_PORT   AMPLIFY_LOCAL_STORAGE_PORT
AMPLIFY_LOCAL_REST_PORT      AMPLIFY_LOCAL_COGNITO_PORT
AMPLIFY_LOCAL_DASHBOARD_PORT AMPLIFY_LOCAL_DYNAMODB_PORT
```

## Authentication

Two independent auth paths — use whichever fits.

### 1. Pre-generated static JWTs (simplest, no setup)

amplify-local signs Cognito-compatible JWTs for every user in the
config on startup. Tokens go to `.amplify-local/tokens.json`:

```bash
# API Key auth (public access)
curl http://localhost:4502/graphql \
  -H "x-api-key: local-api-key-000000" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ listProducts { items { id name } } }"}'

# User Pool auth via a pre-generated token
TOKEN=$(jq -r '."admin@test.local".idToken' .amplify-local/tokens.json)
curl http://localhost:4502/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "..."}'
```

Supported strategies: `public` (apiKey / identityPool), `private`,
`groups`, `owner`.

### 2. Real `Auth.signIn()` via the Cognito endpoint

Full SRP-6a, USER_PASSWORD_AUTH, REFRESH_TOKEN_AUTH, plus
SignUp/ConfirmSignUp/GetUser/GlobalSignOut. The Amplify SDK uses this
with **no code changes** when `amplify_outputs.json` points at the
local Cognito server.

Because the Amplify SDK builds the Cognito URL from `aws_region`,
amplify-local emits a **fake region** (`local-1`) so redirecting
`cognito-idp.local-1.amazonaws.com` in your hosts file *cannot*
collide with real Cognito traffic for us-east-1 / eu-west-1 / etc.

Full step-by-step lives in
[docs/cognito-setup.md](docs/cognito-setup.md), including
single-machine, 2-machine, and CI-runner recipes.

## 2-machine setup (dev server + laptop or agent)

Typical setup: a dev box or VM on your LAN runs amplify-local and your
Next.js dev server; you browse from your Mac. Same instructions for
public cloud VMs, just swap LAN IP for the public one.

### On the server (one-time)

```bash
git clone <this-repo> /opt/amplify-local && cd /opt/amplify-local
make install
make tls-server
# open port 443 (Caddy) and your Next.js port on the firewall / security group
```

### On the server (each session)

```bash
# terminal 1
make up                # DynamoDB + amplify-local

# terminal 2
make tls-caddy         # sudo caddy on :443

# terminal 3
cd /opt/your-nextjs-app
next dev -H 0.0.0.0    # bind to all interfaces so your Mac can reach it
```

### On the Mac (one-time)

```bash
brew install mkcert
git clone <this-repo> ~/code/amplify-local && cd ~/code/amplify-local
make tls-client SERVER=<server-lan-or-public-ip>
# - scp's rootCA.pem from server (or use CA=http://... / CA=./rootCA.pem)
# - adds the server IP → cognito-idp.local-1.amazonaws.com to /etc/hosts
# - installs the CA into System keychain + Firefox NSS DBs
# - verifies the TLS handshake
```

Point your browser at `http://<server-ip>:3000` (Next.js). Sign in.

### Verify

```bash
curl -I https://cognito-idp.local-1.amazonaws.com/      # TLS handshake ok
```

If the server IP ever changes, re-run
`make tls-client SERVER=<new-ip>` on each client. No re-cert, no
re-trust — it just rewrites the hosts entry.

## Dashboard

Open `http://localhost:4501` (or `http://<server-ip>:4501` from your
Mac if the port is open). Five tabs:

- **Health** — each service's probe status, PID, uptime
- **Tokens** — API key + every pre-generated JWT (copy/paste-able)
- **Schema** — parsed models with fields, relationships, indexes, auth
- **Tables** — list DynamoDB tables, scan per table (50-row cap)
- **Logs** — live-streaming ring buffer from every service

## Claude Code skill

If your team uses Claude Code, amplify-local ships a skill that gives
Claude task-specific context about ports, config, the 2-machine setup,
and common debugging recipes. Install it into the consuming repo:

```bash
make install-skill          # → ./.claude/skills/amplify-local.md (team-shared)
make install-skill-user     # → ~/.claude/skills/amplify-local.md (per-developer)

# Or directly
npx amplify-local install-skill [--user|--project] [--force] [--dry-run]
```

The installer stamps the amplify-local version into the skill's
frontmatter so re-running on a newer release prompts for `--force` to
update an out-of-date file. After install, restart Claude Code.

Skills are a Claude Code feature — engineers using Cursor, plain
Anthropic API, or another tool won't see them. The skill is
supplementary to the README and `docs/`, not a replacement.

## Seed data

```json
{
  "Category": [ { "name": "Electronics", "description": "Gadgets and devices" } ],
  "Product":  [ { "name": "Headphones", "price": 79.99, "categoryId": "cat-1" } ]
}
```

Missing `id`, `createdAt`, `updatedAt` are auto-generated.

```bash
npx amplify-local seed --file ./seed.json
npx amplify-local seed --file ./seed.json --reset  # drop tables first
```

## Non-goals

Explicit non-goals (not emulated):
- MFA, Hosted UI, Lambda Cognito triggers
- Email / SMS delivery
- GraphQL subscriptions
- Lambda function execution
- AppSync custom resolvers (stub only; override via `customResolvers`)

Calling unsupported Cognito actions returns `NotImplementedException`
so the SDK surfaces it cleanly.

## Project structure

```
amplify-local/
  bin/amplify-local.js          CLI entry point
  Makefile                      Makefile targets; `make help` to list
  src/
    cli.js                      Commander.js CLI
    config.js                   Config loader (defaults ∪ file ∪ CLI ∪ env)
    orchestrator.js             Service startup/shutdown, state file
    docker.js                   docker compose wrapper
    logger.js                   Ring buffer + console interception
    parser/                     amplify/* TS → parsed schema
    auth/                       JWT, middleware, rule enforcer
    generator/                  amplify_outputs.json + introspection
    dynamo/                     Client, table creator, seeder
    services/
      graphql/                  GraphQL server, schema gen, resolvers, filters
      storage/                  S3-compatible storage
      rest/                     REST mock
      cognito/                  SRP, user store, JSON-RPC server
      dashboard/                Health/tokens/schema/tables/logs UI
  docker/docker-compose.yml     DynamoDB Local (root user, named volume)
  docs/cognito-setup.md         Full Cognito endpoint + TLS guide
  scripts/                      setup-cognito-tls-server.sh / -client.sh
  templates/                    Example config and seed files
  test/
    fixtures/minimal-amplify/   3-model schema for tests
    unit/                       Unit tests (vitest)
    integration/                DynamoDB-backed integration tests
```

## License

Apache-2.0
