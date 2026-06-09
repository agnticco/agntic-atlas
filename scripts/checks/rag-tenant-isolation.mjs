/**
 * Per-tenant RAG isolation check (offline, local embeddings).
 *
 * Ingests DIFFERENT company-context docs into two tenants' RAG stores via the
 * real spine, then proves a query in tenant A can NEVER retrieve tenant B's
 * document — the stores are physically separate files, so cross-tenant retrieval
 * is not even expressible. Also proves a missing tenant is refused (fail-closed).
 *
 * Prints RAG-ISOLATION-PASS / -FAIL and exits 0/1.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const emb = process.env.EMBEDDING_MODEL_PATH ?? resolve('models/nomic-embed-text-v1.5.Q4_K_M.gguf');
if (!existsSync(emb)) { console.error(`RAG-ISOLATION-FAIL: embedding model missing at ${emb}`); process.exit(1); }

const t = mkdtempSync(join(tmpdir(), 'atlas-ragiso-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(t, v);
process.env.EMBEDDING_PROVIDER = 'local';

const { bootSpine } = await import('../../src/api/server.js');
const spine = await bootSpine();

let pass = true;
const ok = (n, c) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n}`); if (!c) pass = false; };

try {
  const acme = await spine.rag.forTenant('acme');
  const globex = await spine.rag.forTenant('globex');

  await acme.ingest('Acme secret: the launch code is BLUE-HERON-42.', { src: 'kb' });
  await globex.ingest('Globex secret: our pricing floor is $1,299 per seat.', { src: 'kb' });

  // Each tenant retrieves only its OWN doc.
  const acmeHit = (await acme.query('what is the launch code?', 3))[0]?.pageContent ?? '';
  const globexHit = (await globex.query('what is the pricing floor?', 3))[0]?.pageContent ?? '';
  ok('acme retrieves its own doc', acmeHit.includes('BLUE-HERON-42'));
  ok('globex retrieves its own doc', globexHit.includes('1,299'));

  // Cross-tenant: acme asking for globex's secret must NOT surface it (separate store).
  const acmeForGlobex = await acme.query('what is the pricing floor per seat?', 5);
  const leaked = acmeForGlobex.some((h) => (h.pageContent ?? '').includes('1,299'));
  ok('acme query CANNOT retrieve globex doc (no leak)', !leaked);
  const globexForAcme = await globex.query('what is the launch code BLUE HERON?', 5);
  ok('globex query CANNOT retrieve acme doc (no leak)', !globexForAcme.some((h) => (h.pageContent ?? '').includes('BLUE-HERON-42')));

  // Stores are physically separate files.
  ok('tenant stores are different files', acme.dbPath !== globex.dbPath && acme.dbPath.includes('acme') && globex.dbPath.includes('globex'));

  // Fail-closed: no tenant -> refused.
  let threw = false; try { await spine.rag.forTenant(''); } catch { threw = true; }
  ok('forTenant() without a tenant THROWS', threw);
} finally {
  spine.close();
}

console.log(pass ? 'RAG-ISOLATION-PASS' : 'RAG-ISOLATION-FAIL');
process.exit(pass ? 0 : 1);
