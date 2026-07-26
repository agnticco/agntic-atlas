/**
 * PLAN PROVENANCE — the closed domain behind the plan card's "you said / I found /
 * I inferred" marks, and the coercion that keeps it closed.
 *
 * THE INVARIANT: **"you said" is a claim ABOUT THE USER, and Atlas may only make it
 * when the user actually said the thing.** Everything else Atlas put on the plan is
 * its own inference and must be labelled as one. When the label is in any doubt it
 * must fall to the WEAKER claim, never the stronger — amber ("I inferred") is the
 * colour that asks for a glance, and an unknown provenance deserves a glance.
 *
 * Why this exists at all. The plan card is written by a model, so `confidence` is a
 * value the model INVENTS. It could be missing, empty, null, a typo, or a phrase the
 * prompt happened to suggest (`"you said"` itself was being instructed at one point).
 * Both renderers used to resolve every one of those to the strongest possible claim
 * by falling through to it — so a line Atlas made up carried the user's own name.
 * A tester saw "Atlas will create the #ops channel — YOU SAID" for a channel they had
 * only NAMED, and the marks are the entire mechanism by which a non-technical person
 * knows which lines to check.
 *
 * CLAUDE.md, twice over: *"a silent fallback is not a safety net; it is the bug —
 * fail closed"*, and *"every routed-on value must have a closed, declared domain"*.
 * This module is that declared domain. `coercePlanConfidence` is total: it maps
 * ANYTHING to one of the three, and only the literal string `'stated'` can reach the
 * claim about the user.
 *
 * The browser has the same rule, in its own copy, in `public/index.html`
 * (`planProvenanceLabel`) — the client file has no module boundary to import across.
 * Both are pinned by `tests/converger/plan-provenance.test.js`; if you change one,
 * change the other.
 */

/** The closed set. Nothing outside this may reach a renderer. */
export const PLAN_CONFIDENCES = Object.freeze(['stated', 'found', 'inferred']);

/** The value the plan must declare for the mark that quotes the user. */
export const STATED = 'stated';

/** What anything unrecognised becomes: the weakest claim, the one that asks for a look. */
export const WEAKEST = 'inferred';

/**
 * Clamp one confidence to the closed set, defaulting to the WEAKER claim.
 *
 * Deliberately an explicit comparison chain rather than a lookup table: a table keyed
 * by an attacker- or model-supplied string answers `'constructor'` and `'__proto__'`
 * with a truthy inherited value, which is exactly the "unrecognised value renders as
 * the strongest claim" bug wearing a different hat.
 *
 * @param {unknown} value
 * @returns {'stated'|'found'|'inferred'}
 */
export function coercePlanConfidence(value) {
  if (value === 'stated') return 'stated';
  if (value === 'found')  return 'found';
  return WEAKEST;
}

/** Clamp `{ …, confidence }` in place-free fashion; non-objects come back untouched. */
function clampItem(item) {
  if (!item || typeof item !== 'object') return item;
  return { ...item, confidence: coercePlanConfidence(item.confidence) };
}

/**
 * Return a copy of the plan with EVERY confidence clamped to the closed set.
 *
 * Applied server-side, where the plan is assembled, so a client that never ran — or a
 * future renderer written by someone who never read this file — cannot receive an
 * unlabelled item to guess about. The client's own coercion is a second line, not the
 * only one.
 *
 * @template T
 * @param {T} plan
 * @returns {T} the same shape, confidences closed
 */
export function normalizePlanConfidences(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const out = { ...plan };
  if (Array.isArray(plan.steps))    out.steps    = plan.steps.map(clampItem);
  if (Array.isArray(plan.branches)) out.branches = plan.branches.map(clampItem);
  // A trigger / error_handling line the model omitted must not become an unlabelled
  // item downstream, so only clamp what is actually there — an absent section stays
  // absent (the renderers already treat a missing section as nothing to show), while
  // a present one is always labelled.
  if (plan.trigger        && typeof plan.trigger === 'object')        out.trigger        = clampItem(plan.trigger);
  if (plan.error_handling && typeof plan.error_handling === 'object') out.error_handling = clampItem(plan.error_handling);
  return out;
}
