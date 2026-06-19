#!/usr/bin/env bash
# Phase 11 — E2E validation + production hardening + VPS migration.
#
# Done when:
#   1. E2E test suite exists covering the full user journey:
#      builder (converger) → run → console (inventory + monitoring + SOP export)
#      → value summary → ROI summary generation
#   2. The full E2E suite passes on VPS infrastructure
#   3. Cross-tenant isolation is proven adversarially: tenant A cannot read,
#      list, or trigger any resource belonging to tenant B
#   4. VPS deployment runbook exists at docs/deployment/vps-runbook.md and
#      produces a clean environment from scratch when followed
#   5. DNS points at the VPS and production smoke tests pass
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "p11 FAIL: $*" >&2; exit 1; }

# ── 1. E2E test suite exists ──────────────────────────────────────────────────
E2E_SUITE="tests/e2e/full-journey.test.js"
[ -f "$E2E_SUITE" ] || fail "E2E test suite missing at $E2E_SUITE — write the full-journey tests first"

# ── 2. VPS deployment runbook exists ─────────────────────────────────────────
RUNBOOK="docs/deployment/vps-runbook.md"
[ -f "$RUNBOOK" ] || fail "VPS deployment runbook missing at $RUNBOOK — document the deployment procedure first"

# ── 3. E2E suite passes ───────────────────────────────────────────────────────
# Implement once the suite is written and VPS is provisioned:
#   node --test tests/e2e/full-journey.test.js
echo "p11: E2E suite run not yet implemented — gate fails closed" >&2
echo "    implement: run tests/e2e/full-journey.test.js on VPS and assert exit 0" >&2
exit 1

# ── 4. Cross-tenant adversarial isolation ────────────────────────────────────
# Assert: authenticated as tenant A, every attempt to read/write tenant B's
# workflows, runs, vault entries, or RAG data returns 403 or 404 — never B's data.
# Run: node scripts/checks/p11-cross-tenant-adversarial.mjs

# ── 5. DNS + production smoke test ───────────────────────────────────────────
# Assert: dig/curl resolves atlas.agntic.co to the VPS IP.
# Assert: /health, /api/auth/status, and the builder UI root all return 200.
# Run: node scripts/checks/p11-smoke.mjs

# echo "p11 PASS: E2E suite green on VPS; cross-tenant isolation adversarially confirmed; DNS live; smoke tests pass"
# exit 0
