/**
 * A column that does not exist is a fact about the world, not a defect in the
 * spec — so it must never buy a whole-spec rebuild.
 *
 * MEASURED ON PROD (2026-07-28, build-platform-1785255582744): a
 * classify→approve→route build spent TWO of its three generate passes — 112s +
 * 152s — on `UNSATISFIED_ASSERTION:deliver_airtable`, and still ended up asking
 * the user. The promise said the record would carry `Subject` and `Summary`; the
 * real table has `Name`, `Notes` and `Date`. No amount of regenerating creates a
 * column in someone else's Airtable.
 *
 * `destinations` already maps promised fields onto the table's real columns and
 * records what it could not place (`unmapped`), deliberately letting it fail
 * rather than dropping it silently. That failure arrives as UNSATISFIED_ASSERTION
 * on `config.fields`. It now joins the resource gaps, which have been exempt from
 * the rebuild loop since #25 for exactly the same reason.
 *
 * THE KEY IS `field`, NOT THE CODE. UNSATISFIED_ASSERTION means "a promised column
 * is missing" on `config.fields`, and "a step that delivers this is missing"
 * everywhere else — and that second one a rebuild really can fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNotRegenerable } from '../../src/converger/elicitation-graph.js';
import { scoreGap } from '../../src/converger/gap-scorer.js';

test('a promised column the table does not have is not regenerable', () => {
  assert.equal(
    isNotRegenerable({ code: 'UNSATISFIED_ASSERTION', field: 'config.fields' }),
    true,
  );
});

test('a missing channel or unverifiable base is not regenerable', () => {
  assert.equal(isNotRegenerable({ code: 'RESOURCE_NOT_FOUND' }), true);
  assert.equal(isNotRegenerable({ code: 'RESOURCE_UNVERIFIED' }), true);
});

// ── THE ANTI-FALSE-PASS CASES ────────────────────────────────────────────────
// Exempting too much would strand a spec the builder really could have fixed.

test('the SAME code about a missing step IS regenerable', () => {
  assert.equal(isNotRegenerable({ code: 'UNSATISFIED_ASSERTION', field: null }), false);
  assert.equal(isNotRegenerable({ code: 'UNSATISFIED_ASSERTION' }), false);
  assert.equal(
    isNotRegenerable({ code: 'UNSATISFIED_ASSERTION', field: 'config.channel' }),
    false,
    'a delivery pointed at the wrong channel is the builder’s own output — rebuild it',
  );
});

test('ordinary builder mistakes stay regenerable', () => {
  for (const code of ['DELIVER_NO_INPUT', 'MISSING_CONFIG', 'MISSING_NAME', 'BRANCH_BAD_ON']) {
    assert.equal(isNotRegenerable({ code }), false, `${code} must still drive a rebuild`);
  }
});

test('junk is not silently treated as unfixable', () => {
  assert.equal(isNotRegenerable(null), false);
  assert.equal(isNotRegenerable(undefined), false);
  assert.equal(isNotRegenerable('UNSATISFIED_ASSERTION'), false);
  assert.equal(isNotRegenerable({}), false);
});

// ── THE MARKER HAS TO SURVIVE THE SCORER ─────────────────────────────────────
// The guard reads `gap.field`. The scorer used to drop it when turning a validator
// issue into a gap, which would have made the guard silently dead — the worst
// outcome, because it looks fixed.

test('scoreGap carries the validator’s `field` through onto the gap', () => {
  const spec = {
    name: 'Log enquiries',
    triggers: [{ type: 'email' }],
    outcome: {
      statement: 'log every enquiry',
      assertions: [{
        id: 'a1', kind: 'record_exists', target: 'airtable:Table 1',
        fields: ['Subject', 'Summary'],
      }],
    },
    nodes: [
      { id: 'extract', type: 'llm', label: 'Extract', config: { mode: 'extract', fields: 'sender' } },
      {
        id: 'log', type: 'deliver', label: 'Log enquiry',
        // The REAL table's columns — Subject and Summary are not among them.
        config: { channel: 'airtable_create_record', baseId: 'Priority Items', tableId: 'Table 1',
                  fields: { Name: '{{extract.output}}', Notes: '{{extract.output}}' } },
      },
    ],
    edges: [{ from: 'extract', to: 'log' }],
  };
  const gaps = scoreGap(spec).gaps;
  const fieldGap = gaps.find(g => g.code === 'UNSATISFIED_ASSERTION' && g.field === 'config.fields');
  assert.ok(fieldGap, 'the promised-column gap must reach the guard with its field marker');
  assert.equal(isNotRegenerable(fieldGap), true);
});
