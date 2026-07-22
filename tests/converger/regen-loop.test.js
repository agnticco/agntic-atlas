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

/**
 * A BLOCKER THAT SURVIVED A REBUILD GOES TO THE CONVERSATION, NOT TO ANOTHER REBUILD.
 *
 * Some blockers are about the world, not the wiring — a column that doesn't exist, a
 * base the tenant doesn't have — and no amount of rewriting resolves them. The
 * converger already knew this for two resource codes; the property is general, and the
 * cheap way to detect it is to OBSERVE rather than guess: give a blocker one rebuild,
 * and if it is still there, ask the user instead of buying another Opus pass.
 *
 * Live cost of not doing this: the outcome promised a `Notes` column while the model
 * believed the table had `Message`. It wrote Notes (rejected), then Message (rejected),
 * then Notes again — 425s + 237s of rebuilds oscillating between two spellings, when
 * the question "add a Notes column, or use Message?" is one sentence and one click.
 */
describe('a blocker that a rebuild could not fix is taken to the user', () => {
  const survivorsOf = (() => {
    const src = readFileSync(SRC, 'utf8');
    const a = src.indexOf('const priorKeys = new Set(');
    const b = src.indexOf('if (state._generated && survivors.length)');
    assert.ok(a > 0 && b > a, 'the survivor rule is gone from elicitation-graph.js — re-point this test, do not delete it');
    const body = src.slice(a, b);
    // eslint-disable-next-line no-new-func
    return new Function('state', 'blockers', `${body}\nreturn survivors;`);
  })();

  const gap = (code, nodeId) => ({ code, nodeId });
  const keyOf = (gs) => gs.map(g => `${g.code}:${g.nodeId ?? ''}`).sort().join('|');

  test('a blocker present before AND after the rebuild is a survivor', () => {
    const before = [gap('UNSATISFIED_ASSERTION', 'airtable_row')];
    const now    = [gap('UNSATISFIED_ASSERTION', 'airtable_row')];
    assert.equal(survivorsOf({ _lastBlockerKey: keyOf(before) }, now).length, 1);
  });

  test('a blocker the rebuild FIXED is not a survivor — the loop keeps its value', () => {
    const before = [gap('DELIVER_NO_INPUT', 'send'), gap('MISSING_NAME', '')];
    const now    = [gap('MISSING_NAME', '')];   // one closed, one new-ish
    const s = survivorsOf({ _lastBlockerKey: keyOf(before) }, now);
    assert.deepEqual(s.map(g => g.code), ['MISSING_NAME'],
      'only the one that persisted counts — a rebuild that closed a blocker has earned its next pass');
  });

  test('a brand-new blocker is never a survivor (nothing has been tried on it yet)', () => {
    const before = [gap('DELIVER_NO_INPUT', 'send')];
    const now    = [gap('UNKNOWN_CHANNEL', 'post')];
    assert.equal(survivorsOf({ _lastBlockerKey: keyOf(before) }, now).length, 0);
  });

  test('the FIRST pass has no history, so nothing is a survivor', () => {
    assert.equal(survivorsOf({ _lastBlockerKey: null }, [gap('MISSING_NAME', '')]).length, 0,
      'asking the user about something the very first rebuild would have fixed is its own kind of rude');
  });
});
