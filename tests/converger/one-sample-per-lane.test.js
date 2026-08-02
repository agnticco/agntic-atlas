/**
 * ONE SAMPLE PER LANE — NOT THREE PER WORKFLOW.
 *
 * Charles, 2026-08-02: *"Why do we need 3 samples in the first place? We could simply
 * just have one sample workflow run to prove it is possible … I trust the LLM to adapt
 * in various scenarios, the wiring and results is simply what needs testing."*
 *
 * His numbers. A LINEAR five-step briefing workflow — zero branches — was tested with
 * three samples: "Monday with 3+ trending stories", "Wednesday with fewer than 3",
 * "Saturday should not trigger". Two of those are model-BEHAVIOUR variations over
 * identical wiring. Each cost ~60–90s, run sequentially, to prove the same path three
 * times — and each is one more minute-long connection to drop (see
 * `a-sample-we-could-not-run.test.js` for what a dropped one used to do).
 *
 * THE ONE CARVE-OUT is his own criterion applied honestly: **a different lane is
 * different wiring.** A three-way classifier certified on one sample that took the
 * do-nothing lane is a defect this repo has shipped (F16), and lane coverage still
 * blocks certification. So: one per lane, and a linear workflow has exactly one lane.
 *
 * WHY IT WAS THREE: `examples` runs at STEP 2, before the workflow exists, and asks a
 * model for "concrete example cases". Nothing capped what it offered against the wiring
 * that later got built — the same ordering flaw as the promise written at step 0.
 *
 * WHAT THIS FILE MOSTLY PINS is the floor, not the cap: trimming samples is one step
 * from testing nothing, so the cases that must NOT be trimmed outnumber the one that is.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

/**
 * The trim runs inside the `verify` node, which closes over the LLM, the graph state and
 * `interrupt`, so it cannot be lifted and executed. The RULE, however, is a pure
 * expression over a list — so it is re-derived here from the source's own shape and
 * exercised, and the wiring is pinned separately at source level below. Said plainly
 * because that is weaker than executing the real thing: if `verify` is ever made
 * extractable, replace this with the real call.
 */
function trim(all, laneCount) {
  const want = Math.max(1, laneCount);
  if (all.length <= want) return all;
  const claimed = [], rest = [], seen = new Set();
  for (const e of all) {
    const lane = String(e?.lane ?? '').trim().toLowerCase();
    if (lane && !seen.has(lane)) { seen.add(lane); claimed.push(e); } else rest.push(e);
  }
  return [...claimed, ...rest].slice(0, Math.max(want, claimed.length));
}

const ex = (id, lane) => ({ id, given: { subject: id }, ...(lane ? { lane } : {}) });

describe('a linear workflow is proved once', () => {
  test('three scenario variations over one lane become one sample', () => {
    const kept = trim([ex('mon'), ex('wed'), ex('sat')], 1);
    assert.equal(kept.length, 1,
      'the same wiring tested three times proves it once and costs three minutes');
  });

  test('and the sample kept is a real one', () => {
    const kept = trim([ex('mon'), ex('wed')], 1);
    assert.ok(kept[0] && kept[0].given, 'a sample with no input can prove nothing');
  });
});

describe('a workflow that ROUTES keeps one per lane', () => {
  test('three lanes keep three samples', () => {
    const kept = trim([ex('a', 'urgent'), ex('b', 'billing'), ex('c', 'other'), ex('d')], 3);
    assert.equal(kept.length, 3);
  });

  test('the lane-CLAIMING samples are the ones kept', () => {
    // A claim is the only evidence of what a sample covers. Dropping a claimed sample in
    // favour of an unclaimed one would leave a lane unproved — and lane coverage then
    // correctly refuses to certify, which is the loop this trim must never create.
    const kept = trim([ex('plain1'), ex('plain2'), ex('urgent', 'urgent'), ex('quiet', 'quiet')], 2);
    const ids = kept.map(k => k.id);
    assert.ok(ids.includes('urgent') && ids.includes('quiet'),
      'kept ' + JSON.stringify(ids) + ' — a claimed lane must outrank an unclaimed sample');
  });

  test('more claimed lanes than the count still all survive', () => {
    // The floor is never below what the lanes need, whatever the count says.
    const kept = trim([ex('a', 'x'), ex('b', 'y'), ex('c', 'z')], 1);
    assert.equal(kept.length, 3, 'a claimed lane is never dropped to hit a smaller cap');
  });
});

describe('it never trims to nothing', () => {
  test('a single sample is left alone', () => {
    assert.equal(trim([ex('only')], 1).length, 1);
  });

  test('no samples stays no samples — nothing is invented', () => {
    assert.deepEqual(trim([], 1), []);
  });

  test('a zero lane count still leaves one sample', () => {
    assert.equal(trim([ex('a'), ex('b')], 0).length, 1,
      'a workflow with nothing to prove must still be provable');
  });
});

describe('the trim is actually wired into the build', () => {
  // SOURCE-level, and weaker than the rest of this file — see the note on `trim` above.
  test('it runs in verify, against the assembled spec\'s lanes', () => {
    assert.match(SRC, /laneInventoryOf\(assembleSpec\(draft\)\)\.length/,
      'the cap must come from the WIRING, not from a number');
  });

  test('and it happens AFTER the per-lane top-up, not before', () => {
    const topUp = SRC.indexOf('converger.lane_examples');
    const trimAt = SRC.indexOf('converger.samples_trimmed');
    assert.ok(topUp > 0 && trimAt > topUp,
      'trimming before the top-up would drop a lane the top-up was about to cover');
  });

  test('a trim is recorded, never silent', () => {
    assert.match(SRC, /converger\.samples_trimmed[\s\S]{0,160}from:[\s\S]{0,40}to:/,
      'silently testing less than was prepared is the shape this repo calls "no silent caps"');
  });
});
