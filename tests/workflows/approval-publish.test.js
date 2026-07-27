/**
 * THE FLAGSHIP SHAPE COULD NOT BE PUBLISHED, AND THE REFUSAL NAMED NO CAUSE.
 *
 * ── What a person saw (reproduced identically twice in live QA) ──────────────
 *
 * A workflow shaped "draft a refund reply → a person approves → then send" built
 * fine and every step was approved. Its pre-publish test then failed — every
 * time — and the only thing the person was told was:
 *
 *     nothing reached charles@agntic.co on Slack
 *
 * No cause, nothing to act on, and Go live never appeared. Both halves are
 * pinned here, and they are two independent defects that happened to meet on one
 * screen.
 *
 * ── Defect 1: the two halves of ONE oracle disagreed about ONE node type ─────
 *
 * At BUILD time an approval step's question satisfies a `slack:<someone>`
 * promise — `satisfiesAssertion` routes `type:'human'` into
 * `askSatisfiesAssertion`, and it must, or "DM me to approve" can only be kept by
 * a second `deliver` node that sends the question twice.
 *
 * At RUN time `checkAssertionAtRuntime` reads the run's DELIVERIES and nothing
 * else — and a `human` node produces no delivery at all (`isDeliveryNode` is
 * false for it, and both delivery-assembly sites drop it). So the promise fell
 * through the loop and came back "nothing reached …" deterministically, on every
 * run, for a workflow that was built correctly.
 *
 * ── The judgement call, and why this is NOT "make it pass" ───────────────────
 *
 * The fix is deliberately NOT `ok:true`. A pre-publish test cannot show that the
 * question reached anyone: deliveries are forced dry on that path, the gate is
 * PRE-ANSWERED by the panel so the run never even pauses, and the only code that
 * issues an ask (`ApprovalService.deliverAsk`) is reachable solely from
 * `WorkflowScheduler` — a module the test path never enters. So the verdict is
 * the third one: NOT EXERCISED. Not a pass, not a failure.
 *
 * The anti-false-pass cases below are the load-bearing half:
 *   · a real delivery is still checked strictly, and a genuine miss still FAILS;
 *   · a `human` node that did NOT run on this sample earns nothing;
 *   · a `human` node whose ask goes somewhere ELSE earns nothing;
 *   · an `email` ask still satisfies nothing (it is a platform magic link, not
 *     the tenant's Gmail connector) — the build-time narrowing, held at run time;
 *   · and the positive half: when the run records that the answer came back OVER
 *     the promised connector, the ask WAS issued and it counts.
 *
 * ── Defect 2: the run threw away the diagnosis it was already holding ────────
 *
 * `_dryRunDeliver` records WHY a delivery would not go through — five named
 * checks plus, when a connector `probe` positively refused the destination, an
 * `unreachableReason` in plain English ("no Slack user matches …"). The loop
 * `continue`d past those receipts without reading them and printed the generic
 * sentence instead.
 *
 * ── Watched go red (both, by hand — see the report) ──────────────────────────
 *
 *   · Revert the oracle change (drop the `approvalAskEvidence` branch in
 *     `evaluateExampleRun`) → the FIRST describe block goes red: the flagship
 *     example is judged `broken` again with the bare sentence.
 *   · Revert the reason plumbing (restore the bare
 *     `nothing reached ${describeTarget(...)}`) → the SECOND and THIRD blocks go
 *     red: the receipt's reason never reaches the person.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { FlowTester }               from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import {
  evaluateExampleRun, normalizeDelivery, isDeliveryNode,
  checkAssertionAtRuntime, approvalAskEvidence,
} from '../../src/workflows/outcome-oracle.js';
import { composeRunSummary } from '../../src/workflows/run-summary.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const DRAFT = 'Dear customer — your refund is on its way.';

/** A registry whose real handler MUST never fire: this whole path is dry. */
function recordingRegistry() {
  const sent = [];
  return {
    sent,
    registry: {
      get: (id) => ({ id, available: true }),
      getHandler: (id) => async (args) => { sent.push({ channel: id, body: args.body }); return { delivered: true, ts: `${id}-1` }; },
    },
  };
}

/**
 * THE FLAGSHIP SHAPE: draft → a person approves over `slack:<email>` → send.
 * The promise names BOTH halves, which is what the converger writes for this shape.
 */
function refundApprovalSpec({ askChannels = [{ type: 'slack', target: 'charles@agntic.co' }] } = {}) {
  return {
    name: 'Refund reply with approval', version: 2, triggers: [{ type: 'email' }],
    outcome: {
      statement: 'Atlas drafts the refund reply, asks charles@agntic.co on Slack to approve it, and only then sends it.',
      assertions: [
        { id: 'a_ask',  kind: 'message_sent', target: 'slack:charles@agntic.co' },
        { id: 'a_send', kind: 'message_sent', target: 'gmail:customer@example.com', when: 'approve' },
      ],
    },
    nodes: [
      { id: 'draft', type: 'llm', label: 'Draft the reply',
        config: { mode: 'rewrite', instructions: 'Draft a refund reply.' } },
      { id: 'approve_send', type: 'human', label: 'Approve the reply',
        config: { prompt: 'Send this refund reply?', preview: '{{draft.output}}',
                  decisions: ['approve', 'reject'], channels: askChannels,
                  timeout: { after: '48h', then: 'reject' } } },
      { id: 'gate', type: 'branch', label: 'Route by the answer',
        config: { on: '{{approve_send.decision}}',
                  cases: [{ when: 'approve', to: 'send' }, { when: '*', to: 'stop' }] } },
      { id: 'send', type: 'deliver', label: 'Send the reply',
        config: { channel: 'gmail_send', to: 'customer@example.com', subject: 'Your refund', body: '{{draft.output}}' } },
      { id: 'stop', type: 'assemble', label: 'Stop — rejected', config: {} },
    ],
    edges: [
      { from: 'draft', to: 'approve_send' }, { from: 'approve_send', to: 'gate' },
      { from: 'gate', to: 'send' }, { from: 'gate', to: 'stop' },
    ],
  };
}

/**
 * DRIVE IT THE WAY THE PRE-PUBLISH TEST DOES — a real FlowTester, dry deliveries
 * forced on, the approval gate PRE-ANSWERED, and the run's deliveries assembled
 * from the delivering NODE. Every one of those is copied from
 * `POST /workflows/run` (src/api/server.js), because a check that hands the
 * oracle what production omits is testing a program nobody runs. In particular
 * `channel: 'test_panel'` is what the route stamps on a pre-answered gate — the
 * value that must never be mistaken for a real Slack answer.
 */
async function runPrePublishTest(spec, { decision = 'approve', probe = null } = {}) {
  const { registry, sent } = recordingRegistry();
  if (probe) registry.getProbe = () => probe;
  const ft = new FlowTester({
    nodeTypes, channelRegistry: registry,
    llm: { invoke: async () => ({ content: DRAFT }) },
  });

  const decisions = decision == null ? undefined : {
    approve_send: { decision, by: 'test', at: new Date().toISOString(), channel: 'test_panel' },
  };

  const steps = [];
  let completed = false, error = null, paused = false;
  for await (const ev of ft.run(spec, {
    initialContext: 'A customer is asking for a refund.',
    tenantId: 't1', workflowId: 'w1',
    dryRunDeliveries: true,                 // forced on the real route — never optional
    ...(decisions ? { decisions } : {}),
  })) {
    if (ev.type === 'step_completed')      steps.push({ nodeId: ev.nodeId, output: ev.output });
    else if (ev.type === 'run_completed')  completed = true;
    else if (ev.type === 'run_paused')   { paused = true; break; }
    else if (ev.type === 'run_failed')   { error = ev.error; break; }
  }

  const coerce = (o) => {
    if (o && typeof o === 'object') return o;
    if (typeof o === 'string') { try { return JSON.parse(o); } catch { /* not json */ } }
    return null;
  };
  const nodeById = new Map(spec.nodes.map(n => [n.id, n]));
  const deliveries = steps.map((s) => {
    const node = nodeById.get(s.nodeId);
    const o = coerce(s.output);
    if (!isDeliveryNode(node) && !(o && o.delivered === true)) return null;
    return normalizeDelivery(node, o);
  }).filter(Boolean);

  const result = evaluateExampleRun(
    spec,
    { id: 'e1', label: 'A refund request', given: 'A customer is asking for a refund.', shouldTrigger: true },
    { completed, deliveries, steps, error },
  );
  return { result, deliveries, steps, sent, completed, paused, error };
}

const byId = (r, id) => r.contract.find(c => c.id === id);

// ─────────────────────────────────────────────────────────────────────────────

describe('the pre-publish test reaches an HONEST verdict on the approval shape', () => {
  test('the approval-ask promise is NOT a false failure — and the workflow can be published', async () => {
    const spec = refundApprovalSpec();
    const { result, sent } = await runPrePublishTest(spec);

    assert.equal(sent.length, 0, 'a pre-publish test must send nothing for real');

    const ask = byId(result, 'a_ask');
    assert.equal(ask.ok, true,
      'the approval question must not be reported as a broken promise — nothing in this test even tried to send it');
    assert.doesNotMatch(String(ask.reason ?? ''), /nothing reached/i,
      'the exact live symptom: "nothing reached charles@agntic.co on Slack" on a correctly built workflow');

    // The send half IS proved — this is not a blanket excuse for the whole contract.
    const send = byId(result, 'a_send');
    assert.equal(send.applicable, true, 'the approved lane ran, so the send promise is enforced');
    assert.equal(send.ok, true, 'and it is kept — the would-deliver receipt satisfies it');

    // Verdict: the example certifies, so Go live is reachable at last.
    assert.equal(result.verdict, 'kept',
      'the flagship shape must be able to certify — it could not be published at all before');
  });

  test('the ask promise is NOT a false PASS either — it is reported as unchecked', async () => {
    const { result } = await runPrePublishTest(refundApprovalSpec());
    const ask = byId(result, 'a_ask');

    assert.equal(ask.applicable, false, 'nothing issued the question, so nothing was checked');
    assert.equal(ask.skipped, true);
    assert.match(ask.detail, /not checked here/i,
      'the row must say the question was not checked, never that it was delivered');
    assert.doesNotMatch(ask.detail ?? '', /delivered|sent|posted|as promised/i,
      'an unissued question must never be described as a message that went out');
  });

  test('and the sentence a person reads names the gap instead of claiming every promise held', async () => {
    const spec = refundApprovalSpec();
    const { result } = await runPrePublishTest(spec);
    const s = composeRunSummary({ spec, verdict: 'passed', outcomeResults: [result], laneCoverage: { applicable: true, total: 2, uncovered: [] } });

    assert.doesNotMatch(s, /every promise it makes held/,
      'one promise was never checked — "every promise held" is the vacuous certification this product refuses');
    assert.match(s, /charles@agntic\.co on Slack/, 'the unchecked promise is NAMED');
    assert.match(s, /still unproved/i);
    assert.match(s, /It's cleared to go live/, 'the send half was proved, so publishing is not blocked');
  });

  test('a REJECTED run still certifies nothing it did not do', async () => {
    // The reject lane sends nothing; the conditional send promise does not apply.
    // The ask promise is still unchecked. Neither may read as kept.
    const { result } = await runPrePublishTest(refundApprovalSpec(), { decision: 'reject' });
    assert.equal(byId(result, 'a_send').applicable, false, 'the send promise is about the approve lane only');
    assert.equal(byId(result, 'a_ask').applicable, false, 'the question was still never issued');
    assert.equal(result.verdict, 'not_exercised',
      'nothing was proved on this sample — certifying it would be the F16 vacuous pass');
  });
});

describe('the ask credit is keyed to the RUN, not to the spec — the anti-false-pass half', () => {
  const askAssertion = { id: 'a_ask', kind: 'message_sent', target: 'slack:charles@agntic.co' };

  test('a `human` node that did NOT run on this sample earns nothing', () => {
    const spec = refundApprovalSpec();
    const evidence = approvalAskEvidence(askAssertion, spec, {
      steps: [{ nodeId: 'draft', output: DRAFT }],     // the gate was never reached
    });
    assert.equal(evidence, null,
      'a promise is not excused because a `human` node EXISTS — it must have run on this sample');
  });

  test('a `human` node asking somewhere ELSE earns nothing', () => {
    const spec = refundApprovalSpec({ askChannels: [{ type: 'slack', target: '#ops' }] });
    const evidence = approvalAskEvidence(askAssertion, spec, {
      steps: [{ nodeId: 'approve_send', output: { decision: 'approve', channel: 'test_panel' } }],
    });
    assert.equal(evidence, null,
      'an ask aimed at #ops says nothing about a promise to DM charles@agntic.co');
  });

  test('an EMAIL ask earns nothing against a Gmail promise — the build-time narrowing holds at run time', () => {
    const spec = refundApprovalSpec({ askChannels: [{ type: 'email', to: 'charles@agntic.co' }] });
    const evidence = approvalAskEvidence(
      { id: 'x', kind: 'message_sent', target: 'gmail:charles@agntic.co' },
      spec,
      { steps: [{ nodeId: 'approve_send', output: { decision: 'approve', channel: 'test_panel' } }] },
    );
    assert.equal(evidence, null,
      'an email ask is a platform magic link, not the tenant\'s Gmail connector — it satisfies nothing');
  });

  test('a question a person ANSWERED over the promised channel counts as kept', () => {
    // The production shape of a real Slack approval: ApprovalService resumes the
    // run with { by:'slack:U…', channel:'slack' }. You cannot answer a question
    // you were never asked, so that IS the run's record that the ask was issued.
    const spec = refundApprovalSpec();
    const evidence = approvalAskEvidence(askAssertion, spec, {
      steps: [{ nodeId: 'approve_send', output: { decision: 'approve', by: 'slack:U0B3LM5KRGV', channel: 'slack' } }],
    });
    assert.equal(evidence?.issued, true, 'an answer that came back over Slack proves the question went out over Slack');
  });

  test('the TEST PANEL\'s own answer can never be mistaken for one — `test_panel` matches no connector', () => {
    const spec = refundApprovalSpec();
    const evidence = approvalAskEvidence(askAssertion, spec, {
      steps: [{ nodeId: 'approve_send', output: { decision: 'approve', by: 'test', channel: 'test_panel' } }],
    });
    assert.equal(evidence?.issued, false,
      'both test-panel paths stamp channel:"test_panel" — if that ever credited the ask, every test would falsely pass');
  });

  test('a REAL delivery still wins, and a REAL miss still FAILS', async () => {
    // The ask branch is consulted only after the delivery check has said no, so it
    // can never mask a delivery — and it must never rescue a promise about a
    // destination the approval step has nothing to do with.
    const spec = refundApprovalSpec();
    spec.outcome.assertions = [{ id: 'a_send', kind: 'message_sent', target: 'gmail:someone-else@example.com' }];
    const { result } = await runPrePublishTest(spec);
    const send = byId(result, 'a_send');
    assert.equal(send.ok, false, 'a genuine miss is still a genuine failure — the approval step does not excuse it');
    assert.equal(result.verdict, 'broken');
  });
});

describe('the refusal NAMES A CAUSE — the run already knew why', () => {
  const promise = { id: 'a1', kind: 'message_sent', target: 'slack:charles@agntic.co' };

  test('a receipt carrying an unreachableReason reaches the person, verbatim', () => {
    // The exact receipt `_dryRunDeliver` produces when the slack_dm probe positively
    // refuses the destination (src/connectors/slack/index.js).
    const receipt = normalizeDelivery(
      { id: 'dm', type: 'deliver', config: { channel: 'slack_dm', user: 'charles@agntic.co' } },
      { dryRun: true, wouldDeliver: false, channel: 'slack_dm', target: 'charles@agntic.co',
        checks: { hasBody: true, bodyWellFormed: true, targetPresent: true, capabilityConnected: true, destinationReachable: false },
        unreachableReason: 'no Slack user matches "charles@agntic.co"' },
    );
    assert.equal(receipt.delivered, false, 'a wouldDeliver:false receipt is not a delivery');

    const r = checkAssertionAtRuntime(promise, [receipt]);
    assert.equal(r.ok, false, 'and it must still refuse — naming a cause is not the same as forgiving one');
    assert.match(r.reason, /no Slack user matches "charles@agntic\.co"/,
      'the reason the run recorded must reach the person — it was being discarded and replaced with a generic sentence');
  });

  test('and it reaches the SENTENCE the person actually reads, not just the panel', () => {
    const spec = { name: 'Refund reply with approval', outcome: { statement: 'x', assertions: [promise] } };
    const receipt = normalizeDelivery(
      { id: 'dm', type: 'deliver', config: { channel: 'slack_dm', user: 'charles@agntic.co' } },
      { dryRun: true, wouldDeliver: false, channel: 'slack_dm',
        checks: { hasBody: true, bodyWellFormed: true, targetPresent: true, capabilityConnected: true, destinationReachable: false },
        unreachableReason: 'no Slack user matches "charles@agntic.co"' },
    );
    const result = evaluateExampleRun(spec, { label: 'A refund request' },
      { completed: true, error: null, deliveries: [receipt], steps: [{ nodeId: 'dm', output: receipt }] });

    // composeRunSummary → brokenReason → the assertion's own `reason`.
    const s = composeRunSummary({ spec, verdict: 'failed', outcomeResults: [result], laneCoverage: { uncovered: [] } });
    assert.match(s, /no Slack user matches "charles@agntic\.co"/,
      'the chat sentence is composed from the run\'s evidence — the cause must survive the trip');
    assert.notEqual(
      s, 'Atlas ran 1 example of Refund reply with approval and it didn\'t keep its promise. “A refund request” fell short: nothing reached charles@agntic.co on Slack. Nothing goes live until that\'s fixed.',
      'this is the exact unactionable sentence QA was given twice');
  });

  test('"nothing was even attempted" is told apart from "it was attempted and refused"', () => {
    const nothing = checkAssertionAtRuntime(promise, []);
    assert.match(nothing.reason, /no step in this run attempted it/,
      'no receipt at all means nothing tried — a different problem with a different fix');

    const refused = checkAssertionAtRuntime(promise, [normalizeDelivery(
      { id: 'dm', type: 'deliver', config: { channel: 'slack_dm', user: 'charles@agntic.co' } },
      { dryRun: true, wouldDeliver: false, channel: 'slack_dm',
        checks: { hasBody: true, bodyWellFormed: true, targetPresent: true, capabilityConnected: false, destinationReachable: null } },
    )]);
    assert.doesNotMatch(refused.reason, /no step in this run attempted it/);
    assert.match(refused.reason, /not connected/i,
      'the run recorded WHICH of the five checks failed — say that, do not fall back to the generic line');
  });

  test('"it delivered, but not to you" says where it actually went', () => {
    const elsewhere = normalizeDelivery(
      { id: 'post', type: 'deliver', config: { channel: 'slack', target: '#ops' } },
      { delivered: true, channel: 'slack', target: '#ops', ts: '1' },
    );
    const r = checkAssertionAtRuntime(promise, [elsewhere]);
    assert.equal(r.ok, false, 'a delivery to #ops does not keep a promise to DM a person');
    assert.match(r.reason, /this run delivered to/i);
    assert.match(r.reason, /#ops/, 'name where it went — that is the whole fix a person needs to make');
  });

  test('each named check is reported, in the order the dry run evaluates them', () => {
    const receiptWith = (checks) => normalizeDelivery(
      { id: 'dm', type: 'deliver', config: { channel: 'slack_dm', user: 'charles@agntic.co' } },
      { dryRun: true, wouldDeliver: false, channel: 'slack_dm', checks },
    );
    const base = { hasBody: true, bodyWellFormed: true, targetPresent: true, capabilityConnected: true, destinationReachable: null };

    assert.match(checkAssertionAtRuntime(promise, [receiptWith({ ...base, hasBody: false })]).reason,
      /no content to send/i);
    assert.match(checkAssertionAtRuntime(promise, [receiptWith({ ...base, bodyWellFormed: false })]).reason,
      /unfilled \{\{…\}\} placeholder/i);
    assert.match(checkAssertionAtRuntime(promise, [receiptWith({ ...base, targetPresent: false })]).reason,
      /no destination was filled in/i);
    assert.match(checkAssertionAtRuntime(promise, [receiptWith({ ...base, destinationReachable: false })]).reason,
      /destination could not be reached/i);
  });

  test('a receipt with NO diagnosis says so rather than inventing one', () => {
    const bare = normalizeDelivery(
      { id: 'dm', type: 'deliver', config: { channel: 'slack_dm', user: 'charles@agntic.co' } },
      { dryRun: true, wouldDeliver: false, channel: 'slack_dm' },
    );
    const r = checkAssertionAtRuntime(promise, [bare]);
    assert.match(r.reason, /did not record why/i,
      'filling a gap in the evidence with a plausible cause is the defect this whole file guards against');
  });

  test('the generic opening is KEPT — the cause is added to it, never substituted for it', () => {
    const r = checkAssertionAtRuntime(promise, []);
    assert.match(r.reason, /^nothing reached charles@agntic\.co on Slack/,
      'callers and the panel both key off this opening; the cause rides after it');
  });
});
