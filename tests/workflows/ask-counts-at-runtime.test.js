/**
 * The approval step's question is a message the run really sent — the runtime
 * check must count it, exactly as the build-time check always has.
 *
 * WITNESSED ON PROD (2026-07-28, v1.6.48), on an otherwise PASSING run:
 *
 *   "Nothing in this run could check hello@agntic.co on Slack, so that part is
 *    still unproven."
 *
 * The workflow did send that DM — the approval step is what sends it, which is the
 * whole reason there is no separate delivery node for it (a second one would
 * message the person twice). `satisfiesAssertion` has always known this; see
 * `askSatisfiesAssertion`. But a run's deliveries were assembled as
 * `isDeliveryNode(node) || output.delivered === true`, and a `human` node is
 * neither — so the ask was invisible and one of the workflow's three promises went
 * live unverified.
 *
 * The rule now lives in ONE place, `deliveriesForStep`, which both
 * `dry-run-runner.js` and `POST /workflows/run` call. Two copies of the rule, each
 * blind to the approval step, is how build and runtime drifted apart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAssertionAtRuntime,
  deliveriesForStep,
  askDeliveriesOf,
} from '../../src/workflows/outcome-oracle.js';

const askNode = (channels) => ({
  id: 'approve', type: 'human', label: 'Charles approves posting',
  config: { prompt: 'ok?', decisions: ['approve', 'reject'], channels },
});

const DM_PROMISE = { kind: 'message_sent', target: 'slack:hello@agntic.co', when: 'urgent_complaint' };

test('the prod failure: a Slack ask satisfies the promise to DM that person', () => {
  const deliveries = deliveriesForStep(askNode([{ type: 'slack', target: 'hello@agntic.co' }]), null);
  const res = checkAssertionAtRuntime(DM_PROMISE, deliveries);
  assert.equal(res.ok, true, res.reason ?? 'the ask should satisfy the DM promise');
});

test('an ask over several channels yields one delivery each', () => {
  const out = askDeliveriesOf(askNode([
    { type: 'slack', target: 'hello@agntic.co' },
    { type: 'inbox', target: 'Approvals' },
  ]));
  assert.equal(out.length, 2);
});

test('a normal delivery step is unchanged', () => {
  const node = { id: 'post', type: 'deliver', config: { channel: 'slack', target: '#atlas-test-temp' } };
  const deliveries = deliveriesForStep(node, { delivered: true });
  assert.equal(deliveries.length, 1);
  const res = checkAssertionAtRuntime({ kind: 'message_sent', target: 'slack:#atlas-test-temp' }, deliveries);
  assert.equal(res.ok, true, res.reason ?? 'a real delivery must still satisfy');
});

test('a step that is neither an ask nor a delivery contributes nothing', () => {
  assert.deepEqual(deliveriesForStep({ id: 'sum', type: 'llm', config: {} }, { output: 'text' }), []);
});

// ── THE ANTI-FALSE-PASS CASES ────────────────────────────────────────────────
// An ask that counts for everything would certify promises nothing ever sent.

test('an ask to a DIFFERENT person does not satisfy the promise', () => {
  const deliveries = deliveriesForStep(askNode([{ type: 'slack', target: 'someone.else@agntic.co' }]), null);
  assert.equal(checkAssertionAtRuntime(DM_PROMISE, deliveries).ok, false);
});

test('an EMAIL ask cannot satisfy a gmail promise — it is a platform magic link', () => {
  const deliveries = deliveriesForStep(askNode([{ type: 'email', target: 'hello@agntic.co' }]), null);
  assert.equal(deliveries.length, 0, 'an email ask is not the tenant’s connector');
  assert.equal(
    checkAssertionAtRuntime({ kind: 'message_sent', target: 'gmail:hello@agntic.co' }, deliveries).ok,
    false,
  );
});

test('an ask does not satisfy a RECORD promise — a question writes nothing', () => {
  const deliveries = deliveriesForStep(askNode([{ type: 'slack', target: 'hello@agntic.co' }]), null);
  assert.equal(
    checkAssertionAtRuntime({ kind: 'record_exists', target: 'airtable:Table 1' }, deliveries).ok,
    false,
  );
});

test('an ask with no channels proves nothing', () => {
  assert.deepEqual(askDeliveriesOf(askNode([])), []);
  assert.deepEqual(askDeliveriesOf(askNode(undefined)), []);
});

test('a channel pair is matched whole, never pooled across channels', () => {
  // slack:#ops + email:bob@x.com must NOT add up to slack:bob@x.com — nothing sends that.
  const deliveries = deliveriesForStep(askNode([
    { type: 'slack', target: '#ops' },
    { type: 'email', target: 'bob@x.com' },
  ]), null);
  assert.equal(
    checkAssertionAtRuntime({ kind: 'message_sent', target: 'slack:bob@x.com' }, deliveries).ok,
    false,
  );
});
