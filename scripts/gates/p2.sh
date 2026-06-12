#!/usr/bin/env bash
# Phase 2 — event triggers + Gmail.
#
# Done when:
#   1. The canonical UPS→Slack spec exists at docs/specs/canonical-ups-slack.json
#      (committed, valid JSON, has an email trigger and at least 2 nodes).
#   2. The spec runs through the engine end-to-end: a mock UPS email is injected
#      as initialContext → summarize node processes it → deliver node posts to Slack
#      (stub) → ts returned.
#   3. The Google/G-Suite connector loads cleanly (capability map valid, all
#      imports resolve).
#
# The real-email test (live Gmail with GOOGLE_OAUTH_CLIENT_ID) is run manually
# before gate close and recorded in docs/gates/p2.md.
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "p2 FAIL: $*" >&2; exit 1; }

# ── 1. Canonical spec ─────────────────────────────────────────────────────────
SPEC="docs/specs/canonical-ups-slack.json"
[ -f "$SPEC" ] || fail "$SPEC does not exist"
node -e "
const s = require('./$SPEC');
if (!s.triggers?.length)    throw new Error('no triggers');
if (!s.nodes?.length || s.nodes.length < 2) throw new Error('need at least 2 nodes');
if (!s.triggers.some(t => t.type === 'email')) throw new Error('no email trigger');
console.log('spec ok: ' + s.name + ' (' + s.nodes.length + ' nodes, email trigger)');
" || fail "$SPEC is invalid or missing required fields"

# ── 2. End-to-end engine run with mock email ──────────────────────────────────
echo "── p2: running canonical spec through engine with mock UPS email ──"

STUB_PORT="${P2_STUB_PORT:-3993}"
node scripts/checks/stub-slack.mjs > /tmp/p2-stub.log 2>&1 &
STUB_PID=$!
TMP_DIR="$(mktemp -d -t atlas-p2.XXXXXX)"

cleanup() {
  kill "$STUB_PID" 2>/dev/null || true
  wait "$STUB_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# Wait for stub to be ready.
for _ in $(seq 1 20); do
  curl -fs "http://127.0.0.1:${STUB_PORT}/health" >/dev/null 2>&1 && break || true
  sleep 0.2
done

RESULT=$(STUB_PORT="$STUB_PORT" \
  SLACK_API_URL="http://127.0.0.1:${STUB_PORT}" \
  node scripts/checks/p2-engine-run.mjs 2>/dev/null | tail -1)

echo "  engine result: $RESULT"
echo "$RESULT" | grep -q "^P2-ENGINE-PASS" || fail "engine run did not reach Slack (got: $RESULT)"

# ── 3. G-Suite connector loads clean ─────────────────────────────────────────
node --input-type=module -e "
import { googleCapabilities, resolveGoogleCapabilities } from './src/connectors/google/index.js';
const r = resolveGoogleCapabilities([]);
if (!r.actions.length) throw new Error('no actions');
console.log('google connector: ' + r.actions.length + ' G-Suite actions in capability map');
" || fail "Google connector failed to load"

# ── 4. P0 non-regression ─────────────────────────────────────────────────────
bash scripts/gates/p0.sh >/dev/null 2>&1 || fail "P0 regressed"

echo "p2 PASS: canonical UPS→Slack spec fires on mock email (email→summarize→Slack ts); G-Suite connector ready; P0 green"
exit 0
