/**
 * Escaping for `{{…}}` interpolation — so an AI answer cannot destroy the
 * STRUCTURE of the config value it lands in.
 *
 * THE BUG THIS FIXES
 * ──────────────────
 * `assemble`'s `sections` is authored as a JSON array whose `content` fields are
 * template references:
 *
 *   [{"heading":"Dental Emergency","content":"{{format_emergency.output}}"}]
 *
 * That is valid JSON at build time, and the build-time probe in assemble.js
 * (which swaps every `{{…}}` for a bare token before parsing) correctly passes
 * it — the value genuinely is not knowable until the workflow runs. At run time
 * the placeholder was replaced with whatever the AI wrote, RAW. The first line
 * break in a written summary ends the JSON string literal, so `JSON.parse` in
 * assemble's run() threw
 *
 *   assemble sections is invalid JSON: Bad control character in string literal
 *
 * on every single run. Deterministic, invisible until it ran, and it killed the
 * whole workflow. Observed 12/12 runs across two independent builds.
 *
 * The same shape reaches other fields that are parsed as JSON downstream — an
 * Airtable `fields` map (`src/connectors/airtable/index.js`, `JSON.parse(fields)`)
 * and Sheets `values` (`src/connectors/google/index.js`) — which is why the fix
 * lives at the point of interpolation rather than inside `assemble`.
 *
 * THE THING THAT MUST NOT BE GOT WRONG
 * ────────────────────────────────────
 * The overwhelming majority of interpolations land in PLAIN TEXT — an `llm`
 * step's instructions, a Slack message body, an email body. Those must keep
 * receiving the raw text with REAL line breaks. Escaping unconditionally would
 * make every workflow in the product start emitting literal `\n` sequences into
 * messages customers read: a worse bug than the one being fixed. So the escape
 * is conditional on where the value LANDS, and the "plain text is untouched"
 * half is pinned by its own tests.
 *
 * HOW "LANDS INSIDE A JSON STRING LITERAL" IS DECIDED
 * ──────────────────────────────────────────────────
 * Neutralise every `{{…}}` to a bare word token and try to parse the result as
 * JSON. If it parses to an object or an array, the field is JSON-structured.
 *
 * A per-field decision is sufficient, and that is not an approximation — it is
 * exact. The neutral token is a bare word (`__ATLAS_TPL__`), and in JSON a bare
 * word is only legal as `true` / `false` / `null`. So the probe can only parse
 * if EVERY template in the value sat inside a string literal (a value or a key).
 * A template outside one — `{"n": {{count.output}}}` — makes the probe fail to
 * parse, the field is treated as not-JSON, and nothing changes: that spec is
 * already refused at build time by assemble.js's identical probe.
 *
 * Requiring an object or an array (not a bare JSON string/number) is deliberate.
 * A plain-text field whose whole content is `"{{prev}}"` — quotes included, a
 * person quoting the summary — parses as a JSON string, and escaping it would be
 * exactly the over-escaping regression above. Every config value actually parsed
 * as JSON downstream is an object or an array.
 *
 * @module src/workflows/template-escape.js
 */

/**
 * One grammar for "this is a template reference". Matches the same span as the
 * build-time probe in `node-types/assemble.js` so the two cannot disagree about
 * what a template is.
 */
const TEMPLATE_SPAN = /\{\{[^}]+\}\}/g;

/**
 * A bare word — legal JSON ONLY inside a string literal, which is what makes the
 * per-field decision exact rather than a heuristic (see the module header).
 */
const NEUTRAL_TOKEN = '__ATLAS_TPL__';

/**
 * True when this config value is a JSON structure whose `{{…}}` references all
 * sit inside string literals — i.e. substituting raw text into it can change its
 * SHAPE, not just its content.
 *
 * @param {string} raw — the config value BEFORE substitution
 * @returns {boolean}
 */
export function landsInsideJsonString(raw) {
  if (typeof raw !== 'string') return false;
  TEMPLATE_SPAN.lastIndex = 0;
  if (!TEMPLATE_SPAN.test(raw)) return false;      // nothing to substitute — moot
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(TEMPLATE_SPAN, NEUTRAL_TOKEN));
  } catch {
    return false;                                   // not JSON — plain text field
  }
  return parsed !== null && typeof parsed === 'object';   // object or array only
}

/**
 * Escape a value for use as the BODY of a JSON string literal (i.e. between the
 * quotes that are already in the config value).
 *
 * `JSON.stringify` is the escaper on purpose: it covers `"` `\` `\b` `\f` `\n`
 * `\r` `\t`, every other control character as `\uXXXX`, and lone surrogates —
 * a hand-rolled table would miss one of those, and the one it missed would be
 * the one an AI eventually emitted.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeJsonStringBody(text) {
  const quoted = JSON.stringify(String(text ?? ''));
  return quoted.slice(1, -1);
}

/**
 * The encoder to apply to every value substituted into `raw`.
 * Identity for plain-text fields — that is the half of this fix that keeps real
 * line breaks in the messages customers read.
 *
 * @param {string} raw — the config value BEFORE substitution
 * @returns {(text: string) => string}
 */
export function encoderFor(raw) {
  return landsInsideJsonString(raw) ? escapeJsonStringBody : (text) => String(text ?? '');
}
