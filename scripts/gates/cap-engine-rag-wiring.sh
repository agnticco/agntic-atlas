#!/usr/bin/env bash
# Capability check — engine LLM wiring + per-tenant RAG.
#
# Verifies the spine wiring (not a numbered phase gate), via the real bootSpine():
#   1. ModelPool injected as the engine's LLM + RAG round-trip
#      (scripts/checks/engine-rag-wiring.mjs).
#   2. RAG is physically isolated per tenant — one tenant's documents can never be
#      retrieved by another (scripts/checks/rag-tenant-isolation.mjs).
#
# (Authenticated HTTP /rag routes are exercised by the multi-tenancy isolation
# suite, where tokens are minted.) Requires local GGUF weights present. Fail-closed.
#
# Note: the wiring check keys on the WIRING-PASS marker, not just the exit code.
# Its functional assertions are real; freeing two Metal models at process exit can
# trip an upstream teardown assert on some builds (node-llama-cpp PR #17869).
set -eu
cd "$(git rev-parse --show-toplevel)"

# THE GATE CANNOT SEND REAL EMAIL — blanks every mail credential for this script's
# children and refuses to run if the mailer is still live. Load-bearing here because
# the capability checks are NOT reachable through scripts/gate.sh, so nothing else
# establishes it for them. No check below sends mail today; this keeps that true for
# the one added later that nobody remembered to guard.
. scripts/gates/_no-mail.sh

fail() { echo "cap-wiring FAIL: $*" >&2; exit 1; }

echo "── cap: engine LLM + RAG wiring (bootSpine path) ──"
out="$(node scripts/checks/engine-rag-wiring.mjs 2>&1 || true)"
echo "$out" | grep -E 'engine llm-node output:|rag top hit:' || true
echo "$out" | grep -q 'WIRING-PASS' || { echo "$out" | tail -20 >&2; fail "engine/RAG wiring check did not reach WIRING-PASS"; }

echo "── cap: per-tenant RAG isolation ──"
iso="$(node scripts/checks/rag-tenant-isolation.mjs 2>&1 || true)"
echo "$iso" | grep -E '^(ok|FAIL)' || true
echo "$iso" | grep -q 'RAG-ISOLATION-PASS' || { echo "$iso" | tail -20 >&2; fail "RAG tenant isolation check did not pass"; }

echo "cap-wiring PASS: ModelPool wired as engine LLM; RAG works and is physically isolated per tenant"
exit 0
