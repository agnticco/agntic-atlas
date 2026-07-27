#!/usr/bin/env bash
# Phase 3 — the converger (the IP; long pole).
#
# Done when: from a vague typed intent, the converger reproduces the EXACT
# frozen spec (docs/specs/canonical-ups-slack.json), with each step's
# confirmation logged.
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL. Load-bearing here because line 19 below uses a
# HARD --env-file=.env, and p12.sh runs this script as its first regression step.
. scripts/gates/_no-mail.sh

fail() { echo "p3 FAIL: $*" >&2; exit 1; }

# ── 1. Frozen spec exists ─────────────────────────────────────────────────────
frozen="docs/specs/canonical-ups-slack.json"
[ -f "$frozen" ] || fail "$frozen missing — freeze it in Phase 2 first"

# ── 2. Headless converger run ─────────────────────────────────────────────────
echo "── p3: running converger headless on canonical UPS→Slack intent ──"

RESULT=$(node --env-file=.env scripts/checks/p3-converger-run.mjs 2>/dev/null | tail -1)
echo "  converger result: $RESULT"
echo "$RESULT" | grep -q "^P3-CONVERGER-PASS" || fail "converger did not reproduce spec (got: $RESULT)"

# ── 3. P2 non-regression ──────────────────────────────────────────────────────
bash scripts/gates/p2.sh >/dev/null 2>&1 || fail "P2 regressed"

echo "p3 PASS: converger reproduced UPS→Slack spec from intent; confirmations logged; P2 green"
exit 0
