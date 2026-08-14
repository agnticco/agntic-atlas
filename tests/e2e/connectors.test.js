/**
 * Connector end-to-end suite (P7 roadmap item #7).
 *
 * Two things, offline & deterministic (no OAuth, no network):
 *   1. The capability catalog is fully wired — every connector's capabilities are
 *      registered with a sane shape, and a representative id per connector is
 *      present (Slack / Google / Airtable / Web / Filesystem).
 *   2. A connector-action actually executes end-to-end through the engine
 *      (filesystem_read against a sandboxed temp file — the one connector that
 *      needs no external service, so it's CI-safe).
 *   3. The request-access demand flow: list → record → per-tenant dedup →
 *      cross-tenant aggregate → platform-admin ranking, with isolation asserted.
 *
 * Live-OAuth connectors (real Slack post, Gmail, Airtable) are validated
 * separately by the opt-in scripts/checks/p8-airtable-e2e.mjs style smoke against
 * a genuinely connected tenant — that needs real tokens and is not part of CI.
 *
 *   node --test tests/e2e/connectors.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REQUESTABLE_CONNECTORS } from '../../src/connectors/connector-demand.js';

let spine, server, base, tmp, platformToken, tokenA, tokenB;
const FS_TENANT = 'fs-tenant';
let fsFilePath;

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data };
};

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'atlas-conn-'));
  for (const [k, v] of Object.entries({
    WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
    AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
    INTERACTIONS_DB: 'i.sqlite', INBOX_DB: 'inbox.sqlite',
  })) process.env[k] = join(tmp, v);
  process.env.DB_BACKUP_KEEP = '0';
  process.env.SCHEDULER_ENABLED = 'false';
  // Isolate the demand store to the temp dir (never touch ./memory).
  process.env.CONNECTOR_DEMAND_FILE = join(tmp, 'connector-demand.json');

  // Filesystem fixture: an approved folder + file, and a sources.json that
  // sandboxes it for FS_TENANT (mirrors scripts/checks/p8-filesystem-read.mjs).
  const approvedDir = join(tmp, 'project-folder');
  fsFilePath = join(approvedDir, 'README.md');
  mkdirSync(approvedDir, { recursive: true });
  writeFileSync(fsFilePath, '# Connector E2E fixture\nThis file proves filesystem_read runs.\n', 'utf8');
  const vectorsDir = join(tmp, 'vectors', FS_TENANT);
  mkdirSync(vectorsDir, { recursive: true });
  writeFileSync(join(vectorsDir, 'sources.json'),
    JSON.stringify([{ path: approvedDir, addedAt: Date.now(), files: 1, chunks: 1 }]));

  const { bootSpine, createApp } = await import('../../src/api/server.js');
  spine = await bootSpine();
  const app = createApp(spine);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Platform admin → two tenants (acme, beta) → login both.
  const setup = await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'fixture-not-a-secret-ops' } });
  platformToken = setup.data.token;
  assert.ok(platformToken, 'platform admin token');
  await api('POST', '/tenants', { token: platformToken, body: { name: 'Acme', slug: 'acme', admin: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme' } } });
  await api('POST', '/tenants', { token: platformToken, body: { name: 'Beta', slug: 'beta', admin: { email: 'b@beta.test', password: 'fixture-not-a-secret-beta' } } });
  tokenA = (await api('POST', '/auth/login', { body: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme' } })).data.token;
  tokenB = (await api('POST', '/auth/login', { body: { email: 'b@beta.test', password: 'fixture-not-a-secret-beta' } })).data.token;
  assert.ok(tokenA && tokenB, 'both tenant tokens');
});

after(async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { spine?.close(); } catch { /* ignore */ }
  try { await spine?.disposeModels?.(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('catalog: every connector capability is registered with a sane shape', () => {
  const reg = spine.engine.capabilityRegistry;
  assert.ok(reg, 'engine exposes capabilityRegistry');
  const all = reg.list(); // no filter → the full catalog (triggers + steps + delivery)
  assert.ok(Array.isArray(all) && all.length > 0, 'catalog is non-empty');
  for (const cap of all) {
    assert.ok(typeof cap.id === 'string' && cap.id, 'capability has a string id');
    assert.ok(Array.isArray(cap.positions) && cap.positions.length > 0, `${cap.id} declares positions`);
    for (const pos of cap.positions) {
      assert.ok(['trigger', 'step', 'delivery'].includes(pos), `${cap.id} position "${pos}" is valid`);
    }
  }
  // A representative id per connector must be present (proves each is wired).
  const ids = new Set(all.map((c) => c.id));
  for (const need of ['slack', 'gmail_send', 'airtable_list_records', 'web_fetch', 'web_search', 'filesystem_read', 'filesystem_list']) {
    assert.ok(ids.has(need), `catalog includes "${need}"`);
  }
});

test('connector-action: filesystem_read executes end-to-end (offline)', async () => {
  const spec = {
    slug: 'conn-e2e-fs', name: 'Connector E2E — filesystem',
    triggers: [{ type: 'manual' }],
    nodes: [{ id: 'read1', type: 'connector-action', config: { action: 'filesystem_read', path: fsFilePath, _tenantId: FS_TENANT } }],
    edges: [],
  };
  let output = null, failed = null;
  for await (const ev of spine.engine.flowTester.run(spec, {})) {
    if (ev.type === 'step_completed' && ev.nodeId === 'read1') {
      output = typeof ev.output === 'string' ? JSON.parse(ev.output) : ev.output;
    }
    if (ev.type === 'run_failed') failed = ev.error;
  }
  assert.equal(failed, null, `run did not fail (${JSON.stringify(failed)})`);
  assert.ok(output?.content?.includes('filesystem_read runs'), 'file content flowed through the connector');
});

test('request-access: lists all requestable connectors, none requested initially', async () => {
  const r = await api('GET', '/connectors/requestable', { token: tokenA });
  assert.equal(r.status, 200);
  assert.equal((r.data.connectors || []).length, REQUESTABLE_CONNECTORS.length, 'lists every requestable connector');
  assert.ok(r.data.connectors.every((c) => c.youRequested === false && c.requestCount === 0), 'all start un-requested at 0');
});

test('request-access: requires auth', async () => {
  const r = await api('GET', '/connectors/requestable', {});
  assert.equal(r.status, 401, 'unauthenticated request is rejected');
});

test('request-access: records a request and dedupes per tenant', async () => {
  const first = await api('POST', '/connectors/notion/request-access', { token: tokenA });
  assert.equal(first.status, 200);
  assert.equal(first.data.youRequested, true);
  assert.equal(first.data.requestCount, 1, 'first request → count 1');

  const again = await api('POST', '/connectors/notion/request-access', { token: tokenA });
  assert.equal(again.data.requestCount, 1, 'same tenant repeating does NOT inflate the count');

  const list = await api('GET', '/connectors/requestable', { token: tokenA });
  const notion = list.data.connectors.find((c) => c.id === 'notion');
  assert.equal(notion.youRequested, true, 'tenant sees its own request reflected');
  assert.equal(notion.requestCount, 1);
});

test('request-access: unknown connector is 404', async () => {
  const r = await api('POST', '/connectors/bogus-connector/request-access', { token: tokenA });
  assert.equal(r.status, 404);
});

test('request-access: aggregates across tenants but isolates youRequested', async () => {
  // Beta also requests notion → shared count rises to 2.
  const beta = await api('POST', '/connectors/notion/request-access', { token: tokenB });
  assert.equal(beta.data.requestCount, 2, 'distinct tenant → count 2');

  // Acme requests stripe (beta did not).
  await api('POST', '/connectors/stripe/request-access', { token: tokenA });

  const betaList = (await api('GET', '/connectors/requestable', { token: tokenB })).data.connectors;
  const betaNotion = betaList.find((c) => c.id === 'notion');
  const betaStripe = betaList.find((c) => c.id === 'stripe');
  assert.equal(betaNotion.youRequested, true, 'beta sees its notion request');
  assert.equal(betaNotion.requestCount, 2, 'beta sees the shared count');
  assert.equal(betaStripe.youRequested, false, 'beta did NOT request stripe (isolation)');
  assert.equal(betaStripe.requestCount, 1, 'but sees acme drove stripe demand to 1');
});

test('request-access: platform-admin sees the demand ranking; tenants cannot', async () => {
  const forbidden = await api('GET', '/connectors/demand', { token: tokenA });
  assert.equal(forbidden.status, 403, 'a tenant admin cannot read the cross-tenant demand ranking');

  const r = await api('GET', '/connectors/demand', { token: platformToken });
  assert.equal(r.status, 200);
  const notion = r.data.demand.find((d) => d.id === 'notion');
  assert.equal(notion.count, 2, 'admin sees notion demand = 2');
  assert.equal(r.data.demand[0].count >= r.data.demand[r.data.demand.length - 1].count, true, 'demand is ranked descending');
});
