/**
 * P9 value-tracking methodology.
 *
 * Methodology: baseline_delta
 *   time_saved = max(0, baseline_duration_s - actual_run_duration_s)
 *
 * Baseline is captured once per workflow (operator records how long the manual
 * version takes). Every successful automated run is measured against it.
 * Time saved accumulates as: runs × avg_time_saved_per_run.
 */

export const METHODOLOGY = 'baseline_delta';
export const UNIT = 'minutes';

/**
 * Compute minutes saved for a single run.
 * @param {number} baselineDurationS  - manual task duration in seconds (from workflow.baseline_duration_s)
 * @param {number} actualDurationS    - automated run duration in seconds (completed_at - started_at)
 * @returns {number} minutes saved (≥ 0), or null when no baseline is set
 */
export function computeTimeSavedMinutes(baselineDurationS, actualDurationS) {
  if (!baselineDurationS || baselineDurationS <= 0) return null;
  return Math.max(0, (baselineDurationS - actualDurationS) / 60);
}
