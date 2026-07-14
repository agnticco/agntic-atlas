/**
 * The RUNTIME outcome oracle — the test panel's engine. (P12 Increment G.)
 *
 * `satisfiesAssertion` asks whether a SPEC can produce an effect. This asks whether
 * a RUN did. The two share one definition of "slack:#ops" (the connector aliasing
 * this file owns), applied once to what a spec declares and once to what a run
 * produced — so a build-time yes and a run-time no cannot come from a disagreement
 * about what the target means.
 *
 * The CONTRACT is gated (machine-checkable, generic). The example's `expect` is
 * SHOWN, never gated — it is the SME's freeform words, and a workflow-agnostic
 * judge that pretended to check them would be exactly the false confidence this
 * phase exists to kill.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { checkAssertionAtRuntime, evaluateExampleRun } from '../../src/workflows/outcome-oracle.js';

const deliv = (over) => ({ delivered: true, ...over });

describe('checkAssertionAtRuntime — did the effect actually happen', () => {
  const slackToOps = { id: 'a1', kind: 'message_sent', target: 'slack:#ops' };

  test('a real Slack delivery to the named channel satisfies it', () => {
    const r = checkAssertionAtRuntime(slackToOps, [deliv({ channel: 'slack', target: '#ops', ts: '1.0' })]);
    assert.equal(r.ok, true);
    assert.match(r.detail, /#ops/);
  });

  test('a delivery to the WRONG channel does not', () => {
    const r = checkAssertionAtRuntime(slackToOps, [deliv({ channel: 'slack', target: '#random' })]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /nothing reached slack:#ops/);
  });

  test('decoration is ignored — "#ops", "ops", "@ops" compare equal', () => {
    assert.equal(checkAssertionAtRuntime(slackToOps, [deliv({ channel: 'slack', target: 'ops' })]).ok, true);
  });

  test('a delivery that DID NOT actually deliver never counts', () => {
    const r = checkAssertionAtRuntime(slackToOps, [{ delivered: false, channel: 'slack', target: '#ops' }]);
    assert.equal(r.ok, false);
  });

  test('no locator ⇒ ANY delivery to that connector is enough', () => {
    const bare = { kind: 'message_sent', target: 'slack' };
    assert.equal(checkAssertionAtRuntime(bare, [deliv({ channel: 'slack', target: '#anywhere' })]).ok, true);
  });

  test('connector aliases: gmail_send satisfies a gmail/email/mail target', () => {
    for (const target of ['gmail:x@y.com', 'email:x@y.com', 'mail:x@y.com']) {
      const r = checkAssertionAtRuntime({ kind: 'message_sent', target }, [deliv({ channel: 'gmail_send', to: 'x@y.com' })]);
      assert.equal(r.ok, true, target);
    }
  });

  test('a record_exists is satisfied by an airtable write delivery', () => {
    const r = checkAssertionAtRuntime({ kind: 'record_exists', target: 'airtable:Leads' },
      [deliv({ channel: 'airtable_create_record', target: 'Leads', id: 'rec1' })]);
    assert.equal(r.ok, true);
  });

  test('a MALFORMED assertion is reported, never silently passed', () => {
    const r = checkAssertionAtRuntime({ kind: 'teleported', target: 'x' }, [deliv({ channel: 'x' })]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /can't check/);
  });

  test('a TEMPLATE locator matches any real destination (resolved at run time)', () => {
    const r = checkAssertionAtRuntime({ kind: 'message_sent', target: 'slack:{{channel}}' },
      [deliv({ channel: 'slack', target: '#whatever-it-resolved-to' })]);
    assert.equal(r.ok, true);
  });
});

describe('evaluateExampleRun — the contract is gated, expect is shown', () => {
  const spec = {
    outcome: { assertions: [
      { id: 'a1', kind: 'record_exists', target: 'airtable:Leads' },
      { id: 'a2', kind: 'message_sent',  target: 'slack:#sales' },
    ] },
  };
  const example = { id: 'e1', label: 'Big lead', given: { subject: 'Need 200 seats' }, expect: { priority: 'P1', urgent: true } };

  test('BOTH promises kept ⇒ contract passes', () => {
    const run = { completed: true, deliveries: [
      deliv({ channel: 'airtable_create_record', target: 'Leads' }),
      deliv({ channel: 'slack', target: '#sales' }),
    ], steps: [] };
    const r = evaluateExampleRun(spec, example, run);
    assert.equal(r.contractPassed, true);
    assert.equal(r.contract.length, 2);
    assert.ok(r.contract.every(c => c.ok));
  });

  test('ONE promise dropped ⇒ contract FAILS, and names which one', () => {
    // The defect-#1 case at RUN time: the record is created, the Slack post never
    // happens. This is exactly what the test panel exists to surface before publish.
    const run = { completed: true, deliveries: [deliv({ channel: 'airtable_create_record', target: 'Leads' })], steps: [] };
    const r = evaluateExampleRun(spec, example, run);
    assert.equal(r.contractPassed, false);
    const failed = r.contract.find(c => !c.ok);
    assert.equal(failed.target, 'slack:#sales');
  });

  test('a run that ERRORED keeps no promise', () => {
    const r = evaluateExampleRun(spec, example, { completed: false, error: 'boom', deliveries: [] });
    assert.equal(r.contractPassed, false);
    assert.equal(r.ran, false);
  });

  test('EXPECT IS SHOWN, NOT GATED — a wrong expect value does not fail the contract', () => {
    // The run kept every contract promise. `expect.urgent` was the SME's word and the
    // run produced `tier: hot` instead — a workflow-agnostic oracle CANNOT know those
    // are the same or different, so it must not judge them. It shows both.
    const run = { completed: true, deliveries: [
      deliv({ channel: 'airtable_create_record', target: 'Leads' }),
      deliv({ channel: 'slack', target: '#sales' }),
    ], steps: [{ nodeId: 'score', output: { priority: 'P1', tier: 'hot' } }] };
    const r = evaluateExampleRun(spec, example, run);
    assert.equal(r.contractPassed, true, 'the CONTRACT is what gates, and it held');
    assert.deepEqual(r.expect, { priority: 'P1', urgent: true }, 'the SME expectation is carried through for display');
    assert.equal(r.produced.priority, 'P1', 'next to what the run actually produced');
    assert.equal(r.produced.tier, 'hot');
  });

  test('produced does NOT include delivery receipts — only content', () => {
    const run = { completed: true, deliveries: [deliv({ channel: 'slack', target: '#sales' })],
      steps: [{ nodeId: 'd', output: { delivered: true, ts: '1.0' } }, { nodeId: 'x', output: { name: 'Dana' } }] };
    const r = evaluateExampleRun(spec, example, run);
    assert.equal('ts' in r.produced, false, 'a receipt is not content');
    assert.equal(r.produced.name, 'Dana');
  });
});
