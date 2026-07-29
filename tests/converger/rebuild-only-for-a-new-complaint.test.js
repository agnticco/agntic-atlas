/**
 * A REBUILD IS ONLY WORTH PAYING FOR IF THE COMPLAINT IS NEW.
 *
 * WITNESSED ON PROD, 2026-07-29 (`build-platform-1785337840769`). The oracle could
 * not see where a Google Task was written (fixed separately — see
 * `write-destination-declared.test.js`), so it complained that a promised delivery
 * never happened. That ONE false fact was discovered independently by three
 * different nodes, each of which ordered its own whole-spec Opus rebuild:
 *
 *     pass 1  first_build                                          132s
 *     pass 2  blocking_gaps   "UNSATISFIED_ASSERTION"               72s
 *     pass 3  gap_answer      "promises tasks:My Tasks, but no …"   71s
 *     pass 4  verify_failed   "nothing reached My Tasks"            80s
 *             verify_failed   "nothing reached My Tasks"  ← identical, and only
 *                                stopped by the AGGREGATE cap, not by any guard
 *
 * 355 seconds of Opus and roughly $1.40 on a spec that was already correct.
 *
 * WHY NOTHING CAUGHT IT. Three "don't pay twice" fingerprints already existed —
 * `_lastShape`, `_lastBlockerKey`, `_lastMissingKey` — one per route, added one
 * incident at a time. Each compares a route only against ITSELF, so a fact that
 * moves BETWEEN routes is invisible to all three, and `verify_failed` had no
 * fingerprint at all. This is the rule-duplication defect applied to the guard
 * against rebuilds.
 *
 * The replacement is ONE gate at `generate`, the single place every route arrives,
 * keyed on `_regenReason`, the single thing every route already sets. The tests
 * that matter here are the ones that would fail if it were re-implemented per
 * route: cross-route matching, and A→B→A thrash.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { machineComplaint, alreadyRebuiltFor, sameComplaint } from '../../src/converger/elicitation-graph.js';

/**
 * The three rebuild orders prod actually issued — details verbatim from the event
 * log, `about` as each route now reports it. All three concern ONE promise.
 */
const PROD = {
  blocking: { route: 'blocking_gaps', detail: 'UNSATISFIED_ASSERTION:', about: ['tasks:My Tasks'] },
  gap:      { route: 'gap_answer',    about: ['tasks:My Tasks'],
              detail: 'The outcome promises "tasks:My Tasks" (record_exists), but no step in this '
                    + 'workflow does that — the request would be silently dropped.' },
  verify:   { route: 'verify_failed', about: ['tasks:My Tasks'],
              detail: 'nothing reached "My Tasks" in tasks — this run delivered to '
                    + '{{extract_email.subject}} (tasks), and nothing else' },
};
const c = (reason) => machineComplaint(reason);

describe('the prod sequence: the same fact, found by three different nodes', () => {
  test('NO TEXT MATCHER pairs these — which is why the promise is compared instead', () => {
    // The measurement behind the design. `sameComplaint` needs minShared:1 to pair
    // the gap and verify wordings, and at minShared:1 it pairs nearly everything.
    // Recorded here so nobody "simplifies" the gate back to comparing prose.
    assert.equal(sameComplaint(PROD.gap.detail, PROD.verify.detail), false);
    assert.equal(sameComplaint(PROD.blocking.detail, PROD.verify.detail), false);
  });

  test('but all three are about the same promise', () => {
    assert.equal(c(PROD.blocking).about, 'tasks:my tasks');
    assert.equal(c(PROD.gap).about, c(PROD.blocking).about);
    assert.equal(c(PROD.verify).about, c(PROD.blocking).about);
  });

  test('so the gap rebuild is refused after the blocking-gap one', () => {
    assert.equal(alreadyRebuiltFor(c(PROD.gap), [c(PROD.blocking)]), true);
  });

  test('and the verify rebuild is refused after either', () => {
    assert.equal(alreadyRebuiltFor(c(PROD.verify), [c(PROD.blocking)]), true);
    assert.equal(alreadyRebuiltFor(c(PROD.verify), [c(PROD.gap)]), true);
  });

  test('THE WHOLE PROD BUILD: four paid passes become two', () => {
    // Replays the exact sequence. `first_build` is never gated; the three that
    // followed all concern one promise, so exactly one of them is bought.
    const seen = [];
    let paid = 0;
    for (const reason of [{ route: 'first_build', detail: 'plan approved' },
                          PROD.blocking, PROD.gap, PROD.verify, PROD.verify]) {
      const complaint = c(reason);
      if (alreadyRebuiltFor(complaint, seen)) continue;
      paid += 1;
      if (complaint) seen.push(complaint);
    }
    assert.equal(paid, 2, 'prod paid for four');
  });

  test('the FIRST time a complaint appears it is always allowed', () => {
    // The gate must never stop the rebuild that might actually fix something.
    assert.equal(alreadyRebuiltFor(c(PROD.gap), []), false);
  });
});

describe('a genuinely different complaint still buys a pass', () => {
  test('a different promise is a different complaint', () => {
    // The sharpest case, and the one an over-eager gate gets wrong: two failures
    // whose sentences are near-identical and whose PROMISES differ.
    const other = { route: 'verify_failed', about: ['slack:#ops'],
                    detail: 'nothing reached "#ops" in slack — no step in this run attempted it' };
    assert.equal(alreadyRebuiltFor(c(other), [c(PROD.verify)]), false,
      'suppressing this would leave a real second defect unfixed');
  });

  test('a complaint about no promise at all is compared by wording', () => {
    const err = (d) => ({ route: 'verify_failed', detail: d });
    assert.equal(alreadyRebuiltFor(c(err('it errored: Airtable POST failed: NOT_AUTHORIZED')),
                                   [c(err('it errored: Airtable POST failed: NOT_AUTHORIZED'))]), true);
    assert.equal(alreadyRebuiltFor(c(err('it errored: Airtable POST failed: NOT_AUTHORIZED')),
                                   [c(err('the trigger has no filter, so this fires on every email'))]), false);
  });

  test('a promise-less complaint never matches a promise-bearing one', () => {
    // They are not comparable; treating them as equal would suppress on a
    // coincidence of wording.
    assert.equal(alreadyRebuiltFor(c({ route: 'sufficiency', detail: 'no step reaches My Tasks in tasks' }),
                                   [c(PROD.verify)]), false);
  });

  test('order and duplication in `about` do not change the answer', () => {
    const a = c({ route: 'verify_failed', detail: 'x', about: ['slack:#ops', 'tasks:My Tasks'] });
    const b = c({ route: 'gap_answer',    detail: 'y', about: ['tasks:my tasks', 'slack:#ops', 'slack:#ops'] });
    assert.equal(alreadyRebuiltFor(a, [b]), true);
  });
});

describe('a person is never refused', () => {
  test('a change someone asked for is not a machine complaint', () => {
    for (const route of ['user_change_request', 'ratify_feedback', 'ratify_rejected', 'decision_correction']) {
      assert.equal(machineComplaint({ route, detail: 'include who sent it in the task' }), null,
        `${route} carries a person's words — asking twice must try twice`);
    }
  });

  test('so asking for the same change twice is allowed', () => {
    const reason = { route: 'user_change_request', detail: 'include who sent it in the task' };
    assert.equal(alreadyRebuiltFor(machineComplaint(reason), [machineComplaint(reason)]), false);
  });

  test('the first build is never gated', () => {
    assert.equal(machineComplaint({ route: 'first_build', detail: 'plan approved' }), null);
  });

  test('the machine routes ARE gated', () => {
    for (const route of ['blocking_gaps', 'gap_answer', 'verify_failed', 'sufficiency']) {
      assert.equal(machineComplaint({ route, detail: PROD.verify.detail })?.text, PROD.verify.detail, route);
    }
  });

  test('a route that forgot to say why can never be gated', () => {
    // `unattributed` has no detail. A missing log label must not be able to refuse
    // someone's build — the gate has to fail open on silence.
    assert.equal(machineComplaint({ route: 'verify_failed', detail: '' }), null);
    assert.equal(machineComplaint({ route: 'verify_failed' }), null);
    assert.equal(machineComplaint(null), null);
    assert.equal(machineComplaint({}), null);
    assert.equal(alreadyRebuiltFor(null, [PROD.verify]), false);
  });
});

describe('A → B → A thrash is caught', () => {
  test('a complaint that returns after an intervening one is still refused', () => {
    // A rebuild that fixes one thing by breaking another alternates for ever. Matching
    // only against the PREVIOUS complaint — which is what every per-route fingerprint
    // does — cannot see this; matching against all of them can.
    const seen = [c(PROD.gap), c({ route: 'verify_failed', about: ['slack:#ops'], detail: 'nothing reached #ops' })];
    assert.equal(alreadyRebuiltFor(c(PROD.verify), seen), true);
  });
});

describe('the gate is wired at the choke point, not per route', () => {
  const SRC = readFileSync(new URL('../../src/converger/elicitation-graph.js', import.meta.url), 'utf8');
  const generate = (() => {
    const i = SRC.indexOf("graph.addNode('generate'");
    assert.ok(i > 0, '`generate` node is gone — re-point this test');
    const j = SRC.indexOf('graph.addNode(', i + 20);   // the whole node, not a window
    assert.ok(j > i, 'could not find the end of the `generate` node');
    return SRC.slice(i, j);
  })();

  test('it lives inside `generate`', () => {
    assert.match(generate, /alreadyRebuiltFor\(complaintNow, state\._regenComplaints\)/,
      'placed at any single route, it would guard only that route — the original defect');
  });

  test('a refused pass is still logged', () => {
    // A rebuild that silently never happened would be invisible in the very log
    // built to make rebuilds visible.
    assert.match(generate, /converger\.regen_refused/);
    const logAt = generate.indexOf('converger.generate_pass');
    const gateAt = generate.indexOf('alreadyRebuiltFor(complaintNow');
    assert.ok(logAt > 0 && gateAt > logAt, 'the gate must sit BELOW the pass log');
  });

  test('it only refuses a REbuild, never a first build', () => {
    assert.match(generate, /state\._generated && alreadyRebuiltFor\(/,
      'without `_generated` this would refuse the build that has not happened yet');
  });

  test('a refused pass leaves the build publishable, and says so', () => {
    const gate = generate.slice(generate.indexOf('alreadyRebuiltFor(complaintNow'));
    assert.match(gate.slice(0, 2200), /_buildCapped: true/,
      'it must use the EXISTING way out of the loop, not add a second');
    assert.match(gate.slice(0, 2200), /review it before going live/i);
  });

  test('the complaint is recorded where the pass is PAID for', () => {
    // Recorded at the requesting route instead, a refused pass would be remembered
    // as though it had been tried, and the next distinct complaint could be lost.
    assert.match(generate, /_regenComplaints: rememberComplaint\(state\._regenComplaints, complaintNow\)/);
  });
});

describe('the matcher is bounded and total', () => {
  test('nothing is remembered without a complaint', () => {
    assert.equal(alreadyRebuiltFor(null, [c(PROD.verify)]), false);
    assert.equal(alreadyRebuiltFor(c(PROD.verify), undefined), false);
    assert.equal(alreadyRebuiltFor(c(PROD.verify), [null, undefined]), false);
  });

  test('a blank `about` is not a promise', () => {
    // '' and '   ' must not all collapse to one key that matches everything.
    assert.equal(machineComplaint({ route: 'verify_failed', detail: 'x', about: ['', '  '] }).about, null);
  });
});

describe('the promise reaches the route as DATA, not as prose', () => {
  const VALIDATOR = readFileSync(new URL('../../src/workflows/workflow-validator.js', import.meta.url), 'utf8');
  const SCORER    = readFileSync(new URL('../../src/converger/gap-scorer.js', import.meta.url), 'utf8');

  test('the validator names the promise on the issue', () => {
    const at = VALIDATOR.indexOf("code: 'UNSATISFIED_ASSERTION'");
    assert.ok(at > 0);
    assert.match(VALIDATOR.slice(at, at + 700), /target: a\.target/,
      'without this the target is recoverable only by parsing an English sentence');
  });

  test('and the gap carries it through', () => {
    assert.match(SCORER, /target:\s+issue\.target \?\? null/,
      'dropped here, every gap route reports `about: []` and the gate silently degrades');
  });
});
