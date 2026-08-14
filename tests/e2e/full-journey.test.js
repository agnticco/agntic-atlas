/**
 * P11 end-to-end full-journey suite.
 *
 * Exercises the complete user journey against the REAL spine (booted in-process
 * on temp DBs): builder (persist + converger) → workflow run → console
 * (inventory + run monitoring + SOP export) → value/ROI summary.
 *
 * Determinism: the engine LLM is stubbed so summarize/deliver runs are
 * reproducible offline (no API key, no network). The converger test exercises
 * the real LLM and is therefore SKIPPED unless ANTHROPIC_API_KEY is set — which
 * it is on the VPS (validateBootConfig requires a cloud key in production), so
 * the full builder path is validated where it matters.
 *
 *   node --test tests/e2e/full-journey.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB_SUMMARY = 'Stubbed summary: the package is out for delivery and arrives today.';

// A connector-free workflow so the run path needs no external service: summarize
// (stubbed LLM) → deliver to the always-available in-app inbox.
const JOURNEY_SPEC = {
  name: 'E2E Journey Flow',
  description: 'Full-journey E2E fixture',
  triggers: [{ type: 'manual' }],
  nodes: [
    { id: 'sum',  type: 'summarize', label: 'Summarize the input', config: { length: 'short', style: 'neutral' } },
    { id: 'note', type: 'deliver',   label: 'Save to inbox',       config: { channel: 'in_app', title: 'E2E Summary' } },
  ],
  edges: [{ from: 'sum', to: 'note' }],
};

let spine, server, base, tmp, tokenA, wfId;
const tenantId = 'acme';
let userId;

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
  tmp = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));
  for (const [k, v] of Object.entries({
    WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
    AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
    INTERACTIONS_DB: 'i.sqlite', INBOX_DB: 'inbox.sqlite',
  })) process.env[k] = join(tmp, v);
  process.env.DB_BACKUP_KEEP = '0';
  process.env.SCHEDULER_ENABLED = 'false';

  const { bootSpine, createApp } = await import('../../src/api/server.js');
  spine = await bootSpine();

  // Deterministic engine LLM: summarize/rewrite/etc. return canned content so the
  // run path is reproducible offline. The converger uses spine.engine.llm (the
  // real ModelPool), not this stub, so it stays a real-LLM path.
  const stub = { invoke: async () => ({ content: STUB_SUMMARY }), async *stream() { yield { content: STUB_SUMMARY }; } };
  spine.engine.flowTester.llm = stub;

  const app = createApp(spine);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;

  // Platform admin → tenant 'acme' + admin → login.
  const setup = await api('POST', '/setup', { body: { token: spine.auth.bootstrap.token, email: 'ops@atlas.dev', password: 'fixture-not-a-secret-ops' } });
  const tA = await api('POST', '/tenants', { token: setup.data.token, body: { name: 'Acme', slug: tenantId, admin: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme' } } });
  userId = tA.data.admin.id;
  const login = await api('POST', '/auth/login', { body: { email: 'a@acme.test', password: 'fixture-not-a-secret-acme' } });
  tokenA = login.data.token;
  assert.ok(tokenA, 'tenant admin obtained a session token');
});

after(async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { spine?.close(); } catch { /* ignore */ }
  try { await spine?.disposeModels?.(); } catch { /* ignore */ }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('builder: persists + activates a workflow', async () => {
  const r = await api('POST', '/api/builder/workflows', { token: tokenA, body: { spec: JOURNEY_SPEC, intent: 'summarize and save to inbox' } });
  assert.equal(r.status, 200, `persist returned 200 (got ${r.status}: ${JSON.stringify(r.data)})`);
  assert.ok(r.data.workflowId, 'returns a workflowId');
  wfId = r.data.workflowId;
});

test('engine: runs the workflow end-to-end (deterministic stub LLM)', async () => {
  const r = await api('POST', '/workflows/run', { token: tokenA, body: { spec: { ...JOURNEY_SPEC, id: wfId }, initialContext: 'UPS: your package is out for delivery, arriving today by 7pm.' } });
  assert.equal(r.status, 200, `run returned 200 (got ${r.status})`);
  assert.equal(r.data.completed, true, `run completed (error: ${JSON.stringify(r.data.error)})`);
  const summarized = JSON.stringify(r.data.steps || []).includes('Stubbed summary');
  assert.ok(summarized, 'summarize step produced the stubbed content');
});

test('console: inventory lists the workflow', async () => {
  const r = await api('GET', '/api/console/workflows', { token: tokenA });
  assert.equal(r.status, 200);
  assert.ok((r.data.workflows || []).some((w) => w.id === wfId), 'inventory includes the workflow');
});

test('console: run monitoring shows a recorded run with time-saved', async () => {
  // Record a completed (non-test) run with an explicit time-saved value so the
  // monitoring + ROI surfaces have deterministic data.
  const run = spine.engine.workflowStore.startRun(wfId, { isTest: false });
  spine.engine.workflowStore.completeRun(run.id, { result: STUB_SUMMARY }, { inputTokens: 10, outputTokens: 5, costUsd: 0.001, calls: 1 }, null, 7);

  const r = await api('GET', `/api/console/workflows/${wfId}/runs`, { token: tokenA });
  assert.equal(r.status, 200);
  const found = (r.data.runs || []).find((x) => x.id === run.id);
  assert.ok(found, 'the recorded run is listed');
  assert.equal(found.status, 'success', 'run shows success');
  assert.equal(found.time_saved_minutes, 7, 'time-saved persisted');

  const single = await api('GET', `/api/console/workflows/${wfId}/runs/${run.id}`, { token: tokenA });
  assert.equal(single.status, 200, 'single-run detail returns 200');
  assert.equal(single.data.run.id, run.id);
});

test('console: SOP markdown export reflects the workflow', async () => {
  const r = await api('GET', `/api/console/workflows/${wfId}/sop`, { token: tokenA });
  assert.equal(r.status, 200);
  assert.ok(typeof r.data === 'string' && r.data.length > 0, 'SOP markdown is non-empty');
  assert.ok(r.data.includes('E2E Journey Flow'), 'SOP includes the workflow name');
});

test('value: ROI summary reflects the recorded time-saved', async () => {
  const r = await api('GET', '/api/console/roi', { token: tokenA });
  assert.equal(r.status, 200);
  assert.ok(r.data.roi, 'roi payload present');
  assert.ok(r.data.roi.totalTimeSavedMinutes >= 7, `ROI total time-saved >= 7 (got ${r.data.roi.totalTimeSavedMinutes})`);
  assert.ok((r.data.roi.byWorkflow || []).some((w) => w.id === wfId), 'ROI breakdown includes the workflow');
});

test('builder: converger produces a runnable spec (real LLM)', { skip: !process.env.ANTHROPIC_API_KEY ? 'requires ANTHROPIC_API_KEY (runs on VPS)' : false }, async () => {
  const { runHeadless } = await import('../../src/converger/index.js');
  const { spec } = await runHeadless({
    intent: 'When a UPS tracking email arrives, summarize it and post to Slack #social.',
    capabilities: { connectors: { slack: { actions: [{ id: 'post_message', label: 'Post', available: true }] }, google: { actions: [{ id: 'gmail_search', label: 'Search', available: true }] } } },
    llm: spine.engine.llm,
    checkpointerDir: join(tmp, 'converger'),
  });
  assert.ok(spec, 'converger returned a spec');
  assert.ok((spec.triggers || []).length > 0 || (spec.nodes || []).some((n) => n.type === 'trigger'), 'spec has a trigger');
  assert.ok((spec.nodes || []).length >= 1, 'spec has nodes');
});
