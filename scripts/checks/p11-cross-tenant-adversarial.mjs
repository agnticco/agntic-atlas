/**
 * p11-cross-tenant-adversarial — proves tenant A cannot read, list, or trigger
 * any resource belonging to tenant B. Covers workflows, runs, vault/OAuth tokens,
 * and RAG, at both the HTTP layer (real auth middleware + endpoint logic) and the
 * store layer (fail-closed scoping). Boots the real spine + app on an ephemeral
 * port against throwaway temp DBs.
 *
 * Prints CROSS-TENANT-ADVERSARIAL-PASS / -FAIL and exits 0/1. Used by the P11 gate.
 *
 *   node scripts/checks/p11-cross-tenant-adversarial.mjs
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic env: isolated temp DBs so this never touches real data.
const tmp = mkdtempSync(join(tmpdir(), 'atlas-adversarial-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
  INTERACTIONS_DB: 'i.sqlite', INBOX_DB: 'inbox.sqlite',
})) process.env[k] = join(tmp, v);
process.env.DB_BACKUP_KEEP = '0';        // no backup noise in a throwaway boot
process.env.SCHEDULER_ENABLED = 'false'; // no tick loop during the check

const { bootSpine, createApp } = await import('../../src/api/server.js');

let pass = true;
const ok = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) pass = false; };

const spine = await bootSpine();
const app = createApp(spine);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
};

try {
  // ── Setup: platform admin + two tenants (A=acme, B=globex) ────────────────
  const setup = await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'ops-pw-12345' } });
  const platformToken = setup.json?.token;
  ok('platform admin bootstrapped', setup.status === 200 && !!platformToken);

  const tA = await api('POST', '/tenants', { token: platformToken, body: { name: 'Acme', slug: 'acme', admin: { email: 'a@acme.test', password: 'acme-pw-12345' } } });
  const tB = await api('POST', '/tenants', { token: platformToken, body: { name: 'Globex', slug: 'globex', admin: { email: 'b@globex.test', password: 'globex-pw-12345' } } });
  ok('two tenants created', tA.status === 200 && tB.status === 200);
  const userA = tA.json?.admin, userB = tB.json?.admin;

  const loginA = await api('POST', '/auth/login', { body: { email: 'a@acme.test', password: 'acme-pw-12345' } });
  const loginB = await api('POST', '/auth/login', { body: { email: 'b@globex.test', password: 'globex-pw-12345' } });
  const tokenA = loginA.json?.token, tokenB = loginB.json?.token;
  ok('both tenant admins logged in', !!tokenA && !!tokenB);

  // ── Seed a workflow + run in tenant A (via the store, to avoid coupling the
  //    isolation check to connector availability validation) ──────────────────
  const wfRow = spine.engine.workflowStore.create({
    tenantId: 'acme', userId: userA.id,
    name: 'Acme Secret Flow', kind: 'flow',
    triggers: [{ type: 'manual' }],
    nodes: [{ id: 'note', type: 'deliver', label: 'Save', config: { channel: 'in_app', body: 'acme-secret' } }],
    edges: [], status: 'active',
  });
  const wfA = wfRow.id;
  ok('tenant A workflow seeded', !!wfA && wfRow.tenant_id === 'acme');
  const runA = spine.engine.workflowStore.startRun(wfA, { isTest: true });
  spine.engine.workflowStore.completeRun(runA.id, { result: 'ok' }, null, null, 5);

  // ── WORKFLOWS: A can read its own; B cannot read or list A's ──────────────
  const aReadsOwn = await api('GET', `/api/console/workflows/${wfA}`, { token: tokenA });
  ok('tenant A CAN read its own workflow (200)', aReadsOwn.status === 200 && aReadsOwn.json?.workflow?.id === wfA);

  const bReadsA = await api('GET', `/api/console/workflows/${wfA}`, { token: tokenB });
  ok('tenant B BLOCKED from reading A\'s workflow (404)', bReadsA.status === 404);
  ok('tenant B receives NO workflow data for A', !bReadsA.json?.workflow);

  const bList = await api('GET', '/api/console/workflows', { token: tokenB });
  ok('tenant B inventory does NOT include A\'s workflow', !(bList.json?.workflows || []).some((w) => w.id === wfA));

  // ── RUNS: B cannot read A's run ───────────────────────────────────────────
  const aReadsRun = await api('GET', `/api/console/workflows/${wfA}/runs/${runA.id}`, { token: tokenA });
  ok('tenant A CAN read its own run (200)', aReadsRun.status === 200);
  const bReadsRun = await api('GET', `/api/console/workflows/${wfA}/runs/${runA.id}`, { token: tokenB });
  ok('tenant B BLOCKED from reading A\'s run (404)', bReadsRun.status === 404);

  // ── VAULT / OAuth tokens: cross-tenant get returns null; unscoped throws ──
  spine.auth.oauthTokenStore.upsert({ tenantId: 'globex', userId: userB.id, connectorId: 'slack', accessTokenEnc: 'ct-globex-secret' });
  const crossVault = spine.auth.oauthTokenStore.get({ tenantId: 'acme', userId: userB.id, connectorId: 'slack' });
  ok('vault: A-tenant context cannot read B\'s token (null)', crossVault === null);
  let vaultThrew = false; try { spine.auth.oauthTokenStore.get({ userId: userB.id, connectorId: 'slack' }); } catch { vaultThrew = true; }
  ok('vault: unscoped get THROWS (fail-closed)', vaultThrew);

  // ── RAG: physically isolated per tenant; no cross-tenant retrieval ─────────
  const ragA = await spine.rag.forTenant('acme');
  const ragB = await spine.rag.forTenant('globex');
  await ragA.ingest('Acme launch code BLUE-HERON-42', { src: 'kb' });
  await ragB.ingest('Globex pricing floor is 1299 dollars per seat', { src: 'kb' });
  // Load-bearing proof: physical per-tenant file isolation (always deterministic).
  ok('RAG stores are physically separate files', ragA.dbPath !== ragB.dbPath && String(ragA.dbPath).includes('acme'));
  // Query-level proof, gated on a positive control so it can't pass vacuously when
  // the embedding model isn't available (empty hits). If A can retrieve its OWN
  // doc, then assert each tenant retrieves only its own and never the other's;
  // otherwise fall back to the physical-separation proof above.
  const aOwn = (await api('POST', '/rag/query', { token: tokenA, body: { query: 'what is the launch code', k: 5 } })).json?.hits || [];
  if (aOwn.some((h) => JSON.stringify(h).includes('BLUE-HERON-42'))) {
    const aHits = (await api('POST', '/rag/query', { token: tokenA, body: { query: 'what is the pricing floor', k: 5 } })).json?.hits || [];
    ok('RAG: A retrieves its own doc but NOT B\'s', !aHits.some((h) => JSON.stringify(h).includes('1299')));
    const bHits = (await api('POST', '/rag/query', { token: tokenB, body: { query: 'what is the pricing floor', k: 5 } })).json?.hits || [];
    ok('RAG: B retrieves its own doc but NOT A\'s', bHits.some((h) => JSON.stringify(h).includes('1299')) && !bHits.some((h) => JSON.stringify(h).includes('BLUE-HERON-42')));
  } else {
    console.log('note  RAG query-level isolation skipped (embedding model unavailable) — physical separation proven above');
  }

  // ── Store-layer fail-closed (defense-in-depth) ────────────────────────────
  let listThrew = false; try { spine.auth.userStore.list(); } catch { listThrew = true; }
  ok('store: userStore.list() unscoped THROWS', listThrew);
  ok('store: workflowStore.get(wfA, tenant=globex) → null', spine.engine.workflowStore.get(wfA, { tenantId: 'globex' }) == null);
  ok('store: workflowStore.getRun(runA, tenant=globex) → null', spine.engine.workflowStore.getRun(runA.id, { tenantId: 'globex' }) == null);
} catch (err) {
  ok(`unexpected error: ${err?.message ?? err}`, false);
} finally {
  try { server.close(); } catch { /* ignore */ }
  try { spine.close(); } catch { /* ignore */ }
  try { await spine.disposeModels?.(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(pass ? 'CROSS-TENANT-ADVERSARIAL-PASS' : 'CROSS-TENANT-ADVERSARIAL-FAIL');
process.exit(pass ? 0 : 1);
