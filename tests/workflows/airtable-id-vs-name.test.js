/**
 * A successful Airtable write must not be reported as a broken promise just
 * because the promise names the table and the run names its provider id.
 *
 * WITNESSED ON PROD (2026-07-28, atlas.agntic.co v1.6.46). A classify→approve→route
 * workflow wrote its record, and the test panel said:
 *
 *   "nothing reached "Table 1" in Airtable — this run delivered to
 *    tblbQ0PmkA2o1P17Q (Airtable), and nothing else."
 *
 * Both halves of that sentence describe the same table. Go live stayed locked on a
 * workflow that had done exactly what it promised.
 *
 * ROOT CAUSE: the build-time check (`satisfiesAssertion`) has always treated an
 * opaque provider id as UNDECIDABLE rather than a mismatch — you cannot know
 * whether `tblbQ0PmkA2o1P17Q` is `Table 1` without asking Airtable. The runtime
 * check compared the same two strings WITHOUT that rule, under a comment claiming
 * it mirrored the build-time one. The two checkers disagreed about identical data:
 * the build published the workflow, the run then failed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAssertionAtRuntime,
  isOpaqueProviderId,
} from '../../src/workflows/outcome-oracle.js';

const RECORD_PROMISE = { kind: 'record_exists', target: 'airtable:Table 1', when: 'normal_enquiry' };

/** The receipt the prod run actually produced: delivered, keyed by provider ids. */
const deliveredToIds = () => ([{
  delivered: true,
  channel: 'airtable_create_record',
  target: 'tblbQ0PmkA2o1P17Q',
  locators: ['tblbQ0PmkA2o1P17Q', 'appR2sT4uV6wX8yZ0'],
}]);

test('the prod failure: a write keyed by table id satisfies a promise naming the table', () => {
  const res = checkAssertionAtRuntime(RECORD_PROMISE, deliveredToIds());
  assert.equal(res.ok, true, res.reason ?? 'expected the delivery to satisfy the promise');
});

test('a human-named table still matches by name, as it always did', () => {
  const res = checkAssertionAtRuntime(RECORD_PROMISE, [{
    delivered: true, channel: 'airtable_create_record',
    target: 'Table 1', locators: ['Table 1'],
  }]);
  assert.equal(res.ok, true, res.reason ?? 'expected a name match');
});

// ── THE ANTI-FALSE-PASS CASES ────────────────────────────────────────────────
// Letting an opaque id through must not turn the oracle into a rubber stamp.

test('a write that did NOT go through is still a broken promise', () => {
  const res = checkAssertionAtRuntime(RECORD_PROMISE, [{
    delivered: false, channel: 'airtable_create_record',
    target: 'tblbQ0PmkA2o1P17Q', locators: ['tblbQ0PmkA2o1P17Q'],
    error: 'the Airtable table wasn’t found in that base',
  }]);
  assert.equal(res.ok, false);
});

test('a delivery to a DIFFERENT connector is still a broken promise', () => {
  const res = checkAssertionAtRuntime(RECORD_PROMISE, [{
    delivered: true, channel: 'slack_post_message',
    target: '#atlas-test-temp', locators: ['#atlas-test-temp'],
  }]);
  assert.equal(res.ok, false);
});

test('a wrong HUMAN-NAMED table is still a broken promise', () => {
  const res = checkAssertionAtRuntime(RECORD_PROMISE, [{
    delivered: true, channel: 'airtable_create_record',
    target: 'Archive', locators: ['Archive'],
  }]);
  assert.equal(res.ok, false, 'a genuinely wrong named table must still fail');
});

test('no delivery at all is still a broken promise', () => {
  const res = checkAssertionAtRuntime(RECORD_PROMISE, []);
  assert.equal(res.ok, false);
});

// ── THE RULE ITSELF STAYS NARROW ─────────────────────────────────────────────

test('only real provider ids are treated as opaque', () => {
  assert.equal(isOpaqueProviderId('tblbQ0PmkA2o1P17Q'), true);
  assert.equal(isOpaqueProviderId('appR2sT4uV6wX8yZ0'), true);
  // Human names, channels and addresses must stay comparable, or a wrong
  // destination would sail through.
  assert.equal(isOpaqueProviderId('Table 1'), false);
  assert.equal(isOpaqueProviderId('Sheet1'), false);
  assert.equal(isOpaqueProviderId('#general'), false);
  assert.equal(isOpaqueProviderId('ops@acme.com'), false);
  // Right prefix, wrong length — not the documented id shape.
  assert.equal(isOpaqueProviderId('tblshort'), false);
  assert.equal(isOpaqueProviderId('tblbQ0PmkA2o1P17QTOOLONG'), false);
  assert.equal(isOpaqueProviderId(''), false);
  assert.equal(isOpaqueProviderId(null), false);
});
