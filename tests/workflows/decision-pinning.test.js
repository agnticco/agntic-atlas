/**
 * decision — PINNING. (P12 Increment E, written by the test-adversary.)
 *
 * Every test here PASSES, and every one KILLS a mutant that survived
 * `node scripts/checks/mutation-sweep.mjs --verbose` on this tree — i.e. a guard
 * that could be deleted, inverted or defaulted away with the whole suite still
 * smiling. The survivor list IS the coverage report; this is the part of it that
 * turned out to be behavioural.
 *
 * Each mutation was applied, CONFIRMED APPLIED (git diff), watched go red, and
 * restored with a file copy — never `git checkout`, which reverts to HEAD and
 * silently eats uncommitted work (ENGINEERING-LOG.md, operational hazard).
 *
 *   B1  decision.js:184           NULLISH     a keyless output publishes
 *   B2  decision.js:207           COND_FALSE  a bad rule CRASHES the validator
 *   B3  decision-analysis.js:111  COND_FALSE  the upper tail is never partitioned
 *   B4  decision-analysis.js:105  COND_TRUE   a phantom gap between integer cuts
 *   B5  decision-analysis.js:275  COND_FALSE  an unreadable boolean silently misses
 *   B6  gap-scorer.js:191         (blocking)  a blocking gap defaults to escalated
 *   B7  flow-tester.js:38         CONTROL_TYPES — asserted on the SENT BODY
 *
 * The sibling file ./decision-adversarial.test.js holds the LIVE DEFECTS, and is red.
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
// PART B — PINNING TESTS. These PASS. Each kills a mutation-sweep survivor.
// ═════════════════════════════════════════════════════════════════════════════

describe('B. pinning the survivors', () => {

  /**
   * KILLS: decision.js:184  NULLISH  `String(output.key ?? '')` → `String(output.key)`
   *
   * With the `?? ''` dropped, `String(undefined)` is the string "undefined" — truthy,
   * non-empty — so a table that declares its answers and never says WHAT it is
   * deciding sails through publish. The SOP then reads "Decides a value from …"
   * (sop-generator.js:193) and the decision-review card has nothing to name
   * (index.html:5024). The rule exists; nothing pinned it.
   */
  test('B1: a decision whose output has no key is rejected', () => {
    const issues = decisionNodeType.validate({
      id: 'score', type: 'decision',
      config: {
        inputs:    [{ key: 'budget', type: 'number' }],
        output:    { type: 'enum', values: ['P1', 'P2'] },   // no `key`
        hitPolicy: 'FIRST',
        rules:     [{ when: { budget: '-' }, then: 'P1' }],
      },
    });
    const missing = issues.filter(i => i.code === 'MISSING_CONFIG' && i.field === 'config.output');
    assert.equal(missing.length, 1, 'a decision that never says what it decides must not publish');
    assert.equal(missing[0].severity, 'error');
  });

  /**
   * KILLS: decision.js:207  COND_FALSE  (the malformed-rule guard in validate())
   *
   * Drop that guard and `Object.keys(rule.when)` runs on a `null` rule → TypeError.
   * workflow-validator.js:245 catches it and turns it into a user-facing
   * `VALIDATOR_ERROR: "score" failed type-specific validation: Cannot convert
   * undefined or null to object.` — an internal stack-trace fragment shown to a
   * person who wrote one bad table row.
   *
   * That is increment C's defect #5, one node type along: "Turning bad input into a
   * message is the validator's entire job; crashing on bad input is the one thing it
   * must never do." A `null` in a rules array is exactly what an LLM emits. Nothing
   * pinned it — the survivor is invisible unless you assert on the ISSUES, not just
   * on `ok === false` (which the crash-catch preserves).
   */
  test('B2: a malformed rule becomes a MESSAGE — validate() never crashes into one', () => {
    const def = {
      version: 2, name: 'W',
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', config: {
          inputs:    [{ key: 'budget', type: 'number' }],
          output:    { key: 'p', type: 'enum', values: ['P1', 'P2'] },
          hitPolicy: 'FIRST',
          rules:     [null, { when: { budget: '-' }, then: 'P1' }],   // an LLM emitted one bad row
        } },
        { id: 'post', type: 'deliver', config: { channel: 'slack', target: '#ops' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };

    let res;
    assert.doesNotThrow(() => { res = validator.validate(def); }, 'publish must not 500 on a bad rule');
    assert.equal(res.ok, false);
    assert.ok(
      res.errors.some(e => e.code === 'DECISION_BAD_CONDITION'),
      'it must SAY which rule it could not read',
    );
    assert.deepEqual(
      res.issues.filter(i => i.code === 'VALIDATOR_ERROR'), [],
      'and it must READ the rule, not CRASH on it: a VALIDATOR_ERROR here is a TypeError from inside the ' +
      'validator, caught at workflow-validator.js:248 and shown to the user as "failed type-specific ' +
      'validation: Cannot convert undefined or null to object."',
    );
    // …and no coverage claim is made about a table nobody can read.
    assert.ok(
      !res.issues.some(i => i.code === 'DECISION_TABLE_GAP'),
      'a table we cannot read gets NO coverage claim, not even a negative one',
    );
  });

  /**
   * KILLS: decision-analysis.js:111  COND_FALSE
   *          `if (!isInt || openCellHasInteger(prev, Infinity))` → never push the tail
   *
   * The atom above the highest cut is the region "anything bigger than the biggest
   * number anyone wrote a rule for". Drop it and a numeric table with no rule up
   * there reports `uncovered: []` — A FULL COMPLETENESS PROOF FOR A TABLE WITH A HOLE
   * IN IT, which is the one thing this module exists never to do.
   *
   * Every existing numeric fixture has its gap BELOW the lowest cut (`> 50000 → P1`,
   * nothing for the rest), which is produced by the loop at :105-108. The upper tail
   * was executed by no test at all.
   */
  test('B3: a numeric table with no rule above its highest cut reports the gap', () => {
    const a = analyzeTable({
      inputs: [{ key: 'days', type: 'number' }],
      rules:  [{ when: { days: '<=10' }, then: 'OK' }],       // nothing for days > 10
    });
    assert.equal(a.decidable, true);
    assert.equal(a.hasCatchAll, false);
    assert.equal(a.uncovered.length, 1, 'the region above the last cut is a real, uncovered region');
    assert.deepEqual(a.uncovered[0], { days: '> 10' });
  });

  /**
   * KILLS: decision-analysis.js:105  COND_TRUE
   *          `if (!isInt || openCellHasInteger(prev, c))` → always push the open cell
   *
   * The INTERIOR half of the integer phantom-gap fix. An open cell between two
   * CONSECUTIVE integer cuts contains no integer, so it is not a region of the
   * domain — reporting it is a fabricated gap, "and it is the more corrosive one: a
   * question with no real answer is what teaches people to click past the questions."
   *
   * The existing suite pins the TAIL cell (:111's guard); the interior cell — which
   * needs two consecutive cuts AND an uncovered neighbour to surface — was pinned by
   * nothing. Here, `<= 0` and `> 1` leave exactly one real gap: the integer 1. Not
   * two, and not a phantom "between 0 and 1".
   */
  test('B4: an integer domain invents no gap between consecutive cuts', () => {
    const a = analyzeTable({
      inputs: [{ key: 'n', type: 'integer' }],
      rules:  [{ when: { n: '<=0' }, then: 'A' }, { when: { n: '>1' }, then: 'B' }],
    });
    assert.equal(a.decidable, true);
    assert.deepEqual(
      a.uncovered, [{ n: '= 1' }],
      'the only integer no rule covers is 1. "between 0 and 1 (exclusive)" contains no integer and is not a case.',
    );

    // And the exhaustive partition of the integers reports NO gap at all.
    const exhaustive = analyzeTable({
      inputs: [{ key: 'n', type: 'integer' }],
      rules:  [{ when: { n: '<=0' }, then: 'A' }, { when: { n: '>=1' }, then: 'B' }],
    });
    assert.deepEqual(exhaustive.uncovered, [], '<=0 and >=1 is exhaustive over the integers');
  });

  /**
   * KILLS: decision-analysis.js:275  COND_FALSE  (the boolean arm of matchesCondition)
   *
   * Delete the boolean arm and `when: { flag: "yes" }` on a boolean input stops being
   * UNREADABLE and starts being merely NOT-MATCHED — it falls through to the enum
   * arm, which compares the literal "yes" against the value and shrugs.
   *
   * That distinction is the whole reason matchesCondition returns `{ok, matched}`
   * rather than a boolean (decision.js:288): "A condition the FEEL-A grammar cannot
   * read is NOT a condition that failed to match. Treating it as 'no match' would let
   * an unparseable rule silently narrow the table at run time while the analyser —
   * which reports it as a bad condition — believed the table was covered."
   *
   * Asserted at BOTH ends: the grammar itself, and the engine refusing to decide.
   */
  test('B5: an unreadable boolean condition is UNREADABLE, not "no match"', async () => {
    const input = { key: 'vip', type: 'boolean' };
    assert.deepEqual(matchesCondition('yes',   input, true),  { ok: false, matched: false },
      '"yes" is not FEEL-A for a boolean — the grammar must say it cannot read it');
    assert.deepEqual(matchesCondition('true',  input, true),  { ok: true,  matched: true },
      'and the GOOD shape is still accepted — otherwise this test would pass with the arm returning ok:false always');
    assert.deepEqual(matchesCondition('false', input, true),  { ok: true,  matched: false });

    // The engine's half: it refuses to decide from a table it cannot read.
    await assert.rejects(
      () => decisionNodeType.run({
        inputs:    [{ key: 'vip', type: 'boolean' }],
        output:    { key: 'p', type: 'enum', values: ['P1', 'P2'] },
        hitPolicy: 'FIRST',
        rules:     [{ when: { vip: 'yes' }, then: 'P1' }, { when: { vip: '-' }, then: 'P2' }],
      }, ctxWith({ vip: true }), {}),
      /not a condition this engine can evaluate/,
      'and it must NOT quietly fall through to the catch-all rule',
    );

    // The analyser agrees — same grammar, same verdict.
    const a = analyzeTable({
      inputs: [{ key: 'vip', type: 'boolean' }],
      rules:  [{ when: { vip: 'yes' }, then: 'P1' }],
    });
    assert.equal(a.decidable, false);
    assert.equal(a.badConditions.length, 1);
  });

  /**
   * `complete ⇒ publishable` across the severities Increment E introduced. The DMN
   * analysis MOVED from the gap scorer into the validator; the scorer now classifies
   * the validator's issues. If the severity/resolution mapping ever slips, the
   * converger ratifies a spec that publish rejects — the dead end a user cannot argue
   * their way out of.
   *
   * Constructed the way PRODUCTION constructs it: validator WITH a channel registry,
   * scorer WITH the capability catalog.
   */
  test('B6: an ERROR-severity table issue blocks the converger, a WARNING does not', () => {
    const route = (id) => [
      { id: 'route', type: 'branch', config: { on: `${id}.output`,
        cases: [{ when: 'P1', to: 'post' }, { when: '*', to: 'file' }] } },
      { id: 'post', type: 'deliver', config: { channel: 'slack', target: '#ops' } },
      { id: 'file', type: 'deliver', config: { channel: 'in_app' } },
    ];
    const edges = [{ from: 'score', to: 'route' }, { from: 'route', to: 'post' }, { from: 'route', to: 'file' }];

    // A hole in the table: a WARNING. Publishable, and escalatable — so `complete`.
    const gapped = spec([
      { id: 'score', type: 'decision', config: {
        inputs: [{ key: 'budget', type: 'number' }],
        output: { key: 'p', type: 'enum', values: ['P1', 'P2'] },
        hitPolicy: 'FIRST',
        rules: [{ when: { budget: '>50000' }, then: 'P1' }],
      } },
      ...route('score'),
    ], edges);
    const vg = validator.validate(gapped);
    const sg = scoreGap(gapped, { capabilities });
    assert.equal(vg.ok, true, 'an uncovered case is escalatable, not fatal');
    assert.ok(vg.warnings.some(w => w.code === 'DECISION_TABLE_GAP'));
    assert.equal(sg.complete, true, 'complete ⇒ publishable: it publishes, so it may be complete');
    assert.ok(sg.gaps.some(g => g.code === 'DECISION_TABLE_GAP' && !g.blocking && g.resolution === 'escalated'));

    // A UNIQUE table whose rules overlap: an ERROR. Must NOT score complete.
    const overlapping = spec([
      { id: 'score', type: 'decision', config: {
        inputs: [{ key: 'budget', type: 'number' }],
        output: { key: 'p', type: 'enum', values: ['P1', 'P2'] },
        hitPolicy: 'UNIQUE',
        rules: [
          { when: { budget: '>10' }, then: 'P1' },
          { when: { budget: '>50' }, then: 'P2' },   // both match 60
          { when: { budget: '-' },   then: 'P2' },
        ],
      } },
      ...route('score'),
    ], edges);
    const vo = validator.validate(overlapping);
    const so = scoreGap(overlapping, { capabilities });
    assert.equal(vo.ok, false, 'UNIQUE promises exactly one rule ever matches; these two both match 60');
    assert.ok(vo.errors.some(e => e.code === 'UNIQUE_HIT_OVERLAP'));
    assert.equal(so.complete, false, 'a spec publish rejects must never score complete');
    assert.ok(
      so.gaps.some(g => g.code === 'UNIQUE_HIT_OVERLAP' && g.blocking && g.resolution === 'unanswered'),
      'a BLOCKING gap can never default to "escalated" — that makes `complete` vacuous',
    );
  });

  /**
   * The top-level half of A1, so the pair reads together: OUTSIDE a foreach the guard
   * is real (flow-tester.js:472, CONTROL_TYPES). Assert the DELIVERED BODY — not that
   * the delivery ran. A `(pinned)` label on a test that never looked at what was sent
   * is how the `lastOutput` guard shipped unpinned in increment B.
   */
  test('B7: at top level, a `deliver` after a `decision` sends the DRAFT', async () => {
    const DRAFT = 'Dear customer, your refund is approved and will land in 3 days.';
    const sent  = [];
    const flow  = spec(
      [
        { id: 'facts', type: 'connector-action', config: { action: 'airtable_get_record' } },
        { id: 'draft', type: 'llm', config: { prompt: 'Write the reply' } },
        { id: 'score', type: 'decision', config: {
          inputs:    [{ key: 'budget', type: 'number', from: 'facts.budget' }],
          output:    { key: 'p', type: 'enum', values: ['P1', 'P2'] },
          hitPolicy: 'FIRST',
          rules:     [{ when: { budget: '-' }, then: 'P1' }],
        } },
        { id: 'post', type: 'deliver', config: { channel: 'slack', target: '#ops' } },
      ],
      [{ from: 'facts', to: 'draft' }, { from: 'draft', to: 'score' }, { from: 'score', to: 'post' }],
    );
    const tester = new FlowTester({
      nodeTypes, llm: stubLlm(DRAFT),
      channelRegistry: recordingChannels(sent, null, { budget: 42 }),
    });
    const events = await runAll(tester, flow, { tenantId: 't', workflowId: 'w' });

    assert.deepEqual(errorsOf(events), []);
    assert.equal(outputOf(events, 'score').value, 'P1', 'the decision ran');
    assert.equal(sent.length, 1);
    assert.equal(sent[0], DRAFT, 'the SENT BODY is the draft, never the decision or its audit row');
    assert.ok(!String(sent[0]).includes('P1'), 'and it carries no trace of the decision blob');
  });
});
