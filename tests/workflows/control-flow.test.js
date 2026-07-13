/**
 * P12 Increment B — engine control flow.
 *
 * The four things the gate demands (scripts/gates/p12.sh):
 *   1. `branch` skips the non-selected subtree
 *   2. `foreach` bounds at maxItems
 *   3. `human` pauses and RESUMES from a full-fidelity checkpoint
 *   4. §11.2 — a spec WITHOUT a branch executes byte-identically to today
 *
 * (4) is the one that protects production. Every workflow running today has no
 * control flow in it, so if this increment changes their behaviour at all, it
 * has broken the live system to add a feature none of them use.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FlowTester } from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';
import { IdempotencyStore } from '../../src/workflows/idempotency-store.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

/** A deterministic stub LLM — no network, no key, same answer every time. */
const stubLlm = (reply = 'STUB') => ({
  invoke: async () => ({ content: reply }),
});

/**
 * A stub ChannelRegistry. `deliver` and `connector-action` both resolve a
 * channel and then its handler, so a stub needs BOTH get() and getHandler().
 * `onCall` lets a test count real side-effects (the idempotency tests).
 */
const stubChannels = (onCall = null, { actionOnly = false } = {}) => ({
  get: (id) => ({ id, available: true, actionOnly }),
  getHandler: () => async (args) => {
    if (onCall) return onCall(args);
    return { delivered: true, ts: '1.0' };
  },
});

/** Collect every event a run emits. */
async function runAll(tester, flow, options = {}) {
  const events = [];
  for await (const evt of tester.run(flow, options)) events.push(evt);
  return events;
}

const ids = (events, type) => events.filter(e => e.type === type).map(e => e.nodeId);
const one = (events, type) => events.find(e => e.type === type);

/**
 * The output a node produced. `step_completed` carries a SHRUNK copy (the event
 * stream feeds the UI and must not carry megabytes), so an object output arrives
 * JSON-encoded. Decode it rather than asserting against the display form.
 */
function outputOf(events, nodeId) {
  const e = events.find(x => x.type === 'step_completed' && x.nodeId === nodeId);
  if (!e) return undefined;
  if (typeof e.output !== 'string') return e.output;
  try { return JSON.parse(e.output); } catch { return e.output; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. branch — exactly one path runs; the other is SKIPPED, not failed.
// ─────────────────────────────────────────────────────────────────────────────
const branchFlow = {
  nodes: [
    { id: 'classify', type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
    { id: 'route', type: 'branch', config: {
      on: 'classify.output',
      cases: [{ when: 'urgent', to: 'page_oncall' }, { when: '*', to: 'file_it' }],
    } },
    { id: 'page_oncall', type: 'llm', config: { prompt: 'Page the on-call.' } },
    { id: 'file_it',     type: 'llm', config: { prompt: 'File it.' } },
    { id: 'send',        type: 'deliver', config: { channel: 'in_app' } },
  ],
  edges: [
    { from: 'classify', to: 'route' },
    { from: 'route', to: 'page_oncall' },
    { from: 'route', to: 'file_it' },
    { from: 'page_oncall', to: 'send' },
    { from: 'file_it',     to: 'send' },
  ],
};

test('branch: the selected path runs and the other is skipped', async () => {
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: stubChannels() });
  const events = await runAll(tester, branchFlow, { initialContext: 'the inbound email' });

  assert.ok(ids(events, 'step_completed').includes('page_oncall'), 'the selected path must run');
  assert.ok(ids(events, 'step_skipped').includes('file_it'), 'the non-selected path must be SKIPPED');
  assert.ok(!ids(events, 'step_completed').includes('file_it'), 'the non-selected path must not run');
  assert.ok(!ids(events, 'step_failed').length, 'a skipped node is not a failed node');
});

test('branch: the catch-all is taken when nothing matches', async () => {
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('routine'), channelRegistry: stubChannels() });
  const events = await runAll(tester, branchFlow, { initialContext: 'the inbound email' });

  assert.ok(ids(events, 'step_completed').includes('file_it'), 'the catch-all path must run');
  assert.ok(ids(events, 'step_skipped').includes('page_oncall'));
});

test('branch: a JOIN downstream of both paths still runs (one live edge is enough)', async () => {
  // The classic way a node-level `active` set gets this wrong: `send` has two
  // parents, one of which was skipped. It must still run — it is a join, not a
  // casualty. This is why liveness is tracked on EDGES.
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: stubChannels() });
  const events = await runAll(tester, branchFlow, { initialContext: 'the inbound email' });

  assert.ok(ids(events, 'step_completed').includes('send'), 'the join must run on one live edge');
  assert.equal(one(events, 'run_completed') !== undefined, true, 'the run must complete');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. foreach — bounds at maxItems, and SAYS SO.
// ─────────────────────────────────────────────────────────────────────────────
test('foreach: bounds at maxItems and reports what it skipped', async () => {
  let calls = 0;
  const counting = { invoke: async () => { calls++; return { content: 'ok' }; } };

  const flow = {
    nodes: [
      { id: 'rows', type: 'assemble', config: { title: 'x', sections: '[]' } },
      { id: 'loop', type: 'foreach', config: {
        over: 'rows.output',
        maxItems: 3,
        steps: [{ id: 'summarise', type: 'llm', config: { prompt: 'Handle {{item}}' } }],
      } },
      { id: 'send', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'rows', to: 'loop' }, { from: 'loop', to: 'send' }],
  };

  const tester = new FlowTester({ nodeTypes, llm: counting, channelRegistry: stubChannels() });
  // Seed `rows` with 10 items by overriding its output through initialContext is
  // not possible (assemble returns markdown), so drive the loop directly:
  const events = await runAll(tester, {
    nodes: [
      { id: 'loop', type: 'foreach', config: {
        over: JSON.stringify(Array.from({ length: 10 }, (_, i) => `item-${i}`)),
        maxItems: 3,
        steps: [{ id: 'summarise', type: 'llm', config: { prompt: 'Handle {{item}}' } }],
      } },
      { id: 'send', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'loop', to: 'send' }],
  });

  const done = outputOf(events, 'loop');
  assert.ok(done, `foreach must complete; got ${JSON.stringify(events.map(e => e.type))}`);
  assert.equal(done.count, 3, 'exactly maxItems items are processed');
  assert.equal(done.total, 10);
  assert.equal(done.truncated, true, 'truncation must be REPORTED, not silent');
  assert.equal(done.skipped, 7);
  assert.equal(calls, 3, 'the bound must actually stop the work — not just trim the output');
  void flow;
});

test('foreach: runs its steps once per item, binding {{item}}', async () => {
  const seen = [];
  const spy = { invoke: async (msgs) => { seen.push(String(msgs[1].content)); return { content: 'ok' }; } };

  const events = await runAll(new FlowTester({ nodeTypes, llm: spy, channelRegistry: stubChannels() }), {
    nodes: [
      { id: 'loop', type: 'foreach', config: {
        over: JSON.stringify(['alpha', 'beta']),
        steps: [{ id: 's', type: 'llm', config: { prompt: 'Handle {{item}}' } }],
      } },
      { id: 'send', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'loop', to: 'send' }],
  });

  assert.equal(outputOf(events, 'loop').count, 2);
  assert.ok(seen.some(p => p.includes('alpha')), `{{item}} must bind; prompts were: ${JSON.stringify(seen)}`);
  assert.ok(seen.some(p => p.includes('beta')));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. human — pauses, and RESUMES FROM PERSISTED STEPS.
//    §7.4: no checkpointer needed — but the persisted STEPS are NOT the
//    checkpoint (they are display-shrunk). The run emits an explicit, full-
//    fidelity `checkpoint` on pause, and that is what a resume rehydrates from.
// ─────────────────────────────────────────────────────────────────────────────
const approvalFlow = {
  nodes: [
    { id: 'draft',  type: 'llm', config: { prompt: 'Draft a reply.' } },
    { id: 'approve', type: 'human', config: {
      prompt: 'Send this reply?', preview: '{{draft.output}}', decisions: ['approve', 'reject'],
    } },
    { id: 'route', type: 'branch', config: {
      on: 'approve.output',
      cases: [{ when: 'approve', to: 'send' }, { when: '*', to: 'drop' }],
    } },
    { id: 'send', type: 'deliver', config: { channel: 'in_app' } },
    { id: 'drop', type: 'llm', config: { prompt: 'Log the rejection.' } },
  ],
  edges: [
    { from: 'draft', to: 'approve' },
    { from: 'approve', to: 'route' },
    { from: 'route', to: 'send' },
    { from: 'route', to: 'drop' },
  ],
};

test('human: the run PAUSES at the approval and goes no further', async () => {
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('Dear customer, …'), channelRegistry: stubChannels() });
  const events = await runAll(tester, approvalFlow, { initialContext: 'the inbound email' });

  const paused = one(events, 'run_paused');
  assert.ok(paused, 'the run must pause');
  assert.equal(paused.nodeId, 'approve');
  assert.equal(paused.ask.prompt, 'Send this reply?');
  assert.deepEqual(paused.ask.decisions, ['approve', 'reject']);
  assert.ok(paused.ask.preview.includes('Dear customer'), 'the ask carries what the person is approving');

  assert.ok(ids(events, 'step_completed').includes('draft'), 'work before the pause is done');
  assert.ok(!ids(events, 'step_completed').includes('send'), 'NOTHING past the pause may run');
  assert.ok(!one(events, 'run_completed'), 'a paused run is not a completed run');
});

test('human: resuming from the PERSISTED steps continues without re-running earlier work', async () => {
  let llmCalls = 0;
  const counting = { invoke: async () => { llmCalls++; return { content: 'Dear customer, …' }; } };
  const tester = new FlowTester({ nodeTypes, llm: counting, channelRegistry: stubChannels() });

  // ── First leg: run until the pause. These are exactly the events the
  //    scheduler hands to WorkflowStore.appendStep() — the persisted record.
  const first = await runAll(tester, approvalFlow, { initialContext: 'the inbound email' });
  const checkpoint = one(first, 'run_paused').checkpoint;
  assert.equal(llmCalls, 1, 'draft ran once');

  // ── Second leg: a person approved. Resume from the CHECKPOINT the pause
  //    emitted — which is exactly what the scheduler persists.
  const second = await runAll(tester, approvalFlow, {
    initialContext: 'the inbound email',
    checkpoint,
    decisions: { approve: { decision: 'approve', by: 'user:abc', channel: 'inbox' } },
  });

  assert.ok(!ids(second, 'step_started').includes('draft'), 'a completed step must NOT re-run on resume');
  assert.equal(llmCalls, 1, 'the LLM must not be paid for twice');

  assert.ok(ids(second, 'step_completed').includes('approve'), 'the human step resolves');
  assert.ok(ids(second, 'step_completed').includes('send'), 'the approved path runs');
  assert.ok(ids(second, 'step_skipped').includes('drop'), 'the rejected path is skipped');
  assert.ok(one(second, 'run_completed'), 'the resumed run completes');
});

test('resume: what gets SENT is byte-identical to what the person APPROVED', async () => {
  // THE test the 30/30 suite was missing. The resume test above used a 16-char
  // stub LLM output, so it never crossed _shrinkOutput's 2000-char cap — and the
  // lossy checkpoint was invisible to it.
  //
  // The bug: the checkpoint used to BE the persisted step events, which carry the
  // DISPLAY-SHRUNK output (truncated at 2000 chars, with a literal "…(truncated)"
  // appended, objects JSON-encoded). So a 3363-char drafted reply resumed as 2013
  // chars, and the customer received a mutilated message ending in "…(truncated)"
  // — while the person had approved the whole thing. No error. run_completed.
  //
  // ~400 words is nothing for a drafted email. This was not an edge case.
  const LONG_DRAFT = 'Dear customer, thank you for your detailed enquiry. '.repeat(70);
  assert.ok(LONG_DRAFT.length > 2000, 'the fixture must exceed the shrink cap, or it proves nothing');

  let sentBody = null;
  const channels = stubChannels((args) => { sentBody = args.body; return { delivered: true }; });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm(LONG_DRAFT), channelRegistry: channels });

  const flow = {
    nodes: [
      { id: 'draft',   type: 'llm', config: { prompt: 'Draft a reply.' } },
      { id: 'approve', type: 'human', config: { prompt: 'Send?', preview: '{{draft.output}}', decisions: ['approve', 'reject'] } },
      { id: 'send',    type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'draft', to: 'approve' }, { from: 'approve', to: 'send' }],
  };

  const first  = await runAll(tester, flow, { initialContext: 'an enquiry' });
  const paused = one(first, 'run_paused');
  assert.ok(paused, 'must pause');

  // The step EVENT is allowed to be shrunk — that is what the UI reads.
  const shrunkEvent = first.find(e => e.type === 'step_completed' && e.nodeId === 'draft').output;
  assert.ok(shrunkEvent.length < LONG_DRAFT.length, 'the UI event is still shrunk (that is fine)');

  // The CHECKPOINT must not be.
  assert.equal(paused.checkpoint.outputs.draft, LONG_DRAFT,
    'the checkpoint must carry the FULL output — it is what the run resumes on');

  const second = await runAll(tester, flow, {
    initialContext: 'an enquiry',
    checkpoint: paused.checkpoint,
    decisions: { approve: { decision: 'approve', by: 'user:1' } },
  });
  assert.ok(one(second, 'run_completed'), 'the resumed run completes');

  assert.equal(sentBody, LONG_DRAFT,
    'the customer must receive EXACTLY what the person approved — not a truncated copy');
  assert.ok(!String(sentBody).includes('(truncated)'),
    'a delivered message must never contain the shrink marker');
});

test('human: a REJECT resumes down the other path', async () => {
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('draft'), channelRegistry: stubChannels() });
  const first = await runAll(tester, approvalFlow, { initialContext: 'the inbound email' });
  const second = await runAll(tester, approvalFlow, {
    initialContext: 'the inbound email',
    checkpoint: one(first, 'run_paused').checkpoint,
    decisions: { approve: { decision: 'reject', by: 'user:abc' } },
  });

  assert.ok(ids(second, 'step_completed').includes('drop'), 'the reject path runs');
  assert.ok(ids(second, 'step_skipped').includes('send'), 'the send is skipped');
});

// ── BRANCH-then-HUMAN: the ruled-out path must stay dead across a resume ─────
// Found by the independent verifier. The gate's "human resumes from persisted
// steps" proof was only ever exercised for human-THEN-branch. Reversed, it was
// broken two different ways, and both let the branch the workflow RULED OUT run
// after the resume — i.e. a rejected draft gets sent.
//
//   1. step_completed carries a SHRUNK output, so a branch rehydrated as a
//      STRING: `output.to` was undefined, so propagate() lit EVERY edge.
//   2. Nodes skipped before the pause were lumped in with completed ones, so
//      they relit their own children on the way back through.
const branchThenHumanFlow = {
  nodes: [
    { id: 'classify', type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
    { id: 'route', type: 'branch', config: {
      on: 'classify.output',
      cases: [{ when: 'urgent', to: 'escalate' }, { when: '*', to: 'auto_file' }],
    } },
    { id: 'escalate',  type: 'human', config: { prompt: 'Page the on-call?', decisions: ['approve', 'reject'] } },
    { id: 'auto_file', type: 'deliver', config: { channel: 'in_app', body: 'filed quietly' } },
    { id: 'paged',     type: 'deliver', config: { channel: 'in_app', body: 'PAGED' } },
  ],
  edges: [
    { from: 'classify', to: 'route' },
    { from: 'route', to: 'escalate' },
    { from: 'route', to: 'auto_file' },
    { from: 'escalate', to: 'paged' },
  ],
};

test('resume: a branch ruled out BEFORE the pause stays ruled out after it', async () => {
  let delivered = 0;
  const channels = stubChannels(() => { delivered++; return { delivered: true, ts: '1' }; });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: channels });

  // Leg 1: classify → urgent → route picks `escalate`; `auto_file` is skipped;
  // the run pauses on the human step.
  const first = await runAll(tester, branchThenHumanFlow, { initialContext: 'an alert' });
  assert.ok(one(first, 'run_paused'), 'leg 1 must pause on the human step');
  assert.equal(delivered, 0, 'nothing delivered before the person answered');
  // NOTE: the pause returns before the topological order even reaches
  // `auto_file`, so leg 1 emits no step_skipped for it. That is the HARSHER
  // case — there is no persisted skip to lean on, and the branch's own decision
  // has to survive the round-trip through the shrunk event on its own.
  assert.ok(!ids(first, 'step_completed').includes('auto_file'), 'the untaken path did not run in leg 1');

  // Leg 2: the person approves. `auto_file` was RULED OUT and must stay dead.
  const second = await runAll(tester, branchThenHumanFlow, {
    initialContext: 'an alert',
    checkpoint: one(first, 'run_paused').checkpoint,
    decisions: { escalate: { decision: 'approve', by: 'user:1' } },
  });

  assert.ok(ids(second, 'step_completed').includes('paged'), 'the approved path runs');
  assert.ok(!ids(second, 'step_completed').includes('auto_file'),
    'the RULED-OUT path must NOT run on resume — this is what sent a rejected draft');
  assert.equal(delivered, 1, 'exactly ONE delivery: the paged one. Not the ruled-out auto_file.');
});

test('resume: a rehydrated branch relights ONLY the case it originally picked', async () => {
  // Variant B — the ruled-out node sorts AFTER the pause, so no step_skipped was
  // ever persisted to fall back on. The branch's own decision has to survive the
  // round-trip through the shrunk event, or the untaken path delivers.
  const flow = {
    nodes: [
      { id: 'classify', type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
      { id: 'route', type: 'branch', config: {
        on: 'classify.output',
        cases: [{ when: 'urgent', to: 'ask' }, { when: '*', to: 'auto_send' }],
      } },
      { id: 'ask',       type: 'human',   config: { prompt: 'Send?', decisions: ['approve', 'reject'] } },
      { id: 'auto_send', type: 'deliver', config: { channel: 'in_app', body: 'sent automatically' } },
      { id: 'sent',      type: 'deliver', config: { channel: 'in_app', body: 'sent after approval' } },
    ],
    edges: [
      { from: 'classify', to: 'route' },
      { from: 'route', to: 'ask' },
      { from: 'route', to: 'auto_send' },
      { from: 'ask', to: 'sent' },
    ],
  };
  let delivered = 0;
  const channels = stubChannels(() => { delivered++; return { delivered: true }; });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: channels });

  const first = await runAll(tester, flow, { initialContext: 'x' });
  const second = await runAll(tester, flow, {
    initialContext: 'x',
    checkpoint: one(first, 'run_paused').checkpoint,
    decisions: { ask: { decision: 'approve', by: 'u' } },
  });

  assert.ok(!ids(second, 'step_completed').includes('auto_send'),
    'the ruled-out branch must not deliver on resume, even with no step_skipped persisted');
  assert.equal(delivered, 1, 'exactly one delivery');
});

test('a LIVE branch that produces no route FAILS the run rather than taking every path', async () => {
  // If we can't tell which way a branch went, the one thing we must never do is
  // light every edge — that runs the path it ruled out. Fail loudly instead.
  //
  // (This used to be phrased as a RESUME test, feeding a corrupt branch output in
  // the checkpoint. That is now meaningless by construction: the checkpoint
  // restores the edge liveness directly, so a resume never re-reads a branch's
  // output to decide routing at all. The invariant it protects now lives where it
  // belongs — on the live path.)
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: stubChannels() });
  const events = await runAll(tester, {
    nodes: [
      { id: 'c', type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
      // A case with no `to`. The validator rejects this shape — but the engine
      // must not depend on the validator having run.
      { id: 'r', type: 'branch', config: { on: 'c.output', cases: [{ when: '*' }] } },
      { id: 'a', type: 'deliver', config: { channel: 'in_app', body: 'A' } },
      { id: 'b', type: 'deliver', config: { channel: 'in_app', body: 'B' } },
    ],
    edges: [{ from: 'c', to: 'r' }, { from: 'r', to: 'a' }, { from: 'r', to: 'b' }],
  }, { initialContext: 'an alert' });

  assert.ok(one(events, 'run_failed'), 'a branch with no route must fail the run');
  assert.ok(!ids(events, 'step_completed').includes('a'), 'and must NOT take a path');
  assert.ok(!ids(events, 'step_completed').includes('b'), 'and must NOT take both paths');
});

test('resume: a FAILED step\'s happy path stays dead (route_to lit only the error edge)', async () => {
  // On resume, replaying a done node used to re-run propagate(), which lights ALL
  // of its outgoing edges — but the original leg lit only SOME: an `on_error:
  // route_to` lights ONLY the error target. So the HAPPY path of a step that had
  // FAILED came back to life after the pause, and the run delivered as though the
  // failure never happened — a receipt for a payment that was declined.
  //
  // Liveness is a fact about what happened, not something to recompute from
  // outputs. The checkpoint restores it.
  const failing = { invoke: async () => { throw new Error('card declined'); } };
  const bodies = [];
  const channels = stubChannels((a) => { bodies.push(a.body); return { delivered: true }; });
  const tester = new FlowTester({ nodeTypes, llm: failing, channelRegistry: channels });

  const flow = {
    nodes: [
      { id: 'charge', type: 'llm', config: { prompt: 'charge' }, on_error: { then: 'route_to:ask' } },
      { id: 'ask',    type: 'human', config: { prompt: 'Retry?', decisions: ['approve', 'reject'] } },
      { id: 'happy',  type: 'deliver', config: { channel: 'in_app', body: 'RECEIPT' } },
      { id: 'happy_child', type: 'deliver', config: { channel: 'in_app', body: 'THANKS' } },
      { id: 'done',   type: 'deliver', config: { channel: 'in_app' } },
    ],
    // charge->ask FIRST, so the pause is reached before `happy` in topo order —
    // which means `happy` is NOT in checkpoint.skipped and the only thing keeping
    // it dead is the restored liveness.
    edges: [
      { from: 'charge', to: 'ask' }, { from: 'charge', to: 'happy' },
      { from: 'ask', to: 'done' }, { from: 'happy', to: 'happy_child' },
    ],
  };

  const first = await runAll(tester, flow, { initialContext: 'ORDER EMAIL' });
  const ckpt = one(first, 'run_paused').checkpoint;
  assert.ok(ids(first, 'step_failed').includes('charge'), 'the charge failed');
  assert.ok(!ckpt.skipped.includes('happy'), 'the fixture must NOT lean on checkpoint.skipped');

  bodies.length = 0;
  const second = await runAll(tester, flow, {
    initialContext: 'ORDER EMAIL',
    checkpoint: ckpt,
    decisions: { ask: { decision: 'approve', by: 'u' } },
  });

  assert.ok(!ids(second, 'step_completed').includes('happy'),
    'the happy path of a FAILED step must not come back to life on resume');
  assert.ok(!ids(second, 'step_completed').includes('happy_child'), 'nor its children');
  assert.ok(!bodies.includes('RECEIPT'),
    'the customer must not get a receipt for a payment that was declined');
  assert.equal(bodies.length, 1, 'exactly one delivery — the one on the error path');
});

test('resume: a RESUMED run delivers exactly what the same spec delivers straight through', async () => {
  // Found by the independent verifier. The ONLY difference between these two
  // specs is a `human` step between the failure and the delivery. They must
  // deliver the same body.
  //
  // They didn't. A step with `on_error: route_to` stores the sentinel
  // {error, failed:true} into `outputs` but never promotes it to `lastOutput`.
  // Replaying done nodes on resume DID promote it — it's an `llm` node, so
  // CONTROL_TYPES doesn't exclude it — so `deliver` sent the customer the raw
  // error blob. run_completed, no error. This is the "a non-work-product value
  // becomes lastOutput and reaches the customer" bug, re-entered by a new door.
  const SOURCE = 'THE ORIGINAL ORDER EMAIL';

  const mkFlow = (withPause) => ({
    nodes: [
      { id: 'charge', type: 'llm', config: { prompt: 'Charge the card.' },
        on_error: { then: 'route_to:tell_ops' } },
      { id: 'tell_ops', type: 'deliver', config: { channel: 'in_app', body: 'ops: {{charge.output}}' } },
      ...(withPause ? [{ id: 'ask', type: 'human', config: { prompt: 'Continue?', decisions: ['approve', 'reject'] } }] : []),
      { id: 'done', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: withPause
      ? [{ from: 'charge', to: 'tell_ops' }, { from: 'tell_ops', to: 'ask' }, { from: 'ask', to: 'done' }]
      : [{ from: 'charge', to: 'tell_ops' }, { from: 'tell_ops', to: 'done' }],
  });

  const bodies = [];
  const channels = () => stubChannels((args) => { bodies.push(args.body); return { delivered: true }; });
  const failing = { invoke: async () => { throw new Error('card declined'); } };

  // A — straight through, no pause.
  const a = new FlowTester({ nodeTypes, llm: failing, channelRegistry: channels() });
  await runAll(a, mkFlow(false), { initialContext: SOURCE });
  const straightBody = bodies.at(-1);

  // B — identical, but with a human step between the failure and the delivery.
  bodies.length = 0;
  const b = new FlowTester({ nodeTypes, llm: failing, channelRegistry: channels() });
  const leg1 = await runAll(b, mkFlow(true), { initialContext: SOURCE });
  const paused = one(leg1, 'run_paused');
  assert.ok(paused, 'must pause');

  bodies.length = 0;
  await runAll(b, mkFlow(true), {
    initialContext: SOURCE,
    checkpoint: paused.checkpoint,
    decisions: { ask: { decision: 'approve', by: 'u' } },
  });
  const resumedBody = bodies.at(-1);

  assert.ok(!String(resumedBody).includes('"failed":true'),
    `a resumed delivery must never carry a failed step's error sentinel — got: ${resumedBody}`);
  assert.equal(resumedBody, straightBody,
    'a pause must not change WHAT gets delivered — only when');
});

test('control nodes: a human/branch output never reaches an AI step as its input', async () => {
  // The `lastOutput` half of the control-node fix was pinned; the
  // NON_CONTENT_TYPES half was not — dropping branch/human from that set left
  // all 31 tests green while an `llm` step after an approval ingested
  // `{"decision":"approve","by":"user:1",…}` as its model input.
  const seen = [];
  const spy = {
    invoke: async (msgs) => { seen.push(String(msgs[1].content)); return { content: 'ok' }; },
  };
  const tester = new FlowTester({ nodeTypes, llm: spy, channelRegistry: stubChannels() });

  const flow = {
    nodes: [
      { id: 'draft',   type: 'llm', config: { prompt: 'Draft it.' } },
      { id: 'approve', type: 'human', config: { prompt: 'ok?', decisions: ['approve', 'reject'] } },
      { id: 'polish',  type: 'llm', config: { mode: 'rewrite', format: 'email' } },
      { id: 'send',    type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'draft', to: 'approve' }, { from: 'approve', to: 'polish' }, { from: 'polish', to: 'send' }],
  };

  const first = await runAll(tester, flow, { initialContext: 'an enquiry' });
  await runAll(tester, flow, {
    initialContext: 'an enquiry',
    checkpoint: one(first, 'run_paused').checkpoint,
    decisions: { approve: { decision: 'approve', by: 'user:1' } },
  });

  const polishPrompt = seen.at(-1);
  assert.ok(!polishPrompt.includes('"decision"'),
    `an AI step must never ingest the approval record as content; got: ${polishPrompt.slice(0, 200)}`);
  assert.ok(!polishPrompt.includes('user:1'), 'the approver identity is audit metadata, not content');
});

test('resume: a checkpoint with a NON-EMPTY skipped[] keeps those nodes dead', async () => {
  // No prior test ever produced a non-empty checkpoint.skipped — the
  // branch-then-human tests pause before the topo order reaches the untaken
  // target. So lumping ckpt.skipped into doneOutputs left all 31 green while a
  // skipped node relit its own children on resume. Force the ordering.
  const flow = {
    nodes: [
      { id: 'classify',  type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
      { id: 'route',     type: 'branch', config: {
        on: 'classify.output',
        cases: [{ when: 'urgent', to: 'urgent_path' }, { when: '*', to: 'quiet_path' }],
      } },
      // `quiet_path` sorts BEFORE the human step, so leg 1 really does emit a
      // step_skipped for it — that is what puts an entry in checkpoint.skipped.
      { id: 'quiet_path', type: 'llm', config: { prompt: 'file quietly' } },
      { id: 'quiet_send', type: 'deliver', config: { channel: 'in_app', body: 'QUIET' } },
      { id: 'urgent_path', type: 'llm', config: { prompt: 'escalate' } },
      { id: 'ask',        type: 'human', config: { prompt: 'page?', decisions: ['approve', 'reject'] } },
      { id: 'paged',      type: 'deliver', config: { channel: 'in_app', body: 'PAGED' } },
    ],
    edges: [
      { from: 'classify', to: 'route' },
      { from: 'route', to: 'urgent_path' },
      { from: 'route', to: 'quiet_path' },
      { from: 'quiet_path', to: 'quiet_send' },
      { from: 'urgent_path', to: 'ask' },
      { from: 'ask', to: 'paged' },
    ],
  };
  let delivered = [];
  const channels = stubChannels((a) => { delivered.push(a.body); return { delivered: true }; });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: channels });

  const first = await runAll(tester, flow, { initialContext: 'alert' });
  const ckpt = one(first, 'run_paused').checkpoint;
  assert.ok(ckpt.skipped.includes('quiet_path'),
    'the fixture must actually produce a non-empty checkpoint.skipped, or it proves nothing');

  delivered = [];
  const second = await runAll(tester, flow, {
    initialContext: 'alert',
    checkpoint: ckpt,
    decisions: { ask: { decision: 'approve', by: 'u' } },
  });

  assert.ok(!ids(second, 'step_completed').includes('quiet_send'),
    'a node downstream of a SKIPPED node must not come back to life on resume');
  assert.ok(ids(second, 'step_skipped').includes('quiet_send'),
    'the dead subtree stays dead through the resume');
  assert.ok(ids(second, 'step_completed').includes('paged'), 'the live path still runs');
  assert.equal(delivered.length, 1,
    'exactly ONE delivery — the ruled-out branch must not deliver on resume');
});

test('resume: a node already recorded as skipped is not re-reported as skipped', async () => {
  // What keeps a ruled-out node DEAD across a resume is the RESTORED LIVENESS,
  // not `checkpoint.skipped` — nothing lit it, so its liveInto stays 0. The
  // skipped[] list exists only so the same node isn't appended to
  // workflow_runs.steps as `step_skipped` twice. Pin that, honestly, rather than
  // leave an unpinned guard whose comment claims a job it no longer does.
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: stubChannels() });
  const first  = await runAll(tester, branchThenHumanFlow, { initialContext: 'an alert' });
  const ckpt   = one(first, 'run_paused').checkpoint;

  // Force a non-empty skipped[] by hand — the branch-then-human fixture pauses
  // before the topo order reaches the untaken target, so it produces none.
  ckpt.skipped = ['auto_file'];

  const second = await runAll(tester, branchThenHumanFlow, {
    initialContext: 'an alert',
    checkpoint: ckpt,
    decisions: { escalate: { decision: 'approve', by: 'u' } },
  });

  assert.ok(!ids(second, 'step_skipped').includes('auto_file'),
    'a node already recorded as skipped must not be reported skipped a second time');
  assert.ok(!ids(second, 'step_completed').includes('auto_file'),
    'and it must still be dead');
});

test('human: an approval can never DEFAULT — the node refuses to evaluate without a decision', async () => {
  // Belt and braces: if a future caller ever dispatches a `human` node directly,
  // bypassing the pause, it must throw rather than quietly evaluate to approved.
  const def = nodeTypes.get('human');
  await assert.rejects(
    () => def.run({ decisions: ['approve', 'reject'] }, {}, {}),
    /no decision/i,
    'a human step with no answer must never resolve to an approval',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. §11.2 — THE NON-REGRESSION CONTRACT.
//    Every workflow in production today has no control flow in it.
// ─────────────────────────────────────────────────────────────────────────────
test('§11.2: a spec with NO control flow executes exactly as before', async () => {
  const plain = {
    nodes: [
      { id: 'sum',  type: 'llm', config: { mode: 'summarize', instructions: 'be brief' } },
      { id: 'post', type: 'deliver', config: { channel: 'in_app', title: 'T' } },
    ],
    edges: [{ from: 'sum', to: 'post' }],
  };
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('a summary'), channelRegistry: stubChannels() });
  const events = await runAll(tester, plain, { initialContext: 'the source text' });

  // Same event sequence the old executor produced: no skips, no pauses, and
  // every node runs in topological order.
  assert.deepEqual(
    events.map(e => e.type),
    ['run_started', 'step_started', 'step_completed', 'step_started', 'step_completed', 'run_completed'],
  );
  assert.equal(events.filter(e => e.type === 'step_skipped').length, 0, 'nothing is skipped without a branch');
  assert.equal(events.filter(e => e.type === 'run_paused').length, 0, 'nothing pauses without a human step');
  assert.ok(one(events, 'run_completed'));
});

test('§11.2: a v1 spec (pre-re-cut node types) still runs through the new executor', async () => {
  const v1 = {
    nodes: [
      { id: 'sum',  type: 'summarize', config: { instructions: 'be brief', format: 'plain' } },
      { id: 'post', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'sum', to: 'post' }],
  };
  const events = await runAll(new FlowTester({ nodeTypes, llm: stubLlm('s'), channelRegistry: stubChannels() }), v1, {
    initialContext: 'text',
  });
  assert.ok(one(events, 'run_completed'), 'a v1 spec must still complete');
  assert.equal(events.filter(e => e.type === 'step_skipped').length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. on_error — retry, then route or escalate.
// ─────────────────────────────────────────────────────────────────────────────
test('on_error: retries the declared number of times, then succeeds', async () => {
  let attempts = 0;
  const flaky = { invoke: async () => {
    attempts++;
    if (attempts < 3) throw new Error('503 upstream');
    return { content: 'ok' };
  } };

  const events = await runAll(new FlowTester({ nodeTypes, llm: flaky, channelRegistry: stubChannels() }), {
    nodes: [
      { id: 'x', type: 'llm', config: { prompt: 'go' }, on_error: { retry: 2 } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'x', to: 'd' }],
  });

  assert.equal(attempts, 3, 'retry:2 means up to 3 attempts');
  assert.equal(events.filter(e => e.type === 'step_retry').length, 2);
  assert.ok(one(events, 'run_completed'), 'the run recovers');
});

test('on_error: route_to sends the run down a declared failure path instead of dying', async () => {
  const events = await runAll(new FlowTester({ nodeTypes, llm: { invoke: async () => { throw new Error('boom'); } }, channelRegistry: stubChannels() }), {
    nodes: [
      { id: 'x',     type: 'llm', config: { prompt: 'go' }, on_error: { then: 'route_to:tell_ops' } },
      { id: 'happy', type: 'deliver', config: { channel: 'in_app' } },
      // An error-path delivery must template in WHAT failed. deliver refuses to
      // send when no content step produced output — that guard is why a broken
      // run doesn't quietly ship an empty message.
      { id: 'tell_ops', type: 'deliver', config: { channel: 'in_app', title: 'It broke', body: 'Step failed: {{x.output}}' } },
    ],
    edges: [{ from: 'x', to: 'happy' }, { from: 'x', to: 'tell_ops' }],
  });

  assert.ok(ids(events, 'step_failed').includes('x'), 'the failure is still reported');
  assert.ok(ids(events, 'step_completed').includes('tell_ops'), 'the error path runs');
  assert.ok(!ids(events, 'step_completed').includes('happy'), 'the happy path must NOT run after a failure');
  assert.ok(one(events, 'run_completed'), 'a handled failure does not kill the run');
});

test('on_error: escalate marks the failure as needing a person', async () => {
  const events = await runAll(new FlowTester({ nodeTypes, llm: { invoke: async () => { throw new Error('boom'); } }, channelRegistry: stubChannels() }), {
    nodes: [
      { id: 'x', type: 'llm', config: { prompt: 'go' }, on_error: { then: 'escalate' } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'x', to: 'd' }],
  });
  const failed = one(events, 'run_failed');
  assert.ok(failed, 'it still fails');
  assert.equal(failed.escalated, true, 'and it is flagged for a human, not lost in a log');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. idempotency — a re-fired trigger must not write twice.
// ─────────────────────────────────────────────────────────────────────────────
test('idempotency: a re-fired trigger does not run the write a second time', async () => {
  const store = new IdempotencyStore({ dbPath: ':memory:' }).init();
  let writes = 0;

  const channelRegistry = stubChannels(async () => { writes++; return { id: `rec_${writes}` }; }, { actionOnly: true });
  const flow = {
    nodes: [
      { id: 'create', type: 'connector-action',
        config: { action: 'airtable_create_record', email: 'alice@acme.com' },
        idempotency: { key: 'alice@acme.com', on_conflict: 'skip' } },
    ],
    edges: [],
  };
  const tester = new FlowTester({ nodeTypes, llm: stubLlm(), channelRegistry, idempotencyStore: store });

  const first  = await runAll(tester, flow, { workflowId: 'wf1' });
  const second = await runAll(tester, flow, { workflowId: 'wf1' });   // the trigger re-fires

  assert.equal(writes, 1, 'the connector must be called exactly ONCE across both runs');
  assert.ok(one(first, 'run_completed'));
  assert.ok(one(second, 'run_completed'), 'the second run still completes — it just does not write');

  // And the deduplicated run still SEES the record the first run made, so
  // downstream steps have their input.
  assert.deepEqual(outputOf(second, 'create'), { id: 'rec_1' },
    'the skipped step returns the FIRST run\'s output, not a fresh one');
  store.close();
});

test('idempotency: a different key writes again', async () => {
  const store = new IdempotencyStore({ dbPath: ':memory:' }).init();
  let writes = 0;
  const channelRegistry = stubChannels(async () => { writes++; return { id: writes }; }, { actionOnly: true });
  const mk = (email) => ({
    nodes: [{ id: 'create', type: 'connector-action', config: { action: 'a' },
              idempotency: { key: email, on_conflict: 'skip' } }],
    edges: [],
  });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm(), channelRegistry, idempotencyStore: store });

  await runAll(tester, mk('alice@acme.com'), { workflowId: 'wf1' });
  await runAll(tester, mk('bob@acme.com'),   { workflowId: 'wf1' });

  assert.equal(writes, 2, 'two different keys are two different things — both must be written');
  store.close();
});

test('idempotency: declaring a key with no store wired is an ERROR, not a silent no-op', async () => {
  const channelRegistry = stubChannels(async () => ({}), { actionOnly: true });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm(), channelRegistry });   // no idempotencyStore
  const events = await runAll(tester, {
    nodes: [{ id: 'create', type: 'connector-action', config: { action: 'a' },
              idempotency: { key: 'k', on_conflict: 'skip' } }],
    edges: [],
  });
  const failed = one(events, 'run_failed');
  assert.ok(failed, 'it must fail loudly');
  assert.match(failed.error, /idempotency store/i,
    'a step that claims to deduplicate and cannot must refuse to run');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The validator — NON_EXHAUSTIVE_BRANCH and friends.
// ─────────────────────────────────────────────────────────────────────────────
const validator = new WorkflowValidator({ nodeTypes });
const spec = (nodes, edges) => ({
  name: 'w', triggers: [{ type: 'email', filter: 'x' }], nodes, edges,
});
const codesOf = (r) => r.errors.map(i => i.code);

test('NON_EXHAUSTIVE_BRANCH: a branch with no catch-all is rejected', () => {
  const res = validator.validate(spec(
    [
      { id: 'c', type: 'llm', config: { mode: 'classify', categories: 'a\nb' } },
      { id: 'r', type: 'branch', config: { on: 'c.output', cases: [{ when: 'a', to: 'd' }] } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'c', to: 'r' }, { from: 'r', to: 'd' }],
  ));
  assert.ok(!res.ok);
  assert.ok(codesOf(res).includes('NON_EXHAUSTIVE_BRANCH'),
    `a branch that can silently fall through must be rejected; got ${codesOf(res).join(', ')}`);
});

test('NON_EXHAUSTIVE_BRANCH: a branch WITH a catch-all validates', () => {
  const res = validator.validate(spec(
    [
      { id: 'c', type: 'llm', config: { mode: 'classify', categories: 'a\nb' } },
      { id: 'r', type: 'branch', config: { on: 'c.output', cases: [{ when: 'a', to: 'd' }, { when: '*', to: 'e' }] } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
      { id: 'e', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'c', to: 'r' }, { from: 'r', to: 'd' }, { from: 'r', to: 'e' }],
  ));
  assert.ok(res.ok, `got: ${codesOf(res).join(', ')}`);
});

test('BRANCH_CASE_NO_EDGE: a case with no edge would run unconditionally — rejected', () => {
  const res = validator.validate(spec(
    [
      { id: 'c', type: 'llm', config: { mode: 'classify', categories: 'a\nb' } },
      { id: 'r', type: 'branch', config: { on: 'c.output', cases: [{ when: '*', to: 'd' }] } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'c', to: 'r' }],   // NO edge r → d
  ));
  assert.ok(codesOf(res).includes('BRANCH_CASE_NO_EDGE'), `got: ${codesOf(res).join(', ')}`);
});

test('the SNEAK PATH: a ruled-out branch target does not run just because something else feeds it', async () => {
  // Found by the independent verifier. `b1` is the branch's UNTAKEN case, but it
  // also has an edge from `c`. That edge is live whichever way the branch went,
  // so on pure edge-liveness `b1` runs anyway — and the branch has decided
  // nothing. A ruled-out target must be DEAD, not merely unlit.
  const flow = {
    nodes: [
      { id: 'c',  type: 'llm', config: { mode: 'classify', categories: 'a\nb' } },
      { id: 'r',  type: 'branch', config: { on: 'c.output', cases: [{ when: 'a', to: 'a1' }, { when: '*', to: 'b1' }] } },
      { id: 'a1', type: 'llm', config: { prompt: 'A' } },
      { id: 'b1', type: 'llm', config: { prompt: 'B' } },
    ],
    edges: [
      { from: 'c', to: 'r' },
      { from: 'r', to: 'a1' },
      { from: 'r', to: 'b1' },
      { from: 'c', to: 'b1' },        // ← the sneak path
    ],
  };
  const events = await runAll(
    new FlowTester({ nodeTypes, llm: stubLlm('a'), channelRegistry: stubChannels() }),
    flow, { initialContext: 'x' },
  );
  assert.ok(ids(events, 'step_completed').includes('a1'), 'the selected path runs');
  assert.ok(!ids(events, 'step_completed').includes('b1'),
    'the RULED-OUT path must not run, even though another live edge feeds it');
  assert.ok(ids(events, 'step_skipped').includes('b1'));

  // And the ambiguity is rejected at BUILD time, so it can't reach the engine.
  const res = validator.validate(spec(flow.nodes.concat([{ id: 'd', type: 'deliver', config: { channel: 'in_app' } }]),
                                      flow.edges.concat([{ from: 'a1', to: 'd' }])));
  assert.ok(codesOf(res).includes('BRANCH_TARGET_EXTRA_PARENT'), `got: ${codesOf(res).join(', ')}`);
});

test('ON_ERROR_ROUTE_NO_EDGE: the CORRECT shape is ACCEPTED (the negative test alone is vacuous)', () => {
  // The negative test below passed while the check was firing on EVERY route_to
  // — the edge-key was built with a literal NUL at one site and a space at
  // another, so it never matched and `route_to` was unpublishable. A test that
  // only asserts the rejection would still pass if the check were `if (true)`.
  // Assert the acceptance too, or you have not tested the check.
  const res = validator.validate(spec(
    [
      { id: 'x', type: 'llm', config: { prompt: 'go' }, on_error: { then: 'route_to:tell_ops' } },
      { id: 'happy', type: 'deliver', config: { channel: 'in_app' } },
      { id: 'tell_ops', type: 'deliver', config: { channel: 'in_app', body: 'broke: {{x.output}}' } },
    ],
    [{ from: 'x', to: 'happy' }, { from: 'x', to: 'tell_ops' }],   // the edge IS present
  ));
  assert.ok(res.ok, `a correctly-wired failure path must VALIDATE; got: ${codesOf(res).join(', ')}`);
});

test('ON_ERROR_ROUTE_NO_EDGE: a failure path with no edge would never run — rejected', () => {
  // Without an edge, the target usually sorts BEFORE the failing node and has
  // already run — so the error path silently never executes and the workflow
  // reports success. Found by the independent verifier.
  const res = validator.validate(spec(
    [
      { id: 'x', type: 'llm', config: { prompt: 'go' }, on_error: { then: 'route_to:tell_ops' } },
      { id: 'tell_ops', type: 'deliver', config: { channel: 'in_app', body: 'broke' } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'x', to: 'd' }],   // no edge x → tell_ops
  ));
  assert.ok(codesOf(res).includes('ON_ERROR_ROUTE_NO_EDGE'), `got: ${codesOf(res).join(', ')}`);
});

test('WRITE_WITHOUT_IDEMPOTENCY: a create with no key warns (but does not block)', () => {
  const res = validator.validate(spec(
    [
      { id: 'c', type: 'connector-action', config: { action: 'airtable_create_record' } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'c', to: 'd' }],
  ));
  assert.ok(res.ok, 'it is a warning, not an error — plenty of writes are naturally idempotent');
  assert.ok(res.warnings.some(w => w.code === 'WRITE_WITHOUT_IDEMPOTENCY'));
});

test('{{item}} outside a foreach is a build-time error, not an empty string at run time', () => {
  const res = validator.validate(spec(
    [
      { id: 'x', type: 'llm', config: { prompt: 'Handle {{item}}' } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'x', to: 'd' }],
  ));
  assert.ok(codesOf(res).includes('BAD_TEMPLATE_REF'), `got: ${codesOf(res).join(', ')}`);
});

test('ON_ERROR_BAD_TARGET: routing failures to a step that does not exist is rejected', () => {
  const res = validator.validate(spec(
    [
      { id: 'x', type: 'llm', config: { prompt: 'go' }, on_error: { then: 'route_to:nowhere' } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'x', to: 'd' }],
  ));
  assert.ok(codesOf(res).includes('ON_ERROR_BAD_TARGET'), `got: ${codesOf(res).join(', ')}`);
});

// ── POSITIVE cases ──────────────────────────────────────────────────────────
// Every rule below had a rejection test and no acceptance test. A negative-only
// test would still pass if the check were `if (true)` — which is exactly how
// ON_ERROR_ROUTE_NO_EDGE shipped rejecting every valid spec. Assert the GOOD
// shape is accepted, or you have not tested the check.
test('positive: a well-formed foreach validates', () => {
  const res = validator.validate(spec(
    [
      { id: 'rows', type: 'connector-action', config: { action: 'airtable_search_records' } },
      { id: 'loop', type: 'foreach', config: {
        over: 'rows.output',
        maxItems: 25,
        steps: [{ id: 's', type: 'llm', config: { prompt: 'Handle {{item}} (#{{index}})' } }],
      } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'rows', to: 'loop' }, { from: 'loop', to: 'd' }],
  ));
  assert.ok(res.ok, `a good foreach — including {{item}}/{{index}} — must validate; got: ${codesOf(res).join(', ')}`);
});

test('positive: a well-formed human step validates', () => {
  const res = validator.validate(spec(
    [
      { id: 'draft', type: 'llm', config: { prompt: 'draft' } },
      { id: 'ask',   type: 'human', config: { prompt: 'Send it?', preview: '{{draft.output}}', decisions: ['approve', 'reject'] } },
      { id: 'd',     type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'draft', to: 'ask' }, { from: 'ask', to: 'd' }],
  ));
  assert.ok(res.ok, `a good human step must validate; got: ${codesOf(res).join(', ')}`);
});

test('positive: a branch whose targets are reached ONLY through it validates', () => {
  // The mirror of BRANCH_TARGET_EXTRA_PARENT. `c` feeds the branch, not the
  // targets — so the routing is unambiguous.
  const res = validator.validate(spec(
    [
      { id: 'c',  type: 'llm', config: { mode: 'classify', categories: 'a\nb' } },
      { id: 'r',  type: 'branch', config: { on: 'c.output', cases: [{ when: 'a', to: 'a1' }, { when: '*', to: 'b1' }] } },
      { id: 'a1', type: 'deliver', config: { channel: 'in_app', body: 'A' } },
      { id: 'b1', type: 'deliver', config: { channel: 'in_app', body: 'B' } },
    ],
    [{ from: 'c', to: 'r' }, { from: 'r', to: 'a1' }, { from: 'r', to: 'b1' }],
  ));
  assert.ok(res.ok, `an unambiguous branch must validate; got: ${codesOf(res).join(', ')}`);
});

test('NESTED_FOREACH / HUMAN_IN_FOREACH are rejected', () => {
  const nested = validator.validate(spec(
    [
      { id: 'l', type: 'foreach', config: { over: 'x.output', steps: [{ id: 'i', type: 'foreach', config: { over: 'y', steps: [] } }] } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'l', to: 'd' }],
  ));
  assert.ok(codesOf(nested).includes('NESTED_FOREACH'));

  const withHuman = validator.validate(spec(
    [
      { id: 'l', type: 'foreach', config: { over: 'x.output', steps: [{ id: 'h', type: 'human', config: { prompt: 'ok?' } }] } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'l', to: 'd' }],
  ));
  assert.ok(codesOf(withHuman).includes('HUMAN_IN_FOREACH'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. No NUL bytes in source. CLAUDE.md has a Known-gotchas entry about exactly
//    this: a single stray \x00 in `server.js` makes macOS grep report "Binary
//    file matches" and return nothing, which once convinced an agent the engine
//    had been deleted. P12 Increment B re-created it in workflow-validator.js —
//    a NUL used as an edge-key separator, invisible in the editor and in the
//    diff, which silently failed to match the one site that used a space and
//    made `on_error: route_to` unpublishable. Never again, mechanically.
// ─────────────────────────────────────────────────────────────────────────────
test('no source file contains a NUL byte', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(entry)) continue;
      if (readFileSync(p).includes(0x00)) offenders.push(p);
    }
  };
  walk('src');
  assert.deepEqual(offenders, [],
    `NUL bytes break grep and hide bugs — see CLAUDE.md, "server.js encoding". Found in: ${offenders.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Round-5 findings. Every one of these was GREEN at 40/40 while broken.
// ─────────────────────────────────────────────────────────────────────────────

test('foreach: a sub-step declaring idempotency with NO store REFUSES to run', async () => {
  // The guarantee was inverted in the one place it matters most. A write in a
  // loop is N writes per fire — the highest-risk write shape the engine has, and
  // the whole reason foreach exists — and it was the ONLY shape where declaring
  // an idempotency key did nothing: `foreach` called the RAW dispatcher, skipping
  // the policy path entirely. It wrote twice and reported success, while the
  // identical node at top level refused to run.
  let writes = 0;
  const channels = stubChannels(() => { writes++; return { id: writes }; }, { actionOnly: true });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm(), channelRegistry: channels });  // NO store

  const events = await runAll(tester, {
    nodes: [{ id: 'loop', type: 'foreach', config: {
      over: JSON.stringify(['a', 'b']),
      steps: [{ id: 'create', type: 'connector-action', config: { action: 'airtable_create_record' },
                idempotency: { key: '{{item}}', on_conflict: 'skip' } }],
    } }],
    edges: [],
  }, { workflowId: 'wf1' });

  assert.ok(one(events, 'run_failed'), 'it must fail loudly, exactly as a top-level node does');
  assert.equal(writes, 0, 'and it must NOT have written anything');
});

test('foreach: a re-fired trigger does not re-write the same items', async () => {
  const store = new IdempotencyStore({ dbPath: ':memory:' }).init();
  let writes = 0;
  const channels = stubChannels(() => { writes++; return { id: writes }; }, { actionOnly: true });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm(), channelRegistry: channels, idempotencyStore: store });

  const flow = {
    nodes: [{ id: 'loop', type: 'foreach', config: {
      over: JSON.stringify(['alice@acme.com', 'bob@acme.com']),
      steps: [{ id: 'create', type: 'connector-action', config: { action: 'airtable_create_record' },
                idempotency: { key: '{{item}}', on_conflict: 'skip' } }],
    } }],
    edges: [],
  };

  await runAll(tester, flow, { workflowId: 'wf1' });
  assert.equal(writes, 2, 'first fire writes both rows');
  await runAll(tester, flow, { workflowId: 'wf1' });   // the trigger re-fires
  assert.equal(writes, 2, 'the re-fire must write NOTHING — not 2 more rows');
  store.close();
});

test('foreach: {{item}} REALLY binds — not by accident via lastOutput', async () => {
  // The old test asserted the item appeared in the prompt. It did — but via
  // `llm`'s auto-injection of lastOutput, NOT via {{item}}, which was being
  // substituted to an empty string before the loop even started. A marker the
  // auto-injection cannot produce is the only way to tell the two apart.
  const seen = [];
  const spy = { invoke: async (msgs) => { seen.push(String(msgs[1].content)); return { content: 'ok' }; } };
  const tester = new FlowTester({ nodeTypes, llm: spy, channelRegistry: stubChannels() });

  await runAll(tester, {
    nodes: [{ id: 'loop', type: 'foreach', config: {
      over: JSON.stringify(['alpha', 'beta']),
      steps: [{ id: 's', type: 'llm', config: { prompt: 'Handle ITEM=[{{item}}] IDX=[{{index}}]' } }],
    } }],
    edges: [],
  });

  assert.ok(seen.some(p => p.includes('ITEM=[alpha]') && p.includes('IDX=[0]')),
    `{{item}}/{{index}} must actually bind; prompts were: ${JSON.stringify(seen)}`);
  assert.ok(seen.some(p => p.includes('ITEM=[beta]') && p.includes('IDX=[1]')));
});

test('BRANCH_BAD_ON: a typo in what a branch routes on is rejected', () => {
  // One letter. Not a template, so BAD_TEMPLATE_REF never fires. The engine took
  // it as a literal, nothing matched, and the MANDATORY catch-all then swallowed
  // 100% of traffic forever — run_completed, no warning. The catch-all that
  // exists to prevent a silent misroute was masking one.
  const res = validator.validate(spec(
    [
      { id: 'classify', type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
      { id: 'route', type: 'branch', config: {
        on: 'clasify.output',                                   // ← typo
        cases: [{ when: 'urgent', to: 'page' }, { when: '*', to: 'file_it' }] } },
      { id: 'page',    type: 'deliver', config: { channel: 'in_app', body: 'P' } },
      { id: 'file_it', type: 'deliver', config: { channel: 'in_app', body: 'F' } },
    ],
    [{ from: 'classify', to: 'route' }, { from: 'route', to: 'page' }, { from: 'route', to: 'file_it' }],
  ));
  assert.ok(codesOf(res).includes('BRANCH_BAD_ON'), `got: ${codesOf(res).join(', ') || '(none)'}`);
});

test('positive: a branch routing on a real step validates (BRANCH_BAD_ON is not `if (true)`)', () => {
  const res = validator.validate(spec(
    [
      { id: 'classify', type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
      { id: 'route', type: 'branch', config: {
        on: 'classify.output',
        cases: [{ when: 'urgent', to: 'page' }, { when: '*', to: 'file_it' }] } },
      { id: 'page',    type: 'deliver', config: { channel: 'in_app', body: 'P' } },
      { id: 'file_it', type: 'deliver', config: { channel: 'in_app', body: 'F' } },
    ],
    [{ from: 'classify', to: 'route' }, { from: 'route', to: 'page' }, { from: 'route', to: 'file_it' }],
  ));
  assert.ok(res.ok, `a correct branch must validate; got: ${codesOf(res).join(', ')}`);
});

test('WRITE_WITHOUT_IDEMPOTENCY also warns for a write INSIDE a loop', () => {
  const res = validator.validate(spec(
    [
      { id: 'loop', type: 'foreach', config: {
        over: 'rows.output',
        steps: [{ id: 'c', type: 'connector-action', config: { action: 'airtable_create_record' } }],
      } },
      { id: 'rows', type: 'connector-action', config: { action: 'airtable_search_records' } },
      { id: 'd', type: 'deliver', config: { channel: 'in_app' } },
    ],
    [{ from: 'rows', to: 'loop' }, { from: 'loop', to: 'd' }],
  ));
  assert.ok(res.warnings.some(w => w.code === 'WRITE_WITHOUT_IDEMPOTENCY'),
    'N writes per fire is the riskiest write shape there is — it must not be the only unwarned one');
});

// ── The two guards I claimed to have mutation-tested, and had not ────────────

test('resume: dropping checkpoint.ruledOut would revive a ruled-out branch (pinned)', async () => {
  // The ruled-out target sorts AFTER the pause (so it is NOT in skipped[]) and has
  // a SECOND parent downstream of the pause (so restored liveness alone does not
  // keep it dark). Only `ruledOut` does. Without this test, ruledOut could be
  // deleted from the checkpoint with the whole suite still green.
  const flow = {
    nodes: [
      { id: 'c',     type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
      { id: 'r',     type: 'branch', config: { on: 'c.output',
        cases: [{ when: 'urgent', to: 'ask' }, { when: '*', to: 'B' }] } },
      { id: 'ask',   type: 'human', config: { prompt: 'ok?', decisions: ['approve', 'reject'] } },
      { id: 'extra', type: 'llm', config: { prompt: 'more' } },
      { id: 'B',     type: 'deliver', config: { channel: 'in_app', body: 'RULED-OUT' } },
    ],
    edges: [
      { from: 'c', to: 'r' }, { from: 'r', to: 'ask' }, { from: 'r', to: 'B' },
      { from: 'ask', to: 'extra' }, { from: 'extra', to: 'B' },   // B's second parent
    ],
  };
  const delivered = [];
  const channels = stubChannels((a) => { delivered.push(a.body); return { delivered: true }; });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: channels });

  const first = await runAll(tester, flow, { initialContext: 'alert' });
  const ckpt = one(first, 'run_paused').checkpoint;
  assert.ok(ckpt.ruledOut.includes('B'), 'the fixture must exercise ruledOut, or it proves nothing');
  assert.ok(!ckpt.skipped.includes('B'), 'and must NOT be leaning on skipped[]');

  const second = await runAll(tester, flow, {
    initialContext: 'alert', checkpoint: ckpt,
    decisions: { ask: { decision: 'approve', by: 'u' } },
  });

  assert.ok(!ids(second, 'step_completed').includes('B'),
    'the ruled-out branch must NOT run on resume');
  assert.equal(delivered.length, 0, 'and must NOT deliver');
});

test('resume: recomputing lastOutput on replay would deliver a failed step\'s error blob (pinned)', async () => {
  // Asserts the DELIVERED BODY, not that the node ran. Asserting it ran is what
  // let this ship: `deliver` sends ctx.lastOutput, and a failed step's
  // {error, failed:true} sentinel was being promoted to it on replay.
  const bodies = [];
  const channels = stubChannels((a) => { bodies.push(a.body); return { delivered: true }; });
  let calls = 0;
  const llm = { invoke: async () => {
    calls++;
    if (calls === 1) throw new Error('card declined');
    return { content: 'Dear customer, here is the reply you approved.' };
  } };
  const tester = new FlowTester({ nodeTypes, llm, channelRegistry: channels });

  const flow = {
    nodes: [
      { id: 'charge', type: 'llm', config: { prompt: 'charge' }, on_error: { then: 'route_to:ask' } },
      { id: 'ask',    type: 'human', config: { prompt: 'Reply anyway?', decisions: ['approve', 'reject'] } },
      { id: 'draft',  type: 'llm', config: { prompt: 'draft a reply' } },
      { id: 'notify', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'charge', to: 'ask' }, { from: 'ask', to: 'draft' }, { from: 'draft', to: 'notify' }],
  };

  const first = await runAll(tester, flow, { initialContext: 'ORDER' });
  bodies.length = 0;
  await runAll(tester, flow, {
    initialContext: 'ORDER',
    checkpoint: one(first, 'run_paused').checkpoint,
    decisions: { ask: { decision: 'approve', by: 'u' } },
  });

  assert.equal(bodies.length, 1, 'one delivery');
  assert.ok(!String(bodies[0]).includes('"failed":true'),
    `a delivery must never carry a failed step's error sentinel — got: ${bodies[0]}`);
  assert.match(String(bodies[0]), /reply you approved/, 'it must carry the actual work product');
});

test('engine: a branch routing on a step that produced nothing FAILS, not falls through', async () => {
  // The validator rejects this shape (BRANCH_BAD_ON) — but the engine must not
  // depend on the validator having run: specs already in the database predate
  // the rule. Falling through to the catch-all would silently misroute every run.
  const delivered = [];
  const channels = stubChannels((a) => { delivered.push(a.body); return { delivered: true }; });
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: channels });

  const events = await runAll(tester, {
    nodes: [
      { id: 'classify', type: 'llm', config: { mode: 'classify', categories: 'urgent\nroutine' } },
      { id: 'route', type: 'branch', config: {
        on: 'clasify.output',                                   // ← typo: no such step
        cases: [{ when: 'urgent', to: 'page' }, { when: '*', to: 'file_it' }] } },
      { id: 'page',    type: 'deliver', config: { channel: 'in_app', body: 'P' } },
      { id: 'file_it', type: 'deliver', config: { channel: 'in_app', body: 'F' } },
    ],
    edges: [{ from: 'classify', to: 'route' }, { from: 'route', to: 'page' }, { from: 'route', to: 'file_it' }],
  }, { initialContext: 'an alert' });

  const failed = one(events, 'run_failed');
  assert.ok(failed, 'it must fail loudly rather than quietly take the catch-all');
  assert.match(failed.error, /no step "clasify" produced a value/i);
  assert.equal(delivered.length, 0, 'and must deliver nothing down a misrouted path');
});
