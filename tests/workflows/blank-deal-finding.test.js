/**
 * ✅ CLOSED 2026-07-19 — this suite now PINS the fix. Do not delete it, do not weaken it.
 *
 * It was written as a deliberately-RED finding (the test-adversary's protocol: a defect
 * that needs a source change is reported and left failing) and it was correct. The guard
 * now lives in `outcome-oracle.js` — `contractIncomplete`, which refuses to return
 * 'kept' for a contract with assertions but no statement. Mutation-checked by hand:
 * dropping `&& !contractIncomplete` from the verdict turns this suite red again.
 *
 * Only the header changed. Every assertion below is the adversary's, untouched.
 *
 * F12 invariant 1b (docs/handoff/ui-test-findings-2026-07-19.md:547) reads, verbatim:
 *
 *   "An EMPTY CONTRACT STATEMENT must never be certified. If THE DEAL is blank there
 *    is no promise to have kept, and 'every promise held' is vacuously true — the
 *    F12 defect through a second door."
 *
 * `aa56d42` closes F12's invariant 1 (zero examples / all-skipped ⇒ `not_exercised`)
 * and marks F12 fixed. Invariant 1b is NOT closed. `verdict` is computed purely from
 * `outcome.assertions`; `outcome.statement` is never consulted, by the oracle or by
 * the client's `hasContract`.
 *
 * WHY IT IS REACHABLE, not theoretical:
 *   · `src/converger/spec-assembler.js:35` — `statement: spec?.statement ?? ''`.
 *     A model turn that omits a statement yields the empty string, not an absence.
 *   · `src/workflows/workflow-validator.js` `_checkOutcome` requires
 *     `outcome.assertions.length`; it NEVER requires a non-empty `statement`.
 *     (`MISSING_OUTCOME`'s hint says "Add outcome.statement" — and then nothing checks it.)
 *   · So a spec with `{ statement: '', assertions: [one] }` publishes, runs, keeps its
 *     one assertion, and the panel renders a BLANK "THE DEAL" above the words
 *     "Contract kept — every promise held." That is precisely the screenshot F14/F15
 *     describe, now reached through a door F11's fix does not cover: F11 made the
 *     contract survive publish, which fixes the NULL-outcome route to a blank deal —
 *     it does nothing about a contract that was blank when it was written.
 *
 * It is SILENT and USER-REACHABLE, which is the blocking bar in CLAUDE.md's review
 * calibration. It was closed the first way it suggests: an oracle verdict that will not
 * certify a contract with no statement. The VALIDATOR half is deliberately still open —
 * such a spec can still be published, it simply can no longer be certified. A validator
 * rule requiring a non-empty `outcome.statement` remains the deeper fix.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { evaluateExampleRun } from '../../src/workflows/outcome-oracle.js';

const SLACK_OPS = { delivered: true, channel: 'slack', target: '#ops' };

/** Everything a real published v2 spec has — except a statement. */
const blankDealSpec = () => ({
  version: 2,
  outcome: {
    statement: '',                                                    // ← the blank deal
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }],
  },
  nodes: [{ id: 'post', type: 'deliver', config: { channel: 'slack', target: '#ops' } }],
  edges: [],
});

describe('FINDING (open): a BLANK contract statement is still certified as kept', () => {
  test('the fixture is the reachable shape — a v2 outcome with an empty statement', () => {
    // Grounding, so a reader can see this is not a strawman: the assertion is real
    // and the run really does satisfy it. The ONLY thing missing is the promise in
    // words — the sentence the panel renders directly above "every promise held".
    const s = blankDealSpec();
    assert.equal(s.outcome.statement, '');
    assert.equal(s.outcome.assertions.length, 1);
  });

  test('EXPECTED RED: a contract with nothing to say must not certify', () => {
    const r = evaluateExampleRun(blankDealSpec(), { id: 'e1', given: {} }, {
      completed: true, error: null,
      steps: [{ nodeId: 'post', output: SLACK_OPS }],
      deliveries: [SLACK_OPS],
    });

    // This is what it does today — recorded so the failure below is unambiguous.
    assert.equal(r.enforced, 1);

    assert.notEqual(r.verdict, 'kept',
      'F12 invariant 1b: a blank statement is a blank promise. Certifying it renders ' +
      '"every promise held" under an empty THE DEAL — the F12 vacuous truth through ' +
      'a second door. Expected `not_exercised` (or a refusal to certify); got "kept".');
  });
});
