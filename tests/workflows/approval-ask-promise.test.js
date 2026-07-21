/**
 * An approval step's QUESTION is a message the promise checker can see.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 *
 * A `human` node sends a message — the question, over its own channels. The
 * promise checker could not see it: `satisfiesAssertion` went through
 * `nodeEffect()`, which returns null for `human`, so a promise like *"DM me
 * asking to approve"* could only ever be kept by a SEPARATE `deliver` node
 * duplicating the question.
 *
 * That left every approval workflow with two bad options and no good one:
 * fold the question into the approval step and fail to publish
 * (UNSATISFIED_ASSERTION), or keep a redundant delivery and message the person
 * TWICE. Observed live: the model spent its entire build budget negotiating
 * between the two ("deliver_slack_a1 is typed as a 'deliver' node in the
 * contract, so I need to keep it separate"), and the build died on the proxy's
 * 100-second ceiling with nothing saved.
 *
 * ── What must NOT regress ───────────────────────────────────────────────────
 *
 * This widens the go-live gate, so the narrowing is the load-bearing half and
 * most of the cases below are negative:
 *
 *   • `nodeEffect(human)` stays null — it feeds `isWriteNode`, and an approval
 *     step that counts as a write would gate approvals behind approvals.
 *   • A question creates no record and no document.
 *   • An `email` ask is a magic link from the PLATFORM mailer, not the tenant's
 *     Gmail connector — it satisfies nothing, by design.
 *   • Channels match WHOLE: one channel's connector with its OWN target.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  satisfiesAssertion, checkOutcome, nodeEffect,
} from '../../src/workflows/outcome-oracle.js';

const ask = (channels, extra = {}) => ({
  id: 'approve_send',
  type: 'human',
  config: {
    prompt: 'Approve this?',
    decisions: ['approve', 'reject'],
    channels,
    timeout: { after: '48h', then: 'reject' },
    ...extra,
  },
});

const msg = (target) => ({ id: 'a1', kind: 'message_sent', target });

describe('an approval question keeps a message promise', () => {
  test('a Slack ask satisfies a promise aimed at that Slack destination', () => {
    const node = ask([{ type: 'slack', target: 'charles@agntic.co' }]);
    assert.equal(satisfiesAssertion(msg('slack:charles@agntic.co'), node), true);
  });

  test('a #channel ask matches with or without the leading hash', () => {
    const node = ask([{ type: 'slack', target: '#ops' }]);
    assert.equal(satisfiesAssertion(msg('slack:ops'), node), true);
    assert.equal(satisfiesAssertion(msg('slack:#ops'), node), true);
  });

  test('an inbox ask satisfies an inbox promise — the inbox has no second address', () => {
    const node = ask([{ type: 'inbox' }]);
    assert.equal(satisfiesAssertion(msg('inbox:Approve this'), node), true);
    assert.equal(satisfiesAssertion(msg('inbox'), node), true);
  });

  test('a promise with no locator is satisfied by any ask to that connector', () => {
    const node = ask([{ type: 'slack', target: '#ops' }]);
    assert.equal(satisfiesAssertion(msg('slack'), node), true);
  });

  test('checkOutcome counts it as SATISFIED, not unsatisfied', () => {
    const outcome = { assertions: [msg('slack:charles@agntic.co')] };
    const { satisfied, unsatisfied, malformed } = checkOutcome(outcome, [
      ask([{ type: 'slack', target: 'charles@agntic.co' }]),
    ]);
    assert.equal(unsatisfied.length, 0);
    assert.equal(malformed.length, 0);
    assert.equal(satisfied.get(0)?.[0]?.id, 'approve_send');
  });
});

describe('the narrowing — what an approval question must NOT be allowed to claim', () => {
  test('a question is not a write: nodeEffect stays null', () => {
    // Load-bearing: nodeEffect feeds isWriteNode, which decides whether a
    // forwardable email approval may stand in front of a write. If a `human`
    // node became a write, approvals would gate approvals.
    assert.equal(nodeEffect(ask([{ type: 'slack', target: '#ops' }])), null);
  });

  test('a question creates no record and no document', () => {
    const node = ask([{ type: 'slack', target: '#ops' }]);
    assert.equal(satisfiesAssertion({ id: 'a1', kind: 'record_exists', target: 'slack:#ops' }, node), false);
    assert.equal(satisfiesAssertion({ id: 'a1', kind: 'document_exists', target: 'slack:#ops' }, node), false);
  });

  test('asking in one channel does not keep a promise about another', () => {
    const node = ask([{ type: 'slack', target: '#ops' }]);
    assert.equal(satisfiesAssertion(msg('slack:#customers'), node), false);
  });

  test('an emailed approval link satisfies nothing — it is not the Gmail connector', () => {
    const node = ask([{ type: 'email', target: 'bob@acme.com' }]);
    assert.equal(satisfiesAssertion(msg('gmail:bob@acme.com'), node), false);
    assert.equal(satisfiesAssertion(msg('email:bob@acme.com'), node), false);
  });

  test('channels match WHOLE — one channel\'s connector with its OWN target', () => {
    // Both channels here survive filtering, which is what makes this bite: if the
    // check asked "does ANY channel use Slack?" and then judged the target against
    // a DIFFERENT channel, the locator-free inbox would wave through a promise about
    // a Slack channel this spec never posts to.
    //
    // (An earlier version of this test paired slack with EMAIL and passed against a
    // deliberately pooled implementation — email is dropped before the match runs, so
    // it never exercised the property at all. Verified by mutation, not by reading.)
    const node = ask([
      { type: 'inbox' },
      { type: 'slack', target: '#ops' },
    ]);
    assert.equal(satisfiesAssertion(msg('slack:#customers'), node), false);
  });

  test('an inbox ask does not keep a promise about Slack', () => {
    assert.equal(satisfiesAssertion(msg('slack:#ops'), ask([{ type: 'inbox' }])), false);
  });

  test('an ask with no channels reaches nobody and keeps no promise', () => {
    assert.equal(satisfiesAssertion(msg('slack:#ops'), ask([])), false);
    assert.equal(satisfiesAssertion(msg('slack:#ops'), ask(undefined)), false);
  });

  test('a Slack ask with no target sends nowhere', () => {
    const node = ask([{ type: 'slack' }]);
    assert.equal(satisfiesAssertion(msg('slack:#ops'), node), false);
  });

  test('an unknown channel type is ignored, never treated as a wildcard', () => {
    const node = ask([{ type: 'carrier_pigeon', target: '#ops' }]);
    assert.equal(satisfiesAssertion(msg('slack:#ops'), node), false);
  });

  test('a malformed assertion is refused, not crashed on', () => {
    const node = ask([{ type: 'slack', target: '#ops' }]);
    assert.equal(satisfiesAssertion(null, node), false);
    assert.equal(satisfiesAssertion('nope', node), false);
  });
});
