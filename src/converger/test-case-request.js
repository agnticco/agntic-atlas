/**
 * ASKING FOR A TEST CASE IS NOT ASKING FOR A CHANGE.
 *
 * WITNESSED ON PROD 2026-07-31 (`build-platform-1785513701920`). A correct workflow was
 * held at *"Contract not verified — nothing went down one path: 'error'"*, and the panel
 * invited the obvious next move in its own words:
 *
 *     "A workflow that routes is only proved on the routes you test, so give me an
 *      example that takes it and I'll check the rest."
 *
 * Typing that example took the `ratify_feedback` route into a **107-second whole-spec
 * regenerate**, which renamed the route from `error` to `none` and **did not add the
 * example**. So the one action the product offers for closing an unproved path cost a
 * paid rebuild and did not close it. Worse than doing nothing: the spec moved underneath
 * a person who had asked for nothing to move.
 *
 * Two doors reach that regenerate — the walkthrough's "request changes" and ratify's
 * feedback — and this module is shared by both **on purpose**. A rule about what a
 * person's message MEANS, written twice, is the defect shape this codebase has paid for
 * more than any other.
 *
 * ── HOW IT DECIDES, AND WHY IT DEFAULTS THE WAY IT DOES ──────────────────────
 *
 * The decision is NOT scoped to the wording. "Test the error path" and "it should also
 * handle an empty body" are the same sentence to a regex and opposite requests to a
 * person. Two things have to hold before a message is read as a test case:
 *
 *   1. **A path is actually unproved.** If every path already has an input aimed at it,
 *      Atlas never asked for an example, so nothing the person says is an answer to that
 *      question. This is the same principle as "answering a question you were asked is
 *      not a revision".
 *   2. **The model says it describes an INPUT, not a change.** One cheap call, and
 *      `wantsChange` is the default for every uncertain, malformed or failed answer.
 *
 * **Every doubt resolves to CHANGE**, which is exactly today's behaviour — so this can
 * only ever remove a wasted rebuild, never swallow a real change request. Getting that
 * backwards would silently ignore someone asking for their workflow to be different,
 * which is far worse than the rebuild this exists to avoid.
 */

import { laneInventoryOf } from '../workflows/outcome-oracle.js';

/** The id a lane is claimed by. One place, so a claim and a lane can never disagree. */
export const laneKeyOf = (lane) => String(lane?.to ?? lane?.label ?? '').trim().toLowerCase();

/**
 * The paths of this spec that no example is aimed at.
 *
 * An example with no `lane` claims NOTHING. Attribution is unknowable for samples
 * generated before the workflow existed, and "we cannot tell" must never read as
 * "covered" — that is how an unproved path gets reported as tested.
 */
export function unprovedLanes(spec) {
  const lanes = laneInventoryOf(spec);
  if (lanes.length < 2) return [];          // a workflow with one path has nothing to miss
  const claimed = new Set(
    (spec?.outcome?.examples ?? [])
      .filter(e => e && e.given != null)
      .map(e => String(e?.lane ?? '').trim().toLowerCase())
      .filter(Boolean));
  return lanes.filter(l => !claimed.has(laneKeyOf(l)));
}

/**
 * Ask whether this message describes an input to TEST or a change to MAKE.
 *
 * The lanes are named so the answer can say which one the input takes — an example that
 * claims no path proves no path, so a test case that cannot name its lane is not useful
 * and is refused below.
 */
export function buildTestCaseRequestPrompt({ feedback, lanes, intent, outcome }) {
  return `A person is reviewing a finished workflow. Atlas has just told them that one of its
paths was never exercised by the test, and asked them for an example that would take it.

THE WORKFLOW: "${intent ?? ''}"
WHAT IT PROMISES: ${outcome?.statement ?? '(not stated)'}

THE PATHS NOTHING HAS BEEN AIMED AT:
${lanes.map((l, i) => `${i + 1}. ${l.label}   (id: ${laneKeyOf(l)})`).join('\n')}

THEY SAID:
"""
${String(feedback ?? '').slice(0, 1200)}
"""

Decide which of these two they are doing:

  · "test_case" — describing an INPUT the workflow should be run against, so a path gets
    proved. Nothing about the workflow itself changes. ("Try it with an email that has an
    empty body." / "What about a message with no amount in it?")

  · "change" — asking for the WORKFLOW to be different: a step added, removed or altered,
    a different destination, different wording, a new rule.

If you are not sure, answer "change". A change wrongly treated as a test case means their
request is silently ignored, which is far worse than an unnecessary rebuild.

For "test_case", build the example: \`given\` is the EVENT the workflow's first step
receives, a realistic instance of that event's own shape with the real content IN
\`given\` — never a label describing the path — and \`lane\` is the id of the path this
input takes, exactly as written above.

Return JSON only, one of:
{"kind":"change"}
{"kind":"test_case","example":{"label":"<short plain-words label>","lane":"<path id>","given":{…},"expect":{…}}}`;
}

/**
 * Read the answer, and refuse anything that is not unmistakably a usable test case.
 *
 * Returns the example to add, or `null` meaning "treat this as a change" — which is the
 * behaviour that existed before this module, so every refusal here is safe.
 */
export function readTestCaseRequest(parsed, lanes) {
  if (parsed?.kind !== 'test_case') return null;
  const ex = parsed.example;
  if (!ex || typeof ex !== 'object') return null;
  // No `given` is no input, and there is nothing to run.
  if (ex.given == null || (typeof ex.given === 'object' && !Object.keys(ex.given).length)) return null;
  // An example that names no path proves no path. Refusing here keeps the claim
  // honest — adding it would grow the sample count while leaving the lane as unproved
  // as it was, which reads on the panel as progress and is not.
  const want = String(ex.lane ?? '').trim().toLowerCase();
  const lane = (lanes ?? []).find(l => laneKeyOf(l) === want);
  if (!lane) return null;
  return {
    id:    `asked_${laneKeyOf(lane).replace(/[^a-z0-9]+/g, '_')}`,
    label: String(ex.label ?? '').trim() || `Your example — ${lane.label}`,
    lane:  laneKeyOf(lane),
    given: ex.given,
    ...(ex.expect != null ? { expect: ex.expect } : {}),
  };
}

/**
 * Put the person's example into the draft, replacing any earlier one of theirs for the
 * same path.
 *
 * Replacing rather than appending is deliberate: a second attempt at the same path means
 * the first one did not do the job, and keeping both would leave the panel showing a
 * sample they have already superseded.
 */
export function withTestCase(draft, example) {
  if (!draft || !example) return draft;
  const had = (draft.outcome?.examples ?? []).filter(e => e && e.id !== example.id);
  return { ...draft, outcome: { ...(draft.outcome ?? {}), examples: [...had, example] } };
}
