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

import { checkAssertionAtRuntime, evaluateExampleRun, normalizeDelivery, isDeliveryNode } from '../../src/workflows/outcome-oracle.js';

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
    assert.match(r.reason, /nothing reached/i);
    assert.match(r.reason, /#ops/i, 'the reason must still name where it should have gone');
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
});

// ── THE PRODUCTION PATH — real handler shapes, not synthetic ones ──────────────
// Every test above hand-builds a delivery that already carries `{delivered, channel,
// target}`. NO handler except Slack returns that shape: inbox omits `channel`,
// gmail_send / airtable_create omit BOTH `channel` and `delivered`. So the checks
// above were green while the runtime oracle confirmed ONLY Slack — every inbox,
// gmail, or airtable delivery read back as "nothing reached …" on a SUCCESSFUL run.
// (P12 G defect; CLAUDE.md flaw #2 — "a test that exercises a configuration
// production never uses cannot see the bug production has".)
//
// These feed `normalizeDelivery` the EXACT object each handler returns (source line
// cited), through the same node→delivery assembly the /workflows/run route uses.
describe('normalizeDelivery — the real handler shapes reach the oracle (G)', () => {
  const run = (node, handlerOutput, assertion) => {
    assert.equal(isDeliveryNode(node), true, 'the node is recognised as a delivery');
    return checkAssertionAtRuntime(assertion, [normalizeDelivery(node, handlerOutput)]);
  };

  test('INBOX: {inbox_message_id, subject, delivered} — no channel (src/inbox/index.js:63)', () => {
    const node   = { id: 'd', type: 'deliver', config: { channel: 'inbox_deliver', subject: 'Support Email Summary' } };
    const output = { inbox_message_id: 'm1', subject: 'Support Email Summary', delivered: true };
    assert.equal(run(node, output, { kind: 'message_sent', target: 'inbox:Support Email Summary' }).ok, true);
  });

  test('GMAIL: {messageId, threadId} — no delivered, no channel (src/connectors/google/index.js:338)', () => {
    const node   = { id: 'g', type: 'connector-action', config: { action: 'gmail_send', to: 'ops@acme.com' } };
    const output = { messageId: 'x1', threadId: 't1' };
    assert.equal(run(node, output, { kind: 'message_sent', target: 'gmail:ops@acme.com' }).ok, true);
  });

  test('AIRTABLE: {id, fields} — no delivered, no channel (src/connectors/airtable/index.js:188)', () => {
    const node   = { id: 'a', type: 'connector-action', config: { action: 'airtable_create_record', baseId: 'appX', tableId: 'Interactions' } };
    const output = { id: 'rec1', fields: { Name: 'Alice' } };
    assert.equal(run(node, output, { kind: 'record_exists', target: 'airtable:Interactions' }).ok, true);
  });

  test('SLACK still passes through the node path (src/connectors/slack/index.js:262)', () => {
    const node   = { id: 's', type: 'connector-action', config: { action: 'slack', target: '#support' } };
    const output = { delivered: true, channel: 'slack', target: '#support', ts: '123' };
    assert.equal(run(node, output, { kind: 'message_sent', target: 'slack:#support' }).ok, true);
  });

  // THE BLOCKER found in live testing (P12 hardening). A Slack DM handler resolves
  // the declared EMAIL to a Slack user id and returns only that id as `target`
  // (src/connectors/slack/index.js:284: {channel:'slack_dm', target:<userId>, slackChannel}).
  // The assertion is written in the DECLARED email. Keying the match to the resolved
  // id alone reported "nothing reached slack:amy@acme.co" on a DM that WAS delivered —
  // a false PROMISE BROKEN. normalizeDelivery must carry BOTH the resolved id and the
  // node's declared user, so the assertion in either spelling matches.
  test('SLACK DM: declared email matches even though the handler returns the resolved user id', () => {
    const node   = { id: 'dm', type: 'deliver', config: { channel: 'slack_dm', user: 'amy@acme.co' } };
    const output = { delivered: true, channel: 'slack_dm', target: 'U0B3LM5KRGV', ts: '1.2', slackChannel: 'D0AMY' };
    const norm   = normalizeDelivery(node, output);
    assert.ok(norm.locators.includes('amy@acme.co'), 'the declared DM email is carried');
    assert.ok(norm.locators.includes('U0B3LM5KRGV'), 'the resolved user id is carried too');
    assert.equal(
      checkAssertionAtRuntime({ kind: 'message_sent', target: 'slack:amy@acme.co' }, [norm]).ok,
      true, 'the assertion written in the declared email is satisfied');
    // …and the guard is NOT blunted: a DM to a DIFFERENT person is not satisfied.
    assert.equal(
      checkAssertionAtRuntime({ kind: 'message_sent', target: 'slack:someone-else@acme.co' }, [norm]).ok,
      false, 'a DM to a different person does not satisfy it');
  });

  test('a READ connector-action is NOT a delivery (it satisfies nothing)', () => {
    assert.equal(isDeliveryNode({ id: 'r', type: 'connector-action', config: { action: 'airtable_get_record' } }), false);
    assert.equal(isDeliveryNode({ id: 'c', type: 'connector-action', config: { action: 'slack_list_channels' } }), false);
    assert.equal(isDeliveryNode({ id: 'l', type: 'llm', config: { mode: 'summarize' } }), false);
  });

  // The inbox is a SINGLE destination and its "locator" is a descriptive TITLE, not a
  // routing address — the converger sets the item's title (e.g. `[Name] — [Company]`)
  // independently of the assertion's descriptive locator (`Daily CRM Summary`), and the
  // two legitimately differ. Matching them as if the title were an address produced a
  // false "nothing reached inbox:…" on genuinely-delivered items, stranding fan-out and
  // foreach builds (live P12 hardening). So an inbox delivery of ANY title satisfies an
  // inbox assertion — the destination is what the moat guards, and there is one inbox.
  test('inbox is a single destination — any title satisfies an inbox assertion', () => {
    const node   = { id: 'd', type: 'deliver', config: { channel: 'inbox_deliver', subject: 'Something Else' } };
    const output = { inbox_message_id: 'm2', subject: 'Something Else', delivered: true };
    assert.equal(run(node, output, { kind: 'message_sent', target: 'inbox:Support Email Summary' }).ok, true);
  });

  // …but the guard is NOT blunted: it still bites on the DESTINATION. A delivery to the
  // WRONG connector does not satisfy an inbox promise, and NO inbox delivery fails it.
  test('a NON-inbox delivery does NOT satisfy an inbox assertion (destination still checked)', () => {
    const node   = { id: 's', type: 'connector-action', config: { action: 'slack', target: '#ops' } };
    const output = { delivered: true, channel: 'slack', target: '#ops', ts: '1' };
    const r = run(node, output, { kind: 'message_sent', target: 'inbox:Daily Digest' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /nothing reached/i);
    assert.match(r.reason, /Daily Digest/i);
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

  // THE CONTENT-ERROR GUARD (live-testing finding). A content llm node that can't
  // find its input outputs EXACTLY the converger's sentinel "ERROR: required data
  // not found", which then flows to the delivery. `message_sent → inbox` is a floor
  // and passed anyway — so a workflow that delivered an ERROR STRING read as
  // "Contract kept / Go live". It must NOT: a delivery of the sentinel keeps nothing.
  test('a delivery whose content is the error sentinel does NOT keep the contract', () => {
    const inboxSpec = { outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Digest' }] } };
    const run = {
      completed: true,
      deliveries: [deliv({ channel: 'inbox_deliver', subject: 'Digest' })],
      steps: [
        { nodeId: 'classify', output: 'urgent' },
        { nodeId: 'summarize_email', output: 'ERROR: required data not found' },
        { nodeId: 'deliver', output: { inbox_message_id: 'm1', subject: 'Digest', delivered: true } },
      ],
    };
    const r = evaluateExampleRun(inboxSpec, { id: 'e1', label: 'x' }, run);
    assert.equal(r.contractPassed, false, 'a delivered error string is not a kept promise');
    const failed = r.contract.find(c => !c.ok);
    assert.match(failed.reason, /content was an error/);
    assert.match(failed.reason, /summarize_email/);
  });

  test('a clean run with the same shape still passes (guard is not over-eager)', () => {
    const inboxSpec = { outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Digest' }] } };
    const run = {
      completed: true,
      deliveries: [deliv({ channel: 'inbox_deliver', subject: 'Digest' })],
      steps: [
        { nodeId: 'classify', output: 'urgent' },
        { nodeId: 'summarize_email', output: 'The database is down; engineering is investigating.' },
        { nodeId: 'deliver', output: { inbox_message_id: 'm1', subject: 'Digest', delivered: true } },
      ],
    };
    assert.equal(evaluateExampleRun(inboxSpec, { id: 'e1', label: 'x' }, run).contractPassed, true);
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
