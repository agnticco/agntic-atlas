/**
 * P12 Increment B — engine control flow.
 *
 * The four things the gate demands (scripts/gates/p12.sh):
 *   1. `branch` skips the non-selected subtree
 *   2. `foreach` bounds at maxItems
 *   3. `human` pauses and RESUMES FROM PERSISTED STEPS
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
//    §7.4: no checkpointer. The store's persisted steps ARE the checkpoint.
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
  const persisted = first.filter(e => ['step_completed', 'step_skipped'].includes(e.type));
  assert.equal(llmCalls, 1, 'draft ran once');

  // ── Second leg: a person approved. Resume from what was persisted.
  const second = await runAll(tester, approvalFlow, {
    initialContext: 'the inbound email',
    resumeSteps: persisted,
    decisions: { approve: { decision: 'approve', by: 'user:abc', channel: 'inbox' } },
  });

  assert.ok(!ids(second, 'step_started').includes('draft'), 'a completed step must NOT re-run on resume');
  assert.equal(llmCalls, 1, 'the LLM must not be paid for twice');

  assert.ok(ids(second, 'step_completed').includes('approve'), 'the human step resolves');
  assert.ok(ids(second, 'step_completed').includes('send'), 'the approved path runs');
  assert.ok(ids(second, 'step_skipped').includes('drop'), 'the rejected path is skipped');
  assert.ok(one(second, 'run_completed'), 'the resumed run completes');
});

test('human: a REJECT resumes down the other path', async () => {
  const tester = new FlowTester({ nodeTypes, llm: stubLlm('draft'), channelRegistry: stubChannels() });
  const first = await runAll(tester, approvalFlow, { initialContext: 'the inbound email' });
  const persisted = first.filter(e => e.type === 'step_completed');

  const second = await runAll(tester, approvalFlow, {
    initialContext: 'the inbound email',
    resumeSteps: persisted,
    decisions: { approve: { decision: 'reject', by: 'user:abc' } },
  });

  assert.ok(ids(second, 'step_completed').includes('drop'), 'the reject path runs');
  assert.ok(ids(second, 'step_skipped').includes('send'), 'the send is skipped');
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
