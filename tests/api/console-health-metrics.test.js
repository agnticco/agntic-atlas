/**
 * F14 — THE HEALTH BAND COUNTS LIVE RUNS, NOT TEST RUNS.
 *
 * The defect: `GET /api/console/workflows/:id/metrics` aggregated over EVERY run
 * row, including build-time test runs. Immediately after publishing, the console
 * read **"100% success · 1 RUNS · 0 ERRORS"** for a workflow that had never once
 * fired for real — the single run being the pre-publish test. Test runs are the
 * runs most likely to have been re-run until green, so this seeded the one number
 * an operator uses to judge whether an automation is healthy with the most
 * flattering possible sample.
 *
 * This was DELIBERATE (commit `c3aad3c`, "Q13"), which removed an existing
 * `.filter(r => !r.is_test)` so the band's run count would agree with the
 * run-history list underneath it. That concern was real; the remedy made the band
 * untrue. The fix separates rather than hides: the band counts live runs, `tests`
 * is returned alongside so the UI can show "not yet run live · 1 test run", and
 * the run-history list still lists test runs with their TEST badge. Both numbers
 * are now true and they no longer contradict each other.
 *
 * WHY THIS TEST IS AT THE HTTP LAYER.
 *
 * The aggregation lives inline in the route. A unit test of `isLiveRun` would stay
 * green if `console.js` reverted to counting every row — it would verify a
 * predicate nobody applied (CLAUDE.md, architectural flaw #2). So this constructs
 * the subject the way production does — express + `mountConsoleRoutes` + a REAL
 * SQLite `WorkflowStore` — and drives the real endpoint over real HTTP, with runs
 * recorded through the same `startRun`/`finishRun` calls the engine makes.
 */

import { test, describe, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import http    from 'node:http';
import express from 'express';

import { mountConsoleRoutes } from '../../src/api/console.js';
import { WorkflowStore }      from '../../src/workflows/workflow-store.js';
import { isLiveRun }          from '../../src/workflows/time-saved.js';

const TENANT = 't1';
const USER   = 'u1';

function identity(req, _res, next) {
  req.tenant = { id: TENANT, name: 'Acme' };
  req.user   = { id: USER };
  next();
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    }).on('error', reject);
  });
}

describe('GET /api/console/workflows/:id/metrics counts live runs only (F14)', () => {
  let server, port, store;

  before(async () => {
    store = new WorkflowStore({ dbPath: ':memory:' });
    await store.init();

    const app = express();
    app.use(express.json());
    mountConsoleRoutes(app, {
      spine: { engine: { workflowStore: store, workflowScheduler: null } },
      requireActiveTenant: identity,
    });
    await new Promise((r) => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  let seq = 0;
  function makeWorkflow() {
    return store.create({
      name: `wf-${++seq}`,
      status: 'active',
      nodes: [],
      edges: [],
      triggers: [{ type: 'schedule', cron: '0 9 * * *' }],
      userId: USER,
      tenantId: TENANT,
    });
  }

  /** Record a finished run through the same calls the engine makes. */
  function record(wfId, { isTest, status, costUsd = null }) {
    const { id: runId } = store.startRun(wfId, { isTest });
    const cost  = costUsd == null ? null : { costUsd };
    if (status === 'success') store.completeRun(runId, 'ok', cost);
    else                      store.failRun(runId, 'boom', cost);
    return runId;
  }

  async function metricsFor(wfId) {
    const res = await get(port, `/api/console/workflows/${wfId}/metrics`);
    assert.equal(res.status, 200, `metrics fetch failed: ${res.raw}`);
    return res.body.metrics;
  }

  test('THE DEFECT: a workflow that has only ever been test-run is not "100% success"', async () => {
    const wf = makeWorkflow();
    record(wf.id, { isTest: true, status: 'success' });

    const m = await metricsFor(wf.id);

    // The exact reading from the F14 report was "100% success · 1 RUNS · 0 ERRORS".
    assert.equal(m.total, 0, 'a test run was counted as a live run');
    assert.equal(m.rate, null, 'a success RATE was reported for a workflow that never ran live');
    assert.equal(m.success, 0);
    assert.equal(m.lastRun, null, '"last run" pointed at a test run');
  });

  test('the test runs are SEPARATED, not hidden — the band can still show them', async () => {
    const wf = makeWorkflow();
    record(wf.id, { isTest: true, status: 'success' });
    record(wf.id, { isTest: true, status: 'error' });

    const m = await metricsFor(wf.id);
    assert.equal(m.tests, 2, 'test runs vanished instead of being reported separately');
    assert.equal(m.total, 0);
  });

  test('live runs are counted, and a failed live run counts against the rate', async () => {
    const wf = makeWorkflow();
    record(wf.id, { isTest: true,  status: 'success' }); // must not flatter the rate
    record(wf.id, { isTest: false, status: 'success' });
    record(wf.id, { isTest: false, status: 'success' });
    record(wf.id, { isTest: false, status: 'error'   });

    const m = await metricsFor(wf.id);
    assert.equal(m.total, 3, 'live run count is wrong');
    assert.equal(m.success, 2);
    assert.equal(m.errors, 1);
    assert.equal(m.rate, 67, 'a failed live run must drag the success rate down');
    assert.equal(m.tests, 1);
  });

  test('a run still in flight is neither a success nor an error, but is a live run', async () => {
    const wf = makeWorkflow();
    record(wf.id, { isTest: false, status: 'success' });
    store.startRun(wf.id, { isTest: false }); // left running

    const m = await metricsFor(wf.id);
    assert.equal(m.total, 2);
    assert.equal(m.success, 1);
    assert.equal(m.errors, 0);
    assert.equal(m.rate, 50);
  });

  test('cost is SPEND, not health — a test run costs real money and still counts', async () => {
    const wf = makeWorkflow();
    record(wf.id, { isTest: true,  status: 'success', costUsd: 0.25 });
    record(wf.id, { isTest: false, status: 'success', costUsd: 0.25 });

    const m = await metricsFor(wf.id);
    assert.ok(m.costUsd > 0.4, `test-run spend was dropped from the cost figure (got ${m.costUsd})`);
    assert.equal(m.total, 1, 'cost accounting must not leak into the health count');
  });

  test('no runs at all reads as "not yet run", not as a failure', async () => {
    const m = await metricsFor(makeWorkflow().id);
    assert.equal(m.total, 0);
    assert.equal(m.tests, 0);
    assert.equal(m.rate, null, 'an unrun workflow must not report a 0% success rate');
  });
});

describe('isLiveRun — the shared definition both surfaces filter on', () => {
  test('a test run is never live, whatever its status', () => {
    assert.equal(isLiveRun({ is_test: 1, status: 'success' }), false);
    assert.equal(isLiveRun({ is_test: 1, status: 'error'   }), false);
  });

  test('a FAILED live run is still live — status is deliberately not considered', () => {
    assert.equal(isLiveRun({ is_test: 0, status: 'error' }), true,
      'excluding failures here would hide errors from the success rate');
  });

  test('is total over a missing run', () => {
    assert.equal(isLiveRun(null), false);
    assert.equal(isLiveRun(undefined), false);
  });
});
