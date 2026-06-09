# Capability — local open-source models + RAG (company context)

**Decision (2026-06-08):** pulled forward from the P0 "defer to later phases" list.
The product must be able to run open-source models locally (llama.cpp) and use a
RAG system for company context. This reverses the thin-spine deferral of `src/rag/`
and `src/llm/llama-cpp-llm.js` + `model-pool.js` recorded in
[`docs/salvage-map.md`](../salvage-map.md).

This is **not** a numbered phase (P0–P7). It is a spine capability extension,
verified out-of-band by `scripts/gates/cap-local-models-rag.sh` with a ledger at
[`docs/gates/cap-local-models-rag.md`](../gates/cap-local-models-rag.md).

## What was migrated

From `agntic-prod`, the clean closure only:

- **`src/rag/`** — all 15 files: embedding model, sqlite vector backend + in-memory
  `VectorStore`, BM25, hybrid + RAG-fusion retrievers, reranker, ingestion pipeline,
  text splitter, document loader, docling processor, vault watcher, RAG chain.
- **`src/llm/`** — `llama-cpp-llm.js` (local GGUF inference), `model-pool.js`
  (tiered model selection), `chat-model.js` (cloud providers, lazy SDK import),
  `cost-tracker.js`, `index.js`. (`native-citations.js` arrived in P0.)
- **`src/memory/{stores.js, base-store.js}`** — the only `memory/` files RAG needs
  (`VectorStore` legacy path uses `MemoryStore`). The rest of `memory/` stays deferred.
- **deps:** `node-llama-cpp`, `chokidar`, `fflate`, plus `@anthropic-ai/sdk` + `openai`
  (lazily imported by `chat-model.js` only when a cloud provider is used). `duckdb` is
  **not** imported by this closure and was not added.

## Salvage edit (recorded)

`src/rag/embedding-model.js` hardcoded `getLlama({ gpu: false })` for the local
embedding context. The shipped node-llama-cpp prebuilt on Apple Silicon is
**Metal-only** (no CPU-only prebuilt), so `gpu:false` + `build:'never'` threw
`NoBinaryFoundError`. Changed to a configurable `this.gpu` defaulting to `'auto'`
(uses Metal when present; `LLAMA_GPU=false` forces CPU, which then needs a CPU build).
This is the only modification to salvage code in this capability; it is also noted in
`CLAUDE.md` → "Don't touch (salvage)".

## Model weights (gitignored)

GGUF weights are large binaries and are **not** committed (`models/` + `*.gguf` are
gitignored). Fetch them locally:

- **Embeddings (required for RAG):** `nomic-embed-text-v1.5.Q4_K_M.gguf` (~80 MB),
  ~768-dim. Sourced from `agntic-prod/models/`. Place at
  `models/nomic-embed-text-v1.5.Q4_K_M.gguf` or set `EMBEDDING_MODEL_PATH`.
- **Chat model (for local inference):** any instruct GGUF. The check uses
  `qwen2.5-0.5b-instruct-q4_k_m.gguf` (~469 MB):
  ```
  curl -fL -o models/qwen2.5-0.5b-instruct-q4_k_m.gguf \
    https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf
  ```
  Point at any other GGUF with `LOCAL_MODEL_PATH`. Larger models (e.g.
  Qwen2.5-1.5B/7B, Llama-3.1-8B) drop in the same way.

## Configuration

| env | default | meaning |
|---|---|---|
| `EMBEDDING_PROVIDER` | `local` (intended for company RAG) | `local` \| `openai` \| `voyage` |
| `EMBEDDING_MODEL_PATH` | `models/nomic-embed-text-v1.5.Q4_K_M.gguf` | local embedding GGUF |
| `LOCAL_MODEL_PATH` | `models/qwen2.5-0.5b-instruct-q4_k_m.gguf` | local chat GGUF |
| `LLAMA_GPU` | `auto` | `auto` (Metal/CUDA) \| `false` (CPU) |

The local provider is fully offline — no API keys, no per-token cost, company text
never leaves the host. Cloud embedding/chat providers remain available via env.

## Verify

```
bash scripts/gates/cap-local-models-rag.sh
```

Runs `scripts/checks/rag-roundtrip.mjs` (offline embeddings → persistent sqlite →
reload → retrieval ranks the relevant doc first) and `scripts/checks/llm-gen.mjs`
(GGUF chat model loads + generates). Fail-closed; requires the weights present.

## Wiring (server spine)

`src/api/server.js` now wires both subsystems into the spine:

- **ModelPool as the engine LLM.** `bootSpine()` builds a local `LlamaCppLLM`
  (from `LOCAL_MODEL_PATH`), tier-wraps it in a `ModelPool`, and injects it as the
  `llm` of `FlowTester` + `WorkflowService`. So `llm`/`summarize`/`rewrite`/`extract`
  nodes run on the local open-source model. If no local weights are present the
  engine still boots (`llm:"unconfigured"` in `/health`) and `llm` nodes fail at run
  time with a clear message — not at boot. Cloud tiers can be layered in via env.
- **RAG HTTP routes** (single-user pilot: `optionalAuth`; tighten to `requireAuth`
  once login routes are mounted):
  - `POST /rag/ingest` — body `{ text, metadata? }` or `{ documents: [{text, metadata?}] }`
    → split → embed (local) → persist to the sqlite vector store (`VECTOR_DB`).
    Returns `{ ingested, chunks }`.
  - `POST /rag/query` — body `{ query, k? }` → embed query → top-k retrieval.
    Returns `{ query, hits: [{ score, content, metadata }] }`.
- `GET /health` now also reports `llm` and `rag` status.

Verify: `bash scripts/gates/cap-engine-rag-wiring.sh` (runs
`scripts/checks/engine-rag-wiring.mjs` via the real `bootSpine()` path — an `llm`
workflow node generates, RAG ingest→query retrieves — then boots the server and
curls `/rag/ingest` → `/rag/query`).

### Known issue — Metal teardown assert (non-blocking)

Freeing both a Metal embedding context and a Metal chat model at process exit can
trip an upstream llama.cpp assert (`GGML_ASSERT [rsets->data count]==0`, ref
node-llama-cpp PR #17869). Mitigated by **ordered disposal before exit**
(`spine.disposeModels()` — dispose embedding context + chat model, awaited, before
the stores close), applied in the server's SIGINT/SIGTERM shutdown and in the wiring
check. The check additionally keys on the `WIRING-PASS` marker (its functional
assertions are real) so a teardown-only abort on an unmitigated build can't mask a
genuine pass/fail.

## Still deferred (intentionally)

Full workflow REST/CRUD surface, the scheduler's background tick (constructed but
not started — scheduled triggers are P2/P7), and cloud-tier model config land when a
phase needs them.
