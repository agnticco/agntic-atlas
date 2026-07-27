#!/usr/bin/env bash
# Phase 8 — web research (search_web native) + filesystem connector.
#
# Done when:
#   1. search_web node type exists and is registered in registerBuiltInNodeTypes
#      (uses Anthropic's native web_search_20260209 tool — no Tavily/Firecrawl needed)
#   2. Filesystem connector exists at src/connectors/filesystem.js with
#      filesystem_read + filesystem_list capabilities
#   3. Both filesystem capabilities are registered in server.js via
#      registerFilesystemCapabilities
#   4. injectFilesystemContext() is called in all three run paths
#      (REST /workflows/run, scheduler token injector, Slack + Airtable event dispatch)
#   5. Filesystem connector sandboxes paths: findApprovedRoot rejects paths
#      outside tenant-approved folders
#   6. End-to-end: a filesystem_read node returns file content in workflow output
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. scripts/gate.sh sources it
# too, but this script is runnable directly (`bash scripts/gates/p8.sh`), and that
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

echo "p8: running gate checks..."

# ── 1. search_web node type ──────────────────────────────────────────────────
check "search-web.js exists" \
  test -f src/workflows/node-types/search-web.js

check "searchWebNodeType exported" \
  grep -q 'export const searchWebNodeType' src/workflows/node-types/search-web.js

check "search_web registered in registerBuiltInNodeTypes" \
  grep -q 'searchWebNodeType' src/workflows/node-types/index.js

check "search_web uses Anthropic native web_search tool" \
  grep -q 'web_search_20260209' src/workflows/node-types/search-web.js

# ── 2. Filesystem connector file ─────────────────────────────────────────────
check "filesystem.js exists" \
  test -f src/connectors/filesystem.js

check "registerFilesystemCapabilities exported" \
  grep -q 'export function registerFilesystemCapabilities' src/connectors/filesystem.js

check "filesystem_read capability defined" \
  grep -q 'filesystem_read' src/connectors/filesystem.js

check "filesystem_list capability defined" \
  grep -q 'filesystem_list' src/connectors/filesystem.js

check "sandbox guard: findApprovedRoot exists" \
  grep -q 'findApprovedRoot' src/connectors/filesystem.js

check "FILESYSTEM_CAPABILITY_IDS exported" \
  grep -q 'FILESYSTEM_CAPABILITY_IDS' src/connectors/filesystem.js

# ── 3. Registered in server.js ───────────────────────────────────────────────
check "registerFilesystemCapabilities imported in server.js" \
  grep -q 'registerFilesystemCapabilities' src/api/server.js

check "registerFilesystemCapabilities called in server.js" \
  grep -q 'registerFilesystemCapabilities(engine.capabilityRegistry' src/api/server.js

# ── 4. injectFilesystemContext wired in all run paths ────────────────────────
check "injectFilesystemContext defined" \
  grep -q 'function injectFilesystemContext' src/api/server.js

check "injectFilesystemContext called in scheduler token injector" \
  grep -q 'injectFilesystemContext(w,' src/api/server.js

check "injectFilesystemContext called in REST /workflows/run" \
  grep -q 'injectFilesystemContext(spec,' src/api/server.js

check "injectFilesystemContext called in event dispatch" \
  grep -q 'injectFilesystemContext(tenantWf,' src/api/server.js

# ── 5. Sandbox: paths outside approved folders are rejected ──────────────────
check "guard() rejects unapproved paths" \
  node --input-type=module --eval "
    import { registerFilesystemCapabilities } from './src/connectors/filesystem.js';
    import { CapabilityRegistry } from './src/connectors/capability-registry.js';
    const reg = new CapabilityRegistry();
    registerFilesystemCapabilities(reg, { getApprovedFolders: () => [] });
    const h = reg.getHandler('filesystem_read');
    h({ config: { _tenantId: 't1', path: '/etc/passwd' } })
      .then(() => process.exit(1))
      .catch(err => err.message.includes('not within any approved') ? process.exit(0) : process.exit(1));
  "

# ── 6. End-to-end: filesystem_read returns file content ─────────────────────
check "filesystem_read end-to-end: reads a file within an approved folder" \
  node scripts/checks/p8-filesystem-read.mjs

# ── Parse checks ─────────────────────────────────────────────────────────────
check "filesystem.js parses cleanly" \
  node --input-type=module --eval "import('./src/connectors/filesystem.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"

check "server.js loads cleanly" \
  node --input-type=module --eval "import('./src/api/server.js').then(()=>process.exit(0)).catch(()=>process.exit(1))"

# Summary
echo ""
echo "p8: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "p8: GATE FAILED" >&2
  exit 1
fi
echo "p8: GATE PASSED"
