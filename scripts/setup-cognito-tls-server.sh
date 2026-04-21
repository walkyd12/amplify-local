#!/usr/bin/env bash
#
# Generate a TLS cert for amplify-local's Cognito endpoint and write a
# Caddyfile that terminates HTTPS on :443 and reverse-proxies to :4500.
#
# Run this on the machine where amplify-local runs.
#
# Afterwards, copy .amplify-local/tls/rootCA.pem to each client machine
# (or point scripts/setup-cognito-tls-client.sh at it over scp/http/file).

set -euo pipefail

HOSTNAME="cognito-idp.local-1.amazonaws.com"
COGNITO_PORT="${AMPLIFY_LOCAL_COGNITO_PORT:-4500}"
TLS_DIR=".amplify-local/tls"

info()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()   { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# 1. mkcert is required.
if ! command -v mkcert >/dev/null 2>&1; then
  warn "mkcert not found. Install it first:"
  cat >&2 <<'EOF'
  macOS:         brew install mkcert
  Debian/Ubuntu: apt install libnss3-tools && \
                 curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64" && \
                 chmod +x mkcert-v*-linux-amd64 && \
                 sudo mv mkcert-v*-linux-amd64 /usr/local/bin/mkcert
  RHEL/Fedora:   dnf install nss-tools && (same curl dance)
EOF
  exit 1
fi

# 2. Ensure mkcert has a root CA (idempotent; -install may require sudo on
#    Linux for the system trust store — harmless even if we don't use it
#    locally, since CLIENTS are the ones who need to trust it).
info "Ensuring mkcert root CA exists…"
mkcert -install >/dev/null 2>&1 || true
CAROOT="$(mkcert -CAROOT)"
[ -f "$CAROOT/rootCA.pem" ] || die "mkcert did not produce $CAROOT/rootCA.pem"

# 3. Generate the leaf cert for the fake Cognito hostname.
mkdir -p "$TLS_DIR"
( cd "$TLS_DIR"
  mkcert \
    -cert-file "${HOSTNAME}.pem" \
    -key-file  "${HOSTNAME}-key.pem" \
    "$HOSTNAME" >/dev/null
  cp "$CAROOT/rootCA.pem" "rootCA.pem"
)
ok "Generated $TLS_DIR/${HOSTNAME}.pem (+ key) and staged rootCA.pem"

# 4. Write a Caddyfile.
ABS_TLS_DIR="$(cd "$TLS_DIR" && pwd)"
cat > "$TLS_DIR/Caddyfile" <<EOF
{
  auto_https off
}
$HOSTNAME:443 {
  tls $ABS_TLS_DIR/${HOSTNAME}.pem $ABS_TLS_DIR/${HOSTNAME}-key.pem
  reverse_proxy 127.0.0.1:$COGNITO_PORT
}
EOF
ok "Wrote $TLS_DIR/Caddyfile"

# 5. Summary.
echo
info "Next steps"
echo "  1. Start Caddy (binds :443, needs sudo or CAP_NET_BIND_SERVICE):"
echo "       sudo caddy run --config $ABS_TLS_DIR/Caddyfile"
echo
echo "  2. On each client machine, distribute the root CA and wire the hosts file:"
echo "       scripts/setup-cognito-tls-client.sh <this-server's-IP> \\"
echo "         scp://user@host:$ABS_TLS_DIR/rootCA.pem"
echo
echo "  Root CA file: $ABS_TLS_DIR/rootCA.pem"
echo "  Hostname:     $HOSTNAME"
