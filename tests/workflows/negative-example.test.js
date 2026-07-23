/**
 * A "should not happen" example must never report as a promise KEPT.
 *
 * ── The defect this pins (found live, 2026-07-21) ───────────────────────────
 *
 * Generated sample sets routinely include a negative case:
 *
 *   { label: "Email without ATLASTEST in subject — should not trigger",
 *     given: {...}, expect: null }
 *
 * The test panel does not fire the TRIGGER — it seeds the workflow with `given`
 * and runs the steps. So the negative case ran like any other, DELIVERED like any
 * other, satisfied the delivery assertion, and came back `kept`: a green tick
 * reading "should not trigger", sitting directly under the words "every promise
 * held", moments after a real Slack DM had gone out for that very input.
 *
 * The row a reader would take as proof the workflow stays quiet was proof of the
 * opposite. Verified against the live database: the delivered body was
 * `*From:* team@company.com *Subject:* Weekly Standup Notes`, i.e. the negative
 * example's own data.
 *
 * ── The rule, and why it is not 'broken' ────────────────────────────────────
 *
 * Whether the workflow would have fired is a question about the trigger filter,
 * which this harness never evaluates — so the honest verdict is `not_exercised`.
 * Calling it `broken` would be the other wrong answer: the delivery happened
 * because the harness bypassed the trigger, not because the spec is wrong, and
 * resolving that pessimistically is what throws a valid spec into a rebuild loop
 * (F17). `not_exercised` neither certifies nor blocks, so the POSITIVE examples
 * still carry the workflow to a pass — pinned below, because a fix that silently
 * made every workflow unpublishable would be worse than the bug.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExampleRun } from '../../src/workflows/outcome-oracle.js';

const SPEC = {
  outcome: {
    statement: "When a Gmail message arrives with 'ATLASTEST' in the subject, send a Slack DM to charles@agntic.co.",
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:charles@agntic.co' }],
  },
  nodes: [
    { id: 'format', type: 'llm', config: { mode: 'freeform', prompt: 'x' } },
    { id: 'deliver_slack_a1', type: 'deliver', config: { channel: 'slack_dm', user: 'charles@agntic.co' } },
  ],
  edges: [{ from: 'format', to: 'deliver_slack_a1' }],
};

/** A run that DID deliver — what actually happens when the harness runs a negative case. */
const delivered = {
  completed: true,
  deliveries: [{ delivered: true, channel: 'slack_dm', target: 'charles@agntic.co' }],
  steps: [
    { nodeId: 'format', output: '*From:* team@company.com\n*Subject:* Weekly Standup Notes' },
    { nodeId: 'deliver_slack_a1', output: { delivered: true, channel: 'slack_dm', target: 'charles@agntic.co' } },
  ],
};

const NEGATIVE = { id: 'e3', label: 'Email without ATLASTEST in subject — should not trigger', given: { from: 'team@company.com', subject: 'Weekly Standup Notes' }, expect: null };
// THE CURRENT GENERATOR ENCODING (2026-07-23): a negative case as `shouldTrigger:false`
// with an empty `expect: {}` — NOT `expect: null`. This is the exact shape the QA found
// certified as `kept` in a live scheduled fan-out. Pinned against what the generator
// PRODUCES NOW, so the detector cannot drift out from under it again.
const NEGATIVE_ST = { id: 'e2', label: 'Weekend trigger (should not fire)', given: {}, expect: {}, shouldTrigger: false };
const POSITIVE = { id: 'e1', label: 'Standard ATLASTEST email', given: { from: 'a@b.com', subject: 'ATLASTEST: Q4' }, expect: { channel: 'slack_dm' }, shouldTrigger: true };

describe('a negative example is never certified', () => {
  test('it is NOT reported as kept, even though the run delivered', () => {
    const r = evaluateExampleRun(SPEC, NEGATIVE, delivered);
    assert.notEqual(r.verdict, 'kept', 'a "should not trigger" case was certified as a kept promise');
    assert.equal(r.verdict, 'not_exercised');
    assert.equal(r.negative, true);
  });

  test('the CURRENT encoding (shouldTrigger:false, expect:{}) is caught — the drift the QA found', () => {
    // `expect: {}` is not `null`, so the original expect-only check MISSED this and
    // certified it `kept` in a live build. Keyed on `shouldTrigger` now.
    const r = evaluateExampleRun(SPEC, NEGATIVE_ST, delivered);
    assert.equal(r.verdict, 'not_exercised',
      'a "should not fire" row was certified as a kept promise — the 07-21 defect through a drifted encoding');
    assert.equal(r.negative, true);
  });

  test('it is not called BROKEN either — that is the other wrong answer', () => {
    // The delivery happened because the harness skipped the trigger, not because
    // the spec is wrong. Failing it here is what sends a valid spec into a rebuild loop.
    assert.equal(evaluateExampleRun(SPEC, NEGATIVE, delivered).verdict, 'not_exercised');
  });

  test('a genuinely failing run is still BROKEN, negative or not', () => {
    // The fix must not become a blanket excuse: if the run itself fell over, that
    // is a real failure and must still read as one.
    const failed = { completed: false, deliveries: [], steps: [], error: 'boom' };
    assert.equal(evaluateExampleRun(SPEC, NEGATIVE, failed).verdict, 'broken');
  });
});

describe('the fix must not make workflows unpublishable', () => {
  test('a positive example still reports as kept', () => {
    const r = evaluateExampleRun(SPEC, POSITIVE, delivered);
    assert.equal(r.verdict, 'kept');
    assert.equal(r.negative, false);
  });

  test('the client rule: one kept + one not-exercised still passes', () => {
    // Mirrors public/index.html: passed = !anyBroken && anyKept && !lanesMissing.
    // If this were false, every workflow with a negative sample would be blocked —
    // a worse bug than the one being fixed.
    const results = [
      evaluateExampleRun(SPEC, POSITIVE, delivered),
      evaluateExampleRun(SPEC, NEGATIVE, delivered),
    ];
    const vOf = o => o.verdict || (o.contractPassed ? 'kept' : 'broken');
    const anyBroken = results.some(o => vOf(o) === 'broken');
    const anyKept   = results.some(o => vOf(o) === 'kept');
    assert.equal(anyBroken, false);
    assert.equal(anyKept, true, 'nothing certified — the workflow could never be published');
  });

  test('an example with no `expect` key at all is unaffected', () => {
    // Absent ≠ explicitly null. Only an example that DECLARES nothing should
    // happen is treated as negative; a sample that simply omitted `expect` is
    // judged on its contract exactly as before.
    const noExpect = { id: 'e4', label: 'No expect key', given: { subject: 'ATLASTEST' } };
    assert.equal(evaluateExampleRun(SPEC, noExpect, delivered).verdict, 'kept');
  });

  test('a positive with shouldTrigger:true stays KEPT', () => {
    const r = evaluateExampleRun(SPEC, POSITIVE, delivered);
    assert.equal(r.verdict, 'kept');
    assert.equal(r.negative, false, 'a shouldTrigger:true case is a positive — never demoted');
  });

  test('an EMPTY expect on a positive is NOT treated as negative (F17 boundary)', () => {
    // A sparsely-specified positive (empty `expect`, no shouldTrigger:false) must not
    // be demoted to not_exercised — that would make valid workflows uncertifiable, the
    // regression the whole fix is scoped to avoid. Only shouldTrigger:false or a null
    // expect is negative; a bare empty object is neither.
    const sparsePositive = { id: 'e5', label: 'Sparse positive', given: { subject: 'ATLASTEST' }, expect: {} };
    assert.equal(evaluateExampleRun(SPEC, sparsePositive, delivered).verdict, 'kept',
      'demoting an empty-expect positive would trade the blocker for an F17 regression');
  });
});
