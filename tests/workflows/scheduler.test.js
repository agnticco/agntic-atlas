/**
 * WorkflowScheduler — the choke point every real run goes through.
 *
 * Written in P12 Increment D, and overdue: this file is where scheduled runs
 * fire, where the retry wrapper lives, where the monthly-run PLAN CAP is
 * enforced, where a suspended tenant's automations are stopped, and — since D —
 * where a run pauses for a person and later resumes. It had NO unit tests at
 * all. The generated mutation sweep said so plainly the moment D widened its
 * TARGETS to include this file (the round-9 verifier's recorded residual), and
 * the survivor list is the coverage report: `if (allowed === false)` — the plan
 * cap — could be inverted with the whole suite still green.
 *
 * None of this is new behaviour. These tests pin what the scheduler ALREADY
 * promises, so the next person to touch it finds out from a red test rather than
 * from a customer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowScheduler } from '../../src/workflows/workflow-scheduler.js';
import { WorkflowStore } from '../../src/workflows/workflow-store.js';
import { FlowTester } from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

const stubChannels = (onCall = null) => ({
  get: (id) => ({ id, available: true, actionOnly: false }),
  getHandler: () => async (args) => (onCall ? onCall(args) : { delivered: true, ts: '1.0' }),
});

/** A one-step flow that delivers whatever the LLM produced. */
function setup({ llm = { invoke: async () => ({ content: 'OUTPUT' }) }, onDeliver = null, errorHandling = null } = {}) {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();
  const flowTester = new FlowTester({ nodeTypes, llm, channelRegistry: stubChannels(onDeliver) });
  const scheduler = new WorkflowScheduler({ workflowStore: ws, sourceRegistry: null, flowTester });

  const workflow = ws.create({
    name: 'Daily digest', kind: 'flow', status: 'active',
    tenantId: 'tenant-a', userId: 'user-1',
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [
      { id: 'work', type: 'llm', config: { mode: 'freeform', prompt: 'do it' } },
      { id: 'out',  type: 'deliver', config: { channel: 'slack', target: '#ops' } },
    ],
    edges: [{ from: 'work', to: 'out' }],
    // NB: the store's create() takes `errorHandling` and persists it as
    // `error_handling`. Passing the snake_case name here silently persisted `{}`
    // — and the retry test then "passed" with one attempt while asserting three.
    ...(errorHandling ? { errorHandling } : {}),
  });
  return { ws, scheduler, workflow: () => ws.get(workflow.id), id: workflow.id };
}

// ── The plan cap (tier gating) ───────────────────────────────────────────────

test('the monthly run cap BLOCKS the run — the single choke point every real run passes', async () => {
  const delivered = [];
  const s = setup({ onDeliver: (a) => { delivered.push(a.body); return { delivered: true }; } });
  s.scheduler.registerRunBudgetCheck(() => false);   // tenant is over its plan's run cap

  await s.scheduler._executeFlow(s.workflow(), { trigger: 'scheduled' });

  assert.equal(delivered.length, 0, 'the workflow did not run');
  assert.equal(s.ws.getLastRun(s.id), null, 'and no run row was opened — a blocked run is not a run');
});

test('the run cap lets an in-budget tenant through (the positive case)', async () => {
  const delivered = [];
  const s = setup({ onDeliver: (a) => { delivered.push(a.body); return { delivered: true }; } });
  s.scheduler.registerRunBudgetCheck(() => true);

  await s.scheduler._executeFlow(s.workflow(), { trigger: 'scheduled' });

  assert.equal(delivered.length, 1, 'a check that blocks everyone is an outage, not a cap');
  assert.equal(s.ws.getLastRun(s.id).status, 'success');
});

test('the run cap FAILS OPEN — a broken budget check must not stop the platform', async () => {
  const delivered = [];
  const s = setup({ onDeliver: (a) => { delivered.push(a.body); return { delivered: true }; } });
  s.scheduler.registerRunBudgetCheck(() => { throw new Error('billing is down'); });

  await s.scheduler._executeFlow(s.workflow(), { trigger: 'scheduled' });

  assert.equal(delivered.length, 1, 'billing being down must not silently stop every customer\'s automations');
});

// ── The retry wrapper + the error notifier ───────────────────────────────────

test('a failing flow is retried the declared number of times, then a person is told', async () => {
  let attempts = 0;
  const s = setup({
    llm: { invoke: async () => { attempts++; throw new Error('upstream 502'); } },
    errorHandling: { retry: { attempts: 2, delay_seconds: 0 }, notify: { type: 'slack', channel: '#alerts' } },
  });
  const notified = [];
  s.scheduler.registerErrorNotifier(async (wf, err) => { notified.push({ wf: wf.id, err: String(err) }); });

  await s.scheduler._executeFlow(s.workflow(), { trigger: 'scheduled' });

  assert.equal(attempts, 3, 'retry.attempts = 2 means 2 EXTRA attempts — three tries in total');
  assert.equal(notified.length, 1, 'after they are all exhausted, somebody is told');
  assert.match(notified[0].err, /upstream 502/);
  assert.equal(s.ws.get(s.id).status, 'error', 'and the workflow itself is marked broken');
});

test('a flow that succeeds is NOT retried and nobody is notified', async () => {
  let calls = 0;
  const s = setup({
    llm: { invoke: async () => { calls++; return { content: 'fine' }; } },
    errorHandling: { retry: { attempts: 2, delay_seconds: 0 } },
  });
  const notified = [];
  s.scheduler.registerErrorNotifier(async () => { notified.push(1); });

  await s.scheduler._executeFlow(s.workflow(), { trigger: 'scheduled' });

  assert.equal(calls, 1, 'one attempt');
  assert.equal(notified.length, 0, 'a notifier that fires on success trains people to ignore it');
});

test('a flow with no flowTester configured fails cleanly rather than crashing the tick', async () => {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();
  const scheduler = new WorkflowScheduler({ workflowStore: ws, sourceRegistry: null, flowTester: null });
  const wf = ws.create({
    name: 'x', kind: 'flow', status: 'active', tenantId: 'tenant-a', userId: 'user-1',
    triggers: [{ type: 'manual' }], nodes: [{ id: 'a', type: 'assemble', config: { title: 't', sections: '[]' } }], edges: [],
  });
  const err = await scheduler._runFlowOnce(ws.get(wf.id), {});
  assert.ok(err instanceof Error);
});

// ── The tick loop ────────────────────────────────────────────────────────────

test('the tick runs DUE workflows and skips ones whose tenant is inactive', async () => {
  const ran = [];
  const s = setup({ onDeliver: (a) => { ran.push(a.body); return { delivered: true }; } });
  // Due right NOW: an every-minute cron with no previous run. (A `0 9 * * *` is
  // only due at 9am, so a test written against it passes at 9am and nowhere else.)
  s.ws.db.prepare("UPDATE workflows SET last_run = NULL, triggers = ?")
    .run(JSON.stringify([{ type: 'schedule', config: { cron: '*/1 * * * *' } }]));

  // A suspended / cancelled tenant's automations must not run (nor cost money).
  s.scheduler.registerTenantGate((tenantId) => tenantId !== 'tenant-a');
  await s.scheduler._tick();
  assert.equal(ran.length, 0, 'inactive tenant → skipped');

  s.scheduler.registerTenantGate(() => true);
  await s.scheduler._tick();
  assert.equal(ran.length, 1, 'active tenant → it runs (so the gate is a check, not an outage)');
});

test('overlapping ticks do not double-fire a workflow', async () => {
  const s = setup();
  s._running = true;
  // Two ticks in flight at once must not both execute the same due workflow.
  const a = s.scheduler._tick();
  const b = s.scheduler._tick();
  await Promise.all([a, b]);
  const runs = s.ws.getRuns(s.id, 100);
  assert.ok(runs.length <= 1, `a workflow fired ${runs.length} times from two overlapping ticks`);
});

test('start() and stop() are idempotent and leave no timer behind', () => {
  const s = setup();
  s.scheduler.start();
  const first = s.scheduler._timer;
  s.scheduler.start();               // second start must not create a second loop
  assert.equal(s.scheduler._timer, first, 'a second start() would double-fire every scheduled workflow');
  s.scheduler.stop();
  assert.equal(s.scheduler._timer, null);
  s.scheduler.stop();                // stopping twice must not throw
});

// ── fetch-kind workflows ─────────────────────────────────────────────────────

test('a fetch-kind workflow with an unknown source does not run and does not crash', async () => {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();
  const scheduler = new WorkflowScheduler({
    workflowStore: ws,
    sourceRegistry: { get: () => null },       // the source is gone
    fetchers: {},
  });
  const wf = ws.create({ name: 'f', kind: 'fetch', status: 'active', tenantId: 'tenant-a', userId: 'user-1', sourceId: 'missing', triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }], nodes: [], edges: [] });

  await scheduler._execute(ws.get(wf.id), { trigger: 'scheduled' });
  assert.equal(ws.getLastRun(wf.id), null, 'no run row — there was nothing to run');
});

test('a fetch-kind workflow with no registered fetcher does not run', async () => {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();
  const scheduler = new WorkflowScheduler({
    workflowStore: ws,
    sourceRegistry: { get: () => ({ id: 's', fetch_module: 'nope' }) },
    fetchers: {},                                // the module is not registered
  });
  const wf = ws.create({ name: 'f', kind: 'fetch', status: 'active', tenantId: 'tenant-a', userId: 'user-1', sourceId: 's', triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }], nodes: [], edges: [] });

  await scheduler._execute(ws.get(wf.id), { trigger: 'scheduled' });
  assert.equal(ws.getLastRun(wf.id), null);
});

test('a fetch-kind workflow runs its fetcher and records the result', async () => {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();
  const scheduler = new WorkflowScheduler({
    workflowStore: ws,
    sourceRegistry: { get: () => ({ id: 's', fetch_module: 'rss' }) },
    fetchers: { rss: { fetch: async () => ({ text: 'FETCHED' }) } },
  });
  const wf = ws.create({ name: 'f', kind: 'fetch', status: 'active', tenantId: 'tenant-a', userId: 'user-1', sourceId: 's', triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }], nodes: [], edges: [] });

  await scheduler._execute(ws.get(wf.id), { trigger: 'scheduled' });
  const run = ws.getLastRun(wf.id);
  assert.equal(run.status, 'success');
  assert.equal(run.output, 'FETCHED');
});

test('a fetch-kind workflow whose fetcher throws records the failure', async () => {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();
  const scheduler = new WorkflowScheduler({
    workflowStore: ws,
    sourceRegistry: { get: () => ({ id: 's', fetch_module: 'rss' }) },
    fetchers: { rss: { fetch: async () => { throw new Error('feed is down'); } } },
  });
  const wf = ws.create({ name: 'f', kind: 'fetch', status: 'active', tenantId: 'tenant-a', userId: 'user-1', sourceId: 's', triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }], nodes: [], edges: [] });

  await scheduler._execute(ws.get(wf.id), { trigger: 'scheduled' });
  assert.equal(ws.getLastRun(wf.id).status, 'error');
});

// ── The unified outputs log (what the admin console reads) ───────────────────

test('every terminal run emits ONE row to the outputs log, carrying its tenant and cost', async () => {
  const rows = [];
  const s = setup();
  s.scheduler.metricsStore = { recordOutput: (r) => rows.push(r) };

  await s.scheduler._executeFlow(s.workflow(), { trigger: 'scheduled' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 'user-1', 'attribution — an unattributed run is invisible in the per-tenant totals');
  assert.equal(rows[0].source_surface, 'scheduled');
  assert.equal(rows[0].status, 'success');
});

// ── Resume (P12 Increment D) ────────────────────────────────────────────────

test('resumeRun whose workflow can no longer be loaded closes the run out, and does not throw', async () => {
  // A DEFENSIVE guard, pinned at the guard rather than through a fabricated
  // scenario: a hard DELETE cascades the run away with the workflow, so there is
  // no realistic path that reaches this branch today. It still must not throw —
  // an exception here would leave the run flipped out of `awaiting_human` and
  // answerable by nobody, forever. So: make `get()` return nothing, and require
  // the run to be closed out rather than abandoned mid-resume.
  const s = setup();
  const run = s.ws.startRun(s.id);
  s.ws.pauseRun(run.id, 'work', { prompt: 'ok?', decisions: ['approve', 'reject'] },
    { outputs: {}, live: {}, skipped: [], ruledOut: [], lastOutput: null }, null);
  const paused = s.ws.getAwaitingHuman(run.id);

  s.ws.get = () => null;

  const res = await s.scheduler.resumeRun(paused, { decision: 'approve' });
  assert.equal(res.resumed, false);
  assert.match(res.reason, /no longer exists/);
  const row = s.ws.db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run.id);
  assert.equal(row.status, 'error', 'the run is closed out, not left waiting forever');
});

test('resumeRun records who answered, and defaults nothing about it', async () => {
  const s = setup();
  const run = s.ws.startRun(s.id);
  s.ws.pauseRun(run.id, 'work', { prompt: 'ok?', decisions: ['approve', 'reject'] }, { outputs: {}, live: {}, skipped: [], ruledOut: [], lastOutput: null }, null);

  await s.scheduler.resumeRun(s.ws.getAwaitingHuman(run.id), { decision: 'approve', by: 'user:7', channel: 'inbox' });

  const answered = s.ws.getRun(run.id).steps.find(x => x.type === 'human_answered');
  assert.equal(answered.decision, 'approve');
  assert.equal(answered.by, 'user:7');
  assert.equal(answered.channel, 'inbox');
  assert.ok(answered.at, 'and WHEN — the audit trail is the whole point of asking a person');
});

test('resumeRun with an anonymous answer records null rather than inventing an answerer', async () => {
  const s = setup();
  const run = s.ws.startRun(s.id);
  s.ws.pauseRun(run.id, 'work', { prompt: 'ok?', decisions: ['approve', 'reject'] }, { outputs: {}, live: {}, skipped: [], ruledOut: [], lastOutput: null }, null);

  await s.scheduler.resumeRun(s.ws.getAwaitingHuman(run.id), { decision: 'approve' });

  const answered = s.ws.getRun(run.id).steps.find(x => x.type === 'human_answered');
  assert.equal(answered.by, null, 'an unknown answerer is recorded as unknown — never as somebody');
  assert.equal(answered.channel, null);
});

test('the timeout sweeper does nothing when no pause has expired', async () => {
  const s = setup();
  const run = s.ws.startRun(s.id);
  // Deadline is in the future.
  s.ws.pauseRun(run.id, 'work', { prompt: 'ok?', decisions: ['approve', 'reject'], timeout: { after: '48h', then: 'reject' } },
    { outputs: {}, live: {}, skipped: [], ruledOut: [], lastOutput: null },
    new Date(Date.now() + 3600_000).toISOString());

  assert.equal(await s.scheduler.sweepTimeouts(), 0, 'a pending approval is not an expired one');
  assert.equal(s.ws.getRun(run.id).status, 'awaiting_human', 'and it is still waiting');
});
