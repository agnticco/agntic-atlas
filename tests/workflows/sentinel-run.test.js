/**
 * A scheduled run that delivered "I couldn't do my job" is not a success.
 *
 * ── The defect this pins (found in production data, 2026-07-21) ─────────────
 *
 * Every content llm node carries a guard the converger writes into it: if its
 * input is missing, output EXACTLY "ERROR: required data not found". The step
 * does not THROW, so the string flows on to the delivery and is sent verbatim,
 * and the run is recorded `success`.
 *
 * A live daily briefing did exactly that — and because it delivered INTO the same
 * inbox it reads, the next run picked up its own error mail as input, produced the
 * sentinel again, and sent it on. Verified from the run table: the run at
 * 21:33:25 delivered message `19f48ccd106eb4ba`, and the run at 21:33:31 fetched
 * `19f48ccd106eb4ba` as its input. Every run in that loop is stored `success`, so
 * the console's health score read 100%.
 *
 * The TEST panel has gated on this sentinel since Increment G. The SCHEDULER never
 * did — which is backwards: a test run is watched by a person, a 5am run is not.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runProducedContentError } from '../../src/workflows/outcome-oracle.js';

describe('the sentinel detector the scheduler now gates on', () => {
  test('catches the sentinel wherever it sits on the path to a delivery', () => {
    const hit = runProducedContentError({
      steps: [
        { nodeId: 'fetch', output: { messages: [] } },
        { nodeId: 'compile_briefing', output: 'ERROR: required data not found' },
        { nodeId: 'deliver', output: { messageId: 'abc' } },
      ],
    });
    assert.ok(hit, 'a run that delivered the sentinel was reported clean');
    assert.equal(hit.step, 'compile_briefing');
  });

  test('reads it out of an object output too, not just a bare string', () => {
    const hit = runProducedContentError({
      steps: [{ nodeId: 'compose', output: { text: 'ERROR: required data not found' } }],
    });
    assert.ok(hit);
    assert.equal(hit.step, 'compose');
  });

  test('a healthy run is untouched', () => {
    assert.equal(runProducedContentError({
      steps: [
        { nodeId: 'compile', output: 'Here is your briefing: 3 emails need a reply.' },
        { nodeId: 'deliver', output: { messageId: 'abc' } },
      ],
    }), null);
  });

  test('a genuine summary that merely mentions an error is NOT caught', () => {
    // The match is deliberately exact. A digest reporting on someone else's error
    // must not fail the run — that would be a false alarm on correct output, and
    // false alarms are how people learn to ignore the console.
    assert.equal(runProducedContentError({
      steps: [{ nodeId: 'compile', output: 'Two emails reported an ERROR in the billing export.' }],
    }), null);

    assert.equal(runProducedContentError({
      steps: [{ nodeId: 'compile', output: 'ERROR: the vendor API returned a 500.' }],
    }), null, 'a different ERROR: line was treated as the converger sentinel');
  });

  test('an empty or malformed run is not reported as an error', () => {
    assert.equal(runProducedContentError({ steps: [] }), null);
    assert.equal(runProducedContentError({}), null);
    assert.equal(runProducedContentError(null), null);
  });
});
