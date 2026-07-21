/**
 * A slow build must not be cut by the proxy — and must not lie when it fails.
 *
 * Cloudflare kills any request that stays SILENT for ~100s (524). It is not a
 * limit on how LONG a request runs: `/reasoning` heartbeats every 15s and was
 * observed alive at 227s through the same tunnel, returning 200. Building an
 * approval-gate workflow genuinely exceeds 100s of model work, so it died at the
 * proxy three times running with the whole build discarded.
 *
 * The fix drips whitespace while the handler works. These tests pin the three
 * properties that make that safe:
 *
 *   1. A FAST response is untouched — no drip, and a real status code.
 *   2. A SLOW response stays parseable — leading whitespace is insignificant JSON.
 *   3. A slow FAILURE still reads as a failure. Once bytes are on the wire the
 *      status is locked at 200, so the error has to travel in the BODY. If the
 *      client trusted the status it would treat the failure as a successful build
 *      and hand `{error}` to a handler that ignores it — a silent dead end, which
 *      is the exact failure class this codebase keeps re-learning.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// The REAL implementation the routes use — not a copy. A copy here would be a
// test of a program nobody runs.
import { keepAlive } from '../../src/api/keep-alive.js';

/** Minimal express-like response that records what actually went on the wire. */
function fakeRes() {
  const r = {
    headers: {}, chunks: [], statusCode: null, jsonBody: undefined,
    writableEnded: false, _handlers: {},
    setHeader(k, v) { this.headers[k] = v; },
    flushHeaders() { this.flushed = true; },
    write(s) { this.chunks.push(s); return true; },
    end() { this.writableEnded = true; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.jsonBody = o; this.writableEnded = true; return this; },
    on(ev, fn) { this._handlers[ev] = fn; },
  };
  /** Everything written to the socket, as the client would receive it. */
  r.wire = () => r.chunks.join('');
  return r;
}

const tick = (ms) => new Promise(r => setTimeout(r, ms));

describe('a fast response is left completely alone', () => {
  test('no bytes are dripped and the real status code survives', async () => {
    const res = fakeRes();
    const alive = keepAlive(res, { after: 50 });
    alive.send({ threadId: 't1' });                 // answers immediately

    assert.equal(alive.committed(), false);
    assert.equal(res.wire(), '');                    // nothing dripped
    assert.deepEqual(res.jsonBody, { threadId: 't1' });
    await tick(120);                                 // the timer must not fire later
    assert.equal(res.wire(), '');
  });

  test('a fast FAILURE still gets its real status code', async () => {
    const res = fakeRes();
    const alive = keepAlive(res, { after: 50 });
    alive.send({ error: 'nope' }, 500);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.jsonBody, { error: 'nope' });
  });
});

describe('a slow response is kept alive and stays parseable', () => {
  test('whitespace is dripped, and the client can still parse the body', async () => {
    const res = fakeRes();
    const alive = keepAlive(res, { after: 20 });
    await tick(75);                                  // outlive several heartbeats
    assert.equal(alive.committed(), true);
    assert.ok(res.chunks.length >= 2, `expected drips, got ${res.chunks.length}`);

    alive.send({ threadId: 't2', interrupt: { type: 'plan_review' } });

    // This is the whole trick: leading whitespace is insignificant JSON.
    const parsed = JSON.parse(res.wire());
    assert.equal(parsed.threadId, 't2');
    assert.equal(parsed.interrupt.type, 'plan_review');
    assert.equal(res.writableEnded, true);
  });

  test('the drip stops once the answer is sent', async () => {
    const res = fakeRes();
    const alive = keepAlive(res, { after: 20 });
    await tick(50);
    alive.send({ ok: true });
    const settled = res.wire();
    await tick(60);
    assert.equal(res.wire(), settled, 'kept writing after the response ended');
  });

  test('the drip stops when the client disconnects', async () => {
    const res = fakeRes();
    const alive = keepAlive(res, { after: 20 });
    try {
      await tick(50);
      const before = res.chunks.length;
      res._handlers.close?.();                       // browser went away
      await tick(60);
      assert.equal(res.chunks.length, before, 'kept writing to a closed socket');
    } finally {
      // Belt and braces: if the close handler is ever dropped, this stops the
      // interval anyway so the failure surfaces as a RED TEST rather than as a
      // test run that hangs forever and has to be killed.
      alive.stop();
    }
  });

  test('the drip stops if the response is ended by some other path', async () => {
    // `send()` always clears the timer, so this guard only earns its keep when
    // something else finishes the response — an express error handler, a client
    // abort. Without it the timer keeps writing to a dead socket.
    const res = fakeRes();
    const alive = keepAlive(res, { after: 20 });
    try {
      await tick(50);
      const before = res.chunks.length;
      res.writableEnded = true;                      // ended elsewhere; timer still live
      await tick(60);
      assert.equal(res.chunks.length, before, 'kept writing after the response ended');
    } finally {
      alive.stop();
    }
  });

  test('the DEFAULT silence window is long enough that normal replies never drip', async () => {
    // Pins the default itself. Every other test passes `after` explicitly, so a
    // default of 0 — which would strip the real status code off every fast
    // response in the app — would otherwise go unnoticed.
    const res = fakeRes();
    const alive = keepAlive(res);                    // no options: production behaviour
    try {
      await tick(120);
      assert.equal(alive.committed(), false, 'dripped within 120ms — the default window is far too short');
      assert.equal(res.wire(), '');
    } finally {
      alive.stop();
    }
  });
});

describe('a slow FAILURE must not read as success', () => {
  test('the error travels in the body once the status is locked at 200', async () => {
    const res = fakeRes();
    const alive = keepAlive(res, { after: 20 });
    await tick(50);
    assert.equal(alive.committed(), true);

    alive.send({ error: 'Atlas hit a snag finishing that step.' }, 500);

    // The 500 is unavailable — headers are long gone. What matters is that the
    // failure is still legible to the client.
    assert.equal(res.statusCode, null);
    const parsed = JSON.parse(res.wire());
    assert.equal(parsed.error, 'Atlas hit a snag finishing that step.');
    assert.equal(parsed.threadId, undefined);
  });

  test('the client rule: a body-level error is an error whatever the status says', () => {
    // Mirrors the guard added at both call sites in public/index.html. Status
    // alone would call this a success and hand `{error}` to _handleInterrupt,
    // which ignores an object with no `type` — the build appears to hang forever.
    const looksOk = (r) => !(!r.ok || (r.data && r.data.error));

    assert.equal(looksOk({ ok: true,  data: { threadId: 't' } }), true);
    assert.equal(looksOk({ ok: true,  data: { error: 'boom' } }), false);
    assert.equal(looksOk({ ok: false, data: { error: 'boom' } }), false);
  });
});
