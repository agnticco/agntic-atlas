/**
 * How often a workflow is allowed to run — the user-facing "how quickly should this
 * check for changes?" control (operator's ask, 2026-07-24).
 *
 * ONE idea, two mechanics, because Atlas's triggers arrive two different ways and
 * pretending otherwise would produce a setting that does nothing:
 *
 *   POLLED triggers (email) — Atlas asks the service "anything new?" on a timer.
 *     Today that timer is hardcoded at 60 seconds for every workflow. Here the
 *     setting is literally the poll interval: ask less often, and Atlas checks
 *     less often.
 *
 *   PUSHED triggers (Airtable record-changed) — the service calls US the moment
 *     something happens, so there is no "checking" to slow down; it is already as
 *     fast as it can be. Here the setting is a MINIMUM GAP BETWEEN RUNS, which is
 *     what a person actually wants when they ask for this: a busy base should not
 *     fire the same workflow forty times an hour and eat the month's run budget.
 *
 * The rule that makes the second one safe: an event arriving inside the window is
 * DEFERRED to the end of it, never dropped. Dropping would be a silent failure —
 * the change happened, the workflow said it was live, and nothing ran.
 *
 * Slack messages deliberately have NO such control. Each message is its own unit of
 * work, so a minimum gap could only drop messages or queue them without bound.
 * "Every message, immediately" is the honest behaviour; a knob that quietly loses
 * messages is the defect this codebase keeps paying for.
 */

/** Minutes. 0/absent means "as fast as the trigger allows" — the current behaviour. */
export const DEFAULT_CHECK_EVERY_MIN = 0;

/** What the UI offers. Minutes, with the label a person reads. */
export const CHECK_EVERY_CHOICES = [
  { minutes: 0,    label: 'As soon as it happens' },
  { minutes: 5,    label: 'At most every 5 minutes' },
  { minutes: 15,   label: 'At most every 15 minutes' },
  { minutes: 30,   label: 'At most every 30 minutes' },
  { minutes: 60,   label: 'At most once an hour' },
  { minutes: 240,  label: 'At most every 4 hours' },
  { minutes: 720,  label: 'At most twice a day' },
  { minutes: 1440, label: 'At most once a day' },
];

/** A polled trigger cannot check faster than the scheduler ticks. */
export const MIN_POLL_MINUTES = 1;
const MAX_MINUTES = 7 * 24 * 60;   // a week — beyond this, use a schedule, not a trigger

/**
 * Read the setting off a trigger. Accepts it at the top level or inside `filter`,
 * because the converger writes trigger options into `filter` and hand-written specs
 * put them at the top.
 *
 * Anything unparseable reads as "no limit" rather than throwing — a nonsense value
 * must not stop a workflow running, and the wrong direction to fail here is silent
 * inaction.
 */
export function checkEveryMinutes(trigger) {
  const raw = trigger?.checkEvery ?? trigger?.filter?.checkEvery ?? trigger?.config?.checkEvery;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHECK_EVERY_MIN;
  // Deliberately NOT rounded to whole minutes. A pushed trigger can honour "every
  // 30 seconds" perfectly well, and rounding it up to a minute would silently give
  // the user something slower than they asked for. Where a fraction genuinely
  // cannot be honoured — a polled trigger cannot beat the scheduler tick —
  // `pollIntervalMs` raises it to the floor, which is a real clamp on a reachable
  // value rather than a guard that can never fire.
  return Math.min(n, MAX_MINUTES);
}

/**
 * The gap a workflow must leave between runs, in milliseconds, across all its
 * triggers. The SMALLEST setting wins: if any trigger says "as soon as it happens",
 * the workflow is not throttled — a limit the user set on one trigger must not
 * silently slow down a different one.
 */
export function minGapMs(workflow, { only = null } = {}) {
  const triggers = (workflow?.triggers ?? []).filter((t) => (only ? only(t) : true));
  if (!triggers.length) return 0;
  let smallest = Infinity;
  for (const t of triggers) smallest = Math.min(smallest, checkEveryMinutes(t));
  return Number.isFinite(smallest) ? smallest * 60_000 : 0;
}

/** As above, but for polled triggers, which can never check faster than the tick. */
export function pollIntervalMs(workflow, { only = null } = {}) {
  const gap = minGapMs(workflow, { only });
  return gap > 0 ? Math.max(gap, MIN_POLL_MINUTES * 60_000) : 0;
}

/**
 * A gate that releases work no more often than `minGapMs`, deferring rather than
 * dropping anything that arrives inside the window.
 *
 * `now` and `setTimer` are injectable so a check can drive the clock instead of
 * sleeping — a test that waits a real minute is a test nobody runs.
 */
export function createRunGate({ now = () => Date.now(), setTimer = setTimeout } = {}) {
  const lastRelease = new Map();   // key → timestamp
  const deferred    = new Map();   // key → { run, timer }

  return {
    /**
     * @param {object}   opts
     * @param {string}   opts.key      — usually the workflow id
     * @param {number}   opts.gapMs    — 0 means no throttling
     * @param {Function} opts.run      — invoked now, or once the window closes
     * @returns {{released:boolean, deferred:boolean, coalesced:boolean, waitMs:number, promise?:Promise}}
     *   `promise` is present only when released, so the caller can await the run it
     *   just started and keep today's serial dispatch behaviour.
     */
    request({ key, gapMs, run }) {
      const t = now();
      const since = t - (lastRelease.get(key) ?? -Infinity);

      if (!gapMs || since >= gapMs) {
        lastRelease.set(key, t);
        return { released: true, deferred: false, coalesced: false, waitMs: 0, promise: Promise.resolve().then(run) };
      }

      // Inside the window. Something already waiting? Replace its work with the
      // newest — for a cursor-based source the later run picks up everything that
      // happened in between, so this coalesces without losing changes.
      const existing = deferred.get(key);
      if (existing) {
        existing.run = run;
        return { released: false, deferred: true, coalesced: true, waitMs: gapMs - since };
      }

      const waitMs = gapMs - since;
      const entry = {
        run,
        timer: setTimer(() => {
          const e = deferred.get(key);
          deferred.delete(key);
          lastRelease.set(key, now());
          Promise.resolve().then(() => e?.run?.()).catch(() => {});
        }, waitMs),
      };
      entry.timer?.unref?.();          // never hold the process open for a deferred run
      deferred.set(key, entry);
      return { released: false, deferred: true, coalesced: false, waitMs };
    },

    /** Testing / shutdown: drop everything waiting. */
    clear() {
      for (const { timer } of deferred.values()) clearTimeout(timer);
      deferred.clear();
      lastRelease.clear();
    },

    pendingCount: () => deferred.size,
  };
}
