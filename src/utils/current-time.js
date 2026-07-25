/**
 * What day is it? — the one place that answers, for every model call Atlas makes.
 *
 * A model has no clock. Asked for "today's date" it answers from training data, and
 * it does so confidently. Observed live on 2026-07-24: a workflow wrote `2025-07-14`
 * into a customer's real Airtable base — over a year wrong — while the test panel
 * reported the promise kept, the run reported Success and the dashboard reported
 * 100%. A second workflow greeted a Friday as "even on a Saturday". Silent at every
 * place a person would look, on every run, corrupting their system of record.
 *
 * TWO SURFACES NEED THIS, and fixing only one is why this module exists rather than
 * a private helper:
 *
 *   · THE ENGINE, at run time — an `llm` node writing "today's date" into a record.
 *   · THE CONVERGER, at build time — it reasons about "every Monday" and "yesterday's
 *     email", and it invents the sample events its own self-test runs against. Those
 *     samples were dated 2025-07-14 and 2025-07-15 on 2026-07-24, so the build was
 *     testing the workflow against a world a year out of date.
 *
 * One helper, imported by both. A second copy of "what time is it" would drift the
 * same way the two copies of "what is a write" drifted — which cost this codebase a
 * shipped defect and an independent verifier to find it.
 *
 * @module src/utils/current-time.js
 */

/**
 * A system-prompt block stating the current date and time, and forbidding a guess.
 *
 * Belongs in the SYSTEM message, never the user prompt: a user-authored prompt can
 * be long, can carry its own dates, and can contradict — the instruction must sit
 * where nothing can displace it.
 *
 * @param {Date} [now] — the moment to report. Defaults to the wall clock. A caller
 *   with a better answer (the time a trigger actually fired) should pass it, so a
 *   run and the event that caused it agree. An invalid Date falls back rather than
 *   throwing: a bad clock must not take down a workflow that was otherwise fine.
 * @returns {string}
 */
export function currentDateLine(now) {
  const at = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
  const human = at.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  return [
    `CURRENT DATE AND TIME: ${human} — ${at.toISOString()} (UTC).`,
    'Use this for anything relative: today, now, tomorrow, this week, "the date".',
    'Never infer the date from your training data; it is not today.',
  ].join('\n');
}
