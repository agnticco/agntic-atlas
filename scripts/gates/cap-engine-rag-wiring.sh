#!/usr/bin/env bash
# Capability check — engine LLM wiring + RAG HTTP routes.
#
# Verifies the spine wiring (not a numbered phase gate):
#   1. ModelPool injected as the engine's LLM + RAG via the real bootSpine() path
#      (scripts/checks/engine-rag-wiring.mjs).
#   2. The HTTP surface works: POST /rag/ingest then POST /rag/query retrieves it.
#
# Requires local GGUF weights present (gitignored — see
# docs/capabilities/local-models-rag.md). Fail-closed.
#
# Note: the wiring check keys on the WIRING-PASS marker, not just the exit code.
# Its functional assertions (llm output, retrieval) are real; freeing two Metal
# models at process exit can still trip an upstream teardown assert on some builds
# (node-llama-cpp PR #17869). The marker is the honest functional signal.
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "cap-wiring FAIL: $*" >&2; exit 1; }

echo "── cap: engine LLM + RAG wiring (bootSpine path) ──"
out="$(node scripts/checks/engine-rag-wiring.mjs 2>&1 || true)"
echo "$out" | grep -E 'engine llm-node output:|rag top hit:' || true
echo "$out" | grep -q 'WIRING-PASS' || { echo "$out" | tail -20 >&2; fail "engine/RAG wiring check did not reach WIRING-PASS"; }

echo "── cap: RAG HTTP routes (/rag/ingest -> /rag/query) ──"
PORT="${WIRING_GATE_PORT:-3991}"
TMP="$(mktemp -d -t atlas-wiring.XXXXXX)"
LOG="$TMP/server.log"
WORKFLOWS_DB="$TMP/workflows.sqlite" SOURCES_DB="$TMP/sources.sqlite" VECTOR_DB="$TMP/vectors.sqlite" \
  PORT="$PORT" node src/api/server.js >"$LOG" 2>&1 &
SRV=$!
cleanup() { kill "$SRV" 2>/dev/null || true; wait "$SRV" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

ready=""
for _ in $(seq 1 60); do
  kill -0 "$SRV" 2>/dev/null || { cat "$LOG" >&2; fail "server exited during boot"; }
  if curl -fs "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
[ -n "$ready" ] || { cat "$LOG" >&2; fail "server did not answer /health"; }

ing="$(curl -s -X POST "http://127.0.0.1:${PORT}/rag/ingest" \
  -H 'content-type: application/json' \
  -d '{"text":"Atlas refund policy: customers may request a full refund within 30 days of purchase.","metadata":{"src":"kb"}}')"
echo "  ingest -> $ing"
echo "$ing" | grep -q '"chunks"' || fail "/rag/ingest did not report chunks: $ing"

qry="$(curl -s -X POST "http://127.0.0.1:${PORT}/rag/query" \
  -H 'content-type: application/json' \
  -d '{"query":"how long do I have to get my money back?","k":2}')"
echo "  query  -> $qry"
echo "$qry" | grep -q 'refund policy' || fail "/rag/query did not retrieve the ingested doc: $qry"

echo "cap-wiring PASS: ModelPool wired as engine LLM; RAG ingest/query routes retrieve company context"
exit 0
