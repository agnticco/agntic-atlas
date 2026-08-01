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

  // ── EMAIL AS A TRIGGER IS GMAIL. EMAIL AS A DESTINATION IS NOT. ────────────
  //
  // A bare "email" stays ambiguous on purpose (see the header): "email me the summary"
  // can mean the Atlas inbox, which needs nothing connected, and treating the word as a
  // Gmail requirement would block the one shape a brand-new user can actually build.
  //
  // But "when a new email ARRIVES" can only mean a mailbox Atlas reads, and the only one
  // it can read is the connected Google account. Nothing else in the product can start a
  // workflow from incoming mail. So the TRIGGER sense is unambiguous where the delivery
  // sense is not, and it is the sense that matters: witnessed 2026-08-01, a workspace
  // with nothing connected was told its workflow would run "whenever a new email arrives
  // in your connected inbox".
  //
  // Deliberately anchored on the ARRIVAL verbs rather than on the word "email", so
  // "send me an email", "email the report" and "reply by email" are all left alone.
  { connector: 'google', label: 'Gmail',
    re: /\b(?:new |incoming |inbound )?e-?mails?\b[^.!?]{0,40}?\b(?:arrives?|arriving|lands?|comes? in|is received)\b/i },
  { connector: 'google', label: 'Gmail',
    re: /\bwhen(?:ever)?\b[^.!?]{0,40}?\be-?mails?\s+(?:us|me|in)\b/i },
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
 * The WHOLE reply a person gets instead of a design they cannot build.
 *
 * Composed deterministically, never by a model — the point is that this cannot be the
 * thing that gets it wrong.
 *
 * **IT REPLACES THE MODEL'S WORDS RATHER THAN FOLLOWING THEM, and that was a correction.**
 * The first version appended a notice and kept the model's prose, on the reasoning that
 * the restatement was useful. Charles, 2026-08-01, looking at the result on a fresh
 * workspace: *"it already affirmed building was possible without slack being connected."*
 * He was right. The kept prose said *"hit 'Build it' and I'll walk you through each
 * step"* — affirming an action that had just been withdrawn — and described the workflow
 * running *"whenever a new email arrives in your connected inbox"*, which is a false
 * statement about the customer's own account. A correction underneath a contradiction is
 * not a correction; the user reads the confident part.
 *
 * So the reply IS the instruction. It says what to connect, where to do it, and what
 * happens next — and it never describes a setup that does not exist.
 *
 * It names Connections in the left sidebar and stops there, which is the ONE place in
 * Atlas the product is allowed to name (2026-07-26). It must not grow a description of
 * what is inside it.
 */
export function connectFirstMessage(missing) {
  if (!missing?.length) return null;
  const names = missing.map(m => m.label);
  const list = names.length === 1 ? names[0]
             : names.length === 2 ? `${names[0]} and ${names[1]}`
             : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const one = names.length === 1;
  return `I can't build this yet — it needs ${list}, and ${one ? 'that is' : 'those are'} not connected to this workspace.

Open **Connections** in the left sidebar to connect ${one ? 'it' : 'them'}. It takes a minute and you only do it once.

Once ${one ? 'it is' : 'they are'} connected, tell me and I'll put this together and walk you through every step before anything goes live.`;
}

/**
 * The decision for one outgoing chat turn.
 *
 * Pure, so it can be tested without a server, and returning every half so the caller
 * cannot apply one and forget another: `reply` REPLACES what the model wrote,
 * `readyToBuild` is the flag the button is gated on.
 *
 * @returns {{readyToBuild: boolean, buildIntent: string|null, reply: string|null,
 *            missing: string[]}}
 */
export function connectorGapDecision({ readyToBuild, buildIntent }, connected) {
  const missing = missingConnectorsFor(buildIntent, connected);
  if (!missing.length) {
    return { readyToBuild: !!readyToBuild, buildIntent: buildIntent ?? null, reply: null, missing: [] };
  }
  return {
    readyToBuild: false,
    buildIntent: null,
    reply: connectFirstMessage(missing),
    missing: missing.map(m => m.connector),
  };
}
