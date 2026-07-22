/**
 * DO NOT ASK A MODEL TO EXPLAIN A FAILURE THAT DID NOT HAPPEN.
 *
 * QA Manager re-measurement, 2026-07-22. The test panel said "Nothing broke, but
 * nothing was proved either" — the honest verdict for a run that executed cleanly
 * and never went down three of the workflow's four paths. Directly beneath it, the
 * chat said the workflow "failed when it tried to ask Charles for approval… got cut
 * off mid-message", and then, in a second paragraph, offered a DIFFERENT cause. Both
 * confident, both invented, both contradicting the panel two inches above.
 *
 * The cause was a lossy boundary, not a bad model. The panel computes three states —
 * passed / unverified / failed — and then sent the narrator `completed: <boolean>`,
 * so "proved nothing" arrived as FAILED with no error attached. The prompt asks for
 * "what went wrong". Given a failure and no facts, the model supplies facts.
 *
 * WHAT THESE PIN. The summary text is model-generated and cannot be asserted. What
 * CAN be asserted, and is the whole defect, is **what the narrator is told**:
 *  - an unverified run is never described to it as a failure;
 *  - it is given the real reason (which paths went untested), so it need not guess;
 *  - failure-only material (the error, the step count "before failure") is not
 *    attached to a run that did not fail — that is the raw material of the invention;
 *  - the instruction not to invent a cause is actually present;
 *  - a genuine failure still reads as one, and an older client that sends no verdict
 *    still works.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC  = readFileSync(path.join(ROOT, 'src/api/builder.js'), 'utf8');

/**
 * Execute the endpoint's real context-building source against a result payload.
 * Lifted from the file rather than re-implemented: a second copy of the branching
 * would pass while production kept sending the old string.
 */
function contextFor(result) {
  const start = SRC.indexOf('const { completed, steps = [], deliveries = [], output, error, uncoveredLanes');
  const end   = SRC.indexOf('const SYSTEM =', start);
  assert.ok(start > 0 && end > start,
    'the test-summary context builder moved — re-point this test, do not delete it');
  const body = SRC.slice(start, end);
  const fn = new Function('result', 'name', 'triggerLabel', 'nodeList',
    `${body}\nreturn { ctx, verdict };`);
  return fn(result, 'Triage', 'email', 'a → b');
}

const CLEAN_RUN = {
  completed: false, steps: [{ nodeId: 'a' }, { nodeId: 'b' }], deliveries: [], output: null,
  error: null,
};

describe('what the narrator is told about an unverified run', () => {
  test('it is NOT described as a failure', () => {
    const { ctx } = contextFor({ ...CLEAN_RUN, verdict: 'unverified', uncoveredLanes: ['urgent', 'approve'] });
    assert.match(ctx, /NOTHING BROKE/,
      'the run executed cleanly — calling it FAILED is what produced the invented cause');
    assert.doesNotMatch(ctx.split('\n')[3] ?? '', /^Result: FAILED$/);
  });

  test('it is given the real reason, so it does not have to guess', () => {
    const { ctx } = contextFor({ ...CLEAN_RUN, verdict: 'unverified', uncoveredLanes: ['urgent', 'approve'] });
    assert.match(ctx, /never went down these paths: urgent, approve/,
      'naming the untested paths is what replaces speculation with a fact');
  });

  test('with no examples at all it still gets a reason rather than silence', () => {
    const { ctx } = contextFor({ ...CLEAN_RUN, verdict: 'unverified', uncoveredLanes: [] });
    assert.match(ctx, /no worked example/i);
  });

  test('failure-only material is NOT attached to a run that did not fail', () => {
    const { ctx } = contextFor({
      ...CLEAN_RUN, verdict: 'unverified', uncoveredLanes: ['urgent'],
      error: 'connection reset',
    });
    assert.doesNotMatch(ctx, /connection reset/,
      'a stale error handed to the narrator is exactly the raw material it invented from');
    assert.doesNotMatch(ctx, /before failure/,
      '"completed 2 steps before failure" asserts a failure that did not occur');
  });
});

describe('the other two verdicts are unharmed', () => {
  test('a real failure still reads as one, with its error', () => {
    const { ctx, verdict } = contextFor({
      completed: false, verdict: 'failed', steps: [{ nodeId: 'a' }], deliveries: [],
      output: null, error: 'Slack unreachable', uncoveredLanes: [],
    });
    assert.equal(verdict, 'failed');
    assert.match(ctx, /Result: FAILED/);
    assert.match(ctx, /Slack unreachable/, 'a genuine failure must still carry its cause');
    assert.match(ctx, /before failure/);
  });

  test('a pass says the promises were KEPT, not merely that steps ran', () => {
    const { ctx } = contextFor({
      completed: true, verdict: 'passed', steps: [], deliveries: [], output: null,
      error: null, uncoveredLanes: [],
    });
    assert.match(ctx, /KEPT ITS PROMISES/);
  });

  test('an older client that sends no verdict still works', () => {
    assert.equal(contextFor({ completed: true,  steps: [], deliveries: [] }).verdict, 'passed');
    assert.equal(contextFor({ completed: false, steps: [], deliveries: [] }).verdict, 'failed');
  });
});

describe('the instruction that stops the invention is actually present', () => {
  test('the prompt forbids describing a cause when nothing went wrong', () => {
    const sys = SRC.slice(SRC.indexOf('const SYSTEM ='), SRC.indexOf('const raw = await withLLMRetry'));
    assert.match(sys, /NOTHING WENT WRONG/,
      'without this the model is asked "what went wrong" about a run that did not go wrong');
    assert.match(sys, /do not speculate about a cause/i);
  });
});

describe('the client sends the verdict it already computed', () => {
  test('the payload carries verdict and the uncovered lanes', () => {
    const html = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const i = html.indexOf("fetch('/api/builder/test-summary'");
    assert.ok(i > 0);
    const payload = html.slice(html.lastIndexOf('const payload = {', i), i);
    assert.match(payload, /verdict: verdict/,
      'the three-way verdict is computed ten lines above and was being discarded here');
    assert.match(payload, /uncoveredLanes:/);
  });
});
