/**
 * THE GENERATOR IS TOLD HOW TO BUILD PER-ITEM WORK, NOT ONLY WHAT IT MAY NOT DO.
 *
 * WITNESSED ON PROD, 2026-07-29. "Every weekday at 5pm, sort each unread email
 * into needs-reply or FYI and post a summary of the needs-reply ones" took FIVE
 * generate passes and 5m24s, and only stopped because the regenerate cap ran out.
 * Every rebuild was the sufficiency critic saying the same thing in new words:
 * "the workflow classifies the entire batch as a single unit, but the intent
 * requires classifying EACH email individually".
 *
 * IT WAS NOT A MODEL FAILURE. The prompt told it branches, human steps, decisions
 * and nested loops are all banned inside a `foreach` — true, all four are hard
 * validator errors — and said nothing about how per-item work IS built. So the
 * model reasoned, in its own visible words, "foreach loops can't contain branches
 * or routing decisions… which seems at odds with a single batch classify node",
 * concluded per-item classification was unbuildable, and fell back to judging the
 * whole batch. The critic rejected that, correctly, and the two could not meet.
 *
 * The answer was already written down — in the VALIDATOR's hint, where the
 * generator never sees it: "Branch outside the loop, on a value the loop
 * produced." This puts the assembled shape in front of the model instead.
 *
 * These pin the FACTS the pattern rests on, against the engine itself, so the
 * instructions cannot quietly start describing a workflow that will not validate.
 * Whether the model then follows them is a belief no test can prove — the live
 * re-run is the evidence for that, and it is recorded in the commit.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { foreachNodeType } from '../../src/workflows/node-types/foreach.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROMPTS = readFileSync(path.join(ROOT, 'src/converger/prompts.js'), 'utf8');

/** The `foreach` section of the node-type briefing. */
const SECTION = (() => {
  const i = PROMPTS.indexOf('- foreach:');
  assert.ok(i > 0, 'the foreach briefing moved — re-point this test');
  const j = PROMPTS.indexOf('- branch:', i);
  assert.ok(j > i, 'the branch briefing should follow it');
  return PROMPTS.slice(i, j);
})();

describe('the positive pattern is present', () => {
  test('it names the ask in the words a user would use', () => {
    assert.match(SECTION, /GO THROUGH EACH X AND ACT ON SOME OF THEM/,
      'the model has to recognise the ask to reach for the pattern');
  });

  test('the per-item judgement happens INSIDE the loop', () => {
    assert.match(SECTION, /foreach over it\. INSIDE, do the per-item judgement/);
  });

  test('the routing happens AFTER it, on one value', () => {
    assert.match(SECTION, /AFTER the loop, ONE step reads \{\{loopId\.output\}\}/);
    assert.match(SECTION, /SINGLE routing value/);
    assert.match(SECTION, /branch on THAT step — with its mandatory catch-all/);
  });

  test('and it names the wrong turn the model actually took', () => {
    // Without this it is a pattern among patterns. The model did not miss the
    // pattern; it reasoned its way to a batch step and needs that contradicted.
    assert.match(SECTION, /DO NOT fall back to judging the whole batch in ONE step/);
    assert.match(SECTION, /That conclusion is wrong/);
  });
});

describe('the pattern describes a workflow that actually validates', () => {
  // A prompt that confidently describes an unbuildable shape is worse than the
  // silence it replaced, so each claim is checked against the engine.

  const forEachWith = (steps) => foreachNodeType.validate({
    id: 'loop', label: 'For each email', config: { over: 'search.output', steps },
  }) || [];

  test('an llm step per item is allowed — step 2 of the pattern', () => {
    const issues = forEachWith([{ id: 'judge', type: 'llm', config: { mode: 'classify' } }]);
    assert.deepEqual(issues.filter(i => i.severity === 'error'), [],
      'the pattern puts the per-item judgement here — it must be legal');
  });

  test('a branch inside the loop is refused — which is WHY the pattern exists', () => {
    const codes = forEachWith([
      { id: 'judge', type: 'llm', config: { mode: 'classify' } },
      { id: 'route', type: 'branch', config: { on: 'judge.output', cases: [] } },
    ]).map(i => i.code);
    assert.ok(codes.includes('BRANCH_IN_FOREACH'),
      'if this ever becomes legal, the pattern should be simplified, not left standing');
  });

  test('so are the other three the prompt bans', () => {
    for (const [type, code] of [['human', 'HUMAN_IN_FOREACH'], ['decision', 'DECISION_IN_FOREACH'],
                                ['foreach', 'NESTED_FOREACH']]) {
      const codes = forEachWith([{ id: 'x', type, config: {} }]).map(i => i.code);
      assert.ok(codes.includes(code), `the prompt claims ${type} is banned in a loop`);
    }
  });

  test('the loop really does expose per-item results downstream', () => {
    // Steps 3 and 5 both read `{{loopId.output}}`. If a loop did not carry the
    // per-item outputs forward, the whole pattern would be fiction.
    const src = readFileSync(path.join(ROOT, 'src/workflows/node-types/foreach.js'), 'utf8');
    const i = src.indexOf('    return {');
    assert.ok(i > 0, 'the foreach run() return moved — re-point this test');
    const shape = src.slice(i, i + 200);
    for (const field of ['count', 'total', 'truncated', 'skipped', 'results']) {
      assert.match(shape, new RegExp('\\b' + field + '\\b'),
        `the prompt tells the model a loop outputs \`${field}\``);
    }
    assert.match(SECTION, /\{ count, total, truncated, skipped, results \}/,
      'the documented shape must match the one the engine returns');
  });

  test('the prompt still states the bans it is working around', () => {
    // The pattern is the way THROUGH the rules, not a replacement for them.
    assert.match(SECTION, /NO branch, NO human, NO decision and NO nested foreach inside a loop/);
  });
});
