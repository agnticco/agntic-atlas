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

  test('the example loop carries a pause forward even when it is not the LAST example', () => {
    // The loop used to hand `_applyTestResult` only the final example's data, so a
    // pause on any earlier example was silently dropped. `pausedData` must win.
    const src = readFileSync(HTML, 'utf8');
    assert.match(src, /if \(d\.paused && !pausedData\) pausedData = d;/,
      'the example loop no longer records a pause — a pause on an earlier example would be lost');
    assert.match(src, /Object\.assign\(\{\}, pausedData \|\| lastData,/,
      'the example loop no longer prefers the paused run when building its result');
  });
});
