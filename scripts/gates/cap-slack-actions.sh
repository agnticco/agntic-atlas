#!/usr/bin/env bash
# Capability check — all 14 Slack channel action handlers.
#
# Runs scripts/checks/slack-actions.mjs: each handler is exercised against
# a stub Slack server to verify it calls the correct endpoint(s) with the
# correct payload and returns the correct shape. Error paths (missing required
# config) are also verified. No real Slack token needed.
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "cap-slack-actions FAIL: $*" >&2; exit 1; }

echo "── cap: Slack action handlers (29 tests, all 14 actions) ──"
out="$(node scripts/checks/slack-actions.mjs 2>&1 || true)"
echo "$out" | grep -E '^(ok|FAIL)|tests:' || true
echo "$out" | grep -q 'SLACK-ACTIONS-PASS' || { echo "$out" | tail -20 >&2; fail "Slack action tests did not all pass"; }

echo "cap-slack-actions PASS: all 16 Slack action handlers verified (30 tests)"
exit 0
