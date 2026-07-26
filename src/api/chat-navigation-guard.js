/**
 * Chat navigation guard — the deterministic backstop that stops Atlas sending a
 * user to one of its own screens that does not exist.
 *
 * WHY THIS EXISTS
 * ---------------
 * The chat assistant is free-form prose. Where the product is engineered it is
 * honest; where prose speaks for it, it invents. Observed live: after a genuinely
 * good refusal ("Notion isn't available, here are two alternatives") the model
 * added — twice, in independent conversations —
 *
 *   "…head to your Agntic workspace settings and look for the 'Connectors' or
 *    'Integrations' section…"
 *
 * There is no such screen. `grep -rn "Integrations" src/ public/` and
 * `grep -rni "workspace settings" src/ public/` both return nothing (verified at
 * 2b95d68). The real surface is a sidebar entry labelled **Connections**
 * (`public/index.html:220-223`, collapsed rail button at `:269`), which opens a
 * flyout listing connected apps, inactive ones, and a "Request a connector"
 * section for the ones Atlas has not built yet (`public/index.html:2323-2346`,
 * `src/connectors/connector-demand.js:20-33`). A non-technical user was sent
 * hunting through a settings screen that isn't there when the answer was one
 * click away.
 *
 * THE RULE IS IN THE PROMPT; THIS IS THE BACKSTOP.
 * A prompt rule is a *belief* about how a model will behave and is pinned by
 * nothing. This module is the part that can be proved.
 *
 * DELIBERATELY CONSERVATIVE
 * -------------------------
 * Mangling a legitimate reply is far worse than missing an invented one, so a
 * sentence is only rewritten when ALL THREE of these hold at once:
 *
 *   1. it is a navigation directive ("head to", "look for", "open", …),
 *   2. it names an Atlas surface that provably does not exist,
 *   3. that surface is ATTRIBUTED TO THIS PRODUCT — "Atlas" or "Agntic" appears
 *      shortly before it, with no third-party service named in between.
 *
 * Rule 3 is what makes this safe. Telling someone to open Slack's or Notion's
 * own settings is legitimate and must survive untouched, and it does: either no
 * product name is present ("in Slack, go to workspace settings"), or the third
 * party sits between the product name and the surface ("Atlas can't, but in
 * Notion go to Settings → Integrations"). Meanwhile the observed failure —
 * "…head to your Agntic workspace settings…" — is caught, even though the same
 * sentence also names Notion, because Notion is not between "Agntic" and
 * "workspace settings".
 *
 * The cost of the tight anchor, stated plainly: an invented instruction that
 * never names the product before the surface ("head to your workspace settings
 * and look for Integrations") is NOT caught here. The prompt rule is the
 * mechanism for that case; this is only the backstop.
 *
 * Pure, synchronous, and never throws. It is on the reply path of every chat
 * turn; it must be incapable of turning a good answer into an error.
 */

/**
 * The one real place, and nothing about what is inside it. Grounded in the
 * markup: the sidebar entry is labelled "Connections" (`public/index.html:222`)
 * and the app's own onboarding copy says "Open Connections in the bottom-left"
 * (`public/index.html:2602`).
 */
export const CONNECTIONS_INSTRUCTION =
  'To connect an app, open Connections in the left sidebar.';

/** This product, by either name it goes by in front of a user. */
const PRODUCT_SELF_REFERENCE = /\b(?:atlas|agntic)\b/i;

/**
 * Atlas surfaces that DO NOT EXIST. Every entry is backed by a grep over `src/`
 * and `public/` that returned nothing, plus the observed invented output. An
 * optional quote character is tolerated because the model quotes the names it
 * invents ("the 'Integrations' section").
 */
const INVENTED_SURFACES = [
  // "head to your Agntic workspace settings" — observed verbatim.
  /\bworkspace settings\b/i,
  // "look for the 'Connectors' or 'Integrations' section" — observed verbatim.
  /\bintegrations?\b['’"]?\s+(?:section|tab|page|menu|panel)\b/i,
  /\bconnectors?\b['’"]?\s+(?:section|tab|page|menu|panel)\b/i,
  // A nested settings path. Atlas has an "Account settings" flyout and nothing
  // beneath it, so "Settings → anything" is a route that cannot be walked.
  /\bsettings\s*(?:→|->|>|»)\s*\S/i,
];

/** A "go here and do this" cue. Without one, the sentence is describing, not directing. */
const NAVIGATION_DIRECTIVE =
  /\b(?:head (?:to|over)|go to|navigate to|visit|open|click|look for|find|select|choose|scroll|check under|you'll find|you will find)\b/i;

/**
 * Third-party services a user legitimately gets told to configure. If one of
 * these is named, the sentence is about somebody else's product and is none of
 * this guard's business.
 */
const THIRD_PARTY = new RegExp(
  '\\b(?:' + [
    'slack', 'notion', 'gmail', 'google', 'drive', 'sheets', 'docs', 'calendar',
    'airtable', 'hubspot', 'salesforce', 'teams', 'outlook', 'microsoft', 'm365',
    'office\\s?365', 'discord', 'stripe', 'jira', 'linear', 'github', 'gitlab',
    'zendesk', 'shopify', 'dropbox', 'asana', 'trello', 'monday', 'zapier',
    'quickbooks', 'xero', 'intercom', 'mailchimp', 'zoom', 'clickup', 'confluence',
  ].join('|') + ')\\b',
  'i',
);

/**
 * How far back from an invented surface name we will look for the product name.
 * Small on purpose: the further apart they are, the less certain the attribution.
 */
const ATTRIBUTION_WINDOW = 120;

/** Index of the LAST product self-reference in `text`, or -1. */
function lastProductReferenceIndex(text) {
  const re = new RegExp(PRODUCT_SELF_REFERENCE.source, 'gi');
  let last = -1, m;
  while ((m = re.exec(text)) !== null) { last = m.index; re.lastIndex = m.index + 1; }
  return last;
}

/**
 * True when an invented surface in this segment is attributed to THIS product:
 * "Atlas"/"Agntic" appears close before it, and no third-party service is named
 * between the two (which would re-attribute the instruction to that service).
 */
function surfaceIsAttributedToAtlas(segment) {
  for (const re of INVENTED_SURFACES) {
    const scan = new RegExp(re.source, 'gi');
    let m;
    while ((m = scan.exec(segment)) !== null) {
      scan.lastIndex = m.index + 1; // never spin on a zero-width match
      const before  = segment.slice(0, m.index);
      const product = lastProductReferenceIndex(before);
      if (product < 0) continue;                                  // nobody claimed it
      if (m.index - product > ATTRIBUTION_WINDOW) continue;        // too far to be sure
      if (THIRD_PARTY.test(before.slice(product))) continue;       // re-attributed elsewhere
      return true;
    }
  }
  return false;
}

/** True when this one segment is Atlas inventing its own navigation. */
function isInventedAtlasNavigation(segment) {
  if (!NAVIGATION_DIRECTIVE.test(segment)) return false;
  return surfaceIsAttributedToAtlas(segment);
}

/**
 * Split into segments that each end at a sentence terminator or a newline, with
 * the delimiter and trailing spaces kept attached. `segments.join('')` always
 * reproduces the input exactly — so a reply with no offending segment comes back
 * byte-identical, which is the property the anti-false-positive case rests on.
 */
function splitSegments(text) {
  const segments = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      segments.push(text.slice(start, i + 1));
      start = i + 1;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i + 1;
      while (j < text.length && (text[j] === '.' || text[j] === '!' || text[j] === '?')) j++;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
      segments.push(text.slice(start, j));
      start = j;
      i = j - 1;
    }
  }
  if (start < text.length) segments.push(text.slice(start));
  return segments;
}

/**
 * Inspect a reply before the user sees it and replace any invented Atlas
 * navigation with the one true instruction.
 *
 * The first offending segment becomes {@link CONNECTIONS_INSTRUCTION}; any
 * further offending segments are dropped rather than repeating it. Everything
 * else — including a good refusal and the alternatives offered alongside it —
 * is left exactly as written.
 *
 * @param   {string} reply
 * @returns {{ text: string, changed: boolean }} `changed:false` guarantees
 *          `text` is the identical string that came in.
 */
export function scrubInventedNavigation(reply) {
  if (typeof reply !== 'string' || reply === '') return { text: reply, changed: false };

  let segments;
  try {
    segments = splitSegments(reply);
  } catch {
    return { text: reply, changed: false }; // never make a reply worse than it was
  }

  const kept = [];
  let changed = false;
  let substituted = false;

  for (const segment of segments) {
    if (!isInventedAtlasNavigation(segment)) { kept.push(segment); continue; }
    changed = true;
    if (substituted) continue;          // don't say the same thing three times
    substituted = true;
    const trailing = segment.match(/\s*$/)[0];
    kept.push(CONNECTIONS_INSTRUCTION + trailing);
  }

  if (!changed) return { text: reply, changed: false };

  const text = kept.join('').trim();
  return { text: text || CONNECTIONS_INSTRUCTION, changed: true };
}
