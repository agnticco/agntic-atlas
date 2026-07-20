/**
 * Unified time-saved model (P11-QA Q02).
 *
 * ONE method across Home, Profile, and the ROI report so a tenant never sees two
 * disagreeing "time saved" numbers. Per real successful run:
 *   1. persisted measured value (`time_saved_minutes`) if present, else
 *   2. measured `baseline − actual duration` if a baseline is recorded, else
 *   3. a flat per-run estimate (default 3 min; `TIME_SAVED_ESTIMATE_MIN` to override).
 *
 * Callers pass raw run rows; helpers filter to real successful runs themselves
 * (or use `isValueRun` when they need the filtered set for other purposes).
 *
 * This module also owns the run-classification predicates the value model rests
 * on — `isLiveRun` (non-test) and `isValueRun` (non-test AND successful) — so
 * that every surface reporting a workflow's health or value filters runs the
 * same way. See `isLiveRun` for why that is load-bearing.
 */

/** Flat per-run estimate (minutes) used when no baseline has been recorded. */
export const FLAT_ESTIMATE_MINUTES = (() => {
  const n = Number(process.env.TIME_SAVED_ESTIMATE_MIN);
  return Number.isFinite(n) && n >= 0 ? n : 3;
})();

/**
 * A LIVE run: one the workflow performed for real, not a build-time test.
 *
 * The single definition of "test runs don't count", shared by every surface an
 * operator judges a workflow's health by — the console metrics band, the Home
 * success-rate and top-workflows modules, and `isValueRun` below. Three copies
 * of `!r.is_test` is three chances to disagree, and the disagreement is silent:
 * a workflow that has only ever been test-run reporting "100% success" is a
 * health claim about runs that never happened (F14).
 *
 * Status is deliberately NOT considered — a failed live run is still a live
 * run, and it must count against the success rate.
 */
export function isLiveRun(run) {
  return !!run && !run.is_test;
}

/** A run that counts toward value: a real (non-test) successful run. */
export function isValueRun(run) {
  return isLiveRun(run) && run.status === 'success';
}

/**
 * Minutes saved by a single real successful run.
 * @param {object} run                — a workflow_runs row
 * @param {number} [baselineDurationS] — the workflow's recorded baseline in seconds (0 = none)
 */
export function timeSavedMinutesForRun(run, baselineDurationS = 0) {
  if (!run) return 0;
  if (run.time_saved_minutes != null) return run.time_saved_minutes;
  if (baselineDurationS > 0 && run.started_at && run.completed_at) {
    const durationS = (new Date(run.completed_at) - new Date(run.started_at)) / 1000;
    if (Number.isFinite(durationS)) return Math.max(0, (baselineDurationS - durationS) / 60);
  }
  return FLAT_ESTIMATE_MINUTES;
}

/**
 * Total minutes saved across a set of runs. Filters to real successful runs, so
 * callers can pass an unfiltered run list.
 */
export function sumTimeSavedMinutes(runs, baselineDurationS = 0) {
  return (runs || [])
    .filter(isValueRun)
    .reduce((sum, r) => sum + timeSavedMinutesForRun(r, baselineDurationS), 0);
}
