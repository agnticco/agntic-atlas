/**
 * Atlas — API spine.
 *
 * NOT a port of the salvage `agntic-prod/src/api/server.js`. Grown deliberately
 * from the P0 thin spine; mounts only what is wired so far:
 *
 *   1. Execution engine — WorkflowStore + the full registry/validator/scheduler
 *      stack, with a local-model ModelPool injected as the engine's LLM
 *      (so `llm`/`summarize`/`rewrite`/… nodes run on open-source models).
 *   2. Auth + credential vault (better-sqlite3 stores, JWT secret, AES-256-GCM key).
 *   3. RAG for company context — local GGUF embeddings + a persistent sqlite vector
 *      store, exposed over `POST /rag/ingest` and `POST /rag/query`.
 *
 * Routes: `GET /health` (unauth), `POST /rag/ingest`, `POST /rag/query`. Deferred
 * subsystems (MCP runtime, agent-graph converger, full workflow REST/CRUD) arrive
 * in the phases that need them — grow as needed, do not bulk-port the salvage server.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { createAuthSubsystem } from '../auth/index.js';
import {
  WorkflowStore,
  SourceRegistry,
  ChannelRegistry,
  registerBuiltInChannels,
  NodeTypeRegistry,
  registerBuiltInNodeTypes,
  WorkflowValidator,
  WorkflowScheduler,
  FlowTester,
  WorkflowService,
} from '../workflows/index.js';
import { LlamaCppLLM, ModelPool } from '../llm/index.js';
import { EmbeddingModel, TextSplitter, VectorStore } from '../rag/index.js';
import { registerSlackChannel } from '../connectors/slack/index.js';

const PORT = Number(process.env.PORT ?? 3000);
const WORKFLOWS_DB = process.env.WORKFLOWS_DB ?? './memory/workflows/workflows.sqlite';
const SOURCES_DB   = process.env.SOURCES_DB   ?? './memory/workflows/sources.sqlite';
const VECTOR_DB    = process.env.VECTOR_DB    ?? './memory/vectors/company.sqlite';
const LOCAL_MODEL_PATH = process.env.LOCAL_MODEL_PATH
  ?? resolve('models/qwen2.5-0.5b-instruct-q4_k_m.gguf');
const EMBEDDING_PROVIDER   = process.env.EMBEDDING_PROVIDER ?? 'local';
const EMBEDDING_MODEL_PATH = process.env.EMBEDDING_MODEL_PATH
  ?? resolve('models/nomic-embed-text-v1.5.Q4_K_M.gguf');

const ensureDir = (file) => { try { mkdirSync(dirname(file), { recursive: true }); } catch { /* ok */ } };

/**
 * Build the local-model LLM, tier-wrapped in a ModelPool, to inject into the
 * engine. Returns null (engine still boots) when no local weights are present —
 * `llm` nodes then fail at run time with a clear message, not at boot.
 */
function buildLocalLLM() {
  if (!existsSync(LOCAL_MODEL_PATH)) return null;
  const local = new LlamaCppLLM({ modelPath: LOCAL_MODEL_PATH, contextSize: 2048 });
  // One local model serves every tier; cloud tiers can be layered in later via env.
  return new ModelPool({ tiers: { fast: local, balanced: local, powerful: local }, defaultTier: 'balanced' });
}

/** Construct the execution engine with `llm` (a ModelPool) injected. */
async function buildEngine(workflowStore, llm) {
  ensureDir(SOURCES_DB);
  const sourceRegistry = new SourceRegistry({ dbPath: SOURCES_DB });
  await sourceRegistry.init();

  const channelRegistry = new ChannelRegistry();
  registerBuiltInChannels(channelRegistry, {});           // in-app + webhook; mcp channel is opt-in
  registerSlackChannel(channelRegistry);                  // P1: Slack post-to-channel (chat.postMessage)

  const nodeTypeRegistry = new NodeTypeRegistry();
  registerBuiltInNodeTypes(nodeTypeRegistry);

  const workflowValidator = new WorkflowValidator({ sourceRegistry, channelRegistry, nodeTypes: nodeTypeRegistry });

  // Scheduler is constructed (FlowTester uses it for preview fetches) but NOT
  // started — the spine runs no background tick yet; scheduled triggers are P2/P7.
  const workflowScheduler = new WorkflowScheduler({ workflowStore, sourceRegistry });
  const flowTester = new FlowTester({
    sourceRegistry,
    scheduler: workflowScheduler,
    llm,
    channelRegistry,
    nodeTypes: nodeTypeRegistry,
  });
  workflowScheduler.flowTester = flowTester;

  const workflowService = new WorkflowService({
    workflowStore, nodeTypeRegistry, channelRegistry, sourceRegistry, workflowValidator, workflowScheduler,
  });

  return { workflowStore, sourceRegistry, channelRegistry, nodeTypeRegistry, workflowValidator, workflowScheduler, flowTester, workflowService, llm };
}

/**
 * Build the company-context RAG store: local GGUF embeddings + a persistent
 * sqlite vector backend. Exposes ingest()/query() used by the HTTP routes and
 * the wiring check.
 */
async function buildRag() {
  ensureDir(VECTOR_DB);
  const embedder = new EmbeddingModel({ provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL_PATH });
  const splitter = new TextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
  const vectorStore = new VectorStore({ sqlitePath: VECTOR_DB });
  await vectorStore.load();

  async function ingest(text, metadata = {}) {
    const chunks = await splitter._call([{ pageContent: text, metadata }]);
    const embeddings = await embedder._call(chunks.map((c) => c.pageContent));
    await vectorStore.add(chunks, embeddings);
    return chunks.length;
  }
  async function query(q, k = 4) {
    const qemb = await embedder._call(q);
    return vectorStore.search(qemb, k);
  }
  return { embedder, splitter, vectorStore, ingest, query, provider: EMBEDDING_PROVIDER };
}

/**
 * Boot every wired subsystem. Returns live handles + close(). Throws on a failed
 * boot — a failed boot must not serve traffic.
 */
export async function bootSpine() {
  ensureDir(WORKFLOWS_DB);
  const workflowStore = new WorkflowStore({ dbPath: WORKFLOWS_DB });
  await workflowStore.init();

  const auth = await createAuthSubsystem();

  const llm = buildLocalLLM();
  const engine = await buildEngine(workflowStore, llm);
  const rag = await buildRag();

  return {
    auth,
    engine,
    rag,
    get llm() { return engine.llm; },
    // Dispose Metal contexts/models before exit — freeing an embedding context
    // and a chat model together at process exit can trip an upstream llama.cpp
    // Metal assert (node-llama-cpp PR #17869). Ordered disposal avoids it.
    async disposeModels() {
      try { await rag.embedder.dispose?.(); } catch { /* ignore */ }
      try { await engine.llm?.tiers?.balanced?.dispose?.(); } catch { /* ignore */ }
    },
    close() {
      try { engine.workflowScheduler.stop?.(); } catch { /* ignore */ }
      try { workflowStore.close?.(); } catch { /* ignore */ }
      try { rag.vectorStore.close?.(); } catch { /* ignore */ }
      try { auth.close?.(); } catch { /* ignore */ }
    },
  };
}

/**
 * Build the express app around already-booted subsystems. Kept separate from
 * bootSpine() so tests can assert routes without standing up a listener.
 */
export function createApp(spine) {
  const app = express();
  app.use(cors());
  app.use(cookieParser());
  app.use(express.json({ limit: '4mb' }));

  // Single-user pilot: RAG routes use optionalAuth (attach user if a token is
  // present, don't block). Tighten to requireAuth once login routes are mounted.
  const optionalAuth = spine.auth?.middleware?.optionalAuth ?? ((_req, _res, next) => next());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version: '0.1.0',
      engine: spine.engine ? 'ok' : 'down',
      auth: spine.auth ? 'ok' : 'down',
      llm: spine.engine?.llm ? 'ready' : 'unconfigured',
      rag: spine.rag ? 'ok' : 'down',
    });
  });

  // Ingest company context. Body: { text, metadata? } or { documents: [{text, metadata?}] }.
  app.post('/rag/ingest', optionalAuth, async (req, res) => {
    try {
      const docs = Array.isArray(req.body?.documents)
        ? req.body.documents
        : [{ text: req.body?.text, metadata: req.body?.metadata }];
      if (docs.some((d) => typeof d?.text !== 'string' || !d.text.trim())) {
        return res.status(400).json({ error: 'each document needs a non-empty `text`' });
      }
      let chunks = 0;
      for (const d of docs) chunks += await spine.rag.ingest(d.text, d.metadata ?? {});
      res.json({ ingested: docs.length, chunks });
    } catch (err) {
      res.status(500).json({ error: `ingest failed: ${err.message ?? String(err)}` });
    }
  });

  // Query company context. Body: { query, k? }.
  app.post('/rag/query', optionalAuth, async (req, res) => {
    try {
      const q = req.body?.query;
      if (typeof q !== 'string' || !q.trim()) return res.status(400).json({ error: '`query` is required' });
      const k = Number(req.body?.k ?? 4);
      const hits = await spine.rag.query(q, k);
      res.json({
        query: q,
        hits: hits.map((h) => ({ score: h.score, content: h.pageContent, metadata: h.metadata })),
      });
    } catch (err) {
      res.status(500).json({ error: `query failed: ${err.message ?? String(err)}` });
    }
  });

  // Expose the wired capability schemas (delivery channels + their config) — the
  // contract the converger (P3) targets. "Connector NOT listed is not wired."
  app.get('/capabilities', (_req, res) => {
    res.json({ channels: spine.engine.channelRegistry.getAll() });
  });

  // Run a hand-authored spec through the engine — the "click run" path (no UI yet).
  // Body: { spec } where spec is the proprietary { name, nodes[], edges[], … } shape.
  app.post('/workflows/run', optionalAuth, async (req, res) => {
    const spec = req.body?.spec;
    if (!spec || !Array.isArray(spec.nodes)) {
      return res.status(400).json({ error: 'body.spec with a nodes[] array is required' });
    }
    try {
      let runId = null, completed = false, output = null;
      const steps = [];
      for await (const ev of spine.engine.flowTester.run(spec, {})) {
        if (ev.type === 'run_started') runId = ev.runId;
        else if (ev.type === 'step_completed') steps.push({ nodeId: ev.nodeId, output: ev.output });
        else if (ev.type === 'run_completed') { completed = true; output = ev.output; }
        else if (ev.type === 'run_failed') return res.status(502).json({ runId, error: ev.error, steps });
      }
      // step_completed outputs are shrunk to strings by the executor; coerce back
      // to objects so delivery results (e.g. the Slack { delivered, ts }) surface.
      const coerce = (o) => {
        if (o && typeof o === 'object') return o;
        if (typeof o === 'string') { try { return JSON.parse(o); } catch { /* not json */ } }
        return null;
      };
      const deliveries = steps.map((s) => coerce(s.output)).filter((o) => o && o.delivered);
      res.json({ runId, completed, output, deliveries, steps });
    } catch (err) {
      res.status(500).json({ error: `run failed: ${err.message ?? String(err)}` });
    }
  });

  return app;
}

export async function start() {
  const spine = await bootSpine();
  const app = createApp(spine);

  const server = app.listen(PORT, () => {
    const llmState = spine.engine.llm ? 'local-model' : 'no-model';
    console.log(`atlas spine listening on :${PORT} (engine ok, auth ok, llm ${llmState}, rag ${spine.rag.provider})`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} — shutting down`);
    server.close(async () => { await spine.disposeModels(); spine.close(); process.exit(0); });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, spine };
}

// Boot when run directly (`npm start`), not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error('spine failed to boot:', err);
    process.exit(1);
  });
}
