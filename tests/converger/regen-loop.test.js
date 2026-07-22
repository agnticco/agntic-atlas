/**
 * A REBUILD THAT CHANGES NOTHING MUST NOT BUY ANOTHER ONE.
 *
 * `analyze` sends an incomplete spec back to `generate`, which is ONE Opus pass over
 * the whole workflow. Measured on a real 4-connector build: generate ran four times
 * — 300s + 304s + 102s + 160s — which was 92% of a 15.7-minute build, and the
 * defects still present at the end included the very one the rebuild path exists to
 * fix ("needs a sections list"). Three whole passes, three times the cost, no change.
 *
 * The rule: fingerprint the blocking gaps. An identical set after a rebuild means
 * the rebuild could not fix them, so stop and let `gaps` repair them (deterministic
 * and free). ANY change means progress, and the loop continues.
 *
 * This pins the KEY, which is where the rule lives. Get it wrong in either direction
 * and the damage is real: too loose and every build spins to its cap; too tight and a
 * converging build is cut off one pass early and ships a worse spec.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/converger/elicitation-graph.js');

/** The real fingerprint expression, lifted from source so it cannot drift. */
function keyer() {
  const src = readFileSync(SRC, 'utf8');
  const line = src.split('\n').find(l => l.includes('const blockerKey ='));
  assert.ok(line, 'the blocker fingerprint is gone from elicitation-graph.js — if it moved, re-point this test');
  // eslint-disable-next-line no-new-func
  return new Function('blockers', `${line.trim()}\nreturn blockerKey;`);
}

const gap = (code, nodeId) => ({ code, nodeId });

describe('the regenerate loop stops when a rebuild changes nothing', () => {
  test('the same blockers produce the same key — the loop is cut', () => {
    const k = keyer();
    const before = k([gap('MISSING_SECTIONS', 'compose_notes'), gap('UNSATISFIED_ASSERTION', 'airtable_row')]);
    const after  = k([gap('UNSATISFIED_ASSERTION', 'airtable_row'), gap('MISSING_SECTIONS', 'compose_notes')]);
    assert.equal(before, after, 'order must not matter — the same two defects are the same two defects');
    assert.ok(before.length, 'a non-empty blocker set must produce a non-empty key');
  });

  test('a FIXED blocker changes the key — the loop continues', () => {
    const k = keyer();
    const before = k([gap('MISSING_SECTIONS', 'compose_notes'), gap('UNSATISFIED_ASSERTION', 'airtable_row')]);
    const after  = k([gap('UNSATISFIED_ASSERTION', 'airtable_row')]);
    assert.notEqual(before, after, 'the rebuild fixed one defect — that is progress and must not be cut short');
  });

  test('the SAME code on a DIFFERENT step changes the key', () => {
    const k = keyer();
    assert.notEqual(
      k([gap('MISSING_SECTIONS', 'compose_notes')]),
      k([gap('MISSING_SECTIONS', 'compose_summary')]),
      'a defect that moved to another step is a different defect');
  });

  test('no blockers produces an empty key, which never triggers the cut', () => {
    const k = keyer();
    assert.equal(k([]), '', 'an empty key is falsy, so the guard cannot fire on a clean spec');
  });
});
