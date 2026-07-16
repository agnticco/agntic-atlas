/**
 * Reasoning beat hub + SSE stream (P12 Increment #22).
 *
 * The converger narrates the WHY behind each step to the right-panel REASONING
 * surface. The build runs synchronously inside POST /sessions and each /respond;
 * this is a SEPARATE, purely additive SSE side-channel. This suite pins the
 * mechanism's contract:
 *
 *   HUB PRIMITIVES (narrate / openReasoningHub / closeReasoningHub):
 *     1. narrate buffers a beat AND emits it live to a subscriber,
 *     2. the buffer is capped (a long build cannot leak unbounded memory),
 *     3. closing a hub emits `end` and deletes the entry (no session leak),
 *     4. narrate to a closed/absent hub is a silent no-op (never throws),
 *     5. a malformed beat (no text / bad kind) is dropped / normalized,
 *     6. a beat for thread A never appears on thread B's hub (isolation).
 *
 *   SSE ENDPOINT (GET /api/builder/sessions/:id/reasoning):
 *     7. on connect it REPLAYS the current buffer, then STREAMS new beats,
 *     8. a caller from another tenant is refused (403) — no cross-tenant read,
 *     9. an unknown/finished thread gets a terminal `end` and closes (no storm).
 *
 * These are behavioural, line-independent: they assert what a subscriber RECEIVES,
 * not that a function ran.
 */

import { test, describe, before, after } from 'node:test';
import assert   from 'node:assert/strict';
import http     from 'node:http';
import express  from 'express';
import { EventEmitter } from 'node:events';

import {
  mountBuilderRoutes,
  reasoningHubs,
  openReasoningHub,
  narrate,
  closeReasoningHub,
  REASONING_BUFFER_CAP,
} from '../../src/api/builder.js';

// ── Hub primitives ────────────────────────────────────────────────────────────

describe('reasoning hub primitives', () => {
  test('narrate buffers a beat and emits it live', () => {
    const tid = 'build-tenantA-1';
    const hub = openReasoningHub(tid, { tenantId: 'tenantA', userId: 'u1' });
    const seen = [];
    hub.emitter.on('beat', (b) => seen.push(b));

    narrate(tid, { kind: 'read', text: 'Reading your tools' });
    narrate(tid, { kind: 'wire', text: 'Wired 3 steps', detail: 'trigger → summarize → deliver' });

    // Buffered for replay…
    assert.equal(hub.buffer.length, 2);
    assert.equal(hub.buffer[0].text, 'Reading your tools');
    assert.equal(hub.buffer[1].detail, 'trigger → summarize → deliver');
    // …and emitted live to the subscriber.
    assert.equal(seen.length, 2);
    assert.equal(seen[1].kind, 'wire');
    // Each beat carries a monotonic seq for SSE Last-Event-ID dedupe.
    assert.equal(seen[0]._seq, 1);
    assert.equal(seen[1]._seq, 2);

    closeReasoningHub(tid);
  });

  test('malformed beats are dropped or normalized, never thrown', () => {
    const tid = 'build-tenantA-2';
    const hub = openReasoningHub(tid, { tenantId: 'tenantA' });

    narrate(tid, null);                          // no beat
    narrate(tid, { kind: 'read' });              // no text → dropped
    narrate(tid, { kind: 'read', text: '   ' }); // blank → dropped
    narrate(tid, { kind: 'bogus', text: 'hi' }); // bad kind → normalized to 'read'
    narrate(tid, { kind: 'prose', text: '  keep me  ' });

    assert.equal(hub.buffer.length, 2);
    assert.equal(hub.buffer[0].kind, 'read');    // normalized
    assert.equal(hub.buffer[1].text, 'keep me'); // trimmed
    assert.equal(hub.buffer[1].kind, 'prose');

    closeReasoningHub(tid);
  });

  test('the buffer is capped at REASONING_BUFFER_CAP', () => {
    const tid = 'build-tenantA-3';
    const hub = openReasoningHub(tid, { tenantId: 'tenantA' });
    const N = REASONING_BUFFER_CAP + 50;
    for (let i = 0; i < N; i++) narrate(tid, { kind: 'read', text: 'beat ' + i });

    assert.equal(hub.buffer.length, REASONING_BUFFER_CAP);
    // It keeps the LAST N, so the oldest are dropped.
    assert.equal(hub.buffer[hub.buffer.length - 1].text, 'beat ' + (N - 1));
    assert.ok(hub.buffer[0].text !== 'beat 0');
    // seq keeps counting across the cap (never resets) so replay dedupe stays correct.
    assert.equal(hub.buffer[hub.buffer.length - 1]._seq, N);

    closeReasoningHub(tid);
  });

  test('closing a hub emits end and deletes the entry', () => {
    const tid = 'build-tenantA-4';
    const hub = openReasoningHub(tid, { tenantId: 'tenantA' });
    let ended = false;
    hub.emitter.on('end', () => { ended = true; });

    assert.ok(reasoningHubs.has(tid));
    closeReasoningHub(tid);
    assert.equal(ended, true);
    assert.equal(reasoningHubs.has(tid), false);
    // Second close is a harmless no-op.
    assert.doesNotThrow(() => closeReasoningHub(tid));
  });

  test('narrate to an absent/closed hub is a silent no-op', () => {
    assert.doesNotThrow(() => narrate('no-such-thread', { kind: 'read', text: 'x' }));
    const tid = 'build-tenantA-5';
    openReasoningHub(tid, { tenantId: 'tenantA' });
    closeReasoningHub(tid);
    assert.doesNotThrow(() => narrate(tid, { kind: 'read', text: 'after close' }));
  });

  test('thinking deltas keep RAW text (no trim) and carry streamId', () => {
    const tid = 'build-tenantA-think';
    const hub = openReasoningHub(tid, { tenantId: 'tenantA' });
    const seen = [];
    hub.emitter.on('beat', (b) => seen.push(b));

    // A discrete status beat is trimmed; a thinking delta must NOT be — inter-word
    // whitespace is meaningful when the tokens are reassembled on the client.
    narrate(tid, { kind: 'thinking', text: 'Looking at the ', streamId: 'g:7' });
    narrate(tid, { kind: 'thinking', text: 'connected tools', streamId: 'g:7' });
    narrate(tid, { kind: 'thinking', text: '   ', streamId: 'g:7' }); // whitespace-only → kept
    narrate(tid, { kind: 'thinking', text: '' });                     // truly empty → dropped

    assert.equal(hub.buffer.length, 3);
    assert.equal(hub.buffer[0].text, 'Looking at the ');   // trailing space preserved
    assert.equal(hub.buffer[2].text, '   ');               // whitespace-only delta kept
    assert.equal(hub.buffer[0].streamId, 'g:7');
    assert.equal(hub.buffer[1].kind, 'thinking');
    // Reassembling the deltas reproduces the raw thinking exactly.
    assert.equal(seen.map((b) => b.text).join(''), 'Looking at the connected tools   ');

    closeReasoningHub(tid);
  });

  test('a beat for thread A never reaches thread B (isolation)', () => {
    const a = openReasoningHub('build-tenantA-6', { tenantId: 'tenantA' });
    const b = openReasoningHub('build-tenantB-6', { tenantId: 'tenantB' });
    const aSeen = [], bSeen = [];
    a.emitter.on('beat', (x) => aSeen.push(x));
    b.emitter.on('beat', (x) => bSeen.push(x));

    narrate('build-tenantA-6', { kind: 'read', text: 'A only' });

    assert.equal(aSeen.length, 1);
    assert.equal(bSeen.length, 0);
    assert.equal(b.buffer.length, 0);

    closeReasoningHub('build-tenantA-6');
    closeReasoningHub('build-tenantB-6');
  });
});

// ── SSE endpoint (mounted on a real express app) ───────────────────────────────

// Minimal request-scoped auth stub: the SSE endpoint only reads req.tenant.id.
// The test drives identity via headers so a single mounted app can act as any tenant.
function tenantMiddleware(req, _res, next) {
  req.tenant = { id: req.headers['x-test-tenant'] || 'tenantA' };
  req.user   = { id: req.headers['x-test-user'] || 'u1' };
  next();
}

// Read an SSE response until `until(events)` is satisfied or a timeout fires,
// then resolve with the parsed data events. Non-destructive: does not require the
// stream to end.
function collectSSE(port, path, { tenant = 'tenantA', headers = {}, until, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let raw = '';
    const req = http.get({ port, path, headers: { 'x-test-tenant': tenant, ...headers } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve({ status: res.statusCode, events }); return; }
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        let idx;
        while ((idx = raw.indexOf('\n\n')) >= 0) {
          const frame = raw.slice(0, idx); raw = raw.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          const isEnd = frame.includes('event: end');
          // The terminal `end` frame is a control signal, not a beat — don't count it.
          if (dataLine && !isEnd) {
            const payload = dataLine.slice(5).trim();
            try { events.push(JSON.parse(payload)); } catch { /* heartbeat/comment */ }
          }
          if (isEnd) { req.destroy(); resolve({ status: 200, events, ended: true }); return; }
          if (until && until(events)) { req.destroy(); resolve({ status: 200, events }); return; }
        }
      });
      res.on('end', () => resolve({ status: 200, events, ended: true }));
    });
    req.on('error', () => resolve({ status: 200, events }));
    setTimeout(() => { req.destroy(); resolve({ status: 200, events, timedOut: true }); }, timeoutMs);
  });
}

describe('GET /api/builder/sessions/:id/reasoning (SSE)', () => {
  let server, port;

  before(async () => {
    const app = express();
    app.use(express.json());
    mountBuilderRoutes(app, {
      spine: {},
      requireActiveTenant: tenantMiddleware,
      requireAuth: tenantMiddleware,
    });
    await new Promise((resolve) => { server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  test('replays the buffer on connect, then streams new beats', async () => {
    const tid = 'build-tenantA-sse-1';
    openReasoningHub(tid, { tenantId: 'tenantA', userId: 'u1' });
    // Beats emitted BEFORE the subscriber connects (the first synchronous pass).
    narrate(tid, { kind: 'read', text: 'replay one' });
    narrate(tid, { kind: 'wire', text: 'replay two', detail: 'a → b' });

    const p = collectSSE(port, `/api/builder/sessions/${tid}/reasoning`, {
      tenant: 'tenantA',
      until: (evs) => evs.length >= 3,
    });
    // A live beat arrives after the connection is open.
    setTimeout(() => narrate(tid, { kind: 'check', text: 'live three' }), 150);

    const { status, events } = await p;
    assert.equal(status, 200);
    const texts = events.map((e) => e.text);
    assert.deepEqual(texts, ['replay one', 'replay two', 'live three']);
    assert.equal(events[1].detail, 'a → b');
    // The internal _seq is NOT leaked in the data payload (transport uses the id: line).
    assert.equal(events[0]._seq, undefined);

    closeReasoningHub(tid);
  });

  test('streams raw thinking deltas with their streamId', async () => {
    const tid = 'build-tenantA-sse-think';
    openReasoningHub(tid, { tenantId: 'tenantA' });
    narrate(tid, { kind: 'thinking', text: 'First, ', streamId: 'gen:3' });
    narrate(tid, { kind: 'thinking', text: 'the trigger.', streamId: 'gen:3' });

    const p = collectSSE(port, `/api/builder/sessions/${tid}/reasoning`, {
      tenant: 'tenantA', until: (evs) => evs.length >= 3,
    });
    setTimeout(() => narrate(tid, { kind: 'thinking', text: ' Then deliver.', streamId: 'gen:3' }), 120);

    const { status, events } = await p;
    assert.equal(status, 200);
    assert.deepEqual(events.map((e) => e.kind), ['thinking', 'thinking', 'thinking']);
    // Reassembling the streamed deltas reproduces the model's raw chain of thought.
    assert.equal(events.map((e) => e.text).join(''), 'First, the trigger. Then deliver.');
    assert.equal(events[0].streamId, 'gen:3');

    closeReasoningHub(tid);
  });

  test('refuses a caller from a different tenant (403)', async () => {
    const tid = 'build-tenantA-sse-2';
    openReasoningHub(tid, { tenantId: 'tenantA' });
    narrate(tid, { kind: 'read', text: 'secret' });

    const { status, events } = await collectSSE(port, `/api/builder/sessions/${tid}/reasoning`, {
      tenant: 'tenantB',
      timeoutMs: 800,
    });
    assert.equal(status, 403);
    assert.equal(events.length, 0);   // tenant B saw NONE of tenant A's beats

    closeReasoningHub(tid);
  });

  test('an unknown/finished thread gets a terminal end and closes', async () => {
    const { status, events, ended } = await collectSSE(port, '/api/builder/sessions/no-such/reasoning', {
      tenant: 'tenantA',
      timeoutMs: 1000,
    });
    assert.equal(status, 200);
    assert.equal(ended, true);        // closed, not left open to retry-storm
    assert.equal(events.length, 0);
  });

  test('Last-Event-ID replay skips already-seen beats (reconnect dedupe)', async () => {
    const tid = 'build-tenantA-sse-3';
    openReasoningHub(tid, { tenantId: 'tenantA' });
    narrate(tid, { kind: 'read', text: 'one' });   // _seq 1
    narrate(tid, { kind: 'read', text: 'two' });   // _seq 2
    narrate(tid, { kind: 'read', text: 'three' }); // _seq 3

    const { events } = await collectSSE(port, `/api/builder/sessions/${tid}/reasoning`, {
      tenant: 'tenantA',
      headers: { 'last-event-id': '2' },
      until: (evs) => evs.length >= 1,
      timeoutMs: 1000,
    });
    assert.deepEqual(events.map((e) => e.text), ['three']);

    closeReasoningHub(tid);
  });
});
