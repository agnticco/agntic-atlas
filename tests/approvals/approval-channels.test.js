/**
 * P12 Increment D — the ASK, over each channel, and the ANSWER back from it.
 *
 * The companion to approval-store.test.js, which pins the token model and the
 * resume. This one pins the half that actually reaches a person: the Block Kit
 * message, the magic-link email, the in-app notification — and each channel's
 * answer coming back with WHO gave it.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * These paths WERE covered — but only by `scripts/checks/approval-adversarial.mjs`,
 * which the mutation sweep does not run (it runs `node:test` suites). So the sweep
 * reported the entire Slack/email surface as unkillable, and it was right to: a
 * mutant is only killable by a suite that EXECUTES it, and "some other script
 * covers it" is exactly the reasoning that leaves a guard nothing pins. The
 * survivor list IS the coverage report, and this file is what it asked for.
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

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

/**
 * The production wiring: a real store, a real scheduler, a real FlowTester, and
 * the ApprovalService constructed the way server.js constructs it — with a
 * postSlack, a sendMail and a baseUrl. A harness that omitted them would be
 * testing a deployment nobody runs (ENGINEERING-LOG.md, architectural flaw #2).
 */
function harness({ channels, decisions = ['approve', 'reject'], timeout = { after: '48h', then: 'reject' }, slackFails = false, mailer = true } = {}) {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();

  const posted = [], mailed = [], inboxed = [], sent = [];

  const flowTester = new FlowTester({
    nodeTypes,
    llm: { invoke: async () => ({ content: 'DRAFTED REPLY' }) },
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
    inboxStore: { create: (m) => { inboxed.push(m); return { id: 'i' + inboxed.length }; } },
    resumeRun: (run, answer) => scheduler.resumeRun(run, answer),
    postSlack: async (msg) => {
      if (slackFails) throw new Error('slack is down');
      posted.push(msg);
      return { ok: true, ts: '1.0' };
    },
    sendMail: mailer ? async (m) => { mailed.push(m); } : null,
    baseUrl: () => 'https://atlas.example.com/',
  });
  scheduler.registerAskDeliverer((ctx) => service.deliverAsk(ctx));
  scheduler.registerTimeoutHook((ctx) => service.onTimeout(ctx));

  const workflow = ws.create({
    name: 'Reply to the customer', kind: 'flow', status: 'active',
    tenantId: 'tenant-a', userId: 'user-1',
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [
      { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'draft' } },
      { id: 'ask',   type: 'human', config: { prompt: 'Send this reply?', preview: '{{draft.output}}', decisions, channels, timeout } },
      { id: 'gate',  type: 'branch', config: { on: '{{ask.decision}}', cases: [{ when: decisions[0], to: 'send' }, { when: '*', to: 'dropped' }] } },
      { id: 'send',    type: 'deliver',  config: { channel: 'slack', target: '#ops' } },
      { id: 'dropped', type: 'assemble', config: { title: 'Not approved.', sections: '[]' } },
    ],
    edges: [
      { from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' },
      { from: 'gate', to: 'send' }, { from: 'gate', to: 'dropped' },
    ],
  });

  const park = async () => {
    await scheduler._executeFlow(ws.get(workflow.id), { trigger: 'scheduled' });
    return ws.listAwaitingHuman({ tenantId: 'tenant-a' })[0];
  };

  return { ws, scheduler, service, approvals, workflow, park, posted, mailed, inboxed, sent };
}

// ── The Slack ask ────────────────────────────────────────────────────────────

test('slack: the ask goes out as Block Kit, with a button per decision', async () => {
  const h = harness({ channels: [{ type: 'slack', target: '#ops' }] });
  const run = await h.park();

  assert.equal(h.posted.length, 1, 'one message, to the channel the node named');
  const msg = h.posted[0];
  assert.equal(msg.channel, '#ops');
  assert.equal(msg.tenantId, 'tenant-a', 'posted as the TENANT\'s bot — an approval is asked in the workspace whose data it concerns');
  assert.ok(msg.text, 'a fallback text, or the Slack notification is blank');

  const actions = msg.blocks.find(b => b.type === 'actions');
  assert.equal(actions.elements.length, 2, 'a button per decision');
  // The value routes the click back to the exact (run, node, decision). It is not
  // a credential — the request SIGNATURE is — but it must be right, or the click
  // answers the wrong question.
  assert.deepEqual(actions.elements.map(e => e.value), [
    `${run.id}:ask:approve`,
    `${run.id}:ask:reject`,
  ]);

  // The person must SEE what they are approving. An approval button with no
  // preview is a request to rubber-stamp something invisible.
  const preview = msg.blocks.filter(b => b.type === 'section').map(b => b.text.text).join('\n');
  assert.ok(preview.includes('DRAFTED REPLY'), 'the draft is in the message');
});

test('slack: the answer carries WHICH Slack user clicked', async () => {
  const h = harness({ channels: [{ type: 'slack', target: '#ops' }] });
  const run = await h.park();

  const res = await h.service.resolveFromSlack({
    tenantId: 'tenant-a', slackUserId: 'U-DANA', runId: run.id, nodeId: 'ask', decision: 'approve',
  });

  assert.equal(res.ok, true);
  assert.equal(h.sent.length, 1, 'the approved step ran');
  const answered = h.ws.getRun(run.id).steps.find(s => s.type === 'human_answered');
  assert.equal(answered.by, 'slack:U-DANA', 'the audit trail names the human, not "slack"');
  assert.equal(answered.channel, 'slack');
});

test('slack: an answer for an unknown workspace resolves nothing', async () => {
  const h = harness({ channels: [{ type: 'slack', target: '#ops' }] });
  const run = await h.park();
  const res = await h.service.resolveFromSlack({ tenantId: null, slackUserId: 'U', runId: run.id, nodeId: 'ask', decision: 'approve' });
  assert.equal(res.ok, false);
  assert.equal(h.sent.length, 0);
});

// ── The email ask: signed, single-use magic links ────────────────────────────

test('email: one magic link PER DECISION, and they are different secrets', async () => {
  const h = harness({ channels: [{ type: 'email', to: 'ops@acme.test' }] });
  const run = await h.park();

  assert.equal(h.mailed.length, 1);
  const body = h.mailed[0].text;
  const links = [...body.matchAll(/https:\/\/atlas\.example\.com\/approvals\/([A-Za-z0-9_-]+)/g)].map(m => m[1]);

  assert.equal(links.length, 2, 'an approve link and a reject link');
  assert.notEqual(links[0], links[1],
    'DIFFERENT tokens — if the decision rode in a query param, anyone with the approve link could edit it into a reject');

  // Each token resolves to the decision it was minted for, and only that one.
  assert.equal(h.service.peekToken(links[0]).decision, 'approve');
  assert.equal(h.service.peekToken(links[1]).decision, 'reject');
});

test('email: the TTL is the node\'s own timeout — not a hardcoded default', async () => {
  const h = harness({ channels: [{ type: 'email', to: 'ops@acme.test' }], timeout: { after: '30m', then: 'reject' } });
  await h.park();

  const row = h.approvals.db.prepare('SELECT created_at, expires_at FROM approval_tokens LIMIT 1').get();
  const ttl = new Date(row.expires_at) - new Date(row.created_at);
  assert.equal(ttl, 30 * 60 * 1000, 'a link that outlives the question it asks is a standing invitation');
});

test('email: peekToken LOOKS, and does not consume (the mail-scanner prefetch)', async () => {
  const h = harness({ channels: [{ type: 'email', to: 'ops@acme.test' }] });
  const run = await h.park();
  const token = [...h.mailed[0].text.matchAll(/approvals\/([A-Za-z0-9_-]+)/g)][0][1];

  const peeked = h.service.peekToken(token);
  assert.equal(peeked.prompt, 'Send this reply?');
  assert.ok(peeked.preview.includes('DRAFTED REPLY'), 'the page shows what is being approved');

  // Peeking twice must still work — a scanning proxy may fetch it many times.
  assert.ok(h.service.peekToken(token), 'still valid after a peek');
  assert.equal(h.ws.listAwaitingHuman({ tenantId: 'tenant-a' }).length, 1, 'and the run is STILL waiting for a person');

  // Only the POST decides.
  const res = await h.service.resolveFromToken(token);
  assert.equal(res.ok, true);
  assert.equal(h.sent.length, 1);
  const answered = h.ws.getRun(run.id).steps.find(s => s.type === 'human_answered');
  assert.equal(answered.channel, 'email');
});

test('email: peekToken on a garbage/unknown token returns null rather than throwing', () => {
  const h = harness({ channels: [{ type: 'inbox' }] });
  assert.equal(h.service.peekToken('not-a-real-token'), null);
  assert.equal(h.service.peekToken(''), null);
});

// ── Many channels at once ────────────────────────────────────────────────────

test('the ask goes out over EVERY channel, and the first valid answer wins', async () => {
  const h = harness({ channels: [{ type: 'inbox' }, { type: 'slack', target: '#ops' }, { type: 'email', to: 'ops@acme.test' }] });
  const run = await h.park();

  assert.equal(h.inboxed.length, 1, 'asked in-app…');
  assert.equal(h.posted.length, 1, '…and in Slack…');
  assert.equal(h.mailed.length, 1, '…and by email');

  // Somebody answers in Slack. The emailed links must die with it — otherwise a
  // second reader answers a question that already has an answer.
  await h.service.resolveFromSlack({ tenantId: 'tenant-a', slackUserId: 'U-DANA', runId: run.id, nodeId: 'ask', decision: 'approve' });

  const token = [...h.mailed[0].text.matchAll(/approvals\/([A-Za-z0-9_-]+)/g)][0][1];
  assert.equal(h.service.peekToken(token), null, 'the magic link is dead the moment the question is answered elsewhere');
  const late = await h.service.resolveFromToken(token);
  assert.equal(late.ok, false);
  assert.equal(h.sent.length, 1, 'AND THE CUSTOMER WAS EMAILED EXACTLY ONCE');
});

test('one channel failing does not silence the others', async () => {
  // Slack is down. The question still reaches the person in the inbox — an outage
  // at Slack must not mean an approval nobody ever sees.
  const h = harness({ channels: [{ type: 'inbox' }, { type: 'slack', target: '#ops' }], slackFails: true });
  const run = await h.park();

  assert.equal(h.posted.length, 0, 'Slack failed');
  assert.equal(h.inboxed.length, 1, 'the inbox ask still went out');
  assert.ok(run, 'and the run is parked, waiting — not failed');
});

test('if NO channel works, deliverAsk throws — a question nobody was asked is not a success', async () => {
  const h = harness({ channels: [{ type: 'slack', target: '#ops' }], slackFails: true });
  const run = await h.park();

  // The run is still parked with its deadline, so it cannot hang forever — the
  // timeout will fire. But `deliverAsk` must not report success: the scheduler
  // logs this loudly, and swallowing it would mean an approval silently vanishing.
  await assert.rejects(
    () => h.service.deliverAsk({ workflow: h.ws.get(h.workflow.id), run, ask: run.pending_ask, expiresAt: null }),
    /could not be delivered/,
  );
});

test('an unsupported channel type is refused, never quietly downgraded', async () => {
  const h = harness({ channels: [{ type: 'inbox' }, { type: 'carrier_pigeon' }] });
  const run = await h.park();
  // The good channel still delivered; the unknown one failed rather than being
  // "handled" by falling back to something weaker.
  assert.equal(h.inboxed.length, 1);
  assert.ok(run, 'the run parked');
});

test('deliverAsk with no tenant THROWS — an unscoped approval cannot be checked', async () => {
  const h = harness({ channels: [{ type: 'inbox' }] });
  const run = await h.park();
  await assert.rejects(
    () => h.service.deliverAsk({ workflow: { id: 'w', name: 'x' }, run: { id: 'r' }, ask: run.pending_ask }),
    /no tenant/,
  );
});

// ── The answer must be one the node actually offers ──────────────────────────

test('an answer the node does not offer is refused BEFORE the run is resumed', async () => {
  const h = harness({ channels: [{ type: 'inbox' }], decisions: ['ship', 'hold'] });
  const run = await h.park();

  const res = await h.service.resolveFromInbox({
    tenantId: 'tenant-a', userId: 'user-1', runId: run.id, nodeId: 'ask', decision: 'approve',
  });

  assert.equal(res.ok, false, '"approve" is not one of {ship, hold}');
  assert.match(res.reason, /not one of the answers/);
  // The critical part: the run is STILL ANSWERABLE. Had this reached the engine,
  // the executor would have thrown mid-resume — after the run was flipped out of
  // `awaiting_human`, leaving a question nobody could ever answer again.
  assert.equal(h.ws.listAwaitingHuman({ tenantId: 'tenant-a' }).length, 1);

  const good = await h.service.resolveFromInbox({
    tenantId: 'tenant-a', userId: 'user-1', runId: run.id, nodeId: 'ask', decision: 'ship',
  });
  assert.equal(good.ok, true, 'and the answer it DOES offer works');
  assert.equal(h.sent.length, 1);
});

test('an empty answer is refused', async () => {
  const h = harness({ channels: [{ type: 'inbox' }] });
  const run = await h.park();
  const res = await h.service.resolveFromInbox({ tenantId: 'tenant-a', userId: 'user-1', runId: run.id, nodeId: 'ask', decision: '' });
  assert.equal(res.ok, false);
  assert.equal(h.ws.listAwaitingHuman({ tenantId: 'tenant-a' }).length, 1, 'still waiting for a real answer');
});

test('an answer aimed at the wrong NODE of a real run is refused', async () => {
  const h = harness({ channels: [{ type: 'inbox' }] });
  const run = await h.park();
  const res = await h.service.resolveFromInbox({
    tenantId: 'tenant-a', userId: 'user-1', runId: run.id, nodeId: 'some_other_step', decision: 'approve',
  });
  assert.equal(res.ok, false);
  assert.equal(h.sent.length, 0);
});

test('resolving without a signed-in user is refused', async () => {
  const h = harness({ channels: [{ type: 'inbox' }] });
  const run = await h.park();
  const res = await h.service.resolveFromInbox({ tenantId: 'tenant-a', userId: null, runId: run.id, nodeId: 'ask', decision: 'approve' });
  assert.equal(res.ok, false);
  assert.equal(h.sent.length, 0);
});

// ── The escalation flag Increment B left inert ───────────────────────────────

test('on_error `escalate` reaches the escalation notifier — B\'s flag, D\'s inbox', async () => {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();
  const escalations = [];

  const flowTester = new FlowTester({
    nodeTypes,
    llm: { invoke: async () => { throw new Error('the model is down'); } },
    channelRegistry: { get: (id) => ({ id, available: true }), getHandler: () => async () => ({ delivered: true }) },
  });
  const scheduler = new WorkflowScheduler({ workflowStore: ws, sourceRegistry: null, flowTester });
  scheduler.registerEscalationNotifier(async (ctx) => { escalations.push(ctx); });

  const wf = ws.create({
    name: 'Escalating flow', kind: 'flow', status: 'active',
    tenantId: 'tenant-a', userId: 'user-1',
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [{ id: 'work', type: 'llm', config: { mode: 'freeform', prompt: 'do it' }, on_error: { then: 'escalate' } }],
    edges: [],
  });

  await scheduler._executeFlow(ws.get(wf.id), { trigger: 'scheduled' });

  assert.equal(escalations.length, 1, 'the failure was escalated to a person, not left to die in a log');
  assert.equal(escalations[0].nodeId, 'work');
  assert.match(escalations[0].error, /the model is down/);
  // And the run still FAILS. A person acknowledging a failure does not make it a success.
  assert.equal(ws.getLastRun(wf.id).status, 'error');
});

// ── A pause the deployment cannot ask about must not park silently ───────────

test('a pause with NO ask deliverer wired FAILS the run rather than hanging forever', async () => {
  const ws = new WorkflowStore({ dbPath: ':memory:' });
  ws.init();
  const flowTester = new FlowTester({
    nodeTypes,
    llm: { invoke: async () => ({ content: 'draft' }) },
    channelRegistry: { get: (id) => ({ id, available: true }), getHandler: () => async () => ({ delivered: true }) },
  });
  // No registerAskDeliverer — a misconfigured or partial boot.
  const scheduler = new WorkflowScheduler({ workflowStore: ws, sourceRegistry: null, flowTester });

  const wf = ws.create({
    name: 'Unaskable', kind: 'flow', status: 'active',
    tenantId: 'tenant-a', userId: 'user-1',
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [{ id: 'ask', type: 'human', config: { prompt: 'ok?', decisions: ['approve', 'reject'], channels: [{ type: 'inbox' }], timeout: { after: '48h', then: 'reject' } } }],
    edges: [],
  });

  await scheduler._executeFlow(ws.get(wf.id), { trigger: 'scheduled' });

  assert.equal(ws.listAwaitingHuman({ tenantId: 'tenant-a' }).length, 0,
    'it does NOT park — a run waiting for an answer no surface will ever request is a hang');
  assert.equal(ws.getLastRun(wf.id).status, 'error', 'an honest, visible failure instead');
});

// ── Precise behavioral pins (mutation-sweep survivors) ───────────────────────

test('deliverAsk RESOLVES (does not throw) when at least one channel succeeds', async () => {
  // Kills the mutant that makes the "not one channel worked" throw fire on every
  // call: a successful delivery must return a count, not reject.
  const h = harness({ channels: [{ type: 'inbox' }, { type: 'email', to: 'ops@acme.test' }] });
  const run = await h.park();
  const res = await h.service.deliverAsk({
    workflow: h.ws.get(h.workflow.id), run, ask: run.pending_ask, expiresAt: null,
  });
  assert.equal(res.delivered, 2, 'both channels delivered');
  assert.equal(res.of, 2);
});

test('an inbox-only ask issues NO email tokens (tokens exist only for the email channel)', async () => {
  // Kills the mutant that makes `if (wantsEmail)` always true — minting a
  // forgeable credential for a channel that does not use one.
  const h = harness({ channels: [{ type: 'inbox' }] });
  const run = await h.park();
  const tokenRows = h.approvals.db.prepare('SELECT COUNT(*) n FROM approval_tokens WHERE run_id = ?').get(run.id);
  assert.equal(tokenRows.n, 0, 'no channel needs a token, so none was minted');
  assert.equal(h.inboxed.length, 1, 'and the inbox ask still went out');
});

test('an email ask DOES mint one token per decision', async () => {
  const h = harness({ channels: [{ type: 'email', to: 'ops@acme.test' }], decisions: ['approve', 'reject'] });
  const run = await h.park();
  const n = h.approvals.db.prepare('SELECT COUNT(*) n FROM approval_tokens WHERE run_id = ?').get(run.id).n;
  assert.equal(n, 2, 'one token for approve, one for reject');
});

test('an unsupported channel type REJECTS (its promise throws), it is not silently downgraded', async () => {
  // Kills THROW_GONE on the `unsupported approval channel` guard: the bad channel
  // must fail, while the good one still delivers.
  const h = harness({ channels: [{ type: 'inbox' }, { type: 'carrier_pigeon' }] });
  const run = await h.park();
  const res = await h.service.deliverAsk({
    workflow: h.ws.get(h.workflow.id), run, ask: run.pending_ask, expiresAt: null,
  });
  assert.equal(res.delivered, 1, 'exactly the inbox channel delivered');
  assert.equal(res.of, 2, 'and the unsupported one counted as a channel that failed');
});

test('a magic-link token is refused if the run has since paused on a DIFFERENT node', async () => {
  // Kills the node-guard mutant: a token minted for `ask` must not resolve a run
  // that is now waiting at some other step (defense in depth behind the token).
  const h = harness({ channels: [{ type: 'email', to: 'ops@acme.test' }] });
  const run = await h.park();
  const token = [...h.mailed[0].text.matchAll(/approvals\/([A-Za-z0-9_-]+)/g)][0][1];
  // Move the run's paused node out from under the token.
  h.ws.db.prepare("UPDATE workflow_runs SET paused_node = 'some_other_step' WHERE id = ?").run(run.id);

  const res = await h.service.resolveFromToken(token);
  assert.equal(res.ok, false, 'the token is for "ask", but the run is parked elsewhere');
  assert.equal(h.sent.length, 0);
});

test('the Slack ask omits the preview block when there is no preview', async () => {
  // Kills `if (preview)` always-true: a node with no preview must not emit an
  // empty ``` ``` code block.
  const withPrev = harness({ channels: [{ type: 'slack', target: '#ops' }] });
  await withPrev.park();
  const nPrev = withPrev.posted[0].blocks.filter(b => b.type === 'section').length;

  const noPrev = harness({ channels: [{ type: 'slack', target: '#ops' }] });
  // Strip the preview from the human node.
  noPrev.ws.db.prepare("UPDATE workflows SET nodes = REPLACE(nodes, '\"preview\":\"{{draft.output}}\",', '')").run();
  await noPrev.park();
  const nNoPrev = noPrev.posted[0].blocks.filter(b => b.type === 'section').length;

  assert.ok(nNoPrev < nPrev, 'no preview → one fewer section block (no empty code block)');
});
