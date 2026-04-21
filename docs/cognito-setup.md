# Using the Cognito-shaped endpoint

amplify-local ships a small Cognito-shaped server on port **4500** so that an
Amplify Gen 2 frontend can call `Auth.signIn()`, `Auth.signOut()`,
`Auth.signUp()`, etc. with **no code changes** — given the right networking
setup on the developer (or CI) machine.

This document covers:
- What the endpoint speaks
- Two ways to point the Amplify SDK at it (hosts-file + TLS vs. HTTP proxy)
- CI runner setup
- What it does *not* emulate

## What's supported

The endpoint speaks the [Cognito JSON-RPC protocol](https://docs.aws.amazon.com/cognitoidentityprovider/latest/APIReference/API_Operations.html)
that the Amplify SDK uses — enough to cover a standard signIn/signOut flow.

| Target | Notes |
|---|---|
| `InitiateAuth` / `USER_SRP_AUTH` | Full SRP-6a, returns `PASSWORD_VERIFIER` challenge |
| `InitiateAuth` / `USER_PASSWORD_AUTH` | Plain username/password |
| `InitiateAuth` / `REFRESH_TOKEN_AUTH` | Exchanges refresh token for fresh id/access tokens |
| `RespondToAuthChallenge` / `PASSWORD_VERIFIER` | Completes the SRP flow, returns tokens |
| `SignUp` | **Auto-confirmed** (local dev only) |
| `ConfirmSignUp` | No-op |
| `GetUser` | Returns user attributes from the in-memory store |
| `GlobalSignOut` / `RevokeToken` | Invalidates the user's refresh tokens |
| `ForgotPassword` / `ConfirmForgotPassword` | Updates the verifier in place |

Unsupported: MFA, Lambda triggers, email/SMS delivery, admin-only APIs,
hosted UI. Calling them returns `NotImplementedException` so the SDK
surfaces a recognisable error.

## Configuring users

Users live in `amplify-local.config.js` under the `users` array. A
`password` makes the account usable via the Cognito endpoint:

```js
export default {
  users: [
    { email: 'admin@test.local', sub: 'admin-001', password: 'Admin1!', groups: ['admins'] },
    { email: 'user@test.local',  sub: 'user-001',  password: 'User1!'              },
  ],
};
```

On `amplify-local start` the server precomputes an SRP verifier per user.
Users added via `SignUp` at runtime are stored in-memory only and are lost
on restart.

## Option A — hosts file + TLS (browser, zero code change)

The Amplify SDK builds its Cognito URL from `aws_region` in
`amplify_outputs.json`. amplify-local deliberately writes a **fake region**
(`local-1`) so the resulting hostname is
`https://cognito-idp.local-1.amazonaws.com/` — an address AWS does not use.

That's the key safety property: hijacking this hostname in `/etc/hosts`
has zero effect on real Cognito traffic in any other app or browser tab,
because no real service ever resolves `cognito-idp.local-1.amazonaws.com`.
Your production app (or anyone else's) using `us-east-1`, `eu-west-1`, etc.
keeps resolving normally.

Setup:

1. **Map the real Cognito host to localhost** in `/etc/hosts`:
   ```
   127.0.0.1  cognito-idp.local-1.amazonaws.com
   ```
2. **Run amplify-local's Cognito server on port 443 with TLS** that your
   browser trusts.

The simplest local TLS path is [mkcert](https://github.com/FiloSottile/mkcert):
```bash
# One-time per machine: installs a local root CA the browser trusts
mkcert -install

# Generate a cert for the Cognito hostname
mkcert cognito-idp.local-1.amazonaws.com
# → cognito-idp.local-1.amazonaws.com.pem
# → cognito-idp.local-1.amazonaws.com-key.pem
```

Then front the Cognito server with [Caddy](https://caddyserver.com/):
```caddyfile
cognito-idp.local-1.amazonaws.com {
  tls /path/to/cognito-idp.local-1.amazonaws.com.pem /path/to/cognito-idp.local-1.amazonaws.com-key.pem
  reverse_proxy 127.0.0.1:4500
}
```

`sudo caddy run` to bind 443. Browser traffic to Cognito now terminates
at amplify-local.

### Automation scripts (Linux + macOS)

For repeatable, idempotent setup — and especially for the **2-machine
topology** where amplify-local runs on a server and a browser (or agent)
runs on a laptop — use the provided shell scripts, or call them via the
Makefile targets:

```
make tls-server                        # on the server
make tls-caddy                         # start Caddy (needs sudo)
make tls-client SERVER=<ip>            # on each client
make tls-client SERVER=<ip> CA=<src>   # with explicit CA source
```

Run `make help` to see every target.

#### Single-machine

Both steps run on the same laptop:

```bash
make tls-server
make tls-caddy   # in another terminal; keeps running

make tls-client SERVER=127.0.0.1 CA=.amplify-local/tls/rootCA.pem
```

#### 2-machine split

On the **server** (running amplify-local):

```bash
make tls-server
make tls-caddy   # keeps Caddy in the foreground on :443
```

This writes `.amplify-local/tls/`:
- `cognito-idp.local-1.amazonaws.com.pem` + `-key.pem` — the leaf cert
  Caddy serves
- `rootCA.pem` — the mkcert root CA you need to distribute to every
  client

On each **client** (laptop, agent, remote worker):

```bash
# Simplest: fetch the root CA over scp (default when CA_SOURCE omitted)
make tls-client SERVER=<SERVER_IP>

# Or explicit: http URL / scp URL / local file path
make tls-client SERVER=<SERVER_IP> CA=http://<SERVER_IP>:4501/rootCA.pem
make tls-client SERVER=<SERVER_IP> CA=scp://user@server:.amplify-local/tls/rootCA.pem
make tls-client SERVER=<SERVER_IP> CA=./rootCA.pem   # after scp'ing it manually
```

The client script:
- Adds (or replaces) `<SERVER_IP>  cognito-idp.local-1.amazonaws.com`
  in `/etc/hosts` (sudo).
- Installs `rootCA.pem` into the OS trust store — macOS keychain,
  Debian/Ubuntu `update-ca-certificates`, or RHEL/Fedora
  `update-ca-trust`.
- Also loads the CA into every Firefox profile it finds (optional;
  Firefox ignores the OS trust store).
- Verifies by TLS-probing `https://cognito-idp.local-1.amazonaws.com/`
  and prints the status.

Re-running either script is safe. If the server IP changes, re-run the
client script — it rewrites the hosts entry in place.

## Option B — HTTP proxy for server-side code

For scripts, tests, or any non-browser client that lets you configure a
proxy (or just talk HTTP), bypass TLS entirely:

```bash
# Direct raw probe
curl http://localhost:4500 \
  -H 'Content-Type: application/x-amz-json-1.1' \
  -H 'X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth' \
  -d '{
    "AuthFlow":"USER_PASSWORD_AUTH",
    "ClientId":"local-client-id-000000",
    "AuthParameters":{"USERNAME":"admin@test.local","PASSWORD":"Admin1!"}
  }'
```

Or with the AWS SDK pointing at the local endpoint:
```js
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4500',
  credentials: { accessKeyId: 'x', secretAccessKey: 'x' },
});
```

The generated id/access tokens validate against the JWKS exposed at
`http://localhost:4500/.well-known/jwks.json`.

## CI runners

For CI (GitHub Actions, etc.) the browser isn't in the loop, so you
typically skip the hosts-file + TLS ritual and let your backend tests
hit the local endpoint directly. If the app under test really does
need the Cognito URL intercepted, a `hosts` modification can be scripted:

```yaml
- name: Redirect Cognito host
  run: |
    echo "127.0.0.1  cognito-idp.local-1.amazonaws.com" | sudo tee -a /etc/hosts
- name: Terminate TLS on 443
  run: |
    sudo npx caddy run --config ./Caddyfile &
```

## Debugging

- The dashboard at <http://localhost:4501> streams Cognito logs under the
  `cognito` scope.
- `tokens.json` is still written, so a test can skip the auth dance
  entirely by reading the pre-generated admin token.
- JWKS lives at `/.well-known/jwks.json` on the Cognito server.
