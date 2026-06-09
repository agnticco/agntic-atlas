#!/usr/bin/env bash
# Phase 5 — console UI (greenfield).
# Done when: she sees her automations (inventory), watches a run execute
# step-by-step (live run monitoring), and reads the logs; the SOP view shows
# steps with dependencies.
#
# Replace with the real check, e.g. an e2e test asserting inventory lists the
# workflow, a live run renders per-step, and logs are readable.
set -eu
cd "$(git rev-parse --show-toplevel)"

echo "p5: check not yet implemented — gate fails closed" >&2
echo "    implement: e2e — inventory + live run monitor + SOP view + logs" >&2
exit 1
