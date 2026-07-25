/**
 * What time is it, where the user is? — the one place that answers, for every model
 * call Atlas makes.
 *
 * A model has no clock. Asked the date it answers from training data, and it does so
 * confidently. In production a workflow wrote `2025-07-14` into a customer's real
 * Airtable base — over a year wrong — while the test panel reported the promise kept,
 * the run reported Success and the dashboard reported 100%. Chat greeted a Friday as
 * "even on a Saturday".
 *
 * INJECTED IN ONE PLACE, and that is deliberate. Per-call-site injection was tried
 * and missed a surface three times running: the engine's `llm` node, then the
 * converger's prompt, then the STREAMING path that chat actually uses. There are ~19
 * model call sites; enumerating them loses. `ChatModel._systemWithClock` is the single
 * seam both request assemblers go through, and it is the only caller of this module.
 *
 * ── WHY THE TIMEZONE MATTERS MORE THAN IT LOOKS ─────────────────────────────────
 * Reporting UTC is not merely an unhelpful format. The production box is `Etc/UTC`,
 * and for a user on US Central, UTC has ALREADY ROLLED OVER TO TOMORROW from early
 * evening onwards. So a UTC clock makes "today's date" wrong for a third of their
 * day — the same defect this module exists to fix, wearing a different hat.
 *
 * The zone is DEPLOYMENT-WIDE (`ATLAS_TIMEZONE`, default `UTC`), matching the
 * existing precedent for approval-channel availability: fine while there is one
 * deployment and one operator, and to be revisited the moment tenants span zones.
 * A per-tenant zone is the follow-up, and it has nowhere to live yet — there is no
 * timezone column on the tenant or user store.
 *
 * @module src/utils/current-time.js
 */

/** The deployment's display timezone. An invalid value falls back to UTC, loudly-ish. */
export function deploymentTimeZone() {
  const tz = process.env.ATLAS_TIMEZONE?.trim();
  if (!tz) return 'UTC';
  try {
    // Throws RangeError on an unknown zone. Better to catch it here than to emit a
    // broken clock: a wrong date is exactly what this module exists to prevent.
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * A system-prompt block stating the current date and time, and forbidding a guess.
 *
 * Belongs in the SYSTEM message, never the user prompt: a user-authored prompt can be
 * long, can carry its own dates, and can contradict — the instruction must sit where
 * nothing can displace it. And it must be positioned AFTER the prompt-cache
 * breakpoint; see `ChatModel._systemWithClock`.
 *
 * Reports the LOCAL time first (that is what a person means by "now"), names the zone
 * so the model cannot mistake it, and carries UTC alongside so anything machine-facing
 * — a timestamp written into a record, a calendar event — has an unambiguous value.
 *
 * @param {Date} [now] — the moment to report. Defaults to the wall clock. A caller
 *   with a better answer (the time a trigger actually fired) should pass it. An
 *   invalid Date falls back rather than throwing: a bad clock must not take down a
 *   workflow that was otherwise fine.
 * @param {string} [timeZone] — override the deployment zone (tests, or a future
 *   per-tenant zone).
 * @returns {string}
 */
export function currentDateLine(now, timeZone) {
  const at = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
  const tz = timeZone ?? deploymentTimeZone();

  // en-GB for "25 July 2026" rather than "July 25, 2026": day-first is unambiguous,
  // and 07/25 vs 25/07 confusion is itself a date bug. `long` for the zone name so it
  // reads "Central Daylight Time" — `short` renders the far less obvious "GMT-5".
  const local = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: tz, timeZoneName: 'long',
  }).format(at);

  return [
    `CURRENT DATE AND TIME: ${local}.`,
    `This is the user's local time (${tz}). In UTC it is ${at.toISOString()}.`,
    'Use the LOCAL date and time for anything a person would mean by today, now,',
    'tomorrow, this morning, tonight or this week. Use UTC only where a machine-',
    'readable timestamp is explicitly required.',
    'Never infer the date or time from your training data; it is not now.',
  ].join('\n');
}
