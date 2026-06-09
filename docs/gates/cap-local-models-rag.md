# Capability gate — local open-source models + RAG (company context)

**Verdict: PASS**
**Date:** 2026-06-08
**Verified commit:** `c3a3eae6a6e1f7a71951fc8b1c4b7a9ff49a59cf` on `feat/local-models-rag`
**Verified by:** independent Verifier (did not write the code)

This is an out-of-band capability (NOT a numbered P0–P7 phase gate), pulled
forward from the deferred list (decision 2026-06-08).

## Commands run + output

### Objective gate
`bash scripts/gates/cap-local-models-rag.sh` → exit 0
```
── cap: RAG offline round-trip ──
embedding dim = 768; persisted+reloaded 4 chunks
  #1 score=0.686 :: Atlas refund policy: customers may request a full refund wit
  #2 score=0.452 :: The office is open Monday through Friday, 9am to 5pm Pacific
RAG-ROUNDTRIP-PASS
── cap: local model generation ──
[gen:qwen2.5-0.5b-instruct-q4_k_m] The capital of France is Paris.
model: qwen2.5-0.5b-instruct-q4_k_m.gguf | load+gen 0.3s
output: The capital of France is Paris.
LLM-GEN-PASS
cap PASS
```

### Independent re-runs with API keys unset (`env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY`)
- `node scripts/checks/rag-roundtrip.mjs` → RAG-ROUNDTRIP-PASS, embedding dim = 768,
  top hit score=0.686 = the refund-policy doc (the relevant company-context doc, ranked #1).
- `node scripts/checks/llm-gen.mjs` → LLM-GEN-PASS, output: "Paris, the capital of France."
  (fresh, differs from the gate run's "The capital of France is Paris." — confirms real
  generation, not a cached/hardcoded value).

## Criteria + evidence

1. **Tree state.** `git status --porcelain` empty (clean). HEAD = c3a3eae on
   feat/local-models-rag. `git ls-files src/rag src/llm src/memory` shows the rag
   closure (15 files incl. index.js, vector-store.js, embedding-model.js,
   sqlite-vector-backend.js), the llm files (llama-cpp-llm, model-pool, chat-model,
   cost-tracker, index, native-citations), and src/memory/{stores,base-store}.js.
   No gguf committed (`git ls-files | grep -i gguf` → exit 1, empty).
   `.gitignore:28-29` = `models/` + `*.gguf`; `git check-ignore` confirms both ignored.

2. **Weights present locally (gitignored).** `models/nomic-embed-text-v1.5.Q4_K_M.gguf`
   (80M) and `models/qwen2.5-0.5b-instruct-q4_k_m.gguf` (469M).

3. **Checks are real, not gamed.** rag-roundtrip.mjs:14 imports `EmbeddingModel,
   VectorStore` from src/rag/index.js, uses `provider:'local'`, persists to a tmpdir
   sqlite, reloads in a *fresh* VectorStore via `.load()` (vector-store.js:149-151 →
   sqlite backend loadAll), asserts dim>0 AND top hit contains 'refund policy'
   (line 54) — no hardcoded PASS. llm-gen.mjs:12 imports `LlamaCppLLM` from
   src/llm/index.js, asserts non-empty text matching /paris/i (line 35). Local
   embedding routes to node-llama-cpp LlamaEmbeddingContext (embedding-model.js:61-72,
   175-176); requires no API key (only voyage/openai do).

4. **Honesty of the record.**
   - Salvage edit real: embedding-model.js:70 `this.gpu = options.gpu ?? (... 'auto')`
     and :176 `getLlama({ ..., gpu: this.gpu, build: 'never' })`. Recorded in
     CLAUDE.md:48-50 and docs/capabilities/local-models-rag.md:31-35.
   - Deferred-list reversal recorded in docs/salvage-map.md (commit diff lines 44, 51-56:
     rag/llm removed from "Defer to later phases", "Pulled forward (decision 2026-06-08)" note added).
   - Commit body claims match reality: `duckdb` absent from package.json (no match);
     `@anthropic-ai/sdk` (package.json:14) + `openai` (:24) present; node-llama-cpp (:23) present.
   - No engine wiring added: commit did not touch src/api/server.js (`git show --stat`
     exit 1 for server.js); the only RAG/llama mention in server.js is a comment
     (server.js:4-15) explicitly stating it does NOT port the salvage server. Confirms
     the stated scope "port + load-verify, no HTTP routes / ModelPool-as-engine wiring."

## Notes
- Embedding dimension: 768 (nomic-embed-text-v1.5).
- Top retrieval score for the relevant doc: 0.686 (vs 0.452 next), ranked #1.
- Generated output (qwen2.5-0.5b): "The capital of France is Paris." / "Paris, the capital of France."
