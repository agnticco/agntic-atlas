/**
 * delivery-verdict — did this run DO the thing, on every path?
 *
 * THIS REPLACES THE CONTRACT ORACLE AS THE TEST'S PASS/FAIL RULE (2026-08-02,
 * Charles's call). Read this header before changing anything here, because the
 * thing that was removed was removed deliberately and re-adding it is the
 * regression.
 *
 * ── WHAT WAS REMOVED, AND WHY ────────────────────────────────────────────────
 *
 * The old rule scored each run against `outcome.assertions`: for every promise,
 * find a delivery whose CONNECTOR and LOCATOR match the promise's `target`
 * string. That comparison needed connector aliasing, canonicalisation,
 * opaque-provider-id detection, template exemptions, per-lane applicability,
 * approval-ask evidence, empty-loop evidence, negative examples, and a third
 * "not exercised" verdict to describe what it could not decide.
 *
 * Measured over 2026-08-01/02: that machinery produced ZERO findings about a
 * workflow being wrong, and produced repeated false failures on workflows that
 * were right — a Doc reported as delivered to its own title, a promise naming
 * "Pricing Emails" against a step writing to "Pricing Enquiries", a destination
 * that was a `{{template}}` at build time, `google:` read as `gmail:`. Each cost
 * paid whole-spec rebuilds and twice blocked a correct workflow from going live.
 * Nine defects in that family are recorded in CLAUDE.md; every one is a
 * disagreement about what a destination STRING means.
 *
 * The question a test needs to answer is simpler, and the engine was already
 * answering it: **did every step run, and did every delivery it attempted
 * actually land?** `wouldDeliver` (flow-tester.js `_dryRunDeliver`) is exactly
 * that, and it is not a string comparison — it checks the body exists, that no
 * `{{placeholder}}` survived into it, that a destination is named, that the
 * connector is connected, and that the destination REALLY EXISTS by reading the
 * live service. We computed it and then ignored it in favour of the assertion
 * layer stacked on top. This module gates on it.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 *   ONE RUN passes when it completed without error, produced no content-error
 *   sentinel, and every delivery it attempted reported `delivered`.
 *
 *   THE SET passes (and Go live unlocks) when every run passed, every lane of
 *   the workflow was run, and at least one delivery was attempted across the
 *   whole set.
 *
 * The set-level clauses live in the caller (`public/index.html` `_finishRun`)
 * because they are judgements over the whole sample set; this module judges one
 * run. Both are named here so the rule can be read in one place.
 *
 * ── WHAT IS DELIBERATELY STILL CHECKED ───────────────────────────────────────
 *
 * · **The destination is real.** `wouldDeliver` is false when the probe says the
 *   sheet/base/channel/calendar does not exist. That is a live read of the
 *   customer's own account, not a guess about a string, and it is the strongest
 *   check in the product. It stays.
 * · **The content is not an error.** An llm step that cannot find its input emits
 *   the sentinel `ERROR: required data not found`. A run that delivered THAT
 *   delivered nothing worth having, so it is broken even though the send
 *   "succeeded". `runProducedContentError` is the one rule for it.
 * · **Every path is run.** A workflow that routes is only proved on the routes
 *   you test. This is not semantics — a different lane is different wiring — and
 *   it is the one thing the old system caught that mattered (F16: a 3-lane router
 *   certified on the sample that took the do-nothing lane).
 *
 * ── WHAT THE PROMISE IS NOW ──────────────────────────────────────────────────
 *
 * `outcome.statement` remains, and is still shown to the person as THE DEAL. It
 * is no longer machine-scored. `outcome.assertions` are still written and still
 * drive the BUILD-time checks (the validator's `checkOutcome`, the gap scorer);
 * nothing here reads them. If you are here because a build is being blocked or
 * rebuilt over an assertion target, that is `workflow-validator.js`
 * / `gap-scorer.js`, not this file.
 *
 * A "should not happen" example is no longer special-cased: the harness seeds the
 * steps directly and never fires the trigger, so such a sample runs like any
 * other. If it completes cleanly it passes — which is honest, because "it ran and
 * broke nothing" is all this harness can observe about it either way.
 */

import {
  deliveriesForStep,
  runProducedContentError,
  lanesTakenBy,
  laneInventoryOf,
} from './outcome-oracle.js';
import { isTransientFailure } from './error-translator.js';

/**
 * Plain-language reason a delivery would not have landed, from the dry-run
 * receipt's own checks. Ordered most-specific first so the person is told the
 * thing they can act on, not the first box that happens to be unticked.
 *
 * Every branch describes something the CUSTOMER can fix or recognise. There is
 * deliberately no fallback naming a check id — an unrecognised shape says the
 * honest generic thing rather than leaking `capabilityConnected` onto a card.
 */
export function whyNotDelivered(delivery) {
  const c = (delivery && typeof delivery.checks === 'object' && delivery.checks) || {};
  if (delivery?.unreachableReason) return String(delivery.unreachableReason);
  if (c.destinationReachable === false) return 'the destination could not be found';
  if (c.capabilityConnected === false) return 'that app is not connected';
  if (c.targetPresent === false) return "it doesn't say where to send it";
  if (c.bodyWellFormed === false) return 'the message still had an unfilled placeholder in it';
  if (c.hasBody === false) return 'there was nothing to send';
  return 'it could not be delivered';
}

/**
 * Judge ONE run.
 *
 * @param {object} spec       the workflow being tested
 * @param {object} example    the sample this run was seeded with (label/given only)
 * @param {object} runResult  { completed, error, steps, deliveries? }
 * @returns {object} the per-example row the test panel renders
 */
export function evaluateDeliveryRun(spec, example, runResult) {
  const ran = runResult?.completed === true && !runResult?.error;

  // ALWAYS DERIVED FROM THE STEPS, never read off `runResult.deliveries`.
  //
  // Both production call sites assemble their own `deliveries` with
  // `deliveriesForStep` and hand them in, so preferring theirs looked free. It is
  // not: the delivering NODE is what knows the channel and the destination —
  // handlers are inconsistent about both — and `deliveriesForStep` is the one
  // rule that reads it. Taking the caller's array means this module's answer
  // depends on how carefully each caller built it, which is precisely how two
  // halves of this system have drifted nine times (see CLAUDE.md).
  //
  // In production the two are identical, so this costs one extra map. What it
  // buys is that a delivery has ONE definition and nobody can pass in a different
  // one.
  const deliveries = derive(spec, runResult);

  // `delivered` is `normalizeDelivery`'s single answer for both worlds: a real
  // handler return is delivered, a dry-run receipt is delivered iff
  // `wouldDeliver`. So this one filter covers a live run and a test alike.
  //
  // `=== false` rather than `!d.delivered` is DEFENSIVE, and it is honestly
  // UNKILLABLE TODAY — measured 2026-08-02: `normalizeDelivery` always stamps a
  // boolean, and an approval step's ask (`askDeliveriesOf`) carries
  // `delivered: true`, so nothing production can build reaches here with the
  // field absent. Swapping it for `!d.delivered` turns no test red.
  //
  // It is kept because the two differ in DIRECTION for a shape nobody has built
  // yet — a record this module cannot read is not evidence that a delivery
  // failed, and reading it as one would fail a workflow for a reason the person
  // could do nothing about. That is the direction this whole change exists to
  // stop. If a future capability ever returns an unstamped record, the fail-open
  // answer is the right one; do not "simplify" this on the grounds that the
  // mutation survives.
  const missed = deliveries
    .filter((d) => d && d.delivered === false)
    .map((d) => ({
      channel: d.channel ?? null,
      target: d.target ?? null,
      reason: whyNotDelivered(d),
    }));

  const attempted = deliveries.length;

  // Where the deliveries that DID land went. Descriptive only — nothing compares
  // this to a promise; it exists so the chat sentence and the panel can say
  // "…and it reached your inbox" from the run's own receipt rather than from a
  // model's guess. A delivery with no resolvable destination contributes nothing
  // rather than a placeholder.
  const landed = deliveries
    .filter((d) => d && d.delivered !== false)
    .map((d) => ({ channel: d.channel ?? null, target: d.target ?? null }));

  // A delivery whose CONTENT is the "I couldn't find my data" sentinel is a miss
  // even though the send succeeded — the inbox got an error, not a summary.
  const broken = runProducedContentError(runResult);

  const verdict = (!ran || broken || missed.length) ? 'broken' : 'kept';

  return {
    exampleId: example?.id ?? null,
    label: example?.label ?? null,
    given: example?.given ?? null,
    ran,
    error: runResult?.error ?? null,
    verdict,                       // 'kept' | 'broken' — there is no third answer now
    attempted,                     // how many deliveries this run made
    delivered: attempted - missed.length,
    landed,                        // [{ channel, target }] — where they went
    missed,                        // [{ channel, target, reason }]
    contentError: !!broken,
    contentErrorDetail: broken || null,
    // Which lanes this run took, and the full inventory, so the CLIENT never
    // re-derives "what lanes exist" — it subtracts one from the other and holds
    // no copy of the rule.
    lanes: lanesTakenBy(spec, runResult),
    laneInventory: laneInventoryOf(spec),
    expect: example?.expect ?? null,
    produced: summariseRun(runResult),
  };
}

/**
 * Judge a run that FAILED, and say whose fault it was.
 *
 * PURE, AND SEPARATE FROM THE ENDPOINT ON PURPOSE. This lives here rather than
 * inline in `POST /workflows/run` because the endpoint's `run_failed` branch sits
 * inside a `for await` over the engine's event stream inside an Express handler,
 * where it cannot be lifted out and executed. A rule that can only be checked by
 * grepping its own source is pinned by nothing: hardwiring the decision to a
 * constant left every source-level assertion green (measured 2026-08-02, and it
 * is why this function exists).
 *
 * TWO ANSWERS, and they are independent:
 *
 * · `transient` — was this OUR fault? A model that timed out, a 429, a provider
 *   refusing us, the box unable to reach a service. None says anything about the
 *   workflow, and scoring them as broken tells a person their workflow is wrong
 *   because our side had a bad minute. `isTransientFailure` is derived from the
 *   SAME pattern table the user-facing message comes from — never a second regex
 *   list — and is deliberately NARROW: anything unrecognised stays a REAL
 *   failure, because excusing a genuine wiring defect ships a broken workflow
 *   while excusing nothing merely costs a re-run.
 *
 * · `outcomeCheck` — the verdict, which is `broken` either way, because the run
 *   did not finish. It is returned even on a failure so the panel always has a
 *   result to score; without it an empty set reads as "nothing was proved" for a
 *   run that demonstrably broke.
 *
 * The caller decides what to DO with `transient` (the browser skips the sample
 * and says so). This only answers the question.
 */
export function judgeFailedRun(spec, example, { error, steps = [], nodeId = null } = {}) {
  const failedStep = steps.length ? steps[steps.length - 1] : null;
  const transient = isTransientFailure(error, {
    nodeId: nodeId ?? failedStep?.nodeId,
    workflow: spec?.name,
  });
  const outcomeCheck = evaluateDeliveryRun(spec, example, {
    completed: false, error, steps,
  });
  return { transient, outcomeCheck };
}

function derive(spec, runResult) {
  const nodeById = new Map((spec?.nodes ?? []).map((n) => [n.id, n]));
  const coerce = (o) => {
    if (o && typeof o === 'object') return o;
    if (typeof o === 'string') { try { return JSON.parse(o); } catch { /* not json */ } }
    return null;
  };
  return (runResult?.steps ?? [])
    .flatMap((s) => deliveriesForStep(nodeById.get(s.nodeId), coerce(s.output)));
}

/** What a run produced, in a shape the panel can lay beside the sample. */
function summariseRun(runResult) {
  const out = {};
  for (const s of (runResult?.steps ?? [])) {
    let o = s.output;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { continue; } }
    if (o && typeof o === 'object' && !Array.isArray(o) && !o.delivered) Object.assign(out, o);
  }
  return out;
}
