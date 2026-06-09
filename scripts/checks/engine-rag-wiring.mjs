/**
 * Wiring check — proves, via the real bootSpine() path:
 *   1. ModelPool is injected as the engine's LLM: an `llm` workflow node runs
 *      through FlowTester and produces output from the local open-source model.
 *   2. RAG company-context store works end-to-end through the spine helpers:
 *      ingest -> embed -> persist -> query -> retrieve.
 *
 * Uses temp DB paths so the assertion is hermetic. Requires local weights present.
 * Prints WIRING-PASS / -FAIL and exits 0/1.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'atlas-wiring-'));
process.env.WORKFLOWS_DB = join(tmp, 'workflows.sqlite');
process.env.SOURCES_DB   = join(tmp, 'sources.sqlite');
process.env.VECTOR_DB    = join(tmp, 'vectors.sqlite');
// Hermetic auth too — don't write to ./memory during a check.
process.env.AUTH_DB     = join(tmp, 'auth.sqlite');
process.env.AUTH_SECRET = join(tmp, '.jwt-secret');
process.env.OAUTH_DB    = join(tmp, 'oauth.sqlite');
process.env.OAUTH_KEY   = join(tmp, '.oauth-key');
process.env.EMBEDDING_PROVIDER = 'local';

const embModel = process.env.EMBEDDING_MODEL_PATH ?? resolve('models/nomic-embed-text-v1.5.Q4_K_M.gguf');
const chatModel = process.env.LOCAL_MODEL_PATH ?? resolve('models/qwen2.5-0.5b-instruct-q4_k_m.gguf');
for (const [label, p] of [['embedding', embModel], ['chat', chatModel]]) {
  if (!existsSync(p)) {
    console.error(`WIRING-FAIL: ${label} model missing at ${p} (see docs/capabilities/local-models-rag.md)`);
    process.exit(1);
  }
}

const { bootSpine } = await import('../../src/api/server.js');
const spine = await bootSpine();

let llmOut = null;
let ragOk = false;
try {
  // 1. ModelPool-as-engine-LLM: run a one-node `llm` workflow through FlowTester.
  if (!spine.engine.llm) throw new Error('engine.llm is null — ModelPool was not injected');
  const flow = {
    name: 'wiring-probe',
    nodes: [{ id: 'ask', type: 'llm', label: 'ask', config: { prompt: 'Answer in one short sentence: what is the capital of France?' } }],
    edges: [],
  };
  for await (const ev of spine.engine.flowTester.run(flow, {})) {
    if (ev.type === 'run_completed') llmOut = ev.output;
    if (ev.type === 'run_failed') throw new Error(`flow run_failed: ${ev.error}`);
  }
  const llmText = typeof llmOut === 'string' ? llmOut : (llmOut?.content ?? String(llmOut));
  console.log(`engine llm-node output: ${llmText.trim()}`);
  if (!/paris/i.test(llmText)) throw new Error(`llm-node output unexpected: ${llmText}`);

  // 2. RAG via the spine helpers.
  await spine.rag.ingest('Atlas refund policy: customers may request a full refund within 30 days of purchase.', { src: 'kb' });
  await spine.rag.ingest('The office is open Monday through Friday, 9am to 5pm Pacific time.', { src: 'kb' });
  const hits = await spine.rag.query('How long do I have to get my money back?', 2);
  console.log(`rag top hit: score=${hits[0]?.score?.toFixed(3)} :: ${hits[0]?.pageContent?.slice(0, 50)}`);
  ragOk = (hits[0]?.pageContent ?? '').includes('refund policy');
} finally {
  // Dispose Metal contexts/models BEFORE process exit. Freeing both an embedding
  // context and a chat model at exit can trip an upstream llama.cpp Metal assert
  // (GGML_ASSERT [rsets->data count]==0, ref node-llama-cpp PR #17869); ordered
  // disposal here is the mitigation.
  try { await spine.rag.embedder.dispose(); } catch { /* ignore */ }
  try { await spine.engine.llm?.tiers?.balanced?.dispose(); } catch { /* ignore */ }
  spine.close();
}

const ok = !!llmOut && ragOk;
console.log(ok ? 'WIRING-PASS' : 'WIRING-FAIL');
process.exit(ok ? 0 : 1);
