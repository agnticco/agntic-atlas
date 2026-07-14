/**
 * The gap oracle — P12 Increment C.
 *
 * scoreGap() over crafted specs. This is the file the gate names, and the five
 * cases it names are the five defects Increment C exists to kill:
 *
 *   unsatisfied assertion · table gap · UNIQUE overlap · non-exhaustive branch ·
 *   unknown config key
 *
 * A NOTE ON HOW THESE TESTS ARE WRITTEN, because the last increment learned it
 * the hard way (CLAUDE.md, "a green suite proved nothing four times running"):
 *
 *   • Every rule gets a POSITIVE case as well as a negative one. A check that
 *     only ever sees bad input would pass if it rejected EVERYTHING — which is
 *     not hypothetical: Increment B's `route_to` check was rejecting every
 *     correct spec, behind a green negative-only test.
 *   • The assertions name the CONSEQUENCE, not the shape. `complete === false`
 *     is not the point; "this spec cannot publish" is.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scoreGap, nextGap, unansweredGaps } from '../../src/converger/gap-scorer.js';
import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { analyzeTable }             from '../../src/workflows/decision-analysis.js';
import { satisfiesAssertion, nodeEffect, checkOutcome } from '../../src/workflows/outcome-oracle.js';

const validator = () => new WorkflowValidator({ nodeTypes: registerBuiltInNodeTypes(new NodeTypeRegistry()) });

const codes = (result) => result.gaps.map(g => g.code);
const has   = (result, code) => codes(result).includes(code);
const errorCodes = (def) => validator().validate(def).errors.map(e => e.code);

/**
 * The delivery catalog, shaped exactly like the converger's `capabilities.channels`
 * (id + configSchema + available) — which is the same view the server's
 * ChannelRegistry exposes. A channel declares its OWN config keys; without the
 * catalog a scorer would judge an Airtable delivery against Slack's key set.
 */
const CAPS = {
  channels: [
    { id: 'slack',                  available: true, configSchema: [{ key: 'target' }] },
    { id: 'slack_dm',               available: true, configSchema: [{ key: 'user' }] },
    { id: 'gmail_send',             available: true, configSchema: [{ key: 'to' }, { key: 'subject' }] },
    { id: 'inbox_deliver',          available: true, configSchema: [{ key: 'subject' }] },
    { id: 'sheets_append',          available: true, configSchema: [{ key: 'spreadsheetId' }, { key: 'range' }] },
    { id: 'airtable_create_record', available: true, configSchema: [{ key: 'baseId' }, { key: 'tableId' }, { key: 'fields' }] },
  ],
};

/** A complete, publishable v2 spec: email in → summarize → Slack. The control. */
function goodSpec(overrides = {}) {
  return {
    version: 2,
    name: 'UPS delivery digest',
    outcome: {
      statement: 'Every UPS shipping email is summarized into #logistics.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#logistics' }],
      examples: [],
    },
    triggers: [{ type: 'email', filter: 'from:ups.com' }],
    nodes: [
      { id: 'summarize', type: 'llm', label: 'Summarize', config: { mode: 'summarize', instructions: 'Summarize the shipment update.' } },
      { id: 'post',      type: 'deliver', label: 'Post to Slack', config: { channel: 'slack', target: '#logistics' } },
    ],
    edges: [{ from: 'summarize', to: 'post' }],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the control: a good spec is COMPLETE and PUBLISHABLE', () => {
  // Without this, every test below would pass if scoreGap simply rejected
  // everything — which is the exact way a guard ships broken behind a green run.
  test('a well-formed v2 spec has no unanswered gaps and validates', () => {
    const result = scoreGap(goodSpec());
    assert.deepEqual(unansweredGaps(result), [], 'a correct spec must have NO unanswered gaps');
    assert.equal(result.complete, true);
    assert.equal(validator().validate(goodSpec()).ok, true);
  });

  test('a TWO-node workflow is complete — no invented LLM step (defect #4)', () => {
    // The old scorer demanded a "processing" node and the converger invented an
    // LLM step to satisfy it — a paid model call on every run, for nothing.
    // Moving an email into a spreadsheet is genuinely two steps.
    const spec = {
      version: 2,
      name: 'Log inbound mail',
      outcome: {
        statement: 'Every inbound email is appended to the tracking sheet.',
        assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Inbound' }],
      },
      triggers: [{ type: 'email', filter: 'to:sales@acme.com' }],
      nodes: [
        { id: 'log', type: 'deliver', label: 'Append row',
          config: { channel: 'sheets_append', spreadsheetId: 'Inbound', range: 'A:C' } },
      ],
      edges: [],
    };
    const result = scoreGap(spec, { capabilities: CAPS });
    assert.equal(result.complete, true, 'a 2-node workflow that meets its outcome is finished');
    assert.equal(result.gaps.some(g => /processing|llm|ai step/i.test(g.message)), false,
      'nothing may demand a processing node');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a delivery channel declares its OWN config keys', () => {
  // Increment A's UNKNOWN_CONFIG_KEY judged every `deliver` node against
  // `deliver`'s schema alone. But a delivery channel is a capability with its own
  // parameters — `sheets_append`'s handler reads config.spreadsheetId and
  // config.range (src/connectors/google/index.js:694). Neither is a deliver key,
  // so EVERY delivery to a Sheet or an Airtable base was rejected at publish,
  // while the converger's system prompt rendered exactly that shape from the
  // channel catalog and told the model to emit it. Slack and Gmail escaped only
  // because their keys happen to overlap deliver's own.
  // `tableId` is declared "Table name or ID" by the capability itself
  // (src/connectors/airtable/index.js:254) and the handler URL-encodes it into
  // the path — so the human table name is a first-class locator, and the outcome
  // can be checked against it.
  const airtableSpec = (config) => ({
    version: 2, name: 'Lead capture',
    outcome: { assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads' }] },
    triggers: [{ type: 'email' }],
    nodes: [{ id: 'save', type: 'deliver', label: 'Save', config }],
    edges: [],
  });

  test('an Airtable delivery validates when the channel declares baseId/tableId', () => {
    const result = scoreGap(airtableSpec({
      channel: 'airtable_create_record', baseId: 'app1', tableId: 'Leads', fields: { Name: 'x' },
    }), { capabilities: CAPS });
    assert.equal(result.complete, true,
      `a valid Airtable delivery must publish; got: ${codes(result).join(', ')}`);
  });

  test('…and a key NO channel declares is still rejected', () => {
    // The fix narrows a LIE in the schema; it does not widen the check.
    const result = scoreGap(airtableSpec({
      channel: 'airtable_create_record', baseId: 'app1', tableId: 'Leads', fields: { Name: 'x' },
      model: 'claude-opus-4-5',
    }), { capabilities: CAPS });
    assert.ok(has(result, 'UNKNOWN_CONFIG_KEY'));
  });

  test('a delivery to a DIFFERENT table than the outcome promised is unsatisfied', () => {
    // The contract names a destination. Writing somewhere else is not "close
    // enough" — it is the promise going unmet, quietly, which is defect #1 in
    // its subtler form.
    const result = scoreGap(airtableSpec({
      channel: 'airtable_create_record', baseId: 'app1', tableId: 'Archive', fields: { Name: 'x' },
    }), { capabilities: CAPS });
    assert.ok(has(result, 'UNSATISFIED_ASSERTION'));
  });
});

// ── 1. UNSATISFIED ASSERTION — defect #1, the "Slack AND email" silent drop ──
describe('outcome gaps: an assertion no node satisfies', () => {
  const slackAndEmail = () => ({
    version: 2,
    name: 'Lead alert',
    outcome: {
      statement: 'Every lead is posted to #sales AND emailed to the rep.',
      assertions: [
        { id: 'a1', kind: 'message_sent', target: 'slack:#sales' },
        { id: 'a2', kind: 'message_sent', target: 'gmail:rep@acme.com' },   // <- promised
      ],
    },
    triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
    nodes: [
      { id: 'draft', type: 'llm', label: 'Draft', config: { mode: 'summarize' } },
      { id: 'post',  type: 'deliver', label: 'Slack', config: { channel: 'slack', target: '#sales' } },
      // …and NO email node. Exactly the spec the converger really shipped.
    ],
    edges: [{ from: 'draft', to: 'post' }],
  });

  test('the promised-but-missing delivery is reported as an OUTCOME gap', () => {
    const result = scoreGap(slackAndEmail());
    assert.ok(has(result, 'UNSATISFIED_ASSERTION'));
    const gap = result.gaps.find(g => g.code === 'UNSATISFIED_ASSERTION');
    assert.equal(gap.class, 'outcome');
    assert.match(gap.message, /gmail:rep@acme\.com/);
    assert.equal(gap.resolution, 'unanswered', 'a dropped delivery may NEVER default to escalated');
    assert.equal(result.complete, false);
  });

  test('THE ACCEPTANCE: the "Slack AND email" spec CANNOT PUBLISH', () => {
    assert.ok(errorCodes(slackAndEmail()).includes('UNSATISFIED_ASSERTION'),
      'defect #1 must be a hard publish error, not a warning');
  });

  test('adding the email node satisfies it — the check is not just "reject everything"', () => {
    const spec = slackAndEmail();
    spec.nodes.push({ id: 'mail', type: 'deliver', label: 'Email rep',
                      config: { channel: 'gmail_send', to: 'rep@acme.com' } });
    spec.edges.push({ from: 'draft', to: 'mail' });
    const result = scoreGap(spec);
    assert.equal(has(result, 'UNSATISFIED_ASSERTION'), false);
    assert.equal(result.complete, true);
    assert.equal(validator().validate(spec).ok, true);
  });

  test('an assertion whose kind we cannot check is MALFORMED, never ignored', () => {
    // Silently skipping an uncheckable assertion is the same failure as dropping
    // the delivery it asked for: the contract reports met, and nobody tested it.
    const spec = goodSpec();
    spec.outcome.assertions.push({ id: 'a2', kind: 'vibes_improved', target: 'slack:#ops' });
    const result = scoreGap(spec);
    assert.ok(has(result, 'MALFORMED_ASSERTION'));
    assert.equal(result.complete, false);
    assert.ok(errorCodes(spec).includes('MALFORMED_ASSERTION'));
  });

  test('a promised FIELD the write node never sets is reported', () => {
    const spec = {
      version: 2, name: 'Lead capture',
      outcome: { statement: 'Leads land in Airtable with Name, Company and Budget.',
                 assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads',
                                fields: ['Name', 'Company', 'Budget'] }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'save', type: 'connector-action', label: 'Create record',
          config: { action: 'airtable_create_record', baseId: 'app1', table: 'Leads',
                    fields: { Name: '{{x.output}}', Company: '{{x.output}}' } } },   // no Budget
        { id: 'out', type: 'deliver', label: 'Inbox', config: { channel: 'inbox_deliver', subject: 'Lead' } },
      ],
      edges: [{ from: 'save', to: 'out' }],
    };
    const result = scoreGap(spec);
    const gap = result.gaps.find(g => g.code === 'UNSATISFIED_ASSERTION');
    assert.ok(gap, 'a record created without a promised field does not meet the promise');
    assert.match(gap.message, /Budget/);
  });

  test('a field we CANNOT read is never reported as missing', () => {
    // Never accuse a spec of dropping a field we merely could not see — that
    // would block a valid workflow, and a false positive teaches people to
    // ignore the check.
    const spec = {
      version: 2, name: 'Lead capture',
      outcome: { assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Budget'] }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'save', type: 'connector-action', label: 'Create record',
          config: { action: 'airtable_create_record', table: 'Leads', fields: '{{extract.output}}' } },
        { id: 'out', type: 'deliver', label: 'Inbox', config: { channel: 'inbox_deliver', subject: 'Lead' } },
      ],
      edges: [{ from: 'save', to: 'out' }],
    };
    assert.equal(has(scoreGap(spec), 'UNSATISFIED_ASSERTION'), false);
  });
});

// ── 2. NON-EXHAUSTIVE BRANCH — defect #5 ─────────────────────────────────────
describe('coverage gaps: a branch with no catch-all', () => {
  const branchSpec = (cases) => ({
    version: 2, name: 'Triage',
    outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#urgent' }] },
    triggers: [{ type: 'email' }],
    nodes: [
      { id: 'classify', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'urgent\nroutine' } },
      { id: 'route', type: 'branch', label: 'Route', config: { on: 'classify.output', cases } },
      { id: 'urgent', type: 'deliver', label: 'Urgent', config: { channel: 'slack', target: '#urgent' } },
      { id: 'normal', type: 'deliver', label: 'Normal', config: { channel: 'inbox_deliver', subject: 'FYI' } },
    ],
    edges: [
      { from: 'classify', to: 'route' },
      { from: 'route', to: 'urgent' },
      { from: 'route', to: 'normal' },
    ],
  });

  test('no `*` case → a coverage gap that BLOCKS publish', () => {
    const result = scoreGap(branchSpec([{ when: 'urgent', to: 'urgent' }, { when: 'routine', to: 'normal' }]));
    assert.ok(has(result, 'NON_EXHAUSTIVE_BRANCH'));
    const gap = result.gaps.find(g => g.code === 'NON_EXHAUSTIVE_BRANCH');
    assert.equal(gap.class, 'coverage');
    assert.equal(gap.resolution, 'unanswered');
    assert.equal(result.complete, false);
  });

  test('with a `*` catch-all it is complete — the positive case', () => {
    const result = scoreGap(branchSpec([{ when: 'urgent', to: 'urgent' }, { when: '*', to: 'normal' }]));
    assert.equal(has(result, 'NON_EXHAUSTIVE_BRANCH'), false);
    assert.equal(result.complete, true);
  });
});

// ── 3. THE MOAT — LLM_INPUT_NOT_ENUM (§11.7) ────────────────────────────────
describe('the moat: an LLM decision input must be a closed enum', () => {
  test('a decision input with evaluator llm and free text is REJECTED', () => {
    const spec = {
      version: 2, name: 'Score',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#sales' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', label: 'Score',
          inputs: [{ key: 'tone', type: 'string', evaluator: 'llm', evaluatorPrompt: 'How urgent?' }],
          output: { key: 'priority', type: 'enum', values: ['P1', 'P2'] },
          hitPolicy: 'FIRST',
          rules: [{ when: { tone: '-' }, then: 'P2' }] },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#sales' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };
    assert.ok(errorCodes(spec).includes('LLM_INPUT_NOT_ENUM'), 'THE MOAT — never weaken this');
    assert.ok(has(scoreGap(spec), 'LLM_INPUT_NOT_ENUM'));
  });

  test('a closed enum with values is ACCEPTED', () => {
    const spec = {
      version: 2, name: 'Score',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#sales' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', label: 'Score',
          inputs: [{ key: 'tone', type: 'enum', values: ['calm', 'urgent'], evaluator: 'llm' }],
          output: { key: 'priority', type: 'enum', values: ['P1', 'P2'] },
          hitPolicy: 'FIRST',
          rules: [{ when: { tone: '-' }, then: 'P2' }] },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#sales' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };
    assert.equal(errorCodes(spec).includes('LLM_INPUT_NOT_ENUM'), false);
  });

  test('a branch routing on a FREEFORM llm step is the same defect, and is rejected', () => {
    // An LLM feeding a decision is an LLM feeding a decision, whichever node
    // type spells it. Routing on free prose is an unbounded domain: the cases
    // can never be proven to cover what the model might say.
    const spec = {
      version: 2, name: 'Triage',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#urgent' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'think', type: 'llm', label: 'Assess', config: { mode: 'freeform', prompt: 'Is this urgent?' } },
        { id: 'route', type: 'branch', label: 'Route',
          config: { on: 'think.output', cases: [{ when: 'yes', to: 'urgent' }, { when: '*', to: 'normal' }] } },
        { id: 'urgent', type: 'deliver', label: 'U', config: { channel: 'slack', target: '#urgent' } },
        { id: 'normal', type: 'deliver', label: 'N', config: { channel: 'inbox_deliver', subject: 'FYI' } },
      ],
      edges: [{ from: 'think', to: 'route' }, { from: 'route', to: 'urgent' }, { from: 'route', to: 'normal' }],
    };
    assert.ok(errorCodes(spec).includes('LLM_INPUT_NOT_ENUM'));
  });

  test('…and the SAME branch on a CLASSIFY step is accepted', () => {
    const spec = {
      version: 2, name: 'Triage',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#urgent' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'think', type: 'llm', label: 'Assess',
          config: { mode: 'classify', categories: 'yes\nno' } },
        { id: 'route', type: 'branch', label: 'Route',
          config: { on: 'think.output', cases: [{ when: 'yes', to: 'urgent' }, { when: '*', to: 'normal' }] } },
        { id: 'urgent', type: 'deliver', label: 'U', config: { channel: 'slack', target: '#urgent' } },
        { id: 'normal', type: 'deliver', label: 'N', config: { channel: 'inbox_deliver', subject: 'FYI' } },
      ],
      edges: [{ from: 'think', to: 'route' }, { from: 'route', to: 'urgent' }, { from: 'route', to: 'normal' }],
    };
    assert.equal(errorCodes(spec).includes('LLM_INPUT_NOT_ENUM'), false,
      'classify is the sanctioned path — if this fails, the moat has become a wall');
  });
});

// ── 4. DECISION TABLE GAP (coverage) ────────────────────────────────────────
describe('coverage gaps: a decision table with a hole', () => {
  const table = (rules, hitPolicy = 'FIRST') => ({
    inputs: [
      { key: 'tier',   type: 'enum', values: ['free', 'pro', 'enterprise'] },
      { key: 'urgent', type: 'boolean' },
    ],
    rules, hitPolicy,
  });

  test('an uncovered enum combination is found', () => {
    // Covers pro/enterprise; says nothing about `free`.
    const a = analyzeTable(table([
      { when: { tier: 'pro',        urgent: '-' }, then: 'queue' },
      { when: { tier: 'enterprise', urgent: '-' }, then: 'page' },
    ]));
    assert.equal(a.decidable, true);
    assert.ok(a.uncovered.length, 'the `free` tier is covered by no rule');
    assert.match(JSON.stringify(a.uncovered), /free/);
  });

  test('a fully covered table reports NO gap — the positive case', () => {
    const a = analyzeTable(table([
      { when: { tier: 'free',       urgent: '-' }, then: 'ignore' },
      { when: { tier: 'pro',        urgent: '-' }, then: 'queue' },
      { when: { tier: 'enterprise', urgent: '-' }, then: 'page' },
    ]));
    assert.equal(a.decidable, true);
    assert.deepEqual(a.uncovered, [], 'every combination is covered — inventing a gap here is as bad as missing one');
  });

  test('a catch-all rule covers everything', () => {
    const a = analyzeTable(table([
      { when: { tier: 'enterprise', urgent: 'true' }, then: 'page' },
      { when: { tier: '-', urgent: '-' }, then: 'queue' },
    ]));
    assert.equal(a.hasCatchAll, true);
    assert.deepEqual(a.uncovered, []);
  });

  test('numeric intervals are analysed by SUBTRACTION, and the hole is found', () => {
    const a = analyzeTable({
      inputs: [{ key: 'budget', type: 'number' }],
      rules: [
        { when: { budget: '>50000' },        then: 'P1' },
        { when: { budget: '[10000..50000]' }, then: 'P2' },
      ],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, true);
    assert.ok(a.uncovered.length, 'nothing decides what to do below 10000');
    assert.match(JSON.stringify(a.uncovered), /10000/);
  });

  test('a decision-table hole surfaces through scoreGap as an ESCALATABLE gap', () => {
    const spec = {
      version: 2, name: 'Triage',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', label: 'Score',
          inputs: [{ key: 'tier', type: 'enum', values: ['free', 'pro'] }],
          rules:  [{ when: { tier: 'pro' }, then: 'page' }],
          hitPolicy: 'FIRST' },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#ops' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };
    const result = scoreGap(spec);
    const gap = result.gaps.find(g => g.code === 'DECISION_TABLE_GAP');
    assert.ok(gap, 'the uncovered `free` tier must be reported before publish');
    assert.equal(gap.class, 'coverage');
    assert.equal(gap.resolution, 'escalated', 'an uncovered case defaults to a human — that is what makes it safe');
    assert.equal(gap.blocking, false);
  });

  test('an UNBOUNDED input is declared UNDECIDABLE — never quietly "covered"', () => {
    // The moat is a completeness proof. A proof we cannot make must be REFUSED,
    // not faked. This is the single most important assertion in the file.
    const a = analyzeTable({
      inputs: [{ key: 'subject', type: 'string' }],
      rules:  [{ when: { subject: 'refund' }, then: 'refunds' }],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, false, 'coverage over an infinite domain is NOT provable');
    assert.deepEqual(a.uncovered, [], 'and no coverage claim — true or false — may be made about it');
    assert.match(a.undecidable[0].reason, /unbounded|unknown/);
  });
});

// ── 5. UNIQUE HIT OVERLAP ───────────────────────────────────────────────────
describe('coverage gaps: UNIQUE with overlapping rules', () => {
  test('two rules that can both match under UNIQUE is an error', () => {
    const a = analyzeTable({
      inputs: [
        { key: 'tier',   type: 'enum', values: ['free', 'pro'] },
        { key: 'urgent', type: 'boolean' },
      ],
      rules: [
        { when: { tier: 'pro', urgent: '-'    }, then: 'queue' },   // pro,   true|false
        { when: { tier: '-',   urgent: 'true' }, then: 'page' },    // free|pro, true   ← both match (pro,true)
        { when: { tier: 'free', urgent: 'false' }, then: 'ignore' },
      ],
      hitPolicy: 'UNIQUE',
    });
    assert.equal(a.overlaps.length, 1);
    assert.deepEqual(a.overlaps[0].rules, [0, 1]);
  });

  test('the same table under FIRST reports no overlap — order resolves it', () => {
    const a = analyzeTable({
      inputs: [
        { key: 'tier',   type: 'enum', values: ['free', 'pro'] },
        { key: 'urgent', type: 'boolean' },
      ],
      rules: [
        { when: { tier: 'pro', urgent: '-'    }, then: 'queue' },
        { when: { tier: '-',   urgent: 'true' }, then: 'page' },
      ],
      hitPolicy: 'FIRST',
    });
    assert.deepEqual(a.overlaps, [], 'FIRST is defined on overlapping rules — flagging it would be a false alarm');
  });

  test('non-overlapping UNIQUE rules pass — the positive case', () => {
    const a = analyzeTable({
      inputs: [{ key: 'tier', type: 'enum', values: ['free', 'pro'] }],
      rules: [
        { when: { tier: 'free' }, then: 'ignore' },
        { when: { tier: 'pro'  }, then: 'queue' },
      ],
      hitPolicy: 'UNIQUE',
    });
    assert.deepEqual(a.overlaps, []);
  });

  test('an overlap surfaces through scoreGap and BLOCKS completeness', () => {
    const spec = {
      version: 2, name: 'Triage',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', label: 'Score',
          inputs: [{ key: 'tier', type: 'enum', values: ['free', 'pro'] }],
          rules: [
            { when: { tier: '-'    }, then: 'queue' },
            { when: { tier: 'pro'  }, then: 'page' },
          ],
          hitPolicy: 'UNIQUE' },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#ops' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };
    const result = scoreGap(spec);
    assert.ok(has(result, 'UNIQUE_HIT_OVERLAP'));
    assert.equal(result.complete, false, 'a table that promises one answer and can give two is not complete');
  });
});

// ── 6. UNKNOWN CONFIG KEY (contract) — defect #3 ────────────────────────────
describe('contract gaps: a config key the engine will silently ignore', () => {
  test('the dead "model" key is a contract gap that blocks', () => {
    const spec = goodSpec();
    spec.nodes[0].config.model = 'claude-opus-4-5';   // a model that does not exist, in no schema
    const result = scoreGap(spec);
    assert.ok(has(result, 'UNKNOWN_CONFIG_KEY'));
    const gap = result.gaps.find(g => g.code === 'UNKNOWN_CONFIG_KEY');
    assert.equal(gap.class, 'contract');
    assert.equal(gap.nodeId, 'summarize');
    assert.equal(gap.resolution, 'unanswered');
    assert.equal(result.complete, false);
  });

  test('a missing required config is a contract gap', () => {
    const spec = goodSpec();
    spec.nodes[0].config = { mode: 'freeform' };   // freeform with no prompt
    assert.ok(has(scoreGap(spec), 'MISSING_CONFIG'));
  });
});

// ── 7. THE INVARIANT: complete ⇒ publishable ────────────────────────────────
describe('the invariant that keeps `complete` honest', () => {
  // If these two ever diverge, the converger tells the user the workflow is
  // finished and the save button disagrees — a dead end with no way out. This
  // property is why the gap scorer reads the validator instead of holding a
  // second, private opinion about what "done" means.
  const corpus = [
    ['good',                goodSpec()],
    ['unsatisfied',         (() => { const s = goodSpec(); s.outcome.assertions.push({ id: 'a2', kind: 'message_sent', target: 'gmail:x@y.com' }); return s; })()],
    ['unknown key',         (() => { const s = goodSpec(); s.nodes[0].config.model = 'x'; return s; })()],
    ['no name',             (() => { const s = goodSpec(); s.name = ''; return s; })()],
    ['no trigger',          (() => { const s = goodSpec(); s.triggers = []; return s; })()],
    ['empty',               { version: 2, name: '', triggers: [], nodes: [], edges: [] }],
    ['bad template',        (() => { const s = goodSpec(); s.nodes[0].config.input = '{{nope.output}}'; return s; })()],
  ];

  for (const [label, spec] of corpus) {
    test(`"${label}": complete ⇒ the validator says ok`, () => {
      const result = scoreGap(spec);
      if (result.complete) {
        assert.equal(validator().validate(spec).ok, true,
          `scoreGap called "${label}" complete, but it cannot publish — the converger would ratify a dead end`);
      } else {
        assert.ok(unansweredGaps(result).length > 0, 'an incomplete spec must name what is missing');
      }
    });
  }

  test('a BLOCKING gap is never defaulted to "escalated"', () => {
    // Escalation promises a human will handle the case AT RUN TIME. A spec that
    // cannot publish has no run time, so calling it escalated is a lie told in
    // the language of safety.
    for (const [, spec] of corpus) {
      for (const gap of scoreGap(spec).gaps) {
        if (gap.blocking) {
          assert.equal(gap.resolution, 'unanswered',
            `a blocking gap (${gap.code}) defaulted to "${gap.resolution}" — it would be silently shipped`);
        }
      }
    }
  });

  test('nextGap asks about the OUTCOME before the plumbing', () => {
    const spec = goodSpec();
    spec.name = '';                                                        // contract gap
    spec.outcome.assertions.push({ id: 'a2', kind: 'message_sent', target: 'gmail:x@y.com' });  // outcome gap
    assert.equal(nextGap(scoreGap(spec)).class, 'outcome');
  });
});

// ── 8. The satisfaction oracle itself ───────────────────────────────────────
describe('the satisfaction oracle', () => {
  test('a READ capability satisfies nothing', () => {
    const node = { id: 'r', type: 'connector-action', config: { action: 'airtable_list_records', table: 'Leads' } };
    assert.equal(nodeEffect(node), null);
    assert.equal(satisfiesAssertion({ kind: 'record_exists', target: 'airtable:Leads' }, node), false);
  });

  test('an LLM step satisfies nothing — thinking is not delivering', () => {
    assert.equal(nodeEffect({ id: 'l', type: 'llm', config: { mode: 'summarize' } }), null);
  });

  test('the wrong channel does not satisfy the assertion', () => {
    const slack = { id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } };
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'gmail:a@b.com' }, slack), false);
  });

  test('the wrong Slack channel does not satisfy a located assertion', () => {
    const slack = { id: 'd', type: 'deliver', config: { channel: 'slack', target: '#random' } };
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:#ops' }, slack), false);
  });

  test('# and @ decoration does not change the destination', () => {
    const slack = { id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } };
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'slack:ops' }, slack), true);
  });

  test('a gmail_send used as a connector-action step satisfies an email assertion', () => {
    // The world does not care which node type called the capability.
    const node = { id: 's', type: 'connector-action', config: { action: 'gmail_send', to: 'a@b.com' } };
    assert.equal(satisfiesAssertion({ kind: 'message_sent', target: 'gmail:a@b.com' }, node), true);
  });

  test('checkOutcome never drops an assertion: every one is satisfied, unsatisfied, or malformed', () => {
    const outcome = { assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#ops' },
      { id: 'a2', kind: 'message_sent', target: 'gmail:a@b.com' },
      { id: 'a3', kind: 'nonsense',     target: 'slack:#ops' },
    ] };
    const nodes = [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }];
    const { satisfied, unsatisfied, malformed } = checkOutcome(outcome, nodes);
    assert.equal(satisfied.size + unsatisfied.length + malformed.length, 3,
      'every assertion must be accounted for — a dropped one is defect #1 all over again');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ADDED BY THE TEST ADVERSARY (P12-C). Everything below pins a scorer path the
// mutation sweep proved nothing was watching. Deeper unit coverage of the three
// C files lives in tests/workflows/{outcome-oracle,decision-analysis,validator-
// rules}.test.js; this section is specifically about scoreGap's own behaviour.
// ═════════════════════════════════════════════════════════════════════════════

// ── 9. The exception question — defect #5, "the converger asked ZERO, ever" ──
describe('NO_ERROR_PATH: the one question every workflow needs asked', () => {
  // `if (nodes.length && !nodes.some(n => n?.on_error))` (gap-scorer.js:176)
  // survived BOTH `if (true)` and `if (false)`. Nothing asserted the gap exists,
  // and nothing asserted it goes away once answered — so the whole point of
  // defect #5 ("the converger never asked a single exception question") was
  // riding on a line no test could see.
  test('a workflow where nothing says what happens on failure is ASKED about it', () => {
    const result = scoreGap(goodSpec());
    const gap = result.gaps.find(g => g.code === 'NO_ERROR_PATH');
    assert.ok(gap, 'the most basic exception question there is must actually get asked');
    assert.equal(gap.severity, 'warning');
    assert.equal(gap.blocking, false);
    assert.equal(gap.resolution, 'escalated', 'unanswered ⇒ a person deals with it — that is what makes the default honest');
    assert.match(gap.message, /fails/);
  });

  test('…and once ANY step declares on_error, it is not asked again (positive)', () => {
    // Without this the check could be `if (true)`: nagging about an error path
    // the author already wrote. A question that is asked after it is answered is
    // a question people learn to click past.
    const spec = goodSpec();
    spec.nodes[0].on_error = { then: 'retry', attempts: 2 };
    assert.equal(has(scoreGap(spec), 'NO_ERROR_PATH'), false);
  });

  test('an EMPTY draft is not asked about error paths — it has no steps to fail', () => {
    const result = scoreGap({ version: 2, name: '', triggers: [], nodes: [], edges: [] });
    assert.equal(has(result, 'NO_ERROR_PATH'), false);
    assert.equal(result.complete, false, 'but an empty draft is emphatically NOT complete');
  });
});

// ── 10. The gap object's own shape (the UI reads these fields) ───────────────
describe('a gap carries the validator\'s own message, hint and nodeId', () => {
  test('a spec-level gap has nodeId null and keeps the validator\'s hint', () => {
    const spec = goodSpec();
    spec.outcome.assertions.push({ id: 'a2', kind: 'message_sent', target: 'gmail:x@y.com' });
    const gap = scoreGap(spec).gaps.find(g => g.code === 'UNSATISFIED_ASSERTION');
    assert.equal(gap.nodeId, null, 'undefined is not null — the UI highlights on `nodeId === null`');
    assert.ok(gap.hint, 'the propose prompt is fed the HINT; drop it and the model is told what is wrong but not how to fix it');
    assert.match(gap.id, /_spec_/, 'a gap with no node still needs a stable id');
  });

  test('a gap with no hint reports null, not undefined', () => {
    const spec = goodSpec();
    spec.nodes.push({ id: 'summarize', type: 'llm', config: { mode: 'summarize' } });   // duplicate id — a hintless rule
    const gap = scoreGap(spec).gaps.find(g => g.code === 'DUPLICATE_NODE_ID');
    assert.ok(gap);
    assert.equal(gap.hint, null);
  });
});

// ── 11. The decision table, reached THROUGH the scorer ──────────────────────
describe('an UNDECIDABLE decision table, through scoreGap', () => {
  // `if (!analysis.decidable)` (gap-scorer.js:225) survived `if (false)`: with
  // the branch gone, an undecidable table produces NO gap at all — the scorer
  // would fall through to `analysis.uncovered` (empty, because no claim was made)
  // and report a clean bill of health on a table it could not read. That is the
  // false proof the whole module exists to refuse, and nothing was watching it.
  const undecidableSpec = (extraRules = []) => ({
    version: 2, name: 'Triage',
    outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
    triggers: [{ type: 'email' }],
    nodes: [
      { id: 'score', type: 'decision', label: 'Score',
        inputs: [{ key: 'subject', type: 'string' }],
        rules:  [{ when: { subject: 'refund' }, then: 'refunds' }, ...extraRules],
        hitPolicy: 'FIRST' },
      { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#ops' } },
    ],
    edges: [{ from: 'score', to: 'post' }],
  });

  test('an unbounded input is reported as UNDECIDABLE and BLOCKS', () => {
    const result = scoreGap(undecidableSpec());
    const gap = result.gaps.find(g => g.code === 'DECISION_UNDECIDABLE');
    assert.ok(gap, 'a table nobody can prove complete must not pass silently');
    assert.equal(gap.severity, 'error');
    assert.equal(gap.blocking, true);
    assert.equal(gap.resolution, 'unanswered');
    assert.equal(gap.decidable, false);
    assert.match(gap.message, /subject/);
    assert.equal(result.complete, false);
    assert.equal(has(result, 'DECISION_TABLE_GAP'), false,
      'NO coverage claim may be made about a table we cannot read — not even a negative one');
  });

  test('a CATCH-ALL downgrades it to escalatable — the one honest resolution', () => {
    const result = scoreGap(undecidableSpec([{ when: { subject: '-' }, then: 'triage' }]));
    const gap = result.gaps.find(g => g.code === 'DECISION_UNDECIDABLE');
    assert.ok(gap);
    assert.equal(gap.severity, 'warning');
    assert.equal(gap.blocking, false);
    assert.equal(gap.resolution, 'escalated',
      'an unanticipated input goes to a person instead of vanishing — that is what makes an undecidable input safe');
  });

  test('a rule the analyser cannot read is a BLOCKING bad condition', () => {
    const spec = {
      version: 2, name: 'Triage',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', label: 'Score',
          inputs: [{ key: 'tier', type: 'enum', values: ['free', 'pro'] }],
          rules:  [{ when: { tier: 'platinum' }, then: 'page' }],
          hitPolicy: 'FIRST' },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#ops' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };
    const gap = scoreGap(spec).gaps.find(g => g.code === 'DECISION_BAD_CONDITION');
    assert.ok(gap);
    assert.equal(gap.blocking, true);
    assert.equal(gap.resolution, 'unanswered');
    assert.match(gap.message, /platinum/);
  });

  test('the table can live under `config` as well as on the node (production shape)', () => {
    // The engine's own node config is where a `decision` table will land once
    // Increment E registers the type. Read only the top-level copy and a
    // config-shaped table is silently un-analysed: `hitPolicy: 'UNIQUE'` under
    // config defaulted to FIRST, and the overlap check never ran at all.
    const spec = {
      version: 2, name: 'Triage',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', label: 'Score', config: {
          inputs: [{ key: 'tier', type: 'enum', values: ['free', 'pro'] }],
          rules: [{ when: { tier: '-' }, then: 'queue' }, { when: { tier: 'pro' }, then: 'page' }],
          hitPolicy: 'UNIQUE',
        } },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#ops' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };
    const result = scoreGap(spec);
    assert.ok(has(result, 'UNIQUE_HIT_OVERLAP'),
      `a UNIQUE table under config must still be checked for overlap; got: ${codes(result).join(', ')}`);
    assert.equal(result.complete, false);
  });

  test('gaps beyond the reporting limit are COUNTED, not dropped', () => {
    // 5 inputs × 4 values, 4 diagonal rules ⇒ 16 uncovered boxes, 12 reported.
    // The remaining 4 must still be named, or the user is told about 12 holes in
    // a table that has 16 and believes they have finished.
    const vals = ['a', 'b', 'c', 'd'];
    const keys = ['k0', 'k1', 'k2', 'k3', 'k4'];
    const spec = {
      version: 2, name: 'Big table',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', label: 'Score',
          inputs: keys.map(key => ({ key, type: 'enum', values: vals })),
          rules: vals.map(v => ({ when: Object.fromEntries(keys.map(k => [k, v])), then: v })),
          hitPolicy: 'FIRST' },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#ops' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };
    const gaps = scoreGap(spec).gaps.filter(g => g.code === 'DECISION_TABLE_GAP');
    const more = gaps.find(g => /further uncovered/.test(g.message));
    assert.ok(more, 'the un-listed holes must still be counted out loud');
    assert.match(more.message, /4 further/);
  });

  test('a table with a SMALL hole reports no "further uncovered" gap (positive)', () => {
    const spec = {
      version: 2, name: 'Triage',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'score', type: 'decision', label: 'Score',
          inputs: [{ key: 'tier', type: 'enum', values: ['free', 'pro'] }],
          rules:  [{ when: { tier: 'pro' }, then: 'page' }],
          hitPolicy: 'FIRST' },
        { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target: '#ops' } },
      ],
      edges: [{ from: 'score', to: 'post' }],
    };
    const gaps = scoreGap(spec).gaps.filter(g => g.code === 'DECISION_TABLE_GAP');
    assert.equal(gaps.length, 1, 'one hole, one gap');
    assert.equal(gaps.some(g => /further uncovered/.test(g.message)), false,
      '"0 further uncovered combinations" is a message that must never be shown');
  });
});

// ── 12. THE PRODUCTION PUBLISH PATH ─────────────────────────────────────────
describe('complete ⇒ publishable, through WorkflowService + WorkflowStore', () => {
  // Every other test in this file checks `complete` against a hand-built
  // WorkflowValidator. Production does not publish through a hand-built
  // validator: it publishes through WorkflowService.create() → the store → SQLite,
  // and it EDITS through update(), which is a second, entirely separate validation
  // site. Increment B's cross-tenant leak was exactly this shape — a unit test
  // that hand-passed what production omits (CLAUDE.md, architectural flaw #2).
  //
  // The claim under test is the one in workflow-service.js:160: "THE CONTRACT
  // SURVIVES THE EDIT."
  const USER = 'u1';

  async function service() {
    const { WorkflowStore }   = await import('../../src/workflows/workflow-store.js');
    const { WorkflowService } = await import('../../src/workflows/workflow-service.js');
    const store = new WorkflowStore({ dbPath: ':memory:' });
    await store.init();
    return new WorkflowService({
      workflowStore:     store,
      nodeTypeRegistry:  registerBuiltInNodeTypes(new NodeTypeRegistry()),
      workflowValidator: validator(),
    });
  }

  /** "Post every lead to #sales AND email the rep" — the defect-#1 promise. */
  const contract = () => ({
    version: 2,
    name: 'Lead alert',
    outcome: {
      statement: 'Every lead is posted to #sales and emailed to the rep.',
      assertions: [
        { id: 'a1', kind: 'message_sent', target: 'slack:#sales' },
        { id: 'a2', kind: 'message_sent', target: 'gmail:rep@acme.com' },
      ],
    },
    triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
    nodes: [
      { id: 'draft', type: 'llm',     label: 'Draft', config: { mode: 'summarize' } },
      { id: 'post',  type: 'deliver', label: 'Slack', config: { channel: 'slack', target: '#sales' } },
      { id: 'mail',  type: 'deliver', label: 'Email', config: { channel: 'gmail_send', to: 'rep@acme.com' } },
    ],
    edges: [{ from: 'draft', to: 'post' }, { from: 'draft', to: 'mail' }],
    status: 'active',
  });

  test('a spec the scorer calls COMPLETE actually publishes', () => {
    // If this ever fails the converger is ratifying a dead end: the builder says
    // "done", the save button says no, and the user has no way to argue.
    assert.equal(scoreGap(contract()).complete, true);
  });

  test('…and it survives create() → SQLite → get(), outcome and all', async () => {
    const svc = await service();
    const res = await svc.create(contract(), { userId: USER, tenantId: 't1' });
    assert.equal(res.ok, true, `publish rejected a complete spec: ${JSON.stringify(res.issues)}`);

    const stored = svc.get(res.workflow.id, { userId: USER });
    assert.ok(stored.outcome, 'the CONTRACT must be persisted, not merely checked at the door');
    assert.equal(stored.outcome.assertions.length, 2);
    assert.equal(stored.spec_version, 2);
  });

  test('THE ACCEPTANCE: deleting the email step in a LATER EDIT is rejected', async () => {
    // Defect #1 walking back in through the edit path. Publish "Slack AND email"
    // (checked, passes), then quietly drop the email node a week later. The
    // promise was made to the user, not to the publish button.
    const svc = await service();
    const created = await svc.create(contract(), { userId: USER, tenantId: 't1' });
    assert.equal(created.ok, true);

    const gutted = contract();
    const res = await svc.update(created.workflow.id, {
      nodes: gutted.nodes.filter(n => n.id !== 'mail'),
      edges: gutted.edges.filter(e => e.to !== 'mail'),
    }, { userId: USER });

    assert.equal(res.ok, false, 'an edit that breaks the stored contract must not save');
    assert.ok(res.issues.some(i => i.code === 'UNSATISFIED_ASSERTION'),
      `expected UNSATISFIED_ASSERTION; got: ${JSON.stringify(res.issues)}`);

    // …and the stored workflow is UNCHANGED — a rejected edit must not half-apply.
    const stored = svc.get(created.workflow.id, { userId: USER });
    assert.equal(stored.nodes.length, 3, 'the rejected edit leaked into the database');
  });

  test('an edit that KEEPS the contract still saves (positive)', async () => {
    // Without this the rule could be "reject every edit to a v2 workflow", which
    // is a green suite and an unusable product.
    const svc = await service();
    const created = await svc.create(contract(), { userId: USER, tenantId: 't1' });
    const spec = contract();
    spec.nodes[0].config = { mode: 'summarize', style: 'bullets' };
    const res = await svc.update(created.workflow.id, { nodes: spec.nodes, edges: spec.edges }, { userId: USER });
    assert.equal(res.ok, true, `a contract-preserving edit was rejected: ${JSON.stringify(res.issues)}`);
  });

  test('the contract can be deliberately RETRACTED with outcome: null', async () => {
    const svc = await service();
    const created = await svc.create(contract(), { userId: USER, tenantId: 't1' });
    const spec = contract();
    const res = await svc.update(created.workflow.id, {
      outcome: null,
      nodes: spec.nodes.filter(n => n.id !== 'mail'),
      edges: spec.edges.filter(e => e.to !== 'mail'),
    }, { userId: USER });
    assert.equal(res.ok, true, `retracting the contract must be possible: ${JSON.stringify(res.issues)}`);
    assert.equal(svc.get(created.workflow.id, { userId: USER }).outcome, null,
      'a retracted contract must leave no contract behind — not the string "null"');
  });

  test('a v1 workflow (no outcome) publishes and edits exactly as before', async () => {
    // §11.2's structural guarantee, at the persistence layer: the workflows
    // already in production carry no contract and must not acquire one.
    const svc = await service();
    const v1 = {
      name: 'Legacy digest',
      triggers: [{ type: 'schedule', cron: '0 9 * * *' }],
      nodes: [
        { id: 'sum', type: 'summarize', config: {} },                        // a v1 type, lifted on read
        { id: 'out', type: 'deliver', config: { channel: 'in_app', title: 'Digest' } },
      ],
      edges: [{ from: 'sum', to: 'out' }],
    };
    const created = await svc.create(v1, { userId: USER, tenantId: 't1' });
    assert.equal(created.ok, true, `a v1 spec must still publish: ${JSON.stringify(created.issues)}`);
    assert.equal(created.workflow.outcome, null);
    assert.equal(created.workflow.spec_version, 1);

    const edited = await svc.update(created.workflow.id, { name: 'Legacy digest v2' }, { userId: USER });
    assert.equal(edited.ok, true, 'editing a v1 workflow must not demand a contract it never made');
  });
});
