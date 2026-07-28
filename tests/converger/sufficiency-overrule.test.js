/**
 * The sufficiency check may not order a whole-spec rebuild for something the
 * contract already covers, nor repeat a complaint a rebuild has already failed on.
 *
 * WHY THIS EXISTS (measured, prod, 2026-07-28, build-platform-1785252448380):
 * a classify→approve→route build ran FOUR whole-spec generate passes —
 * 221s + 126s + 142s + 120s ≈ 10 minutes — and every one was ordered by the
 * `sufficiency` route naming the same thing missing: the Slack DM to Charles.
 * It was never missing. The `human` approval step sends that DM itself, which is
 * exactly why there is no separate delivery node for it. `scoreGap` had already
 * returned `complete: true` on that spec.
 *
 * The cost was not only the ten minutes: the regenerate budget was spent before
 * the build reached `verify`, which is where one test example per path is added,
 * so the finished workflow was handed to the test panel with a SINGLE example and
 * could not cover a five-path router.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sufficiencyClaimAlreadyCovered, missingKeyOf } from '../../src/converger/elicitation-graph.js';

// The real shape from the prod build: the DM is promised by the contract, and it is
// performed by the human approval node rather than a separate delivery step.
const APPROVAL_DRAFT = {
  outcome: {
    assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:hello@agntic.co', when: 'urgent_complaint' },
      { id: 'a2', kind: 'message_sent', target: 'slack:#atlas-test-temp', when: 'approve' },
      { id: 'a3', kind: 'record_exists', target: 'airtable:Table 1', when: 'normal_enquiry' },
    ],
  },
};

// Verbatim from the prod event log's `_regenReason.detail`.
const PROD_COMPLAINT =
  'Slack DM delivery to Charles (hello@agntic.co) with sender name, subject, and AI summary for the urgent complaint path';

test('the complaint that drove four prod rebuilds is recognised as already covered', () => {
  assert.equal(sufficiencyClaimAlreadyCovered(PROD_COMPLAINT, APPROVAL_DRAFT), true);
});

test('a channel the contract promises is covered even when named informally', () => {
  assert.equal(
    sufficiencyClaimAlreadyCovered('nothing posts the summary to #atlas-test-temp', APPROVAL_DRAFT),
    true,
  );
});

test('a table the contract promises is covered', () => {
  assert.equal(
    sufficiencyClaimAlreadyCovered('the workflow never writes to Table 1', APPROVAL_DRAFT),
    true,
  );
});

// ── THE ANTI-FALSE-PASS CASES ────────────────────────────────────────────────
// A guard that swallowed every complaint would silently disable the check this
// route exists for. These pin that it still passes real ones through.

test('a genuinely missing component the contract does NOT mention is still actioned', () => {
  assert.equal(
    sufficiencyClaimAlreadyCovered(
      'there is no step that removes the customer’s account number before sending',
      APPROVAL_DRAFT,
    ),
    false,
  );
});

test('a complaint naming a DIFFERENT destination is still actioned', () => {
  assert.equal(
    sufficiencyClaimAlreadyCovered('nothing posts to #finance-alerts', APPROVAL_DRAFT),
    false,
  );
});

test('a spec with no contract can never be overruled — nothing to disprove it with', () => {
  assert.equal(sufficiencyClaimAlreadyCovered(PROD_COMPLAINT, { outcome: { assertions: [] } }), false);
  assert.equal(sufficiencyClaimAlreadyCovered(PROD_COMPLAINT, {}), false);
});

test('an empty or absent complaint is not treated as covered', () => {
  assert.equal(sufficiencyClaimAlreadyCovered('', APPROVAL_DRAFT), false);
  assert.equal(sufficiencyClaimAlreadyCovered(null, APPROVAL_DRAFT), false);
  assert.equal(sufficiencyClaimAlreadyCovered('   ', APPROVAL_DRAFT), false);
});

test('a very short locator cannot match everything', () => {
  // A one- or two-character locator appears inside ordinary English, so without a
  // minimum length it would mark almost every complaint "already covered" and
  // silently disable the check. "at" is a substring of "anywhere at all"; the
  // guard is what stops that counting as a match.
  const draft = { outcome: { assertions: [{ kind: 'message_sent', target: 'slack:at' }] } };
  assert.equal(sufficiencyClaimAlreadyCovered('nothing posts anywhere at all', draft), false);
});

// ── THE REPEAT GUARD ─────────────────────────────────────────────────────────

test('the same complaint fingerprints the same however it is spaced or cased', () => {
  assert.equal(
    missingKeyOf('Slack DM   delivery to Charles'),
    missingKeyOf('slack dm delivery to charles'),
  );
});

test('two different complaints do not collide', () => {
  assert.notEqual(missingKeyOf('no redaction step'), missingKeyOf('no summary step'));
});
