/**
 * P12 Increment D — the approval gate, attacked.
 *
 * Written by the `test-adversary`, which did not write `src/`. Every test here
 * exists because a mutation of the guard it names left the suite GREEN, or —
 * worse — because there is no guard to mutate.
 *
 * The five properties D claims, and the question each of these asks of it:
 *
 *   1. an approval cannot be FORGED
 *   2. an unanswered approval NEVER becomes an approve   ← falsified (F3)
 *   3. one answer resumes a run exactly once
 *   4. the person approves what the customer receives    ← falsified (F1)
 *   5. a `human` node ALONE IS NOT A GATE                ← falsified (F2)
 *
 * The shape of every failure below is the shape CLAUDE.md names three times: a
 * check that is real, and a LAUNDERING HOP one step to the left of it that the
 * check does not look through. In C it was an `assemble` between an `llm` and a
 * `branch`. Here it is `.decision` between a `human` and the case check; a
 * missing `branch` between a `human` and the send; and a `foreach` between an
 * approval and the write it is supposed to guard.
 *
 * Built against the shapes PRODUCTION builds — the real scheduler, the real
 * store, the real ApprovalService, and a validator constructed the way
 * `server.js:buildEngine` constructs it (with a channel registry AND an approval
 * channel view). A check that hands the unit something production omits is
 * testing a program nobody runs (CLAUDE.md, architectural flaw #2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalStore } from '../../src/approvals/approval-store.js';
import { ApprovalService } from '../../src/approvals/approval-service.js';
import { WorkflowStore } from '../../src/workflows/workflow-store.js';
import { WorkflowScheduler } from '../../src/workflows/workflow-scheduler.js';
import { FlowTester } from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';
import { approvalChannelView } from '../../src/workflows/approval-channels.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

/** The production wiring: real store, real scheduler, real engine, real service. */
function harness({ spec, llm = null } = {}) {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();

  const sent = [];
  const inbox = [];
  const flowTester = new FlowTester({
    nodeTypes,
    llm: llm ?? { invoke: async () => ({ content: 'DRAFTED REPLY' }) },
    channelRegistry: {
      get: (id) => ({ id, available: true, actionOnly: false }),
      getHandler: () => async ({ body }) => { sent.push(body); return { delivered: true, ts: '1.0' }; },
    },
  });

  const scheduler = new WorkflowScheduler({ workflowStore: ws, sourceRegistry: null, flowTester });
  const approvals = new ApprovalStore({ dbPath: ':memory:' }).init();
  const service = new ApprovalService({
    approvalStore: approvals,
    workflowStore: ws,
    inboxStore: { create: (item) => { inbox.push(item); return { id: `inbox-${inbox.length}` }; } },
    resumeRun: (run, answer) => scheduler.resumeRun(run, answer),
  });
  scheduler.registerAskDeliverer((ctx) => service.deliverAsk(ctx));
  scheduler.registerTimeoutHook((ctx) => service.onTimeout(ctx));

  const workflow = ws.create({
    name: 'Reply to the customer', kind: 'flow', status: 'active',
    tenantId: 'tenant-a', userId: 'user-1',
    ...spec,
  });

  return { ws, scheduler, service, approvals, workflow, sent, inbox };
}

/** The validator, built the way `server.js:buildEngine` builds it. */
const errorsOf = (spec, channels = ['inbox', 'slack', 'email']) => new WorkflowValidator({
  nodeTypes,
  channelRegistry:  { get: (id) => ({ id, available: true }) },
  approvalChannels: approvalChannelView(channels),
}).validate(spec).issues.filter(i => i.severity === 'error');

const codesOf = (spec, channels) => errorsOf(spec, channels).map(i => i.code);

const flow = (nodes, edges) => ({
  name: 'x', kind: 'flow', status: 'active',
  triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
  nodes, edges,
});

const ASK = (extra = {}) => ({
  prompt: 'Send this reply to the customer?', preview: '{{draft.output}}',
  decisions: ['approve', 'reject'],
  channels: [{ type: 'inbox' }],
  timeout: { after: '48h', then: 'reject' },
  ...extra,
});

/** Drag every pause's deadline into the past, so the sweeper finds it. */
const expireAllPauses = (ws) => ws.db
  .prepare('UPDATE workflow_runs SET pause_expires_at = ? WHERE status = \'awaiting_human\'')
  .run(new Date(Date.now() - 1000).toISOString());

// ═══════════════════════════════════════════════════════════════════════════
// F1. BRANCH_CASE_NOT_IN_ENUM IS BLIND TO `.decision`
//
// Increment D widened the branch reference grammar (branch.js ON_REF) to accept
// `<id>.decision`, and taught BRANCH_BAD_ON the new shape. It did NOT teach the
// two checks that carry the completeness proof: `_checkDecisionInputs`
// (workflow-validator.js:529) and BRANCH_CASE_NOT_IN_ENUM (:591) both still parse
// `on` with the OLD regex — /^([a-z0-9_-]+)(?:\.output)?$/ — which does not match
// `ask.decision`. `onId` comes back null, `src` is null, and both checks `continue`.
//
// So on the ONE shape converger-v2 §7.1 documents and escalation.js EMITS
// (`on: "{{ask.decision}}"`), the case-membership check DOES NOT RUN. A case that
// says `"approved"` where the answer is `"approve"` publishes clean, matches
// nothing, and the mandatory catch-all swallows the approval — silently, forever,
// with `run_completed`.
//
// This is BRANCH_CASE_NOT_IN_ENUM's own stated failure ("We forced the domain
// closed precisely so membership would be DECIDABLE, and then never decided it"),
// reintroduced by the increment that made `human` reachable.
// ═══════════════════════════════════════════════════════════════════════════

const specWithCases = (cases, on = '{{ask.decision}}') => flow([
  { id: 'draft',   type: 'llm',    config: { mode: 'freeform', prompt: 'draft a reply' } },
  { id: 'ask',     type: 'human',  config: ASK() },
  { id: 'gate',    type: 'branch', config: { on, cases } },
  { id: 'send',    type: 'deliver',  config: { channel: 'slack', target: '#customer' } },
  { id: 'dropped', type: 'assemble', config: { title: 'Not approved.', sections: '[]' } },
], [
  { from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' },
  { from: 'gate', to: 'send' }, { from: 'gate', to: 'dropped' },
]);

test('BRANCH_CASE_NOT_IN_ENUM fires on `{{ask.decision}}`, not only on the bare id', () => {
  const typo = [{ when: 'approved', to: 'send' }, { when: '*', to: 'dropped' }];

  // The control: the SAME typo, routed on the bare id. This one IS caught — which
  // is what proves the check works and only its reference parser is blind.
  assert.ok(
    codesOf(specWithCases(typo, '{{ask}}')).includes('BRANCH_CASE_NOT_IN_ENUM'),
    'the check itself works when the reference is a bare id',
  );

  assert.ok(
    codesOf(specWithCases(typo)).includes('BRANCH_CASE_NOT_IN_ENUM'),
    'a case the human can NEVER answer must be rejected on the `.decision` form too — ' +
    'it is the only form converger-v2 §7.1 documents, and the one escalation.js emits',
  );
});

// The run-time consequence of the hole above is NOT pinned as a test, deliberately:
// the only correct fix is to refuse the spec at build time (the engine cannot know
// that "approved" was meant to be "approve"), so a test demanding the engine deliver
// on it would be demanding wrong behaviour. What that spec does today, on the
// production path — scheduler._executeFlow → pauseRun → deliverAsk →
// resolveFromInbox('approve') → resumeRun — is:
//
//     run status : success
//     DELIVERED  : []
//
// The person approved. The customer received nothing. No error, no trace, and
// `run_completed`. Verbatim BRANCH_CASE_NOT_IN_ENUM's own reason for existing.

test('`timeout` is a legitimate case on a human branch (the positive case)', () => {
  // Guards the fix from over-correcting: `timeout` is in a human node\'s closed
  // domain (closedDomainOf) because the sweeper injects it, so a branch that
  // handles it explicitly must be ACCEPTED. A check that rejected this would be
  // an outage, not a check.
  assert.deepEqual(codesOf(specWithCases([
    { when: 'approve', to: 'send' },
    { when: 'timeout', to: 'dropped' },
    { when: '*',       to: 'dropped' },
  ])).filter(c => c === 'BRANCH_CASE_NOT_IN_ENUM'), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// F2. A `human` NODE ALONE IS NOT A GATE — AND NOTHING SAYS SO
//
// `src/converger/escalation.js:158` states the invariant outright:
//
//     "The branch is NOT optional. A `human` node followed directly by the step
//      it 'approves' is an approval gate that IGNORES THE ANSWER — the step runs
//      whether the person said yes or no. It looks exactly like a gate and does
//      exactly nothing, which is worse than having none."
//
// …and then: "Every part of this shape is load-bearing, and the validator will
// reject it if any is missing." It will not. There is no such rule. `draft → ask
// → send` validates clean, and a REJECTED draft is delivered to the customer.
//
// The gate must hold on BOTH sides — the validator (so it cannot be built) and
// the engine (so a spec already in the database cannot do it either). That is the
// same doctrine BRANCH_TARGET_EXTRA_PARENT already follows: "The engine does not
// rely on the validator having run — specs already in the database predate the
// rule."
// ═══════════════════════════════════════════════════════════════════════════

const UNGATED = flow([
  { id: 'draft', type: 'llm',   config: { mode: 'freeform', prompt: 'draft a reply' } },
  { id: 'ask',   type: 'human', config: ASK() },
  { id: 'send',  type: 'deliver', config: { channel: 'slack', target: '#customer' } },
], [{ from: 'draft', to: 'ask' }, { from: 'ask', to: 'send' }]);

test('an approval whose answer nothing reads is REJECTED at build time', () => {
  // No branch consumes `{{ask.decision}}`, so the answer changes nothing. The
  // person is asked a question whose outcome is already decided.
  assert.notDeepEqual(
    codesOf(UNGATED), [],
    'a `human` node whose decision no branch routes on is a gate that ignores the answer — it must not publish',
  );
});

test('a REJECTED draft is never delivered, even when the spec forgot the branch', async () => {
  const h = harness({ spec: UNGATED });
  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });
  const [paused] = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });

  await h.service.resolveFromInbox({
    tenantId: 'tenant-a', userId: 'user-1', runId: paused.id, nodeId: 'ask', decision: 'reject',
  });

  // The observable effect, with NOTHING between the step under test and the
  // assertion: what did the customer actually receive?
  assert.deepEqual(
    h.sent, [],
    'THE PERSON SAID NO AND THE CUSTOMER RECEIVED THE DRAFT ANYWAY. ' +
    'An approval the engine does not enforce is not an approval.',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// F3. SILENCE BECOMES CONSENT
//
// `workflow-scheduler.js` sweepTimeouts() says, in its own docblock:
//
//     "It never resolves as `approve`. An approval must never be the default, and
//      silence is not consent."
//
// It does. `timeout: { after: '48h', then: 'approve' }` passes HUMAN_BAD_TIMEOUT
// (workflow-validator.js:483 — `allowed` is every decision the node declares, and
// `approve` is one of them), and the sweeper then hands the engine `approve` with
// `by: 'system:timeout'`. Nobody read the draft; the customer got it.
//
// The LLM writes these specs. "If nobody answers in 48h, just send it" is a
// sentence a user says out loud, and there is nothing in the system that says no.
// ═══════════════════════════════════════════════════════════════════════════

const CONSENT_BY_SILENCE = flow([
  { id: 'draft', type: 'llm',   config: { mode: 'freeform', prompt: 'draft a reply' } },
  { id: 'ask',   type: 'human', config: ASK({ timeout: { after: '48h', then: 'approve' } }) },
  { id: 'gate',  type: 'branch', config: {
    on: '{{ask.decision}}',
    cases: [{ when: 'approve', to: 'send' }, { when: '*', to: 'dropped' }],
  } },
  { id: 'send',    type: 'deliver',  config: { channel: 'slack', target: '#customer' } },
  { id: 'dropped', type: 'assemble', config: { title: 'Not approved.', sections: '[]' } },
], [
  { from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' },
  { from: 'gate', to: 'send' }, { from: 'gate', to: 'dropped' },
]);

test('HUMAN_BAD_TIMEOUT rejects `then: approve` — an approval is never the default answer', () => {
  assert.ok(
    codesOf(CONSENT_BY_SILENCE).includes('HUMAN_BAD_TIMEOUT'),
    '"if nobody answers in 48h, just send it" is a sentence a user says out loud, and an LLM will write it. ' +
    'Nothing in the system says no.',
  );
  // The positive case, so a fix cannot be `if (true)`: the declared answers a
  // timeout MAY take must still be accepted.
  const ok = (then) => codesOf(flow(
    CONSENT_BY_SILENCE.nodes.map(n => n.id === 'ask'
      ? { ...n, config: ASK({ timeout: { after: '48h', then } }) } : n),
    CONSENT_BY_SILENCE.edges,
  ));
  assert.deepEqual(ok('reject'),   [], '`then: reject` is the whole point of the feature');
  assert.deepEqual(ok('escalate'), [], '…and so is `then: escalate`');
});

test('the sweeper NEVER hands the engine `approve`, however the spec spells it', async () => {
  // The run-time half. The rule above stops it being BUILT; this stops a spec
  // already in the database from doing it — the doctrine BRANCH_TARGET_EXTRA_PARENT
  // already follows ("the engine does not rely on the validator having run").
  // sweepTimeouts()'s own docblock promises exactly this: "It never resolves as
  // `approve`. An approval must never be the default, and silence is not consent."
  const h = harness({ spec: CONSENT_BY_SILENCE });
  await h.scheduler._executeFlow(h.workflow, { trigger: 'scheduled' });
  const [paused] = h.ws.listAwaitingHuman({ tenantId: 'tenant-a' });
  expireAllPauses(h.ws);

  assert.equal(await h.scheduler.sweepTimeouts(), 1, 'the sweeper found the expired pause');

  const run = h.ws.getRun(paused.id);
  const answered = run.steps.find(s => s.type === 'human_answered');
  assert.notEqual(
    answered?.decision, 'approve',
    'NOBODY ANSWERED AND THE SYSTEM ANSWERED "approve" ON THEIR BEHALF (by: system:timeout)',
  );
  assert.deepEqual(h.sent, [], 'and the customer received a draft no person ever read');
});

// ═══════════════════════════════════════════════════════════════════════════
// F4. WEAK_APPROVAL_FOR_WRITE IS LAUNDERED BY A `foreach`
//
// `isWriteNode()` (workflow-validator.js:1177) asks `node.type === 'deliver'` or
// `connector-action` + a writing action. It never looks inside a `foreach`'s
// `steps`. So the identical write, guarded by the identical email-only approval,
// is REJECTED at top level and ACCEPTED one hop inside a loop.
//
// A loop is N writes per fire — by CLAUDE.md's own words, "the highest-risk write
// shape the engine has, and the whole reason `foreach` exists". It is the one
// place the rule most needs to hold, and the one place it does not.
// ═══════════════════════════════════════════════════════════════════════════

const EMAIL_ONLY_GATE = {
  prompt: 'Create these records?',
  decisions: ['approve', 'reject'],
  channels: [{ type: 'email', to: 'ops@acme.com' }],
  timeout: { after: '48h', then: 'reject' },
};

/** `notify` is a SIBLING of the ask, not a descendant — so the only thing the
 *  approval guards is the write. */
const writeGuardedBy = (work) => flow([
  { id: 'rows',    type: 'connector-action', config: { action: 'airtable_list_records', baseId: 'b', tableId: 't' } },
  { id: 'notify',  type: 'deliver', config: { channel: 'slack', target: '#log' } },
  { id: 'ask',     type: 'human',   config: EMAIL_ONLY_GATE },
  { id: 'gate',    type: 'branch',  config: { on: '{{ask.decision}}', cases: [{ when: 'approve', to: 'work' }, { when: '*', to: 'dropped' }] } },
  work,
  { id: 'dropped', type: 'assemble', config: { title: 'Not approved', sections: '[]' } },
], [
  { from: 'rows', to: 'notify' }, { from: 'rows', to: 'ask' }, { from: 'ask', to: 'gate' },
  { from: 'gate', to: 'work' }, { from: 'gate', to: 'dropped' },
]);

test('WEAK_APPROVAL_FOR_WRITE sees a write INSIDE a foreach — one write or a hundred', () => {
  const ONE = { id: 'work', type: 'connector-action', idempotency: { key: 'k' },
    config: { action: 'airtable_create_record', baseId: 'b', tableId: 't', fields: '{}' } };
  const MANY = { id: 'work', type: 'foreach', config: { over: 'rows.output', steps: [
    { id: 'mk', type: 'connector-action', idempotency: { key: '{{item}}' },
      config: { action: 'airtable_create_record', baseId: 'b', tableId: 't', fields: '{}' } },
  ] } };

  // The control: ONE write behind an emailed link is already refused.
  assert.ok(
    codesOf(writeGuardedBy(ONE)).includes('WEAK_APPROVAL_FOR_WRITE'),
    'the rule works on a top-level write',
  );

  assert.ok(
    codesOf(writeGuardedBy(MANY)).includes('WEAK_APPROVAL_FOR_WRITE'),
    'N writes in a loop behind a FORWARDABLE emailed link must be refused too — ' +
    'a loop is the highest-risk write shape the engine has, not an exemption from the rule',
  );
});
