#!/usr/bin/env bash
# Deploy Annona to a home server over SSH and (re)build with Docker Compose.
#
# Ships the COMMITTED HEAD (a clean `git archive`), never the dirty working tree,
# so production always matches a known commit. Refuses to deploy if there are
# uncommitted or unpushed changes. Your local .env (gitignored secrets) is copied
# into the staging snapshot so the container's env_file finds it. The SQLite DB
# lives in a docker named volume on the server and survives redeploys.
#
# Usage:  ./deploy.sh [ssh-host] [remote-dir]
#   ssh-host    SSH alias/host (default: home)
#   remote-dir  path on the server (default: ~/annona)
#
# Requires on the server: docker + docker compose, and outbound internet.
set -euo pipefail

HOST="${1:-home}"
DEST="${2:-~/annona}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "-> Verifying the working tree is clean and pushed..."
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: uncommitted changes present. Commit or stash before deploying." >&2
  exit 1
fi
git fetch -q origin "${BRANCH}" 2>/dev/null || true
if [ -n "$(git log "origin/${BRANCH}..HEAD" --oneline 2>/dev/null)" ]; then
  echo "ERROR: local ${BRANCH} is ahead of origin/${BRANCH}. Push before deploying." >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "ERROR: .env not found — the container needs it for secrets." >&2
  exit 1
fi

echo "-> Checking ${HOST} is reachable and has docker..."
ssh "${HOST}" 'docker --version && docker compose version' >/dev/null

echo "-> Staging committed HEAD ($(git rev-parse --short HEAD))..."
STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
git archive --format=tar HEAD | tar -x -C "${STAGE}"   # tracked files only — no .git/node_modules/dirty edits
cp .env "${STAGE}/.env"                                 # gitignored secrets, not in the archive

echo "-> Syncing snapshot to ${HOST}:${DEST} (data volume untouched)..."
rsync -az --delete --exclude data "${STAGE}/" "${HOST}:${DEST}/"

echo "-> Building and starting on ${HOST}..."
ssh "${HOST}" "cd ${DEST} && docker compose up -d --build"

echo
echo "Deployed commit $(git rev-parse --short HEAD) (${BRANCH})."
echo "  First time only - seed the dish DB:"
echo "    ssh ${HOST} 'cd ${DEST} && docker compose run --rm annona bun run src/recipes/seed.ts'"
echo "  Reload dishes after seeding:"
echo "    ssh ${HOST} 'cd ${DEST} && docker compose restart annona'"
echo "  Tail logs:"
echo "    ssh ${HOST} 'cd ${DEST} && docker compose logs -f'"
echo "  Back up the SQLite DB (snapshot into the data volume; copy off-host with rsync):"
echo "    ssh ${HOST} 'cd ${DEST} && docker compose run --rm annona bun run scripts/backup.ts'"
echo "    # cron it, e.g.:  0 3 * * * cd ~/annona && docker compose run --rm annona bun run scripts/backup.ts"
