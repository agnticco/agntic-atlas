/**
 * F11 — THE OUTCOME CONTRACT SURVIVES PUBLISH, THROUGH THE ROUTE PRODUCTION USES.
 *
 * The defect (`aa56d42`): `PUT /api/builder/workflows/:id` enumerated the fields it
 * forwarded to `workflowService.update()` and omitted `outcome`. `update()` correctly
 * reads an absent key as INHERIT, and the row it inherited from was the draft row —
 * born with no contract. So `outcome` was NULL on 100% of stored workflows, silently
 * disabling `UNSATISFIED_ASSERTION` on every later edit and leaving the SOP nothing
 * to render.
 *
 * WHY THIS TEST IS AT THE HTTP LAYER AND NOT AT THE SERVICE LAYER.
 *
 * `tests/converger/gap-oracle.test.js` already proves `WorkflowService.create/update`
 * persists an `outcome` handed to it — and it passed for the entire life of this bug,
 * because the bug was that the ROUTE never handed it one. A service-level test
 * verifies a program nobody runs (ENGINEERING-LOG.md, architectural flaw #2). So this suite
 * constructs the subject the way production does:
 *
 *   express + express.json() + mountBuilderRoutes + a REAL WorkflowStore (SQLite)
 *   + a REAL WorkflowService + the REAL production capability catalog,
 *
 * and drives it over real HTTP, through the real publish sequence the client
 * performs: `POST /api/builder/draft` (what `_ensureDraft` calls on the first
 * message) then `PUT /api/builder/workflows/:id` (what `_saveWorkflow` calls,
 * because `S.workflowId` is set by then and so POST is unreachable).
 *
 * The assertion is on the STORED ROW, read back out of SQLite — not on the route's
 * response body, which could echo a contract it never wrote.
 */

import { test, describe, before, after } from 'node:test';
import assert  from 'node:assert/strict';
import http    from 'node:http';
import express from 'express';

import { mountBuilderRoutes }       from '../../src/api/builder.js';
import { WorkflowStore }            from '../../src/workflows/workflow-store.js';
import { WorkflowService }          from '../../src/workflows/workflow-service.js';
import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { productionCatalog }        from '../helpers/prod-catalog.js';

const TENANT = 't1';
const USER   = 'u1';

function identity(req, _res, next) {
  req.tenant = { id: req.headers['x-test-tenant'] || TENANT, name: 'Acme' };
  req.user   = { id: req.headers['x-test-user']   || USER };
  next();
}

/** POST/PUT JSON over real HTTP and return { status, body }. */
function send(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = http.request(
      { port, method, path, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => { let parsed = null; try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: parsed, raw }); });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * "Every urgent email is posted to #ops." A minimal but REAL v2 spec: it carries
 * an outcome contract whose assertion the nodes actually satisfy, so it publishes.
 */
const spec = () => ({
  version: 2,
  name: 'Urgent mail alert',
  description: 'Post urgent mail to #ops',
  outcome: {
    statement: 'Every urgent email is posted to #ops.',
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }],
    examples: [{ id: 'e1', label: 'an urgent email', given: { subject: 'server down' }, expect: { posted: true } }],
  },
  triggers: [{ type: 'email', filter: 'to:ops@acme.com' }],
  nodes: [
    { id: 'sum',  type: 'llm',     label: 'Summarize', config: { mode: 'summarize' } },
    { id: 'post', type: 'deliver', label: 'Post',      config: { channel: 'slack', target: '#ops' } },
  ],
  edges: [{ from: 'sum', to: 'post' }],
});

describe('PUT /api/builder/workflows/:id persists the outcome contract (F11)', () => {
  let server, port, store;

  before(async () => {
    store = new WorkflowStore({ dbPath: ':memory:' });
    await store.init();
    const channels = productionCatalog();
    const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
    const service = new WorkflowService({
      workflowStore: store,
      nodeTypeRegistry: nodeTypes,
      // Publish validates WITH a channel registry (server.js buildEngine). A
      // validator without one answers a different question than publish answers.
      workflowValidator: new WorkflowValidator({ nodeTypes, channelRegistry: channels }),
    });

    const app = express();
    app.use(express.json());
    mountBuilderRoutes(app, {
      spine: { engine: { workflowStore: store, workflowService: service } },
      requireActiveTenant: identity,
      requireAuth: identity,
    });
    await new Promise((r) => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  /** The real client sequence: draft row first (_ensureDraft), then publish (PUT). */
  async function publish(s) {
    const draft = await send(port, 'POST', '/api/builder/draft', {});
    assert.equal(draft.status, 200, `draft creation failed: ${draft.raw}`);
    const id = draft.body.workflowId;
    // The draft row is born WITHOUT a contract — this is the state the bug
    // inherited from, so the fixture must prove it really is empty.
    assert.equal(store.get(id, { userId: USER }).outcome ?? null, null,
      'fixture invalid: the draft row already had an outcome');
    const put = await send(port, 'PUT', `/api/builder/workflows/${id}`, { spec: s });
    return { id, put };
  }

  test('THE ACCEPTANCE: the stored row carries the contract and spec_version 2', async () => {
    const s = spec();
    const { id, put } = await publish(s);
    assert.equal(put.status, 200, `publish rejected: ${put.raw}`);
    assert.equal(put.body.ok, true);

    // Read the ROW back out of SQLite. Not the response body — a route can echo a
    // contract it never wrote, which is exactly how this bug survived.
    const row = store.get(id, { userId: USER });
    assert.ok(row.outcome, 'the outcome contract was DROPPED on the way in (F11)');
    assert.equal(row.outcome.statement, s.outcome.statement, 'the STORED contract must be what was SENT');
    assert.equal(row.outcome.assertions.length, 1);
    assert.equal(row.outcome.assertions[0].target, 'slack:#ops');
    assert.equal(row.spec_version, 2, 'a stored contract that is not spec v2 is not a v2 workflow');
  });

  test('the persisted contract is ENFORCED on a later edit (what F11 silently disabled)', async () => {
    // The consequence, not the shape. With outcome NULL, deleting the promised
    // delivery saved clean. Note this second PUT sends NO outcome key at all — the
    // inherit path — which is precisely how a real "just tweak a node" edit arrives.
    const { id } = await publish(spec());
    const gutted = spec();
    delete gutted.outcome;
    gutted.nodes = gutted.nodes.filter((n) => n.id !== 'post');
    gutted.edges = [];

    const res = await send(port, 'PUT', `/api/builder/workflows/${id}`, { spec: gutted });
    assert.equal(res.status, 400, 'an edit that breaks the STORED promise must not save');
    assert.ok((res.body.issues ?? []).some((i) => i.code === 'UNSATISFIED_ASSERTION'),
      `expected UNSATISFIED_ASSERTION; got ${JSON.stringify(res.body)}`);

    // …and the stored contract is untouched by the rejected edit.
    const row = store.get(id, { userId: USER });
    assert.ok(row.outcome, 'a rejected edit must not wipe the contract');
    assert.equal(row.nodes.length, 2, 'the rejected edit leaked into the database');
  });

  test('an ABSENT outcome key INHERITS the stored contract (a dumb caller cannot wipe it)', async () => {
    const { id } = await publish(spec());
    const edit = spec();
    delete edit.outcome;                       // undefined ⇒ inherit
    edit.nodes[0].config = { mode: 'summarize', style: 'bullets' };

    const res = await send(port, 'PUT', `/api/builder/workflows/${id}`, { spec: edit });
    assert.equal(res.status, 200, `a contract-preserving edit was rejected: ${res.raw}`);
    const row = store.get(id, { userId: USER });
    assert.ok(row.outcome, 'undefined must INHERIT, not retract');
    assert.equal(row.outcome.assertions.length, 1);
    assert.equal(row.spec_version, 2);
  });

  test('an EXPLICIT null RETRACTS the contract (and drops back to spec v1)', async () => {
    // The other half of the distinction. Collapsing undefined and null into one
    // meaning is how a caller that knows nothing about outcomes wipes one — or how
    // a deliberate retraction becomes impossible.
    const { id } = await publish(spec());
    assert.ok(store.get(id, { userId: USER }).outcome, 'precondition: the contract is stored');

    const retract = spec();
    retract.outcome = null;
    const res = await send(port, 'PUT', `/api/builder/workflows/${id}`, { spec: retract });
    assert.equal(res.status, 200, `an explicit retraction was rejected: ${res.raw}`);

    const row = store.get(id, { userId: USER });
    assert.equal(row.outcome ?? null, null, 'explicit null must RETRACT');
    assert.equal(row.spec_version, 1, 'no contract ⇒ not a v2 spec');
  });

  test('the contract also survives a PUT that CHANGES it (not just the first write)', async () => {
    const { id } = await publish(spec());
    const edited = spec();
    edited.outcome.statement = 'Every urgent email is posted to #ops within a minute.';
    edited.outcome.assertions = [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' },
                                 { id: 'a2', kind: 'message_sent', target: 'slack:#ops' }];
    const res = await send(port, 'PUT', `/api/builder/workflows/${id}`, { spec: edited });
    assert.equal(res.status, 200, `re-publish rejected: ${res.raw}`);

    const row = store.get(id, { userId: USER });
    assert.equal(row.outcome.assertions.length, 2, 'the UPDATED contract must overwrite the stored one');
    assert.match(row.outcome.statement, /within a minute/);
  });
});
