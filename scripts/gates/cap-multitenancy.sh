#!/usr/bin/env bash
# Capability check — multi-tenancy data isolation (foundational).
#
# Proves, fail-closed, that one tenant's data never surfaces in another's:
#   1. Auth/vault: fail-closed scoping, JWT tid, cross-tenant vault isolation.
#   2. Workflow store: two-tenant create/list/get isolation + run/version inherit.
#   3. RAG: per-tenant physical isolation (cross-tenant retrieval impossible).
#   4. HTTP adversarial: tenant admins can't reach platform endpoints or other
#      tenants' users; tokens are tenant-bound; suspension locks a tenant out.
#
# (3) needs the local embedding GGUF present; the rest are model-free. Fail-closed.
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "cap-multitenancy FAIL: $*" >&2; exit 1; }
run() { # <label> <script> <marker>
  echo "── $1 ──"
  local out; out="$(node "$2" 2>&1 || true)"
  echo "$out" | grep -E '^(ok|FAIL)' || true
  echo "$out" | grep -q "$3" || { echo "$out" | tail -20 >&2; fail "$1 did not pass ($3)"; }
}

run "auth/vault tenant scoping"   scripts/checks/tenant-auth.mjs       TENANT-AUTH-PASS
run "workflow store scoping"      scripts/checks/wf-tenant.mjs         WF-TENANT-PASS
run "RAG per-tenant isolation"    scripts/checks/rag-tenant-isolation.mjs RAG-ISOLATION-PASS
run "HTTP cross-tenant attacks"   scripts/checks/tenant-isolation.mjs  TENANT-ISOLATION-PASS

echo "cap-multitenancy PASS: tenant data isolation holds across auth, vault, workflows, RAG, and the HTTP surface"
exit 0
