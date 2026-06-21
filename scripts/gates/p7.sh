#!/usr/bin/env bash
# Phase 7 — Airtable connector + Google write-back + sub-daily scheduling + error handling.
#
# Done when:
#   (a) CapabilityRegistry is instantiated and wired in server.js (unified catalog).
#   (b) Airtable connector exists with PAT auth, CRUD record handlers, and webhook support.
#   (c) registerAirtableChannels registers capabilities in the catalog.
#   (d) Sub-daily cron patterns (*/N minute, 0 */N hour) are handled in _isFlowDue.
#   (e) WorkflowScheduler._executeFlow wraps _runFlowOnce with retry + error notification.
#   (f) error_handling.notify Slack path wired in server.js via registerErrorNotifier.
#   (g) Google write-back capabilities (gmail_send, calendar_create_event, sheets_append,
#       docs_create, tasks_create) registered in the catalog.
set -eu
cd "$(git rev-parse --show-toplevel)"

PASS=0; FAIL=0

check() {
  local label="$1"; shift
  if "$@" &>/dev/null; then
    echo "  [ok] $label"; PASS=$((PASS+1))
  else
    echo "  [FAIL] $label"; FAIL=$((FAIL+1))
  fi
}

echo "p7: running gate checks..."

# (a) CapabilityRegistry
check "capability-registry.js exists" \
  test -f src/connectors/capability-registry.js

check "CapabilityRegistry class exported" \
  grep -q 'export class CapabilityRegistry' src/connectors/capability-registry.js

check "CapabilityRegistry instantiated in server.js" \
  grep -q 'new CapabilityRegistry' src/api/server.js

check "channelRegistry receives capabilityRegistry" \
  grep -q 'new ChannelRegistry(capabilityRegistry)' src/api/server.js

# (b) Airtable connector file
check "airtable/index.js exists" \
  test -f src/connectors/airtable/index.js

check "makeAirtableApi exported" \
  grep -q 'export function makeAirtableApi' src/connectors/airtable/index.js

check "storeAirtableToken exported from oauth.js" \
  grep -q 'export function storeAirtableToken' src/connectors/airtable/oauth.js

check "initWebhookStore exported" \
  grep -q 'export function initWebhookStore' src/connectors/airtable/index.js

check "verifyAirtableSignature exported" \
  grep -q 'export function verifyAirtableSignature' src/connectors/airtable/index.js

check "airtableCreateRecord exported" \
  grep -q 'export async function airtableCreateRecord' src/connectors/airtable/index.js

# (c) Airtable capabilities registered
check "registerAirtableChannels exported" \
  grep -q 'export function registerAirtableChannels' src/connectors/airtable/index.js

check "registerAirtableChannels called in server.js" \
  grep -q 'registerAirtableChannels' src/api/server.js

check "airtable_list_records capability registered" \
  grep -q 'airtable_list_records' src/connectors/airtable/index.js

check "airtable_record_changed trigger registered" \
  grep -q 'airtable_record_changed' src/connectors/airtable/index.js

# (d) Sub-daily scheduling
check "_isFlowDue handles */N minute pattern" \
  grep -q 'everyMinMatch' src/workflows/workflow-store.js

check "_isFlowDue handles 0 */N hour pattern" \
  grep -q 'everyHrMatch' src/workflows/workflow-store.js

check "elapsed-time dedup for sub-daily" \
  grep -q 'intervalMs' src/workflows/workflow-store.js

# (e) Retry logic in scheduler
check "_runFlowOnce method exists (extracted from _executeFlow)" \
  grep -q '_runFlowOnce' src/workflows/workflow-scheduler.js

check "_executeFlow has maxAttempts retry loop" \
  grep -q 'maxAttempts' src/workflows/workflow-scheduler.js

check "retry delay_seconds respected" \
  grep -q 'retryDelayMs' src/workflows/workflow-scheduler.js

# (f) Error notifier wired
check "registerErrorNotifier method exists" \
  grep -q 'registerErrorNotifier' src/workflows/workflow-scheduler.js

check "registerErrorNotifier called in server.js" \
  grep -q 'registerErrorNotifier' src/api/server.js

check "Slack notify path in server.js" \
  grep -q "chat.postMessage" src/api/server.js

# (g) Google write capabilities
check "registerGoogleChannels exported from google/index.js" \
  grep -q 'export function registerGoogleChannels' src/connectors/google/index.js

check "gmail_send registered" \
  grep -q 'gmail_send' src/connectors/google/index.js

check "calendar_create_event registered" \
  grep -q 'calendar_create_event' src/connectors/google/index.js

check "sheets_append registered" \
  grep -q 'sheets_append' src/connectors/google/index.js

check "registerGoogleChannels called in server.js" \
  grep -q 'registerGoogleChannels' src/api/server.js

# Testability env var overrides
check "AIRTABLE_OAUTH_URL override in oauth.js (stub-testable)" \
  grep -q 'AIRTABLE_OAUTH_URL' src/connectors/airtable/oauth.js

check "AIRTABLE_API_URL override in index.js (stub-testable)" \
  grep -q 'AIRTABLE_API_URL' src/connectors/airtable/index.js

# Airtable OAuth E2E (stubbed Airtable, real spine, two tenants, isolation, run, disconnect)
check "airtable OAuth E2E passes" \
  node scripts/checks/airtable-oauth.mjs

# Parse check — grep passes even on non-parsing source; verify the modules load
check "workflow-store.js parses (node import)" \
  node --input-type=module --eval "import('./src/workflows/workflow-store.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"

check "server.js loads cleanly (node import)" \
  node --input-type=module --eval "import('./src/api/server.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"

# Summary
echo ""
echo "p7: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "p7: GATE FAILED" >&2
  exit 1
fi
echo "p7: GATE PASSED"
