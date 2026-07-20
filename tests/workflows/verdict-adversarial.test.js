/**
 * THE THIRD VERDICT — adversarial pinning (test-adversary).
 *
 * `aa56d42` added `verdict` ('kept' | 'broken' | 'not_exercised') and `enforced`
 * to `evaluateExampleRun`, because `contract.every(c => c.ok)` is vacuously TRUE
 * over an empty set and over a set that is entirely skips — and both were being
 * rendered to the user as "every promise held, cleared to go live" (F12/F16).
 *
 * At the moment this file was written NOTHING in `tests/` referenced `verdict`
 * or the top-level `enforced` at all (`grep -rn "verdict\|enforced" tests/`
 * returned only per-assertion `contract[].ok` helpers named "verdict"). The
 * entire fix was unpinned: every mutation below survived a green suite.
 *
 * WHAT THIS PINS, and why each case exists:
 *
 *   A. A verdict may only be computed over EVIDENCE THAT EXISTS.
 *      · zero assertions          → not_exercised   (kills: drop the `enforced > 0` floor)
 *      · every assertion skipped  → not_exercised   (kills: drop the floor; count skips)
 *   B. THE ANTI-WEAKENING CORE IS INTACT — honesty was not bought by making
 *      everything "unverified".
 *      · asserted lane taken + delivered      → kept
 *      · asserted lane taken + nothing sent   → broken
 *      · the content-error sentinel           → broken
 *      · the run itself errored               → broken
 *      · a `when` no route can produce        → broken (fails closed, is ENFORCED)
 *   C. `contractPassed` IS UNCHANGED for the unexercised case (still `true`).
 *      Load-bearing: `src/converger/elicitation-graph.js`'s `verify` node reads it
 *      to decide whether to REGENERATE. Flipping it false for a lane the sample
 *      never reached is F17 — a valid draft thrown away and rebuilt until the
 *      build gives up. This is exactly the "obviously it should be stricter"
 *      change a future agent will make, so it is asserted explicitly, by name.
 *
 * Every assertion here is on the OBSERVABLE verdict of the unit under test, with
 * nothing between the call and the assertion.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { evaluateExampleRun } from '../../src/workflows/outcome-oracle.js';

/** A 3-lane router: urgent → slack, billing → gmail, everything else → nothing. */
function routerSpec() {
  return {
    version: 2,
    outcome: {
      statement: 'Urgent mail is posted to #ops and billing mail is emailed to finance.',
      assertions: [
        { id: 'a_urgent',  kind: 'message_sent', target: 'slack:#ops',            when: 'urgent'  },
        { id: 'a_billing', kind: 'message_sent', target: 'gmail:finance@acme.com', when: 'billing' },
      ],
    },
    nodes: [
      { id: 'sort', type: 'llm', config: { mode: 'classify', categories: ['urgent', 'billing', 'other'], prompt: 'sort it' } },
      { id: 'route', type: 'branch', config: { on: 'sort.output', cases: [
        { when: 'urgent',  to: 'post' },
        { when: 'billing', to: 'mail' },
        { when: '*',       to: 'nothing' },
      ] } },
      { id: 'post',    type: 'deliver', config: { channel: 'slack',       target: '#ops' } },
      { id: 'mail',    type: 'deliver', config: { channel: 'gmail_send',  to: 'finance@acme.com' } },
      { id: 'nothing', type: 'assemble', config: { content: 'no action' } },
    ],
    edges: [],
  };
}

/** A run of routerSpec() that took `lane`, optionally performing `delivery`. */
function routerRun(lane, delivery) {
  const steps = [{ nodeId: 'sort', output: lane }];
  const deliveries = [];
  if (delivery) {
    steps.push({ nodeId: lane === 'urgent' ? 'post' : 'mail', output: delivery });
    deliveries.push(delivery);
  }
  return { completed: true, error: null, steps, deliveries };
}

const SLACK_OPS  = { delivered: true, channel: 'slack',      target: '#ops' };
const GMAIL_FIN  = { delivered: true, channel: 'gmail_send', to: 'finance@acme.com' };

// ── A. A VERDICT MAY ONLY BE COMPUTED OVER EVIDENCE THAT EXISTS ───────────────

describe('not_exercised — the absence of evidence is not evidence of a kept promise', () => {
  test('a spec with NO assertions is not_exercised, never kept (F12)', () => {
    // The run is perfect: it completed, it delivered, nothing failed. The ONLY
    // thing missing is a promise to check — so there is nothing to certify.
    const spec = { version: 2, outcome: { statement: 'does things', assertions: [] },
                   nodes: [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }], edges: [] };
    const r = evaluateExampleRun(spec, { id: 'e1', given: {} },
      { completed: true, error: null, steps: [{ nodeId: 'd', output: SLACK_OPS }], deliveries: [SLACK_OPS] });

    assert.equal(r.contract.length, 0, 'fixture must actually have zero assertions');
    assert.equal(r.enforced, 0);
    assert.equal(r.verdict, 'not_exercised',
      'an empty contract is a vacuous truth — certifying it is F12');
    assert.notEqual(r.verdict, 'kept');
  });

  test('a spec with no `outcome` at all is not_exercised', () => {
    const spec = { version: 1, nodes: [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }], edges: [] };
    const r = evaluateExampleRun(spec, { given: {} },
      { completed: true, error: null, steps: [], deliveries: [SLACK_OPS] });
    assert.equal(r.enforced, 0);
    assert.equal(r.verdict, 'not_exercised');
  });

  test('EVERY assertion skipped (the do-nothing lane) is not_exercised, never kept (F16)', () => {
    // The exact live shape: a 3-lane router whose single sample routed "other".
    // Both promises are about lanes this sample did not take, no delivery node
    // executed at all, and the old boolean read that as a full pass.
    const r = evaluateExampleRun(routerSpec(), { id: 'e1', label: 'a newsletter', given: {} },
      routerRun('other', null));

    assert.equal(r.contract.length, 2, 'fixture must carry both promises');
    assert.equal(r.contract.filter(c => c.applicable === false).length, 2,
      'fixture must actually skip BOTH — otherwise this test proves nothing');
    assert.equal(r.enforced, 0, 'a skipped lane is not a check');
    assert.equal(r.verdict, 'not_exercised');
    assert.notEqual(r.verdict, 'kept');
    // …and the per-row detail the panel renders still marks them n/a, not ✓.
    assert.ok(r.contract.every(c => c.skipped === true));
  });

  test('a PARTIALLY exercised run is kept — `enforced` counts only what was CHECKED', () => {
    // urgent lane taken and delivered; the billing promise is skipped. Something
    // WAS proved, so this is a genuine pass — and `enforced` is 1, not 2. A mutant
    // that counts skipped assertions as enforced reads 2 here and still says kept,
    // which is why the count itself is asserted and not just the verdict.
    const r = evaluateExampleRun(routerSpec(), { given: {} }, routerRun('urgent', SLACK_OPS));

    assert.equal(r.enforced, 1, 'exactly one assertion was actually checked');
    assert.equal(r.contract.filter(c => c.applicable === false).length, 1);
    assert.equal(r.verdict, 'kept');
    assert.equal(r.contractPassed, true);
  });
});

// ── B. THE ANTI-WEAKENING CORE ───────────────────────────────────────────────
// Honesty must not have been bought by downgrading everything to "unverified".

describe('kept still means kept, and broken still means broken', () => {
  test('an UNCONDITIONAL promise that was delivered is kept', () => {
    const spec = {
      version: 2,
      // FIXTURE ONLY — `statement` added 2026-07-19, no assertion touched. This
      // fixture omitted it for brevity, and at the time that was harmless. It is
      // not any more: `blank-deal-finding.test.js` (F12 invariant 1b, from this
      // same pass) established that a contract with assertions but NO promise in
      // words cannot be certified, so the omission made this a blank-deal spec
      // rather than the ordinary one it is meant to represent. Every other fixture
      // in this file already carries a statement (see routerSpec), which is why
      // this was the only case affected. Same class as increment D's `human` node
      // with no timeout: a fixture that was "well formed" until a new rule made
      // explicit what it had been leaving out.
      outcome: {
        statement: 'Every message is posted to #ops.',
        assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }],
      },
      nodes: [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }], edges: [],
    };
    const r = evaluateExampleRun(spec, { given: {} },
      { completed: true, error: null, steps: [{ nodeId: 'd', output: SLACK_OPS }], deliveries: [SLACK_OPS] });
    assert.equal(r.enforced, 1);
    assert.equal(r.verdict, 'kept');
    assert.equal(r.contractPassed, true);
  });

  test('the asserted lane was taken and NOTHING was delivered → broken', () => {
    const r = evaluateExampleRun(routerSpec(), { given: {} }, routerRun('urgent', null));
    assert.equal(r.enforced, 1, 'the urgent promise WAS checked');
    assert.equal(r.verdict, 'broken');
    assert.equal(r.contractPassed, false);
    assert.match(r.contract.find(c => c.id === 'a_urgent').reason, /nothing reached slack:#ops/);
  });

  test('the asserted lane delivered to the WRONG target → broken', () => {
    // Structurally a delivery happened, so "a delivery ran" would pass. What it
    // SENT, and where, is the thing under test.
    const r = evaluateExampleRun(routerSpec(), { given: {} },
      routerRun('urgent', { delivered: true, channel: 'slack', target: '#random' }));
    assert.equal(r.verdict, 'broken');
    assert.equal(r.contractPassed, false);
  });

  test('the CONTENT-ERROR SENTINEL still breaks the example (it delivered an error)', () => {
    const spec = {
      version: 2,
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      nodes: [
        { id: 'sum', type: 'llm',     config: { mode: 'summarize' } },
        { id: 'd',   type: 'deliver', config: { channel: 'slack', target: '#ops' } },
      ], edges: [{ from: 'sum', to: 'd' }],
    };
    const run = {
      completed: true, error: null,
      steps: [{ nodeId: 'sum', output: 'ERROR: required data not found' },
              { nodeId: 'd',   output: SLACK_OPS }],
      deliveries: [SLACK_OPS],
    };
    const r = evaluateExampleRun(spec, { given: {} }, run);
    assert.equal(r.contentError, true, 'fixture must actually trip the sentinel guard');
    assert.equal(r.verdict, 'broken', 'a delivered error is not a kept promise');
    assert.equal(r.contractPassed, false);
  });

  test('a run that ERRORED is broken, not not_exercised — even with zero assertions', () => {
    // The tempting mutation is `enforced === 0 ⇒ not_exercised` evaluated FIRST.
    // A failed run is real, negative evidence; calling it "unverified" would hide
    // a crash behind a neutral badge.
    const spec = { version: 2, outcome: { assertions: [] }, nodes: [], edges: [] };
    const r = evaluateExampleRun(spec, { given: {} },
      { completed: false, error: 'slack: channel_not_found', steps: [], deliveries: [] });
    assert.equal(r.ran, false);
    assert.equal(r.verdict, 'broken');
    assert.equal(r.contractPassed, false);
  });

  test('a `when` NO route can produce fails closed, and is COUNTED as enforced', () => {
    // If a malformed conditional were treated as "not applicable" it would both
    // stop blocking the example AND stop counting — an unprovable promise would
    // read as a neutral "not exercised" instead of the failure it is.
    const spec = routerSpec();
    spec.outcome.assertions.push({ id: 'a_ghost', kind: 'message_sent', target: 'slack:#nowhere', when: 'p9' });
    const r = evaluateExampleRun(spec, { given: {} }, routerRun('urgent', SLACK_OPS));

    const ghost = r.contract.find(c => c.id === 'a_ghost');
    assert.equal(ghost.applicable, true, 'an uncheckable promise must not be filed as n/a');
    assert.equal(ghost.ok, false);
    assert.equal(r.enforced, 2, 'the urgent promise + the impossible one');
    assert.equal(r.verdict, 'broken');
  });

  test('the billing lane, taken and delivered, is also kept (both lanes provable)', () => {
    // Without this the rule could be "only ever certify the first assertion".
    const r = evaluateExampleRun(routerSpec(), { given: {} }, routerRun('billing', GMAIL_FIN));
    assert.equal(r.enforced, 1);
    assert.equal(r.verdict, 'kept');
  });
});

// ── C. `contractPassed` IS DELIBERATELY UNCHANGED ────────────────────────────

describe('contractPassed must NOT be tightened for the unexercised case (F17)', () => {
  // `src/converger/elicitation-graph.js`'s `verify` node reads `contractPassed`
  // to decide whether to REGENERATE the spec. A sample that simply did not reach
  // the asserted lane is not a defect in the spec, and resolving it pessimistically
  // is what threw away a valid 12-node draft and rebuilt it until the build gave up.
  //
  // So: `verdict` is the USER-FACING certification, `contractPassed` is the
  // CONVERGER's regenerate signal, and they are allowed to disagree here — on
  // purpose. If a future agent "fixes" contractPassed to follow the verdict, this
  // goes red and points at F17.
  test('zero assertions: verdict not_exercised, contractPassed STILL true', () => {
    const spec = { version: 2, outcome: { assertions: [] }, nodes: [], edges: [] };
    const r = evaluateExampleRun(spec, { given: {} }, { completed: true, error: null, steps: [], deliveries: [] });
    assert.equal(r.verdict, 'not_exercised');
    assert.equal(r.contractPassed, true,
      'tightening this recreates F17: the converger discards a valid draft and rebuilds until it gives up');
  });

  test('all lanes skipped: verdict not_exercised, contractPassed STILL true', () => {
    const r = evaluateExampleRun(routerSpec(), { given: {} }, routerRun('other', null));
    assert.equal(r.verdict, 'not_exercised');
    assert.equal(r.contractPassed, true,
      'a sample that took an unasserted lane must NOT trigger a rebuild');
  });

  test('the two signals still AGREE on every exercised case', () => {
    // The disagreement above is confined to `not_exercised`. Anywhere evidence
    // exists, a false `contractPassed` would be a real regression.
    const kept   = evaluateExampleRun(routerSpec(), { given: {} }, routerRun('urgent', SLACK_OPS));
    const broken = evaluateExampleRun(routerSpec(), { given: {} }, routerRun('urgent', null));
    assert.equal(kept.verdict, 'kept');
    assert.equal(kept.contractPassed, true);
    assert.equal(broken.verdict, 'broken');
    assert.equal(broken.contractPassed, false);
  });
});
