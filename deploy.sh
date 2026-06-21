#!/usr/bin/env bash
# Deploy Annona to a home server over SSH and (re)build with Docker Compose.
#
# Usage:  ./deploy.sh [ssh-host] [remote-dir]
#   ssh-host    SSH alias/host (default: home)
#   remote-dir  path on the server (default: ~/annona)
#
# Requires on the server: docker + docker compose, and outbound internet.
# Your local .env (with the real secrets) is rsynced so the container's
# env_file finds it. The SQLite DB lives in a docker named volume on the
# server, so it survives redeploys (rsync never touches it).
set -euo pipefail

HOST="${1:-home}"
DEST="${2:-~/annona}"

echo "→ Checking $HOST is reachable and has docker…"
ssh "$HOST" 'docker --version && docker compose version' >/dev/null

echo "→ Syncing project to $HOST:$DEST (excluding build junk; .env IS sent)…"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude data \
  --exclude .superpowers --exclude .claude --exclude .cursor \
  ./ "$HOST:$DEST/"

echo "→ Building & starting on $HOST…"
ssh "$HOST" "cd $DEST && docker compose up -d --build"

echo
echo "✓ Deployed."
echo "  First time only — seed the dish DB:"
echo "    ssh $HOST 'cd $DEST && docker compose run --rm annona bun run src/recipes/seed.ts'"
echo "  Tail logs:"
echo "    ssh $HOST 'cd $DEST && docker compose logs -f'"
