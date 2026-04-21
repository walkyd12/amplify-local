#!/usr/bin/env bash
#
# Point this machine's browser at the remote amplify-local Cognito endpoint:
#   1. Add `<SERVER_IP>  cognito-idp.local-1.amazonaws.com` to /etc/hosts
#   2. Install the server's mkcert root CA into the OS trust store
#      (+ Firefox NSS DB if present)
#   3. Verify the TLS handshake succeeds
#
# Usage:
#   scripts/setup-cognito-tls-client.sh <SERVER_IP> [CA_SOURCE]
#
# CA_SOURCE can be:
#   - a local file path                        (e.g. ./rootCA.pem)
#   - an http/https URL                        (e.g. http://SERVER:4501/rootCA.pem)
#   - an scp URL                               (e.g. scp://user@host:/path/rootCA.pem)
#   - omitted → defaults to scp:user@SERVER_IP:.amplify-local/tls/rootCA.pem
#
# Re-running is safe: all steps are idempotent.

set -euo pipefail

HOSTNAME="cognito-idp.local-1.amazonaws.com"
NICK="amplify-local-cognito"

info()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()   { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

SERVER_IP="${1:-}"
CA_SOURCE="${2:-}"

[ -n "$SERVER_IP" ] || {
  echo "usage: $0 <SERVER_IP> [CA_SOURCE]" >&2
  exit 1
}

OS="$(uname)"
case "$OS" in
  Darwin) ;;
  Linux)  ;;
  *) die "Unsupported OS: $OS (only macOS and Linux are automated)" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CA_FILE="$TMP/rootCA.pem"

# ---- 1. Fetch root CA ------------------------------------------------------
fetch_ca() {
  local src="$1"
  if [ -z "$src" ]; then
    src="scp://${USER}@${SERVER_IP}:.amplify-local/tls/rootCA.pem"
  fi
  case "$src" in
    http://*|https://*)
      info "Fetching root CA from $src"
      curl -sSfL -o "$CA_FILE" "$src" || die "Download failed"
      ;;
    scp://*)
      local rest="${src#scp://}"
      info "Fetching root CA via scp $rest"
      scp -q "$rest" "$CA_FILE" || die "scp failed — check ssh keys or use http/file source"
      ;;
    *)
      [ -f "$src" ] || die "CA source not found: $src"
      cp "$src" "$CA_FILE"
      ;;
  esac
  [ -s "$CA_FILE" ] || die "Fetched file is empty: $CA_FILE"
  grep -q 'BEGIN CERTIFICATE' "$CA_FILE" || die "Fetched file is not a PEM certificate"
  ok "Root CA downloaded ($(wc -c < "$CA_FILE") bytes)"
}
fetch_ca "$CA_SOURCE"

# ---- 2. /etc/hosts ---------------------------------------------------------
update_hosts() {
  # Remove any existing line for this hostname so re-running with a new IP
  # doesn't leave a stale entry.
  if grep -qE "[[:space:]]${HOSTNAME}([[:space:]]|$)" /etc/hosts; then
    info "Replacing existing $HOSTNAME entry in /etc/hosts (sudo)"
    sudo sed -i.bak "/[[:space:]]${HOSTNAME}\([[:space:]]\|$\)/d" /etc/hosts
    sudo rm -f /etc/hosts.bak
  else
    info "Adding $HOSTNAME to /etc/hosts (sudo)"
  fi
  echo "${SERVER_IP}  ${HOSTNAME}" | sudo tee -a /etc/hosts >/dev/null
  ok "/etc/hosts updated: ${SERVER_IP} → ${HOSTNAME}"
}
update_hosts

# ---- 3. Install root CA into OS trust store -------------------------------
install_ca_macos() {
  info "Installing root CA into macOS system keychain (sudo)"
  sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain "$CA_FILE"
  ok "macOS trust store updated"
}

install_ca_linux() {
  if command -v update-ca-certificates >/dev/null 2>&1; then
    info "Installing root CA via update-ca-certificates (Debian/Ubuntu)"
    sudo cp "$CA_FILE" "/usr/local/share/ca-certificates/${NICK}.crt"
    sudo update-ca-certificates >/dev/null
    ok "System trust store updated (Debian/Ubuntu)"
  elif command -v update-ca-trust >/dev/null 2>&1; then
    info "Installing root CA via update-ca-trust (RHEL/Fedora)"
    sudo cp "$CA_FILE" "/etc/pki/ca-trust/source/anchors/${NICK}.pem"
    sudo update-ca-trust >/dev/null
    ok "System trust store updated (RHEL/Fedora)"
  else
    die "No known Linux trust-store tool found (need update-ca-certificates or update-ca-trust)"
  fi
}

if [ "$OS" = "Darwin" ]; then
  install_ca_macos
else
  install_ca_linux
fi

# ---- 4. Firefox NSS (optional) --------------------------------------------
# Firefox keeps its own cert DB per-profile and ignores the OS trust store.
# If Firefox is installed and we can find its profiles, add the CA there too.
if command -v certutil >/dev/null 2>&1; then
  any=0
  for db in \
    "$HOME/.mozilla/firefox"/*.default* \
    "$HOME/snap/firefox/common/.mozilla/firefox"/*.default* \
    "$HOME/Library/Application Support/Firefox/Profiles"/*.default*; do
    [ -d "$db" ] || continue
    info "Adding CA to Firefox NSS DB: $db"
    certutil -A -d "sql:$db" -t "C,," -n "$NICK" -i "$CA_FILE" >/dev/null 2>&1 || true
    any=1
  done
  [ "$any" = 1 ] && ok "Firefox trust store(s) updated"
fi

# ---- 5. Verify -------------------------------------------------------------
info "Verifying TLS handshake at https://$HOSTNAME/"
if curl -sS --max-time 4 -o /dev/null -w '  handshake ok · HTTP %{http_code}\n' \
    "https://${HOSTNAME}/"; then
  ok "Client is wired up. Your browser's Auth.signIn() now hits amplify-local."
else
  warn "Handshake failed. Check:"
  warn "  - Caddy is running on $SERVER_IP:443 (scripts/setup-cognito-tls-server.sh)"
  warn "  - Firewall / security group allows 443 inbound from this client"
  warn "  - Browsers may need a restart to pick up the new CA"
  exit 1
fi
