/**
 * AN APPROVAL WORKFLOW COULD NOT BE TESTED — the panel hung on "Testing…" forever.
 *
 * A spec with an approval step stops at the gate on the test path, and the server
 * reports that correctly (`paused:true`). `_applyTestResult` has a branch for it,
 * and that branch read `runDurationMs` — a `const` declared ~40 lines BELOW it in
 * the same function. So every paused run hit the temporal dead zone and threw
 * `ReferenceError: Cannot access 'runDurationMs' before initialization`, from
 * inside the animation interval, after that interval had already been cleared.
 * Nothing caught it: the panel sat on "Testing…" with a frozen timer, a body still
 * reading "not yet run", and no way out but a page reload. Go live never unlocked,
 * so NO workflow containing an approval step could be published.
 *
 * WHY IT LOOKS LIKE THIS. Same reason as test-panel-certification.test.js: the rule
 * lives in a 7000-line browser file with no module boundary, so there is nothing to
 * import. A grep for `d.paused` would have passed against the broken code — the
 * branch was there, it just threw. So this EXECUTES the real method source against
 * a real paused payload. The extraction is fail-loud: if the method is renamed or
 * removed the test FAILS rather than quietly proving nothing.
 *
 * Watched go red: reverting the declaration to its old position makes both tests
 * below throw the ReferenceError.
 */

import { test, describe } from 'node:test';
import assert   from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html');

/** Compile the real `_applyTestResult` onto a stub component. Fail-loud. */
function panel() {
  const src = readFileSync(HTML, 'utf8');
  const start = src.indexOf('  _applyTestResult(r, d) {');
  assert.notEqual(start, -1,
    '`_applyTestResult` is GONE from public/index.html. If it moved or was renamed, ' +
    're-point this extraction; do not delete the test.');

  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, 'could not find the end of `_applyTestResult`');

  const obj = eval('({ ' + src.slice(start, end) + ' })');
  obj.state = { spec: { outcome: { assertions: [{ id: 'a1' }], examples: [{ id: 'e1' }] } } };
  obj._testStartMs = Date.now() - 4200;
  obj.setState = (s) => { obj._captured = Object.assign(obj._captured || {}, s); };
  return obj;
}

const PAUSED = {
  paused: true,
  completed: false,
  awaiting: { nodeId: 'approval', prompt: 'Send this reply?' },
  note: 'The test ran up to your approval step and stopped there.',
  steps: [{ nodeId: 'draft' }, { nodeId: 'approval' }],
};

describe('the test panel on a paused (approval-gated) run', () => {
  test('a paused run resolves — it does not throw and leave the panel spinning', () => {
    const p = panel();
    p._applyTestResult({ ok: true }, PAUSED);   // threw ReferenceError before the fix
    assert.equal(p._captured.testState, 'paused',
      'a paused run must land in testState "paused" — anything else leaves the panel in "running"');
  });

  test('a paused run reports its real duration, not undefined', () => {
    const p = panel();
    p._applyTestResult({ ok: true }, PAUSED);
    assert.equal(typeof p._captured.runDurationMs, 'number');
    assert.ok(p._captured.runDurationMs >= 4000,
      'the elapsed time must be the real wall clock, so the panel timer does not read frozen');
  });

  test('"paused" is NOT "passed" — an unexercised gate must never unlock Go live', () => {
    const p = panel();
    p._applyTestResult({ ok: true }, PAUSED);
    assert.notEqual(p._captured.testState, 'passed',
      'the steps after an approval gate were never run, so nothing past it can be certified');
  });

  test('the test NEVER pauses — it pre-answers every gate and exercises BOTH lanes', () => {
    // BEHAVIOUR CHANGE (2026-07-24, operator). Pressing Run test now authorizes the
    // whole run: `runTest` supplies each `human` gate's decision UP FRONT (`decisions`
    // in the body) so the run completes instead of pausing, and it runs a gate-reaching
    // example ONCE PER ANSWER (approve-all, then reject-all) so the reject path is
    // actually PROVEN, not assumed. The old "queue every pause and make the tester click
    // Approve/Reject one at a time" flow is gone, and so is its evidence-carrying dance.
    const src = readFileSync(HTML, 'utf8');
    // The new mechanism: a per-pass decision map + a driver that runs the extra
    // (reject) pass only when the example actually reached a gate.
    assert.match(src, /decisionMapForPass/,
      'runTest no longer builds a per-pass gate-decision map — gates cannot be pre-answered');
    assert.match(src, /decisions: decisions/,
      'runTest no longer sends a pre-answered `decisions` map, so the run would still pause at a gate');
    assert.match(src, /const gates = \(S\.spec\.nodes \|\| \[\]\)\.filter/,
      'runTest no longer enumerates the spec\'s human gates');
    // The old pause QUEUE must be gone: no queued answerable pauses surfaced to the user.
    assert.doesNotMatch(src, /pausedRuns\.push\(/,
      'the old answerable-pause QUEUE is still present — the test should never surface a pause to the tester now');
    // And the in-panel Approve/Reject buttons must no longer be offered.
    assert.match(src, /showPauseAnswers: false/,
      'the in-panel Approve/Reject buttons are still offered — a test must not ask the tester to answer a gate');
  });
});
