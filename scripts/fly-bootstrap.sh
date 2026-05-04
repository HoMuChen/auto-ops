#!/usr/bin/env bash
# One-shot Fly.io deploy: stage secrets, deploy, provision the custom-domain
# TLS cert, and smoke-test /health.
#
# Usage:
#   ./scripts/fly-bootstrap.sh                                     # defaults
#   FLY_APP_NAME=staging API_DOMAIN=api.staging.autoffice.app \
#     ENV_FILE=.env.staging ./scripts/fly-bootstrap.sh
#
# Pre-reqs:
#   1. flyctl installed   →  https://fly.io/docs/flyctl/install/
#   2. fly auth login     →  authenticated
#   3. App already claimed: fly launch --copy-config --no-deploy
#   4. DB migrations applied to production: pnpm db:migrate
#      (against the production DATABASE_URL, run from local — idempotent)
#
# This script is idempotent — safe to re-run after code changes or env edits.

set -euo pipefail

APP_NAME="${FLY_APP_NAME:-auto-ops-api}"
DOMAIN="${API_DOMAIN:-api.autoffice.app}"
ENV_FILE="${ENV_FILE:-.env.prod}"

log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# 1. Pre-flight checks
command -v fly >/dev/null 2>&1 \
  || fail 'flyctl not installed — see https://fly.io/docs/flyctl/install/'
[[ -f "$ENV_FILE" ]] \
  || fail "missing $ENV_FILE (set ENV_FILE=... to override)"
fly auth whoami >/dev/null 2>&1 \
  || fail 'not logged in — run: fly auth login'
fly status --app "$APP_NAME" >/dev/null 2>&1 \
  || fail "app '$APP_NAME' not found — run: fly launch --copy-config --no-deploy"

# 2. Stage secrets — --stage avoids restart-per-secret; the deploy below
#    rolls everything in a single machine restart.
log "Staging secrets from $ENV_FILE → $APP_NAME"
fly secrets import --stage --app "$APP_NAME" < "$ENV_FILE"
ok 'Secrets staged'

# 3. Deploy
log 'Deploying…'
fly deploy --app "$APP_NAME"
ok 'Deployed'

# 4. Custom-domain TLS cert — idempotent (re-running on an existing cert is a no-op)
log "Ensuring TLS cert for $DOMAIN"
fly certs create "$DOMAIN" --app "$APP_NAME" 2>/dev/null || true
fly certs show "$DOMAIN" --app "$APP_NAME" || true

# 5. Smoke check via *.fly.dev (resolvable as soon as the machine is up,
#    independent of whether your custom-domain DNS has propagated yet).
INTERNAL_URL="https://${APP_NAME}.fly.dev/health"
log "Health check: $INTERNAL_URL"
for _ in $(seq 1 30); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$INTERNAL_URL" || echo '000')
  if [[ "$code" == '200' ]]; then
    ok 'Healthy'
    log "Once Cloudflare DNS for $DOMAIN points at Fly (grey cloud, CNAME → ${APP_NAME}.fly.dev or A/AAAA per 'fly certs show'), https://$DOMAIN/health should also serve 200."
    exit 0
  fi
  sleep 2
done
fail "/health did not return 200 within 60s — investigate: fly logs --app $APP_NAME"
