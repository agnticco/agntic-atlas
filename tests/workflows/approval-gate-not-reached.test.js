/**
 * A CONDITIONAL promise gated on a DOWNSTREAM branch a sample never reached.
 *
 * THE LIVE BUG this pins (found by the QA Manager driving the canonical
 * classify→approve workflow, 2026-07-23): a workflow classifies mail urgent /
 * normal / spam, ignores spam, and — on the urgent lane — asks a person to approve
 * before saving. Its contract carries `{ kind:'record_exists', when:'approve' }`,
 * gated on the APPROVAL branch, which lives inside the urgent lane. A SPAM sample
 * never reaches that branch (it stops), so the approval branch's source node never
 * runs and its route is unread.
 *
 * Before the fix, `assertionApplicability` treated "this branch's route is unread"
 * as DOUBT and enforced the promise anyway → the spam sample "failed" a promise
 * about approved mail → the converger's self-test (`verify`) read that as a
 * structural delivery failure and REBUILT the spec, corrupting the classifier to
 * forward spam so the delivery would fire. ~23 minutes and a workflow that did the
 * opposite of "ignore spam".
 *
 * The fix (outcome-oracle.js: runRouteInfo records `reached`; assertionApplicability
 * enforces on doubt ONLY for a branch that actually RAN): a never-reached gate's
 * promise does not apply — SKIP, not enforce.
 *
 * MUTATION: delete the `b.reached &&` guard in assertionApplicability's branchRoutes
 * enforce condition → the spam sample enforces the approval promise → contractPassed
 * flips to false → the first test here goes RED. (Watched red→green.)
 *
 * ANTI-WEAKENING (the reason this is not just a loosening): a REAL miss on the lane
 * that WAS reached still fails (urgent+approve with no delivery), and a REJECT still
 * skips (silence is not a kept promise) — so the fix cannot mask a broken approve lane.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { evaluateExampleRun } from '../../src/workflows/outcome-oracle.js';

// classify(urgent/normal/spam) → b1; urgent lane holds a NESTED approval branch (b2);
// normal lane delivers to the inbox; spam stops. The `approve` promise is gated on b2,
// which a spam or normal sample never reaches.
function triageWithApproval() {
  return {
    version: 2,
    name: 'Inbound triage with approval',
    outcome: {
      statement: 'Normal mail is summarised to the inbox; urgent mail is saved only after I approve it; spam is ignored.',
      assertions: [
        { id: 'a_norm', kind: 'message_sent', target: 'inbox:Summary', when: 'normal'  },
        { id: 'a_appr', kind: 'message_sent', target: 'inbox:Summary', when: 'approve' },
      ],
    },
    triggers: [{ type: 'email', filter: 'is:unread' }],
    nodes: [
      { id: 'classify', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'urgent\nnormal\nspam', instructions: 'Sort the message.' } },
      { id: 'b1', type: 'branch', label: 'Route by category',
        config: { on: 'classify.output', cases: [
          { when: 'urgent', to: 'draft' },
          { when: 'normal', to: 'summ' },
          { when: '*',      to: 'stop_spam' },
        ] } },
      // urgent lane: draft → ask a person → route on their answer
      { id: 'draft', type: 'llm', label: 'Draft', config: { mode: 'rewrite', instructions: 'Prepare it.' } },
      { id: 'ask', type: 'human', label: 'Approve', config: { prompt: 'Save this?', decisions: ['approve', 'reject'], timeout: { after: '1d' } } },
      { id: 'b2', type: 'branch', label: 'Route by approval',
        config: { on: '{{ask.decision}}', cases: [
          { when: 'approve', to: 'save_appr' },
          { when: '*',       to: 'stop_rej' },
        ] } },
      { id: 'save_appr', type: 'deliver', label: 'Save (approved)', config: { channel: 'inbox_deliver', subject: 'Summary' } },
      { id: 'stop_rej',  type: 'assemble', label: 'Stop — rejected', config: {} },
      // normal lane
      { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize', instructions: 'One line.' } },
      { id: 'save_norm', type: 'deliver', label: 'Save (normal)', config: { channel: 'inbox_deliver', subject: 'Summary' } },
      // spam lane
      { id: 'stop_spam', type: 'assemble', label: 'Stop — spam', config: {} },
    ],
    edges: [
      { from: 'classify', to: 'b1' },
      { from: 'b1', to: 'draft' }, { from: 'b1', to: 'summ' }, { from: 'b1', to: 'stop_spam' },
      { from: 'draft', to: 'ask' }, { from: 'ask', to: 'b2' },
      { from: 'b2', to: 'save_appr' }, { from: 'b2', to: 'stop_rej' },
      { from: 'summ', to: 'save_norm' },
    ],
  };
}

const inboxDelivery = { delivered: true, channel: 'inbox_deliver', subject: 'Summary' };
const byId = (r, id) => r.contract.find(c => c.id === id);

// Mirror the engine: only EXECUTED nodes appear in steps (a skipped node emits
// step_skipped, which the dry-run does not push), and a delivery rides on its node.
function spamRun() {
  return { completed: true, error: null, deliveries: [],
    steps: [
      { nodeId: 'classify', output: 'spam' },
      { nodeId: 'b1', output: { value: 'spam', matched: '*', to: 'stop_spam' } },
      { nodeId: 'stop_spam', output: { done: true } },
    ] };
}
function normalRun(deliver = true) {
  const steps = [
    { nodeId: 'classify', output: 'normal' },
    { nodeId: 'b1', output: { value: 'normal', matched: 'normal', to: 'summ' } },
    { nodeId: 'summ', output: 'A one-line summary.' },
  ];
  const deliveries = [];
  if (deliver) { steps.push({ nodeId: 'save_norm', output: inboxDelivery }); deliveries.push(inboxDelivery); }
  return { completed: true, error: null, steps, deliveries };
}
function urgentRun(decision, deliver = true) {
  const to = decision === 'approve' ? 'save_appr' : 'stop_rej';
  const steps = [
    { nodeId: 'classify', output: 'urgent' },
    { nodeId: 'b1', output: { value: 'urgent', matched: 'urgent', to: 'draft' } },
    { nodeId: 'draft', output: 'A drafted note.' },
    { nodeId: 'ask', output: { decision, by: 'user:1', channel: 'inbox' } },
    { nodeId: 'b2', output: { value: decision, matched: decision === 'approve' ? 'approve' : '*', to } },
  ];
  const deliveries = [];
  if (decision === 'approve' && deliver) { steps.push({ nodeId: 'save_appr', output: inboxDelivery }); deliveries.push(inboxDelivery); }
  else if (decision !== 'approve') { steps.push({ nodeId: 'stop_rej', output: { done: true } }); }
  return { completed: true, error: null, steps, deliveries };
}

describe('a conditional promise gated on a downstream branch a sample never reached', () => {
  const spec = triageWithApproval();

  test('THE FIX: a SPAM sample skips the approval-gated promise — it does NOT fail (no rebuild)', () => {
    const r = evaluateExampleRun(spec, { given: {} }, spamRun());
    assert.equal(byId(r, 'a_appr').applicable, false, 'the approve promise does not apply to spam — its gate never ran');
    assert.equal(byId(r, 'a_appr').skipped, true);
    assert.equal(byId(r, 'a_norm').skipped, true, 'the normal promise does not apply to spam either');
    assert.equal(r.contractPassed, true, 'a spam sample that correctly stopped is not a broken delivery');
    assert.equal(r.verdict, 'not_exercised', 'nothing was proved — but nothing was broken');
  });

  test('a NORMAL sample enforces the normal promise and skips the approval one', () => {
    const r = evaluateExampleRun(spec, { given: {} }, normalRun(true));
    assert.equal(byId(r, 'a_norm').applicable, true);
    assert.equal(byId(r, 'a_norm').ok, true, 'the normal lane delivered');
    assert.equal(byId(r, 'a_appr').skipped, true, 'the approval gate was never reached on a normal sample');
    assert.equal(r.contractPassed, true);
    assert.equal(r.verdict, 'kept');
  });

  test('an URGENT+APPROVE sample enforces the approval promise (its gate WAS reached)', () => {
    const r = evaluateExampleRun(spec, { given: {} }, urgentRun('approve', true));
    assert.equal(byId(r, 'a_appr').applicable, true, 'the approval gate ran and took the approve lane');
    assert.equal(byId(r, 'a_appr').ok, true, 'the approved record was saved');
    assert.equal(byId(r, 'a_norm').skipped, true);
    assert.equal(r.contractPassed, true);
    assert.equal(r.verdict, 'kept');
  });

  test('an URGENT+REJECT sample SKIPS the approval promise (silence is not a kept promise, nor a broken one)', () => {
    const r = evaluateExampleRun(spec, { given: {} }, urgentRun('reject'));
    assert.equal(byId(r, 'a_appr').applicable, false, 'a rejected item was not approved — the record promise does not apply');
    assert.equal(byId(r, 'a_appr').skipped, true);
    assert.equal(r.contractPassed, true, 'a rejection that correctly saved nothing is not a failure');
    assert.equal(r.verdict, 'not_exercised');
  });

  test('ANTI-WEAKENING: an URGENT+APPROVE sample whose save DID NOT happen still FAILS', () => {
    // The gate WAS reached and took approve, so the promise applies — a missing delivery
    // on the reached lane must fail, exactly as before. The fix must not mask this.
    const r = evaluateExampleRun(spec, { given: {} }, urgentRun('approve', /* deliver */ false));
    assert.equal(byId(r, 'a_appr').applicable, true);
    assert.equal(byId(r, 'a_appr').ok, false, 'approved but nothing was saved — a real miss on the taken lane');
    assert.match(byId(r, 'a_appr').reason, /nothing reached/i);
    assert.equal(r.contractPassed, false);
    assert.equal(r.verdict, 'broken');
  });
});
