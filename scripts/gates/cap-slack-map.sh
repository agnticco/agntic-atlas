#!/usr/bin/env bash
# Capability check — Slack capability map (P1-domain follow-up).
#
# Verifies the declarative Slack capability map + per-client scope resolution:
#   1. availability = implemented AND requiredScopes ⊆ the token's granted scopes,
#   2. granted scopes are auto-detected from Slack's x-oauth-scopes header,
#   3. GET /capabilities exposes connectors.slack with per-client availability flags.
#
# Fully offline (local stub). Fail-closed.
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. Load-bearing here because
# the capability checks are NOT reachable through scripts/gate.sh, so nothing else
# establishes it for them. No check below sends mail today; this keeps that true for
# the one added later that nobody remembered to guard.
. scripts/gates/_no-mail.sh

fail() { echo "cap-slack-map FAIL: $*" >&2; exit 1; }

[ -f src/connectors/slack/capabilities.json ] || fail "capabilities.json missing"
node -e 'JSON.parse(require("fs").readFileSync("src/connectors/slack/capabilities.json","utf8"))' \
  || fail "capabilities.json is not valid JSON"

echo "── cap: Slack capability map (scope-gated availability + /capabilities) ──"
out="$(node scripts/checks/slack-capabilities.mjs 2>&1)" || { echo "$out" | tail -25 >&2; fail "capability check errored"; }
echo "$out" | grep -E '^(ok|FAIL)|menu:' || true
echo "$out" | grep -q 'SLACK-CAP-PASS' || { echo "$out" | tail -25 >&2; fail "capability map assertions did not pass"; }

echo "cap-slack-map PASS: scope-gated Slack capability map resolves per client and is exposed via /capabilities"
exit 0
