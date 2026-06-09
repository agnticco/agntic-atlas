/**
 * RAG capability check — fully offline.
 *
 * Local GGUF embeddings -> persistent sqlite vector store -> reload in a fresh
 * instance -> semantic retrieval ranks the relevant company-context doc first.
 * No API keys, no network.
 *
 * Model path: EMBEDDING_MODEL_PATH env, else ./models/nomic-embed-text-v1.5.Q4_K_M.gguf
 * Prints RAG-ROUNDTRIP-PASS / -FAIL and exits 0/1.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EmbeddingModel, VectorStore } from '../../src/rag/index.js';

const MODEL = process.env.EMBEDDING_MODEL_PATH
  ?? resolve('models/nomic-embed-text-v1.5.Q4_K_M.gguf');

if (!existsSync(MODEL)) {
  console.error(`RAG-ROUNDTRIP-FAIL: embedding model not found at ${MODEL}`);
  console.error('  fetch it (see docs/capabilities/local-models-rag.md) or set EMBEDDING_MODEL_PATH');
  process.exit(1);
}

const dbPath = join(mkdtempSync(join(tmpdir(), 'atlas-rag-')), 'vectors.sqlite');
const embedder = new EmbeddingModel({ provider: 'local', model: MODEL });

const docs = [
  'Atlas refund policy: customers may request a full refund within 30 days of purchase.',
  'The office is open Monday through Friday, 9am to 5pm Pacific time.',
  'Our primary cloud provider is Cloudflare; deployments use Workers and D1.',
  'Engineering on-call rotation is weekly and managed in the #oncall Slack channel.',
];

const embs = await embedder._call(docs);
const dim = embs[0].length;

const store1 = new VectorStore({ sqlitePath: dbPath });
await store1.add(docs.map((t) => ({ pageContent: t, metadata: { src: 'kb' } })), embs);

// Fresh instance reloads from disk -> proves company context persists.
const store2 = new VectorStore({ sqlitePath: dbPath });
await store2.load();

const query = 'How long do I have to get my money back?';
const qemb = await embedder._call(query);
const hits = store2.search(qemb, 2);

console.log(`embedding dim = ${dim}; persisted+reloaded ${docs.length} chunks`);
hits.forEach((h, i) => console.log(`  #${i + 1} score=${h.score.toFixed(3)} :: ${h.pageContent.slice(0, 60)}`));

await embedder.dispose();

const ok = dim > 0 && (hits[0]?.pageContent ?? '').includes('refund policy');
console.log(ok ? 'RAG-ROUNDTRIP-PASS' : 'RAG-ROUNDTRIP-FAIL');
process.exit(ok ? 0 : 1);
