/**
 * WHAT THE USER IS TOLD ABOUT A TEST RUN — COMPOSED FROM THE RUN'S OWN EVIDENCE.
 *
 * THE DEFECT THIS EXISTS TO CLOSE (observed live, screenshotted). After a test of
 * a spam-triage workflow, the chat told a tester that the workflow
 *
 *   "…classified it as spam, routed it to the correct path, and then summarized
 *    and delivered it to both the #ops channel and to charles@agntic.co as
 *    promised."
 *
 * Spam is the branch whose entire promise is to do NOTHING. Two inches above, the
 * evidence panel — reading the same run — said it correctly: "it took a path that
 * doesn't cover… Nothing was proved either way."
 *
 * WHY IT INVENTED. The sentence was written by a model, server-side, from a
 * context that contained: the node list, a delivery receipt from the LAST run of
 * the sequence, an output excerpt, and an instruction to "be specific — say what
 * the workflow actually did". It never learned which example, which lane, or that
 * the spam sample's verdict was `not_exercised`. Given a delivery receipt and an
 * order to be specific, a model fills the gap. That is not a prompt bug that a
 * sterner prompt fixes; it is a missing-evidence bug, and the previous round of
 * this same defect (2026-07-22 — an unverified run described as a failure, with an
 * invented cause) was already patched at the prompt and came back through a
 * different door.
 *
 * THE RULE, decided by the operator: **the product does not describe its own test
 * results in free prose.** The sentence is composed here, from the same objects
 * the panel renders, so the two cannot disagree.
 *
 * HOW "CANNOT DISAGREE" IS ACHIEVED — and it is NOT "two code paths that happen to
 * agree today". Both surfaces read the SAME field, `verdict`, off the SAME
 * per-example result produced by `evaluateExampleRun()`:
 *
 *   · the panel's row mark (`✓` / `○` / `!`)  — public/index.html, `_contractPanel`
 *   · every clause below
 *
 * `contractPassed` is deliberately NOT read for the per-example judgement:
 * it is TRUE over a set that is entirely skips (that is by design — the converger's
 * self-test needs it that way, outcome-oracle.js), and reading it here is exactly
 * how the do-nothing lane gets narrated as a delivery.
 *
 * TWO PROPERTIES THAT ARE STRUCTURAL, NOT EDITORIAL:
 *
 *  1. **This module never sees the run's deliveries, steps or output.** It cannot
 *     narrate them, correctly or otherwise. The old narrator was handed
 *     `deliveries[0]` from the LAST example of a multi-example sequence and
 *     described it as the whole run's — a mixed run's one real delivery told as
 *     though every example had made it. There is nothing here to make that mistake
 *     with. A delivery is only ever mentioned via an assertion the oracle marked
 *     `applicable && ok` — i.e. one that was actually CHECKED.
 *
 *  2. **The stance can only ever be weakened by the evidence, never strengthened.**
 *     A caller that says `verdict: 'passed'` over a set with nothing `kept` in it
 *     gets an "unverified" sentence. Refusing to certify is always available;
 *     certifying without checking is not.
 *
 * It is a pure function on purpose. The step-approval card's derivation was made
 * "pure and separate from the renderer on purpose — the render closure is
 * unreachable from outside the render pass, the same trap that let the destination
 * fix revert silently" (CLAUDE.md). A composer inside the endpoint's request
 * handler, or inside a browser render pass, could not be asserted — and until now
 * NOTHING in this codebase asserted the content of this sentence, because it was
 * model-generated.
 */

import { describeTarget } from './outcome-oracle.js';

/** The three things one example can have proved. Same vocabulary as the oracle. */
const EXAMPLE_VERDICTS = new Set(['kept', 'broken', 'not_exercised']);

/**
 * How strong a claim each overall stance makes about the workflow.
 * `passed` asserts the promise held; `unverified` asserts nothing; `failed`
 * asserts a break. Weakening means moving toward the answer that claims less
 * about the workflow working — and a break is never softened.
 */
const CLAIM_RANK = { failed: 0, unverified: 1, passed: 2 };

/**
 * One example's verdict, read the way the panel reads it.
 *
 * The fallback fires only for a result from a server older than the third
 * verdict, where the boolean is genuinely all there is — it is the SAME fallback
 * the panel uses (`o.verdict || (o.contractPassed ? "kept" : "broken")`), because
 * two different fallbacks would be two surfaces that can disagree.
 */
export function exampleVerdict(o) {
  const v = o && o.verdict;
  if (EXAMPLE_VERDICTS.has(v)) return v;
  return (o && o.contractPassed) ? 'kept' : 'broken';
}

/** The lanes no example went down, exactly as the panel receives them. */
function uncoveredLanesOf(laneCoverage) {
  const u = laneCoverage && laneCoverage.uncovered;
  return Array.isArray(u) ? u : [];
}

/** A lane in the words the panel puts on it. */
function laneLabel(l) {
  return String((l && (l.label ?? l.to ?? l.branch)) ?? '').trim() || 'an unnamed path';
}

function exampleLabel(o, i) {
  const l = o && typeof o.label === 'string' ? o.label.trim() : '';
  return l || `Example ${i + 1}`;
}

function workflowName(spec) {
  const n = spec && typeof spec.name === 'string' ? spec.name.trim() : '';
  return n || 'this workflow';
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "a", "a and b", "a, b and c" — never an Oxford-comma-free jumble of ids. */
function listOf(items) {
  const xs = items.filter(Boolean);
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function unique(xs) {
  return [...new Set(xs)];
}

/** Trim a recorded reason to something a person reads, without rewriting it. */
function tidy(text, max = 220) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Why ONE example fell short — taken from the run, never composed.
 *
 * If the run recorded no reason, this returns null and the caller says so. It
 * does not fill the gap: filling the gap is the entire defect.
 */
function brokenReason(o) {
  const miss = (o.contract || []).find(c => c && c.applicable !== false && !c.ok);
  if (miss) return tidy(miss.reason || `nothing reached ${describeTarget(miss.target)}`);
  if (o.error) return tidy(o.error);
  if (o.ran === false) return 'the run did not finish';
  return null;
}

/** The promises this run actually CHECKED and found satisfied. */
function provenTargets(results, marks) {
  const out = [];
  results.forEach((o, i) => {
    if (marks[i] !== 'kept') return;
    (o.contract || []).forEach(c => {
      if (c && c.applicable !== false && c.ok) out.push(describeTarget(c.target));
    });
  });
  return unique(out);
}

/** The promises an unexercised example's lane does not cover. */
function skippedTargets(results, marks) {
  const out = [];
  results.forEach((o, i) => {
    if (marks[i] !== 'not_exercised') return;
    (o.contract || []).forEach(c => {
      if (c && c.applicable === false) out.push(describeTarget(c.target));
    });
  });
  return unique(out);
}

/**
 * Promises NO example in this run checked — aggregated across the whole set.
 *
 * A skipped assertion on ONE example is normally not a gap: a three-lane router's
 * spam sample skips the delivery promise, and the normal sample proves it. What
 * matters is a promise that *nothing* in the run ever enforced.
 *
 * That case became reachable on the flagship approval shape: the promise "ask
 * charles@agntic.co on Slack" is kept by the approval step's QUESTION, and a test
 * run answers that question itself rather than sending it, so no example can
 * prove it (outcome-oracle.js, `approvalAskEvidence`). Without this clause the
 * sentence read "every promise it makes held" over a promise nothing had looked
 * at — the exact vacuous certification this module exists to refuse.
 *
 * It NAMES the gap; it does not re-decide the verdict. The stance is the panel's,
 * read off the same `verdict` field, and a second opinion computed here is how
 * two surfaces start to disagree.
 */
function uncheckedTargets(results) {
  const proved = new Set();
  const skipped = [];
  results.forEach((o) => {
    (o.contract || []).forEach(c => {
      if (!c) return;
      if (c.applicable === false) skipped.push(describeTarget(c.target));
      else if (c.ok) proved.add(describeTarget(c.target));
    });
  });
  return unique(skipped).filter(t => !proved.has(t));
}

/**
 * Compose the sentence a person reads in chat after pressing Run test.
 *
 * @param {object}   evidence
 * @param {object}   evidence.spec           — the workflow blueprint (name only is read)
 * @param {string}   evidence.verdict        — the panel's three-way state: passed|unverified|failed
 * @param {object[]} evidence.outcomeResults — one `evaluateExampleRun()` result per example
 * @param {object}   evidence.laneCoverage   — { applicable, total, uncovered: [{branch,to,label}] }
 * @param {string}   [evidence.runError]     — the run-level error; used ONLY when the stance is `failed`
 * @returns {string} 2–3 plain sentences, every clause backed by the evidence above.
 */
export function composeRunSummary(evidence = {}) {
  const results = Array.isArray(evidence.outcomeResults) ? evidence.outcomeResults : [];
  const marks   = results.map(exampleVerdict);
  const total   = results.length;
  const kept    = marks.filter(m => m === 'kept').length;
  const broke   = marks.filter(m => m === 'broken').length;
  const uncovered = uncoveredLanesOf(evidence.laneCoverage);
  const name    = workflowName(evidence.spec);

  // WHAT THE EVIDENCE ON ITS OWN SUPPORTS. An uncovered lane blocks certification
  // exactly as an unexercised promise does — a router is only proved on the routes
  // that were taken (F16).
  const derived = broke > 0 ? 'failed'
    : (kept > 0 && uncovered.length === 0) ? 'passed'
      : 'unverified';

  // The caller's own three-way state, if it sent a recognised one. An unrecognised
  // or absent value is not guessed at — the evidence answers for it.
  const stated = Object.prototype.hasOwnProperty.call(CLAIM_RANK, evidence.verdict)
    ? evidence.verdict : null;

  // FAIL CLOSED. Take whichever of the two claims LESS. A caller insisting on
  // "passed" over evidence that proved nothing gets the honest sentence; a caller
  // reporting a failure the per-example evidence cannot see (a run-level error,
  // which produces no example result at all) still reads as a failure.
  const stance = (stated === null || CLAIM_RANK[derived] <= CLAIM_RANK[stated]) ? derived : stated;

  if (stance === 'failed')   return failedSummary({ name, results, marks, total, broke, runError: evidence.runError });
  if (stance === 'passed')   return passedSummary({ name, results, marks, total, kept });
  return unverifiedSummary({ name, results, marks, total, uncovered });
}

function ranClause(name, total) {
  return total
    ? `Atlas ran ${count(total, 'example')} of ${name}`
    : `Atlas ran ${name}`;
}

function quoted(s) {
  return `“${s}”`;
}

function failedSummary({ name, results, marks, total, broke, runError }) {
  const i = marks.indexOf('broken');
  let lead, why;
  if (i >= 0) {
    lead = `${ranClause(name, total)} and it didn't keep its promise.`;
    const reason = brokenReason(results[i]);
    const which  = quoted(exampleLabel(results[i], i));
    const many   = broke > 1 ? `${broke} of them fell short. ` : '';
    why = reason
      ? `${many}${which} fell short: ${reason}.`
      // No reason was recorded. Say that, rather than supplying one — supplying
      // one is the whole defect this module exists to close.
      : `${many}${which} fell short, and the run recorded no reason, so there's nothing here that says what went wrong.`;
  } else {
    // No per-example evidence at all — this is a run-level failure, so it may not
    // be described as a broken promise (nothing checked one). The error is the
    // only thing that may be attached, and it may be attached ONLY here.
    lead = `${ranClause(name, total)} and the test didn't get through.`;
    const err = tidy(runError);
    why = err
      ? `The run stopped with an error: ${err}.`
      : 'The run did not finish, and nothing in it records why.';
  }
  return `${lead} ${why} Nothing goes live until that's fixed.`;
}

function passedSummary({ name, results, marks, total, kept }) {
  const proven    = provenTargets(results, marks);
  const unchecked = uncheckedTargets(results);
  // NEVER "every promise held" over a promise nothing in the run looked at. The
  // claim is narrowed to what was actually enforced, and the gap is named below.
  const every = unchecked.length ? 'every promise it was able to check' : 'every promise it makes';
  const first = proven.length
    ? `${ranClause(name, total)} and ${every} held — what came back reached ${listOf(proven)}.`
    : `${ranClause(name, total)} and ${every} held.`;

  // A mixed run: some examples proved the promise, others took a path that does
  // not cover it. Their silence is reported AS silence, by name — never folded
  // into the deliveries the OTHER examples made. The old narrator was handed one
  // example's delivery receipt and described it as the whole run's.
  const quiet = results.filter((_, i) => marks[i] !== 'kept');
  const middle = quiet.length
    ? ` ${quiet.length <= 3
        ? listOf(quiet.map(o => quoted(exampleLabel(o, results.indexOf(o)))))
        : `${count(quiet.length, 'other example')}`
      } didn't exercise the promise, so ${quiet.length === 1 ? 'it proved' : 'they proved'} nothing either way.`
    : '';

  // The gap, named. Taken from the run's own contract entries — no example proved
  // these, and saying so is the difference between a verification and a shrug.
  const gap = unchecked.length
    ? ` Nothing in this run could check ${listOf(unchecked)}, so that part is still unproved.`
    : '';

  return `${first}${middle}${gap} It's cleared to go live.`;
}

function unverifiedSummary({ name, results, marks, total, uncovered }) {
  const first = `${ranClause(name, total)} and nothing broke.`;

  let why;
  let ask = " It isn't cleared to go live yet.";

  if (uncovered.length) {
    // NAME the lanes nothing took. "We couldn't verify it" invites a shrug; naming
    // the path tells the user exactly which example to give us.
    why = `But nothing went down ${uncovered.length === 1 ? 'one path' : `${uncovered.length} paths`}: `
      + `${listOf(uncovered.map(l => quoted(laneLabel(l))))}. `
      + 'A workflow that routes is only proved on the routes you test.';
    ask = ` Give me an example that takes ${uncovered.length === 1 ? 'it' : 'each of them'} and I'll check the rest — it isn't cleared to go live yet.`;
  } else if (results.some(o => o && o.contractIncomplete)) {
    // A blank promise. Do not say "nothing was exercised" — the steps may well have
    // run; what is missing is the promise itself.
    why = "But this workflow has no stated outcome — there's no promise recorded for it to keep, so there was nothing to check it against.";
    ask = " Tell Atlas what it should deliver and I'll hold it to that. It isn't cleared to go live yet.";
  } else if (total === 0) {
    why = 'But there were no worked examples to run it against, so none of its promises were checked and nothing was proved either way.';
    ask = " Describe a real case to try and I'll check it. It isn't cleared to go live yet.";
  } else {
    const skipped   = skippedTargets(results, marks);
    const negatives = results.filter((o, i) => marks[i] === 'not_exercised' && o && o.negative).length;
    why = `But ${total === 1 ? "it didn't exercise" : 'none of them exercised'} what this workflow promises`
      + (skipped.length ? ` — ${total === 1 ? 'it took a path' : 'they took paths'} that doesn't cover ${listOf(skipped)}` : '')
      + '. Nothing was proved either way.';
    if (negatives) {
      // A "should not happen" case. The panel never fires the trigger, so whether
      // the workflow would have stayed quiet is unknowable here — and a tick that
      // means the opposite is worse than saying so.
      why += ` ${negatives === 1 ? 'One example is a “should not happen” case' : `${negatives} examples are “should not happen” cases`}`
        + ", which this test can't prove — it runs the steps directly without checking the trigger.";
    }
    ask = " Give me an example that exercises the promise and I'll check it — it isn't cleared to go live yet.";
  }

  return `${first} ${why}${ask}`;
}
