/**
 * duration — "48h" → milliseconds. One parser, used by everything. (P12 Increment D.)
 *
 * A `human` node's `timeout.after` is written by a person (or a model) as "30m",
 * "48h", "7d". The validator must decide whether it is a duration at all, and the
 * timeout sweeper must turn it into a deadline. If those two disagree about what
 * "48 hours" means — or about whether "2 fortnights" is valid — the validator
 * accepts a pause the sweeper can never expire, and the run hangs forever with a
 * timeout declared. So there is exactly one definition.
 *
 * Returns null for anything it cannot read, and the caller decides what that
 * means. It never guesses a default: a duration nobody could parse is not
 * "probably an hour", it is a mistake, and the validator says so.
 *
 * @module src/workflows/duration.js
 */

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * @param {string|number} v — "48h", "30m", "7d", "90s", or a raw ms number.
 * @returns {number|null} milliseconds, or null if it is not a duration.
 */
export function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v !== 'string') return null;

  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/i.exec(v);
  if (!m) return null;

  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;

  return Math.floor(n * UNIT_MS[m[2].toLowerCase()]);
}

/** The deadline `after` from `from`, or null if `after` is unreadable. */
export function deadlineFrom(after, from = Date.now()) {
  const ms = parseDuration(after);
  return ms == null ? null : new Date(from + ms).toISOString();
}
