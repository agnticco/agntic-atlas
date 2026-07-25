/**
 * Resume must not be able to make a never-tested draft live.
 *
 * Found by driving the real product. The endpoint read:
 *
 *     const newStatus = wf.status === 'active' ? 'paused' : 'active';
 *
 * — so ANY non-active status became active, `draft` included. A workflow that had
 * never been tested, never had its promise checked and never had a trigger armed
 * could be made live and scheduled, with no error shown anywhere. During QA a real
 * draft went draft -> active -> paused through this endpoint and was live for 42
 * seconds.
 *
 * Two things were missing, and they are exactly the two things publish does: only
 * promote from a state that has earned it, and ARM the triggers. Without the second,
 * resuming an Airtable-triggered workflow marks it live while no webhook exists —
 * the "shows as live, can never fire" shape this codebase has already shipped once.
 *
 * These drive the real route through a minimal express app, because the defect was
 * in the route's own logic and a test of a helper would have missed it entirely.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { mountConsoleRoutes } from '../../src/api/console.js';

/** A workflow store with just the surface the pause route touches. */
function makeStore(initial) {
  const rows = new Map(initial.map(w => [w.id, { ...w }]));
  return {
    rows,
    get: (id) => rows.get(id) ?? null,
    update: (id, patch) => {
      const row = rows.get(id);
      if (row) Object.assign(row, patch);
      return row;
    },
    list: () => [...rows.values()].filter(w => w.status === 'active'),
    getRuns: () => [],
    getRun: () => null,
  };
}

function makeApp(store) {
  const app = express();
  app.use(express.json());
  // requireActiveTenant stands in for the real middleware: it only supplies the
  // identity the route reads. The route's OWN logic is what is under test.
  const requireActiveTenant = (req, _res, next) => {
    req.tenant = { id: 't1' };
    req.user   = { id: 'u1' };
    next();
  };
  mountConsoleRoutes(app, {
    spine: {
      engine: { workflowStore: store, workflowScheduler: {} },
      auth:   { oauthTokenStore: { get: () => null }, tokenCipher: {} },
    },
    requireActiveTenant,
  });
  return app;
}

/** Fire the route without binding a port. */
function post(app, path) {
  return new Promise((resolve) => {
    const req = { method: 'POST', url: path, headers: {}, body: {}, params: {}, query: {} };
    const server = app.listen(0, async () => {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      server.close(() => resolve({ status: res.status, body }));
    });
    void req;
  });
}

let store, app;

beforeEach(() => {
  store = makeStore([
    { id: 'wf-draft',  tenant_id: 't1', status: 'draft'  },
    { id: 'wf-active', tenant_id: 't1', status: 'active' },
    { id: 'wf-paused', tenant_id: 't1', status: 'paused' },
    { id: 'wf-error',  tenant_id: 't1', status: 'error'  },
  ]);
  app = makeApp(store);
});

describe('pause/resume refuses to promote what has not earned live', () => {
  test('a DRAFT cannot be made live through resume', async () => {
    const { status, body } = await post(app, '/api/console/workflows/wf-draft/pause');

    // MUTATION: restore `wf.status === 'active' ? 'paused' : 'active'` — the draft
    // becomes active, the assertions below go red, and a never-tested workflow is
    // live and scheduled.
    assert.equal(status, 409, 'a draft must be refused, not silently promoted');
    assert.equal(body.code, 'NOT_RESUMABLE');
    assert.equal(store.get('wf-draft').status, 'draft', 'the draft must be untouched');
    assert.match(body.error, /never been published/i,
      'the refusal must say what to do instead, not just say no');
  });

  test('an ERRORED workflow cannot be resumed into live either', async () => {
    const { status } = await post(app, '/api/console/workflows/wf-error/pause');
    assert.equal(status, 409);
    assert.equal(store.get('wf-error').status, 'error');
  });

  test('the ordinary pause still works', async () => {
    const { status, body } = await post(app, '/api/console/workflows/wf-active/pause');
    assert.equal(status, 200);
    assert.equal(body.status, 'paused');
    assert.equal(store.get('wf-active').status, 'paused');
  });

  test('the ordinary resume still works — the guard did not break the feature', async () => {
    // The failure mode of a guard is over-blocking. A paused workflow HAS been
    // published and verified; resuming it is the whole point of the button.
    const { status, body } = await post(app, '/api/console/workflows/wf-paused/pause');
    assert.equal(status, 200);
    assert.equal(body.status, 'active');
    assert.equal(store.get('wf-paused').status, 'active');
  });

  test('a workflow from another tenant is not found, whatever its status', async () => {
    store.rows.set('wf-other', { id: 'wf-other', tenant_id: 't2', status: 'paused' });
    const { status } = await post(app, '/api/console/workflows/wf-other/pause');
    assert.equal(status, 404);
    assert.equal(store.get('wf-other').status, 'paused');
  });

  test('an unknown id is 404, not a 500', async () => {
    const { status } = await post(app, '/api/console/workflows/nope/pause');
    assert.equal(status, 404);
  });
});
