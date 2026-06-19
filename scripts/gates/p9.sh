#!/usr/bin/env bash
# Phase 9 — value tracking (time-saved / ROI metrics).
#
# Done when:
#   1. A value calculation config exists that defines how time-saved is computed
#      per workflow (methodology finalized in-phase — candidates: user-entered
#      estimate during converger elicitation, step-count heuristic, post-run
#      confirmation prompt)
#   2. A completed run log carries a time_saved_minutes field populated by the
#      engine after execution
#   3. The console shows per-workflow and all-up time-saved totals for a tenant
#   4. A one-page ROI summary can be generated and is human-readable
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "p9 FAIL: $*" >&2; exit 1; }

# ── 1. Value calculation config exists ───────────────────────────────────────
VALUE_CONFIG="src/value/time-saved-config.js"
[ -f "$VALUE_CONFIG" ] || fail "value calculation config missing at $VALUE_CONFIG — define the methodology first"

# ── 2. Run log carries time_saved_minutes ────────────────────────────────────
# Implement once the engine writes value metadata to run logs:
#   node scripts/checks/p9-value-run.mjs
#   Assert: completed run log contains time_saved_minutes > 0
echo "p9: run-log value check not yet implemented — gate fails closed" >&2
echo "    implement: run a workflow, inspect run log for time_saved_minutes" >&2
exit 1

# ── 3. Console value totals (UI check — implement with e2e tooling) ──────────
# Assert: per-workflow total and all-up tenant total render in the console.

# ── 4. ROI summary generation ────────────────────────────────────────────────
# Assert: generate command produces a readable one-page summary (PDF or HTML).

# echo "p9 PASS: value tracking live; run logs carry time_saved_minutes; console totals render; ROI summary generates"
# exit 0
