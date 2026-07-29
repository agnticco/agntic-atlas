/**
 * AN EXAMPLE THAT SHOULD DO NOTHING IS NOT A BROKEN PROMISE.
 *
 * WITNESSED ON PROD, 2026-07-29. A pricing-enquiry workflow — Gmail → classify →
 * branch → draft → Slack approval → send, with a silent stop for anything that is
 * not a pricing enquiry. The test panel ran 12 examples. Ten were `kept`. The two
 * labelled "Non-pricing email — should not trigger workflow" were reported as
 * BROKEN PROMISES — for sending nothing, which is exactly and only what they were
 * supposed to do. `broke > 0` ⇒ 'failed' (run-summary.js), so it could not go live.
 *
 * THE CAUSE WAS EVALUATION ORDER:
 *
 *     !ran || broken || !contract.every(c => c.ok)  ? 'broken'
 *       : (negative ? 'not_exercised' : …)
 *
 * A negative that correctly delivers nothing fails its delivery assertions BY
 * DESIGN, so it short-circuited to 'broken' and never reached the branch written
 * for it. That branch was reachable only when a negative HAD delivered — the
 * opposite case. The file carries ~40 lines explaining how negatives must be
 * judged, and two prior fixes (2026-07-21, 2026-07-23) both changed WHICH samples
 * count as negative; neither touched WHEN the negative test is consulted.
 *
 * AND IT PUNISHED THE BETTER DESIGN. A workflow that filters at the TRIGGER lets
 * the negative sample through, delivers, satisfies its contract, and lands on
 * 'not_exercised' correctly. A workflow that classifies IN-FLOW and stops quietly
 * — the safer shape, and the one a person asks for — was the only one that failed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateExampleRun } from '../../src/workflows/outcome-oracle.js';
import { exampleVerdict } from '../../src/workflows/run-summary.js';

/** The contract the prod workflow carried. */
const SPEC = {
  outcome: {
    statement: 'When a pricing-related email arrives, AI drafts a reply, sends it to Charles '
             + 'via Slack DM for review, and — if Charles approves — sends it to the sender.',
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:hello@agntic.co' }],
  },
};

/** A run in which NOTHING was delivered — the quiet path taken correctly. */
const QUIET_RUN = { completed: true, error: null, deliveries: [], outputs: {} };
/** A run that did post to Slack. */
const DELIVERED_RUN = {
  completed: true, error: null, outputs: {},
  deliveries: [{ channel: 'slack', target: 'hello@agntic.co', delivered: true }],
};

const NEGATIVE = { id: 'e1', label: 'Non-pricing email — should not trigger workflow', shouldTrigger: false };
const POSITIVE = { id: 'e2', label: 'Direct pricing inquiry from prospect', shouldTrigger: true };

const judge = (example, run) => evaluateExampleRun(SPEC, example, run);

describe('the prod case', () => {
  test('a negative that stays quiet is NOT broken', () => {
    assert.equal(judge(NEGATIVE, QUIET_RUN).verdict, 'not_exercised');
  });

  test('and the panel reads it the same way', () => {
    // Two surfaces, one field. A fix that only the oracle agreed with would leave
    // the panel still showing a red row.
    assert.equal(exampleVerdict(judge(NEGATIVE, QUIET_RUN)), 'not_exercised');
  });

  test('so a run of 10 kept + 2 quiet negatives has NOTHING broken', () => {
    const results = [
      ...Array.from({ length: 10 }, () => judge(POSITIVE, DELIVERED_RUN)),
      judge(NEGATIVE, QUIET_RUN),
      judge(NEGATIVE, QUIET_RUN),
    ];
    const marks = results.map(exampleVerdict);
    assert.equal(marks.filter(m => m === 'broken').length, 0, 'this is what blocked go-live');
    assert.equal(marks.filter(m => m === 'kept').length, 10);
  });
});

describe('it did not become a way to hide failures', () => {
  test('a POSITIVE that delivers nothing is still broken', () => {
    // The entire point of the checker. If this ever returns not_exercised, a
    // workflow that silently does nothing certifies clean.
    assert.equal(judge(POSITIVE, QUIET_RUN).verdict, 'broken');
  });

  test('an example that declares NOTHING is judged on the contract, as before', () => {
    // Absent `shouldTrigger` and absent `expect` is not a negative — declaring
    // nothing must not become a way to opt out of the check.
    const undeclared = { id: 'e3', label: 'Some email' };
    assert.equal(judge(undeclared, QUIET_RUN).verdict, 'broken');
  });

  test('a negative that ERRORED is still broken', () => {
    // Excusing the contract result does not excuse a crash.
    assert.equal(judge(NEGATIVE, { completed: false, error: 'boom', deliveries: [] }).verdict, 'broken');
  });

  test('a negative whose content step emitted the error sentinel is still broken', () => {
    const contentErr = {
      completed: true, error: null, deliveries: [],
      steps: [{ nodeId: 'draft_reply', output: 'ERROR: required data not found' }],
    };
    assert.equal(judge(NEGATIVE, contentErr).verdict, 'broken');
  });

  test('negatives alone can never certify a workflow', () => {
    // not_exercised neither certifies nor blocks — the positives must carry it.
    const marks = [judge(NEGATIVE, QUIET_RUN), judge(NEGATIVE, QUIET_RUN)].map(exampleVerdict);
    assert.equal(marks.filter(m => m === 'kept').length, 0);
  });
});

describe('the older negative case still behaves', () => {
  test('a negative that DID deliver is not_exercised, not kept', () => {
    // The 2026-07-21/23 defect: the harness never fires the trigger, so a negative
    // runs and delivers like any other. It must not show a green tick reading
    // "should not fire".
    assert.equal(judge(NEGATIVE, DELIVERED_RUN).verdict, 'not_exercised');
  });

  test('the `expect: null` spelling is still honoured', () => {
    const older = { id: 'e4', label: 'Weekend — should not fire', expect: null };
    assert.equal(judge(older, QUIET_RUN).verdict, 'not_exercised');
  });

  test('the result still reports that it was a negative', () => {
    // run-summary reads `o.negative` to explain the row to the user.
    assert.equal(judge(NEGATIVE, QUIET_RUN).negative, true);
    assert.equal(judge(POSITIVE, DELIVERED_RUN).negative, false);
  });
});

describe('contractPassed is deliberately untouched', () => {
  test('the converger still sees the raw contract result', () => {
    // `verify` reads contractPassed to decide whether to rebuild. This fix changes
    // what the PERSON is told, not what drives a rebuild — flipping it here would
    // be the F17 regression (valid specs thrown away and rebuilt) through a new door.
    assert.equal(judge(NEGATIVE, QUIET_RUN).contractPassed, false);
  });
});
