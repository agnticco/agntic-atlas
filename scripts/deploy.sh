#!/usr/bin/env bash
# Atlas deploy/update — pull latest main, install, restart the service, verify.
# Run as the `atlas` user on the VPS from ~/atlas. See docs/deployment/vps-runbook.md §10.
#
#   ./scripts/deploy.sh
#
# SIGTERM (via systemctl restart) triggers a graceful drain: the scheduler stops,
# in-flight requests finish, a WAL checkpoint runs on clean shutdown.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "→ fetching latest main"
git fetch --quiet origin main
BEFORE="$(git rev-parse HEAD)"
git checkout --quiet main
git pull --quiet --ff-only origin main
AFTER="$(git rev-parse HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  echo "→ already up to date ($AFTER) — nothing to deploy"
  exit 0
fi
echo "→ $BEFORE → $AFTER"

echo "→ installing dependencies (npm ci)"
npm ci --omit=dev 2>/dev/null || npm ci

echo "→ restarting service"
sudo systemctl restart atlas

echo "→ waiting for health"
for i in $(seq 1 30); do
  if curl -fsS http://localhost:3000/health >/dev/null 2>&1; then
    echo "✓ healthy after ${i}s — deployed $AFTER"
    exit 0
  fi
  sleep 1
done

echo "✗ service did not become healthy within 30s — check: journalctl -u atlas -n 50" >&2
echo "  rollback: git checkout $BEFORE && npm ci && sudo systemctl restart atlas" >&2
exit 1
