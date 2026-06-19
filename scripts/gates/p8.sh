#!/usr/bin/env bash
# Phase 8 — web research + filesystem connectors.
#
# Done when:
#   1. Unified web_research connector exists at src/connectors/web-research.js
#      supporting mode: "search" (Tavily), "fetch" (Firecrawl), and "auto"
#      (search → scrape top results when content_needed=true)
#   2. Filesystem connector exists at src/connectors/filesystem.js
#      supporting tenant-scoped read and write operations
#   3. A web_research node with mode=search runs end-to-end: query → Tavily
#      results array with url + snippet fields
#   4. A web_research node with mode=fetch runs end-to-end: URL → Firecrawl
#      markdown content in workflow data
#   5. A filesystem read node runs end-to-end: path → file content in {{nodeId.output}}
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "p8 FAIL: $*" >&2; exit 1; }

# ── 1. Web research connector exists ─────────────────────────────────────────
WEB_CONNECTOR="src/connectors/web-research.js"
[ -f "$WEB_CONNECTOR" ] || fail "web research connector missing at $WEB_CONNECTOR — build the unified search/fetch connector first"

# ── 2. Filesystem connector exists ───────────────────────────────────────────
FS_CONNECTOR="src/connectors/filesystem.js"
[ -f "$FS_CONNECTOR" ] || fail "filesystem connector missing at $FS_CONNECTOR — build the filesystem connector first"

# ── 3. Web research search mode — end-to-end ─────────────────────────────────
# Implement once Tavily API key is configured and connector is wired to the engine:
#   node scripts/checks/p8-web-search.mjs
#   Assert: web_research node with mode=search returns [{url, title, snippet}]
echo "p8: web search end-to-end check not yet implemented — gate fails closed" >&2
echo "    implement: run a web_research search node and assert results array" >&2
exit 1

# ── 4. Web research fetch mode — end-to-end ──────────────────────────────────
# Assert: web_research node with mode=fetch returns markdown content for a URL.
# Run: node scripts/checks/p8-web-fetch.mjs

# ── 5. Filesystem read — end-to-end ──────────────────────────────────────────
# Assert: filesystem read node returns file content into {{nodeId.output}}.
# Run: node scripts/checks/p8-filesystem-read.mjs

# echo "p8 PASS: web_research search + fetch modes live; filesystem read/write live; all run end-to-end"
# exit 0
