/**
 * P12 Increment D — the human approval gate.
 *
 * What the gate demands (scripts/gates/p12.sh), and why each one is here:
 *
 *   1. the token is stored SHA-256 HASHED   — a database dump must not yield
 *                                             usable approval links.
 *   2. single-use — a replay is REJECTED    — a forwarded thread must not let a
 *                                             second reader answer again.
 *   3. TTL expiry                           — an approval link that works forever
 *                                             is a standing invitation.
 *   4. approve/reject are DISTINCT tokens   — one token carrying the decision in a
 *      that MUTUALLY INVALIDATE               query param could be flipped by
 *                                             editing the URL; and once either is
 *                                             used, the question is ANSWERED.
 *   5. a timeout takes the DECLARED path    — silence is not consent, and a pause
 *                                             with no deadline hangs forever.
 *
 * Plus the properties D itself rests on: the pause resumes on the CHECKPOINT (not
 * the display-shrunk steps), a control node's output never reaches the customer,
 * one answer resumes a run exactly ONCE, and a failure path is not a successor.
 *
 * These are written against the shapes PRODUCTION builds — the scheduler's own
 * resume path, the store's own SQL — not against hand-passed arguments no real
 * caller passes. That is ENGINEERING-LOG.md architectural flaw #2, and it is how Increment
 * B leaked one tenant's output into another tenant's run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { ApprovalStore, hashApprovalToken } from '../../src/approvals/approval-store.js';
import { ApprovalService } from '../../src/approvals/approval-service.js';
import { WorkflowStore } from '../../src/workflows/workflow-store.js';
import { WorkflowScheduler } from '../../src/workflows/workflow-scheduler.js';
import { FlowTester } from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';
import { approvalChannelView } from '../../src/workflows/approval-channels.js';
import { parseDuration } from '../../src/workflows/duration.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

const store = () => new ApprovalStore({ dbPath: ':memory:' }).init();

// ── 1. The token is a hash on disk ───────────────────────────────────────────

test('the token is stored SHA-256 hashed — the plaintext never touches the database', () => {
  const s = store();
  const { approve } = s.issue({ tenantId: 't1', runId: 'r1', nodeId: 'n1', decisions: ['approve', 'reject'] });

  const rows = s.db.prepare('SELECT * FROM approval_tokens').all();
  const blob = JSON.stringify(rows);

  assert.ok(approve.length > 20, 'the caller gets a real token back');
  assert.ok(!blob.includes(approve), 'the PLAINTEXT token must not appear anywhere in the database');
  assert.ok(blob.includes(createHash('sha256').update(approve).digest('hex')), 'its SHA-256 hash is what is stored');
  // And the hash is what the lookup uses — peek() finds it by hash, not by scan.
  assert.equal(s.peek(approve).token_hash, hashApprovalToken(approve));
});

// ── 2 + 4. Single-use, and the siblings die together ─────────────────────────

test('a replayed magic link is rejected (single-use)', () => {
  const s = store();
  const { approve } = s.issue({ tenantId: 't1', runId: 'r1', nodeId: 'n1', decisions: ['approve', 'reject'] });

  const first = s.consume(approve);
  assert.equal(first.decision, 'approve', 'the first click works');

  assert.equal(s.consume(approve), null, 'the SAME link, used again, is rejected');
  assert.equal(s.peek(approve), null, 'and it no longer even peeks');
});

test('approve and reject are DISTINCT tokens, and consuming either invalidates BOTH', () => {
  const s = store();
  const { approve, reject } = s.issue({ tenantId: 't1', runId: 'r1', nodeId: 'n1', decisions: ['approve', 'reject'] });

  assert.notEqual(approve, reject, 'a forwarded "approve" link cannot be edited into a "reject" — they are different secrets');

  assert.equal(s.consume(approve).decision, 'approve');
  // One approval, one answer. The reject link in the same email is dead the
  // moment approve is clicked — otherwise a second reader overrides the first.
  assert.equal(s.consume(reject), null, 'the sibling token is invalidated by the first answer');
});

// ── 3. TTL ───────────────────────────────────────────────────────────────────

test('a token expires — TTL is enforced on peek AND on consume', () => {
  const s = store();
  const { approve } = s.issue({ tenantId: 't1', runId: 'r1', nodeId: 'n1', decisions: ['approve'], ttlMs: 1 });
  // Force the deadline into the past rather than sleeping.
  s.db.prepare('UPDATE approval_tokens SET expires_at = ?')
    .run(new Date(Date.now() - 1000).toISOString());

  assert.equal(s.peek(approve), null, 'an expired token does not peek');
  assert.equal(s.consume(approve), null, 'and it cannot be consumed');
});

// ── Cross-tenant ─────────────────────────────────────────────────────────────

test('a token issued in tenant A cannot be consumed as tenant B', () => {
  const s = store();
  const { approve } = s.issue({ tenantId: 'tenant-a', runId: 'r1', nodeId: 'n1', decisions: ['approve'] });

  assert.equal(s.consume(approve, { tenantId: 'tenant-b' }), null, 'the wrong tenant gets nothing…');
  assert.ok(s.consume(approve, { tenantId: 'tenant-a' }), '…and the right one still works (the failed attempt did not burn it)');
});

test('issuing without a tenant THROWS — it never silently defaults', () => {
  const s = store();
  // A `?? "default"` here would be a cross-tenant forgery primitive: the token
  // could then be checked against a run in any tenant. Fail closed.
  assert.throws(() => s.issue({ runId: 'r1', nodeId: 'n1', decisions: ['approve'] }), /tenantId is required/);
  assert.throws(() => s.issue({ tenantId: '', runId: 'r1', nodeId: 'n1', decisions: ['approve'] }), /tenantId is required/);
});

// ── 5. The timeout takes the declared path — end to end, through the scheduler ─

/**
 * The production wiring, assembled the way server.js assembles it: a real
 * WorkflowStore, a real scheduler, a real FlowTester, a real ApprovalService.
 * Nothing here hand-passes an argument that production omits.
 */
function harness({ spec, timeoutThen = 'reject' } = {}) {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();

  const delivered = [];
  const inboxStore = { create: (item) => { delivered.push(item); return { id: `inbox-${delivered.length}` }; } };

  const flowTester = new FlowTester({
    nodeTypes,
    llm: { invoke: async () => ({ content: 'DRAFTED REPLY' }) },
    channelRegistry: {
      get: (id) => ({ id, available: true, actionOnly: false }),
      getHandler: () => async ({ body }) => { sent.push(body); return { delivered: true, ts: '1.0' }; },
    },
  });
  const sent = [];

  const scheduler = new WorkflowScheduler({ workflowStore: ws, sourceRegistry: null, flowTester });
  const approvals = new ApprovalStore({ dbPath: ':memory:' }).init();
  const service = new ApprovalService({
    approvalStore: approvals,
    workflowStore: ws,
    inboxStore,
    resumeRun: (run, answer) => scheduler.resumeRun(run, answer),
  });
  scheduler.registerAskDeliverer((ctx) => service.deliverAsk(ctx));
  scheduler.registerTimeoutHook((ctx) => service.onTimeout(ctx));

  const workflow = ws.create({
    name: 'Reply to the customer', kind: 'flow', status: 'active',
    tenantId: 'tenant-a', userId: 'user-1',
    ...spec,
  });

  return { ws, scheduler, service, approvals, workflow, inbox: delivered, sent };
}

/** draft → ask a person → branch(approve → send | * → dropped) */
const APPROVAL_SPEC = (timeoutThen = 'reject') => ({
  triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
  nodes: [
    { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'draft a reply' } },
    { id: 'ask',   type: 'human', config: {
      prompt: 'Send this reply?', preview: '{{draft.output}}',
      decisions: ['approve', 'reject'],
      channels: [{ type: 'inbox' }],
      timeout: { after: '48h', then: timeoutThen },
    } },
    { id: 'gate',  type: 'branch', config: {
      on: '{{ask.decision}}',
      cases: [{ when: 'approve', to: 'send' }, { when: '*', to: 'dropped' }],
    } },
    { id: 'send',    type: 'deliver',  config: { channel: 'slack', target: '#ops' } },
    { id: 'dropped', type: 'assemble', config: { title: 'Not approved — nothing was sent.', sections: '[]' } },
  ],
  edges: [
    { from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' },
    { from: 'gate', to: 'send' }, { from: 'gate', to: 'dropped' },
  ],
});

test('a run with no answer hits the timeout and takes the DECLARED path', async () => {
  const h = harness({ spec: APPROVAL_SPEC('reject') });

  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });

  const paused = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });
  assert.equal(paused.length, 1, 'the run parked on the human step');
  assert.equal(paused[0].paused_node, 'ask');
  assert.equal(h.inbox.length, 1, 'and the question was actually DELIVERED — a pause nobody is asked is a hang');

  // Nobody answers. Drag the deadline into the past and let the sweeper find it.
  h.ws.db.prepare('UPDATE workflow_runs SET pause_expires_at = ?')
    .run(new Date(Date.now() - 1000).toISOString());

  assert.equal(await h.scheduler.sweepTimeouts(), 1);

  const run = h.ws.getRun(paused[0].id);
  assert.equal(run.status, 'success', 'the run finished — it did not hang, and it did not error');
  assert.equal(h.sent.length, 0, 'THE DECLARED PATH WAS "reject", SO NOTHING WAS SENT. Silence is not consent.');

  const answered = run.steps.find(s => s.type === 'human_answered');
  assert.equal(answered.decision, 'reject', 'the audit trail records the timeout decision…');
  assert.equal(answered.by, 'system:timeout', '…and that it was the SYSTEM, not a person, that gave it');
});

test('a timeout of `then: escalate` resolves as `timeout`, never as approve', async () => {
  const h = harness({ spec: APPROVAL_SPEC('escalate') });
  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });
  const [paused] = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });
  h.ws.db.prepare('UPDATE workflow_runs SET pause_expires_at = ?')
    .run(new Date(Date.now() - 1000).toISOString());

  await h.scheduler.sweepTimeouts();

  const run = h.ws.getRun(paused.id);
  assert.equal(h.ws.listAwaitingHuman({ tenantId: 'tenant-a' }).length, 0, 'the pause is resolved');
  assert.equal(h.sent.length, 0, 'AN UNANSWERED APPROVAL NEVER BECOMES AN APPROVAL');

  // Asserting only "nothing was sent" would pass for the WRONG REASON — the
  // engine throwing on an answer it refuses to accept also sends nothing. Then
  // the declared timeout path would be unreachable and every timed-out run would
  // ERROR, and this test would smile at it. Assert the run actually resolved.
  assert.equal(run.status, 'success', 'the run took its declared path and finished — it did not crash');
  const answered = run.steps.find(s => s.type === 'human_answered');
  assert.equal(answered.decision, 'timeout', '`timeout` is the answer the system gives when nobody does');
  assert.ok(run.steps.some(s => s.type === 'step_completed' && s.nodeId === 'ask'), 'and the human step actually ran on it');
});

test('markRunResumed is a ONE-SHOT LATCH — the second answer of a race loses', () => {
  // The guard that stops one run resuming twice. In-process the two callers cannot
  // currently interleave (the path from read to flip has no await in it), so no
  // end-to-end test can distinguish this from an unconditional UPDATE — which is
  // exactly why it is pinned HERE, at the latch itself. Delete the `AND status =
  // 'awaiting_human'` and this goes red; without it, a race resumes the run twice
  // and the customer is emailed twice.
  const h = harness({ spec: APPROVAL_SPEC() });
  const run = h.ws.startRun(h.workflow.id);
  h.ws.pauseRun(run.id, 'ask', { prompt: 'Send?', decisions: ['approve', 'reject'] }, { outputs: {} }, null);

  assert.equal(h.ws.markRunResumed(run.id), true,  'the first answer wins…');
  assert.equal(h.ws.markRunResumed(run.id), false, '…and the second is refused');
});

test('resumeRun refuses a run that is not waiting for an answer', async () => {
  const h = harness({ spec: APPROVAL_SPEC() });
  const run = h.ws.startRun(h.workflow.id);   // status: running, not awaiting_human
  const res = await h.scheduler.resumeRun(h.ws.getRun(run.id), { decision: 'approve' });
  assert.equal(res.resumed, false);
  assert.equal(h.sent.length, 0);
});

// ── The approval itself, over the inbox (the strong, always-available channel) ─

test('an approval resumes the run and delivers WHAT WAS APPROVED — not the approval record', async () => {
  const h = harness({ spec: APPROVAL_SPEC() });
  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });

  const [paused] = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });
  const res = await h.service.resolveFromInbox({
    tenantId: 'tenant-a', userId: 'user-1',
    runId: paused.id, nodeId: 'ask', decision: 'approve',
  });

  assert.equal(res.ok, true);
  assert.equal(h.sent.length, 1, 'the approved step ran');
  // A `human` output is {decision, by, at, channel} and a `branch` output is
  // {value, matched, to}. Neither is the work product. If either became
  // `lastOutput`, the CUSTOMER receives the approval record instead of the reply.
  assert.equal(h.sent[0], 'DRAFTED REPLY', 'the customer gets the DRAFT that was approved');
  assert.ok(!String(h.sent[0]).includes('decision'), 'and never the approval record itself');

  const run = h.ws.getRun(paused.id);
  const answered = run.steps.find(s => s.type === 'human_answered');
  assert.equal(answered.by, 'user:user-1', 'WHO approved it is recorded…');
  assert.equal(answered.channel, 'inbox', '…and HOW');
});

test('a rejection takes the other path — the send never runs', async () => {
  const h = harness({ spec: APPROVAL_SPEC() });
  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });

  const [paused] = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });
  await h.service.resolveFromInbox({
    tenantId: 'tenant-a', userId: 'user-1',
    runId: paused.id, nodeId: 'ask', decision: 'reject',
  });

  assert.equal(h.sent.length, 0, 'a rejected draft is NOT sent');
  const run = h.ws.getRun(paused.id);
  assert.equal(run.status, 'success');
  assert.ok(run.steps.some(s => s.type === 'step_skipped' && s.nodeId === 'send'), 'the send was skipped, not failed');
});

test('ONE answer resumes a run exactly once — a second answer is refused', async () => {
  const h = harness({ spec: APPROVAL_SPEC() });
  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });
  const [paused] = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });

  const a = await h.service.resolveFromInbox({ tenantId: 'tenant-a', userId: 'user-1', runId: paused.id, nodeId: 'ask', decision: 'approve' });
  // The second one arrives after the run has already been resumed — a person
  // clicking twice, or Slack racing the inbox. Without the conditional flip out of
  // `awaiting_human`, the run resumes twice and the customer is emailed twice.
  const b = await h.service.resolveFromInbox({ tenantId: 'tenant-a', userId: 'user-1', runId: paused.id, nodeId: 'ask', decision: 'approve' });

  assert.equal(a.ok, true);
  assert.equal(b.ok, false, 'the second answer is refused');
  assert.equal(h.sent.length, 1, 'AND THE CUSTOMER WAS EMAILED EXACTLY ONCE');
});

test('a user in tenant B cannot answer tenant A\'s approval', async () => {
  const h = harness({ spec: APPROVAL_SPEC() });
  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });
  const [paused] = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });

  const res = await h.service.resolveFromInbox({
    tenantId: 'tenant-b', userId: 'attacker',
    runId: paused.id, nodeId: 'ask', decision: 'approve',
  });

  assert.equal(res.ok, false, 'the run does not resolve for the wrong tenant');
  assert.equal(h.sent.length, 0, 'and nothing was sent');
  assert.equal(h.ws.listAwaitingHuman({ tenantId: 'tenant-a' }).length, 1, 'the approval is still pending for its real owner');
});

// ── The checkpoint, not the steps ─────────────────────────────────────────────

test('the approved content survives the pause at FULL FIDELITY (not the 2000-char display copy)', async () => {
  // ~3.3k chars — a routine drafted reply exceeds the 2000-char display cap, which
  // is exactly the case that resumed from a truncated copy and sent the customer a
  // mutilated email ending in "…(truncated)", with no error (converger-v2 §7.4).
  const LONG = 'x'.repeat(3363);
  const h = harness({ spec: APPROVAL_SPEC() });
  h.scheduler.flowTester.llm = { invoke: async () => ({ content: LONG }) };

  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });
  const [paused] = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });

  // The persisted STEP is display-shrunk. That is fine — that is its job.
  const step = paused.steps.find(s => s.nodeId === 'draft' && s.type === 'step_completed');
  assert.ok(String(step.output).includes('(truncated)'), 'the display copy IS truncated (this is the trap)');

  await h.service.resolveFromInbox({ tenantId: 'tenant-a', userId: 'user-1', runId: paused.id, nodeId: 'ask', decision: 'approve' });

  assert.equal(h.sent[0].length, LONG.length, 'the CUSTOMER receives the whole thing…');
  assert.equal(h.sent[0], LONG, '…exactly as it was approved');
});

// ── The failure path is not a successor ──────────────────────────────────────

test('an on_error route_to target does NOT run when the step succeeds', async () => {
  // The validator REQUIRES the edge (ON_ERROR_ROUTE_NO_EDGE), and propagate() used
  // to light every outgoing edge on success — including that one. So the only shape
  // the validator accepts was the shape that misfires, and the error handler ran on
  // every healthy run: a "this broke" Slack post every morning, and — once D lands —
  // an approval gate meant only for failures pausing every single run.
  const h = harness({ spec: {
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [
      { id: 'work', type: 'llm', config: { mode: 'freeform', prompt: 'do it' }, on_error: { then: 'route_to:handler' } },
      { id: 'handler', type: 'deliver', config: { channel: 'slack', target: '#alerts' } },
      { id: 'next',    type: 'assemble', config: { title: 'Done', sections: '[]' } },
    ],
    edges: [{ from: 'work', to: 'handler' }, { from: 'work', to: 'next' }],
  } });

  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });

  const run = h.ws.getLastRun(h.workflow.id);
  assert.equal(run.status, 'success');
  assert.equal(h.sent.length, 0, 'THE ERROR HANDLER DID NOT RUN — the step succeeded');
  assert.ok(run.steps.some(s => s.type === 'step_skipped' && s.nodeId === 'handler'), 'it was skipped');
  assert.ok(run.steps.some(s => s.type === 'step_completed' && s.nodeId === 'next'), 'and the happy path still ran');
});

// ── Routing on the answer: the reference grammar ─────────────────────────────

test('a branch routing on `.decision` of something that is not a human REFUSES to guess', async () => {
  // `.decision` is a field only a `human` node has. On an `llm` step it is
  // undefined — and undefined matches no case, so the MANDATORY catch-all would
  // swallow 100% of runs, silently, forever, with run_completed. That is the
  // BRANCH_BAD_ON failure through a different door. The engine refuses.
  const h = harness({ spec: {
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [
      { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'draft' } },
      { id: 'gate',  type: 'branch', config: {
        on: '{{draft.decision}}',            // draft is an llm — it has no decision
        cases: [{ when: 'approve', to: 'send' }, { when: '*', to: 'dropped' }],
      } },
      { id: 'send',    type: 'deliver',  config: { channel: 'slack', target: '#ops' } },
      { id: 'dropped', type: 'assemble', config: { title: 'no', sections: '[]' } },
    ],
    edges: [{ from: 'draft', to: 'gate' }, { from: 'gate', to: 'send' }, { from: 'gate', to: 'dropped' }],
  } });

  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });

  const run = h.ws.getLastRun(h.workflow.id);
  assert.equal(run.status, 'error', 'the run FAILS loudly…');
  assert.match(run.error, /no decision/i, '…naming the reason');
  assert.equal(h.sent.length, 0, 'and it does not quietly take the catch-all');
});

// ── The validator rules (§7.7) — each with a POSITIVE case ───────────────────
//
// A rule with only a negative test would pass if it rejected EVERYTHING, and a
// check that rejects every correct spec is not a check — it is an outage. That is
// how Increment B shipped an ON_ERROR_ROUTE_NO_EDGE that fired on every valid
// route_to, behind a fully green suite.

const GOOD_HUMAN = {
  prompt: 'Send this reply?', preview: '{{draft.output}}',
  decisions: ['approve', 'reject'],
  channels: [{ type: 'inbox' }],
  timeout: { after: '48h', then: 'reject' },
};

const specWith = (humanConfig) => ({
  name: 'x', kind: 'flow',
  triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
  nodes: [
    { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'draft it' } },
    { id: 'ask',   type: 'human', config: humanConfig },
    { id: 'gate',  type: 'branch', config: { on: '{{ask.decision}}', cases: [{ when: 'approve', to: 'send' }, { when: '*', to: 'dropped' }] } },
    { id: 'send',    type: 'deliver',  config: { channel: 'slack', target: '#ops' } },
    { id: 'dropped', type: 'assemble', config: { title: 'no', sections: '[]' } },
  ],
  edges: [
    { from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' },
    { from: 'gate', to: 'send' }, { from: 'gate', to: 'dropped' },
  ],
});

const codesOf = (spec, channels = ['inbox', 'slack', 'email']) => {
  const v = new WorkflowValidator({
    nodeTypes,
    channelRegistry:  { get: (id) => ({ id, available: true }) },
    approvalChannels: approvalChannelView(channels),
  });
  return v.validate(spec).issues.filter(i => i.severity === 'error').map(i => i.code);
};

test('the CORRECT approval gate validates clean (the positive case)', () => {
  assert.deepEqual(codesOf(specWith(GOOD_HUMAN)), [], 'a good gate must be ACCEPTED — or the rule is an outage, not a check');
});

test('HUMAN_WITHOUT_TIMEOUT — a pause with no deadline hangs forever', () => {
  const { timeout, ...noTimeout } = GOOD_HUMAN;
  assert.ok(codesOf(specWith(noTimeout)).includes('HUMAN_WITHOUT_TIMEOUT'));
  // An unreadable duration is no timeout at all: the sweeper could never expire it.
  assert.ok(codesOf(specWith({ ...GOOD_HUMAN, timeout: { after: 'soon', then: 'reject' } })).includes('HUMAN_WITHOUT_TIMEOUT'));
});

test('HUMAN_BAD_TIMEOUT — a `then` the node cannot answer takes a path nobody wrote', () => {
  assert.ok(codesOf(specWith({ ...GOOD_HUMAN, timeout: { after: '48h', then: 'aprove' } })).includes('HUMAN_BAD_TIMEOUT'));
  // …but `escalate` and any declared decision are fine.
  assert.deepEqual(codesOf(specWith({ ...GOOD_HUMAN, timeout: { after: '48h', then: 'escalate' } })), []);
});

test('WEAK_APPROVAL_FOR_WRITE — an emailed link cannot stand alone in front of a send', () => {
  const emailOnly = { ...GOOD_HUMAN, channels: [{ type: 'email', to: 'ops@acme.com' }] };
  assert.ok(codesOf(specWith(emailOnly)).includes('WEAK_APPROVAL_FOR_WRITE'),
    'a forwarded link proves possession of a mailbox, not who approved the customer email');
  // Adding a STRONG channel alongside it is fine — first valid answer wins.
  const both = { ...GOOD_HUMAN, channels: [{ type: 'email', to: 'ops@acme.com' }, { type: 'inbox' }] };
  assert.deepEqual(codesOf(specWith(both)), []);
});

test('EMAIL_REPLY_APPROVAL — §11.8, the hard rule', () => {
  const reply = { ...GOOD_HUMAN, channels: [{ type: 'email_reply' }] };
  assert.ok(codesOf(specWith(reply)).includes('EMAIL_REPLY_APPROVAL'),
    'parsing "yes" out of a reply body authenticates NOBODY — From: is forgeable and a forwarded thread is full of the word yes');
});

test('APPROVAL_CHANNEL_NOT_CONNECTED — a question nobody can be asked is a run that waits forever', () => {
  const slackAsk = { ...GOOD_HUMAN, channels: [{ type: 'slack', target: '#ops' }] };
  assert.ok(codesOf(specWith(slackAsk), ['inbox']).includes('APPROVAL_CHANNEL_NOT_CONNECTED'),
    'Slack is not connected in this workspace');
  assert.deepEqual(codesOf(specWith(slackAsk), ['inbox', 'slack']), [], 'and it is fine once Slack IS connected');
});

// ── The duration parser the validator and the sweeper SHARE ──────────────────

test('parseDuration reads what the validator accepts, and refuses what it rejects', () => {
  assert.equal(parseDuration('48h'), 48 * 3600_000);
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('7d'),  7 * 86_400_000);
  // If these disagreed, the validator would accept a pause the sweeper could never
  // expire — a hang with a timeout declared on it.
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration('0h'),   null);
  assert.equal(parseDuration(''),     null);
  assert.equal(parseDuration(null),   null);
});

// The store durably persists to a real file (not just :memory:), creating the
// parent dir — the path a production boot takes.
test('an ApprovalStore on a real nested file path persists a token across instances', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'appr-')), 'nested', 'approvals.sqlite');

  const first = new ApprovalStore({ dbPath }).init();
  const { approve } = first.issue({ tenantId: 't1', runId: 'r1', nodeId: 'n1', decisions: ['approve', 'reject'] });
  first.close();

  const second = new ApprovalStore({ dbPath }).init();   // after a restart
  assert.ok(second.peek(approve), 'the token written before the restart is still valid');
  assert.equal(second.consume(approve).decision, 'approve');
  second.close();
});
