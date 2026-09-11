#!/usr/bin/env bash
# Create (or rotate) the cluster's Secret with freshly generated values.
#
# Nothing is written to disk and nothing is committed. `kubectl create ... |
# kubectl apply -f -` is used instead of `kubectl create` alone so this is
# idempotent: running it again replaces the Secret rather than erroring.
set -euo pipefail

# openssl rather than `tr -dc ... | head -c`: head closes the pipe early, tr
# takes SIGPIPE, and with `set -o pipefail` the whole script dies silently.
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"

kubectl create secret generic pong-secrets \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "pong-secrets created/rotated."
echo "NOTE: rotating JWT_SECRET invalidates every issued token - users must sign in again."
echo "NOTE: PostgreSQL only reads POSTGRES_PASSWORD when it initialises an empty"
echo "      data directory. Rotating it does NOT change an existing database's password."
