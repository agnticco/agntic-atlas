#!/usr/bin/env bash
# Phase 10 — admin observability (standalone web app).
#
# Done when:
#   1. The admin app exists as a distinct service/route, separate from the
#      user-facing console — non-admin users cannot reach it
#   2. Per-tenant run counts and cost breakdowns are queryable via the admin API
#   3. A non-admin session receives 403 on all admin endpoints (access control)
#   4. Data is scoped per-tenant — one tenant's metrics are not visible from
#      another tenant's admin view (isolation, not just filtering)
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "p10 FAIL: $*" >&2; exit 1; }

# ── 1. Admin app entry point exists ──────────────────────────────────────────
ADMIN_ENTRY="src/admin/server.js"
[ -f "$ADMIN_ENTRY" ] || fail "admin app entry point missing at $ADMIN_ENTRY — build the admin service first"

# ── 2. Per-tenant metrics endpoints ──────────────────────────────────────────
# Implement once the admin API is wired:
#   node scripts/checks/p10-admin-metrics.mjs
#   Assert: /admin/tenants/:id/runs returns run count
#   Assert: /admin/tenants/:id/cost returns cost breakdown
echo "p10: metrics endpoint check not yet implemented — gate fails closed" >&2
echo "    implement: query /admin/tenants/:id/runs and /admin/tenants/:id/cost" >&2
exit 1

# ── 3. Access control — 403 for non-admin ────────────────────────────────────
# Assert: a valid non-admin JWT receives 403 on every /admin/* route.

# ── 4. Cross-tenant isolation ────────────────────────────────────────────────
# Assert: tenant A's admin session cannot read tenant B's metrics.
# (Adversarial: attempt cross-tenant query; assert empty or 403, never B's data.)

# echo "p10 PASS: admin app live; metrics endpoints return data; non-admin 403; cross-tenant isolation confirmed"
# exit 0
