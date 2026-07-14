/**
 * decision — LIVE DEFECTS. (P12 Increment E, written by the test-adversary.)
 *
 * ⚠️  EVERY TEST IN THIS FILE IS CURRENTLY RED, AND THAT IS THE POINT.
 *
 * The Builder wrote decision.js and he wrote decision-node.test.js. Code and tests
 * from one mind share one set of blind spots: he tested the cases he thought of,
 * which are the cases he already handled. Each test below is a REPRODUCTION — a
 * validator-clean spec whose run silently does the wrong thing — not a style
 * complaint. The adversary may not touch src/, so a test that cannot pass without a
 * source change is a FINDING, reported and left failing.
 *
 * Green them by fixing the engine. NEVER by weakening the assertion.
 *
 * This file is deliberately NOT in scripts/checks/mutation-sweep.mjs SUITES (the
 * sweep refuses to run when its suites are red, mutation-sweep.mjs:270) and NOT in
 * scripts/gates/p12.sh. Add it to both in the same commit that fixes the defects —
 * the pinning half already lives in ./decision-pinning.test.js and is in the sweep
 * now.
 *
 *   A1  a decision INSIDE a foreach becomes the delivered body   (silent)
 *   A2  a decision's own INPUT launders free text past the moat   (silent)
 *   A3  the AI classifier returns a value the model did not pick  (silent)
 *   A4  a null extracted field decides via the '-' catch-all      (silent)
 *   A5  a 'from' publish accepts and the engine cannot resolve    (loud)
 *   A6  the engine and the analyser read one condition two ways   (loud)
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { decisionNodeType }               from '../../src/workflows/node-types/decision.js';
import { analyzeTable, matchesCondition } from '../../src/workflows/decision-analysis.js';
import { WorkflowValidator }              from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }               from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes }       from '../../src/workflows/node-types/index.js';
import { FlowTester }                     from '../../src/workflows/flow-tester.js';
import { scoreGap }                       from '../../src/converger/gap-scorer.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());

/**
 * PRODUCTION constructs the validator WITH a channel registry (server.js:542) and
 * the gap scorer WITH a capability catalog (builder.js). A check that hands the
 * unit something production omits — or omits something production hands in — is
 * testing a program nobody runs. That was architectural flaw #2, and it is how
 * increment C's `complete ⇒ publishable` blocker stayed invisible.
 */
const CHANNELS = [
  { id: 'slack',  label: 'Slack', available: true, positions: ['delivery'], params: [] },
  { id: 'in_app', label: 'Inbox', available: true, positions: ['delivery'], params: [] },
];
const channelRegistry = {
  get:        (id) => CHANNELS.find(c => c.id === id) ?? null,
  getAll:     () => CHANNELS,
  getHandler: () => async () => ({ delivered: true, ts: '1.0' }),
};
const validator    = new WorkflowValidator({ nodeTypes, channelRegistry });
const capabilities = { channels: CHANNELS, approvalChannels: [{ type: 'inbox', connected: true }] };

/** A channel registry that RECORDS what was actually sent. Nothing between the step and the assertion. */
const ACTIONS = new Set(['airtable_search_records', 'airtable_get_record']);
const recordingChannels = (sent, rows = null, record = null) => ({
  get: (id) => ({ id, available: true, actionOnly: ACTIONS.has(id) }),
  getHandler: (id) => async (args) => {
    if (id === 'airtable_search_records') return rows;
    if (id === 'airtable_get_record')     return record;
    sent.push(args.body);
    return { delivered: true, ts: '1.0' };
  },
});

const stubLlm = (reply) => ({ invoke: async () => ({ content: reply }) });

async function runAll(tester, flow, options = {}) {
  const events = [];
  for await (const evt of tester.run(flow, options)) events.push(evt);
  return events;
}
const outputOf = (events, id) => {
  const e = events.find(x => x.type === 'step_completed' && x.nodeId === id);
  if (!e || typeof e.output !== 'string') return e?.output;
  try { return JSON.parse(e.output); } catch { return e.output; }
};
const errorsOf = (events) => events.filter(e => e.type === 'step_failed').map(e => e.error);

const spec = (nodes, edges) => ({
  version: 2, name: 'Triage',
  outcome: { statement: 'route it', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
  triggers: [{ type: 'email' }],
  nodes, edges,
});

const ctxWith = (lastOutput, extra = {}) => ({
  outputs: new Map(), lastOutput, ancestorOutputs: [], nodeIds: new Set(), ...extra,
});

// ═════════════════════════════════════════════════════════════════════════════
// PART A — LIVE DEFECTS. These are RED. Each is a reproduction.
// ═════════════════════════════════════════════════════════════════════════════

describe('A. live defects', () => {

  /**
   * A1 — A DECISION'S OUTPUT BECOMES THE DELIVERED BODY INSIDE A `foreach`.
   *
   * CLAUDE.md (Increment B): "`branch` and `human` are CONTROL nodes — their output
   * never becomes `lastOutput`. This holds on BOTH executors — the top-level loop
   * (flow-tester.js, CONTROL_TYPES) *and* the `foreach` sub-loop, which has its own
   * executor (foreach.js, CONTROL_SUBSTEP_TYPES). The sub-loop was missed at first:
   * a validator-clean spec with a `branch` inside a `foreach` delivered
   * {"value":…,"viaCatchAll":true} to the customer once per item."
   *
   * Increment E added `decision` to flow-tester.js:38 CONTROL_TYPES and to
   * _node-input.js:44 NON_CONTENT_TYPES — and NOT to foreach.js:38
   * CONTROL_SUBSTEP_TYPES. So the sub-loop was missed AGAIN, for the same reason,
   * on the same line. The customer receives the DECISION VALUE ("P1") instead of
   * the drafted reply, once per row, with run_completed and no error.
   */
  test('A1: a `deliver` after a `decision` INSIDE a foreach sends the DRAFT, not the decision', async () => {
    const rows = [{ subject: 'Server on fire', budget: 90000 }, { subject: 'Coffee order', budget: 10 }];
    const sent = [];
    const DRAFT = 'Dear customer, we are on it and will update you within the hour.';

    const flow = spec(
      [
        { id: 'rows', type: 'connector-action', config: { action: 'airtable_search_records' } },
        { id: 'loop', type: 'foreach', config: {
          over: 'rows.output',
          steps: [
            { id: 'draft', type: 'llm', config: { prompt: 'Write a reply about {{item}}' } },
            { id: 'score', type: 'decision', config: {
              inputs:    [{ key: 'budget', type: 'number', from: 'item.budget' }],
              output:    { key: 'priority', type: 'enum', values: ['P1', 'P2'] },
              hitPolicy: 'FIRST',
              rules: [{ when: { budget: '>50000' }, then: 'P1' }, { when: { budget: '-' }, then: 'P2' }],
            } },
            { id: 'tell', type: 'deliver', config: { channel: 'slack', target: '#ops' } },
          ],
        } },
        { id: 'post', type: 'deliver', config: { channel: 'slack', target: '#ops' } },
      ],
      [{ from: 'rows', to: 'loop' }, { from: 'loop', to: 'post' }],
    );

    // FIXED ON BOTH SIDES (Builder, in response to this finding), so this one
    // PRECONDITION is inverted — and only this one. It asserted `ok: true` to
    // document that publish ACCEPTED the broken shape; publish now REJECTS it
    // (DECISION_IN_FOREACH), which is half the fix. Not one assertion below is
    // touched: the engine must ALSO refuse to deliver the decision value, because
    // it cannot depend on the validator having run — specs already in the database
    // predate every rule we write. This is the BRANCH_IN_FOREACH precedent exactly.
    const res = validator.validate(flow);
    assert.equal(res.ok, false, 'a decision in a loop must not publish — nothing inside a loop can route on its answer');
    assert.ok(res.errors.some(e => e.code === 'DECISION_IN_FOREACH'),
      `expected DECISION_IN_FOREACH; got: ${res.errors.map(e => e.code).join(', ')}`);

    const tester = new FlowTester({ nodeTypes, llm: stubLlm(DRAFT), channelRegistry: recordingChannels(sent, rows) });
    const events = await runAll(tester, flow, { tenantId: 't1', workflowId: 'w1' });
    assert.deepEqual(errorsOf(events), [], 'and it runs clean — no error is ever surfaced');

    // ASSERT WHAT IT SENT, not that it ran. Two deliveries inside the loop.
    const inLoop = sent.slice(0, 2);
    assert.equal(inLoop.length, 2, 'one delivery per row');
    for (const body of inLoop) {
      assert.notEqual(body, 'P1', 'the customer must never receive the decision VALUE');
      assert.notEqual(body, 'P2', 'the customer must never receive the decision VALUE');
      assert.equal(
        body, DRAFT,
        'a decision is a CONTROL node: its output is the answer + the audit row, never the work product. ' +
        'foreach.js:38 CONTROL_SUBSTEP_TYPES is {branch, human} — `decision` is missing, so it becomes the ' +
        "iteration's `last` and the deliver sub-step ships it.",
      );
    }
  });

  /**
   * A2 — THE MOAT'S NEW DOOR: a decision's own INPUT launders free text in.
   *
   * §11.7's property is "the value being DECIDED ON has a closed, declared domain".
   * Increment C learned this the hard way: the branch moat was a DENYLIST ("is the
   * parent an llm?") and one laundering hop through an `assemble` defeated it. It
   * was rebuilt as an allowlist over `closedDomainOf()`.
   *
   * `decision` inputs never got that treatment. LLM_INPUT_NOT_ENUM
   * (workflow-validator.js:611) fires only when `evaluator === 'llm'`. Declare the
   * input `type: 'enum'` with NO evaluator and point `from` at a FREEFORM llm, and:
   *
   *   • the validator says ok (0 errors, 0 warnings)
   *   • analyzeTable() certifies { decidable: true, uncovered: [], badConditions: [] }
   *   • at run time the input holds PROSE, which matches no enum literal, so the
   *     catch-all rule fires — EVERY RUN, FOREVER, with run_completed.
   *
   * The audit trail even records it: inputs: { tone: "This is EXTREMELY urgent…" },
   * rule: { when: { tone: "-" } }. A false proof, with a receipt.
   *
   * Root cause is one function: coerce() (decision.js:468) String()s an `enum`
   * input's value and never checks it against `input.values` — while classifyInput()
   * (decision.js:494), the LLM path, correctly THROWS on an off-enum answer. The
   * run-time half of the moat exists for one of the two ways a value gets in.
   */
  test('A2: an off-enum value must NOT be swallowed by the table\'s catch-all', async () => {
    const table = {
      inputs:    [{ key: 'tone', type: 'enum', values: ['calm', 'urgent'], from: 'think' }],
      output:    { key: 'priority', type: 'enum', values: ['P1', 'P3'] },
      hitPolicy: 'FIRST',
      rules: [
        { when: { tone: 'urgent' }, then: 'P1' },
        { when: { tone: '-' },      then: 'P3' },   // the catch-all DECISION_TABLE_GAP nags you into adding
      ],
    };
    const flow = spec(
      [
        { id: 'think', type: 'llm',      config: { prompt: 'How urgent does this sound?' } },  // freeform
        { id: 'score', type: 'decision', config: table },
        { id: 'route', type: 'branch',   config: { on: 'score.output',
          cases: [{ when: 'P1', to: 'page' }, { when: '*', to: 'file' }] } },
        { id: 'page',  type: 'deliver',  config: { channel: 'slack', target: '#ops' } },
        { id: 'file',  type: 'deliver',  config: { channel: 'in_app' } },
      ],
      [{ from: 'think', to: 'score' }, { from: 'score', to: 'route' },
       { from: 'route', to: 'page' },  { from: 'route', to: 'file' }],
    );

    const PROSE = 'This is EXTREMELY urgent — the server is on fire and the customer is threatening to leave.';
    assert.ok(PROSE.length > 40, 'the fixture must actually be prose, not a value that happens to match');

    const sent = [];
    const tester = new FlowTester({ nodeTypes, llm: stubLlm(PROSE), channelRegistry: recordingChannels(sent) });
    const events = await runAll(tester, flow, { tenantId: 't1', workflowId: 'w1' });

    const v = validator.validate(flow);
    const decided = outputOf(events, 'score');

    // ONE of these must hold. Today NEITHER does.
    const rejectedAtPublish = !v.ok;
    const failedLoudly      = errorsOf(events).length > 0;
    const swallowed         = decided?.rule?.when?.tone === '-';

    assert.ok(
      rejectedAtPublish || failedLoudly,
      'An enum input holding prose is an UNCOVERED case. It must be rejected at publish (its source has no ' +
      'closed domain — the branch moat\'s own rule) or THROW at run time (decision.js\'s own header: "an ' +
      `uncovered input combination THROWS"). Instead: validator.ok=${v.ok}, run_completed, and the table's ` +
      `catch-all decided ${JSON.stringify(decided?.value)} on an input that reads "${String(decided?.inputs?.tone).slice(0, 40)}…". ` +
      `swallowed-by-catch-all=${swallowed}`,
    );
  });

  /**
   * A3 — THE AI CLASSIFIER RETURNS A VALUE THE MODEL DID NOT CHOOSE.
   *
   * decision.js:520:
   *     const picked = values.find(v => v.toLowerCase() === raw.toLowerCase())
   *                 ?? values.find(v => raw.toLowerCase().includes(v.toLowerCase()));
   *
   * The fallback is a SUBSTRING SEARCH IN DECLARATION ORDER. It does not ask "which
   * value did the model choose"; it asks "which declared value appears first in this
   * blob". So:
   *
   *   values ['approve','reject'], answer "I would reject this — do not approve."
   *      → picked: "approve"      ← it decided the opposite of what the model said
   *   values ['ship','ship_hold'], answer "Decision: ship_hold"
   *      → picked: "ship"         ← a value that is a PREFIX of another is unreachable
   *                                 the moment the model adds any preamble
   *
   * The header (decision.js:490) promises: "it classifies into the input's own closed
   * `values` and THROWS on anything else — never returning free text into a table
   * whose coverage was proven over that closed set." It never returns free text. It
   * returns the WRONG member of the set, silently, and the table then decides on it.
   *
   * An off-enum answer is the one case that MUST escalate to a person — "the one case
   * where being wrong quietly would be indistinguishable from being right" (its own
   * words). A fuzzy match is exactly being wrong quietly.
   */
  test('A3: a negated answer must not classify as the value it negates', async () => {
    const table = {
      inputs:    [{ key: 'call', type: 'enum', values: ['approve', 'reject'], evaluator: 'llm' }],
      output:    { key: 'p', type: 'enum', values: ['SEND', 'HOLD'] },
      hitPolicy: 'FIRST',
      rules: [{ when: { call: 'approve' }, then: 'SEND' }, { when: { call: '-' }, then: 'HOLD' }],
    };
    const llm = stubLlm('I would reject this — do not approve.');

    let out, threw = null;
    try { out = await decisionNodeType.run(table, ctxWith({ body: 'a refund request' }), { llm }); }
    catch (e) { threw = e; }

    assert.ok(
      threw || out.inputs.call === 'reject',
      'The model said REJECT. The classifier must return "reject" — or throw, so the case reaches a person. ' +
      `It returned ${JSON.stringify(out?.inputs?.call)} and the table decided ${JSON.stringify(out?.value)}: ` +
      'the substring fallback (decision.js:521) scans the declared values IN ORDER and takes the first one ' +
      'that appears anywhere in the answer.',
    );
  });

  test('A3b: a value that is a PREFIX of another value must still be reachable', async () => {
    const table = {
      inputs:    [{ key: 'call', type: 'enum', values: ['ship', 'ship_hold'], evaluator: 'llm' }],
      output:    { key: 'p', type: 'enum', values: ['GO', 'STOP'] },
      hitPolicy: 'FIRST',
      rules: [{ when: { call: 'ship_hold' }, then: 'STOP' }, { when: { call: '-' }, then: 'GO' }],
    };
    const out = await decisionNodeType.run(
      table, ctxWith({ body: 'x' }), { llm: stubLlm('Decision: ship_hold') },
    );
    assert.equal(
      out.inputs.call, 'ship_hold',
      'the model chose ship_hold; the prefix "ship" must not win because it was declared first',
    );
  });

  /**
   * A4 — A NULL FIELD DECIDES VIA THE `-` RULE.
   *
   * readInput()'s own docblock (decision.js:421): "A value that cannot be found
   * THROWS. It does not default to null and it does not default to "". A missing
   * input silently becoming empty would match whatever rule happened to test `-` on
   * it, and the table would decide on a value nobody supplied — a wrong answer that
   * looks exactly like a right one."
   *
   * It throws on `undefined` only. And the canonical upstream is an `llm` in
   * `extract` mode, whose system prompt (llm.js:283) says verbatim: "If a field
   * cannot be found, its value is null." So the one producer the converger is taught
   * to put in front of a decision (prompts.js:208, `from: "<stepId>.budget"`) emits
   * exactly the value readInput does not catch — and for an `enum` input coerce()
   * hands `null` straight to the table, where it matches only `-`.
   */
  test('A4: an extracted field that came back null must not decide via the catch-all', async () => {
    const table = {
      inputs: [
        { key: 'tone',   type: 'enum', values: ['calm', 'urgent'], from: 'extract.tone' },
        { key: 'budget', type: 'number' },
      ],
      output:    { key: 'p', type: 'enum', values: ['P1', 'P3'] },
      hitPolicy: 'FIRST',
      rules: [
        { when: { tone: 'urgent', budget: '>10' }, then: 'P1' },
        { when: { tone: '-', budget: '-' },        then: 'P3' },
      ],
    };
    // What `llm` mode:'extract' returns when the field isn't in the email.
    const outputs = new Map([['extract', { tone: null, budget: 50000 }]]);

    let out, threw = null;
    try { out = await decisionNodeType.run(table, ctxWith({ budget: 50000 }, { outputs }), {}); }
    catch (e) { threw = e; }

    assert.ok(
      threw,
      'A field the extractor could not find is a value NOBODY SUPPLIED. The table must refuse to decide on ' +
      `it. Instead it decided ${JSON.stringify(out?.value)} from rule ${JSON.stringify(out?.rule?.when)} — ` +
      'the "-" the author wrote as a catch-all, silently absorbing a missing input.',
    );
  });

  /**
   * A5 — A SPEC THE VALIDATOR ACCEPTS AND THE ENGINE CANNOT RUN.
   *
   * `inputs[].from` is a REFERENCE (decision.js:339: "`from` is a REFERENCE (like a
   * branch's `on`), never a template"), and readInput() strips `{{ }}` off it — so
   * the braced spelling is plainly intended to work. DECISION_BAD_INPUT_REF accepts
   * it (decision.js:164 strips the braces before testing).
   *
   * But `decision` is not in flow-tester.js:651-659's carve-out list (only a
   * `foreach`'s `steps` and a `branch`'s `on` stay raw), so `_substitute` REPLACES
   * `{{think.output}}` with the VALUE before run() ever sees it — and a bare value is
   * indistinguishable from a step id. This is verbatim CLAUDE.md's branch-`on` crash:
   * "the engine looked up a step called 'urgent' and killed the run. Data-dependent,
   * which is worse."
   *
   * Loud (run_failed), so a residual rather than a blocker — but it is a spec publish
   * accepts and no run can ever complete, on the increment's headline node.
   */
  test('A5: a `from` the validator accepts must be one the engine can resolve', async () => {
    const flow = spec(
      [
        { id: 'think', type: 'llm', config: { mode: 'classify', categories: 'calm\nurgent', input: 'the server is on fire' } },
        { id: 'score', type: 'decision', config: {
          inputs:    [{ key: 'tone', type: 'enum', values: ['calm', 'urgent'], from: '{{think.output}}' }],
          output:    { key: 'p', type: 'enum', values: ['P1', 'P2'] },
          hitPolicy: 'FIRST',
          rules: [{ when: { tone: 'urgent' }, then: 'P1' }, { when: { tone: '-' }, then: 'P2' }],
        } },
        { id: 'post', type: 'deliver', config: { channel: 'slack', target: '#ops' } },
      ],
      [{ from: 'think', to: 'score' }, { from: 'score', to: 'post' }],
    );
    assert.equal(validator.validate(flow).ok, true, 'publish accepts it');

    const events = await runAll(
      new FlowTester({ nodeTypes, llm: stubLlm('urgent'), channelRegistry: recordingChannels([]) }), flow, {},
    );
    assert.deepEqual(
      errorsOf(events), [],
      'the engine must be able to run every spec the validator publishes. It cannot: _substitute() rewrites ' +
      '`from` into the classified VALUE, and the engine then hunts for a step by that name.',
    );
  });

  /**
   * A6 — THE ENGINE AND THE ANALYSER READ THE SAME CONDITION DIFFERENTLY.
   *
   * decision-analysis.js:243 states the contract: "the day the two disagree is the
   * day the coverage proof describes a program nobody is running."
   *
   *   coveredAtoms()    (:235)  String(w) === String(a)                  — CASE SENSITIVE
   *   matchesCondition() (:291) w.toLowerCase() === v.toLowerCase()      — CASE INSENSITIVE
   *
   * So `when: { tone: "URGENT" }` over values ["urgent","normal"] is a condition the
   * ENGINE evaluates happily and the ANALYSER declares unreadable — DECISION_BAD_CONDITION,
   * a hard publish error whose message ("isn't a condition this system can check") is
   * simply untrue. One grammar, two readings.
   */
  test('A6: a condition the engine can evaluate must be one the analyser can read', () => {
    const input = { key: 'tone', type: 'enum', values: ['urgent', 'normal'] };
    const cond  = 'URGENT';

    const engine = matchesCondition(cond, input, 'urgent');
    assert.equal(engine.ok, true);
    assert.equal(engine.matched, true, 'the engine matches it (it lowercases both sides)');

    const analysis = analyzeTable({ inputs: [input], rules: [{ when: { tone: cond }, then: 'X' }] });
    assert.deepEqual(
      analysis.badConditions, [],
      'the analyser calls the SAME condition unreadable. ONE FEEL-A grammar, consulted by both — or the ' +
      'completeness proof is about a different program than the one that runs.',
    );
  });
});
