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
     ENGINEERING-LOG.md:48-50 and docs/capabilities/local-models-rag.md:31-35.
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

---

## 2026-06-08 — Wiring verification (ModelPool-as-engine-LLM + RAG HTTP routes)

**Verdict: PASS.** Independent Verifier (did not write the code).

**Commit verified:** `c8767a91326328ad872b2cb05726301ae2bcd0ee`
("feat(p0): wire ModelPool as engine LLM + RAG ingest/query routes"),
branch `feat/local-models-rag`. Tree clean (`git status --porcelain` empty);
no GGUF committed (`git ls-files | grep -i gguf` -> exit 1, empty).

**Scope:** `bootSpine()` now builds a local `LlamaCppLLM` -> tier-wraps it in a
`ModelPool` -> injects it as the `llm` of `FlowTester` + `WorkflowService`
(src/api/server.js:59-64 buildLocalLLM, :83-94 injection). Adds `POST /rag/ingest`
and `POST /rag/query` (server.js:187-217) + `llm`/`rag` fields on `GET /health`.

### Criteria + evidence

1. **Tree state** — clean; HEAD `c8767a9` on `feat/local-models-rag`; no gguf tracked.

2. **P0 gate still green** — `bash scripts/gate.sh 0` -> exit 0:
   `p0 PASS: engine+auth boot; GET /health -> 200 {...,"llm":"ready","rag":"ok"};
   src/api/server.js is clean UTF-8 (grep ok, no NUL)`.

3. **Wiring gate** — `bash scripts/gates/cap-engine-rag-wiring.sh` -> exit 0:
   `engine llm-node output: The capital of France is Paris.`;
   `rag top hit: score=0.686 :: Atlas refund policy: customers may request a full`;
   HTTP `ingest -> {"ingested":1,"chunks":1}`, `query` retrieved the refund policy;
   `cap-wiring PASS`.

4. **Independent confirmation (not the gate's calls):**
   - LLM really injected: server.js:39 imports `LlamaCppLLM, ModelPool`; :61 `new LlamaCppLLM(...)`;
     :63 `new ModelPool({ tiers: { fast: local, balanced: local, powerful: local }, ... })`;
     :83-89 passed as `llm` to `FlowTester`; :92-94 same engine handed to `WorkflowService`.
     Not stubbed (buildLocalLLM returns null only when weights absent, :60).
   - `node scripts/checks/engine-rag-wiring.mjs` run directly -> exit 0, printed
     `engine llm-node output: The capital of France is Paris.`, `rag top hit: score=0.686`,
     and `WIRING-PASS`. The check imports the real `bootSpine` from src/api/server.js
     (:30), runs an `llm` node through FlowTester, asserts `/paris/i` (:49) and that the
     top hit `.includes('refund policy')` (:56) — real outcomes, not existence checks.
   - **Own server boot, own document text** (port 4117, temp WORKFLOWS_DB/SOURCES_DB/VECTOR_DB):
     `GET /health` -> `{"status":"ok",...,"llm":"ready","rag":"ok"}`;
     `POST /rag/ingest {"text":"The Atlas onboarding mascot is a purple narwhal named
     Quillby who lives in the Helsinki data closet."}` -> `{"ingested":1,"chunks":1}`;
     `POST /rag/query {"query":"what is the name of the onboarding mascot and where does
     it live?","k":3}` -> retrieved that exact sentence at **score 0.8062**
     (metadata src "verifier-probe"). A stale store could not fabricate this novel text.
     Clean SIGTERM shutdown, exit 0.
   - Anti-gaming: the gate keys on the `WIRING-PASS` marker (cap-engine-rag-wiring.sh:22-24,
     `|| true` then `grep -q WIRING-PASS`) rather than the bare exit code. Judged LEGITIMATE:
     the check prints WIRING-PASS only after both functional assertions pass (mjs:67-68),
     and does so before process exit, where freeing two Metal models can trip an upstream
     teardown assert (node-llama-cpp PR #17869). The marker captures the true functional
     signal independent of a teardown-only abort; assertions remain real and fail-closed.
     In this run the check's own exit was 0 anyway (no teardown abort observed).

5. **Honesty of the record:**
   - Scheduler constructed but NOT started: `grep -n 'workflowScheduler.start\|scheduler.start\|\.start('
     src/api/server.js` -> exit 1, no match. Constructed at server.js:82, comment :80-81.
   - RAG routes use optionalAuth: server.js:172,187,204.
   - Engine boots without chat weights: booted with `LOCAL_MODEL_PATH` -> nonexistent file,
     `GET /health` -> `{"status":"ok",...,"engine":"ok","llm":"unconfigured","rag":"ok"}`.
   - Metal teardown mitigation real: `disposeModels()` at server.js:147-150 (ordered:
     embedder dispose then chat model dispose), invoked in shutdown path at :233.
   - Capability doc updated: docs/capabilities/local-models-rag.md gained a "Wiring (server
     spine)" section (:78-111) + "Known issue — Metal teardown assert" (:102-111);
     `grep -ni 'not wired' ...` -> exit 1 (no stale "not wired yet" language remains).

All commit-body claims confirmed; no overstatement found.

— Verified-by: independent Verifier session, 2026-06-08
