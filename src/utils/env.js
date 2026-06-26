/**
 * Env-var parsing helpers with safe fallbacks.
 *
 * `Number(process.env.X ?? def)` has two footguns: an empty-string value
 * (`X=""`) is non-nullish so it bypasses `?? def` and yields `0`, and a
 * malformed value yields `NaN`. Both silently misconfigure timeouts/limits.
 * numEnv treats empty/NaN as "absent" and returns the default.
 */
export function numEnv(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

/**
 * Boolean env: '1'/'true'/'yes'/'on' → true, '0'/'false'/'no'/'off' → false,
 * anything else (incl. unset/empty) → def.
 */
export function boolEnv(name, def = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return def;
}
