/**
 * A PROMISE ABOUT PER-ITEM WORK, ON A RUN THAT HAD NO ITEMS.
 *
 * WITNESSED ON PROD, 2026-07-30 (`build-platform-1785430634647`), driving "every Monday,
 * summarise each unread email from the past week into a row in a sheet". The workflow
 * was CORRECT: schedule → search Gmail → `foreach` → summarise → append a row, with the
 * promise and the write inside the loop even sharing one destination id. The dry run
 * said:
 *
 *     nothing reached "Weekly Inbox Digest" in Google Sheets — no step in this run
 *     attempted it
 *
 * …because the loop iterated over the Gmail results and, in a dry run, there were none.
 * Zero items, so the write never ran, so a promise about what happens PER ITEM was
 * scored BROKEN. **Five paid whole-spec Opus passes**, two of them rebuilding a spec
 * that was already right, then the gate refused a sixth — and the workflow could never
 * be cleared to go live.
 *
 * It is the quiet-path defect of 2026-07-29 arriving through the `foreach` door:
 * something that legitimately does nothing being called a broken promise.
 *
 * THE SECOND BLOCK IS THE IMPORTANT ONE. "Not exercised" is one word away from "we
 * stopped checking", and a blanket version of this excuse would hide every missing
 * delivery in any workflow that happens to contain a loop. Each narrowing is a way the
 * loop could LOOK empty without the promise being unexercisable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { setCapabilityCatalog, evaluateExampleRun, emptyLoopEvidence }
  from '../../src/workflows/outcome-oracle.js';

function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  setCapabilityCatalog(reg);
}

/** The prod shape, reduced to what decides this. */
const SPEC = () => ({
  outcome: {
    statement: 'Append one row per unread email to the Weekly Inbox Digest sheet.',
    assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Weekly Inbox Digest' }],
  },
  nodes: [
    { id: 'search_emails', type: 'connector-action', label: 'Search unread email',
      config: { action: 'gmail_search', query: 'is:unread' } },
    { id: 'process_emails', type: 'foreach', label: 'Process each email', config: {
      items: 'search_emails.output',
      steps: [
        { id: 'summarise', type: 'llm', label: 'Summarise', config: { mode: 'summarize' } },
        { id: 'append_row', type: 'deliver', label: 'Append row',
          config: { channel: 'sheets_append', spreadsheetId: 'Weekly Inbox Digest', range: 'A:D' } },
      ],
    } },
  ],
  edges: [{ from: 'search_emails', to: 'process_emails' }],
});

/** A run in which the loop reported N items and delivered nothing. */
const runWithLoop = (out) => ({
  completed: true,
  deliveries: [],
  steps: [
    { nodeId: 'search_emails', output: [] },
    { nodeId: 'process_emails', output: out },
  ],
});

const EMPTY = { count: 0, total: 0, truncated: false, skipped: 0, results: [] };

const verdictOf = (spec, run) => {
  catalog();
  return evaluateExampleRun(spec, { id: 'e1', label: 'a quiet Monday', given: {} }, run);
};

describe('THE PROD CASE', () => {
  test('a loop with nothing to do does not break the promise', () => {
    const r = verdictOf(SPEC(), runWithLoop(EMPTY));
    const c = r.contract[0];
    assert.equal(c.ok, true, c.reason ?? '');
    assert.equal(c.skipped, true);
    assert.equal(c.applicable, false);
  });

  test('and the example is not scored as broken', () => {
    // The verdict that drove five paid rebuilds and blocked go-live.
    const r = verdictOf(SPEC(), runWithLoop(EMPTY));
    assert.notEqual(r.verdict, 'broken');
  });

  test('the person is told what happened, in words', () => {
    const r = verdictOf(SPEC(), runWithLoop(EMPTY));
    const detail = r.contract[0].detail ?? '';
    assert.match(detail, /nothing for "Process each email" to work through/);
    assert.match(detail, /proved nothing either way/);
    assert.doesNotMatch(detail, /foreach|assertion|locator/i);
  });

  test('the evidence function says so on its own', () => {
    catalog();
    const e = emptyLoopEvidence(SPEC().outcome.assertions[0], SPEC(), runWithLoop(EMPTY));
    assert.equal(e?.empty, true);
  });
});

describe('IT MUST NEVER EXCUSE A REAL MISS', () => {
  // Each of these is a way the loop could LOOK empty without the promise being
  // unexercisable. If any starts returning a skip, every missing delivery in any
  // workflow containing a loop is laundered.

  test('NARROWING 1 — a step OUTSIDE the loop could have kept it', () => {
    catalog();
    const spec = SPEC();
    spec.nodes.push({ id: 'also', type: 'deliver', label: 'Also append',
      config: { channel: 'sheets_append', spreadsheetId: 'Weekly Inbox Digest', range: 'A:D' } });
    assert.equal(emptyLoopEvidence(spec.outcome.assertions[0], spec, runWithLoop(EMPTY)), null,
      'a top-level step that did not deliver is a real miss');
    assert.equal(verdictOf(spec, runWithLoop(EMPTY)).contract[0].ok, false);
  });

  test('NARROWING 2 — the loop never ran at all', () => {
    catalog();
    // Absent from the run means something upstream failed. That is a BROKEN run, not
    // an empty one, and it must not be excused as "nothing to do".
    const run = { completed: true, deliveries: [], steps: [{ nodeId: 'search_emails', output: [] }] };
    assert.equal(emptyLoopEvidence(SPEC().outcome.assertions[0], SPEC(), run), null);
    assert.equal(verdictOf(SPEC(), run).contract[0].ok, false);
  });

  test('NARROWING 3 — there WERE items and none was processed', () => {
    catalog();
    // Work was dropped: the opposite of nothing to do.
    const run = runWithLoop({ count: 0, total: 7, truncated: false, skipped: 0, results: [] });
    assert.equal(emptyLoopEvidence(SPEC().outcome.assertions[0], SPEC(), run), null);
    assert.equal(verdictOf(SPEC(), run).contract[0].ok, false);
  });

  test('NARROWING 4 — items were SKIPPED or TRUNCATED', () => {
    catalog();
    // Hitting the per-run cap is a real event with real consequences and must never
    // read as "there was nothing".
    for (const out of [{ count: 0, total: 0, skipped: 3, truncated: false, results: [] },
                       { count: 0, total: 0, skipped: 0, truncated: true, results: [] }]) {
      assert.equal(emptyLoopEvidence(SPEC().outcome.assertions[0], SPEC(), runWithLoop(out)), null,
        JSON.stringify(out));
    }
  });

  test('a promise about a DIFFERENT destination is untouched', () => {
    catalog();
    const spec = SPEC();
    spec.outcome.assertions = [{ id: 'a1', kind: 'record_exists', target: 'sheets:Some Other Sheet' }];
    assert.equal(emptyLoopEvidence(spec.outcome.assertions[0], spec, runWithLoop(EMPTY)), null,
      'nothing in this workflow writes there — an empty loop does not excuse that');
  });

  test('a workflow with NO loop is untouched', () => {
    catalog();
    const spec = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:sam@acme.com' }] },
      nodes: [{ id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'sam@acme.com', subject: 's' } }],
      edges: [],
    };
    const run = { completed: true, deliveries: [], steps: [{ nodeId: 'm', output: {} }] };
    assert.equal(emptyLoopEvidence(spec.outcome.assertions[0], spec, run), null);
    assert.equal(verdictOf(spec, run).contract[0].ok, false, 'a plain missing send is still broken');
  });

  test('a loop that DID deliver is judged normally, not skipped', () => {
    catalog();
    const spec = SPEC();
    const run = {
      completed: true,
      deliveries: [{ delivered: true, channel: 'sheets_append', target: 'Weekly Inbox Digest',
                     locators: ['Weekly Inbox Digest'] }],
      steps: [{ nodeId: 'search_emails', output: [1, 2] },
              { nodeId: 'process_emails', output: { count: 2, total: 2, skipped: 0, truncated: false, results: [] } }],
    };
    const c = verdictOf(spec, run).contract[0];
    assert.equal(c.ok, true);
    assert.notEqual(c.skipped, true, 'a real delivery must be KEPT, not skipped');
    assert.equal(c.applicable, true);
  });

  test('junk in the loop output is not read as empty', () => {
    catalog();
    for (const out of [null, undefined, 'nope', 42, {}, { count: 0 }]) {
      assert.equal(emptyLoopEvidence(SPEC().outcome.assertions[0], SPEC(), runWithLoop(out)), null,
        JSON.stringify(out) ?? 'undefined');
    }
  });
});

describe('the delivery check still wins', () => {
  test('a REAL delivery is never overridden by this', () => {
    // Position matters: this is consulted strictly after the delivery check says no,
    // exactly like the approval-ask evidence beside it. A kept promise must read kept.
    catalog();
    const spec = SPEC();
    const run = {
      completed: true,
      deliveries: [{ delivered: true, channel: 'sheets_append', target: 'Weekly Inbox Digest',
                     locators: ['Weekly Inbox Digest'] }],
      // The loop reports empty AND a delivery happened — contradictory, and the
      // delivery is the stronger evidence.
      steps: [{ nodeId: 'process_emails', output: EMPTY }],
    };
    const c = verdictOf(spec, run).contract[0];
    assert.equal(c.ok, true);
    assert.notEqual(c.skipped, true);
  });
});
