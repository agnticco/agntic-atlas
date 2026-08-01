/**
 * DO NOT OFFER TO BUILD A WORKFLOW OUT OF SERVICES THE WORKSPACE DOES NOT HAVE.
 *
 * WITNESSED 2026-08-01 on a genuinely fresh tenant (`zz-firstrun-test`) — the first time
 * the product had been driven as someone who has just been handed a login, which is the
 * model in use now that self-serve is off. Nothing connected. First message:
 *
 *     "When a customer emails us asking about pricing, send me a summary in Slack."
 *
 * Atlas asked **which Slack channel** to post to, then said the workflow would run
 * *"whenever a new email lands in **your connected inbox**"* and put a **Build it**
 * button on screen. Read from `oauth_tokens` rather than inferred: **zero rows for that
 * tenant.** There was no inbox and no Slack.
 *
 * A brand-new workspace has no connectors BY DEFINITION, so this was not an edge case —
 * it was the guaranteed first impression of every customer, and it was a false statement
 * about their own account.
 *
 * The prompt already carried the fact. It said: *"No connectors are connected yet. **If
 * asked**, say none are set up"* — and the user had not asked; they had described a
 * workflow. That is the whole defect in four words, and it is why this file exists: the
 * instruction is now unconditional, and this module is the mechanism that makes being
 * wrong about the model harmless.
 *
 * ── WHY IT SUPPRESSES THE BUTTON RATHER THAN JUST WARNING ────────────────────
 * Pressing Build it here spends a real interview and a paid build on a workflow that
 * cannot run. Refusing the offer and naming what to connect is the same fail-closed
 * principle as "publishing FAILS CLOSED when a trigger cannot be armed", moved to the
 * first turn where it costs the person nothing.
 *
 * ── AND WHY IT FAILS *OPEN* ON EVERY DOUBT ───────────────────────────────────
 * Wrongly blocking is worse than wrongly allowing: a false positive traps someone at the
 * first message of their first workflow with no way forward, whereas a false negative
 * only reproduces today's behaviour. So this fires ONLY when a service is named
 * unambiguously, is one Atlas actually connects, and is definitely absent. Anything
 * else — an unrecognised name, a bare "email", no intent at all — returns nothing.
 *
 * `email` DELIBERATELY DOES NOT IMPLY GMAIL. "Email me the summary" can mean the Atlas
 * inbox, which needs no connector at all, and a workflow that reads nothing external and
 * delivers to the inbox is genuinely buildable on an empty workspace. Treating the word
 * as a Gmail requirement would block the one shape that works.
 */

/**
 * Services a person may name, mapped to the connector that provides them.
 *
 * Keyed on words a CUSTOMER writes, not on capability ids — this reads the sentence they
 * typed, not the spec. Each entry needs a word specific enough that its presence is not a
 * judgement call; that is why `email`, `doc`, `sheet` and `calendar` are absent on their
 * own and appear only qualified by their vendor.
 */
const SERVICE_WORDS = [
  { connector: 'slack',     label: 'Slack',            re: /\bslack\b/i },
  { connector: 'google',    label: 'Gmail',            re: /\bgmail\b/i },
  { connector: 'google',    label: 'Google Sheets',    re: /\bgoogle\s+sheets?\b|\bspreadsheet\b/i },
  { connector: 'google',    label: 'Google Docs',      re: /\bgoogle\s+docs?\b/i },
  { connector: 'google',    label: 'Google Calendar',  re: /\bgoogle\s+calendar\b/i },
  { connector: 'google',    label: 'Google Drive',     re: /\bgoogle\s+drive\b/i },
  { connector: 'airtable',  label: 'Airtable',         re: /\bairtable\b/i },
];

/**
 * Which connectable services this intent names that the workspace does not have.
 *
 * @param {string} intent            the model's `build_intent` — what it proposes to build
 * @param {Set<string>|string[]} connected  connector ids the tenant actually has
 * @returns {{connector: string, label: string}[]}  empty when there is nothing to say
 */
export function missingConnectorsFor(intent, connected) {
  const text = String(intent ?? '');
  if (!text.trim()) return [];                       // nothing proposed ⇒ nothing to check
  const have = connected instanceof Set ? connected : new Set(connected ?? []);

  const out = [];
  const seen = new Set();
  for (const s of SERVICE_WORDS) {
    if (!s.re.test(text)) continue;
    if (have.has(s.connector)) continue;
    // One entry per CONNECTOR, not per service word: "Google Sheets and Gmail" with
    // Google absent is one thing to connect, and listing it twice would read as two.
    if (seen.has(s.connector)) continue;
    seen.add(s.connector);
    out.push({ connector: s.connector, label: s.label });
  }
  return out;
}

/**
 * The sentence a person is shown instead of a button they should not be given.
 *
 * Composed deterministically, never by a model — the whole point is that this cannot be
 * the thing that gets it wrong. It names Connections in the left sidebar and stops there,
 * which is the ONE place in Atlas the product is allowed to name (2026-07-26); it must not
 * grow a description of what is inside it.
 */
export function connectFirstMessage(missing) {
  if (!missing?.length) return null;
  const names = missing.map(m => m.label);
  const list = names.length === 1 ? names[0]
             : names.length === 2 ? `${names[0]} and ${names[1]}`
             : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const it = names.length === 1 ? 'it' : 'them';
  return `Before I can build this, ${list} ${names.length === 1 ? 'needs' : 'need'} to be connected to this workspace — open Connections in the left sidebar to set ${it} up. Once that's done, tell me and I'll put this together.`;
}

/**
 * The decision for one outgoing chat turn.
 *
 * Pure, so it can be tested without a server, and returning BOTH halves so the caller
 * cannot apply one and forget the other: `notice` is the sentence to stream, and
 * `readyToBuild` is the flag the button is gated on.
 *
 * The model's own words are never replaced — the notice is appended. The reply usually
 * contains a useful restatement of what the person asked for, and discarding it to print
 * one sentence would make the product feel like it stopped listening.
 *
 * @returns {{readyToBuild: boolean, buildIntent: string|null, notice: string|null,
 *            missing: string[]}}
 */
export function connectorGapDecision({ readyToBuild, buildIntent }, connected) {
  const missing = missingConnectorsFor(buildIntent, connected);
  if (!missing.length) {
    return { readyToBuild: !!readyToBuild, buildIntent: buildIntent ?? null, notice: null, missing: [] };
  }
  return {
    readyToBuild: false,
    buildIntent: null,
    notice: connectFirstMessage(missing),
    missing: missing.map(m => m.connector),
  };
}
