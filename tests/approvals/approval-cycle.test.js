/**
 * THE APPROVAL GATE, END TO END, THROUGH THE SCHEDULER (2026-07-19).
 *
 * The live UI test suite (docs/handoff/ui-test-findings-2026-07-19.md) recorded
 * that "whether rejecting actually blocks the send" was the single most important
 * unproven behaviour in the product, and F25 suspected the durable pause was
 * broken outright. It is not — but the reason nobody could tell is worth pinning:
 *
 *   EVERY pre-existing test of the pause hand-calls `ws.pauseRun(...)` with a
 *   hand-built checkpoint. That covers the RESUME half and leaves the PARK half —
 *   the scheduler reacting to a `run_paused` event the ENGINE emitted, with a
 *   checkpoint the ENGINE built — executed by nothing. It is CLAUDE.md's
 *   architectural flaw #2 verbatim: the tests supply what production must
 *   generate, so a mutant and the original behave identically.
 *
 * So this suite drives `_executeFlow` with a real `human` node and asserts what
 * the run DID, not that a function was called:
 *
 *   1. the park is durable and answerable (status/checkpoint/ask actually land),
 *   2. APPROVE sends, and sends THE APPROVED DRAFT — not a control node's output
 *      and not a truncated display copy (converger-v2 §7.4),
 *   3. REJECT sends NOTHING — the invariant the whole gate exists for,
 *   4. a deployment with no way to ask FAILS LOUDLY rather than parking forever.
 *
 * Assertions are on the DELIVERED BODY and the SEND COUNT. A test that only
 * checked "a delivery ran" passes on an engine that sends on reject.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { WorkflowScheduler } from '../../src/workflows/workflow-scheduler.js';
import { WorkflowStore }     from '../../src/workflows/workflow-store.js';
import { FlowTester }        from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry }  from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const DRAFT = 'Dear customer, here is your refund. — Support';

/**
 * The sanctioned approval shape (converger-v2 §7.1, as corrected in Increment D):
 * a `human` node ALONE is not a gate — the answer must be routed by a `branch`,
 * or the step after it runs whatever the person said.
 *
 *   draft → ask[human] → gate[branch] ─ approve → send[deliver]
 *                                     └ *       → dropped[assemble]
 */
function setup({ withDeliverer = true } = {}) {
  const sent = [];
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();

  const flowTester = new FlowTester({
    nodeTypes,
    llm: { invoke: async () => ({ content: DRAFT }) },
    channelRegistry: {
      get: (id) => ({ id, available: true }),
      getHandler: () => async (args) => { sent.push(args); return { delivered: true, ts: '1.0' }; },
    },
  });
  const scheduler = new WorkflowScheduler({ workflowStore: ws, sourceRegistry: null, flowTester });

  const asks = [];
  if (withDeliverer) scheduler.registerAskDeliverer(async (ctx) => { asks.push(ctx); });

  const wf = ws.create({
    name: 'Support auto-reply', kind: 'flow', status: 'active',
    tenantId: 'tenant-a', userId: 'user-1',
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [
      { id: 'draft', type: 'llm',   config: { mode: 'freeform', prompt: 'draft a reply' } },
      { id: 'ask',   type: 'human', config: { prompt: 'Send this?', decisions: ['approve', 'reject'],
                                              channels: ['inbox'], timeout: { after: '24h', then: 'reject' } } },
      { id: 'gate',  type: 'branch', config: { on: '{{ask.decision}}',
                                               cases: [{ when: 'approve', to: 'send' }, { when: '*', to: 'dropped' }] } },
      { id: 'send',    type: 'deliver',  config: { channel: 'slack', target: '#customer' } },
      { id: 'dropped', type: 'assemble', config: { content: 'not sent' } },
    ],
    edges: [{ from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' },
            { from: 'gate', to: 'send' }, { from: 'gate', to: 'dropped' }],
  });

  return { ws, scheduler, sent, asks, wf };
}

const runIdOf = (ws) => ws.db.prepare('SELECT id FROM workflow_runs').get().id;

/** Drive to the pause, answer it, return what happened. */
async function cycle(decision) {
  const s = setup();
  await s.scheduler._executeFlow(s.ws.get(s.wf.id), { trigger: 'scheduled' });
  const runId  = runIdOf(s.ws);
  const paused = s.ws.getAwaitingHuman(runId);
  const res    = await s.scheduler.resumeRun(paused, { decision, by: 'user:1', channel: 'inbox' });
  return { ...s, runId, paused, res, row: s.ws.getRun(runId) };
}

describe('the approval gate, driven through the scheduler', () => {
  test('THE PARK: the engine\'s own run_paused durably parks the run and asks a person', async () => {
    const s = setup();
    await s.scheduler._executeFlow(s.ws.get(s.wf.id), { trigger: 'scheduled' });

    const row = s.ws.db.prepare('SELECT status, paused_node, checkpoint FROM workflow_runs').get();
    assert.equal(row.status, 'awaiting_human',
      'a run waiting on a person is not running, not a success and not an error');
    assert.equal(row.paused_node, 'ask');
    assert.ok(row.checkpoint, 'the checkpoint is the resume state — without it the run cannot be answered');

    // Nothing was delivered: the gate stopped the send, which is the point.
    assert.equal(s.sent.length, 0, 'nothing may be sent before a person has answered');

    // The ask actually went out, and it is answerable.
    assert.equal(s.asks.length, 1, 'the question reached a channel');
    assert.equal(s.asks[0].ask.prompt, 'Send this?');
    assert.ok(s.ws.getAwaitingHuman(runIdOf(s.ws)), 'and the run is findable to answer');
  });

  test('APPROVE sends — and sends the APPROVED DRAFT, not a control node\'s output', async () => {
    const c = await cycle('approve');

    assert.equal(c.res.resumed, true);
    assert.equal(c.row.status, 'success');
    assert.equal(c.sent.length, 1, 'approving sends exactly once');

    // WHAT was sent, not that a send happened. `branch` and `human` are CONTROL
    // nodes whose output must never become `lastOutput`; miss that and the
    // customer receives {"decision":"approve",...}. And the body must be the FULL
    // draft — resuming from the display-shrunk step stream truncated a 3363-char
    // reply to 2013 chars, so the person approved one thing and the customer got
    // another (converger-v2 §7.4).
    const body = JSON.stringify(c.sent[0]);
    assert.ok(body.includes(DRAFT),
      `the delivered body must be the approved draft verbatim — got: ${body.slice(0, 200)}`);
    assert.ok(!body.includes('"decision"'),
      'the approval record must never reach the customer');
    assert.ok(!body.includes('(truncated)'), 'the approved text must not be a display copy');
  });

  test('REJECT sends NOTHING — the invariant the gate exists for', async () => {
    const c = await cycle('reject');

    assert.equal(c.res.resumed, true, 'a rejection still resolves the run');
    assert.equal(c.row.status, 'success', 'rejecting is a normal outcome, not a failure');
    assert.equal(c.sent.length, 0,
      'REJECTED MEANS NOT SENT. If this is ever non-zero the approval gate is decorative ' +
      'and the customer receives mail a person explicitly declined to send.');
  });

  test('a deployment with no way to ask FAILS the run rather than parking it forever', async () => {
    // A pause nobody can be asked about is worse than a failure: the run waits on
    // an answer no surface will ever request. Fail loudly instead.
    const s = setup({ withDeliverer: false });
    await s.scheduler._executeFlow(s.ws.get(s.wf.id), { trigger: 'scheduled' });

    const row = s.ws.db.prepare('SELECT status, paused_node FROM workflow_runs').get();
    assert.equal(row.status, 'error');
    assert.equal(row.paused_node, null, 'it must not be left parked');
    assert.equal(s.sent.length, 0, 'and it certainly must not send');
  });
});
