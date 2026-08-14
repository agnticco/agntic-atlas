/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FINDINGS — these tests FAIL. That is the point. (Test Adversary, P12-C.)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each test below asserts a property Increment C's own documentation claims, and
 * each one currently FAILS against `src/`. I may not touch `src/`, so they are
 * left red, precisely described, for the Builder to decide on.
 *
 * THIS FILE IS DELIBERATELY *NOT* IN `SUITES` in scripts/checks/mutation-sweep.mjs
 * and *NOT* IN scripts/gates/p12.sh — a red suite there would make the sweep exit
 * before it could measure anything, and the measurement is the deliverable. Add it
 * to both once the findings are closed.
 *
 *   FINDING 1 — THE MOAT IS BYPASSED BY ONE LAUNDERING HOP.  (severity: high)
 *   FINDING 2 — A MALFORMED RULE SILENTLY COVERS THE WHOLE TABLE.  (high)
 *   FINDING 3 — DUPLICATE ASSERTION IDS SILENTLY DROP AN ASSERTION.  (medium)
 *   FINDING 4 — `integer` INPUTS GET A PHANTOM GAP.  (medium)
 *   FINDING 5 — A `null` NODE MAKES validate() THROW.  (medium, pre-existing)
 *
 * Run:  node --test tests/converger/moat-adversarial.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scoreGap }                 from '../../src/converger/gap-scorer.js';
import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { analyzeTable }             from '../../src/workflows/decision-analysis.js';
import { checkOutcome }             from '../../src/workflows/outcome-oracle.js';

const validator = () => new WorkflowValidator({ nodeTypes: registerBuiltInNodeTypes(new NodeTypeRegistry()) });
const errorCodes = (def) => validator().validate(def).errors.map(e => e.code);

// ═══════════════════════════════════════════════════════════════════════════
describe('FINDING 1 — the moat is bypassed by ONE laundering hop', () => {
  /**
   * src/workflows/workflow-validator.js:478-491 (`_checkDecisionInputs`).
   *
   *     const src = onId ? byId.get(onId) : null;
   *     if (!src || src.type !== 'llm') continue;     // <-- only the DIRECT source
   *
   * LLM_INPUT_NOT_ENUM inspects ONLY the node a branch's `on` points at. Put any
   * non-`llm` node between the free-text LLM step and the branch — an `assemble`
   * whose `content` is `{{think.output}}` is the obvious one, and it is a node the
   * converger is explicitly taught to emit — and the check does not fire.
   *
   * The branch then routes on free LLM prose. `when: "yes"` matches nothing (the
   * value is a markdown document), so the MANDATORY catch-all takes 100% of
   * traffic, forever, silently, with `run_completed`. That is verbatim the failure
   * BRANCH_BAD_ON was written to prevent — ENGINEERING-LOG.md: "the catch-all that exists
   * to prevent a silent misroute was MASKING one."
   *
   * The property §11.7 claims is not "the branch's parent is not an llm node". It
   * is "an LLM-evaluated decision input has a closed domain". Laundering does not
   * bound the domain; it only hides who produced it.
   *
   * Same hole, other spellings (all validate clean today):
   *   • branch on a `search_web` step (LLM-backed, free text);
   *   • branch on a `connector-action` whose output is free text (a Gmail body);
   *   • branch on an `llm` step via a second `assemble`, or an `llm` in `rewrite`
   *     mode feeding an `assemble` feeding the branch.
   *
   * The narrow fix is not "walk the graph" — it is to constrain what a `branch`
   * may route ON: a `classify` llm, a `decision` output, or a value with a
   * declared closed domain. Anything else is an unbounded input, whatever produced
   * it. That is a one-rule change and it closes the class rather than the instance.
   */
  const launder = () => ({
    version: 2, name: 'Triage',
    outcome: { statement: 'Urgent mail reaches #urgent.',
               assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#urgent' }] },
    triggers: [{ type: 'email' }],
    nodes: [
      // Free text. Unbounded domain. The thing §11.7 exists to keep out of a decision.
      { id: 'think', type: 'llm', label: 'Assess',
        config: { mode: 'freeform', prompt: 'Is this urgent? Answer yes or no.' } },
      // One hop of laundering. Nothing here bounds anything — it just re-wraps.
      { id: 'doc', type: 'assemble', label: 'Doc',
        config: { title: 'Assessment', sections: '[{"heading":"Verdict","content":"{{think.output}}"}]' } },
      // …and now the branch routes on free prose, and the validator is fine with it.
      { id: 'route', type: 'branch', label: 'Route',
        config: { on: 'doc.output', cases: [{ when: 'yes', to: 'urgent' }, { when: '*', to: 'normal' }] } },
      { id: 'urgent', type: 'deliver', label: 'U', config: { channel: 'slack', target: '#urgent' } },
      { id: 'normal', type: 'deliver', label: 'N', config: { channel: 'in_app', title: 'FYI' } },
    ],
    edges: [{ from: 'think', to: 'doc' }, { from: 'doc', to: 'route' },
            { from: 'route', to: 'urgent' }, { from: 'route', to: 'normal' }],
  });

  test('an LLM free-text value routed through `assemble` into a branch must NOT publish', () => {
    // CONTROL: the direct shape IS caught — so the rule exists and works, and this
    // is a scope hole, not a missing rule.
    const direct = launder();
    direct.nodes = direct.nodes.filter(n => n.id !== 'doc');
    direct.nodes.find(n => n.id === 'route').config.on = 'think.output';
    direct.edges = [{ from: 'think', to: 'route' },
                    { from: 'route', to: 'urgent' }, { from: 'route', to: 'normal' }];
    assert.ok(errorCodes(direct).includes('LLM_INPUT_NOT_ENUM'),
      'control: the direct llm→branch shape is rejected');

    // FINDING: one hop through `assemble` and the moat is gone.
    const codes = errorCodes(launder());
    assert.ok(codes.includes('LLM_INPUT_NOT_ENUM'),
      `THE MOAT: a branch routing on laundered free LLM text reached a PUBLISHABLE spec. ` +
      `validator errors were: [${codes.join(', ')}] (i.e. none). ` +
      `The catch-all would then swallow 100% of traffic, silently, with run_completed.`);
  });

  test('…and scoreGap calls that spec COMPLETE', () => {
    const result = scoreGap(launder());
    assert.equal(result.complete, false,
      'the converger would tell the user this workflow is finished, and it decides nothing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FINDING 2 — a malformed rule silently covers the WHOLE table', () => {
  /**
   * src/workflows/decision-analysis.js:283-304 (the box-subtraction loop) and
   * :243-248 (`hasCatchAll`).
   *
   *     const cov = domains.map((d, i) => {
   *       const { atoms } = coveredAtoms(rule?.when?.[d.input.key], d.input, [...region[i]]);
   *
   * `rule?.when?.[key]` on a rule that is `null`, a string, a number — anything
   * that is not an object with a `when` — yields `undefined`, which `coveredAtoms`
   * treats as IRRELEVANT, which covers EVERY atom on EVERY dimension. So one junk
   * entry in `rules[]` subtracts the entire input space and the analyser reports
   * `uncovered: []` — a proof of completeness derived from a rule it never read.
   *
   * `hasCatchAll` (correctly) refuses to count it (`r && typeof r === 'object'`),
   * so the module simultaneously reports "there is no catch-all" and "nothing is
   * uncovered", which cannot both be true of a table with a hole.
   *
   * This is precisely the failure decision-analysis.js's own header forbids:
   * "Never imply a completeness proof you cannot make — a false proof is worse
   * than no proof, because the user stops looking." An LLM emitting one malformed
   * rule is not a hypothetical; it is Tuesday.
   *
   * Fix shape: a rule that is not an object with an object `when` is a
   * `badCondition` / undecidable, exactly like an unreadable condition already is.
   */
  const inputs = [{ key: 'tier', type: 'enum', values: ['free', 'pro'] }];

  test('a null rule must not be read as a catch-all', () => {
    const a = analyzeTable({ inputs, rules: [null], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, false,
      `a table containing an unreadable rule claimed FULL COVERAGE: ` +
      `uncovered=${JSON.stringify(a.uncovered)}, hasCatchAll=${a.hasCatchAll}, ` +
      `badConditions=${JSON.stringify(a.badConditions)}. Nothing decides "free" or "pro", ` +
      `and the analyser proved the table complete anyway.`);
  });

  test('a non-object rule must not be read as a catch-all', () => {
    const a = analyzeTable({ inputs, rules: ['if tier is pro then page'], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, false,
      `a string in rules[] covered the entire input space; uncovered=${JSON.stringify(a.uncovered)}`);
  });

  test('a rule whose `when` is not an object must not be read as a catch-all', () => {
    const a = analyzeTable({ inputs, rules: [{ when: 'tier = pro', then: 'page' }], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, false,
      `a rule with a STRING \`when\` covered everything; uncovered=${JSON.stringify(a.uncovered)}`);
  });

  test('CONTROL: a genuine catch-all is still a catch-all (this must keep passing)', () => {
    const a = analyzeTable({ inputs, rules: [{ when: { tier: '-' }, then: 'x' }], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, true);
    assert.equal(a.hasCatchAll, true);
    assert.deepEqual(a.uncovered, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FINDING 3 — duplicate assertion ids silently drop an assertion', () => {
  /**
   * src/workflows/outcome-oracle.js:283  `satisfied.set(a.id ?? a.target, hits)`
   * src/workflows/workflow-validator.js:411  `assertions.find(x => (x.id ?? x.target) === id)`
   *
   * `satisfied` is a Map keyed by `id ?? target`. Two assertions sharing that key
   * collapse into ONE entry, so the module's headline property —
   *
   *   "An assertion must ALWAYS land in exactly one of satisfied / unsatisfied /
   *    malformed — never silently dropped (that is defect #1)"
   *
   * — is false. The validator then looks the assertion back up by the same key and
   * gets the FIRST one, so the SECOND assertion's `fields` requirement is checked
   * against the first assertion's (absent) field list and vanishes.
   *
   * Nothing anywhere validates that assertion ids are unique, and the converger
   * generates them with an LLM.
   *
   * Fix shape: DUPLICATE_ASSERTION_ID as a validator error (cheap, and it makes
   * the Map key honest), or key `satisfied` by array index.
   */
  test('two assertions sharing an id are BOTH accounted for', () => {
    const outcome = { assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#ops' },
      { id: 'a1', kind: 'message_sent', target: 'slack:#ops' },
    ] };
    const nodes = [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }];
    const { satisfied, unsatisfied, malformed } = checkOutcome(outcome, nodes);
    assert.equal(satisfied.size + unsatisfied.length + malformed.length, 2,
      'checkOutcome dropped one of two assertions on the floor — the exact property the module claims it cannot');
  });

  test('the SECOND assertion\'s promised fields are still enforced', () => {
    // The user asked for a Leads record carrying a Budget. The converger emitted
    // two assertions with the same id (an LLM will), the first without `fields`.
    // The Budget requirement is never checked, and the workflow publishes without
    // ever writing a Budget — which is defect #1 wearing a hat.
    const spec = {
      version: 2, name: 'Lead capture',
      outcome: { assertions: [
        { id: 'a1', kind: 'record_exists', target: 'airtable:Leads' },
        { id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Budget'] },
      ] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'save', type: 'connector-action', label: 'Save',
          config: { action: 'airtable_create_record', tableId: 'Leads', fields: { Name: '{{trigger.output}}' } } },
        { id: 'out', type: 'deliver', label: 'Inbox', config: { channel: 'in_app', title: 'Lead' } },
      ],
      edges: [{ from: 'save', to: 'out' }],
    };
    const codes = errorCodes(spec);
    assert.ok(codes.includes('UNSATISFIED_ASSERTION') || codes.includes('DUPLICATE_ASSERTION_ID'),
      `the promised Budget field was never checked and the spec published clean. errors: [${codes.join(', ')}]`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FINDING 4 — `integer` inputs get a phantom gap', () => {
  /**
   * src/workflows/decision-analysis.js:76  `if (type === 'number' || type === 'integer')`
   *
   * `integer` is partitioned over the REALS: the cuts {0, 1} produce the open cell
   * (0, 1), which contains no integer at all. So `<=0` plus `>=1` — an exhaustive
   * pair over the integers — is reported as having an uncovered region
   * "between 0 and 1 (exclusive)".
   *
   * This is the second failure mode in the module's own header: "INVENT A GAP THAT
   * ISN'T THERE". The converger surfaces it as a DECISION_TABLE_GAP and asks the
   * user what to do about an integer that is strictly between 0 and 1. That is the
   * question that teaches people to click past the questions — and then they click
   * past the real one.
   *
   * Fix shape: for `integer`, an open cell (lo, hi) is EMPTY when
   * `floor(hi) <= lo + 1` (no integer strictly inside); drop empty cells from the
   * atom set. `describeAtoms` should also render integer cells as "1 to 4", not
   * "between 0 and 5 (exclusive)".
   */
  test('<=0 and >=1 exhaust the integers — no gap may be reported', () => {
    const a = analyzeTable({
      inputs: [{ key: 'retries', type: 'integer' }],
      rules: [{ when: { retries: '<=0' }, then: 'first try' },
              { when: { retries: '>=1' }, then: 'a retry' }],
      hitPolicy: 'FIRST',
    });
    assert.deepEqual(a.uncovered, [],
      `a phantom gap was invented for an exhaustive integer table: ${JSON.stringify(a.uncovered)}`);
  });

  test('CONTROL: over the REALS that same table really does have a hole (must keep passing)', () => {
    const a = analyzeTable({
      inputs: [{ key: 'score', type: 'number' }],
      rules: [{ when: { score: '<=0' }, then: 'a' }, { when: { score: '>=1' }, then: 'b' }],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.uncovered.length, 1, '0.5 is a real number and nothing decides it');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('FINDING 5 — a null node makes validate() THROW instead of reporting MALFORMED_NODE', () => {
  /**
   * src/workflows/workflow-validator.js:238
   *
   *     const triggerCount = nodes.filter(n => n.type === 'trigger').length;
   *                                        ^^^^^^ no optional chaining
   *
   * The MALFORMED_NODE branch (:87) `continue`s the node loop but never removes the
   * node, so a `null` in `nodes[]` reaches :238 and throws
   * `TypeError: Cannot read properties of null (reading 'type')`.
   *
   * MALFORMED_NODE is therefore dead for the null case: the issue is pushed and
   * then thrown away with the whole result. `WorkflowService.create()` calls
   * `validate()` with no try/catch (workflow-service.js:90), so publish 500s
   * instead of returning a clean validation error. The gap scorer survives only
   * because it wraps `validate()` in a try/catch and reports VALIDATOR_ERROR.
   *
   * PRE-EXISTING — present on `main` (same line, `git show main:…`), not an
   * Increment C regression. Reported because the sweep's MALFORMED_NODE survivor
   * is explained by it, and because a nodeless-entry spec is exactly what a
   * half-streamed LLM response produces.
   *
   * Fix shape: `nodes.filter(n => n?.type === 'trigger')` — and the same for the
   * `deliverCount` line below it.
   */
  test('a null entry in nodes[] is reported, not thrown', () => {
    const spec = {
      name: 'Half-built', triggers: [{ type: 'email' }],
      nodes: [{ id: 'out', type: 'deliver', config: { channel: 'in_app' } }, null],
      edges: [],
    };
    let result;
    assert.doesNotThrow(() => { result = validator().validate(spec); },
      'validate() must never throw on a malformed spec — publish has no try/catch around it');
    assert.ok(result.errors.some(e => e.code === 'MALFORMED_NODE'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The independent VERIFIER's findings (P12 Increment C, round 2). Every one of
// these reached candidate state behind a fully green suite — including a green
// `converger-adversarial` check that was structurally incapable of seeing D1.
// ─────────────────────────────────────────────────────────────────────────────

import { WorkflowValidator as WV2 }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry as NTR2 }        from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes as RBN2 } from '../../src/workflows/node-types/index.js';
import { scoreGap as scoreGap2 }           from '../../src/converger/gap-scorer.js';

const CHANS = [
  { id: 'slack',         available: true, configSchema: [{ key: 'target' }] },
  { id: 'inbox_deliver', available: true, configSchema: [{ key: 'subject' }] },
];
/** The validator PRODUCTION uses — with a channel registry (server.js:542). */
const prodV = () => new WV2({
  nodeTypes: RBN2(new NTR2()),
  channelRegistry: { get: (id) => CHANS.find(c => c.id === id) ?? null },
});

describe('VERIFIER D1 — complete ⇒ publishable, with the channel catalog', () => {
  const discordSpec = {
    version: 2, name: 'Hallucinated channel',
    outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
    triggers: [{ type: 'email' }],
    nodes: [
      { id: 'ok', type: 'deliver', label: 'Slack',   config: { channel: 'slack', target: '#ops' } },
      { id: 'no', type: 'deliver', label: 'Discord', config: { channel: 'discord', target: '#ops' } },
    ],
    edges: [],
  };

  test('a spec with a channel that does not exist is NOT scored complete', () => {
    // It used to be: the scorer had no catalog, so the validator's
    // `if (channelId && this.channelRegistry)` guard silently skipped
    // UNKNOWN_CHANNEL — while publish (which HAS a registry) still enforced it.
    // The converger said "done"; the save button said no.
    assert.equal(scoreGap2(discordSpec, { capabilities: { channels: CHANS } }).complete, false);
    assert.equal(prodV().validate(discordSpec).ok, false);
  });

  test('with NO catalog the scorer REFUSES to certify rather than skipping the check', () => {
    // Refusing to certify is always available. Certifying without checking is not.
    const r = scoreGap2(discordSpec, { capabilities: {} });
    assert.equal(r.complete, false, 'a scorer that cannot see the catalog must not call a spec finished');
    assert.ok(r.gaps.some(g => g.code === 'CHANNELS_UNVERIFIED' && g.blocking));
  });

  test('CONTROL: a real channel, with a catalog, still scores complete', () => {
    const good = { ...discordSpec, nodes: [discordSpec.nodes[0]] };
    assert.equal(scoreGap2(good, { capabilities: { channels: CHANS } }).complete, true);
    assert.equal(prodV().validate(good).ok, true);
  });
});

describe('VERIFIER D2 — a branch case the classifier can never produce', () => {
  const triage = (cases) => ({
    version: 2, name: 'Triage',
    outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
    triggers: [{ type: 'email' }],
    nodes: [
      { id: 'c',  type: 'llm', label: 'Classify', config: { mode: 'classify', categories: 'urgent\nnormal' } },
      { id: 'r',  type: 'branch', label: 'Route', config: { on: 'c.output', cases } },
      { id: 'up', type: 'deliver', label: 'Urgent', config: { channel: 'slack', target: '#ops' } },
      { id: 'dn', type: 'deliver', label: 'Normal', config: { channel: 'inbox_deliver', subject: 'FYI' } },
    ],
    edges: [{ from: 'c', to: 'r' }, { from: 'r', to: 'up' }, { from: 'r', to: 'dn' }],
  });

  test('a case naming a value outside the closed enum is REJECTED', () => {
    // "HIGH" is not one of urgent|normal, so it can never match: the mandatory
    // catch-all would swallow 100% of traffic, forever, with run_completed — the
    // exact silent misroute the moat exists to prevent. We forced the domain
    // closed precisely so membership became DECIDABLE; not deciding it was a
    // completeness claim nobody checked.
    const codes = prodV().validate(triage([{ when: 'HIGH', to: 'up' }, { when: '*', to: 'dn' }]))
      .errors.map(e => e.code);
    assert.ok(codes.includes('BRANCH_CASE_NOT_IN_ENUM'), `got: ${codes.join(', ') || '(none)'}`);
  });

  test('CONTROL: cases drawn from the enum are accepted', () => {
    const r = prodV().validate(triage([{ when: 'urgent', to: 'up' }, { when: '*', to: 'dn' }]));
    assert.equal(r.ok, true, `a valid branch must publish; got: ${r.errors.map(e => e.code).join(', ')}`);
  });

  test('CONTROL: matching is case-insensitive — "Urgent" is not a typo', () => {
    const r = prodV().validate(triage([{ when: 'Urgent', to: 'up' }, { when: '*', to: 'dn' }]));
    assert.equal(r.ok, true);
  });
});
