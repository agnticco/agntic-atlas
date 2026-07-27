#!/usr/bin/env bash
# Phase 9 — value tracking (time-saved / ROI metrics).
#
# Done when:
#   1. A value calculation config exists that defines how time-saved is computed
#   2. The run log carries a time_saved_minutes column populated by the engine
#   3. The console exposes per-workflow profile + all-up ROI summary
#   4. A one-page ROI summary can be generated (via /api/console/roi)
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. scripts/gate.sh sources it
# too, but this script is runnable directly (`bash scripts/gates/p9.sh`), and that
# path bypasses gate.sh entirely.
. scripts/gates/_no-mail.sh

fail() { echo "p9 FAIL: $*" >&2; exit 1; }

# ── 1. Value calculation config exists ───────────────────────────────────────
VALUE_CONFIG="src/value/time-saved-config.js"
[ -f "$VALUE_CONFIG" ] || fail "value calculation config missing at $VALUE_CONFIG"
grep -q "computeTimeSavedMinutes" "$VALUE_CONFIG" || fail "$VALUE_CONFIG exists but computeTimeSavedMinutes export is missing"

# ── 2. time_saved_minutes column in workflow_runs ────────────────────────────
DB="./memory/workflows/workflows.sqlite"
[ -f "$DB" ] || fail "workflow DB not found at $DB — start the server at least once to initialise"
col=$(sqlite3 "$DB" "SELECT name FROM pragma_table_info('workflow_runs') WHERE name='time_saved_minutes'" 2>/dev/null || true)
[ "$col" = "time_saved_minutes" ] || fail "time_saved_minutes column missing from workflow_runs — restart the server to apply the migration"

# ── 3. Per-workflow profile endpoint ─────────────────────────────────────────
grep -q "workflows/:id/profile" src/api/console.js || fail "per-workflow profile endpoint missing from console.js"
grep -q "timeSavedYtdS\|time_saved" src/api/console.js || fail "time-saved computation missing from profile endpoint"

# ── 4. All-up ROI summary endpoint ───────────────────────────────────────────
grep -q "api/console/roi" src/api/console.js || fail "ROI summary endpoint (GET /api/console/roi) missing from console.js"
grep -q "totalTimeSavedMinutes" src/api/console.js || fail "totalTimeSavedMinutes missing from ROI response"

# ── 5. Profile surface in UI ─────────────────────────────────────────────────
grep -q "consoleProfile\|onSwitchProfile" public/index.html || fail "profile surface missing from index.html"

echo "p9 PASS: value config defined; time_saved_minutes column live; profile + ROI endpoints present; UI surface present"
exit 0
