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

import { describeTarget, canonicalConnector } from './outcome-oracle.js';

/**
 * A delivery receipt names its CAPABILITY (`inbox_deliver`, `sheets_append`);
 * `describeTarget` speaks CONNECTORS. Without the hop between them the sentence
 * read `"Summary" in inbox deliver` — the capability id with its underscore
 * knocked out, offered to a customer as the name of a place.
 *
 * CLAUDE.md warns that `canonicalConnector` is not a display-name function (it
 * answers "do these name the same destination", and grouping BY it once sent
 * every Google capability under a Gmail heading). That warning is about
 * GROUPING. Here it is used to name ONE receipt's own service, and the six
 * shipped write channels were measured through it before it was written:
 * inbox_deliver → your Atlas inbox, gmail_send → Gmail, slack → Slack,
 * sheets_append → Google Sheets, docs_create → Google Docs,
 * airtable_create_record → Airtable.
 */
function whereItWent(channel, target) {
  const c = canonicalConnector(String(channel ?? ''));
  if (!c) return '';
  return target ? describeTarget(`${c}:${target}`) : describeTarget(c);
}

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
  const miss = (o.missed || [])[0];
  if (miss) {
    const where = whereItWent(miss.channel, miss.target);
    return tidy(where ? `${where} — ${miss.reason}` : miss.reason);
  }
  if (o.contentErrorDetail?.step) {
    return tidy(`“${o.contentErrorDetail.step}” couldn't find the data it needed, so what went out was an error, not real content`);
  }
  if (o.error) return tidy(o.error);
  if (o.ran === false) return 'the run did not finish';
  return null;
}

/**
 * Where this run's deliveries actually went — read off the run's own receipts.
 *
 * DESCRIPTIVE, NOT A CHECK. It names destinations so the sentence can be
 * specific; nothing here compares them to a promise. Comparing them is the rule
 * that was removed (src/workflows/delivery-verdict.js).
 */
function deliveredTargets(results, marks) {
  const out = [];
  results.forEach((o, i) => {
    if (marks[i] !== 'kept') return;
    (o.landed || []).forEach(d => {
      if (!d) return;
      const where = whereItWent(d.channel, d.target);
      if (where) out.push(where);
    });
  });
  return unique(out);
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

  // WHAT THE EVIDENCE ON ITS OWN SUPPORTS — the SAME three clauses the panel
  // applies (public/index.html `_finishRun`), so the sentence and the panel
  // cannot disagree: nothing broke, every lane was run, and at least one
  // delivery was attempted somewhere.
  const attempted = results.reduce((n, o) => n + (Number(o && o.attempted) || 0), 0);
  const derived = broke > 0 ? 'failed'
    : (kept > 0 && uncovered.length === 0 && attempted > 0) ? 'passed'
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
  if (stance === 'passed')   return passedSummary({ name, results, marks, total });
  return unverifiedSummary({ name, results, marks, total, uncovered, attempted });
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
    lead = `${ranClause(name, total)} and it didn't get all the way through.`;
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

function passedSummary({ name, results, marks, total }) {
  // WHERE IT WENT, from the run's own receipts. Named because "it worked" is
  // worth nothing to a person who cannot see what it did — and because these are
  // observations, not claims about a promise being matched.
  const reached = deliveredTargets(results, marks);
  const first = reached.length
    ? `${ranClause(name, total)} and every step completed — what it sent reached ${listOf(reached)}.`
    : `${ranClause(name, total)} and every step completed.`;

  // A run that delivered NOTHING is reported as such rather than folded into the
  // deliveries the other runs made. A path built to stay quiet is not a defect,
  // and it is not evidence of a delivery either.
  const quiet = results.filter((o, i) => marks[i] === 'kept' && !(Number(o && o.attempted) > 0));
  const middle = quiet.length
    ? ` ${quiet.length <= 3
        ? listOf(quiet.map(o => quoted(exampleLabel(o, results.indexOf(o)))))
        : count(quiet.length, 'other example')
      } ran with nothing to send, which is what ${quiet.length === 1 ? 'that path is' : 'those paths are'} built to do.`
    : '';

  // No "nothing was really sent" boilerplate here: the panel's evidence note says
  // it, on the same screen, every time. Repeating it lengthens every sentence and
  // buys nothing.
  return `${first}${middle} It's cleared to go live.`;
}

function unverifiedSummary({ name, results, marks, total, uncovered, attempted }) {
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
  } else if (total === 0) {
    why = "But it couldn't be run just now, so nothing has been checked.";
    ask = " Try the test again — it isn't cleared to go live yet.";
  } else {
    // NOTHING WAS SENT OR WRITTEN ON ANY PATH. The only "nothing was proved" case
    // left, and it asks whether a delivery HAPPENED — never where it landed.
    why = total === 1
      ? "But it didn't send or write anything, on any path, so there's nothing here that shows the workflow does its job."
      : "But none of them sent or wrote anything, on any path, so there's nothing here that shows the workflow does its job.";
    ask = " It isn't cleared to go live yet.";
  }

  return `${first} ${why}${ask}`;
}
