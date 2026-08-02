/**
 * THE PRODUCT DOES NOT DESCRIBE ITS OWN TEST RESULTS IN FREE PROSE.
 *
 * ── What was observed (2026-07-26, screenshotted) ────────────────────────────
 * After a PASSING test of a spam-triage workflow, the chat told a tester the
 * workflow
 *
 *   "…classified it as spam, routed it to the correct path, and then summarized
 *    and delivered it to both the #ops channel and to charles@agntic.co as
 *    promised."
 *
 * Spam is the branch whose entire promise is to do NOTHING. Two inches above, in
 * the same screenshot, the engineered evidence panel — reading the same run —
 * said it correctly: "it took a path that doesn't cover… Nothing was proved
 * either way."
 *
 * ── Why it invented, and why the previous fix did not hold ───────────────────
 * This is the SECOND round of the same defect. The first (2026-07-22: a clean but
 * unverified run described as a failure, with an invented cause, twice in one
 * message) was fixed at the prompt and at the boundary — the client began sending
 * the three-way verdict instead of a boolean. It came back through a different
 * door, because the boundary was still lossy in the same way: the client computed
 * `outcomeResults` — one `evaluateDeliveryRun()` result per example, each carrying
 * the oracle's `verdict` — and DROPPED it, sending instead `deliveries` from the
 * LAST run of the sequence. A model handed a delivery receipt and told to "be
 * specific" fills the gap it was left.
 *
 * The old version of this file could only assert WHAT THE NARRATOR WAS TOLD,
 * because the sentence itself was model-generated and unassertable. The sentence
 * is now COMPOSED (src/workflows/run-summary.js) from the same objects the panel
 * renders, so every pin below is now on THE SENTENCE A PERSON READS.
 *
 * ── The pins carried over from the 2026-07-22 suite, now stronger ────────────
 *   · an unverified run is NEVER described as a failure          (was: in the context)
 *   · the real reason is given, so nothing has to be guessed     (was: in the context)
 *   · failure-only material is not attached to a run that did
 *     not fail — it was the raw material of the invention        (was: in the context)
 *   · a genuine failure still reads as one, with its own cause   (was: in the context)
 *   · a pass says the promise was KEPT, not merely that it ran   (was: in the context)
 *   · an older client that sends no verdict still works          (was: in the context)
 *   · the client sends the evidence it computed                  (payload, re-pointed)
 *
 * ── How the subjects are constructed ─────────────────────────────────────────
 * Every `outcomeResults` fixture below is produced by the REAL oracle
 * (`evaluateExampleRun`) over a real spec and a real run shape, and the lane
 * coverage by the REAL `laneCoverage()`. Hand-written result objects would let a
 * pin pass against a shape production never produces. The client's payload is
 * LIFTED from public/index.html rather than re-implemented, for the same reason
 * the old suite lifted the context builder: a second copy passes while production
 * keeps sending the old thing.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

import {  laneCoverage } from '../../src/workflows/outcome-oracle.js';
import { evaluateDeliveryRun } from '../../src/workflows/delivery-verdict.js';
import { composeRunSummary, exampleVerdict } from '../../src/workflows/run-summary.js';
import { mountBuilderRoutes } from '../../src/api/builder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── The workflow from the screenshot, reduced to its two lanes ────────────────
// Real mail is summarised into the Atlas inbox; spam goes down the lane that
// does nothing. The promise is CONDITIONAL on the "normal" lane, which is why a
// spam sample proves nothing at all about it.
function spamTriage() {
  return {
    version: 2,
    name: 'Inbox triage',
    outcome: {
      statement: 'Real mail is summarised into my Atlas inbox; spam is ignored.',
      assertions: [{ id: 'a_norm', kind: 'message_sent', target: 'inbox:Summary', when: 'normal' }],
    },
    triggers: [{ type: 'email', filter: 'is:unread' }],
    nodes: [
      { id: 'classify', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'normal\nspam', instructions: 'Sort the message.' } },
      { id: 'b1', type: 'branch', label: 'Route by category',
        config: { on: 'classify.output', cases: [{ when: 'normal', to: 'summ' }, { when: '*', to: 'stop_spam' }] } },
      { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize', instructions: 'One line.' } },
      { id: 'save', type: 'deliver', label: 'Save to inbox', config: { channel: 'inbox_deliver', subject: 'Summary' } },
      { id: 'stop_spam', type: 'assemble', label: 'Stop — spam', config: {} },
    ],
    edges: [
      { from: 'classify', to: 'b1' }, { from: 'b1', to: 'summ' },
      { from: 'b1', to: 'stop_spam' }, { from: 'summ', to: 'save' },
    ],
  };
}

/**
 * A second workflow with TWO delivery promises on TWO different lanes.
 *
 * This exists for one test: a "should not happen" example that the harness runs
 * anyway (it bypasses the trigger) DELIVERS for real, and its delivery must never
 * be credited as something the workflow proved. That is the shape that once put a
 * green tick reading "should not fire" directly above "every promise held",
 * moments after a real Slack DM had gone out for it. With one shared target the
 * lie is invisible — the honest example proves the same string — so the two lanes
 * deliver to two different places.
 */
function twoLaneTriage() {
  return {
    version: 2,
    name: 'Two-lane triage',
    outcome: {
      statement: 'Normal mail is summarised to my inbox; urgent mail is escalated to my inbox as Urgent.',
      assertions: [
        { id: 'a_norm', kind: 'message_sent', target: 'inbox:Summary', when: 'normal' },
        { id: 'a_urg',  kind: 'message_sent', target: 'inbox:Urgent',  when: 'urgent' },
      ],
    },
    triggers: [{ type: 'email', filter: 'is:unread' }],
    nodes: [
      { id: 'classify', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'normal\nurgent', instructions: 'Sort the message.' } },
      { id: 'b1', type: 'branch', label: 'Route by category',
        config: { on: 'classify.output', cases: [{ when: 'normal', to: 'summ' }, { when: '*', to: 'esc' }] } },
      { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize', instructions: 'One line.' } },
      { id: 'save', type: 'deliver', label: 'Save to inbox', config: { channel: 'inbox_deliver', subject: 'Summary' } },
      { id: 'esc', type: 'llm', label: 'Escalate', config: { mode: 'rewrite', instructions: 'Flag it.' } },
      { id: 'save_urg', type: 'deliver', label: 'Save as urgent', config: { channel: 'inbox_deliver', subject: 'Urgent' } },
    ],
    edges: [
      { from: 'classify', to: 'b1' }, { from: 'b1', to: 'summ' }, { from: 'b1', to: 'esc' },
      { from: 'summ', to: 'save' }, { from: 'esc', to: 'save_urg' },
    ],
  };
}

const INBOX_DELIVERY = { delivered: true, channel: 'inbox_deliver', subject: 'Summary' };
const URGENT_DELIVERY = { delivered: true, channel: 'inbox_deliver', subject: 'Urgent' };

// Mirror the engine: only EXECUTED nodes appear in steps, and a delivery rides on
// its node. The spam lane performs no delivery at all — that is the whole point.
const spamRun = () => ({
  completed: true, error: null, deliveries: [],
  steps: [
    { nodeId: 'classify', output: 'spam' },
    { nodeId: 'b1', output: { value: 'spam', matched: '*', to: 'stop_spam' } },
    { nodeId: 'stop_spam', output: { done: true } },
  ],
});
const normalRun = (deliver = true) => {
  const steps = [
    { nodeId: 'classify', output: 'normal' },
    { nodeId: 'b1', output: { value: 'normal', matched: 'normal', to: 'summ' } },
    { nodeId: 'summ', output: 'A one-line summary.' },
  ];
  const deliveries = [];
  if (deliver) { steps.push({ nodeId: 'save', output: INBOX_DELIVERY }); deliveries.push(INBOX_DELIVERY); }
  return { completed: true, error: null, steps, deliveries };
};

const twoLaneRun = (lane) => {
  const normal = lane === 'normal';
  const delivery = normal ? INBOX_DELIVERY : URGENT_DELIVERY;
  return {
    completed: true, error: null, deliveries: [delivery],
    steps: [
      { nodeId: 'classify', output: lane },
      { nodeId: 'b1', output: { value: lane, matched: normal ? 'normal' : '*', to: normal ? 'summ' : 'esc' } },
      { nodeId: normal ? 'summ' : 'esc', output: 'Some text.' },
      { nodeId: normal ? 'save' : 'save_urg', output: delivery },
    ],
  };
};

const SPEC     = spamTriage();
const EX_SPAM  = { id: 'e_spam', label: 'Spam — a crypto blast', given: { subject: 'YOU HAVE WON' } };
const EX_NORM  = { id: 'e_norm', label: 'A normal enquiry',      given: { subject: 'Quote please' } };

const R_SPAM   = evaluateDeliveryRun(SPEC, EX_SPAM, spamRun());
const R_NORM   = evaluateDeliveryRun(SPEC, EX_NORM, normalRun());
// A GENUINE FAILURE under the new rule: the delivery step RAN and its receipt says
// it would not have landed. RE-POINTED 2026-08-02 — this used to be `normalRun(false)`,
// a run with no delivery step at all, which the old rule scored `broken` because no
// delivery matched the promise's target. That run is now `kept` with `attempted: 0`
// (it completed and everything it tried to send — nothing — landed), and the case it
// stood for is caught by the set-level "no delivery was attempted anywhere" clause.
// A workflow that TRIES to deliver and cannot is a different, sharper failure, and it
// is the one a person actually hits.
const FAILED_DELIVERY = {
  dryRun: true, wouldDeliver: false, channel: 'inbox_deliver',
  checks: { hasBody: true, bodyWellFormed: true, targetPresent: true, capabilityConnected: false, destinationReachable: null },
};
const missedRun = () => ({
  completed: true, error: null,
  steps: [
    { nodeId: 'classify', output: 'normal' },
    { nodeId: 'b1', output: { value: 'normal', matched: 'normal', to: 'summ' } },
    { nodeId: 'summ', output: 'A one-line summary.' },
    { nodeId: 'save', output: FAILED_DELIVERY },
  ],
});
const R_MISS   = evaluateDeliveryRun(SPEC, EX_NORM, missedRun());

/**
 * WORDS THAT ASSERT SOMETHING HAPPENED TO THE OUTSIDE WORLD.
 *
 * The invented sentence was built out of exactly these: "routed it to the correct
 * path… summarized and delivered it… as promised". None of them may appear about a
 * run whose evidence records the lane as not exercised.
 */
const CLAIM_WORDS = [
  /\bdeliver(ed|s|ing|y)?\b/i,
  /\bsent\b/i,
  /\bposted\b/i,
  /\bemailed\b/i,
  /\brouted\b/i,
  /\bas promised\b/i,
  /\bkept\b/i,
  /\bheld\b/i,
];

/**
 * A NEGATION IS NOT A CLAIM (added 2026-08-02).
 *
 * `CLAIM_WORDS` is a blunt word list, on purpose — it is the guard against a
 * narrator inventing "…delivered it to #ops as promised". But "ran with nothing
 * to send" and "didn't send or write anything" are the OPPOSITE of a claim, and
 * a word list cannot tell them apart.
 *
 * So a small, EXPLICIT list of negated phrases is removed before matching. It is
 * a list of exact phrases and never a general "not …" pattern: a broad negation
 * rule would let a real invented claim through by wrapping it in a "not", which
 * is the one thing this guard exists to stop. Add to it only with a phrase you
 * can read as unambiguously negative on its own.
 */
const NEGATIONS = [
  /\bnothing to send\b/gi,
  /\bnothing was (actually )?sent\b/gi,
  /\bdidn't send or write anything\b/gi,
  /\bnone of them sent or wrote anything\b/gi,
];

function assertClaimsNothing(sentence, why) {
  let s = sentence;
  for (const n of NEGATIONS) s = s.replace(n, '');
  for (const re of CLAIM_WORDS) {
    assert.doesNotMatch(s, re, `${why} — but the sentence matched ${re}: ${sentence}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the spam case — a do-nothing lane is never narrated as a delivery', () => {
  test('after a PASSING run, the example that took the do-nothing lane is reported as proving nothing', () => {
    // The exact live shape: both lanes covered across the set, the real example
    // kept the promise, the spam example took the lane that does nothing. The panel
    // shows ✓ then ○ and the run is cleared to go live.
    const results = [R_NORM, R_SPAM];
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: results,
      laneCoverage: laneCoverage(SPEC, results),
    });

    // The spam example is named, and named as having sent nothing — not as a
    // delivery. RE-POINTED 2026-08-02: it used to read "didn't exercise the
    // promise"; a lane that delivers nothing is no longer described as unproved,
    // because running cleanly IS what that lane is built to do. THE INVARIANT IS
    // UNCHANGED — the spam example must be NAMED and must never be folded into the
    // deliveries the other examples made.
    assert.match(s, /Spam — a crypto blast/,
      'the example that sent nothing must be named, not silently folded into the ones that did');
    assert.match(s, /nothing to send/);

    // And the ONE delivery claim in the sentence is attributed to the promise that
    // was actually checked, never to the spam example.
    assertClaimsNothing(s.slice(s.indexOf('Spam — a crypto blast')), 'the do-nothing lane delivered nothing');
  });

  test('a run whose ONLY example took the do-nothing lane claims no delivery at all', () => {
    const results = [R_SPAM];
    const s = composeRunSummary({
      spec: SPEC, verdict: 'unverified', outcomeResults: results,
      laneCoverage: laneCoverage(SPEC, results),
    });

    assertClaimsNothing(s, 'nothing was delivered, routed or promised on this run');
    assert.match(s, /nothing broke/i, 'the run executed cleanly — calling it a failure is the other lie');
    assert.match(s, /isn't cleared to go live/i);
  });

  test("a run that sent nothing on any path is not cleared, however clean it was", () => {
    // THE ANTI-VACUITY FLOOR, and the only thing left of "was anything proved".
    // It asks whether a delivery HAPPENED — never where it landed. A caller
    // insisting on `passed` over a set in which nothing was ever sent must still
    // get the honest sentence: refusing to certify is always available.
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [R_SPAM],
      laneCoverage: { applicable: true, total: 2, uncovered: [] },
    });
    assertClaimsNothing(s, 'no delivery was attempted anywhere in this run');
    assert.match(s, /didn't send or write anything/i);
    assert.match(s, /isn't cleared to go live/i);
  });

  // ── A DELIBERATE LOSS, RECORDED RATHER THAN PAPERED OVER (2026-08-02) ──────
  //
  // This block used to pin: *a delivery made by a "should not happen" example is
  // never credited as proof*. The harness seeds the steps directly and never
  // fires the trigger, so a "should not fire" sample runs like any other and
  // delivers like any other — and the old rule demoted it to `not_exercised` so
  // its delivery could not be counted.
  //
  // THAT DISTINCTION IS GONE. The verdict no longer reads `shouldTrigger`, so
  // such a sample is now an ordinary run: it completed, it delivered, it counts.
  //
  // The cost, stated plainly: a workflow whose ONLY delivery came from a
  // should-not-fire sample now clears the anti-vacuity floor. That is weaker than
  // before. It was accepted because the negative case was never provable here in
  // either direction — the trigger filter is what decides it, and this harness
  // does not evaluate the trigger filter — so the old demotion bought a narrower
  // guarantee than its wording implied while costing a whole verdict in the
  // vocabulary.
  //
  // WHAT IS STILL PINNED, because it is the half that actually protected anyone:
  // a run that delivered NOTHING can never have a delivery attributed to it.
  test('a run that delivered nothing is never given another run\'s delivery', () => {
    // Both lanes covered, so this really is a PASS — the point is what the pass
    // sentence attributes to which run. The spam run performed no delivery, so the
    // destination the OTHER run reached may never be attached to it.
    assert.equal(R_NORM.verdict, 'kept');
    assert.equal(R_SPAM.verdict, 'kept', 'a clean run that sends nothing is not a failure');
    assert.equal(R_SPAM.attempted, 0, 'but it attempted nothing, and that is what the sentence reads');
    assert.deepEqual(R_SPAM.landed, [], 'and it has no destination of its own to be quoted');

    const results = [R_NORM, R_SPAM];
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: results,
      laneCoverage: laneCoverage(SPEC, results),
    });

    assert.match(s, /reached "Summary" in your Atlas inbox/,
      'the run that really delivered must still say where it went');
    assert.match(s, /Spam — a crypto blast/, 'and the quiet run is NAMED, not folded into it');
    assert.match(s, /nothing to send/);
    // The destination is quoted ONCE, in the clause about the run that reached it.
    assertClaimsNothing(s.slice(s.indexOf('Spam — a crypto blast')),
      'the spam run delivered nothing, so nothing may be attributed to it');
  });

  test('the do-nothing lane attempted nothing, and the composer reads that field', () => {
    // RE-POINTED 2026-08-02 from `verdict === 'not_exercised'` / `enforced === 0`.
    // Both of those fields are gone with the contract oracle. The property they
    // existed to express — *this run performed no delivery, and nothing may be
    // narrated as though it had* — is now carried by `attempted` / `landed`.
    assert.equal(R_SPAM.verdict, 'kept', 'the spam lane ran cleanly, which is what it is for');
    assert.equal(R_SPAM.attempted, 0, 'and it delivered nothing');
    assert.deepEqual(R_SPAM.landed, []);
    assert.equal(exampleVerdict(R_SPAM), 'kept');
  });
});

describe('the sentence and the panel cannot disagree — both read `verdict`', () => {
  test('a caller insisting on "passed" over a BROKEN run is refused, not obeyed', () => {
    // Fail closed, in the direction that matters most. RE-POINTED 2026-08-02 from
    // "`contractPassed` is TRUE on the unexercised run" — that field is gone with
    // the contract oracle, but the trap it guarded is the same one: a caller may
    // never manufacture a certification the evidence does not support. Refusing to
    // certify is always available; certifying without checking is not.
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [R_MISS],
      laneCoverage: { applicable: true, total: 2, uncovered: [] },
    });
    assert.doesNotMatch(s, /It's cleared to go live/, 'a broken run cannot be talked into a pass');
    assert.match(s, /didn't get all the way through/);
    assert.match(s, /Nothing goes live until that's fixed/);
  });

  test('changing the verdict field changes the sentence with it', () => {
    // The panel's row mark and this sentence are driven by the SAME field. Move the
    // field and the sentence must move — otherwise the agreement is a coincidence
    // between two hand-written code paths.
    //
    // RE-POINTED 2026-08-02 to a fixture where the FIELD IS THE ONLY DIFFERENCE.
    // `R_NORM` ran and delivered; the copy differs from it in `verdict` alone, so
    // if the sentence still read as a pass, something other than the field would
    // be deciding it.
    const cov = { applicable: true, total: 2, uncovered: [] };
    const asKept = composeRunSummary({ spec: SPEC, verdict: 'passed', outcomeResults: [R_NORM], laneCoverage: cov });
    const asBroken = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [{ ...R_NORM, verdict: 'broken' }], laneCoverage: cov,
    });

    assert.match(asKept, /every step completed/,
      'a result the panel marks kept must read as a pass — the sentence follows the field');
    assert.match(asKept, /It's cleared to go live/);

    assert.doesNotMatch(asBroken, /It's cleared to go live/,
      'one field moved and nothing else did — the sentence must move with it');
    assert.match(asBroken, /Nothing goes live until that's fixed/);
  });

  test('a caller claiming more than the evidence supports is refused, not obeyed', () => {
    // Fail closed. The panel would show ○; a "passed" from the client cannot
    // manufacture a certification out of a set with nothing proved in it.
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [R_SPAM],
      laneCoverage: laneCoverage(SPEC, [R_SPAM]),
    });
    assert.doesNotMatch(s, /It's cleared to go live/);
    assert.match(s, /isn't cleared to go live/i);
  });
});

describe('an unverified run (carried over from the 2026-07-22 suite)', () => {
  const results = [R_SPAM];
  const cov     = laneCoverage(SPEC, results);

  test('it is NOT described as a failure', () => {
    const s = composeRunSummary({ spec: SPEC, verdict: 'unverified', outcomeResults: results, laneCoverage: cov });
    assert.doesNotMatch(s, /\bfailed\b|\bfell short\b|\bbroke\b(?!\.)|went wrong|\berror\b/i,
      'the run executed cleanly — calling it a failure is what produced the invented cause last time');
    assert.match(s, /nothing broke/i);
  });

  test('it gives the real reason, so nothing has to be guessed', () => {
    const s = composeRunSummary({ spec: SPEC, verdict: 'unverified', outcomeResults: results, laneCoverage: cov });
    assert.match(s, /nothing went down one path: “normal”/,
      'naming the untested path is what replaces speculation with a fact');
  });

  test('with no results at all it still gives a reason rather than silence', () => {
    // RE-POINTED 2026-08-02. "No worked examples" is no longer the reason a run can
    // have nothing in it — a workflow with no examples is run once on a sample
    // event and produces a result like any other. Reaching here now means the runs
    // themselves could not be carried out. The INVARIANT is unchanged: never
    // silence, always a reason and a next step.
    const s = composeRunSummary({ spec: SPEC, verdict: 'unverified', outcomeResults: [], laneCoverage: null });
    assert.match(s, /couldn't be run/i);
    assert.match(s, /Try the test again/i);
    assert.match(s, /isn't cleared to go live/i);
  });

  test('failure-only material is NOT attached to a run that did not fail', () => {
    const s = composeRunSummary({
      spec: SPEC, verdict: 'unverified', outcomeResults: results, laneCoverage: cov,
      runError: 'connection reset',
    });
    assert.doesNotMatch(s, /connection reset/,
      'a stale error carried into a clean run is exactly the raw material the narrator invented from');
  });

  // ── TWO TESTS WERE REMOVED HERE (2026-08-02), AND SAYING SO IS THE POINT ────
  //
  // · *a blank promise is called a blank promise, not an unexercised one* — pinned
  //   `contractIncomplete`, which flagged a spec carrying assertions but no
  //   `statement`, so the panel could not certify a blank deal. The verdict no
  //   longer reads the contract at all, so it cannot notice a blank one. A
  //   workflow with an empty statement now tests exactly like any other. **If the
  //   blank-statement case is to be caught again it belongs at BUILD time, in the
  //   validator, not in a run's verdict — a run has nothing to do with it.**
  //
  // · *a "should not happen" example says it cannot be proved here* — pinned the
  //   `negative` demotion. See the note above `a run that delivered nothing is
  //   never given another run's delivery` for why that went and what it cost.
  //
  // Neither was deleted because it failed. Both were deleted because the thing
  // they asserted no longer exists, and a test kept green over a rule nobody runs
  // is worse than no test.
});

describe('the other two verdicts are unharmed', () => {
  test('a real failure still reads as one, with the cause the run recorded', () => {
    assert.equal(R_MISS.verdict, 'broken');
    const s = composeRunSummary({
      spec: SPEC, verdict: 'failed', outcomeResults: [R_MISS],
      laneCoverage: laneCoverage(SPEC, [R_MISS]),
    });
    assert.match(s, /didn't get all the way through/);
    assert.match(s, /A normal enquiry/, 'name the example that fell short');
    // RE-POINTED 2026-08-02: the cause is now the DELIVERY's own recorded reason
    // (`whyNotDelivered`, from the dry-run receipt's checks) rather than "nothing
    // reached <the promise's target>". The invariant is the one that matters and
    // is unchanged: the run's OWN recorded cause reaches the person, never a
    // composed one.
    assert.match(s, /"Summary" in your Atlas inbox/, 'name where it was going');
    assert.match(s, /that app is not connected/,
      'a genuine failure must still carry its own recorded cause');
    assert.match(s, /Nothing goes live until that's fixed/);
  });

  test('a failure with NO recorded cause says so rather than inventing one', () => {
    const causeless = { ...R_MISS, verdict: 'broken', missed: [], contentErrorDetail: null, error: null, ran: true };
    const s = composeRunSummary({ spec: SPEC, verdict: 'failed', outcomeResults: [causeless] });
    assert.match(s, /recorded no reason/i);
    assert.doesNotMatch(s, /timed out|was rejected|cut off|approval/i,
      'the previous round of this defect invented exactly these');
  });

  test('a run-level failure with no example evidence is not called a broken promise', () => {
    const s = composeRunSummary({ spec: SPEC, verdict: 'failed', outcomeResults: [], runError: 'Slack unreachable' });
    assert.match(s, /Slack unreachable/, 'a genuine failure must still carry its cause');
    assert.doesNotMatch(s, /didn't get all the way through/,
      'no example ran at all, so nothing may describe one as having fallen short');
  });

  test('a pass says every step completed, and names where it actually went', () => {
    const s = composeRunSummary({
      spec: SPEC, verdict: 'passed', outcomeResults: [R_NORM],
      laneCoverage: { applicable: true, total: 2, uncovered: [] },
    });
    assert.match(s, /every step completed/);
    assert.match(s, /what it sent reached "Summary" in your Atlas inbox/,
      'assert what was DELIVERED, not merely that a step ran');
    assert.match(s, /It's cleared to go live/);
  });

  test('an older client that sends no verdict still works — the evidence answers', () => {
    const kept = composeRunSummary({ spec: SPEC, outcomeResults: [R_NORM], laneCoverage: { applicable: true, total: 2, uncovered: [] } });
    assert.match(kept, /every step completed/);
    const broken = composeRunSummary({ spec: SPEC, outcomeResults: [R_MISS] });
    assert.match(broken, /didn't get all the way through/);
    const quiet = composeRunSummary({ spec: SPEC, outcomeResults: [R_SPAM], laneCoverage: { applicable: true, total: 2, uncovered: [] } });
    assertClaimsNothing(quiet, 'no verdict from the client is not a licence to certify');
  });
});

// ── The client boundary, lifted from the browser it runs in ───────────────────

/**
 * Build the payload the test panel actually posts, by EXECUTING the object
 * literal out of public/index.html. Re-implementing it here would pass while the
 * browser kept dropping the evidence — which is precisely what happened.
 */
function clientPayload({ spec, passed, verdict, outcomeResults, coverage, d }) {
  const html  = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const i     = html.indexOf("fetch('/api/builder/test-summary'");
  assert.ok(i > 0, 'the test-summary POST moved — re-point this test, do not delete it');
  const start = html.lastIndexOf('const payload = {', i);
  const end   = html.indexOf('};', start);
  assert.ok(start > 0 && end > start,
    'the test-summary payload literal moved — re-point this test, do not delete it');
  const body = html.slice(start, end + 2);
  const fn = new Function('spec', 'passed', 'verdict', 'outcomeResults', 'coverage', 'd',
    `${body}\nreturn payload;`);
  return fn(spec, passed, verdict, outcomeResults, coverage, d);
}

describe('the client sends the evidence the panel used', () => {
  test('the payload carries the per-example verdicts and the lane coverage', () => {
    const results = [R_NORM, R_SPAM];
    const cov = laneCoverage(SPEC, results);
    const p = clientPayload({ spec: SPEC, passed: true, verdict: 'passed', outcomeResults: results, coverage: cov, d: {} });

    assert.equal(p.result.verdict, 'passed');
    assert.ok(Array.isArray(p.result.outcomeResults),
      'the per-example verdicts are the whole evidence — a payload without them is the defect');
    assert.equal(p.result.outcomeResults.length, 2,
      'the per-example verdicts are computed by the panel and were being discarded at this boundary');
    assert.equal(p.result.outcomeResults[1].verdict, 'kept');
    assert.deepEqual(p.result.laneCoverage, cov);
  });

  test('the run\'s deliveries, steps and output are NOT sent to be narrated', () => {
    // The old payload sent `deliveries` from the LAST run of the sequence, which is
    // how one example's delivery got told as the whole run's. Nothing to narrate
    // means nothing to narrate wrongly.
    const d = { deliveries: [{ channel: '#ops', ts: '1' }], steps: [{ nodeId: 'save' }], output: 'a summary' };
    const p = clientPayload({ spec: SPEC, passed: true, verdict: 'passed', outcomeResults: [R_SPAM], coverage: null, d });

    assert.equal(p.result.deliveries, undefined, 'a delivery receipt is what the invention was built from');
    assert.equal(p.result.steps, undefined);
    assert.equal(p.result.output, undefined);
  });
});

// ── The real endpoint, end to end ─────────────────────────────────────────────

async function tenantMiddleware(req, _res, next) {
  await new Promise(r => setImmediate(r));   // the real requireAuth awaits a lookup here
  req.tenant = { id: 'tenantA' };
  req.user   = { id: 'u1', email: 'op@example.com' };
  next();
}

function postJson(port, pathName, body) {
  return new Promise(resolve => {
    const payload = JSON.stringify(body);
    const req = http.request({
      port, path: pathName, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.on('error', () => resolve({ status: 0, data: null, raw: '' }));
    req.end(payload);
  });
}

describe('POST /api/builder/test-summary — the sentence a user reads', () => {
  let server, port, modelCalls;

  before(async () => {
    const app = express();
    app.use(express.json());
    modelCalls = 0;
    // THE MODEL IS BOOBY-TRAPPED. If anything in this path still asks a model to
    // describe the run, the request fails loudly instead of quietly returning
    // prose nobody checked.
    const spine = {
      llm: {
        invoke: async () => { modelCalls++; throw new Error('the run summary must not be written by a model'); },
      },
    };
    mountBuilderRoutes(app, { spine, requireActiveTenant: tenantMiddleware, requireAuth: tenantMiddleware });
    await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
  });

  after(() => { try { server?.close(); } catch { /* ignore */ } });

  test('the browser\'s own payload, posted for real, produces the honest sentence', async () => {
    const results = [R_NORM, R_SPAM];
    const body = clientPayload({
      spec: SPEC, passed: true, verdict: 'passed', outcomeResults: results,
      coverage: laneCoverage(SPEC, results), d: {},
    });

    const { status, data } = await postJson(port, '/api/builder/test-summary', body);
    assert.equal(status, 200);
    assert.equal(modelCalls, 0, 'no model may be asked what this run did');
    assert.ok(data.summary, 'the endpoint must return a sentence');

    const at = data.summary.indexOf('Spam — a crypto blast');
    assert.ok(at >= 0,
      `the unproved example must appear in what the user reads — got: ${data.summary}`);
    assertClaimsNothing(data.summary.slice(at), 'the spam example delivered nothing');
  });

  test('a delivery receipt smuggled into the body cannot become a claim', async () => {
    // Even if a client (or a replayed old client) posts the material the invented
    // sentence was built from, the sentence is composed from the evidence only.
    const { status, data } = await postJson(port, '/api/builder/test-summary', {
      spec: SPEC,
      result: {
        completed: true, verdict: 'passed',
        outcomeResults: [R_SPAM],
        laneCoverage: { applicable: true, total: 2, uncovered: [] },
        deliveries: [{ channel: '#ops', ts: '1712.1', delivered: true }],
        output: 'Summary sent to #ops and charles@agntic.co',
        steps: [{ nodeId: 'save' }],
      },
    });
    assert.equal(status, 200);
    assert.equal(modelCalls, 0);
    assert.doesNotMatch(data.summary, /#ops|charles@agntic\.co/,
      'the destination from a delivery receipt is exactly what the invented sentence named');
    assertClaimsNothing(data.summary, 'the run proved nothing, whatever else was in the body');
  });

  test('a genuine failure still reads as a failure through the endpoint', async () => {
    const { status, data } = await postJson(port, '/api/builder/test-summary', {
      spec: SPEC,
      result: { completed: false, verdict: 'failed', outcomeResults: [R_MISS], laneCoverage: null, error: null },
    });
    assert.equal(status, 200);
    assert.match(data.summary, /didn't get all the way through/);
    assert.match(data.summary, /"Summary" in your Atlas inbox — that app is not connected/,
      "the delivery's own recorded reason must survive the trip through the endpoint");
  });

  test('the endpoint still refuses a request with no spec or no result', async () => {
    const a = await postJson(port, '/api/builder/test-summary', { spec: SPEC });
    assert.equal(a.status, 400);
    const b = await postJson(port, '/api/builder/test-summary', { result: {} });
    assert.equal(b.status, 400);
  });
});
