#!/usr/bin/env bash
# Phase 11 — E2E validation + production hardening + VPS migration.
#
# Done when:
#   1. E2E suite covers the full journey: builder (converger) → run → console
#      (inventory + monitoring + SOP export) → value/ROI summary — and PASSES.
#   2. Cross-tenant isolation proven adversarially: tenant A cannot read, list,
#      or trigger any resource belonging to tenant B (workflows/runs/vault/RAG).
#   3. VPS deployment runbook exists and is followable.
#   4. DNS points at the VPS and production smoke tests pass.
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. scripts/gate.sh sources it
# too, but this script is runnable directly (`bash scripts/gates/p11.sh`), and that
# path bypasses gate.sh entirely.
. scripts/gates/_no-mail.sh

fail() { echo "p11 FAIL: $*" >&2; exit 1; }

# ── 1. E2E suite exists and passes ───────────────────────────────────────────
# Deterministic (engine LLM stubbed). The converger sub-test self-skips without
# ANTHROPIC_API_KEY and runs on the VPS where a cloud key is required.
E2E_SUITE="tests/e2e/full-journey.test.js"
[ -f "$E2E_SUITE" ] || fail "E2E suite missing at $E2E_SUITE"
echo "p11: running E2E full-journey suite..."
node --test "$E2E_SUITE" >/tmp/p11-e2e.log 2>&1 || { tail -40 /tmp/p11-e2e.log >&2; fail "E2E suite did not pass"; }

# ── 2. Cross-tenant adversarial isolation ────────────────────────────────────
echo "p11: running cross-tenant adversarial check..."
node scripts/checks/p11-cross-tenant-adversarial.mjs >/tmp/p11-adv.log 2>&1 \
  || { tail -40 /tmp/p11-adv.log >&2; fail "cross-tenant adversarial check failed"; }
grep -q 'CROSS-TENANT-ADVERSARIAL-PASS' /tmp/p11-adv.log || fail "adversarial check did not report PASS"

# ── 3. VPS deployment runbook exists ─────────────────────────────────────────
RUNBOOK="docs/deployment/vps-runbook.md"
[ -f "$RUNBOOK" ] || fail "VPS deployment runbook missing at $RUNBOOK"

# ── 4. DNS + production smoke (requires a live VPS) ──────────────────────────
# Gated on PROD_HOST so the gate stays fail-closed until the app is actually
# deployed and DNS points at the VPS. Everything above runs locally/CI.
if [ -z "${PROD_HOST:-}" ]; then
  fail "PROD_HOST unset — local artifacts pass (E2E, adversarial, runbook). Deploy per $RUNBOOK, point DNS at the VPS, then re-run: PROD_HOST=atlas.agntic.co bash scripts/gate.sh 11"
fi
echo "p11: running production smoke against ${PROD_HOST}..."
node scripts/checks/p11-smoke.mjs >/tmp/p11-smoke.log 2>&1 || { tail -40 /tmp/p11-smoke.log >&2; fail "production smoke test failed"; }
grep -q 'SMOKE-PASS' /tmp/p11-smoke.log || fail "smoke test did not report PASS"

echo "p11 PASS: E2E green; cross-tenant isolation adversarially confirmed; runbook present; DNS live; smoke passed"
exit 0
