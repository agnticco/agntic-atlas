#!/usr/bin/env bash
# release.sh — bump the app version and (optionally) record user-facing release
# notes, in one step. Part of the deploy flow (see docs/deployment/update-protocol.md).
#
#   ./scripts/release.sh patch                                  # silent version bump
#   ./scripts/release.sh minor "Note one." "Note two."          # bump + What's-New entry
#   ./scripts/release.sh patch --title "Faster runs" "We sped up execution."
#
# Bumps package.json (single source of truth → /health + What's-New) and, when
# notes are given, prepends an entry to release-notes.json dated today. Stages
# both files; you then commit + push + run ./scripts/deploy.sh on the VPS.
set -euo pipefail
cd "$(dirname "$0")/.."

LEVEL="${1:-}"
case "$LEVEL" in
  patch|minor|major) ;;
  *) echo "usage: release.sh <patch|minor|major> [--title \"Title\"] [note ...]"; exit 1 ;;
esac
shift

TITLE=""
if [ "${1:-}" = "--title" ]; then TITLE="${2:-}"; shift 2 || true; fi

NEW="$(npm version "$LEVEL" --no-git-tag-version | sed 's/^v//')"
DATE="$(date +%Y-%m-%d)"

if [ "$#" -gt 0 ]; then
  NEW="$NEW" DATE="$DATE" TITLE="$TITLE" node - "$@" <<'NODE'
const fs = require('fs');
const notes = process.argv.slice(2);
const file = 'release-notes.json';
let arr = [];
try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
arr.unshift({
  version: process.env.NEW,
  date: process.env.DATE,
  title: process.env.TITLE || `Version ${process.env.NEW}`,
  notes,
});
fs.writeFileSync(file, JSON.stringify(arr, null, 2) + '\n');
console.log(`release-notes.json: added v${process.env.NEW} (${notes.length} note(s))`);
NODE
  git add package.json package-lock.json release-notes.json
else
  echo "(no notes — silent version bump; nothing added to release-notes.json)"
  git add package.json package-lock.json
fi

# WHY package-lock.json IS STAGED HERE — do not drop it again.
#
# `npm version` above rewrites the version in BOTH package.json and
# package-lock.json (in `version` and in `packages[""].version`). This script
# used to stage only package.json, so every release left the lockfile's version
# behind in the working tree — where it was either committed later by accident or
# discarded. Measured 2026-07-27: the committed lockfile said 1.6.36 while the
# committed package.json said 1.6.42, SIX releases of drift, and the gap had to be
# closed by hand on three consecutive releases that day before this was fixed.
#
# `npm ci` on the box does NOT fail on that mismatch (verified against exactly
# what was on origin/main: 345 packages, clean), so this was never a broken
# deploy. It is a repository that quietly disagrees with itself about what
# version it is — which is the kind of thing someone later debugs for an hour.
#
# Pinned by tests/gates/release-stages-lockfile.test.js.

echo "✓ version is now $NEW and staged."
echo "  Next: git commit → git push origin main → (on VPS) ./scripts/deploy.sh"
