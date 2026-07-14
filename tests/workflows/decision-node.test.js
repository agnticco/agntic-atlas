/**
 * The `decision` node — P12 Increment E.
 *
 * Increment C built the DMN analysis (decision-analysis.js) and could not reach
 * it from anything runnable: `decision` was not a registered node type, so the
 * moat guarded a shape no spec could contain. E makes it real, and this suite is
 * what stops it going quiet again.
 *
 * Every test here is written to FAIL when the invariant it names is broken. The
 * ones that matter most:
 *
 *   • an uncovered case THROWS — it never returns null and never guesses. A null
 *     would reach the downstream branch, match no case, and be swallowed by the
 *     mandatory catch-all: a silent no-op with `run_completed`, which is the one
 *     failure this entire phase exists to make impossible.
 *   • the ENGINE and the ANALYSER read a condition the same way. One FEEL-A
 *     grammar (decision-analysis.js), consulted by both. If they can disagree,
 *     the completeness proof is about a program nobody is running.
 *   • a decision's output NEVER becomes `lastOutput` — a `deliver` after a
 *     decision sends the draft, not the audit record.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { decisionNodeType, tableOf, normalizeHitPolicy, HIT_POLICIES } from '../../src/workflows/node-types/decision.js';
import { matchesCondition } from '../../src/workflows/decision-analysis.js';
import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }  from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { FlowTester }        from '../../src/workflows/flow-tester.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const validator = new WorkflowValidator({ nodeTypes });

const codes = (def) => validator.validate(def).issues.map(i => i.code);

/** A table: budget (number) × tone (AI-judged enum) → priority. §2.2's own example. */
const table = (over = {}) => ({
  inputs: [
    { key: 'budget', type: 'number' },
    { key: 'tone',   type: 'enum', values: ['calm', 'urgent'], evaluator: 'llm', evaluatorPrompt: 'How urgent?' },
  ],
  output:    { key: 'priority', type: 'enum', values: ['P1', 'P2', 'P3'] },
  hitPolicy: 'FIRST',
  rules: [
    { when: { budget: '>50000' },            then: 'P1' },
    { when: { tone: 'urgent' },              then: 'P1' },
    { when: { budget: '[10000..50000]' },    then: 'P2' },
    { when: { budget: '-', tone: '-' },      then: 'P3' },
  ],
  ...over,
});

const spec = (decisionCfg, extra = {}) => ({
  version: 2, name: 'Lead triage',
  outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
  triggers: [{ type: 'email' }],
  nodes: [
    { id: 'score', type: 'decision', label: 'Score it', config: decisionCfg },
    { id: 'post',  type: 'deliver',  label: 'Post',     config: { channel: 'slack', target: '#ops' } },
  ],
  edges: [{ from: 'score', to: 'post' }],
  ...extra,
});

/** A stub LLM that always answers `answer` — and counts how often it was asked. */
const stubLLM = (answer) => {
  const calls = [];
  return {
    calls,
    invoke: async (msgs) => { calls.push(String(msgs[1]?.content ?? '')); return { content: answer }; },
  };
};

const ctxWith = (lastOutput, extra = {}) => ({
  outputs: new Map(), lastOutput, ancestorOutputs: [], nodeIds: new Set(), ...extra,
});

const run = (cfg, ctx, services = {}) => decisionNodeType.run(cfg, ctx, services);

// ── 1. It decides, and it says WHICH RULE decided ────────────────────────────

describe('the decision itself', () => {
  test('a numeric threshold picks the rule, and reports which one fired', async () => {
    const out = await run(table(), ctxWith({ budget: 80000 }), { llm: stubLLM('calm') });
    assert.equal(out.value, 'P1');
    assert.equal(out.rule.index, 0, 'THE AUDIT TRAIL: which row of the table fired');
    assert.deepEqual(out.rule.when, { budget: '>50000' });
    assert.deepEqual(out.inputs, { budget: 80000, tone: 'calm' },
      'and on which resolved inputs — "why did it decide that" must be answerable');
  });

  test('FIRST means first: an earlier matching rule wins over a later one', async () => {
    // budget 80000 matches rule 1 (>50000); tone urgent matches rule 2. Both are
    // P1 here, so assert on the RULE, not the value — otherwise the test passes
    // whichever rule fired and pins nothing.
    const out = await run(table(), ctxWith({ budget: 80000 }), { llm: stubLLM('urgent') });
    assert.equal(out.rule.index, 0);
  });

  test('an interval condition is inclusive at both ends ([10000..50000])', async () => {
    const at50k = await run(table(), ctxWith({ budget: 50000 }), { llm: stubLLM('calm') });
    assert.equal(at50k.value, 'P2', '50000 is NOT > 50000, so it falls to the interval rule');
    const at10k = await run(table(), ctxWith({ budget: 10000 }), { llm: stubLLM('calm') });
    assert.equal(at10k.value, 'P2');
  });

  test('the catch-all rule (every input "-") takes everything else', async () => {
    const out = await run(table(), ctxWith({ budget: 500 }), { llm: stubLLM('calm') });
    assert.equal(out.value, 'P3');
    assert.equal(out.rule.index, 3);
  });

  test('UNIQUE with two matching rules THROWS — the table promised one answer', async () => {
    const t = table({
      hitPolicy: 'UNIQUE',
      rules: [
        { when: { budget: '>1000' }, then: 'P1' },
        { when: { tone: 'urgent' },  then: 'P2' },
        { when: { budget: '-', tone: '-' }, then: 'P3' },
      ],
    });
    await assert.rejects(
      () => run(t, ctxWith({ budget: 90000 }), { llm: stubLLM('urgent') }),
      /UNIQUE/,
      'picking one anyway would make the answer depend on rule order in a table whose author was told order does not matter',
    );
  });

  test('COLLECT returns every match, as a list', async () => {
    const t = table({
      hitPolicy: 'COLLECT',
      rules: [
        { when: { budget: '>1000' }, then: 'P1' },
        { when: { tone: 'urgent' },  then: 'P2' },
        { when: { budget: '-', tone: '-' }, then: 'P3' },
      ],
    });
    const out = await run(t, ctxWith({ budget: 90000 }), { llm: stubLLM('urgent') });
    assert.deepEqual(out.value, ['P1', 'P2', 'P3']);
  });
});

// ── 2. THE HEADLINE: an uncovered case fails LOUDLY ─────────────────────────

describe('an uncovered case never silently does nothing', () => {
  const noCatchAll = () => table({
    rules: [
      { when: { budget: '>50000' }, then: 'P1' },
      { when: { tone: 'urgent' },   then: 'P1' },
    ],
  });

  test('no rule matched ⇒ THROW, with the inputs named', async () => {
    // If this ever returns instead of throwing, the value flows into the
    // downstream branch, matches no case, and the MANDATORY CATCH-ALL swallows
    // 100% of traffic — silently, with run_completed. That is the exact defect
    // the whole increment exists to prevent.
    await assert.rejects(
      () => run(noCatchAll(), ctxWith({ budget: 200 }), { llm: stubLLM('calm') }),
      (err) => {
        assert.match(err.message, /no rule/i);
        assert.match(err.message, /budget/, 'it must say WHICH inputs it could not place');
        assert.match(err.message, /200/);
        return true;
      },
    );
  });

  test('it does not quietly fall back to the first rule, or to null', async () => {
    let out = 'not thrown';
    try { out = await run(noCatchAll(), ctxWith({ budget: 200 }), { llm: stubLLM('calm') }); } catch { out = 'threw'; }
    assert.equal(out, 'threw');
  });
});

// ── 3. THE MOAT, at run time ────────────────────────────────────────────────

describe('an AI-judged input classifies into its closed enum, or the run stops', () => {
  test('the model\'s answer is snapped to a declared value', async () => {
    const llm = stubLLM('urgent');
    const out = await run(table(), ctxWith({ budget: 1 }), { llm });
    assert.equal(out.inputs.tone, 'urgent');
    assert.equal(llm.calls.length, 1, 'ONE call per fuzzy input — that is what makes it attributable');
    assert.match(llm.calls[0], /calm/);
    assert.match(llm.calls[0], /urgent/, 'the closed list must be IN the prompt, or it is not a closed question');
  });

  test('an OFF-ENUM answer throws — free text never enters the table', async () => {
    await assert.rejects(
      () => run(table(), ctxWith({ budget: 1 }), { llm: stubLLM('somewhat impatient, I would say') }),
      /not one of/,
      'a table proven complete over {calm,urgent} decides nothing about "somewhat impatient"',
    );
  });

  test('an AI input with NO closed list refuses to run, even if the validator never saw it', async () => {
    // The engine does not rely on the validator having run. A spec in the database
    // predates every rule we write.
    const t = table({
      inputs: [
        { key: 'budget', type: 'number' },
        { key: 'tone',   type: 'string', evaluator: 'llm' },   // no values — LLM_INPUT_NOT_ENUM
      ],
    });
    await assert.rejects(
      () => run(t, ctxWith({ budget: 1 }), { llm: stubLLM('anything') }),
      /closed list|unbounded/i,
    );
  });

  test('a fuzzy input with no upstream content throws rather than judging nothing', async () => {
    // budget arrives by an explicit `from`, so the only thing missing is the
    // CONTENT the model would judge the tone of. Asking a classifier to pick from
    // a closed list with nothing to read is asking it to guess, and a guess that
    // lands on a declared value is indistinguishable from a judgement.
    const t = table();
    t.inputs[0].from = 'extract.budget';
    const ctx = ctxWith(null, { outputs: new Map([['extract', { budget: 1 }]]) });
    await assert.rejects(() => run(t, ctx, { llm: stubLLM('calm') }), /nothing to judge|no upstream/i);
  });
});

// ── 4. Reading the inputs ───────────────────────────────────────────────────

describe('where an input\'s value comes from', () => {
  const numeric = () => ({
    inputs: [{ key: 'budget', type: 'number' }],
    output: { key: 'priority', type: 'enum', values: ['P1', 'P3'] },
    hitPolicy: 'FIRST',
    rules: [{ when: { budget: '>50000' }, then: 'P1' }, { when: { budget: '-' }, then: 'P3' }],
  });

  test('an explicit `from` reads a named step\'s field', async () => {
    const ctx = ctxWith(null, { outputs: new Map([['extract', { budget: 90000 }]]) });
    const cfg = numeric();
    cfg.inputs[0].from = 'extract.budget';
    assert.equal((await run(cfg, ctx)).value, 'P1');
  });

  test('with no `from`, the input\'s own key is found in the upstream output', async () => {
    assert.equal((await run(numeric(), ctxWith({ budget: 90000 }))).value, 'P1');
  });

  test('an upstream JSON STRING is read too (an llm extract returns one)', async () => {
    assert.equal((await run(numeric(), ctxWith('{"budget":90000}'))).value, 'P1');
  });

  test('a MISSING input throws — it never defaults to empty', async () => {
    // A missing input silently becoming "" would match whatever rule tests `-` on
    // it, and the table would decide on a value nobody supplied: a wrong answer
    // that looks exactly like a right one.
    await assert.rejects(() => run(numeric(), ctxWith({ nothing: 1 })), /not produced by any earlier step/);
  });

  test('a `from` naming a step that did not run throws — it does not read undefined', async () => {
    const cfg = numeric();
    cfg.inputs[0].from = 'ghost.budget';
    await assert.rejects(() => run(cfg, ctxWith({ budget: 90000 })), /ghost/);
  });

  test('"$80,000" is read as a number — a value is text until proven otherwise', async () => {
    assert.equal((await run(numeric(), ctxWith({ budget: '$80,000' }))).value, 'P1');
  });

  test('a number input handed prose throws rather than deciding on NaN', async () => {
    await assert.rejects(() => run(numeric(), ctxWith({ budget: 'quite a lot' })), /needs a number/);
  });
});

// ── 5. The engine and the analyser read a condition the SAME way ────────────

describe('one FEEL-A grammar, consulted by both', () => {
  const num = { key: 'n', type: 'number' };
  const en  = { key: 'e', type: 'enum', values: ['a', 'b', 'c'] };

  test('the comparison, interval, list and not() forms all evaluate', () => {
    assert.equal(matchesCondition('>10', num, 11).matched, true);
    assert.equal(matchesCondition('>10', num, 10).matched, false);
    assert.equal(matchesCondition('<=10', num, 10).matched, true);
    assert.equal(matchesCondition('[10..50]', num, 50).matched, true);
    assert.equal(matchesCondition('(10..50)', num, 50).matched, false);
    assert.equal(matchesCondition('a, b', en, 'b').matched, true);
    assert.equal(matchesCondition('not(a)', en, 'b').matched, true);
    assert.equal(matchesCondition('not(a)', en, 'a').matched, false);
    assert.equal(matchesCondition('-', en, 'anything').matched, true, '"-" means the rule does not care');
  });

  test('an UNPARSEABLE condition reports ok:false — it is not merely "no match"', () => {
    const r = matchesCondition('>= budget', num, 5);
    assert.equal(r.ok, false,
      'a condition nobody can read is not a condition that failed to match — treating it as "no match" would let a rule silently narrow the table');
  });

  test('and the ENGINE refuses to run it, rather than skipping the rule', async () => {
    const cfg = {
      inputs: [{ key: 'n', type: 'number' }],
      output: { key: 'r', type: 'enum', values: ['x', 'y'] },
      hitPolicy: 'FIRST',
      rules: [{ when: { n: 'roughly a lot' }, then: 'x' }, { when: { n: '-' }, then: 'y' }],
    };
    await assert.rejects(() => run(cfg, ctxWith({ n: 5 })), /cannot evaluate|not a condition/i);
  });
});

// ── 6. The validator (publish) ──────────────────────────────────────────────

describe('the DMN analysis runs at PUBLISH, not only in the converger', () => {
  test('a gap is reported — and does NOT block (it is escalatable, and honestly so)', () => {
    const t = table({ rules: [{ when: { budget: '>50000' }, then: 'P1' }] });
    const res = validator.validate(spec(t));
    assert.ok(res.issues.some(i => i.code === 'DECISION_TABLE_GAP'),
      'an uncovered combination must be found before publish, not at 3am');
    assert.equal(res.errors.some(e => e.code === 'DECISION_TABLE_GAP'), false,
      'it is a WARNING: publishing a workflow that hands an unanticipated case to a person is honest. Publishing one that silently does nothing is not — and decision.run() throws, so it cannot.');
  });

  test('UNIQUE + overlapping rules is REJECTED', () => {
    const t = table({
      hitPolicy: 'UNIQUE',
      rules: [
        { when: { budget: '>1000' }, then: 'P1' },
        { when: { tone: 'urgent' },  then: 'P2' },
        { when: { budget: '-', tone: '-' }, then: 'P3' },
      ],
    });
    const res = validator.validate(spec(t));
    assert.ok(res.errors.some(e => e.code === 'UNIQUE_HIT_OVERLAP'));
    assert.equal(res.ok, false);
  });

  test('POSITIVE: the well-formed table VALIDATES (the check is not just "reject everything")', () => {
    const res = validator.validate(spec(table()));
    assert.equal(res.ok, true, `a good table must publish; got: ${res.errors.map(e => e.code + ': ' + e.message).join(' | ')}`);
  });

  test('a `then` outside the output enum is rejected — nothing could route on it', () => {
    const t = table({ rules: [...table().rules, { when: { budget: '<0' }, then: 'P0' }] });
    assert.ok(codes(spec(t)).includes('DECISION_OUTPUT_NOT_IN_ENUM'));
  });

  test('a `when` naming an undeclared input is rejected — the condition would be IGNORED', () => {
    // The analysis partitions the DECLARED inputs only. A condition on an unknown
    // key is silently dropped, so the rule covers boxes its author believed it
    // excluded — and the proof would be about a different table.
    const t = table({ rules: [{ when: { budget: '-', tone: '-', region: 'EU' }, then: 'P1' }] });
    assert.ok(codes(spec(t)).includes('DECISION_UNKNOWN_INPUT'));
  });

  test('the MOAT still bites now that decision is runnable: an AI input with no enum', () => {
    const t = table({
      inputs: [{ key: 'budget', type: 'number' }, { key: 'tone', type: 'string', evaluator: 'llm' }],
    });
    const res = validator.validate(spec(t));
    assert.ok(res.errors.some(e => e.code === 'LLM_INPUT_NOT_ENUM'),
      '§11.7. Registering the node type must not have moved the check out of the way of the shape it guards.');
  });

  test('>4 inputs asks for a DECOMPOSE — the limit is cognitive, not computational', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const t = {
      inputs: keys.map(k => ({ key: k, type: 'enum', values: ['x', 'y'] })),
      output: { key: 'r', type: 'enum', values: ['P1', 'P2'] },
      hitPolicy: 'FIRST',
      rules: [{ when: Object.fromEntries(keys.map(k => [k, '-'])), then: 'P1' }],
    };
    const issue = validator.validate(spec(t)).issues.find(i => i.code === 'DECISION_TOO_WIDE');
    assert.ok(issue, 'a table nobody can review is not auditable, which is the whole claim');
    assert.equal(issue.severity, 'warning', 'unreviewable is not the same as incorrect — say so, do not block');
    assert.match(issue.hint, /[Ss]plit/);
  });

  test('4 inputs does NOT trigger it (the boundary is > 4, not >= 4)', () => {
    const keys = ['a', 'b', 'c', 'd'];
    const t = {
      inputs: keys.map(k => ({ key: k, type: 'enum', values: ['x', 'y'] })),
      output: { key: 'r', type: 'enum', values: ['P1', 'P2'] },
      hitPolicy: 'FIRST',
      rules: [{ when: Object.fromEntries(keys.map(k => [k, '-'])), then: 'P1' }],
    };
    assert.equal(codes(spec(t)).includes('DECISION_TOO_WIDE'), false);
  });

  test('an unknown hit policy is rejected, not silently read as FIRST', () => {
    // Quietly defaulting "UNIQE" to FIRST would run the table under a policy its
    // author did not choose — and UNIQUE's promise (overlaps are impossible)
    // would never be checked at all.
    assert.ok(codes(spec(table({ hitPolicy: 'UNIQE' }))).includes('DECISION_BAD_HIT_POLICY'));
    assert.equal(normalizeHitPolicy('UNIQE'), 'UNIQE', 'it is returned verbatim so the validator can see it');
    assert.equal(normalizeHitPolicy(undefined), 'FIRST');
    assert.equal(normalizeHitPolicy('u'), 'UNIQUE');
  });

  test('the table hung off the NODE (not config) is rejected — the engine would never read it', () => {
    const bad = spec({});
    Object.assign(bad.nodes[0], table());
    bad.nodes[0].config = {};
    const res = validator.validate(bad);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => /outside its config/.test(e.message)),
      'run() is handed node.config and nothing else — a table on the node is a table nobody executes');
  });

  test('two inputs sharing a key is rejected', () => {
    const t = table({
      inputs: [{ key: 'budget', type: 'number' }, { key: 'budget', type: 'number' }],
    });
    assert.ok(codes(spec(t)).includes('DUPLICATE_DECISION_INPUT'));
  });
});

// ── 6b. The structural checks, each pinned on its own ───────────────────────
//
// The generated mutation sweep reported EVERY branch of decision.validate() as a
// survivor: the whole structural half of the check could be deleted with the suite
// still green. A validator rule nothing pins is a rule the next person can remove
// without anything noticing, which is how a check becomes decoration.

describe('a malformed table is REPORTED, never crashed on and never shrugged at', () => {
  const only = (cfg) => validator.validate(spec(cfg)).issues
    .filter(i => i.nodeId === 'score').map(i => i.code);

  test('no inputs', () => {
    assert.ok(only({ ...table(), inputs: [] }).includes('MISSING_CONFIG'));
  });

  test('an input with no key', () => {
    const t = table();
    t.inputs = [{ type: 'number' }];
    const res = validator.validate(spec(t));
    assert.ok(res.errors.some(e => /no key/.test(e.message)));
  });

  test('an input with no type — its domain is unknown, so coverage cannot be checked', () => {
    const t = table();
    t.inputs = [{ key: 'budget' }];
    assert.ok(validator.validate(spec(t)).errors.some(e => /what kind of value/.test(e.message)));
  });

  test('a `from` that is not a step reference', () => {
    const t = table();
    t.inputs[0].from = 'extract.budget.deep[0]';
    assert.ok(only(t).includes('DECISION_BAD_INPUT_REF'));
  });

  test('no output', () => {
    const t = table();
    delete t.output;
    assert.ok(validator.validate(spec(t)).errors.some(e => /doesn't say what it decides/.test(e.message)));
  });

  test('an output with fewer than two values decides nothing', () => {
    const t = table({ output: { key: 'priority', type: 'enum', values: ['P1'] } });
    assert.ok(validator.validate(spec(t)).errors.some(e => /fewer than two possible answers/.test(e.message)));
  });

  test('no rules', () => {
    assert.ok(validator.validate(spec(table({ rules: [] }))).errors.some(e => /no rules/.test(e.message)));
  });

  test('a rule that is not an object, or has no `when`', () => {
    assert.ok(only(table({ rules: [null] })).includes('DECISION_BAD_CONDITION'));
    assert.ok(only(table({ rules: [{ then: 'P1' }] })).includes('DECISION_BAD_CONDITION'));
  });

  test('a rule with no `then` — it matches and then decides nothing', () => {
    assert.ok(validator.validate(spec(table({ rules: [{ when: { budget: '-', tone: '-' } }] })))
      .errors.some(e => /doesn't say what to decide/.test(e.message)));
  });

  test('and a null node still does not crash the validator', () => {
    const bad = spec(table());
    bad.nodes.push(null);
    assert.doesNotThrow(() => validator.validate(bad));
  });
});

describe('the engine refuses a table it cannot read, rather than evaluating what is left', () => {
  test('no inputs or no rules ⇒ throw', async () => {
    await assert.rejects(() => run({ inputs: [], rules: [], output: { key: 'x', values: ['a', 'b'] } }, ctxWith({})),
      /nothing to decide/);
  });

  test('a MALFORMED RULE stops the run — it is never skipped', async () => {
    // Skipping it makes every remaining rule broader than it was written, and the
    // table decides confidently from something nobody authored. This is C's
    // defect #2 ("a malformed rule silently covered the whole table") arriving at
    // the executor instead of the analyser.
    const t = {
      inputs: [{ key: 'n', type: 'number' }],
      output: { key: 'r', type: 'enum', values: ['x', 'y'] },
      hitPolicy: 'FIRST',
      rules: [null, { when: { n: '-' }, then: 'y' }],
    };
    await assert.rejects(() => run(t, ctxWith({ n: 1 })), /no readable conditions/);
  });

  test('a KEYLESS INPUT stops the run — the dimension does not just vanish', async () => {
    const t = {
      inputs: [{ type: 'number' }],
      output: { key: 'r', type: 'enum', values: ['x', 'y'] },
      hitPolicy: 'FIRST',
      rules: [{ when: {}, then: 'y' }],
    };
    await assert.rejects(() => run(t, ctxWith({ n: 1 })), /no key/);
  });

  test('and the ANALYSER sees the malformed rule too — no coverage claim is made', () => {
    const t = table({ rules: [null, ...table().rules] });
    const res = validator.validate(spec(t));
    assert.ok(res.errors.some(e => e.code === 'DECISION_BAD_CONDITION'),
      'the reader must hand the analyser the table the author WROTE, malformed rows and all');
    assert.equal(res.issues.some(i => i.code === 'DECISION_TABLE_GAP'), false,
      'and NO coverage claim may be made about a table we cannot read — not even a negative one');
  });
});

describe('coercion — a value read out of an upstream step is text until proven otherwise', () => {
  const boolTable = {
    inputs: [{ key: 'vip', type: 'boolean' }],
    output: { key: 'lane', type: 'enum', values: ['fast', 'normal'] },
    hitPolicy: 'FIRST',
    rules: [{ when: { vip: 'true' }, then: 'fast' }, { when: { vip: '-' }, then: 'normal' }],
  };

  test('a boolean input reads true/false, and the STRINGS "true"/"yes" too', async () => {
    assert.equal((await run(boolTable, ctxWith({ vip: true }))).value, 'fast');
    assert.equal((await run(boolTable, ctxWith({ vip: 'true' }))).value, 'fast');
    assert.equal((await run(boolTable, ctxWith({ vip: 'yes' }))).value, 'fast');
    assert.equal((await run(boolTable, ctxWith({ vip: false }))).value, 'normal');
  });

  test('a boolean input handed something else throws rather than deciding on a guess', async () => {
    await assert.rejects(() => run(boolTable, ctxWith({ vip: 'maybe' })), /needs true or false/);
  });

  test('a plain (non-AI) enum input is compared as a string, not coerced to a number', async () => {
    const t = {
      inputs: [{ key: 'tier', type: 'enum', values: ['free', 'pro'] }],
      output: { key: 'lane', type: 'enum', values: ['fast', 'normal'] },
      hitPolicy: 'FIRST',
      rules: [{ when: { tier: 'pro' }, then: 'fast' }, { when: { tier: '-' }, then: 'normal' }],
    };
    assert.equal((await run(t, ctxWith({ tier: 'pro' }))).value, 'fast');
    assert.equal((await run(t, ctxWith({ tier: 'free' }))).value, 'normal');
  });
});

describe('a `from` says WHICH way it failed — the two paths are not interchangeable', () => {
  const numeric = () => ({
    inputs: [{ key: 'budget', type: 'number', from: 'extract.budget' }],
    output: { key: 'priority', type: 'enum', values: ['P1', 'P3'] },
    hitPolicy: 'FIRST',
    rules: [{ when: { budget: '>50000' }, then: 'P1' }, { when: { budget: '-' }, then: 'P3' }],
  });

  test('the STEP never ran ⇒ "produced no output on this run"', async () => {
    await assert.rejects(
      () => run(numeric(), ctxWith(null, { outputs: new Map() })),
      /produced no output on this run/,
    );
  });

  test('the step ran but has no such FIELD ⇒ "produced no \\"budget\\""', async () => {
    // A different sentence, because it is a different mistake: one is a broken
    // graph, the other is a typo'd field name. Collapsing them tells the user to
    // look in the wrong place.
    await assert.rejects(
      () => run(numeric(), ctxWith(null, { outputs: new Map([['extract', { total: 9 }]]) })),
      /produced no "budget"/,
    );
  });

  test('a whole-step reference (no field) reads the step\'s output', async () => {
    const cfg = numeric();
    cfg.inputs[0].from = 'extract';
    assert.equal((await run(cfg, ctxWith(null, { outputs: new Map([['extract', 90000]]) }))).value, 'P1');
  });
});

// ── 7. A branch may route on a decision — and only on a single-hit one ──────

describe('the branch allowlist (closedDomainOf)', () => {
  const routed = (decisionCfg, cases) => ({
    version: 2, name: 'Routed',
    outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
    triggers: [{ type: 'email' }],
    nodes: [
      { id: 'score', type: 'decision', label: 'Score', config: decisionCfg },
      { id: 'route', type: 'branch',   label: 'Route', config: { on: '{{score.output}}', cases } },
      { id: 'post',  type: 'deliver',  label: 'Post',  config: { channel: 'slack', target: '#ops' } },
      { id: 'drop',  type: 'deliver',  label: 'Drop',  config: { channel: 'in_app' } },
    ],
    edges: [
      { from: 'score', to: 'route' },
      { from: 'route', to: 'post' },
      { from: 'route', to: 'drop' },
    ],
  });

  test('POSITIVE: routing on a decision\'s output validates', () => {
    const res = validator.validate(routed(table(), [
      { when: 'P1', to: 'post' },
      { when: '*',  to: 'drop' },
    ]));
    assert.equal(res.ok, true, res.errors.map(e => e.code).join(', '));
  });

  test('a case naming a value the table cannot decide is rejected', () => {
    const res = validator.validate(routed(table(), [
      { when: 'P0', to: 'post' },     // the output enum is P1|P2|P3
      { when: '*',  to: 'drop' },
    ]));
    assert.ok(res.errors.some(e => e.code === 'BRANCH_CASE_NOT_IN_ENUM'),
      'we forced the domain closed precisely so membership would be decidable — not deciding it is a completeness claim nobody checked');
  });

  test('routing on a COLLECT table is rejected — it emits a LIST, so no case can match', () => {
    const res = validator.validate(routed(table({ hitPolicy: 'COLLECT' }), [
      { when: 'P1', to: 'post' },
      { when: '*',  to: 'drop' },
    ]));
    assert.ok(res.errors.some(e => e.code === 'LLM_INPUT_NOT_ENUM'),
      'a branch matches by exact value; against ["P1","P2"] nothing matches and the catch-all swallows every run');
  });
});

// ── 8. The engine: a decision's output is NOT the work product ──────────────

describe('a decision never becomes `lastOutput`', () => {
  test('THE DELIVERED BODY is the draft, not the audit record', async () => {
    // Assert the body that would be SENT. Anything between the decision and the
    // assertion (a transform that launders the value) would make this test pass
    // for the wrong reason — which is precisely how a "(pinned)" test in
    // Increment B pinned nothing.
    // `deliver` resolves the channel and THEN its handler, so a stub needs both.
    const sent = [];
    const channelRegistry = {
      get: (id) => ({ id, available: true }),
      getHandler: () => async (args) => { sent.push(args.body ?? args.text ?? args.content); return { delivered: true, ts: '1.0' }; },
    };
    const tester = new FlowTester({
      nodeTypes, channelRegistry,
      llm: { invoke: async () => ({ content: 'urgent' }) },
    });

    const def = {
      name: 'Deliver after decide', version: 2,
      triggers: [{ type: 'manual' }],
      nodes: [
        { id: 'draft', type: 'llm', label: 'Draft', config: { mode: 'freeform', prompt: 'draft it' } },
        { id: 'score', type: 'decision', label: 'Score', config: {
          inputs: [{ key: 'tone', type: 'enum', values: ['calm', 'urgent'], evaluator: 'llm' }],
          output: { key: 'priority', type: 'enum', values: ['P1', 'P3'] },
          hitPolicy: 'FIRST',
          rules: [{ when: { tone: 'urgent' }, then: 'P1' }, { when: { tone: '-' }, then: 'P3' }],
        } },
        { id: 'send', type: 'deliver', label: 'Send', config: { channel: 'in_app' } },
      ],
      edges: [{ from: 'draft', to: 'score' }, { from: 'score', to: 'send' }],
    };

    const events = [];
    for await (const e of tester.run(def, {})) events.push(e);

    assert.equal(events.some(e => e.type === 'run_failed'), false,
      events.find(e => e.type === 'run_failed')?.error ?? '');
    assert.equal(sent.length, 1);
    assert.equal(sent[0], 'urgent',
      'the LLM draft — NOT {"value":"P1","rule":{…}}. A decision is a control node: its output is routing and audit metadata, not the work product.');
  });

  test('AND AN AI STEP AFTER A DECISION SUMMARISES THE EMAIL, not the audit record', async () => {
    // The second guard, and it is a different one: `CONTROL_TYPES` governs what
    // `deliver` SENDS; `NON_CONTENT_TYPES` governs what an `llm` INGESTS. Drop
    // `decision` from the latter and the model is handed
    // {"value":"P1","rule":{…}} as the content to summarise — so it dutifully
    // summarises the classification of the email instead of the email.
    const prompts = [];
    const tester = new FlowTester({
      nodeTypes,
      llm: { invoke: async (msgs) => { prompts.push(String(msgs[1]?.content ?? '')); return { content: 'urgent' }; } },
    });
    const def = {
      name: 'Summarize after decide', version: 2,
      triggers: [{ type: 'manual' }],
      nodes: [
        { id: 'draft', type: 'llm', label: 'Draft', config: { mode: 'freeform', prompt: 'write the customer email' } },
        { id: 'score', type: 'decision', label: 'Score', config: {
          inputs: [{ key: 'tone', type: 'enum', values: ['calm', 'urgent'], evaluator: 'llm' }],
          output: { key: 'priority', type: 'enum', values: ['P1', 'P3'] },
          hitPolicy: 'FIRST',
          rules: [{ when: { tone: 'urgent' }, then: 'P1' }, { when: { tone: '-' }, then: 'P3' }],
        } },
        { id: 'brief', type: 'llm', label: 'Brief', config: { mode: 'summarize' } },
      ],
      edges: [{ from: 'draft', to: 'score' }, { from: 'score', to: 'brief' }],
    };
    const events = [];
    for await (const e of tester.run(def, {})) events.push(e);
    assert.equal(events.some(e => e.type === 'run_failed'), false,
      events.find(e => e.type === 'run_failed')?.error ?? '');

    const summarizePrompt = prompts.at(-1);
    // Assert on the DECIDED VALUE, not just the JSON shape. The audit record
    // stringifies through its `text` field, so a leaked decision arrives in the
    // prompt as the bare string "P1" rather than as {"value":"P1","rule":…} —
    // and a test that only looked for the JSON would pass while the model was
    // being handed the classification as content. The decision contributes
    // "P1" and nothing else; the draft contributes "urgent". Only "urgent"
    // belongs here.
    assert.equal(/P1|"rule"/.test(summarizePrompt), false,
      `the summarize step was handed the decision's answer as its content:\n${summarizePrompt}`);
    assert.match(summarizePrompt, /urgent/, 'it should be summarising the draft the decision routed');
  });

  test('the run log carries the decision, so the audit trail survives the run', async () => {
    const tester = new FlowTester({ nodeTypes, llm: { invoke: async () => ({ content: 'urgent' }) } });
    const def = {
      name: 'Decide', version: 2,
      triggers: [{ type: 'manual' }],
      nodes: [
        { id: 'draft', type: 'llm', label: 'D', config: { mode: 'freeform', prompt: 'x' } },
        { id: 'score', type: 'decision', label: 'Score', config: {
          inputs: [{ key: 'tone', type: 'enum', values: ['calm', 'urgent'], evaluator: 'llm' }],
          output: { key: 'priority', type: 'enum', values: ['P1', 'P3'] },
          hitPolicy: 'FIRST',
          rules: [{ when: { tone: 'urgent' }, then: 'P1' }, { when: { tone: '-' }, then: 'P3' }],
        } },
      ],
      edges: [{ from: 'draft', to: 'score' }],
    };
    const events = [];
    for await (const e of tester.run(def, {})) events.push(e);
    const step = events.find(e => e.type === 'step_completed' && e.nodeId === 'score');
    assert.match(String(step.output), /"value":"P1"/);
    assert.match(String(step.output), /"rule"/, 'which rule fired must reach the run log, or there is no audit trail');
  });
});

// ── 9. tableOf — one reader, so "what does this table say" has one answer ───

describe('tableOf', () => {
  test('reads the config shape (canonical)', () => {
    const t = tableOf({ config: table() });
    assert.equal(t.inputs.length, 2);
    assert.equal(t.hitPolicy, 'FIRST');
  });

  test('reads the node shape too — so the MOAT bites on a table publish will reject', () => {
    // Rejecting the shape and refusing to LOOK at it are different things. A
    // top-level table is un-runnable, but its AI-judged input is still a moat
    // violation, and the user must be told both.
    const t = tableOf({ ...table({ hitPolicy: 'UNIQUE' }), config: {} });
    assert.equal(t.inputs.length, 2);
    assert.equal(t.rules.length, 4);
    assert.equal(t.output.key, 'priority', 'every part of the table, not just the inputs');
    assert.equal(t.hitPolicy, 'UNIQUE', 'a UNIQUE table read as FIRST would never be checked for overlap');
  });

  test('a JSON-string OUTPUT parses too (the same textarea path as the rules)', () => {
    const t = tableOf({ config: { output: JSON.stringify({ key: 'p', type: 'enum', values: ['a', 'b'] }) } });
    assert.equal(t.output.key, 'p');
  });

  test('THE READER IS FAITHFUL: it does not drop the entries it dislikes', () => {
    // It used to filter out anything that wasn't a plain object with a key — which
    // quietly re-created C's defect #2 one layer up. decision-analysis.js opens
    // with a guard whose whole purpose is that a rule it cannot READ must never
    // look like a rule that covers EVERYTHING; a `null` stripped here never
    // reached that guard, and the analyser certified the coverage of a table with
    // one fewer rule than the author wrote. A keyless input vanished the same way.
    const t = tableOf({ config: {
      inputs: [{ type: 'number' }, { key: 'ok', type: 'number' }],
      rules:  [null, { when: { ok: '-' }, then: 'x' }],
    } });
    assert.equal(t.inputs.length, 2, 'a keyless input is a FACT ABOUT THE SPEC — reporting it is the validator\'s job, hiding it is nobody\'s');
    assert.equal(t.rules.length, 2);
  });

  test('a JSON-string table (the textarea path) parses', () => {
    const t = tableOf({ config: { inputs: JSON.stringify([{ key: 'a', type: 'number' }]), rules: JSON.stringify([{ when: {}, then: 'x' }]) } });
    assert.equal(t.inputs.length, 1);
    assert.equal(t.rules.length, 1);
  });

  test('HIT_POLICIES is the closed set the UI radio renders', () => {
    assert.deepEqual(HIT_POLICIES, ['UNIQUE', 'FIRST', 'COLLECT']);
  });
});
