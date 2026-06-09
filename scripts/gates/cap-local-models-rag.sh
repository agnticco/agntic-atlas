#!/usr/bin/env bash
# Capability check — local open-source models + RAG (company context).
#
# NOT a numbered phase gate (P0-P7). This is an out-of-band capability the user
# pulled forward from the deferred list (decision 2026-06-08). Verifies, with
# evidence, that the migrated subsystems actually work on this machine:
#   1. RAG: local GGUF embeddings -> persistent sqlite store -> reload -> retrieve.
#   2. Inference: a GGUF chat model loads via node-llama-cpp and generates text.
#
# Requires the model weights present locally (gitignored — see
# docs/capabilities/local-models-rag.md). Fail-closed.
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "cap FAIL: $*" >&2; exit 1; }

echo "── cap: RAG offline round-trip ──"
node scripts/checks/rag-roundtrip.mjs 2>&1 | grep -vE '^\[node-llama|^llama_|^ggml_|^load_|^print_info' || true
node scripts/checks/rag-roundtrip.mjs >/dev/null 2>&1 || fail "RAG round-trip check failed"

echo "── cap: local model generation ──"
node scripts/checks/llm-gen.mjs 2>&1 | grep -vE '^\[node-llama|^llama_|^ggml_|^load_|^print_info' || true
node scripts/checks/llm-gen.mjs >/dev/null 2>&1 || fail "local LLM generation check failed"

echo "cap PASS: RAG (local embeddings + persistent retrieval) and local open-source model generation both verified"
exit 0
