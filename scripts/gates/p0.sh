#!/usr/bin/env bash
# Phase 0 — clean spine.
# Done when: the existing engine boots in the new repo and the empty UI reaches
# it over one health route.
#
# Replace the body below with the real check, e.g.:
#   - boot the server, curl the health route, assert 200 + expected payload
#   - assert server.js is clean UTF-8 (no encoding that breaks plain grep)
set -eu
cd "$(git rev-parse --show-toplevel)"

echo "p0: check not yet implemented — gate fails closed" >&2
echo "    implement: engine boots + UI hits one health route (see build plan)" >&2
exit 1
