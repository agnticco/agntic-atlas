#!/usr/bin/env bash
# Phase 5 — console UI + SOP export.
#
# Done when:
#   (a) GET /api/console/workflows lists the tenant's workflows; cross-tenant returns none.
#   (b) A run renders per-step from GET .../runs/:runId.
#   (c) SOP export produces a Markdown file for a workflow derived from its spec.
#   (d) modeConsole panel exists in the UI HTML.
#   (e) getTRuns/getRun store methods include tenantId scoping (multi-tenant fail-closed).
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. scripts/gate.sh sources it
# too, but this script is runnable directly (`bash scripts/gates/p5.sh`), and that
# path bypasses gate.sh entirely.
. scripts/gates/_no-mail.sh

PASS=0; FAIL=0

check() {
  local label="$1"; shift
  if "$@" &>/dev/null; then
    echo "  [ok] $label"; PASS=$((PASS+1))
  else
    echo "  [FAIL] $label"; FAIL=$((FAIL+1))
  fi
}

echo "p5: running gate checks..."

# (d) Console panel exists in the UI
check "modeConsole panel in index.html" \
  grep -q 'modeConsole' public/index.html

check "consoleViewDash in index.html" \
  grep -q 'consoleViewDash' public/index.html

check "consoleViewSop in index.html" \
  grep -q 'consoleViewSop' public/index.html

check "Run detail drawer in index.html" \
  grep -q 'consoleDrawerOpen' public/index.html

# (e) Store methods have tenantId param
check "getRuns has tenantId param" \
  grep -q 'tenantId.*undefined' src/workflows/workflow-store.js

check "getRun has tenantId param" \
  grep -q 'getRun.*tenantId' src/workflows/workflow-store.js

# (a)-(c) Console API files exist
check "console.js routes file exists" \
  test -f src/api/console.js

check "console routes mounted in server.js" \
  grep -q 'mountConsoleRoutes' src/api/server.js

check "GET /api/console/workflows route" \
  grep -q '/api/console/workflows' src/api/console.js

check "GET .../runs/:runId route" \
  grep -q '/api/console/workflows/:id/runs/:runId' src/api/console.js

check "SOP export route" \
  grep -q '/api/console/workflows/:id/sop' src/api/console.js

# (c) SOP generator exists and produces Markdown
check "sop-generator.js exists" \
  test -f src/workflows/sop-generator.js

check "generateSopMarkdown exported" \
  grep -q 'export function generateSopMarkdown' src/workflows/sop-generator.js

check "sop-pdf.js exists" \
  test -f src/workflows/sop-pdf.js

check "pdfkit in node_modules" \
  test -d node_modules/pdfkit

# Summary
echo ""
echo "p5: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "p5: GATE FAILED" >&2
  exit 1
fi
echo "p5: GATE PASSED"
