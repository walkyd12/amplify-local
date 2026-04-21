---
name: amplify-local
description: Use when a user asks about running, configuring, debugging, or testing against amplify-local — the local emulator for AWS Amplify Gen 2 that runs GraphQL, DynamoDB, S3, REST, and a Cognito-shaped auth endpoint locally. Trigger on questions about starting the stack, sign-in / Cognito auth flows, the dashboard on :4501, the 2-machine TLS setup, `amplify_outputs.json`, or tokens in `.amplify-local/`.
---

# amplify-local skill

You are helping a user work with **amplify-local**, a local emulator for AWS
Amplify Gen 2. It reads `amplify/data/resource.ts` (plus optional auth and
storage resources) and stands up local replacements for every service a
typical Amplify backend uses.

Before answering, check whether the user's project has:
- `amplify-local.config.js` at the repo root (explicit config)
- `.amplify-local/` state directory (emulator has run before)
- `amplify_outputs.json` (generated from the schema)

If you need to verify how a feature actually behaves, **read the source
under `node_modules/amplify-local/src/`** (or the repo if they're
developing amplify-local itself). Don't guess — the real behavior lives
in the code.

## Services and ports (defaults)

| Service | Port | URL |
|---|---|---|
| GraphQL | 4502 | `http://localhost:4502/graphql` |
| Storage (S3-compat) | 4503 | `http://localhost:4503` |
| REST mock | 4504 | `http://localhost:4504` |
| Cognito UserPool shape | 4500 | `http://localhost:4500` (HTTP) |
| Dashboard UI | 4501 | `http://localhost:4501` |
| DynamoDB Local | 8000 | `http://localhost:8000` |

Override via `amplify-local.config.js` → `ports.*` or env vars
(`AMPLIFY_LOCAL_{GRAPHQL,STORAGE,REST,COGNITO,DASHBOARD,DYNAMODB}_PORT`).

## Everyday commands

The repo Makefile is the canonical entry point — `make help` lists
everything. The important ones:

```bash
make up                 # DynamoDB Local + amplify-local (foreground)
make down               # stop amplify-local + tear down DynamoDB
make start / stop / status / generate
make test / test-integration / test-all
make tls-server                         # on the server: mkcert + Caddyfile
make tls-caddy                          # sudo caddy on :443
make tls-client SERVER=<ip> [CA=<src>]  # on each client laptop
```

Or call the CLI directly via `npx amplify-local <cmd>` — `start`, `stop`,
`status`, `generate`, `setup-tables`, `seed`, `docker:start`,
`docker:stop`, `install-skill`.

## Configuration

`amplify-local.config.js` is the single source of truth for test users,
REST mocks, ports, seed data, storage paths, and custom-resolver
overrides. Priority: CLI flags > config file > defaults.

Test users look like:

```js
users: [
  { email: 'admin@test.local', sub: 'admin-001', password: 'Admin1!', groups: ['admins'] },
  { email: 'user@test.local',  sub: 'user-001',  password: 'User1!' },
]
```

- **Without `password`** — the user is usable only via the pre-generated
  JWT in `.amplify-local/tokens.json` (copy into `Authorization: Bearer`
  headers).
- **With `password`** — the user can ALSO sign in via the Cognito-shaped
  endpoint using `Auth.signIn(email, password)`.

## Two ways to authenticate

1. **Pre-generated JWTs** — written to `.amplify-local/tokens.json` on
   startup. Simplest for curl / server-side scripts / tests.
2. **Real Cognito flow** — the Amplify SDK's `Auth.signIn()` / `signUp()`
   work against the local Cognito endpoint (SRP-6a + password + refresh,
   plus auto-confirmed SignUp). No code changes in the frontend — but the
   browser needs a hosts-file + TLS setup. See the "2-machine setup"
   section below.

## State files

- `.amplify-local/state.json` — running PIDs and service URLs
- `.amplify-local/tokens.json` — the pre-generated JWTs (one per config user)
- `.amplify-local/keys/` — RSA-2048 keypair for JWT signing
- `.amplify-local/storage/` — local S3 filesystem storage
- `.amplify-local/tls/` — mkcert leaf cert + rootCA.pem + Caddyfile

## Dashboard

`http://localhost:4501` (or `http://<server-ip>:4501` for remote
amplify-local). Five tabs:
- **Health** — probe status per service, PID, uptime
- **Tokens** — API key + every pre-generated JWT (copy/paste-able)
- **Schema** — parsed models with fields, relationships, indexes, auth rules
- **Tables** — list DynamoDB tables, scan per model (50-row cap)
- **Logs** — live ring-buffer feed from every service

When debugging, **point the user at the dashboard first** — it surfaces
most of what they'd otherwise need to read files for.

## 2-machine setup (remote dev server + laptop/agent)

Amplify-local runs on a remote server; the browser runs on a laptop. The
`aws_region` in `amplify_outputs.json` is deliberately the fake
`local-1`, so the Cognito hostname is
`cognito-idp.local-1.amazonaws.com` — a name AWS never uses, which means
hijacking it in `/etc/hosts` cannot affect real Cognito traffic.

**On the server** (one-time, needs mkcert + caddy installed):
```bash
make tls-server                        # writes .amplify-local/tls/
make tls-caddy                         # sudo caddy on :443 → :4500
```

**On each laptop/agent** (one-time, needs mkcert for certutil):
```bash
make tls-client SERVER=<server-ip>
# fetches rootCA.pem via scp (or pass CA=http://… / CA=./rootCA.pem)
# adds hosts entry, installs CA into keychain + Firefox, verifies TLS
```

Server IP changed? Re-run `make tls-client SERVER=<new-ip>` — it
replaces the hosts entry in place.

CI runners usually skip this — point the AWS SDK at `http://<host>:4500`
directly via the `endpoint:` override instead.

## Debugging recipes

- **"Sign-in fails with NotAuthorizedException"** — check the user has
  `password` set in `amplify-local.config.js`; verifiers are computed at
  startup so restart after editing.
- **"Can't reach Cognito from the Mac"** — verify Caddy is running on
  :443 (`make tls-caddy`), the server's firewall allows 443, and the
  hosts entry on the Mac points to the right IP.
- **"Safari shows cert error"** — restart Safari after `make tls-client`;
  Safari caches cert validity aggressively.
- **"Firefox shows cert error"** — make sure `mkcert` (which provides
  `certutil`) was installed before running `make tls-client`; otherwise
  the script couldn't populate the Firefox NSS DB.
- **"GraphQL auth returns 'No matching auth rule'"** — this is correct
  behavior. Check the `authorization(allow => [...])` block in
  `amplify/data/resource.ts` for the model/operation, and confirm the
  caller's JWT has the right `cognito:groups` claim.
- **"DynamoDB calls hang"** — probably a stale named volume with wrong
  permissions. `make docker-stop && make docker-start` (stop includes
  `-v` to drop the volume). If that fails, `make docker-start-ephemeral`
  sidesteps persistent storage entirely.
- **"Amplify SDK throws 'Cannot use GraphQLSchema from another module or
  realm' in tests"** — vitest integration needs `pool: 'forks'` and
  `server.deps.inline: [/@graphql-tools/, /^graphql$/, /graphql\//]`.
  See `vitest.config.js` in the amplify-local repo.

## When the user asks for deeper detail

Point them at these files in the amplify-local repo:

| Question | File |
|---|---|
| How is my schema parsed? | `src/parser/{index,models,auth-rules,indexes,enums}.js` |
| What auth rules are supported? | `src/auth/enforcer.js` |
| How are resolvers built? | `src/services/graphql/resolver-factory.js` |
| How are filter queries translated? | `src/services/graphql/filters.js` |
| How is `amplify_outputs.json` generated? | `src/generator/outputs.js`, `src/generator/introspection.js` |
| How does the Cognito endpoint work? | `src/services/cognito/{server,srp,user-store}.js` |
| How is DynamoDB set up? | `src/dynamo/table-creator.js` |
| Full TLS/hosts walkthrough | `docs/cognito-setup.md` |

## Non-goals (don't promise these)

- No MFA, hosted UI, or Lambda Cognito triggers
- No GraphQL subscriptions
- No Lambda function execution (custom resolvers are stubs)
- No email/SMS delivery — `ForgotPassword` just logs and lets
  `ConfirmForgotPassword` reset the password directly

If a user wants one of these, the honest answer is "amplify-local
doesn't emulate that; you'd need to run against real AWS or mock at the
test-doubles layer."
