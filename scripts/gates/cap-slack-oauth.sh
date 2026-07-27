#!/usr/bin/env bash
# Capability check — Slack connector OAuth (user-authorization) install flow.
#
# Verifies a client can authorize the Atlas Slack app (no API-console access, no
# Marketplace listing) and that the workspace token is stored + used per tenant:
#   - authorize -> callback -> oauth.v2.access exchange stores a per-tenant token,
#   - tenants are isolated (each gets its own token; no cross-tenant token use),
#   - an authenticated run posts with the tenant's OWN OAuth token (no env token),
#   - /connectors/slack/status + /capabilities reflect the per-tenant grant,
#   - disconnect removes only that tenant's install.
#
# Fully offline (stubbed Slack). Fail-closed.
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. Load-bearing here because
# the capability checks are NOT reachable through scripts/gate.sh, so nothing else
# establishes it for them. No check below sends mail today; this keeps that true for
# the one added later that nobody remembered to guard.
. scripts/gates/_no-mail.sh

fail() { echo "cap-slack-oauth FAIL: $*" >&2; exit 1; }

echo "── cap: Slack OAuth install flow (per-tenant) ──"
out="$(node scripts/checks/slack-oauth.mjs 2>&1 || true)"
echo "$out" | grep -E '^(ok|FAIL)' || true
echo "$out" | grep -q 'SLACK-OAUTH-PASS' || { echo "$out" | tail -25 >&2; fail "Slack OAuth flow check did not pass"; }

echo "cap-slack-oauth PASS: client OAuth install -> per-tenant token storage, isolation, and posting verified"
exit 0
