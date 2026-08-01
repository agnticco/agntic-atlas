/**
 * A ROUTER NEEDS A SAMPLE PER ROUTE, AND THE PATHS ARE ONLY KNOWN LATE.
 *
 * QA Manager re-measurement, 2026-07-22. A user answered nothing, accepted every
 * default, and got a CORRECT three-lane workflow — which could then never reach Go
 * live. One worked example cannot cover four paths, so the panel refused to certify
 * (correctly) and told them to write test cases by hand. That is exactly the typing
 * the zero-typing path exists to remove.
 *
 * The cause is ordering, not judgement: the example generator runs BEFORE the
 * workflow is built, so it proposes cases blind and cannot know the workflow routes.
 * By the time `verify` runs, the spec is assembled and the lanes are knowable — so
 * that is where the samples are topped up, one aimed at each path.
 *
 * WHAT THESE PIN:
 *  - the top-up only happens when there are FEWER samples than paths (a workflow
 *    that does not branch must not pay for a model call it does not need);
 *  - the prompt NAMES each path, because an untargeted extra sample is as likely to
 *    retread a covered lane as to reach a new one;
 *  - ids cannot collide with the existing samples — `checkOutcome` keys by index
 *    precisely because a colliding key silently DROPS an entry, and a dropped sample
 *    is a path reported as tested that never ran;
 *  - a failed top-up is never fatal — it falls through to today's behaviour;
 *  - and the one that would undo all of it: EVERY return from `verify` must carry
 *    the draft. It carried none, so the samples we just paid for were discarded and
 *    the panel got the same single case as before.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildLaneExamplesPrompt } from '../../src/converger/prompts.js';
import { laneInventoryOf } from '../../src/workflows/outcome-oracle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRAPH = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

/** Just the `verify` node's source. */
function verifySource() {
  const start = GRAPH.indexOf("graph.addNode('verify'");
  const end   = GRAPH.indexOf('graph.addNode(', start + 10);
  assert.ok(start > 0 && end > start, 'the verify node moved — re-point this test, do not delete it');
  return GRAPH.slice(start, end);
}

const THREE_LANE = {
  nodes: [
    { id: 'classify', type: 'llm', label: 'C',
      config: { mode: 'classify', prompt: 'x', categories: ['urgent', 'routine', 'junk'] } },
    { id: 'route', type: 'branch', label: 'R',
      config: { on: '{{classify.output}}', cases: [
        { when: 'urgent', to: 'a' }, { when: 'routine', to: 'b' }, { when: '*', to: 'c' }] } },
    { id: 'a', type: 'deliver', label: 'Urgent', config: { channel: 'in_app', subject: 'U' } },
    { id: 'b', type: 'deliver', label: 'Routine', config: { channel: 'in_app', subject: 'R' } },
    { id: 'c', type: 'assemble', label: 'Stop', config: { title: 'x', sections: '[]' } },
  ],
  edges: [{ from: 'classify', to: 'route' }, { from: 'route', to: 'a' },
          { from: 'route', to: 'b' }, { from: 'route', to: 'c' }],
};

describe('the prompt asks for one sample per path', () => {
  const lanes = laneInventoryOf(THREE_LANE);

  test('the workflow really does have three paths to cover', () => {
    assert.equal(lanes.length, 3, 'if this changes, the fixture — not the rule — is what moved');
  });

  test('every path is named in the request', () => {
    const p = buildLaneExamplesPrompt({ intent: 'triage email', outcome: { statement: 'x' },
                                        triggers: [{ type: 'email' }], lanes });
    for (const l of lanes) {
      assert.ok(p.includes(l.label),
        `path "${l.label}" is not named — an untargeted extra sample is as likely to retread a covered lane`);
    }
  });

  test('it carries the trigger\'s own event shape, so the first step gets real input', () => {
    const p = buildLaneExamplesPrompt({ intent: 'x', outcome: {}, triggers: [{ type: 'email' }], lanes });
    assert.match(p, /"subject"/, 'an email-triggered workflow handed a {scenario:…} blob fires its own missing-data guard');
  });

  test('samples the user already has are listed as not-to-repeat', () => {
    const p = buildLaneExamplesPrompt({ intent: 'x', outcome: {}, triggers: [{ type: 'email' }], lanes,
                                        existing: [{ label: 'An urgent outage mail', given: {} }] });
    assert.match(p, /do not repeat/i);
    assert.match(p, /An urgent outage mail/);
  });
});

describe('when the top-up runs, and what it must not break', () => {
  const src = verifySource();

  test('only when some path has nobody aimed at it', () => {
    /**
     * RE-POINTED 2026-07-31, and the invariant it used to state was WRONG.
     *
     * This asserted `lanes.length <= have.length` — "enough samples ⇒ no model call" —
     * two COUNTS. Witnessed on prod (`build-platform-1785513701920`): TWO paths, THREE
     * samples, all three aimed at the SAME path, logged `enough_samples_already`, and
     * the other path was left unproved. The workflow could not go live and the person
     * was asked to write a test case by hand — the typing this top-up exists to remove.
     *
     * The real invariant, kept: a workflow that needs no top-up must not pay for a
     * model call. What changed is how "needs" is decided — by path coverage, not by
     * arithmetic on two totals.
     *
     * NOTE this asserts the GATE EXPRESSION, not the words: the old text still appears
     * in the comment above the gate explaining why it was wrong, so a looser search
     * would pass against the very code it is meant to forbid.
     */
    assert.match(src, /:\s*!openLanes\.length\s+\?\s*'every_path_already_claimed'/,
      'a workflow with every path already claimed must not pay for a model call it does not need');
    assert.doesNotMatch(src, /\?\s*'enough_samples_already'/,
      'the count-based skip is back — samples piled on one path will skip the top-up again');
  });

  test('a skipped top-up says WHY it was skipped', () => {
    // Measured on a `classify→route` build (2026-07-28): the top-up correctly did not
    // run, and established that took a database query, because only the failure
    // branches logged and the GATE did not. "Correctly skipped" and "silently did
    // nothing" must not look identical — a loop whose observations need a database
    // query is not observable.
    const i = src.indexOf('const skipReason');
    assert.ok(i > 0, 'the gate must name its reason');
    const around = src.slice(i, i + 900);
    for (const reason of ['no_dry_runner', 'no_contract_to_prove', 'every_path_already_claimed']) {
      assert.match(around, new RegExp(reason), `the skip reason ${reason} must be distinguishable`);
    }
    assert.match(around, /lane_examples_skipped/);
  });

  test('the extra samples get fresh, non-colliding ids', () => {
    assert.match(src, /id: `lane_\$\{i \+ 1\}`/,
      'a colliding id is silently DROPPED by checkOutcome — a path reported as tested that never ran');
  });

  test('a failed top-up falls through instead of failing the build', () => {
    // Anchored to the whole node rather than a byte window: the window was 900/2600
    // characters wide and the node grew past it on 2026-07-31, so the assertion started
    // failing over formatting rather than behaviour.
    const around = src;
    // The invariant is that the top-up is CAUGHT, not that the catch is parameterless.
    // It became `catch (err)` on 2026-07-28 so the failure can be logged — see below.
    assert.match(around, /catch\s*(\([^)]*\)\s*)?\{/,
      'a build must never die because an extra sample could not be drafted');
  });

  test('a top-up that adds nothing says so, instead of vanishing', () => {
    // Witnessed on prod 2026-07-28: `verify` ran for 19.2s and a five-path workflow
    // still reached the test panel with ONE example, with nothing in the log to say
    // why — the catch was bare and the "returned zero" path did not exist at all.
    // A run that proves nothing about four of five paths must never be silent.
    const around = src;
    assert.match(around, /lane_examples_empty/, 'a zero-example top-up must be recorded');
    assert.match(around, /lane_examples_failed/, 'a thrown top-up must be recorded');
  });

  test('EVERY return from verify carries the draft', () => {
    // The defect this would reintroduce is silent: the samples are generated, paid
    // for, and then dropped on the way out, so the panel shows the same single case
    // and nothing anywhere reports a problem.
    const returns = src.match(/return \{/g) ?? [];
    const carrying = src.match(/\.\.\.carryDraft/g) ?? [];
    assert.ok(returns.length > 0);
    assert.equal(carrying.length, returns.length,
      `${returns.length} returns but ${carrying.length} carry the draft — any that does not silently discards the samples`);
  });

  test('the run uses the topped-up draft, not the one that arrived', () => {
    assert.match(src, /let\s+draft\s+=\s+state\.draft/,
      'a const draft here means the spec is assembled from the pre-top-up examples');
  });
});
