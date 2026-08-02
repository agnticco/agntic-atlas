/**
 * THE TEST ASKS ONE QUESTION: DID IT DELIVER?
 *
 * ── What this replaced, and why (2026-08-02, Charles's call) ─────────────────
 *
 * A test run used to be scored against `outcome.assertions`: for each promise,
 * find a delivery whose connector and locator STRING match the promise's
 * `target`. Over 2026-08-01/02 that machinery produced no findings about a
 * workflow being wrong and repeatedly failed workflows that were right — nine
 * defects of that shape are recorded in CLAUDE.md, each one a disagreement about
 * what a destination string means, several costing paid rebuilds and twice
 * blocking a correct workflow from going live.
 *
 * The rule now:
 *
 *   ONE RUN passes when it completed without error, produced no content-error
 *   sentinel, and every delivery it attempted reported `delivered`.
 *
 *   THE SET passes when every run passed, every lane was run, and at least one
 *   delivery was attempted across the whole set.
 *
 * This file pins the per-run half (`src/workflows/delivery-verdict.js`). The
 * set-level half lives in the browser and is pinned by
 * `tests/api/test-panel-certification.test.js`, which extracts and EXECUTES the
 * real decision out of `public/index.html`. Lane coverage is unchanged and is
 * pinned by `tests/workflows/lane-coverage.test.js`.
 *
 * ── What is deliberately still checked, and must not be softened ─────────────
 *
 * `wouldDeliver` is not a string comparison. It is false when the body is empty,
 * when a `{{placeholder}}` survived into it, when no destination is named, when
 * the connector is not connected, or when the destination DOES NOT EXIST in the
 * customer's real account (a live probe). Every one of those is a real defect a
 * person would otherwise meet in production, and each has a test below.
 *
 * ── Carried over from `approval-publish.test.js`, which was deleted ──────────
 *
 * That file pinned the approval-ask evidence rule, which is gone. One invariant
 * in it outlived the rule and is kept here, marked: **the reason the run itself
 * recorded must reach the person, never a generic sentence composed in its
 * place.** It was a real defect — "no Slack user matches …" was being discarded.
 *
 * ── Mutations run by hand, all red→green (2026-08-02) ────────────────────────
 *
 *   M2  drop the content-error clause                   → 1 red
 *   M3  drop the `!ran` clause                          → 2 red
 *   M4  `whyNotDelivered` ignores `unreachableReason`   → 2 red
 *   M5  read `runResult.deliveries` instead of deriving → 1 red
 *   M6  `missed.length` dropped from the verdict        → 5 red
 *
 * M1 — `d.delivered === false` → `!d.delivered` — **SURVIVED, and is recorded as
 * unkillable rather than contrived into a kill.** Measured: `normalizeDelivery`
 * always stamps a boolean and an approval ask carries `delivered: true`, so no
 * shape production can build reaches that filter with the field absent. The
 * check is kept for its DIRECTION (an unreadable record is not evidence that a
 * delivery failed) and `delivery-verdict.js` says so at the line. The gated-
 * workflow test below passes either way; it pins that an approval step counts as
 * an attempt and does not fail the run, which is a real property.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateDeliveryRun, whyNotDelivered } from '../../src/workflows/delivery-verdict.js';

// ── The subject: an ordinary summarise-then-deliver workflow ─────────────────
const spec = () => ({
  version: 2,
  name: 'Daily summary',
  outcome: {
    statement: 'Every morning a summary lands in my inbox.',
    // Present on purpose: nothing below reads it. A spec still carries its
    // promise, and the verdict must be indifferent to how that promise is worded
    // — that indifference IS the change.
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Nowhere At All' }],
  },
  triggers: [{ type: 'schedule', cron: '0 8 * * *', timezone: 'America/Chicago' }],
  nodes: [
    { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize' } },
    { id: 'save', type: 'deliver', label: 'Save to inbox', config: { channel: 'inbox_deliver', subject: 'Summary' } },
  ],
  edges: [{ from: 'summ', to: 'save' }],
});

const LANDED = { delivered: true, channel: 'inbox_deliver', subject: 'Summary' };

/** A dry-run receipt that would NOT have landed, for a stated reason. */
const refused = (checks, unreachableReason) => ({
  dryRun: true, wouldDeliver: false, channel: 'inbox_deliver',
  checks: { hasBody: true, bodyWellFormed: true, targetPresent: true, capabilityConnected: true, destinationReachable: true, ...checks },
  ...(unreachableReason ? { unreachableReason } : {}),
});

const run = (saveOutput, over = {}) => ({
  completed: true, error: null,
  steps: [
    { nodeId: 'summ', output: 'A one-line summary.' },
    ...(saveOutput === undefined ? [] : [{ nodeId: 'save', output: saveOutput }]),
  ],
  ...over,
});

const judge = (r, s = spec()) => evaluateDeliveryRun(s, { id: 'e1', label: 'A normal morning' }, r);

// ─────────────────────────────────────────────────────────────────────────────

describe('a run that did the thing is kept', () => {
  test('it completed and its delivery would have landed', () => {
    const v = judge(run(LANDED));
    assert.equal(v.verdict, 'kept');
    assert.equal(v.attempted, 1);
    assert.equal(v.delivered, 1);
    assert.deepEqual(v.missed, []);
    assert.equal(v.landed[0].channel, 'inbox_deliver');
  });

  test('THE PROMISE IS NOT READ — a workflow whose deal names nowhere still passes', () => {
    // The spec's one assertion promises `inbox:Nowhere At All`; the step delivers
    // to "Summary". Under the old rule this was `broken` — "nothing reached
    // Nowhere At All" — and it is the exact shape that blocked correct workflows
    // from going live and bought whole-spec rebuilds. The run did what the
    // workflow says it does, so it passes.
    const v = judge(run(LANDED));
    assert.equal(v.verdict, 'kept');
  });

  test('a run with nothing to send is not a failure', () => {
    // A quiet lane — classify as spam, stop. It ran end to end and everything it
    // tried to send (nothing) landed. Calling this broken is what made a
    // correctly-built classifier unpublishable.
    const v = judge(run(undefined));
    assert.equal(v.verdict, 'kept');
    assert.equal(v.attempted, 0, 'but it attempted nothing — the callers gate on that');
    assert.deepEqual(v.landed, []);
  });
});

describe('a run that could not deliver is broken, with the reason it recorded', () => {
  // Each case below is a real production failure a person would otherwise meet
  // AFTER going live. `wouldDeliver` is what makes them visible before.
  const cases = [
    ['the destination does not exist in their account',
      refused({ destinationReachable: false }, 'no Slack user matches "charles@agntic.co"'),
      /no Slack user matches "charles@agntic\.co"/],
    ['the app is not connected',
      refused({ capabilityConnected: false }), /not connected/],
    ['no destination is named',
      refused({ targetPresent: false }), /doesn't say where/],
    ['an unfilled placeholder survived into the message',
      refused({ bodyWellFormed: false }), /placeholder/],
    ['there is nothing to send',
      refused({ hasBody: false }), /nothing to send/],
  ];

  for (const [name, receipt, reason] of cases) {
    test(name, () => {
      const v = judge(run(receipt));
      assert.equal(v.verdict, 'broken', name);
      assert.equal(v.attempted, 1, 'it tried');
      assert.equal(v.delivered, 0, 'and it did not land');
      assert.equal(v.missed.length, 1);
      assert.match(v.missed[0].reason, reason);
    });
  }

  test("THE RUN'S OWN RECORDED REASON WINS over any sentence composed in its place", () => {
    // Carried over from the deleted `approval-publish.test.js`. The defect: a
    // probe reported "no Slack user matches …" and the reason was discarded and
    // replaced with a generic one, so the person could not tell what to fix.
    const r = refused({ destinationReachable: false }, 'no Slack user matches "charles@agntic.co"');
    assert.equal(whyNotDelivered(r), 'no Slack user matches "charles@agntic.co"');
    // …and with no recorded reason it says the honest generic thing rather than
    // inventing a specific one.
    assert.equal(whyNotDelivered(refused({ destinationReachable: false })), 'the destination could not be found');
  });

  test('an unprobed destination is NOT a failure — inconclusive is not negative', () => {
    // A probe that times out or is not implemented leaves reachability null.
    // Failing on that would block every capability with no probe.
    const v = judge(run({ dryRun: true, wouldDeliver: true, channel: 'inbox_deliver', subject: 'Summary',
      checks: { hasBody: true, bodyWellFormed: true, targetPresent: true, capabilityConnected: true, destinationReachable: null } }));
    assert.equal(v.verdict, 'kept');
  });
});

describe('a run that did not finish is broken, whatever it delivered', () => {
  test('an errored run', () => {
    const v = judge(run(LANDED, { completed: false, error: 'Slack unreachable' }));
    assert.equal(v.verdict, 'broken');
    assert.equal(v.ran, false);
    assert.equal(v.error, 'Slack unreachable');
  });

  test('a run that never completed, even with no error recorded', () => {
    const v = judge(run(LANDED, { completed: false }));
    assert.equal(v.verdict, 'broken');
    assert.equal(v.ran, false);
  });
});

describe('a delivery whose CONTENT is an error is not a delivery', () => {
  test('the sentinel breaks the run even though the send succeeded', () => {
    // An llm step that cannot find its input emits exactly this. The message went
    // out; what went out was an apology. The inbox got an error, not a summary.
    const v = judge({
      completed: true, error: null,
      steps: [
        { nodeId: 'summ', output: 'ERROR: required data not found — do not compose content.' },
        { nodeId: 'save', output: LANDED },
      ],
    });
    assert.equal(v.verdict, 'broken');
    assert.equal(v.contentError, true);
    assert.ok(v.contentErrorDetail?.step, 'and it names the step that could not find its data');
  });
});

describe('what counts as a delivery is decided in ONE place', () => {
  test('an approval question counts as an attempt and does not fail the run', () => {
    // A `human` node's ask rides in the delivery list (`askDeliveriesOf`) —
    // measured 2026-08-02, it carries `delivered: true`, so the gated workflow
    // clears the set-level "something was attempted" floor on the strength of the
    // question it asked, exactly as it did before. What must never happen is the
    // ask reading as a delivery that FAILED, which would block every approval
    // workflow from going live.
    const gated = spec();
    gated.nodes = [
      { id: 'summ', type: 'llm', label: 'Draft', config: { mode: 'summarize' } },
      { id: 'ask', type: 'human', label: 'Approve it',
        config: { question: 'Send this?', channels: [{ type: 'slack', target: '#ops' }], decisions: ['approve', 'reject'] } },
      { id: 'save', type: 'deliver', label: 'Save to inbox', config: { channel: 'inbox_deliver', subject: 'Summary' } },
    ];
    gated.edges = [{ from: 'summ', to: 'ask' }, { from: 'ask', to: 'save' }];

    const v = evaluateDeliveryRun(gated, { id: 'e1', label: 'Gated' }, {
      completed: true, error: null,
      steps: [
        { nodeId: 'summ', output: 'A draft.' },
        { nodeId: 'ask', output: { decision: 'approve' } },
        { nodeId: 'save', output: LANDED },
      ],
    });
    assert.equal(v.verdict, 'kept', 'an approval step must not read as a delivery that failed');
    assert.deepEqual(v.missed, []);
  });

  test('deliveries are derived from the STEPS, never taken from the caller', () => {
    // The delivering NODE is what knows the channel and destination — handlers are
    // inconsistent about both. A caller-supplied array would make this module's
    // answer depend on how carefully each caller built it, which is exactly how
    // two halves of this system have drifted nine times.
    const r = run(LANDED);
    r.deliveries = [];                       // a caller that assembled nothing
    const v = judge(r);
    assert.equal(v.attempted, 1, "the run's own steps decide, not the caller's array");
    assert.equal(v.verdict, 'kept');
  });

  test('a read step is not a delivery', () => {
    const s = spec();
    s.nodes = [
      { id: 'read', type: 'connector-action', label: 'Read the sheet', config: { action: 'sheets_read' } },
      { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize' } },
    ];
    s.edges = [{ from: 'read', to: 'summ' }];
    const v = evaluateDeliveryRun(s, { id: 'e1' }, {
      completed: true, error: null,
      steps: [{ nodeId: 'read', output: { rows: [] } }, { nodeId: 'summ', output: 'text' }],
    });
    assert.equal(v.attempted, 0, 'reading is not delivering');
    assert.equal(v.verdict, 'kept');
  });
});

describe('the run still reports which lanes it took', () => {
  test('lanes and the lane inventory ride along for the set-level check', () => {
    // Unchanged from before, and load-bearing: a router is only proved on the
    // routes you test. The client subtracts one from the other and holds no copy
    // of the rule.
    const v = judge(run(LANDED));
    assert.ok(Array.isArray(v.lanes));
    assert.ok(Array.isArray(v.laneInventory));
  });
});
