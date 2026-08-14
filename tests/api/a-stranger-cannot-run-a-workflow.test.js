/**
 * A STRANGER CANNOT MAKE THIS SERVER DO WORK.
 *
 * ── What was measured (2026-08-14, pre-release security review) ──────────────
 *
 * `POST /workflows/run` executes a workflow spec handed to it IN THE REQUEST
 * BODY — it does not load a stored workflow, it runs whatever you send. It sat
 * behind `optionalAuth`, so on any Atlas reachable from the internet an anonymous
 * stranger could POST a spec and have the server run it. This was not reasoned
 * about; it was exploited against a real server, twice:
 *
 *   1. an unauthenticated curl with a `web_fetch` step returned
 *      `{"completed":true,"clean":true,...,"title":"Example Domain"}` — the server
 *      fetched a URL and handed back the page. An open proxy wearing the
 *      operator's IP address.
 *   2. an unauthenticated curl with an `llm` step reached the Anthropic API on the
 *      DEPLOYMENT'S OWN KEY, and failed only because the test key was deliberately
 *      fake (`401 authentication_error`). With a real key that is a stranger
 *      spending the operator's money.
 *
 * AND THE SPEND CEILING COULD NOT HELP. `tenantGuard` opens with
 * `if (!tenantId) return next()` — correct for a guard that scopes per tenant, and
 * it means an anonymous run had no daily USD limit at all. The one caller who
 * could not be billed was also the one caller who could not be capped.
 *
 * Both routes now require an authenticated session in an active workspace.
 * Nothing legitimate was lost: the test panel that calls this runs in a signed-in
 * browser, and the scheduler enters the engine directly rather than over HTTP.
 * The full suite stayed green on the change — 2,547 passing, nothing adjusted.
 *
 * ── Why this test boots the real server ──────────────────────────────────────
 *
 * A source-level assertion that the word `requireActiveTenant` appears next to the
 * route would pass against a middleware that had been quietly neutered, and this
 * is the wrong finding to discover by reading. The tests below send real HTTP to a
 * real app and assert the status code, which is the thing an attacker experiences.
 *
 * ── Mutations, run by hand (2026-08-14) ──────────────────────────────────────
 *
 *   M1  restore `optionalAuth` on POST /workflows/run   → 3 red
 *   M2  restore `optionalAuth` on GET  /workflows/run/:jobId → 1 red
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { isolateSpineStorage } from '../helpers/isolated-spine-env.js';

let spine, server, base, storage;

/** A spec that genuinely does work, so a pass cannot be an accident of validation. */
const WORKING_SPEC = {
  name: 'anonymous probe',
  nodes: [
    { id: 'f', type: 'connector-action', config: { action: 'web_fetch', url: 'https://example.com' } },
    { id: 'd', type: 'deliver', config: { channel: 'webhook', url: 'https://example.com/sink' } },
  ],
  edges: [{ from: 'f', to: 'd' }],
  triggers: [{ type: 'manual' }],
};

before(async () => {
  // EVERY durable path, not the obvious subset. Overriding only some of them left
  // this suite sharing SQLite files with the other spine-booting suites running
  // concurrently, and the symptom was the whole FILE being cancelled on CI before
  // any test in it ran — which reads as a failing security test when nothing had
  // actually been tested. See the helper's header.
  storage = isolateSpineStorage('anon-run');

  const { bootSpine, createApp } = await import('../../src/api/server.js');
  spine = await bootSpine();
  const app = createApp(spine);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try { server?.close(); } catch { /* ignore */ }
  try { spine?.close(); } catch { /* ignore */ }
  try { await spine?.disposeModels?.(); } catch { /* ignore */ }
  storage?.cleanup();
});

const anon = (method, path, body) => fetch(base + path, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

describe('an unauthenticated caller cannot execute a workflow', () => {
  test('POST /workflows/run is refused outright', async () => {
    const res = await anon('POST', '/workflows/run', { spec: WORKING_SPEC, dryRunDeliveries: true });
    assert.equal(res.status, 401, 'an anonymous run must be refused, not executed');
  });

  test('and nothing was executed — no run result comes back', async () => {
    const res = await anon('POST', '/workflows/run', { spec: WORKING_SPEC, dryRunDeliveries: true });
    const body = await res.json().catch(() => ({}));
    // The exploit's tell was `completed: true` with the fetched page in `output`.
    assert.notEqual(body.completed, true, 'a refused request must not report a completed run');
    assert.equal(body.output, undefined, 'a refused request must return no workflow output');
  });

  test('backgrounding is not a way around it', async () => {
    // `background: true` takes a different branch inside the route. It must sit
    // behind the SAME guard — a second path is how halves of this system drift.
    const res = await anon('POST', '/workflows/run', {
      spec: WORKING_SPEC, dryRunDeliveries: true, background: true,
    });
    assert.equal(res.status, 401, 'the background branch must be guarded too');
    const body = await res.json().catch(() => ({}));
    assert.equal(body.jobId, undefined, 'no job may be created for an anonymous caller');
  });

  test('and the job-poll route does not let a stranger probe job ids', async () => {
    const res = await anon('GET', '/workflows/run/run-anything');
    assert.equal(res.status, 401, 'polling must require a session before any id is looked up');
  });
});

describe('the refusal is authentication, not a broken route', () => {
  test('the server is up and answering on an unauthenticated route', async () => {
    // Guards against the whole block passing because the app failed to boot: if
    // /health did not answer, the 401s above would prove nothing at all.
    const res = await anon('GET', '/health');
    assert.equal(res.status, 200, 'the app under test must actually be running');
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.engine, 'ok', 'the engine must be wired, so a run COULD have happened');
  });
});
