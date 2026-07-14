/**
 * decision-analysis — the completeness proof, attacked. (Test Adversary, P12-C.)
 *
 * The moat's claim is narrow and absolute: **this table is proven complete, or we
 * say we cannot prove it.** Two ways to break that, and both are worse than a
 * crash because they are silent:
 *
 *   1. CLAIM COVERAGE IT HAS NOT PROVEN — the user stops looking.
 *   2. INVENT A GAP THAT ISN'T THERE   — the user learns to ignore the questions,
 *      and then ignores the real one.
 *
 * The Builder's own tests exercise exactly three condition shapes: a bare enum
 * literal, `-`, and two numeric forms (`>50000`, `[10000..50000]`). The FEEL-A
 * grammar the module actually accepts is much wider — a bare numeric literal, a
 * comma disjunction, `not(...)`, open/closed interval bounds, ±Infinity cells,
 * boolean literals — and none of it was executed. The mutation sweep says so:
 * `if (iv)` → `if (true)` (decision-analysis.js:145) SURVIVED, which can only
 * happen if no test ever parses a bare number.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeTable, atomsFor, IRRELEVANT } from '../../src/workflows/decision-analysis.js';

const enumInput = (key, values) => ({ key, type: 'enum', values });
const numInput  = (key) => ({ key, type: 'number' });

/** Every uncovered box, flattened to a string, for `match`-style assertions. */
const gapText = (a) => JSON.stringify(a.uncovered);

// ── The FEEL-A grammar, one shape at a time ─────────────────────────────────
describe('numeric conditions: every accepted shape actually parses', () => {
  test('a BARE NUMERIC LITERAL is a point condition', () => {
    // `if (iv)` → `if (true)` survives unless something reaches the literal
    // branch below the interval branch. Nothing did.
    const a = analyzeTable({
      inputs: [numInput('n')],
      rules: [{ when: { n: '0' }, then: 'zero' }, { when: { n: '-' }, then: 'other' }],
      hitPolicy: 'UNIQUE',
    });
    assert.equal(a.decidable, true, `a bare number must parse; got: ${JSON.stringify(a.undecidable)}`);
    assert.deepEqual(a.uncovered, []);
    // The point rule and the catch-all both match n = 0 — a real UNIQUE overlap.
    assert.equal(a.overlaps.length, 1);
    assert.match(JSON.stringify(a.overlaps[0].where), /= 0/);
  });

  test('a COMMA DISJUNCTION on a number is a union of conditions', () => {
    const a = analyzeTable({
      inputs: [numInput('n')],
      rules: [{ when: { n: '<10,>50' }, then: 'edge' }],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, true);
    assert.ok(a.uncovered.length, 'the middle band [10..50] is decided by nothing');
    assert.match(gapText(a), /10/);
    assert.match(gapText(a), /50/);
  });

  test('not(...) on a number INVERTS the condition', () => {
    const a = analyzeTable({
      inputs: [numInput('n')],
      rules: [{ when: { n: 'not(<10)' }, then: 'big' }],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, true, `not(...) must parse; got: ${JSON.stringify(a.undecidable)}`);
    // not(<10) covers [10, ∞). What is left is (-∞, 10).
    assert.equal(a.uncovered.length, 1);
    assert.match(gapText(a), /< 10/);
  });

  test('not(<10) plus <10 covers the whole line (positive — no invented gap)', () => {
    const a = analyzeTable({
      inputs: [numInput('n')],
      rules: [{ when: { n: 'not(<10)' }, then: 'big' }, { when: { n: '<10' }, then: 'small' }],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, true);
    assert.deepEqual(a.uncovered, [], 'inventing a gap in an exhaustive table is as bad as missing one');
  });

  test('interval bounds are honoured: (10..50) EXCLUDES its endpoints', () => {
    const a = analyzeTable({
      inputs: [numInput('n')],
      rules: [
        { when: { n: '<10' },       then: 'lo' },
        { when: { n: '(10..50)' },  then: 'mid' },
        { when: { n: '>50' },       then: 'hi' },
      ],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, true);
    // The holes are the endpoints 10 and 50 themselves. An analyser that treated
    // `(` as `[` would report NO gap — and the workflow would silently do nothing
    // for a budget of exactly 10.
    assert.ok(a.uncovered.length, `the endpoints are decided by nothing; got ${gapText(a)}`);
    assert.match(gapText(a), /= 10/);
    assert.match(gapText(a), /= 50/);
  });

  test('…and [10..50] INCLUDES them (positive)', () => {
    const a = analyzeTable({
      inputs: [numInput('n')],
      rules: [
        { when: { n: '<10' },      then: 'lo' },
        { when: { n: '[10..50]' }, then: 'mid' },
        { when: { n: '>50' },      then: 'hi' },
      ],
      hitPolicy: 'FIRST',
    });
    assert.deepEqual(a.uncovered, []);
  });

  test('<= and >= carry their endpoint', () => {
    const a = analyzeTable({
      inputs: [numInput('n')],
      rules: [{ when: { n: '<=0' }, then: 'a' }, { when: { n: '>0' }, then: 'b' }],
      hitPolicy: 'FIRST',
    });
    assert.deepEqual(a.uncovered, [], '<=0 and >0 partition the line — there is no hole at 0');
  });

  test('negative and decimal endpoints parse', () => {
    const a = analyzeTable({
      inputs: [numInput('n')],
      rules: [{ when: { n: '<-1.5' }, then: 'a' }, { when: { n: '>=-1.5' }, then: 'b' }],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, true, `got: ${JSON.stringify(a.undecidable)}`);
    assert.deepEqual(a.uncovered, []);
  });

  test('a condition outside FEEL-A makes the input UNDECIDABLE — it is never guessed at', () => {
    const a = analyzeTable({
      inputs: [numInput('budget')],
      rules: [{ when: { budget: 'a lot' }, then: 'P1' }],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, false);
    assert.ok(a.undecidable.some(u => u.key === 'budget'),
      'an unreadable condition must be reported against the INPUT it sits on, so the user knows where to look');
    assert.deepEqual(a.uncovered, [], 'and no coverage claim — true or false — may be made about it');
  });
});

// ── Enum + boolean conditions ───────────────────────────────────────────────
describe('enum conditions', () => {
  const inputs = [enumInput('tier', ['free', 'pro', 'enterprise'])];

  test('not(...) on an enum is the complement (positive)', () => {
    const a = analyzeTable({ inputs, rules: [
      { when: { tier: 'not(free)' }, then: 'paid' },
      { when: { tier: 'free' },      then: 'free' },
    ], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, true, `not(free) must parse; got: ${JSON.stringify(a.badConditions)}`);
    assert.deepEqual(a.uncovered, [], 'not(free) + free is exhaustive');
  });

  test('not(...) alone leaves exactly the excluded value uncovered', () => {
    const a = analyzeTable({ inputs, rules: [{ when: { tier: 'not(free)' }, then: 'paid' }], hitPolicy: 'FIRST' });
    assert.equal(a.uncovered.length, 1);
    assert.match(gapText(a), /free/);
  });

  test('a comma disjunction covers each named value', () => {
    const a = analyzeTable({ inputs, rules: [{ when: { tier: 'free, pro' }, then: 'small' }], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, true);
    assert.equal(a.uncovered.length, 1);
    assert.match(gapText(a), /enterprise/);
  });

  test('a literal the enum never declared is a BAD CONDITION, not a shrunk covered set', () => {
    // The dangerous alternative: quietly cover nothing and report a gap the
    // author cannot explain. A rule the analyser cannot read is a rule whose
    // coverage nobody has proven — say that, don't paper over it.
    const a = analyzeTable({ inputs, rules: [{ when: { tier: 'platinum' }, then: '?' }], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, false);
    assert.deepEqual(a.badConditions, [{ rule: 0, key: 'tier', condition: 'platinum' }]);
    assert.deepEqual(a.uncovered, []);
  });

  test('not(<undeclared value>) is a bad condition too', () => {
    const a = analyzeTable({ inputs, rules: [{ when: { tier: 'not(platinum)' }, then: '?' }], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, false);
    assert.equal(a.badConditions.length, 1);
  });

  test('an enum with fewer than two values decides nothing', () => {
    assert.equal(atomsFor(enumInput('tier', ['free'])).decidable, false);
    assert.equal(atomsFor(enumInput('tier', [])).decidable, false);
    assert.equal(atomsFor(enumInput('tier', ['free', 'pro'])).decidable, true, 'positive: two values ARE decidable');
  });

  test('enum atoms are de-duplicated and stringified', () => {
    const { atoms } = atomsFor(enumInput('tier', ['free', 'free', 'pro']));
    assert.deepEqual(atoms, ['free', 'pro']);
  });
});

describe('boolean conditions', () => {
  const inputs = [{ key: 'urgent', type: 'boolean' }];

  test('true / false partition the domain (positive)', () => {
    const a = analyzeTable({ inputs, rules: [
      { when: { urgent: 'true' },  then: 'page' },
      { when: { urgent: 'false' }, then: 'queue' },
    ], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, true);
    assert.deepEqual(a.uncovered, []);
  });

  test('the literal is case-insensitive — "TRUE" is true', () => {
    const a = analyzeTable({ inputs, rules: [
      { when: { urgent: 'TRUE' },  then: 'page' },
      { when: { urgent: 'False' }, then: 'queue' },
    ], hitPolicy: 'FIRST' });
    assert.deepEqual(a.badConditions, [], 'a capitalised boolean is still a boolean');
    assert.deepEqual(a.uncovered, []);
  });

  test('only `true` is covered → `false` is the hole', () => {
    const a = analyzeTable({ inputs, rules: [{ when: { urgent: 'true' }, then: 'page' }], hitPolicy: 'FIRST' });
    assert.equal(a.uncovered.length, 1);
    assert.match(gapText(a), /false/);
  });

  test('anything other than true/false is a bad condition', () => {
    const a = analyzeTable({ inputs, rules: [{ when: { urgent: 'yes' }, then: 'page' }], hitPolicy: 'FIRST' });
    assert.equal(a.decidable, false);
    assert.equal(a.badConditions.length, 1);
    assert.equal(a.badConditions[0].condition, 'yes');
  });

  test('boolean atoms are exactly [true, false]', () => {
    assert.deepEqual(atomsFor({ key: 'b', type: 'boolean' }), { decidable: true, atoms: [true, false] });
  });
});

// ── The undecidable frontier ────────────────────────────────────────────────
describe('what cannot be proven is REFUSED, never faked', () => {
  test('a table with NO inputs decides nothing', () => {
    const a = analyzeTable({ inputs: [], rules: [{ when: {}, then: 'x' }] });
    assert.equal(a.decidable, false);
    assert.deepEqual(a.uncovered, [], 'a table with no inputs must not report "fully covered"');
    assert.match(a.undecidable[0].reason, /no inputs/);
  });

  test('an input with no `key` is not an input', () => {
    const a = analyzeTable({ inputs: [{ type: 'enum', values: ['a', 'b'] }], rules: [] });
    assert.equal(a.decidable, false, 'a keyless input is dropped, which leaves no inputs at all');
  });

  test('an input with no declared type is undecidable, and says so', () => {
    const a = atomsFor({ key: 'x' });
    assert.equal(a.decidable, false);
    assert.match(a.reason, /no type|unknown/);
  });

  test('a string domain is undecidable — the single most important refusal in the file', () => {
    const a = atomsFor({ key: 's', type: 'string' });
    assert.equal(a.decidable, false);
    assert.match(a.reason, /unbounded/);
  });

  test('a table too complex to analyse ABORTS rather than half-analysing', () => {
    // The box-subtraction guard. Without it a pathological table would grind for
    // minutes and then hand back a partial answer wearing a proof's clothing.
    const a = analyzeTable({
      inputs: [enumInput('a', ['1', '2', '3']), enumInput('b', ['1', '2', '3']), enumInput('c', ['1', '2', '3'])],
      rules: [
        { when: { a: '1', b: '1', c: '1' }, then: 'x' },
        { when: { a: '2', b: '2', c: '2' }, then: 'y' },
        { when: { a: '3', b: '3', c: '3' }, then: 'z' },
      ],
      hitPolicy: 'FIRST',
    }, { maxBoxes: 2 });
    assert.equal(a.decidable, false);
    assert.match(a.undecidable.at(-1).reason, /too complex/);
    assert.deepEqual(a.uncovered, [], 'an aborted analysis makes NO coverage claim');
  });

  test('the same table under the default box budget IS analysed (positive)', () => {
    const a = analyzeTable({
      inputs: [enumInput('a', ['1', '2', '3']), enumInput('b', ['1', '2', '3']), enumInput('c', ['1', '2', '3'])],
      rules: [
        { when: { a: '1', b: '1', c: '1' }, then: 'x' },
        { when: { a: '2', b: '2', c: '2' }, then: 'y' },
        { when: { a: '3', b: '3', c: '3' }, then: 'z' },
      ],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.decidable, true, 'the abort must be a real budget, not a permanent refusal');
    assert.ok(a.uncovered.length, '24 of the 27 combinations are decided by nothing');
  });
});

// ── Reporting limits ────────────────────────────────────────────────────────
describe('gaps beyond the reporting limit are COUNTED, never dropped', () => {
  test('truncated says how many were not listed', () => {
    const a = analyzeTable({
      inputs: [enumInput('tier', ['a', 'b', 'c', 'd'])],
      rules: [],
      hitPolicy: 'FIRST',
    }, { maxReported: 0 });
    assert.deepEqual(a.uncovered, []);
    assert.equal(a.truncated, 1, 'a gap we chose not to print is still a gap, and the count must survive');
  });

  test('under the limit, truncated is 0 (positive)', () => {
    const a = analyzeTable({
      inputs: [enumInput('tier', ['a', 'b'])],
      rules: [{ when: { tier: 'a' }, then: 'x' }],
      hitPolicy: 'FIRST',
    });
    assert.equal(a.truncated, 0);
    assert.equal(a.uncovered.length, 1);
  });
});

// ── hitPolicy ───────────────────────────────────────────────────────────────
describe('hit policy', () => {
  const table = (hitPolicy) => ({
    inputs: [enumInput('tier', ['free', 'pro'])],
    rules: [{ when: { tier: IRRELEVANT }, then: 'a' }, { when: { tier: 'pro' }, then: 'b' }],
    hitPolicy,
  });

  test('UNIQUE reports the overlap', () => {
    assert.equal(analyzeTable(table('UNIQUE')).overlaps.length, 1);
  });
  test('the abbreviation "U" means UNIQUE too', () => {
    assert.equal(analyzeTable(table('U')).overlaps.length, 1);
  });
  test('lower-case "unique" means UNIQUE too', () => {
    assert.equal(analyzeTable(table('unique')).overlaps.length, 1);
  });
  test('FIRST reports none — order resolves it (positive)', () => {
    assert.deepEqual(analyzeTable(table('FIRST')).overlaps, []);
  });
  test('an ABSENT hit policy defaults to FIRST, not UNIQUE', () => {
    assert.deepEqual(analyzeTable(table(undefined)).overlaps, [],
      'defaulting an unstated policy to UNIQUE would flag a false error on every ordinary table');
  });
  test('an overlap names WHERE the two rules collide, not just that they do', () => {
    const o = analyzeTable(table('UNIQUE')).overlaps[0];
    assert.deepEqual(o.rules, [0, 1]);
    assert.deepEqual(o.where, { tier: 'pro' });
  });
});

// ── The catch-all ───────────────────────────────────────────────────────────
describe('hasCatchAll', () => {
  const inputs = [enumInput('tier', ['free', 'pro']), { key: 'urgent', type: 'boolean' }];

  test('a rule with every input "-" is the catch-all', () => {
    const a = analyzeTable({ inputs, rules: [{ when: { tier: '-', urgent: '-' }, then: 'x' }] });
    assert.equal(a.hasCatchAll, true);
  });
  test('a rule with an OMITTED input is also a catch-all — absent means "don\'t care"', () => {
    const a = analyzeTable({ inputs, rules: [{ when: {}, then: 'x' }] });
    assert.equal(a.hasCatchAll, true);
    assert.deepEqual(a.uncovered, []);
  });
  test('a rule that constrains ANY input is not a catch-all (positive)', () => {
    const a = analyzeTable({ inputs, rules: [{ when: { tier: '-', urgent: 'true' }, then: 'x' }] });
    assert.equal(a.hasCatchAll, false,
      'calling a partial rule a catch-all would let an unanticipated input fall through silently');
  });
});
