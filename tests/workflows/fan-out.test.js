/**
 * Multiple destinations — one workflow, one content step, N deliveries.
 *
 * "Post it to #ops AND email the team" is the most ordinary thing a user asks
 * for, and it was silently broken in a way nobody could see from the outside.
 *
 * THE DEFECT (found by a load-bearing test, reported as "it only did the Slack
 * one"): the engine fans out correctly — one `deliver` per destination, both
 * edged from the content step, and both RUN. But a delivery's return value is a
 * RECEIPT ({delivered, ts}), and `deliver` was not in flow-tester's CONTROL_TYPES
 * — so the first delivery's receipt became `lastOutput`, and the SECOND deliver
 * builds its body from `ctx.lastOutput`:
 *
 *     slack  ←  "Here is your summary…"
 *     gmail  ←  {"delivered":true,"ts":"1728…"}
 *
 * …with `run_completed`, no error, and the run marked success. The second
 * destination receives the first one's receipt. Whether that surfaces as garbage
 * in an inbox or a channel rejecting the payload, the user's conclusion is the
 * same: "only Slack worked".
 *
 * SO THESE TESTS ASSERT WHAT EACH DESTINATION RECEIVED. Asserting that two
 * deliveries RAN passes on the broken engine — the whole point is what was in
 * them. (CLAUDE.md: a test that asserts a delivery ran, and never what it sent,
 * is how the checkpoint-truncation disaster shipped green.)
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { FlowTester }               from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

const CONTENT = 'Q3 shipped 14 features and revenue grew 9%.';

/** Records what each channel was actually handed, and returns a REAL receipt. */
const recordingChannels = (sent) => ({
  get: (id) => ({ id, available: true }),
  getHandler: (id) => async (args) => {
    sent.push({ channel: id, body: args.body });
    // The receipt is the point: it is a plausible object, and it is NOT content.
    return { delivered: true, ts: `${id}-1728000000.0001`, channel: 'C001' };
  },
});

const twoDestinations = () => ({
  name: 'Post to Slack and email the team', version: 2,
  triggers: [{ type: 'email' }],
  outcome: {
    statement: 'Every report goes to #ops in Slack and to the team by email.',
    assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#ops' },
      { id: 'a2', kind: 'message_sent', target: 'gmail:team@example.com' },
    ],
  },
  nodes: [
    { id: 'summarize', type: 'llm',     label: 'Summarize', config: { mode: 'summarize' } },
    { id: 'to_slack',  type: 'deliver', label: 'Slack',     config: { channel: 'slack', target: '#ops' } },
    { id: 'to_email',  type: 'deliver', label: 'Email',     config: { channel: 'gmail_send', to: 'team@example.com' } },
  ],
  // FAN-OUT: both deliveries hang off the SAME content step.
  edges: [{ from: 'summarize', to: 'to_slack' }, { from: 'summarize', to: 'to_email' }],
});

const tester = (sent) => new FlowTester({
  nodeTypes,
  channelRegistry: recordingChannels(sent),
  llm: { invoke: async () => ({ content: CONTENT }) },
});

async function runAll(t, flow, options = {}) {
  const events = [];
  for await (const e of t.run(flow, options)) events.push(e);
  return events;
}

describe('a workflow with two destinations delivers the CONTENT to both', () => {
  test('THE ACCEPTANCE: neither destination receives the other\'s receipt', async () => {
    const sent = [];
    const events = await runAll(tester(sent), twoDestinations(), { initialContext: { subject: 'Q3', body: '…' } });

    assert.equal(events.some(e => e.type === 'run_failed'), false,
      events.find(e => e.type === 'run_failed')?.error ?? '');
    assert.equal(sent.length, 2, 'both destinations must be delivered to — the engine fans out');

    for (const { channel, body } of sent) {
      assert.equal(
        body, CONTENT,
        `${channel} received ${JSON.stringify(body)} instead of the content. A delivery's return value is a ` +
        'RECEIPT, not the work product: if `deliver` is not in CONTROL_TYPES, the first delivery\'s ' +
        '{delivered, ts} becomes lastOutput and the second deliver ships it to the customer.',
      );
      assert.equal(/"delivered"|"ts"/.test(String(body)), false, 'no receipt may reach a destination');
    }
  });

  test('order does not matter — the SECOND destination is not the degraded one', async () => {
    // The defect is asymmetric by nature: destination #1 is always fine and
    // destination #2 always gets the receipt. A test that only checked the first
    // delivery would pass on the broken engine, which is exactly the shape of a
    // test that passes for the wrong reason.
    const flow = twoDestinations();
    flow.edges = [{ from: 'summarize', to: 'to_email' }, { from: 'summarize', to: 'to_slack' }];
    const sent = [];
    await runAll(tester(sent), flow, { initialContext: { subject: 'Q3', body: '…' } });
    assert.deepEqual(sent.map(s => s.body), [CONTENT, CONTENT]);
  });

  test('THREE destinations: every one of them gets the content', async () => {
    const flow = twoDestinations();
    flow.nodes.push({ id: 'to_inbox', type: 'deliver', label: 'Inbox', config: { channel: 'in_app' } });
    flow.edges.push({ from: 'summarize', to: 'to_inbox' });
    const sent = [];
    await runAll(tester(sent), flow, { initialContext: { subject: 'Q3', body: '…' } });
    assert.equal(sent.length, 3);
    assert.deepEqual([...new Set(sent.map(s => s.body))], [CONTENT], 'one distinct body: the content');
  });

  test('the RUN\'s final output is the content, not the last channel\'s receipt', async () => {
    // `run_completed.output` is what the console shows, what the Inbox stores, and
    // what output-validator.js inspects for an empty body or a leaked template. It
    // has been the last delivery's receipt all along, so those checks were reading
    // the wrong thing — EMPTY_BODY could never fire correctly on a real workflow.
    const sent = [];
    const events = await runAll(tester(sent), twoDestinations(), { initialContext: { subject: 'Q3', body: '…' } });
    const done = events.find(e => e.type === 'run_completed');
    assert.equal(done.output, CONTENT);
  });

  test('a delivery RECEIPT still reaches the run log (the P2/P3 runnability bar)', async () => {
    // The receipt is not deleted — it is simply not the work product. The deliver
    // node's own step_completed still carries {delivered, ts}, which is what the P3
    // gate reads to prove the spec actually reached Slack.
    const sent = [];
    const events = await runAll(tester(sent), twoDestinations(), { initialContext: { subject: 'Q3', body: '…' } });
    const step = events.find(e => e.type === 'step_completed' && e.nodeId === 'to_slack');
    assert.match(String(step.output), /"ts":"slack-/, 'the delivery ts must survive — P3 asserts runnability with it');
  });

  test('POSITIVE: a single-destination workflow is untouched', async () => {
    // §11.2's rule, applied to this change: a spec that does not fan out must
    // execute exactly as it did before. The overwhelming majority of workflows in
    // production have one deliver node.
    const flow = twoDestinations();
    flow.nodes = flow.nodes.filter(n => n.id !== 'to_email');
    flow.edges = [{ from: 'summarize', to: 'to_slack' }];
    flow.outcome.assertions = [flow.outcome.assertions[0]];
    const sent = [];
    const events = await runAll(tester(sent), flow, { initialContext: { subject: 'Q3', body: '…' } });
    assert.deepEqual(sent, [{ channel: 'slack', body: CONTENT }]);
    assert.equal(events.find(e => e.type === 'run_completed').output, CONTENT);
  });
});

describe('and the outcome contract holds the converger to BOTH (P12-C)', () => {
  test('a spec that drops the email step does not publish', () => {
    // The other half of the reported bug, and the one Increment C already closed:
    // the converger agreeing to Slack AND email and emitting only Slack. The
    // outcome declares both, so a spec containing one is UNSATISFIED_ASSERTION —
    // it cannot be saved. This test is what stops that regressing while the engine
    // fix lands.
    const channelRegistry = { get: (id) => ({ id, available: true }) };
    const v = new WorkflowValidator({ nodeTypes, channelRegistry });

    const dropped = twoDestinations();
    dropped.nodes = dropped.nodes.filter(n => n.id !== 'to_email');
    dropped.edges = [{ from: 'summarize', to: 'to_slack' }];

    const res = v.validate(dropped);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.code === 'UNSATISFIED_ASSERTION'),
      `a workflow that promises email and does not send it must not publish; got: ${res.errors.map(e => e.code).join(', ')}`);

    // POSITIVE: with both destinations present, it publishes.
    assert.equal(v.validate(twoDestinations()).ok, true);
  });
});
