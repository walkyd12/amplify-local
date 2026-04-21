.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# amplify-local — convenience targets
#
# The Makefile is a thin wrapper over the scripts in scripts/ and the
# CLI under bin/. Every target is safe to re-run.
# ---------------------------------------------------------------------------

# ---- Core workflow --------------------------------------------------------

.PHONY: install
install:  ## Install npm dependencies
	npm install

.PHONY: up
up: docker-start start  ## Bring up DynamoDB Local + amplify-local (foreground; Ctrl-C to stop)

.PHONY: down
down: stop docker-stop  ## Stop amplify-local and tear down DynamoDB Local

.PHONY: start
start:  ## Start amplify-local (foreground). Stops on Ctrl-C.
	npx amplify-local start

.PHONY: stop
stop:  ## Stop the running amplify-local instance
	npx amplify-local stop

.PHONY: status
status:  ## Health-check running services
	npx amplify-local status

.PHONY: docker-start
docker-start:  ## Start DynamoDB Local via docker compose
	npx amplify-local docker:start

.PHONY: docker-start-ephemeral
docker-start-ephemeral:  ## Start DynamoDB Local in-memory (no persistence)
	npx amplify-local docker:start --ephemeral

.PHONY: docker-stop
docker-stop:  ## Stop DynamoDB Local (data volume removed)
	npx amplify-local docker:stop -v

# ---- Tests ----------------------------------------------------------------

.PHONY: test
test: test-unit  ## Alias for test-unit

.PHONY: test-unit
test-unit:  ## Run unit tests
	npm run test:unit

.PHONY: test-integration
test-integration:  ## Run integration tests (requires DynamoDB Local)
	npm run test:integration

.PHONY: test-all
test-all:  ## Run unit + integration tests
	npm run test:all

# ---- Cognito TLS automation -----------------------------------------------
#
# Usage:
#   make tls-server                        # on the machine running amplify-local
#   make tls-caddy                         # then start Caddy to serve HTTPS
#   make tls-client SERVER=1.2.3.4         # on each laptop / agent
#   make tls-client SERVER=1.2.3.4 CA=...  # with explicit CA source
#

.PHONY: tls-server
tls-server:  ## Generate TLS cert + Caddyfile for the Cognito endpoint
	./scripts/setup-cognito-tls-server.sh

.PHONY: tls-caddy
tls-caddy:  ## Start Caddy on :443 using the generated config (needs sudo)
	@test -f .amplify-local/tls/Caddyfile \
	  || { echo "Run 'make tls-server' first — Caddyfile not found"; exit 1; }
	sudo caddy run --config .amplify-local/tls/Caddyfile

.PHONY: tls-client
tls-client:  ## Wire this machine's browser to the remote Cognito (SERVER=ip [CA=path|url])
	@test -n "$(SERVER)" \
	  || { echo "usage: make tls-client SERVER=<ip> [CA=<path-or-url>]"; exit 1; }
	./scripts/setup-cognito-tls-client.sh $(SERVER) $(CA)

# ---- Help -----------------------------------------------------------------

.PHONY: help
help:  ## Show this help
	@awk 'BEGIN { FS = ":.*##"; printf "\nUsage: make \033[36m<target>\033[0m\n\nTargets:\n" } \
	  /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 }' \
	  $(MAKEFILE_LIST)
	@echo
