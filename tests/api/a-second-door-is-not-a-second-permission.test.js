/**
 * A SECOND DOOR INTO THE SAME ROOM MUST NOT BE A SECOND SET OF KEYS.
 *
 * ── What this endpoint is ──────────────────────────────────────────────────
 *
 * `POST /mcp` speaks Atlas's workflow API as Model Context Protocol, so an agent
 * harness can list and run automations without writing a bespoke REST client. Atlas
 * already reads other servers' MCP catalogs (`connectors/mcp-catalog.js`); this is the
 * mirror of that.
 *
 * ── The risk it carries, and what these tests are actually for ─────────────
 *
 * A new protocol surface over an existing store is exactly where tenant scoping gets
 * re-implemented and gets it wrong. The console API resolves a workflow in two steps —
 * fetch scoped to the user, then compare `tenant_id` — and every tool here has to do the
 * same thing. A tool that skipped the second step would read another workspace's
 * automation and look completely normal doing it, because the store returned a row.
 *
 * So the first assertions are not about MCP at all. They are that a caller from tenant B
 * cannot see, read or run tenant A's workflow through this door, and that the answer is
 * indistinguishable from the workflow not existing.
 *
 * ── The three JSON-RPC details a hand-rolled server gets wrong ─────────────
 *
 *   1. A NOTIFICATION (no `id`) must be acknowledged by status and never answered.
 *      Replying to one is the usual reason a client sits waiting forever.
 *   2. A TOOL'S OWN FAILURE is a result with `isError`, not a JSON-RPC error. A
 *      transport error tells the model nothing; `isError` hands it the message so it can
 *      try something else.
 *   3. `tools/list` must not leak the server's internals. Each tool here carries a `run`
 *      function, and a naive projection ships it as `undefined` or throws on serialise.
 *
 * ── Mutations, run by hand ─────────────────────────────────────────────────
 *   M1  the tenant check is dropped from ownedWorkflow   → 2 red
 *   M2  a notification is answered instead of 202        → 1 red
 *   M3  a tool throw becomes a JSON-RPC error            → 3 red
 *   M4  run_workflow is advertised as readOnly           → 1 red
 *   M5  batches are accepted and executed                → 1 red
 *   M6  the client's protocolVersion is echoed unchecked → 1 red
 *   M7  the tenant guard is consulted after runNow       → 1 red
 *   M8  the guard is applied to every method, not costly → 1 red
 *
 * M1 kills two rather than three: the listing test survives because `store.list` filters
 * by tenant itself, so what that test actually pins is narrower — that the tool forwards
 * the CALLER's tenant to the store rather than a default or another's. That is worth
 * having and is not the same guard as the other two.
 *
 * A LATER MUTATION, run by hand: dropping the `aud` comparison in mcpAuth → 1 red. The
 * token stubs here carry `aud` for the same reason — one without it is rejected before
 * the scope and tenant comparisons these tests are actually about, which would have made
 * them pass while proving nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { mountMcpRoutes } from '../../src/api/mcp.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const WORKFLOW = {
  id: 'wf-1', name: 'Daily brief', status: 'active',
  tenant_id: TENANT_A, updated_at: '2026-08-19T09:00:00Z',
  nodes: [], edges: [], triggers: [],
};

/**
 * The real route module against a stubbed store.
 *
 * Only storage is stubbed — the dispatch, the tenant check and the tool projection are
 * the code under test and are the real thing. A test that re-implements its subject
 * proves that the test can call a function.
 */
function appFor(tenantId, { runNow = async () => {}, tenantGuard = null,
                           accessToken = null, issuer = 'https://atlas.test',
                           session = true, grantIsLive = () => true } = {}) {
  const ran = [];
  const store = {
    list: ({ tenantId: t }) => (t === TENANT_A ? [WORKFLOW] : []),
    // Scoped by user in production; here the tenant comparison in ownedWorkflow is what
    // is under test, so the store deliberately returns the row to ANY caller.
    get: (id) => (id === WORKFLOW.id ? WORKFLOW : null),
    getRuns: () => [{ id: 'run-1', status: 'succeeded' }],
    getLastRun: () => ({ id: 'run-1', status: 'succeeded' }),
  };
  const scheduler = { runNow: async (id, opts) => { ran.push({ id, opts }); return runNow(id, opts); } };

  const app = express();
  app.use(express.json());
  // `session: false` is a caller with no Atlas cookie — the only way to see what the
  // bearer path decided on its own. With a session always available, a rejected token
  // silently falls through to it and every token test passes for the wrong reason.
  const requireActiveTenant = (req, res, next) => {
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: 'user-1' };
    req.tenant = { id: tenantId };
    next();
  };
  // `accessToken` stands in for a token minted by the consent flow: {token: claims}.
  // Verifying a real JWT is token-service's job and is tested there; what is under test
  // here is what the endpoint does with the claims once it has them.
  const tokenService = { verify: (t) => (accessToken && accessToken.token === t ? accessToken.claims : null) };
  const userStore = { findById: (id) => ({ id, tenant_id: accessToken?.claims?.tid, disabled_at: null }) };

  mountMcpRoutes(app, {
    spine: { engine: { workflowStore: store, workflowScheduler: scheduler },
             interactionStore: null, auth: { tokenService, userStore } },
    requireActiveTenant, tenantGuard, issuer,
    oauth: accessToken ? { grantIsLive } : null,
  });
  return { app, ran };
}

/** Drive the endpoint the way a client does, without binding a port. */
async function rpc(app, message) {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    await new Promise(r => server.close(r));
  }
}

const call = (name, args = {}) =>
  ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

describe('the MCP endpoint is scoped to the calling tenant', () => {
  test('a workflow from another tenant is not listed', async () => {
    const { app } = appFor(TENANT_B);
    const { body } = await rpc(app, call('list_workflows'));
    assert.equal(body.result.isError, undefined);
    assert.equal(JSON.parse(body.result.content[0].text).length, 0,
      'tenant B was shown tenant A\'s workflow');
  });

  test('reading another tenant\'s workflow fails as if it does not exist', async () => {
    const { app } = appFor(TENANT_B);
    const { body } = await rpc(app, call('get_workflow', { id: 'wf-1' }));
    assert.equal(body.result.isError, true, 'the store returned the row and the tool served it');
    assert.match(body.result.content[0].text, /No workflow/,
      'the refusal must not distinguish "not yours" from "not there"');
  });

  test('running another tenant\'s workflow does not reach the scheduler', async () => {
    const { app, ran } = appFor(TENANT_B);
    const { body } = await rpc(app, call('run_workflow', { id: 'wf-1' }));
    assert.equal(body.result.isError, true);
    assert.equal(ran.length, 0,
      'a cross-tenant run reached runNow — the check must come BEFORE the side effect');
  });

  test('the owning tenant can read and run it', async () => {
    const { app, ran } = appFor(TENANT_A);
    const read = await rpc(app, call('get_workflow', { id: 'wf-1' }));
    assert.equal(read.body.result.isError, undefined, read.body.result.content?.[0]?.text);

    const run = await rpc(app, call('run_workflow', { id: 'wf-1' }));
    assert.equal(run.body.result.isError, undefined);
    assert.equal(ran.length, 1, 'the run never happened');
    assert.equal(ran[0].opts.trigger, 'mcp', 'a run should record where it came from');
  });
});

describe('spend and concurrency are guarded where they are spent', () => {
  /** Stands in for the real tenantGuard, refusing the way it does. */
  const refusing = (_req, res) =>
    res.status(429).json({ error: 'Daily usage limit reached for this workspace.' });

  test('a throttled run is refused before the scheduler is touched', async () => {
    const { app, ran } = appFor(TENANT_A, { tenantGuard: refusing });
    const { body } = await rpc(app, call('run_workflow', { id: 'wf-1' }));
    assert.equal(ran.length, 0,
      'the workflow ran and was then reported as throttled — a guard that fires after '
      + 'the side effect is a report, not a guard');
    assert.equal(body.result.isError, true);
  });

  test('the refusal is readable by the caller, not a bare transport error', async () => {
    const { app } = appFor(TENANT_A, { tenantGuard: refusing });
    const { status, body } = await rpc(app, call('run_workflow', { id: 'wf-1' }));
    assert.equal(status, 200,
      'a 429 with a REST error body reaches an MCP client as an opaque transport failure');
    assert.match(body.result.content[0].text, /Daily usage limit/,
      'a model that cannot read why it was refused will simply retry');
  });

  test('reading is never gated — a workspace over budget can still be inspected', async () => {
    const { app } = appFor(TENANT_A, { tenantGuard: refusing });
    for (const c of [call('list_workflows'), call('get_workflow', { id: 'wf-1' })]) {
      const { body } = await rpc(app, c);
      assert.notEqual(body.result.isError, true,
        `${c.params.name} was throttled; only tools that spend money should be`);
    }
    const init = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.ok(init.body.result.serverInfo,
      'initialize was gated — a client could not connect at all while over budget');
  });

  test('the guard still runs for the owning tenant when it allows', async () => {
    let seen = 0;
    const allowing = (_req, _res, next) => { seen++; next(); };
    const { app, ran } = appFor(TENANT_A, { tenantGuard: allowing });
    await rpc(app, call('run_workflow', { id: 'wf-1' }));
    assert.equal(seen, 1, 'the guard was never consulted for a costly call');
    assert.equal(ran.length, 1);
  });
});

describe('an OAuth token carries only what was consented to', () => {
  // `aud` is part of a real access token: the endpoint refuses one addressed to another
  // resource. A stub without it is not a token this server would ever accept.
  const tokenFor = (scope) => ({
    token: 'access-tok',
    claims: { typ: 'access', sub: 'user-1', tid: TENANT_A, scope,
              aud: 'https://atlas.test', gid: 'grant-1' },
  });

  /** Send with a bearer token rather than relying on the session stub. */
  async function rpcAs(app, token, message) {
    const { createServer } = await import('node:http');
    const server = createServer(app);
    await new Promise(r => server.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(message),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    } finally { await new Promise(r => server.close(r)); }
  }

  test('revoking the grant stops the access token that was already issued', async () => {
    const { app } = appFor(TENANT_A, {
      session: false,
      accessToken: tokenFor('workflows:read workflows:run'),
      grantIsLive: () => false,   // the user disconnected it, or reuse was detected
    });
    const { status } = await rpcAs(app, 'access-tok',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(status, 401,
      'a revoked connection kept working until its JWT expired — up to 8 hours during which '
      + 'the disconnect button, and the refresh-reuse detection that relies on it, did nothing');
  });

  test('a token addressed to another resource is not accepted here', async () => {
    const { app } = appFor(TENANT_A, { session: false, accessToken: {
      token: 'access-tok',
      claims: { typ: 'access', sub: 'user-1', tid: TENANT_A,
                scope: 'workflows:read workflows:run',
                aud: 'https://other-mcp.example', gid: 'grant-1' },
    } });
    const { status, headers } = await rpcAs(app, 'access-tok',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(status, 401,
      'a token minted for another service was spent here — the resource binding this server '
      + 'advertises in its metadata would be a claim it does not keep');
    assert.match(headers.get('www-authenticate') ?? '', /resource_metadata="/);
  });

  test('a read-only token is not even shown run_workflow', async () => {
    const { app } = appFor(TENANT_A, { accessToken: tokenFor('workflows:read') });
    const { body } = await rpcAs(app, 'access-tok', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = body.result.tools.map(t => t.name);
    assert.ok(names.includes('list_workflows'), names.join(', '));
    assert.ok(!names.includes('run_workflow'),
      'advertising a tool the caller cannot use spends a model turn discovering a boundary '
      + 'it could have been told about');
  });

  test('a read-only token calling run_workflow is refused, readably', async () => {
    const { app, ran } = appFor(TENANT_A, { accessToken: tokenFor('workflows:read') });
    const { body } = await rpcAs(app, 'access-tok', call('run_workflow', { id: 'wf-1' }));
    assert.equal(ran.length, 0, 'a scope check that runs after the side effect is not a check');
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0].text, /workflows:run/,
      'the refusal must name the missing scope, or nobody knows what to reconnect for');
  });

  test('a token granted run may run', async () => {
    const { app, ran } = appFor(TENANT_A, { accessToken: tokenFor('workflows:read workflows:run') });
    const { body } = await rpcAs(app, 'access-tok', call('run_workflow', { id: 'wf-1' }));
    assert.equal(body.result.isError, undefined, body.result.content?.[0]?.text);
    assert.equal(ran.length, 1);
  });

  test('a token for another tenant cannot reach this one', async () => {
    const { app } = appFor(TENANT_A, {
      // Addressed to us and otherwise valid — the ONLY thing wrong with it is the tenant,
      // which is what this test is about. Drop `aud` and it is rejected an inch earlier,
      // and the tenant comparison below is never reached.
      accessToken: { token: 'access-tok',
                     claims: { typ: 'access', sub: 'user-9', tid: TENANT_B, scope: 'workflows:read',
                               aud: 'https://atlas.test', gid: 'grant-9' } },
    });
    const { body } = await rpcAs(app, 'access-tok', call('get_workflow', { id: 'wf-1' }));
    assert.equal(body.result.isError, true, 'an access token reached another tenant\'s workflow');
  });

  test('a session token is not narrowed by scopes it never had', async () => {
    // A session already grants everything its holder can do; the scoped credential is the
    // new thing, and it must not retroactively restrict the old one.
    const { app, ran } = appFor(TENANT_A);
    const { body } = await rpcAs(app, 'not-an-access-token', call('run_workflow', { id: 'wf-1' }));
    assert.equal(body.result.isError, undefined, body.result.content?.[0]?.text);
    assert.equal(ran.length, 1);
  });
});

describe('it speaks JSON-RPC the way a client expects', () => {
  test('initialize advertises tools', async () => {
    const { app } = appFor(TENANT_A);
    const { body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.ok(body.result.capabilities.tools, 'no tools capability');
    assert.equal(body.result.serverInfo.name, 'atlas');
  });

  test('a notification is acknowledged, never answered', async () => {
    const { app } = appFor(TENANT_A);
    const { status, body } = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(status, 202, 'a notification must not get a result');
    assert.equal(body, null, 'a body came back for a notification — clients hang on this');
  });

  test('GET says 405, not 404', async () => {
    // 404 reads to a client as a wrong URL; 405 says the endpoint is here and does not
    // offer a server-initiated stream. A client probing for one should learn the latter.
    const { app } = appFor(TENANT_A);
    const { createServer } = await import('node:http');
    const server = createServer(app);
    await new Promise(r => server.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/mcp`);
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'POST');
    } finally { await new Promise(r => server.close(r)); }
  });

  test('an unknown method is a JSON-RPC error, not a crash', async () => {
    const { app } = appFor(TENANT_A);
    const { body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'nope' });
    assert.equal(body.error.code, -32601);
  });

  test('a tool failure is a result with isError, not a transport error', async () => {
    const { app } = appFor(TENANT_A);
    const { body } = await rpc(app, call('get_workflow', { id: 'missing' }));
    assert.equal(body.error, undefined,
      'a tool that refuses must not surface as a JSON-RPC error — the model learns nothing from one');
    assert.equal(body.result.isError, true);
  });

  test('tools/list exposes a usable schema and no internals', async () => {
    const { app } = appFor(TENANT_A);
    const { body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = body.result.tools;
    assert.ok(tools.length >= 5, `expected the full surface, got ${tools.length}`);
    for (const t of tools) {
      assert.ok(t.name && t.description, `${t.name}: incomplete advertisement`);
      assert.equal(t.inputSchema.type, 'object', `${t.name}: schema must be an object`);
      assert.equal('run' in t, false, `${t.name}: the handler leaked into the wire format`);
    }
  });

  test('a batch is refused rather than executed', async () => {
    // A 4 MB body of run_workflow calls is ~50k runs in one request, executed in
    // sequence while the connection is held. No REST route in Atlas can be asked for
    // more than one run at a time, and this door should not be the exception.
    const { app, ran } = appFor(TENANT_A);
    const { status, body } = await rpc(app, [call('run_workflow', { id: 'wf-1' }),
                                             call('run_workflow', { id: 'wf-1' })]);
    assert.equal(status, 400, 'a batch was accepted');
    // Assert the MESSAGE, not just the code. Without the array guard an array falls
    // through to the single-message path and fails the `jsonrpc` check with the same
    // 400 and the same code — so a status-only assertion passes whether the guard
    // exists or not, which is how it read green against a mutation that removed it.
    assert.match(body.error.message, /batches are not accepted/,
      'the refusal came from the jsonrpc check, not the batch guard');
    assert.equal(ran.length, 0, 'a batched run reached the scheduler');
  });

  test('an unsupported protocol version is answered with ours, not echoed', async () => {
    const { app } = appFor(TENANT_A);
    const { body } = await rpc(app, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' },
    });
    assert.notEqual(body.result.protocolVersion, '1999-01-01',
      'echoing an unknown version tells the client to frame requests this server cannot read');
  });

  test('a version we do speak is honoured', async () => {
    const { app } = appFor(TENANT_A);
    const { body } = await rpc(app, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' },
    });
    assert.equal(body.result.protocolVersion, '2025-03-26',
      'a client pinned to a revision we implement should not be forced to renegotiate');
  });

  test('run_workflow is advertised as the destructive one', async () => {
    const { app } = appFor(TENANT_A);
    const { body } = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const byName = Object.fromEntries(body.result.tools.map(t => [t.name, t]));
    assert.equal(byName.run_workflow.annotations.readOnlyHint, false,
      'run_workflow sends messages and writes documents; a client that believes it is '
      + 'read-only will not gate it');
    assert.equal(byName.list_workflows.annotations.readOnlyHint, true);
  });
});
