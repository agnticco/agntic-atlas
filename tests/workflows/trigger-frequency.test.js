/**
 * "How often should this check?" — the user-facing frequency control
 * (operator's ask, 2026-07-24).
 *
 * The thing that must never regress: a change arriving inside the quiet window is
 * DEFERRED to the end of it, never DROPPED. Dropping would mean the record changed,
 * the workflow said it was live, and nothing ran — the exact silent failure this
 * whole area was just fixed for.
 *
 * The clock and the timer are injected so these run instantly. A test that waits a
 * real fifteen minutes is a test nobody runs.
 *
 *   node --test tests/workflows/trigger-frequency.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkEveryMinutes, minGapMs, pollIntervalMs, createRunGate,
  CHECK_EVERY_CHOICES, MIN_POLL_MINUTES,
} from '../../src/workflows/trigger-frequency.js';

// The gate starts a run on the microtask queue (so a throwing run can never take
// the caller down with it), so a test has to let the queue drain before asserting.
const flush = () => new Promise((r) => setImmediate(r));

// A fake clock: time only moves when a test moves it, and timers fire when due.
function fakeClock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const e = { fn, at: t + ms, cancelled: false }; timers.push(e); return e; },
    advance(ms) {
      t += ms;
      for (const e of [...timers]) if (!e.cancelled && e.at <= t) { e.cancelled = true; e.fn(); }
    },
  };
}

// ── Reading the setting ──────────────────────────────────────────────────────

test('an unset frequency means "as soon as it happens"', () => {
  assert.equal(checkEveryMinutes({ type: 'email' }), 0);
  assert.equal(checkEveryMinutes({ type: 'email', filter: {} }), 0);
  assert.equal(checkEveryMinutes(undefined), 0);
});

test('the setting is read from the trigger or from its filter', () => {
  assert.equal(checkEveryMinutes({ checkEvery: 15 }), 15);
  assert.equal(checkEveryMinutes({ filter: { checkEvery: 30 } }), 30, 'the builder writes trigger options into filter');
  assert.equal(checkEveryMinutes({ config: { checkEvery: 5 } }), 5);
});

test('a nonsense value falls back to no limit rather than stopping the workflow', () => {
  for (const bad of ['soon', -5, 0, null, NaN, {}]) {
    assert.equal(checkEveryMinutes({ checkEvery: bad }), 0,
      `"${String(bad)}" must not silently prevent the workflow from ever running`);
  }
});

test('an absurd value is clamped rather than accepted', () => {
  assert.equal(checkEveryMinutes({ checkEvery: 999_999 }), 7 * 24 * 60, 'capped at a week');
});

test('the offered choices are real minutes with a plain-language label', () => {
  assert.ok(CHECK_EVERY_CHOICES.length >= 4);
  for (const c of CHECK_EVERY_CHOICES) {
    assert.equal(typeof c.minutes, 'number');
    assert.ok(c.label && !/checkEvery|ms|interval/i.test(c.label), `"${c.label}" must read as English`);
  }
  assert.equal(CHECK_EVERY_CHOICES[0].minutes, 0, 'the default offered is "as soon as it happens"');
});

// ── Combining across triggers ────────────────────────────────────────────────

test('the fastest setting wins when a workflow has several triggers', () => {
  const wf = { triggers: [{ checkEvery: 60 }, { checkEvery: 5 }] };
  assert.equal(minGapMs(wf), 5 * 60_000, 'a limit on one trigger must not slow a different one down');
});

test('any trigger set to "as soon as it happens" removes the limit', () => {
  assert.equal(minGapMs({ triggers: [{ checkEvery: 60 }, { checkEvery: 0 }] }), 0);
});

test('only the triggers asked about are considered', () => {
  const wf = { triggers: [{ type: 'email', checkEvery: 30 }, { type: 'event', checkEvery: 5 }] };
  assert.equal(minGapMs(wf, { only: (t) => t.type === 'email' }), 30 * 60_000);
});

test('a workflow with no triggers is unlimited, not blocked', () => {
  assert.equal(minGapMs({ triggers: [] }), 0);
  assert.equal(minGapMs({}), 0);
});

test('a polled trigger can never be asked to check faster than the tick', () => {
  assert.equal(pollIntervalMs({ triggers: [{ checkEvery: 1 }] }), MIN_POLL_MINUTES * 60_000);
  assert.equal(pollIntervalMs({ triggers: [{ checkEvery: 0 }] }), 0, 'unset still means every tick');
  // Sub-minute is honourable for a PUSHED trigger and impossible for a polled one,
  // so the two must disagree here — this is the only case that proves the floor works.
  assert.equal(pollIntervalMs({ triggers: [{ checkEvery: 0.5 }] }), MIN_POLL_MINUTES * 60_000,
    'a mailbox cannot be checked twice a minute — raise it to the floor');
  assert.equal(minGapMs({ triggers: [{ checkEvery: 0.5 }] }), 30_000,
    'but a pushed trigger can honour it exactly, and must not be silently slowed to a minute');
});

// ── The gate: throttle without losing anything ───────────────────────────────

test('the first event runs immediately', async () => {
  const clock = fakeClock();
  const gate = createRunGate(clock);
  let runs = 0;
  const r = gate.request({ key: 'w1', gapMs: 15 * 60_000, run: () => { runs++; } });
  assert.equal(r.released, true);
  await r.promise;
  assert.equal(runs, 1);
});

test('with no limit set, every event runs immediately', async () => {
  const clock = fakeClock();
  const gate = createRunGate(clock);
  let runs = 0;
  for (let i = 0; i < 5; i++) await gate.request({ key: 'w1', gapMs: 0, run: () => { runs++; } }).promise;
  assert.equal(runs, 5);
});

test('an event inside the window is DEFERRED, not dropped', async () => {
  const clock = fakeClock();
  const gate = createRunGate(clock);
  const ran = [];

  gate.request({ key: 'w1', gapMs: 15 * 60_000, run: () => ran.push('first') });
  await flush();
  clock.advance(60_000);                                    // one minute later
  const second = gate.request({ key: 'w1', gapMs: 15 * 60_000, run: () => ran.push('second') });

  assert.equal(second.released, false);
  assert.equal(second.deferred, true, 'a change inside the window must still run eventually');
  assert.equal(second.waitMs, 14 * 60_000);
  assert.deepEqual(ran, ['first'], 'and it has not run yet — that is the throttle working');

  clock.advance(14 * 60_000);                               // window closes
  await flush();
  assert.deepEqual(ran, ['first', 'second'], 'the held change ran — nothing was lost');
});

test('several events inside one window collapse into a single later run', async () => {
  const clock = fakeClock();
  const gate = createRunGate(clock);
  const ran = [];

  gate.request({ key: 'w1', gapMs: 15 * 60_000, run: () => ran.push('first') });
  await flush();
  for (const label of ['a', 'b', 'c']) {
    clock.advance(60_000);
    const r = gate.request({ key: 'w1', gapMs: 15 * 60_000, run: () => ran.push(label) });
    assert.equal(r.deferred, true);
  }
  assert.equal(gate.pendingCount(), 1, 'one pending run, not three');

  clock.advance(15 * 60_000);
  await flush();
  assert.deepEqual(ran, ['first', 'c'], 'the newest work runs — it re-reads the source, so the gap is covered');
});

test('after the window passes, the next event runs immediately again', async () => {
  const clock = fakeClock();
  const gate = createRunGate(clock);
  const ran = [];
  await gate.request({ key: 'w1', gapMs: 15 * 60_000, run: () => ran.push(1) }).promise;
  clock.advance(15 * 60_000 + 1);
  const r = gate.request({ key: 'w1', gapMs: 15 * 60_000, run: () => ran.push(2) });
  assert.equal(r.released, true);
  await r.promise;
  assert.deepEqual(ran, [1, 2]);
});

test('a deferred run resets the clock, so the throttle holds across batches', async () => {
  const clock = fakeClock();
  const gate = createRunGate(clock);
  const ran = [];

  gate.request({ key: 'w1', gapMs: 10 * 60_000, run: () => ran.push('first') });
  await flush();
  clock.advance(60_000);
  gate.request({ key: 'w1', gapMs: 10 * 60_000, run: () => ran.push('deferred') });
  clock.advance(9 * 60_000);                                 // deferred one fires here
  await flush();
  assert.deepEqual(ran, ['first', 'deferred']);

  const next = gate.request({ key: 'w1', gapMs: 10 * 60_000, run: () => ran.push('third') });
  assert.equal(next.released, false, 'the gap is measured from the deferred run, not the first');
});

test('workflows throttle independently of each other', async () => {
  const clock = fakeClock();
  const gate = createRunGate(clock);
  const ran = [];
  await gate.request({ key: 'w1', gapMs: 15 * 60_000, run: () => ran.push('w1') }).promise;
  const other = gate.request({ key: 'w2', gapMs: 15 * 60_000, run: () => ran.push('w2') });
  assert.equal(other.released, true, 'one busy workflow must not throttle another');
  await other.promise;
  assert.deepEqual(ran, ['w1', 'w2']);
});

test('a failing run does not wedge the gate', async () => {
  const clock = fakeClock();
  const gate = createRunGate(clock);
  const r = gate.request({ key: 'w1', gapMs: 0, run: () => { throw new Error('boom'); } });
  await assert.rejects(() => r.promise);
  const next = gate.request({ key: 'w1', gapMs: 0, run: () => 'ok' });
  assert.equal(next.released, true);
  assert.equal(await next.promise, 'ok');
});
