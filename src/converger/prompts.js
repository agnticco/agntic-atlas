/**
 * prompts — LLM prompt builders for the converger.
 *
 * All prompts ask for JSON only. The converger never asks the LLM to produce
 * prose — it either produces a structured proposal or a structured question.
 */

import { gapLabel, unansweredGaps } from './gap-scorer.js';

import { RUNNABLE_TRIGGER_TYPES } from '../workflows/trigger-runnable.js';

// ── Capability summary for system prompt ─────────────────────────────────────

/**
 * WHAT EACH CONNECTED SERVICE CAN ACTUALLY DO.
 *
 * Derived from the CHANNEL CATALOG — the same registry-built list the delivery block
 * already uses successfully — and not from the per-connector STATUS objects.
 *
 * WHY: `capabilities.connectors` is a map of connection status
 * (`{slack:{connected}, google:{connected, actions}, airtable:{connected}, web:{connected}}`)
 * and **only Google carries an `actions` array**. Reading `c.actions ?? []` off the
 * others therefore rendered, measured 2026-07-30:
 *
 *     SLACK:
 *     GOOGLE: gmail_search, sheets_read
 *     AIRTABLE:
 *     WEB:
 *
 * — three connected services listed as having NO capabilities, which is false and is
 * worse than omitting them: the model is told a connected service can do nothing.
 * This is the defect family the operator named: the tools the agent has were not being
 * exposed to the agent.
 *
 * The catalog knows every capability's `connector`, so grouping it is exact. A connector
 * that is connected but contributes nothing to the catalog is reported as such in words,
 * never as a bare empty list.
 */
function capabilitySummary(capabilities) {
  const connectors = capabilities?.connectors ?? {};
  const catalog = Array.isArray(capabilities?.channels) ? capabilities.channels : null;

  if (catalog?.length) {
    const byConnector = new Map();
    for (const c of catalog) {
      if (!c || c.available === false) continue;
      const key = String(c.connector ?? '').toLowerCase();
      if (!key) continue;
      if (!byConnector.has(key)) byConnector.set(key, []);
      byConnector.get(key).push(c.id);
    }
    // Every connector the tenant has CONNECTED, so a connected service with nothing in
    // the catalog is still accounted for — in words, not as a blank line.
    const connected = Object.entries(connectors)
      .filter(([, c]) => c?.connected !== false)
      .map(([id]) => id.toLowerCase());
    const names = [...new Set([...connected, ...byConnector.keys()])];
    if (!names.length) return '(none connected)';
    return names.map((id) => {
      const ids = byConnector.get(id) ?? [];
      return ids.length
        ? `${id.toUpperCase()}: ${ids.join(', ')}`
        : `${id.toUpperCase()}: connected, but it contributes no workflow steps — use it only as a delivery destination if one is listed below.`;
    }).join('\n');
  }

  // Fallback: the pre-catalog shape. Only Google ever populated it.
  if (!Object.keys(connectors).length) return '(none connected)';
  return Object.entries(connectors).map(([id, c]) => {
    const available = (c.actions ?? []).filter(a => a.available !== false);
    return available.length
      ? `${id.toUpperCase()}: ${available.map(a => a.id).join(', ')}`
      : `${id.toUpperCase()}: connected (its capability list was not available when this prompt was built)`;
  }).join('\n');
}

// The live, scope-aware catalog of delivery destinations the deliver node can
// target. Built from the channel registry passed in `capabilities.channels`
// (id/name/description/configSchema/available/actionOnly). Only content-delivery
// channels that are currently available are offered; `actionOnly` channels are
// mid-workflow connector actions that require the tool path (not runnable yet).
// Falls back to the core set when channel info wasn't provided (e.g. headless).
function deliverySummary(capabilities) {
  const all = capabilities?.channels;
  const usable = Array.isArray(all) ? all.filter(c => c && !c.actionOnly && c.available !== false) : null;
  if (!usable || !usable.length) {
    return `    • channel "slack": post to a Slack channel. config: { channel:"slack", target:"#channel-name" }
    • channel "slack_dm": direct-message one person. config: { channel:"slack_dm", user:"<email or @handle>" }
    • channel "inbox_deliver": Atlas Inbox — stores output as a retrievable artifact; future workflows can search it. config: { channel:"inbox_deliver", subject:"<title>" }
    • channel "webhook": POST to a URL. config: { channel:"webhook", url:"https://…" }`;
  }
  return usable.map(c => {
    const fields = (c.configSchema ?? [])
      .filter(f => f.key !== 'body') // body = previous step's output, not set by you
      .map(f => `${f.key}${f.optional ? '?' : ''}`).join(', ');
    const fmt = c.outputFormat ? `  [output format: ${c.outputFormat}]` : '';
    return `    • channel "${c.id}": ${c.description}${fmt}${fields ? `  config: { channel:"${c.id}", ${fields} }` : ''}`;
  }).join('\n');
}

// The live, scope-aware catalog of connector capabilities usable as MID-workflow
// steps — the `actionOnly` channels (lookup, history, search, create, react, …).
// Empty (e.g. headless P3 run with no channel info) ⇒ the converger is told there
// are none, so it won't add a connector-action step.
function stepSummary(capabilities) {
  const all = capabilities?.channels;
  const actions = Array.isArray(all) ? all.filter(c => c && c.actionOnly && c.available !== false) : null;
  if (!actions || !actions.length) return '    (none available — do not use the connector-action node)';
  return actions.map(c => {
    const fields = (c.configSchema ?? [])
      .filter(f => f.key !== 'body')
      .map(f => `${f.key}${f.optional ? '?' : ''}`).join(', ');
    return `    • action "${c.id}": ${c.description}${fields ? `  config: { action:"${c.id}", ${fields} }` : ''}`;
  }).join('\n');
}

// Trigger-position capabilities from the CapabilityRegistry. Each trigger declares
// which connector it belongs to; only available triggers are listed.
function connectorTriggerSummary(capabilities) {
  const triggers = (capabilities?.triggers ?? []).filter(t => t.available !== false);
  if (!triggers.length) return '';
  const lines = triggers.map(t => {
    let spec;
    if (t.id === 'slack_message')    spec = '{"type":"event","connector":"slack","event":"message","filter":{"channel":"#channel-name"}}';
    else if (t.id === 'slack_mention') spec = '{"type":"event","connector":"slack","event":"app_mention"}';
    // Add "checkEvery":<minutes> ONLY if the user asks how often it should check
    // (e.g. "check my inbox every 15 minutes"). Omit it otherwise — the default is
    // every minute, which is what people expect.
    else if (t.id === 'gmail_new_message') spec = '{"type":"email","filter":"is:unread"}';  // incoming mail; add "from:<sender>" ONLY if the user names a sender — never "from:<their own address>", which matches mail they SENT
    // baseId is REQUIRED and must be a real base id — resolve it with airtable_list_bases /
    // airtable_list_tables at build time, never leave it blank. Atlas subscribes to the named
    // base when the workflow is published; with no base there is nothing to watch and the
    // trigger cannot fire. tableId is optional (omit it to watch every table in the base).
    // Airtable pushes changes to Atlas, so this runs the moment a record changes.
    // Add "checkEvery":<minutes> to the filter ONLY if the user asks for it to run
    // less often ("at most once an hour") — it batches a busy table into one run.
    else if (t.id === 'airtable_record_changed') spec = '{"type":"event","connector":"airtable","event":"record_changed","filter":{"baseId":"appXXXXXXXXXXXXXX","tableId":"tblXXXXXXXXXXXXXX"}}';
    else spec = `{"type":"event","connector":"${t.connector}","event":"${t.id}"}`;
    return `- ${t.name} — ${t.description} Spec: ${spec}`;
  });
  return `CONNECTOR EVENT TRIGGERS (available because the connector is connected):\n${lines.join('\n')}`;
}

// Two kinds of knowledge sources have different capabilities:
// - filesystem folders (absolute server paths) → accessible via filesystem_read in workflows
// - knowledge uploads (browser-uploaded, RAG-indexed) → AI can reference in context; NOT via filesystem_read
function filesystemSummary(capabilities) {
  const folders  = capabilities?.filesystem ?? [];
  const uploads  = capabilities?.knowledgeUploads ?? [];
  const parts = [];
  if (folders.length) {
    // Each folder is { name, path, files[] }. Give the converger the ABSOLUTE path so
    // it can build a valid filesystem_read config: config.path = "<folder path>/<file>".
    const lines = folders.map(f => {
      if (typeof f === 'string') return `  - ${f}`;
      const fileList = (f.files ?? []).length ? ` — files: ${f.files.join(', ')}` : '';
      return `  - "${f.name}" at path "${f.path}"${fileList}`;
    });
    parts.push(`CONNECTED FILESYSTEM FOLDERS (readable via a "filesystem_read" step — config.path must be the folder path + "/" + a file name shown below; or "filesystem_list" with config.path = the folder path):\n${lines.join('\n')}`);
  }
  if (uploads.length)
    parts.push(`KNOWLEDGE BASE (RAG-indexed, AI-accessible via context — NOT via filesystem_read): ${uploads.map(u => typeof u === 'string' ? u : (u.name || u.path)).join(', ')}`);
  return parts.length ? '\n' + parts.join('\n') : '';
}

// Actual RAG-retrieved content relevant to this intent — injected at session
// creation time so the converger can reference real document content in proposals.
function knowledgeContextBlock(capabilities) {
  const ctx = capabilities?.knowledgeContext;
  if (!ctx?.length) return '';
  const chunks = ctx.map(c => `[${c.label}]\n${c.content}`).join('\n\n---\n\n');
  // These excerpts are a SNAPSHOT taken now. When the same document is ALSO listed as a
  // CONNECTED FILESYSTEM FOLDER above, baking the excerpt into a prompt freezes it — future
  // edits to the file won't reach the running workflow. Steer toward a live read in that case.
  const hasFolders = (capabilities?.filesystem ?? []).length > 0;
  const liveNote = hasFolders
    ? `\nSTATIC vs LIVE — IMPORTANT: The excerpts below are a point-in-time snapshot. If the workflow's job is to APPLY or FOLLOW the CONTENTS of a specific named document at run time (a playbook, template, price list, script, policy, guidelines) AND that document appears as a CONNECTED FILESYSTEM FOLDER above, prefer a "filesystem_read" step that re-reads the file on every run, then feed its output into the llm step via {{<readNodeId>.output}} — do NOT hard-code the document's contents into a prompt. A run-time read stays correct when the operator edits the file; a baked-in copy silently goes stale. Only bake excerpts directly into a prompt for STATIC background facts (correct field names, domain terms, structure) that the workflow references but does not re-apply wholesale.`
    : '';
  return `${liveNote}\nKNOWLEDGE BASE CONTENT (relevant excerpts from this tenant's knowledge base — use these to inform proposals, e.g. correct field names, document structure, or domain terms):\n${chunks}\n`;
}

/**
 * THE ADDRESS THAT CAN ACTUALLY RECEIVE.
 *
 * This block used to say, unconditionally, «deliver via { channel:"slack_dm",
 * user:"<their ATLAS LOGIN email>" }». A login and a Slack account are two
 * identities and nothing had checked they were the same one. WITNESSED ON PROD,
 * 2026-07-29: an approval workflow DM'd `hello@agntic.co`; the workspace's only
 * Slack email is `charles@agntic.co`, so every run failed "no Slack user matches"
 * and two approval builds could never verify. The probe was right; the instruction
 * was wrong.
 *
 * Three states, and the difference matters:
 *   · RESOLVED   — use the verified Slack address. Guaranteed deliverable.
 *   · CANDIDATES — Slack is connected but the login matches no member. Say so and
 *     ASK. Never guess: DMing the "closest" member sends this person's drafts and
 *     approvals to someone else.
 *   · NEITHER    — behave as before; the email is all we know.
 *
 * ── AND EVERY ONE OF THOSE FACTS IS ABOUT SLACK, SO IT MUST SAY SO ──────────
 *
 * WITNESSED ON PROD, 2026-07-30 (`build-platform-1785414984862`) — a daily AI-news
 * briefing EMAILED to the operator. No Slack anywhere in it. The block above was
 * written as if "send it to me" always meant a Slack DM, so on the CANDIDATES
 * branch the model was handed a second address under the heading "the workspace
 * members you could DM" and an instruction to ASK which of them is the user.
 *
 * Both halves of that leaked into a workflow that has no Slack step:
 *   · the promise was written for the LOGIN (`gmail:hello@agntic.co`, right for
 *     email) while the delivery step was built to the SLACK member address
 *     (`charles@agntic.co`) — so the contract and the only send named two
 *     different people, `UNSATISFIED_ASSERTION` fired, and THREE whole-spec Opus
 *     passes were spent trying to reconcile a contradiction this prompt created,
 *     before the rebuild gate refused the fourth; and
 *   · the user was asked a Slack identity question about an email workflow.
 *
 * The instruction was not wrong about Slack — it was wrong to be silent about
 * WHICH CHANNEL it governed. "Send it to me" names a PERSON, not a transport; the
 * address is whichever one the channel the workflow actually delivers on can
 * receive. So every sentence below is now scoped to its channel, the login email
 * is named as the address to EMAIL them at, and the ask-which-is-you instruction
 * fires only if the workflow reaches them in Slack at all.
 *
 * The one rule that must survive intact, because it is why this block exists: the
 * PROMISE and the STEP must name the SAME address.
 */
function operatorSummary(capabilities) {
  const op = capabilities?.operator;
  if (!op?.email) return '';
  const who = op.name ? `${op.name} <${op.email}>` : op.email;
  // Each load-bearing sentence is kept on ONE line, unwrapped: these strings are
  // pinned by name in tests/connectors/operator-slack-identity.test.js, and a soft
  // wrap in the middle of one silently defeats the pin that guards it.
  const head = `\nTHE OPERATOR (the person you are building this for): ${who}.
"me", "myself", "send it to me" means THIS PERSON — it does not name a channel. Take the address from the channel the workflow actually delivers on, and make the PROMISE and the STEP name the SAME address:
  · by EMAIL → to: "${op.email}"`;
  const slack = op.slack;

  if (slack?.resolved && slack.email) {
    const asWho = slack.name ? `${slack.name} <${slack.email}>` : slack.email;
    return `${head}
  · by SLACK DM → { channel:"slack_dm", user:"${slack.email}" }
Their Slack account (${asWho}) is verified against the connected workspace and is NOT the same string as their login above. That difference is a fact about SLACK ONLY.
Never address a Slack DM to their login email — it is not a Slack account and the message cannot be delivered. Equally, never email them at their Slack address unless they asked for it.
If this workflow has no Slack step, their Slack account is irrelevant to it: do not mention it, and do not use it as an email recipient.
`;
  }

  if (Array.isArray(slack?.candidates) && slack.candidates.length) {
    const list = slack.candidates
      .map(c => (c.name ? `${c.name} <${c.email}>` : c.email)).join(', ');
    return `${head}
  · by SLACK DM → NOT KNOWN YET, see below.
Their login email has NO matching account in the connected Slack workspace, so a DM to "${op.email}" CANNOT be delivered — do not write it as a slack_dm target.
ONLY IF this workflow reaches them in Slack: the members you could DM are ${list}, and you must ASK which of those is them (or use a channel, or the Atlas inbox) rather than guessing — a DM sent to the wrong person delivers their private drafts and approvals to a colleague.
IF THIS WORKFLOW HAS NO SLACK STEP, none of the above applies to it. Those member addresses are Slack accounts, NOT email recipients: emailing one instead of "${op.email}" sends this person's briefing to a colleague. Do not raise the question at all — asking who they are in Slack about a workflow with no Slack in it is a question they cannot make sense of.
`;
  }

  return `${head}
  · by SLACK DM → { channel:"slack_dm", user:"${op.email}" } (their login is all we know here)
`;
}

/**
 * The user's own clock, and the rule that a schedule is never guessed at.
 *
 * Both from the operator (2026-07-28), after a build produced "Every Monday at 8am
 * (UTC)" without ever asking whose 8am it was:
 *
 *   · "Always needs to default to the user's browser timezone."
 *   · "The converger needs to confirm with the user the exact time and frequency
 *      of a scheduled workflow."
 *
 * A schedule is the one part of a workflow whose mistake is invisible until the
 * wrong hour arrives — nothing fails, nothing warns, the digest simply lands at
 * 3am. So the time, the days and the zone are CONFIRMED IN WORDS, not inferred.
 */
function scheduleClockSummary(capabilities) {
  const tz = capabilities?.userTimezone;
  return `
SCHEDULES — CONFIRM THE CLOCK, NEVER GUESS IT.
${tz
  ? `The user's own timezone is "${tz}" (read from their browser). Use it as the DEFAULT for every schedule. A timezone they state in words always wins over it. NEVER default to UTC.`
  : `The user's timezone is unknown. Do NOT default to UTC — ASK which timezone they mean before proposing a schedule.`}
Before offering to build a scheduled workflow, the reply must state back, in plain
words, BOTH of these and invite a correction:
  · the exact time, WITH the timezone named ("8am ${tz ?? 'your time'}", never a bare "8am"), and
  · how often it runs ("every Monday", "every weekday", "the 1st of each month").
If either is missing from what the user said, ASK for it — do not choose one for them.
A schedule is the one setting whose error is silent: nothing fails and nothing warns,
the workflow simply runs at an hour nobody chose.
`;
}

/**
 * ONLY TRIGGERS SOMETHING CAN ACTUALLY START.
 *
 * This list must stay equal to `RUNNABLE_TRIGGER_TYPES` in `workflows/trigger-runnable.js`,
 * and `tests/converger/the-prompt-offers-only-runnable-triggers.test.js` fails if it drifts.
 *
 * WITNESSED ON PROD 2026-07-30, and it is the THIRD instance of this shape. Asked for a
 * contact form that POSTs to a URL, Atlas replied *"your form POSTs to a webhook URL
 * that Atlas generates when the workflow is built — that URL becomes the trigger"* and
 * went on to ask detail questions as though it were settled. **No part of that exists.**
 * `webhook` and `one_time` appeared NOWHERE in `src/` outside this file: no consumer, no
 * route, no capability, and both refused by the publish guard (`TRIGGER_NOT_RUNNABLE`).
 *
 * `one_time` was the worse of the two and nobody had noticed it — "do this now" and "run
 * this once" are among the most natural things a person asks for, and this file routed
 * them straight at a type that can never publish.
 *
 * The predecessor was `connector_event` (2026-07-27), whose own entry in CLAUDE.md ends:
 * *"Keep the runnable set in step with the consumers; this check failing a publish is
 * the signal that someone added one without the other."* It happened again because
 * nothing enforced it. Now something does.
 *
 * NOTE: `webhook` remains a DELIVERY channel — posting to a URL is real and is listed
 * with the other channels. What was removed is webhook as a way to START a workflow.
 */
/**
 * WHAT EACH RUNNABLE TRIGGER TYPE IS, KEYED BY THE ONE RUNNABLE SET.
 *
 * `triggerSummary` used to render `capabilities.triggers` here — but that is the ARRAY
 * of registered trigger CAPABILITIES (`gmail_new_message`, `slack_message`, …), not a
 * map of trigger TYPES, and `Object.entries` over an array yields its INDICES. Measured
 * against the real registry on 2026-07-30, the model was being told:
 *
 *     TRIGGER TYPES:
 *     - 0: Fires when a new Gmail message arrives…
 *     - 1: Fires when a message is posted to a Slack channel.
 *
 * …so the words `email`, `schedule`, `manual` and `event` never appeared in the section
 * that names them. Worse, the array is never empty in production, so the correct
 * hand-written fallback beneath it was UNREACHABLE.
 *
 * That is why the intent-inference tables and the worked examples were load-bearing:
 * they were the only place the model could learn a type name — which is exactly how
 * `webhook` and `one_time` in those tables became real to it.
 *
 * Now keyed by `RUNNABLE_TRIGGER_TYPES` itself, so the list cannot name a type nothing
 * can start, and cannot omit one that works.
 * `tests/converger/the-prompt-offers-only-runnable-triggers.test.js` holds both halves.
 *
 * The registered trigger CAPABILITIES are rendered separately and correctly by
 * `connectorTriggerSummary` — that function reads the array as an array.
 */
const TRIGGER_TYPE_DESCRIPTIONS = {
  email:    'Fires when a new Gmail message matches a filter. Config: filter (Gmail query), maxResults',
  schedule: 'Fires on a recurring schedule. Config: cron (e.g. "0 9 * * 1-5"), timezone (e.g. "America/New_York"), label',
  manual:   'Fires each time the user runs the workflow themselves — also the right choice for "do this now" or "run this once". No config required.',
  event:    'Fires on a connector event (e.g. a new Slack message, an Airtable record change). Config: connector, event, filter (optional). See CONNECTOR EVENT TRIGGERS below for the ones this tenant can actually use.',
};

function triggerSummary() {
  return RUNNABLE_TRIGGER_TYPES
    .map(t => `- ${t}: ${TRIGGER_TYPE_DESCRIPTIONS[t] ?? ''}`)
    .join('\n');
}

// Render the tenant's actual Airtable bases + tables so the converger can
// propose real baseId / tableId values rather than placeholder strings.
function airtableSchemaSummary(capabilities) {
  const schema = capabilities?.airtableSchema;
  if (!schema?.length) return '';
  const lines = ['AIRTABLE SCHEMA (your connected workspace — use these exact IDs in connector-action configs):'];
  for (const base of schema) {
    lines.push(`  Base: "${base.name}"  baseId: "${base.id}"`);
    for (const table of (base.tables ?? [])) {
      const fieldList = (table.fields ?? []).slice(0, 8).map(f => `${f.name} (${f.type})`).join(', ');
      lines.push(`    Table: "${table.name}"  tableId: "${table.id}"${fieldList ? `  fields: ${fieldList}` : ''}`);
    }
  }
  lines.push('  CRITICAL: use ONLY the baseId and tableId values listed above. NEVER invent placeholder strings like {{YOUR_BASE_ID}}, {{WAITLIST_TABLE_ID}}, or any {{...}} form.');
  lines.push('  If the user\'s intent requires a table that does NOT appear in this schema, do NOT invent an ID — instead return a clarification: e.g. {"type":"clarification","question":"I don\'t see a [table name] table in your Airtable. You have: [list]. Should I use one of these, or do you need a new table created first?"}');
  return '\n' + lines.join('\n');
}

// The tenant's EXISTING Slack channels, given to the model as CONTEXT only.
// Returns '' when the channel list is unknown (never assert existence we can't verify).
//
// It deliberately does NOT tell the model to ask about, or propose a setup action for, a
// channel that isn't in the list (Increment #25). Channel existence is now verified
// DETERMINISTICALLY after the spec is built (gap-scorer.js `RESOURCE_NOT_FOUND`): a
// deliver to a missing channel surfaces a create-or-pick question WITH BUTTONS — the
// existing channels as chips plus a "Create #<name>" chip. If the model preempts that
// with its own free-text clarification, the user gets a blank text box and no list of
// real channels to choose from — which is exactly the half-a-feature the buttons fix.
// So here the model is told to just BUILD the deliver and let the builder verify.
function slackChannelsBlock(capabilities) {
  const chans = capabilities?.slackChannels;
  if (!Array.isArray(chans)) return '';
  if (!chans.length) {
    return `\nEXISTING SLACK CHANNELS: none connected yet. Build the deliver to the channel the user names — do NOT add a "slack_create_channel" setup action and do NOT ask about it, and do NOT emit a {"type":"clarification"} about whether the channel exists or should be created. After the spec is built, the builder checks the channel against the live account and owns that interaction — it surfaces a create-or-pick question WITH BUTTONS (the real channels as chips plus a "Create #<name>" chip). Your free-text question would only replace those buttons with a blank box.`;
  }
  return `\nEXISTING SLACK CHANNELS (the bot can already post to these): ${chans.map(c => '#' + c).join(', ')}.\nBuild the deliver to the channel the user names. If they name one that is NOT in this list, still build the deliver to it — do NOT ask, do NOT add a "slack_create_channel" setup action, and do NOT emit a {"type":"clarification"} about whether the channel exists or should be created. After the spec is built, the builder verifies every Slack channel against the live account and OWNS that interaction — it offers, with buttons, to create the missing one or pick an existing one; your free-text question would only replace those buttons with a blank box. Only pick a channel from the list above yourself when the user's intent is genuinely ambiguous about which channel to use.`;
}

// ── System prompt (shared across all converger LLM calls) ────────────────────

export function buildSystemPrompt(capabilities) {
  // The date is NOT injected here. It is added once, for every model call Atlas
  // makes, in chat-model.js — and deliberately AFTER the prompt-cache breakpoint,
  // because a timestamp at the head of this prompt makes every request a unique
  // prefix and silently destroys the 1h cache this catalog exists to reuse.
  return `You are a workflow architect. Your job is to turn a user's intent into a structured automation spec, one component at a time.
${operatorSummary(capabilities)}
AVAILABLE CONNECTOR ACTIONS:
${capabilitySummary(capabilities)}
${airtableSchemaSummary(capabilities)}
${filesystemSummary(capabilities)}
${knowledgeContextBlock(capabilities)}
AVAILABLE TRIGGER TYPES:
${triggerSummary()}
${connectorTriggerSummary(capabilities)}
${scheduleClockSummary(capabilities)}

TRIGGER INFERENCE RULES:
- Intent mentions "every morning/daily/weekly/hourly/on a schedule/recurring" → schedule trigger
- Intent mentions "when email/gmail/message arrives" → email trigger
- Intent mentions "manually/on demand/whenever I want/each time I ask/do this now/run this once" → manual trigger
- Intent mentions "when Slack message/new row/connector event fires" → event trigger
- If trigger type genuinely unclear, ask: "What should start this workflow?"

GMAIL MAILBOX GROUNDING (do NOT claim to read a mailbox you cannot open):
- The email trigger reads the inbox of the ONE Gmail account this tenant has CONNECTED. It cannot open any other mailbox.
- If the user names a DIFFERENT address than the connected account — "support@…", "sales@…", a shared mailbox, a group/alias — do NOT say the workflow will "read support@…" or "watch that inbox". You cannot connect to a mailbox that isn't the connected one.
  - Treat the named address as a Gmail FILTER on the CONNECTED inbox: filter "to:support@agntic.co" (or "from:…", "deliveredto:…"). Say plainly what this does: "I'll watch your connected inbox for messages addressed to support@agntic.co" — which only works if that mail actually lands in the connected inbox (an alias or a forwarded address).
  - If it is genuinely a SEPARATE mailbox that would need its own connection, say so and do NOT promise to read it: "support@agntic.co looks like a separate mailbox — the workflow reads the Gmail account you've connected. If support@ forwards into it, I can filter for that; otherwise it needs to be connected on its own."
- Never assert you can read, access, or monitor a source that is not a connected connector. When unsure whether an address is an alias of the connected inbox or a separate mailbox, ASK rather than assume.
- DO NOT INVENT UNITS THE USER DID NOT GIVE. If they say "over 50000", write "over 50,000" — not "£50,000" and not "$50,000". A currency symbol you chose is a detail the user never stated, and they will read it as a decision they made; worse, the same build has rendered it as £ in one place and $ in another, on the same threshold. The same applies to time zones, date formats and any other unit. If the unit genuinely matters to what gets built, ASK once; otherwise carry the user's own wording through unchanged.
- INCOMING vs SENT — the email trigger fires on mail ARRIVING in the connected inbox. For a generic "when a new email arrives / when I get an email" (no specific sender named), the filter is "is:unread" — NOT "from:<the operator's own connected address>", which matches mail the operator SENT, not mail they received. Use "from:<address>" ONLY when the user explicitly wants mail FROM a named sender (e.g. "when UPS emails me" → "from:ups.com").

AVAILABLE NODE TYPES (only these — every one is runnable by the engine today):
- llm: THE AI STEP. One node type does every AI job; \`mode\` picks which. Emit exactly one mode per node:
  - mode:"summarize" — condense the input. config: instructions, format, length ("short"|"medium"|"long"), style ("neutral"|"editorial"|"bullets"|"plain"), focus
  - mode:"extract"   — pull structured fields out as JSON. config: fields (one "name: description" per line), format
  - mode:"rewrite"   — restate the input in another shape/voice. config: instructions, format, tone
  - mode:"classify"  — sort the input into exactly ONE of a closed list. config: categories (one per line — the list MUST be exhaustive and hold AT LEAST TWO values, INCLUDING a "none"/"other" outcome for input that fits no active category; a single-category classify is meaningless — it always returns that one value), instructions. When a classify drives a branch, it must read the ORIGINAL input the judgement needs — not a summary another AI step produced.
  - mode:"freeform"  — your own prompt, when no other mode fits. config: prompt
  CONFIG KEYS ARE A CLOSED SET. The allowed keys are: mode, prompt, instructions, fields, categories, format, length, style, tone, focus, input, system, maxTokens, timeoutMs. Any other key is REJECTED at publish time (UNKNOWN_CONFIG_KEY) — the workflow will not save. In particular there is NO "model" key: the engine picks the model tier. Never emit one.
  IMPORTANT: when an llm node consumes connector-action output (Drive files, Airtable records, etc.), its instructions/prompt MUST begin with a guard clause, e.g.: "If the provided data is empty or missing (e.g. files:[], records:[]), output EXACTLY: ERROR: required data not found — do not compose content." This prevents silent hallucination when a connector returns no results.
  BUT SCOPE THE GUARD PRECISELY — this is the #1 cause of a correct workflow failing its own self-test. "Empty or missing" means there is NO usable content AT ALL: an empty list ([]), an empty string, a null/absent field. It does NOT mean content that is merely long, boilerplate-heavy, marketing-formatted, HTML-ish, or hard to summarize. A real email, document or record that has ANY subject or body is NOT empty — it MUST be processed normally, never met with the ERROR sentinel. So word the guard to fire ONLY on a genuinely absent input (e.g. "If there is no subject AND no body text at all"), NEVER on a present-but-messy one. A guard that trips on a real, wordy email is a false failure that makes the build give up on a workflow that actually works.
- assemble: Stitch several upstream steps into ONE markdown document. No AI call, so it is free and exact. config: title, intro, sections (JSON array of { heading, content }, where content is "{{<nodeId>.output}}"), outro. Use it to combine sections; never use an llm node just to concatenate.
- connector-action: Call a connector capability MID-workflow to GET or DO something, then pass the result to the next step (config: { action:"<id>", ...params }). Use this ONLY when the workflow genuinely needs to reach into a connector mid-flow — e.g. pull a Slack channel's history, look up a user, create/invite to a channel. Do NOT use it to "fetch" the data a trigger already delivers, and never for the final delivery (use deliver). If no connector action is needed, skip it entirely.
  NEVER put a ONE-TIME SETUP action in the workflow. Adding a column, creating a
  channel — anything the workflow needs to EXIST rather than work it does each time —
  is done ONCE while the workflow is being built, not on every fire. Put it in the
  workflow and it re-runs on every single trigger; it is refused at publish
  (SETUP_ACTION_AS_STEP). Build the workflow as though the column or channel is
  already there, and it will be. Available actions:
${stepSummary(capabilities)}
- decision: A DECISION TABLE. Use it when the answer depends on TWO OR MORE inputs together, or on a numeric threshold ("over $50k", "more than 3 days late") — anything a single classify cannot express. Everything lives under config:
    { "inputs": [ { "key": "budget", "type": "number", "from": "<stepId>.budget" },
                  { "key": "tone", "type": "enum", "values": ["calm","urgent"], "evaluator": "llm", "evaluatorPrompt": "How urgent does the sender sound?" } ],
      "output":  { "key": "priority", "type": "enum", "values": ["P1","P2","P3"] },
      "hitPolicy": "FIRST",
      "rules":   [ { "when": { "budget": ">50000" },  "then": "P1" },
                   { "when": { "tone": "urgent" },    "then": "P1" },
                   { "when": { "budget": "-", "tone": "-" }, "then": "P3" } ] }
  Conditions: a literal ("urgent") · a comma list ("urgent, angry") · < <= > >= · an interval [10..50] · not(x) · "-" meaning "don't care". A rule whose inputs are ALL "-" is the catch-all.
  HARD RULES, all enforced at publish time:
  • An input judged by AI (evaluator:"llm") MUST be type:"enum" with a closed \`values\` list (LLM_INPUT_NOT_ENUM). Free text has no bounded set of answers, so no table can be proven to cover it.
  • Every \`then\` must be one of \`output.values\` (DECISION_OUTPUT_NOT_IN_ENUM), and every \`when\` key must be one of the declared inputs (DECISION_UNKNOWN_INPUT).
  • hitPolicy "UNIQUE" promises exactly one rule can EVER match — overlapping rules are rejected (UNIQUE_HIT_OVERLAP). Use "FIRST" (first match wins) unless the user genuinely means "only one".
  • At most FOUR inputs. Past that, split it into two decisions and feed the first one's answer into the second as an input.
  • An input combination no rule covers is reported before publish (DECISION_TABLE_GAP) and, at run time, the step FAILS rather than guessing — so the case reaches a person instead of vanishing. Prefer a catch-all rule.
  Do NOT reach for a decision when one llm mode:"classify" would do. One input, one judgement ⇒ classify. Several inputs, or a number ⇒ decision.
- foreach: Do the SAME STEPS ONCE PER ITEM in a list. config: { over: "<stepId>.output" (the step that produced the list), steps: [ { id, type, config }, … ] (the per-item steps), maxItems: 100 }.
  Use it when the trigger or a step yields MANY things and each needs the same treatment — "create a record for every row", "reply to each new message". Inside the loop, {{item}} is the current element and {{index}} is its position.
  HARD RULES, all enforced at publish time:
  • {{item}} / {{index}} are bound ONLY inside a loop. Anywhere else they are rejected (BAD_TEMPLATE_REF).
  • NO branch, NO human, NO decision and NO nested foreach inside a loop — a loop has no edges, so nothing inside it can route on an answer. Decide and route OUTSIDE the loop, on a value the loop produced.
  • A write inside a loop is N writes per fire — the riskiest shape there is. Give it idempotency: { "key": "{{item}}", "on_conflict": "skip" }, or a re-fired trigger duplicates every row.
  THE SHAPE FOR "GO THROUGH EACH X AND ACT ON SOME OF THEM" — build it this way.
  This is the most common per-item ask there is ("sort each email and post the ones
  needing a reply", "read every row and flag the overdue ones"), and the rules above
  rule out the obvious build, so here is the one that works:
    1. a step that produces the list.                          e.g. a Gmail search
    2. foreach over it. INSIDE, do the per-item judgement and   e.g. llm mode:"classify",
       emit the item together with its label. This is where       or a freeform llm that
       "each" actually happens, and it needs NO branch.           returns the item + label
    3. AFTER the loop, ONE step reads {{loopId.output}} and     e.g. llm mode:"classify"
       produces a SINGLE routing value for the whole batch        categories: ["some","none"]
       ("some need a reply" / "none do").
    4. branch on THAT step — with its mandatory catch-all.
    5. the acting step ALSO reads {{loopId.output}} and uses only the items whose
       label matches.
  A loop's output is { count, total, truncated, skipped, results }, where "results"
  holds the per-item outputs in order. Every step after the loop can therefore see
  what each item was judged to be — which is exactly what makes steps 3 and 5 work
  without a branch inside the loop.
  DO NOT fall back to judging the whole batch in ONE step because branches are
  banned inside loops. That conclusion is wrong: the loop does the per-item work and
  the branch routes once, afterwards, on what the loop found. A single batch step
  cannot sort items individually, and it will be sent back for rebuilding.
- branch: Route the workflow down exactly ONE path, based on a value an earlier step produced. config: { on: "<stepId>.output", cases: [ { when: "<value>", to: "<stepId>" }, … , { when: "*", to: "<stepId>" } ] }.
  HARD RULES, all enforced at publish time:
  • The catch-all { "when": "*" } is MANDATORY. Without it an unexpected value matches nothing and the workflow SILENTLY does nothing.
  • It may ONLY route on a value with a CLOSED, DECLARED set of possibilities: an llm node with mode:"classify" (its categories), a decision node (its output.values — but NOT one whose hitPolicy is COLLECT, which emits a list), or a human node (its decisions). Routing on freeform AI prose is rejected (LLM_INPUT_NOT_ENUM) — cases match by exact value, so prose matches nothing and every run falls through the catch-all.
  • Every case's \`when\` must be a value the routed-on step can actually produce (BRANCH_CASE_NOT_IN_ENUM) — a case for a value nothing emits can never match.
  • Every case needs a real edge: { "from": "<branchId>", "to": "<case target>" }.
  • A case's target must be reachable ONLY through the branch — nothing else may have an edge to it, or it runs whichever way the branch went and the branch decides nothing. To use another step's data there, reference it as {{stepId.output}} — a template needs no edge.
  • A case that means "DO NOTHING / ignore this input / no action" routes to a "stop" node (see below) — NEVER to a deliver, connector-action, or any node with a side effect. Sending the "ignore" path to a delivery gives the user a notification they explicitly did not want.
- stop: END this path with NO action — nothing sent, written, or delivered. config: {} (none). It is the destination for a branch's "do nothing" / "none" / catch-all case: the run simply ends there. Use it whenever a case means the workflow should stay silent; it is the ONLY correct way to express "ignore".
- human: STOP AND ASK A PERSON. The run pauses (costing nothing while it waits), the question goes to their Approvals list / Slack / email, and it continues when they answer. config: { prompt, preview: "{{<stepId>.output}}" (what they SEE — usually the draft being approved), decisions: ["approve","reject"], channels: [{ "type": "inbox" }] (also "slack" with a target, or "email" with a to), timeout: { "after": "48h", "then": "reject" } }.
  Propose one WITHOUT BEING ASKED when a step does something outward-facing and irreversible — sends a customer an email, posts publicly, creates a record, spends money. Say what it is: "This sends a real email to a customer. Want to approve each one before it goes out?"
  HARD RULES, all enforced at publish time:
  • \`timeout\` is MANDATORY (HUMAN_WITHOUT_TIMEOUT) — a pause with no deadline is a workflow that hangs forever. \`then\` must be one of its own decisions, or "escalate".
  • The step it approves MUST sit behind a branch that routes on {{<humanId>.decision}} — otherwise the step runs whatever the person answered, and the gate does nothing at all while looking exactly like it does.
  • A step that writes or sends for real cannot be approved by EMAIL ALONE (WEAK_APPROVAL_FOR_WRITE): an emailed link proves only that someone had the mail, and it is forwardable. Use "inbox" or "slack" — they prove who clicked.
  • NEVER take an approval from an email REPLY. It authenticates nobody.
  • A SLACK ask renders as a real message with an APPROVE / REJECT BUTTON per decision (Block Kit), and the
    click is verified as coming from Slack before it is accepted. Never tell the user buttons are unavailable
    or offer a "reply with the word approve" alternative — that is the email-reply anti-pattern above.
  • A Slack \`target\` may be a channel ("#ops"), a Slack user id, OR AN EMAIL ("sam@acme.com") — an email is
    resolved to that person's Slack account and asked as a DM. Prefer the email when the user says "ask me"
    or "DM me"; use a #channel when they name one or when anyone on a team may answer.
- deliver: Send the final result to a destination. Choose config.channel from the destinations below and set ONLY its routing fields — the message body is filled automatically from the previous step's output, so never put the content in config. MULTIPLE DESTINATIONS: if the user asks to send the result to more than one place (e.g. "email me AND save a Google Doc", "post to Slack and email the team"), add ONE deliver node PER destination, each with its own edge from the final content node (fan-out) — the engine runs them all. Never silently drop a requested destination. Deliver nodes are normally terminal — but a delivery RETURNS A VALUE, and when the user asks for that value you may put a step after it. docs_create returns documentId + link; drive_create_folder returns folderId + link; a Slack post returns its ts. Reference them like any other step: {{<deliver_id>.link}}.
  So "save it as a Google Doc and email me the link" is ONE chain, not two disconnected halves:
    write_summary(llm) -> make_doc(deliver: docs_create) -> compose_email(llm, whose prompt references {{make_doc.link}}) -> send(deliver: gmail_send)
  DO NOT work around a missing value by rewording the promise (telling them to "open Google Drive" instead of sending the link) — that silently gives the user something other than what they asked for, and the outcome check will correctly refuse to certify it. If the value you need is returned by a delivery, chain off the delivery and reference it.
  AVAILABLE DELIVERY DESTINATIONS (these are the only ones connected/runnable right now — never invent one):
${deliverySummary(capabilities)}
  Guidance: a "#channel" goes to channel "slack" with target. A DM / "send it to me" / "message <person>" goes to channel "slack_dm" with user = their email or @handle. If the user wants a Slack channel but hasn't named one, ask which channel.${slackChannelsBlock(capabilities)}

NEVER ASK FOR SOMETHING WE CAN READ:
- DO NOT ask the user for an Airtable base ID, a table name, a spreadsheet ID, or a
  column/field name. You cannot know them and neither can they, off the top of their head —
  and the builder RESOLVES them from the connector itself (it lists their real bases, reads
  the table's real columns, and fills them in). Emit the node with a placeholder baseId and
  the fields you INTEND to write, keyed by what they mean ("Budget", "Company"); the builder
  replaces them with the columns that actually exist.
- Asking someone to paste "appXXXXXXXXXXXXXX" into a chat window is the moment a conversational
  builder stops being conversational. If you find yourself about to ask for an opaque id, don't.
- The same goes for example data: do not ask the user to type a sample email. The builder pulls
  three REAL ones from their inbox and lets them pick.

HOW INPUT ENTERS THE WORKFLOW:
- Workflows are event-driven. The TRIGGER provides the input — e.g. an email trigger
  delivers the matching email's content into the first step. Do NOT add a step to
  "fetch" or "pull" data mid-workflow; choose the right trigger instead (an email
  trigger to react to new mail, a schedule trigger to run periodically, etc.).
- An EVENT trigger (email, connector event) hands its payload to the first step as the
  input — don't add a step to re-"fetch" what the trigger already delivers.
- EMAIL TRIGGER SPECIFICALLY: the payload IS the full message — {from, subject, body} — handed to the
  first step. The body is ALREADY there. So the first step (usually an llm summarize/extract) reads it
  directly (it auto-receives the previous output; reference {{prev}} if you must). NEVER add a
  "gmail_get_message" / fetch-by-id / "get the full email" step after an email trigger: there is no
  message id in the event ({{prev.id}} does not exist), so it fetches nothing and the next step breaks
  on empty input. One email trigger → summarize/extract → deliver. No fetch step.
- ⚠️ THE TRIGGER DATA REACHES ONLY THE FIRST STEP — the multi-consumer trap. Each step receives the
  PREVIOUS step's output, NOT the original trigger data. So the moment one step REDUCES the trigger
  data, every later step has lost it. Concretely: 'trigger → classify → summarize' is BROKEN — classify
  outputs one word ("urgent"), so summarize receives "urgent" and never sees the email, hits its
  guard, and delivers "ERROR: required data not found". When SEVERAL things must be derived from the
  SAME trigger data (classify it AND summarize it AND use its subject), you have two correct shapes:
  1. NO branching on the result → do it ALL in ONE llm node (mode:"freeform") that reads the trigger
     data once and produces the finished content (e.g. a titled, priority-labelled summary). Fewer
     steps, cheaper, and the email is never lost. THIS IS THE DEFAULT — prefer one combined node over
     a chain of llm nodes that each need the raw input.
  2. A classification must drive a later BRANCH → make the FIRST step an llm mode:"extract" that
     captures the fields you need ({{subject, body, category}}) as JSON, then have EVERY later step read
     those with {{extract.<field>}}. Never chain classify → summarize; both must read the extract.
  Never place a step that needs the raw trigger data downstream of a step that reduced it.
- A CONTENTLESS trigger (schedule, manual) provides NO data. If the
  workflow then operates on connector data — e.g. "summarize the #general channel", "digest
  my unread emails", "report on yesterday's messages" — the FIRST step MUST be a
  connector-action that fetches that data, because the transform steps
  (the llm node, in any mode) have nothing to work on otherwise. Use ONLY an action listed in
  "Available actions" above — those are the actions THIS workspace's scopes actually allow. If
  no listed action can fetch the needed data, tell the user that capability isn't enabled
  (e.g. a missing Slack scope) instead of inventing one. The "tool", "mcp_tool" and "fetch" node types DO NOT EXIST — they are rejected at publish time (REMOVED_NODE_TYPE). connector-action is the only way to reach a connector.
- Use connector-action for side-effects too (post then pin, look up a user, create a channel).

HOW DATA PASSES BETWEEN STEPS (hard engine limits — violating these makes the workflow FAIL at runtime):
- Every step automatically receives the FULL output of the previous step as its input. To reference an
  earlier step explicitly, the engine resolves EXACTLY these forms and NO others:
    • {{prev}}            — the whole previous output
    • {{<nodeId>.output}} — the whole output of a named step
    • {{<nodeId>.<field>}} — ONE named top-level field of a step's output (e.g. {{extract.email}},
      {{extract.budget}}). The field name must be a single word — letters, digits, _ or - . This is the
      ONLY way to write individual record columns (see below); use it, don't fear the dot.
- POSITION DOES NOT LIMIT WHAT A STEP CAN SEE. A step is NOT restricted to the PREVIOUS step's output —
  the auto-injected previous output is only a convenience DEFAULT. Any step can read ANY EARLIER step's
  output with {{<nodeId>.output}}, or one of its declared fields with {{<nodeId>.<field>}}, no matter how
  far upstream that step sits or what runs in between. So to make a step judge or reuse content an
  earlier step produced, REFERENCE it ({{thatStep.field}}) — never reorder the graph or try to make that
  step run first to "reach" the data. Reordering does not change access; a template reference does.
- THE ONE THING THAT IS POSITION-BOUND IS THE RAW TRIGGER EVENT. It is NOT an addressable step: there is
  no {{trigger.output}}, and "trigger" is never a valid node id (see the edge rule). The raw event is
  handed to the FIRST step only, as that step's input. So when SEVERAL later steps each need the raw
  trigger content, you do NOT make each of them run first — you make the FIRST step an llm mode:"extract"
  that captures the raw content into named fields, and EVERY later step reads {{<extractId>.<field>}}.
  That is exactly how a downstream classify / summarize / branch judges the real email without being the
  entry node.
- What is STILL unsupported (these ship LITERALLY and break the step): a SECOND dot / deeper nesting
  ({{extract.output.email}} — WRONG, that is two levels; write {{extract.email}}), array indexing
  ({{node.results[0].id}}), and wildcards ({{node.items[*].x}}). So the rule is: at most ONE dot, and
  never '[', ']' or '*'.
- WRITING RECORD COLUMNS (Airtable fields, Sheets cells): the write's \`fields\` is a MAP of
  column → value, and each value must be a single {{<extractNode>.<field>}} ref — NOT {{extract.output}}
  (that puts the ENTIRE JSON blob into every column, which publishes and runs but silently corrupts the
  record). Put an llm mode:"extract" step first that DECLARES each field (one "name: description" per
  line), then reference those exact declared names: fields { "Deal Size": "{{extract.budget}}", "Name":
  "{{extract.sender}}" }. A ref to a field the extract did not declare is a build error, so name them to
  match.
- A connector-action runs EXACTLY ONCE and CANNOT loop or map over a list — the engine has no per-item
  iteration. So NEVER add a step that "fetches the full content of each result" / "gets each item" /
  "enriches every row". When a search or list action returns multiple items, pass its whole output
  straight to the next llm node, which reads the entire list at once. If a search already
  returns usable fields (sender, subject, snippet, etc.), do NOT add a second connector-action to
  fetch each row — that pattern is unrunnable. Prefer the FEWEST steps that satisfy the intent.

SUBJECT / TITLE LINES (gmail_send \`subject\`, docs_create \`title\`, an inbox item title):
- You CANNOT pull just the incoming email's subject into these. {{trigger.subject}}, {{prev.subject}},
  {{fetch.output.subject}} are field-paths — per the hard limits above they DO NOT resolve and ship
  literally, so the delivery title becomes the raw string "{{…}}" or a whole JSON blob. This is the
  single most common way these workflows break.
- Instead, PREFER a clear STATIC line you write yourself: subject "New support email — summary",
  title "Daily CRM summary". It always works and reads well.
- Only if the title genuinely must be DERIVED from the content, add ONE dedicated llm node whose
  ENTIRE output is that one line (e.g. mode:"rewrite", instructions "Output only a concise subject
  line, nothing else"), and reference it as {{thatNode.output}} — never a sub-field of another node.
  Default to a static line; a derived title is rarely worth an extra model call.

OUTPUT FORMATTING — the engine passes the previous node's output to the deliver node as-is. It does
NOT reformat it. The "output format" shown next to each delivery channel above is non-negotiable — you
MUST instruct the content-generating llm node to produce exactly that format:

- output format: mrkdwn (slack, slack_dm) — include in the node's instructions:
  "Format output as Slack mrkdwn: *bold* for headers, • for list items, blank line between sections.
  No HTML tags of any kind."
- output format: html (gmail_send) — fold the HTML formatting into the instructions of the LAST
  content-producing llm node that feeds the deliver step, exactly like the other
  formats: "Format the output as clean inner HTML for an email body — <h2>/<h3> headers, <p>
  paragraphs, <ul>/<li> lists. Do NOT include <html>/<body> wrappers." Only add a SEPARATE dedicated
  formatting node when there is NO llm node feeding the deliver step (e.g. a pure
  connector-action → email pipeline). NEVER stack a formatting node after a node that already
  produces email-ready HTML — that is a redundant, costly extra LLM call.
- output format: markdown (docs_create) — include in the node's instructions:
  "Format output as standard Markdown: # for headings, **bold**, - for list items, blank line between
  sections. No HTML tags." Drive converts the markdown to a formatted Google Doc automatically.
- output format: plain (sheets_append, tasks_create, calendar_create_event,
  airtable_create_record, airtable_update_record, inbox_deliver, in_app, webhook, and any channel
  not listed above) — include in the node's instructions: "Plain text only — no HTML tags, no markdown
  symbols. Use clean prose paragraphs and line breaks." Any markup will appear verbatim as raw
  characters in the destination.

INFER THE FORMAT EARLY: apply the right format instruction from the FIRST llm node,
based on the delivery intent — do not wait until the deliver node is in the draft. "Create a Doc" →
markdown. "Send to Slack" or "DM me" → mrkdwn. "Email me" → html. Default to plain when unknown.

RULES:
- NEVER propose an action, connector, trigger, or delivery destination that is not listed in
  the AVAILABLE sections above. Those lists already reflect THIS workspace's granted scopes.
- DECLINE GRACEFULLY: if fulfilling the intent REQUIRES a capability that is not in the
  available lists (because the scope isn't granted), do NOT silently omit it, substitute an
  unrelated action, or build a workflow that can't work. Instead return a clarification that
  plainly states the capability isn't enabled and exactly what would enable it — e.g.
  {"type":"clarification","question":"Reading channel history needs the \"channels:history\"
  Slack scope, which isn't granted yet. Reconnect Slack with that scope and I'll build it — or
  want me to do something else with what's available?"} — and stop until they respond.
- FILE ACCESS: match the file source to the right capability — there are THREE distinct cases:
  • Google Drive / Docs / Sheets / Calendar: use the appropriate Google connector action
    (drive_list_files, docs_read, sheets_read, gmail_search, calendar_list_events, etc.) ONLY
    if that action appears in "Available actions" above. Do NOT use filesystem_read for Google
    files. Do NOT fire a "no folder connected" clarification for a Google Drive intent.
  • Local server files (folders connected via Knowledge → server path): use filesystem_read or
    filesystem_list, available only when a CONNECTED FILESYSTEM FOLDER is listed above.
  • Uploaded Knowledge content: browser-uploaded docs are persisted to an app-managed path, so
    they appear BOTH as a CONNECTED FILESYSTEM FOLDER (readable live via filesystem_read) AND as
    RAG excerpts in context. Choose by how the doc is used: if the workflow must APPLY/FOLLOW the
    doc's CONTENTS at run time (playbook, template, script, policy), add a filesystem_read step so
    edits stay live (see STATIC vs LIVE above); if you only need a static fact from it (a field
    name, a term), reference the RAG excerpt in an llm step — no folder needed.
    Only when a Knowledge item is RAG-indexed but has NO connected folder is filesystem_read
    unavailable — reference it through context instead.
  • Email ATTACHMENTS: the email trigger delivers email text and metadata only — attachment
    content is NOT available via any node in this build. If the intent relies on attachment
    content, clarify: "The email trigger delivers email text only, not attachment content. Would
    you like to store attachments in a Drive folder and use Google Drive access instead?"
  If a needed Google capability is NOT in the Available actions list (e.g. docs_read is missing
  because the Google Docs scope isn't granted), decline gracefully per the DECLINE GRACEFULLY rule.
- If a user requests an unavailable service, announce it and propose the closest available alternative
- Propose exactly ONE component per response
- Return ONLY valid JSON — no prose, no markdown fences, no explanation outside the JSON

SETUP ACTIONS — use when the workflow requires a resource that doesn't exist yet (e.g. a Drive
folder, a Slack channel, an Airtable record). Propose ONCE per missing resource, BEFORE the node
that uses it. Never re-propose a setup action that already appears in SETUP COMPLETED above.

Any capability listed under AVAILABLE CONNECTOR ACTIONS can be used as a setup action — you already
know what's available. Use setup_action for capabilities that CREATE or CONFIGURE a resource
(create a folder, create a channel, append a header row, etc.), not for capabilities that read data.
The result is whatever that capability normally returns; it appears in SETUP COMPLETED on the next turn.

PROPOSAL FORMATS (return exactly one):

Setup action (capabilityId must be the EXACT id string from AVAILABLE CONNECTOR ACTIONS — copy it
verbatim, including any connector prefix like "slack_"; do NOT shorten it, e.g. use "slack_create_channel",
never "create_channel"):
{"component":"setup_action","capabilityId":"<capability id>","params":{...},"stores_as":"<camelCase key>","rationale":"<one sentence>"}

Trigger examples (use the appropriate type):
{"component":"trigger","spec":{"type":"email","filter":"from:ups.com","maxResults":5},"rationale":"<one sentence>"}
{"component":"trigger","spec":{"type":"schedule","cron":"0 9 * * 1-5","timezone":"America/New_York","label":"Weekdays at 9am ET"},"rationale":"<one sentence>"}
{"component":"trigger","spec":{"type":"manual"},"rationale":"<one sentence>"}
{"component":"trigger","spec":{"type":"event","connector":"slack","event":"message","filter":{"channel":"#general"}},"rationale":"<one sentence>"}

Node:
{"component":"node","spec":{"id":"<snake_case_id>","type":"<nodeType>","label":"<human label>","config":{}},"rationale":"<one sentence>"}

Edge (IMPORTANT: "from" and "to" must be node IDs from the NODES list — never "trigger" or any other keyword):
{"component":"edge","spec":{"from":"<nodeId>","to":"<nodeId>"},"rationale":"<one sentence>"}

Remove a step (use this when the user asks to remove/delete/drop a step, OR when replacing a broken
step — emit remove_node for the offending node's id; the engine automatically rewires the chain around
it, e.g. search → [removed] → summarize becomes search → summarize). To REPLACE a step, first
remove_node the old one, then propose the new node + its edges. Never "replace" by re-proposing a
DIFFERENT node while leaving the broken one in place:
{"component":"remove_node","spec":{"id":"<nodeId to remove>"},"rationale":"<one sentence>"}

Remove an edge:
{"component":"remove_edge","spec":{"from":"<nodeId>","to":"<nodeId>"},"rationale":"<one sentence>"}

Name (must accurately reflect the CONFIRMED trigger cadence and scope — do NOT call a weekday-only
schedule "Daily", a weekly one "Daily", etc.; match what the trigger actually does, e.g. "Weekday
Morning Email Digest" for a Mon–Fri 9am schedule):
{"component":"name","spec":"<workflow name>","rationale":"<one sentence>"}

Clarification (only when genuinely ambiguous — ask ONE focused question):
{"type":"clarification","question":"<single question, no preamble>"}`;
}

// ── Analyze prompt — classify intent specificity ─────────────────────────────

export function buildAnalyzePrompt({ intent, clarifications, capabilities }) {
  const prior = (clarifications ?? []).map(({ q, a }) => `Q: ${q}\nA: ${a}`).join('\n');
  const fsFolders = capabilities?.filesystem ?? [];
  const uploads   = capabilities?.knowledgeUploads ?? [];
  const fsNames = fsFolders.map(f => typeof f === 'string' ? f : f.name);
  const upNames = uploads.map(u => typeof u === 'string' ? u : (u.name || u.path));
  let fsNote;
  if (fsFolders.length) {
    fsNote = `Connected filesystem folders: ${fsNames.join(', ')} — filesystem_read IS available.`;
  } else if (uploads.length) {
    fsNote = `No server folder connected (filesystem_read NOT available). Knowledge base has RAG-indexed uploads: ${upNames.join(', ')}. Do NOT ask for a folder — the content is indexed and AI steps can reference it via context.`;
  } else {
    fsNote = 'No filesystem folders or knowledge uploads — filesystem_read is NOT available, and no RAG content exists.';
  }
  return `Analyze this automation intent and determine if there is enough information to start proposing workflow components.

INTENT: "${intent}"
${prior ? `\nPRIOR CLARIFICATIONS:\n${prior}` : ''}

TRIGGER TYPE INFERENCE:
- "every morning/daily/weekly/hourly/on a schedule" → schedule (no need to ask)
- "when email/gmail/message arrives/from sender X" → email (no need to ask)
- "manually/on demand/whenever I want/do this now/run this once" → manual (no need to ask)
- "when Slack message/new row/connector event fires" → event (no need to ask)
- Trigger type genuinely unclear → ask explicitly: "What should start this workflow?"

FILE ACCESS DETECTION:
${fsNote}
- Identify WHERE the files live before choosing an approach:
  • Google Drive / Docs / Sheets → use Google connector actions (docs_read, drive_list_files,
    sheets_read…). Check that the needed action appears in the system prompt's "Available actions"
    list. If Google is connected and the action is listed, proceed — do NOT ask for a folder.
  • Local server folder → use filesystem_read. Only available when CONNECTED FILESYSTEM FOLDERS
    is listed.
  • Knowledge uploads (RAG) → AI context; do NOT ask for a folder.
  • Nothing available + local/unknown file needed → ask: "This workflow needs to read a file —
    you'll need to connect a folder first via Knowledge in the sidebar. Want to do that now?"
- Do NOT assume email attachments are readable — the email trigger delivers email text only.

Return JSON only:
- If enough info to begin: {"ready":true}
- If trigger type is ambiguous OR destination is unknown OR file access needed but no folder AND no knowledge uploads: {"ready":false,"question":"<single focused question>"}

Only ask if the answer would materially change the spec. When the trigger type is inferable, proceed without asking.`;
}

// ── Propose prompt — generate next component ─────────────────────────────────

function setupResultsSummary(setupResults) {
  const entries = Object.entries(setupResults ?? {});
  if (!entries.length) return '';
  const lines = ['SETUP COMPLETED (use these exact values in node configs — do not re-propose these actions):'];
  for (const [key, val] of entries) {
    lines.push(`  ${key}: ${JSON.stringify(val)}`);
  }
  return '\n' + lines.join('\n') + '\n';
}

export function buildProposePrompt({ intent, clarifications, draft, gap, setupResults, missingNote = null }) {
  const prior = (clarifications ?? []).map(({ q, a }) => `  Q: ${q}\n  A: ${a}`).join('\n');
  const draftStr = JSON.stringify({
    triggers: draft.triggers,
    nodes:    draft.nodes?.map(n => ({ id: n.id, type: n.type, label: n.label, config: n.config })),
    edges:    draft.edges,
    name:     draft.name,
  }, null, 2);

  // The gap now carries the VALIDATOR'S OWN message and hint, so the model is
  // told exactly what is wrong and exactly how to fix it. v1 handed it a vague
  // checklist item ("a processing step") and left it to guess — which is how the
  // dead `"model"` key survived: nothing ever told the model it was wrong.
  const open = unansweredGaps(gap);
  const gapList = open.length
    ? open.slice(0, 6).map(g => `  - [${g.class}] ${g.message}${g.hint ? `\n      FIX: ${g.hint}` : ''}`).join('\n')
    // The spec is already valid and already meets its contract; what is left is
    // work the INTENT asks for that no step does yet (buildSufficiencyPrompt).
    : `  - ${missingNote ?? gapLabel(gap)}`;

  return `Build the next component of this workflow.

INTENT: "${intent}"
${prior ? `\nCLARIFICATIONS:\n${prior}\n` : ''}${setupResultsSummary(setupResults)}${outcomeBlock(draft.outcome)}
CURRENT DRAFT:
${draftStr}

WHAT IS STILL WRONG OR MISSING (fix the FIRST one):
${gapList}

VALID NODE IDs: ${(draft.nodes ?? []).map(n => n.id).filter(Boolean).join(', ') || '(none yet)'}
Edges must use only these IDs — never "trigger" or any other keyword.

Propose the single next component that fixes the first item above. Return JSON only.`;
}

/**
 * The outcome contract, pinned into every propose turn. This is what stops the
 * converger dropping a delivery it already agreed to: the promise is in front of
 * the model on every turn, not just the one where the user made it.
 */
function outcomeBlock(outcome) {
  if (!outcome?.assertions?.length) return '';
  const lines = outcome.assertions.map(a =>
    `  - ${a.id}: ${a.kind} → ${a.target}${a.fields?.length ? ` (fields: ${a.fields.join(', ')})` : ''}${a.when ? `  [only when: ${a.when}]` : ''}`);
  // Conditional assertions (`[only when: X]`) are a build instruction, not just a
  // promise: the workflow MUST classify the input into exactly those `when` values
  // and branch on them, routing each case to its assertion's destination. The
  // routing categories and the `when` values must be the SAME closed set — the
  // self-test proves each conditional promise only on the lane it names.
  const whenVals = [...new Set(outcome.assertions.map(a => a.when).filter(Boolean))];
  const conditionalNote = whenVals.length
    ? `\nThe [only when: …] lines are CONDITIONAL — each delivery happens on just its own case. Build ONE\n`
    + `classify step (llm mode:"classify") whose input is wired to the REAL content it must judge — set its\n`
    + `config.input to that content ({{<extractId>.<field>}} when an extract step precedes it, holding the raw\n`
    + `body; or {{prev}} when the classify IS the first step after the trigger). It does NOT need to be the\n`
    + `first node and is NOT limited to the previous step's output. Have it sort that content into a\n`
    + `CLOSED, EXHAUSTIVE list of categories: ${whenVals.join(', ')} — PLUS one extra category "none" for input\n`
    + `that matches NONE of those lanes. A classify needs AT LEAST TWO categories (the active ones AND "none");\n`
    + `${whenVals.length === 1 ? `here that means EXACTLY: ${whenVals[0]}, none.\n` : ''}`
    + `Then a branch routes each active category to its destination, and routes "none" AND the mandatory "*"\n`
    + `catch-all to a "stop" node (type:"stop", no config) — so input matching no lane ENDS THE RUN WITH NO\n`
    + `ACTION. NEVER route a "do nothing / ignore" case to a deliver or any node with a side effect: that would\n`
    + `send a notification the user explicitly did NOT ask for. The classify must judge the REAL content — the\n`
    + `raw trigger body (via an extract's field, or {{prev}} when it runs first), NEVER a SUMMARY another llm\n`
    + `step produced (judging a paraphrase silently misroutes), and it is the ONLY node that\n`
    + `makes this routing judgement — do not also have an upstream step decide the same thing. Every active\n`
    + `case's \`when\` MUST equal one of the categories.`
    : '';
  return `
THE OUTCOME THIS WORKFLOW MUST DELIVER (the contract — every line needs a step that does it,
and a workflow that quietly does less than this WILL NOT PUBLISH):
${outcome.statement ? `  "${outcome.statement}"\n` : ''}${lines.join('\n')}${conditionalNote}
`;
}

// ── Generate prompt — emit the WHOLE spec at once (rearchitecture, Increment 2) ─

/**
 * THE PRE-BUILD PLAN (agent-contracts increment 1). Project the gathered contract +
 * trigger into a human-legible plan, in plain language, BEFORE the expensive
 * whole-spec build — so the user catches a misread in one glance instead of after a
 * 3-5 min Opus pass, and the approved plan gives `generate` an explicit skeleton to
 * fill (fewer regenerations, same-intent → same-structure).
 *
 * The plan carries NO per-line provenance mark (removed 2026-07-27, operator's call —
 * see CLAUDE.md). Every line is plain prose the reader judges for themselves; nothing
 * on the card makes a claim about who said what.
 *
 * `upload_suggestion` turns an ungrounded JUDGMENT into an invitation: when a step
 * makes a policy/criteria/tone decision with NO knowledge to ground it, name ONE
 * specific artifact the user could upload and the concrete benefit. Null otherwise —
 * never nag. `knowledge` surfaces what was actually used from the knowledge base, with
 * its source, so the grounding that already happens silently becomes visible.
 *
 * @param {{ intent, outcome, triggers, clarifications }} args
 * @returns {string} the user-message prompt
 */
/**
 * The GROUNDING block — facts verified live against the connected tools, so the plan's
 * wording reflects reality instead of the model's guess. This is the grounding pass
 * (agent-contracts increment 2) surfacing what elicitation learned from the tools.
 *
 * THE RULE THAT MUST NOT LEAVE THIS BLOCK: **the plan must not settle a question
 * another stage asks properly.** A destination the user NAMED but does not have is the
 * create-or-pick conversation's decision, not the plan's to pre-announce. This block
 * used to say *say Atlas will CREATE the channel*, and a tester was shown "Atlas will
 * create the #ops channel" — after which the build SKIPPED the work, because the plan
 * read as settled. Atlas already has that conversation: `RESOURCE_NOT_FOUND` in
 * `gap-scorer.js`, resolved in the `gaps` node of `elicitation-graph.js`, which offers
 * "Create #<name>" or an existing channel to point at, and gets a REAL answer from the
 * user. So the plan states the situation truthfully and leaves the decision where it is
 * actually asked. Pinned by `tests/converger/plan-grounding-prompt.test.js` and
 * `tests/converger/plan-gate.test.js`.
 *
 * (The per-line confidence tags this block used to set were removed 2026-07-27 with the
 * rest of the plan card's marks — operator's call. The grounding FACTS stay: they change
 * what the plan says, not how it is labelled.)
 */
function groundingBlock(grounding) {
  const lines = [];
  const s = grounding?.slack;
  if (s?.checked) {
    if (s.known?.length)
      lines.push(`- These Slack channels EXIST in the connected workspace: ${s.known.join(', ')}. A delivery to one of these is GROUNDED — say it posts to the EXISTING channel.`);
    if (s.absent?.length)
      lines.push(`- These Slack channels were named but do NOT exist in the workspace yet: ${s.absent.join(', ')}. The user named the channel; they did NOT say what should happen about it not existing. Say in the text only that the channel does not exist yet and that you will confirm what to do about it before the workflow runs. Do NOT state that Atlas will create it, or that it is already handled — that decision has not been made yet and is asked separately, after the build.`);
  }
  const at = grounding?.airtable;
  if (at?.table) {
    const cols = at.columns?.length ? ` with columns: ${at.columns.join(', ')}` : '';
    lines.push(`- Airtable: the base "${at.base}" has a table "${at.table}"${cols} — verified in the connected workspace. A write to it is GROUNDED — name the REAL table${at.columns?.length ? ' and its columns' : ''} in the step text.`);
  }
  if (!lines.length) return '';
  return `\nGROUNDING — verified live against the connected tools. Reflect this in the wording; do NOT contradict it:\n${lines.join('\n')}\n`;
}

export function buildPlanPrompt({ intent, outcome, triggers, clarifications, grounding } = {}) {
  const prior = (clarifications ?? []).map(({ q, a }) => `  Q: ${q}\n  A: ${a}`).join('\n');
  const assertions = (outcome?.assertions ?? []).map(a => {
    const fields = a.fields ? ` [fields: ${(Array.isArray(a.fields) ? a.fields : [a.fields]).join(', ')}]` : '';
    return `  - ${a.kind} → ${a.target}${a.when ? ` (when ${a.when})` : ''}${fields}`;
  }).join('\n');
  const trig = (Array.isArray(triggers) ? triggers : []).map(t =>
    `  - ${t.type}${t.filter ? ` (filter: ${t.filter})` : ''}${t.cron ? ` (cron: ${t.cron})` : ''}`
  ).join('\n');

  return `Before building the workflow, write the PLAN the user will approve — HOW this workflow will
work, in plain language, tagged by how sure you are of each part. It is shown BEFORE the build so the
user can catch a misunderstanding in one glance.

INTENT: "${intent}"
OUTCOME: ${outcome?.statement ?? '(none)'}
CONTRACT (what the finished workflow must deliver):
${assertions || '  (none)'}
TRIGGER (already derived):
${trig || '  (none derived yet)'}
${groundingBlock(grounding)}${prior ? `\nWHAT THE USER HAS CLARIFIED / CHANGED (reflect this — it overrides your first read):\n${prior}\n` : ''}
When a step uses something from the KNOWLEDGE BASE CONTENT in your system prompt, ALSO add that fact
to "knowledge" below with its source label.

Keep each item to ONE short plain-language line — no jargon, no node types, no config. Describe what
happens the way you'd tell a coworker.

UPLOAD SUGGESTION — when a step makes a JUDGMENT (a classification rule, an escalation/priority policy,
a tone or wording choice) and you had NO knowledge base content to ground it, you MAY suggest ONE
specific document the user could upload to make it precise: name the artifact and the concrete benefit.
Only for genuine judgment calls, at most one, and null when nothing qualifies — never nag.

Return JSON only:
{
  "summary": "<one plain sentence: the whole workflow>",
  "trigger": { "text": "<when it starts>" },
  "steps":   [ { "text": "<what happens, in order>" } ],
  "branches":[ { "when": "<condition, plain words>", "then": "<what happens>" } ],
  "error_handling": { "text": "<what happens if a step fails>" },
  "knowledge": [ { "text": "<the relevant fact you used>", "source": "<the document label>" } ],
  "upload_suggestion": { "artifact": "<what to upload>", "reason": "<the concrete benefit>" }
}
"branches" is [] for a linear workflow. "knowledge" is [] when nothing in the knowledge base applied.
"upload_suggestion" is null unless a real judgment gap qualifies.

IF THERE ARE BRANCHES, THE LAST ONE MUST COVER EVERYTHING ELSE. Every workflow that
routes is built with a catch-all, so a plan listing only the named cases is missing a
real outcome — and it is the outcome the reader is least likely to have thought about.
List it explicitly and last, phrased as the condition it actually is:
  { "when": "anything else", "then": "<what happens to inputs that match none of the above>" }
If the answer is "nothing happens", say that in words ("no action is taken") rather
than omitting the route. A plan that names two outcomes for a workflow that has three
undercounts the paths and contradicts the diagram the user is about to approve.`;
}

/**
 * The APPROVED PLAN, rendered into the generate prompt as the skeleton to fill. The
 * user has already signed off on this shape, so `generate` builds it rather than
 * re-deriving structure from a one-line outcome — which is what drove the
 * regeneration variance (a branch build rediscovering extract-first three times).
 */
function approvedPlanBlock(plan) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return '';
  const steps    = plan.steps.map((s, i) => `  ${i + 1}. ${s.text}`).join('\n');
  const branches = (plan.branches ?? []).map(b => `  - when ${b.when} → ${b.then}`).join('\n');
  const fail     = plan.error_handling?.text ? `\n  On failure: ${plan.error_handling.text}` : '';
  return `\nAPPROVED PLAN — the user approved this WORK: the trigger, the SET of steps to perform, and the
routing between outcomes. Honor the work — cover every step it lists and no extra ones, and keep the
routes it describes; but you are FREE to choose the cleanest node structure, ORDER, and {{...}} data
wiring that accomplishes it. The plan is a list of WHAT to do, not a node sequence to hard-code: if
reading the data cleanly means an extract runs first and a later step references its fields, build it
that way even if the plan lists those steps in a different order. Do not add steps it does not call for,
and do not drop any it lists:
  Trigger: ${plan.trigger?.text ?? ''}
  Steps:\n${steps}${branches ? `\n  Routes:\n${branches}` : ''}${fail}
This plan is PLAIN LANGUAGE, not node config — it fixes the STRUCTURE, not the node types. Build each
step with the node type + config your STRUCTURE RULES demand, NOT by matching the plan's wording: a
"summarize"/"write a summary" step is an "llm" node with mode:"summarize" that reads the upstream
extract via {{<extractId>.output}} — never a freeform node, and never one that reads the classifier's
category instead of the email. The plan says WHAT each step does; your grammar says HOW to build it.\n`;
}

/**
 * WHAT THE SYSTEM ALREADY FIXED IN THE LAST DRAFT — rendered into the next build.
 *
 * THE LOOP THIS CLOSES. `generate` rebuilds the WHOLE spec on every "the spec must
 * change" route, and the previous draft reaches it as ids, types and labels ONLY
 * (`existing`, below) — no config, no edges. So a blank the deterministic repairs had
 * already filled in (`autoRepairStructural`: a missing `sections` list, an unwired
 * route edge, a missing name) was INVISIBLE to the pass that came next, which
 * re-emitted the identical blank, which fired the identical repair. The build could
 * not retain a fix it had already made — a loop that cannot make progress by
 * construction.
 *
 * On the record (memory/logs/atlas-events.log): build `build-agntic-1785087187289`,
 * 2026-07-26, logged `converger.pre_regen_repair [DIGEST_MISSING_SECTIONS]` after
 * EVERY one of three consecutive whole-spec passes — 155s + 130s + 203s, eight
 * minutes of a person waiting — and two other builds that afternoon repeated it twice
 * each.
 *
 * WHY THIS AND NOT THE WHOLE PREVIOUS DRAFT. Serialising every node's full config
 * would also close it, and it is the worse trade on three counts:
 *   · COST — the observed builds are 13–26 nodes; their configs run to thousands of
 *     tokens, on the most expensive tier, inside the SAME `max_tokens` budget the
 *     answer has to fit in (see GENERATE_MAX_TOKENS: running out of that room mid-JSON
 *     is a live, documented failure that discards the entire pass).
 *   · ANCHORING — handing the model back the draft it just produced invites it to
 *     return the same thing. `generate` already has a guard for exactly that outcome
 *     (`converger.regen_noop`); making the no-op MORE likely on the expensive path is
 *     the wrong direction.
 *   · PRECISION — a rebuild is worth running only when it is told something actionable.
 *     "this step needs a sections list, and here is the list we computed" is a
 *     correction a model can act on in one pass; a full spec dump is not a correction
 *     at all.
 * So we carry the REPAIRS: what was wrong, in the validator's own words, and the exact
 * value now sitting in the draft — which is bounded by the number of things that were
 * actually broken, not by the size of the workflow.
 */
function repairsBlock(repairs, draft) {
  const list = (repairs ?? []).filter(Boolean);
  if (!list.length) return '';
  const byId = new Map(((draft?.nodes) ?? []).map(n => [n.id, n]));
  const lines = [];
  for (const r of list) {
    const why = r.message ? ` — it was rejected for: ${r.message}` : '';
    if (r.op === 'set_config' && r.nodeId) {
      const node = byId.get(r.nodeId);
      const cfg  = node ? JSON.stringify(node.config ?? {}, null, 2) : null;
      lines.push(`- "${r.nodeId}"${why}\n  Its config is now, and must come back as:\n${(cfg ?? '{}').split('\n').map(l => `  ${l}`).join('\n')}`);
    } else if (r.op === 'add_edge') {
      lines.push(`- the edge ${r.from} → ${r.to} was missing and has been added${why}. Emit it.`);
    } else if (r.op === 'remove_edge') {
      lines.push(`- the edge ${r.from} → ${r.to} was wrong and has been removed${why}. Do not emit it.`);
    } else if (r.op === 'set_name') {
      lines.push(`- the workflow had no name; it is now "${r.name}"${why}. Emit that name.`);
    } else if (r.op === 'set_assertion_when') {
      lines.push(`- a promise's condition was restated as "${r.when}"${why}. Build the route that satisfies it.`);
    } else {
      lines.push(`- ${r.code ?? 'a defect'} was repaired${why}.`);
    }
  }
  return `
ALREADY FIXED FOR YOU — DO NOT UNDO THIS. The last build left these blank or wrong and
the system filled them in itself. The values below are CORRECT and are already in the
workflow. Carry every one of them into this rebuild verbatim. Emitting them empty again
is what makes this build loop: the repair fires, you cannot see it, and you write the
same blank back.
${lines.join('\n')}
`;
}

/**
 * Ask the model for the COMPLETE spec in ONE structured JSON object —
 * `{ triggers, nodes, edges }` — instead of one component per round.
 *
 * This is the same vocabulary as `buildProposePrompt` (llm modes, decision
 * tables, the moat's closed-enum routing rule, the deliver channels — all taught
 * by `buildSystemPrompt`, which is the SYSTEM message alongside this one); it is
 * simply emitted all at once. The one-component loop reliably emitted visible
 * NODES but dropped invisible EDGES, so branches never branched and classifiers
 * dangled (docs/handoff/converger-rearchitecture.md). Emitting the whole graph —
 * with every edge and branch case — then wiring deterministically (`wireEdges`)
 * is what guarantees a connected, branched result.
 *
 * @param {{ intent, clarifications, outcome, draft, capabilities, setupResults }} args
 * @returns {string} the user-message prompt
 */
export function buildGeneratePrompt({ intent, clarifications, outcome, draft, capabilities, setupResults, plan, repairs } = {}) {
  const prior = (clarifications ?? []).map(({ q, a }) => `  Q: ${q}\n  A: ${a}`).join('\n');
  const contract = outcome ?? draft?.outcome ?? null;
  const existing = JSON.stringify({
    triggers: draft?.triggers ?? [],
    nodes:    (draft?.nodes ?? []).map(n => ({ id: n.id, type: n.type, label: n.label })),
  }, null, 2);

  return `Build the COMPLETE workflow in ONE structured JSON object. You are NOT proposing a single
component — you are emitting the entire spec at once: the trigger, every node with its full config,
and EVERY edge that connects them.

INTENT: "${intent}"
${prior ? `\nCLARIFICATIONS:\n${prior}\n` : ''}${setupResultsSummary(setupResults)}${approvedPlanBlock(plan)}${outcomeBlock(contract)}
ALREADY DERIVED (reuse these exact ids and triggers where present — do not contradict them):
${existing}
${repairsBlock(repairs, draft)}

A derived "deliver" step is a PLACEHOLDER for a promise, not a fixed part of the design: keep its id
when a delivery is genuinely what that promise needs, but you may REPLACE it with a different step that
keeps the SAME promise. The case that matters: when the promise is the approval QUESTION itself
("DM me asking to approve"), the "human" step's own ask keeps it — its channels are where the question
goes. Do NOT also add a deliver step for that promise, or the person is messaged twice: once by a
pointless delivery and again by the real question. Delete the placeholder and let the human step carry it.

Use the node-type vocabulary, the llm modes, the decision-table rules, the closed-enum routing rule
and the delivery channels EXACTLY as defined in your system prompt. This is the SAME grammar — emitted
all at once instead of one component per turn.

RETURN THIS SHAPE (JSON only):
{
  "name":     "<short descriptive workflow title, e.g. 'Inbound lead triage'>",
  "triggers": [ { …one trigger spec… } ],
  "nodes":    [ { "id": "<snake_case>", "type": "<nodeType>", "label": "<short human label>", "description": "<one plain sentence: what THIS configured step does>", "config": { … } }, … ],
  "edges":    [ { "from": "<nodeId>", "to": "<nodeId>" }, … ]
}

ALWAYS include "name": a short, human title for the whole workflow (a few words). It is required —
a nameless workflow cannot be saved.

ALWAYS include a per-node "description": ONE plain-language sentence describing what THAT specific,
configured step does — the user reads it to approve the step. Make it INSTANCE-specific, not a
definition of the node type: "Summarizes the urgent support email for the #support channel", NOT
"Condenses content into a summary". Name the real destination/fields where the step has them. No
jargon, no node types, no config syntax.

STRUCTURE RULES — these are what make the graph actually RUN. The single most common failure is a node
with no inbound edge, or a branch with no feed:
- MINIMAL NODE SET — use the FEWEST steps that satisfy the outcome. Most "do X to the incoming thing and
  send it to Y" intents are ONE processing node feeding ONE delivery: "summarize the email and save it to
  the inbox" is a single llm(mode:"summarize") → deliver — NOT extract → assemble → deliver. An llm node
  already outputs finished, channel-ready text, so do NOT add a separate "extract" then an "assemble"/
  format node to reshape text the delivering step could produce itself. Split into extract + assemble ONLY
  when the outcome needs DISTINCT fields written to DISTINCT places (e.g. named columns in a record). Extra
  reshaping nodes make the workflow slower and more fragile, drop content, and a spec that over-builds will
  fail its own self-test.
- EVERY node except the ENTRY node has at least one INBOUND edge. The entry node — the first step, fed
  by the trigger — has NONE. The trigger is NOT a node: never write an edge whose "from" is "trigger".
- A ROUTER is exactly this shape: an "llm" node with mode:"classify" and a CLOSED list of categories
  → a "branch" whose config.on is "<classifyId>.output" and whose config.cases has one { when, to } per
  category PLUS the mandatory { when:"*", to:… } catch-all → each case's "to" is a lane, and EACH lane
  ends in a delivery. Emit the branch's INPUT edge (classify→branch) AND one OUTPUT edge per case
  (branch→caseTarget).
- THE MOAT: a branch may route ONLY on a value with a closed, declared domain — an "llm" mode:"classify"
  (its categories), a "decision" (its output.values), or a "human" (its decisions). NEVER route a branch
  on freeform AI prose; cases match by exact value, so prose matches nothing and every run silently falls
  through the catch-all.
- EXACTLY ONE delivery node per distinct destination. If two lanes both end at #ops, that is still ONE
  deliver node targeting #ops (reachable from both lanes) — never two deliver nodes writing the same
  place with different ids.
- USE ONLY the connector actions, triggers, delivery channels and ids listed in your system prompt and in
  ALREADY DERIVED above. NEVER invent a connector id, a base id, a table id or a channel — leave a base or
  table you cannot know as the placeholder the system prompt describes; the builder resolves it.

WORKED EXAMPLE — a lead router (study the shape, then build for the REAL intent):
{
  "triggers": [ { "type": "email", "filter": "to:leads@acme.com" } ],
  "nodes": [
    { "id": "classify_lead", "type": "llm", "label": "Classify the email",
      "config": { "mode": "classify", "categories": "hot\\nwarm\\nnot_a_lead", "instructions": "Sort the inbound email." } },
    { "id": "route", "type": "branch", "label": "Route by lead type",
      "config": { "on": "classify_lead.output", "cases": [
        { "when": "hot",        "to": "summarize_hot" },
        { "when": "warm",       "to": "summarize_hot" },
        { "when": "not_a_lead", "to": "log_other" },
        { "when": "*",          "to": "log_other" } ] } },
    { "id": "summarize_hot", "type": "llm", "label": "Summarize for sales",
      "config": { "mode": "summarize", "instructions": "One-paragraph summary. Format output as Slack mrkdwn." } },
    { "id": "log_other", "type": "llm", "label": "One-line note",
      "config": { "mode": "summarize", "length": "short", "instructions": "One line. Slack mrkdwn." } },
    { "id": "notify_sales", "type": "deliver", "label": "Post to #sales",
      "config": { "channel": "slack", "target": "#sales" } },
    { "id": "notify_ops",   "type": "deliver", "label": "Post to #ops",
      "config": { "channel": "slack", "target": "#ops" } }
  ],
  "edges": [
    { "from": "classify_lead", "to": "route" },
    { "from": "route",         "to": "summarize_hot" },
    { "from": "route",         "to": "log_other" },
    { "from": "summarize_hot", "to": "notify_sales" },
    { "from": "log_other",     "to": "notify_ops" }
  ]
}
Note: the entry node "classify_lead" has NO inbound edge (the email trigger feeds it); the branch has
its INPUT edge and BOTH output edges; each lane ends in its own delivery; and no destination has two
deliver nodes.

Return ONLY the JSON object — no prose, no markdown fences, no explanation.`;
}

// ── Outcome prompt — "how would we know this worked?" ────────────────────────

export function buildOutcomePrompt({ intent, capabilities }) {
  return `Turn this intent into an OUTCOME CONTRACT: a plain-English statement of what must be
true after the workflow runs, plus the machine-checkable assertions that prove it.

INTENT: "${intent}"

Offer 2-3 candidate contracts — different readings of what the user probably meant. The user
picks one (or edits it). Order them best-guess first; the first one is pre-selected, so it must
be the most likely reading, not the most cautious one.

AN ASSERTION IS: { "id": "a1", "kind": "<kind>", "target": "<connector>:<destination>" }
  kind is EXACTLY ONE OF — nothing else exists, and an unknown kind is REJECTED at publish:
    message_sent     a message reached a person, a channel, or an endpoint
    record_exists    a row or record was created in a data store
    document_exists  a document or file was created
  target is "<connector>:<destination>", e.g.
    "slack:#logistics"   "slack:someone@acme.com"   "gmail:ops@acme.com"
    "airtable:Leads"     "sheets:Q3 Pipeline"       "inbox:Daily digest"
  Optional: "fields": ["Name","Budget"] — a record_exists that must carry named fields.
  Optional: "when": "<category>" — see CONDITIONAL DELIVERIES below. OMIT it for anything
    that happens on EVERY run.

RULES — these are what make the contract checkable, which is the whole point:
- EVERY destination the user asked for gets its OWN assertion. If they said "post to Slack AND
  email me", that is TWO assertions. A workflow that quietly does only one of them will not
  publish (UNSATISFIED_ASSERTION) — that is the single most common way this system used to fail
  its users, and the contract is what stops it.
- CONDITIONAL DELIVERIES — if a destination is reached only in SOME cases ("if it's urgent send
  it to #support, if it's a billing question send it to #sales, otherwise save it to my inbox"),
  each such assertion carries a "when" naming the CASE under which that delivery happens:
    {"id":"a1","kind":"message_sent","target":"slack:#support","when":"urgent"}
    {"id":"a2","kind":"message_sent","target":"slack:#sales","when":"billing_question"}
    {"id":"a3","kind":"message_sent","target":"inbox:Triage","when":"general"}
  A conditional delivery does NOT happen on every run, so asserting it unconditionally would make
  the workflow fail its own contract on every input that took a different path. The "when" values
  are a CLOSED set of routing categories — the SAME closed set the workflow will classify the
  input into and branch on (that shared vocabulary is what lets the self-test prove each promise
  only on the run that actually took that lane). Pick short, distinct category tokens
  (urgent / billing_question / general), and use the SAME token in every assertion for that case.
  A delivery that ALWAYS happens (a log, a digest that goes out every run) has NO "when".
- ONLY assert things that are the workflow's OUTPUT. "The email is summarized" is not an
  assertion — no connector can be checked for it. The Slack message that carries the summary IS.
- Use ONLY connectors that appear in the AVAILABLE lists in your system prompt. If the intent
  needs one that isn't connected, say so in the statement rather than asserting something that
  cannot happen.
- Keep the statement to ONE sentence a non-technical person would recognise as their own request.

Return JSON only:
{"candidates":[
  {"id":"c1","statement":"<one sentence>","assertions":[{"id":"a1","kind":"…","target":"…"}]},
  {"id":"c2","statement":"…","assertions":[…]}
]}`;
}

// ── Sufficiency — "is this actually finished?" ───────────────────────────────

/**
 * The outcome contract is a FLOOR, not a ceiling.
 *
 * It guarantees that nothing the user asked for was silently DROPPED — that is
 * what kills defect #1. It cannot guarantee that every transformation they asked
 * for is PRESENT, because "a summary of the email" and "the email" arrive at
 * Slack as the same assertion: `message_sent → slack:#logistics`. No
 * machine-checkable assertion distinguishes them, and inventing one that claimed
 * to would be a proof we cannot make.
 *
 * So the intent still drives construction, and the model still judges when the
 * build is done — but only ONCE THE FLOOR IS MET, and it must name a concrete
 * missing component to continue. That is the difference from v1's checklist,
 * which DEMANDED a processing node and so invented one for workflows that
 * genuinely had none (defect #4): here, "yes, it's finished" is always available
 * and is the default reading for a simple workflow.
 */
/**
 * ONE EDGE, NOT A WHOLE REBUILD. The build seeds a delivery node per promised
 * delivery but not its edges; the model wires them at `generate`, and when it forgets
 * one the delivery has nothing feeding it (DELIVER_NO_INPUT). Rather than throw away
 * every node for a fresh Opus pass, ask the model — in a small, cheap call — for JUST
 * the edges that wire the orphaned deliveries. The model still chooses WHICH step
 * feeds each delivery (the same judgement it makes in a full build, so no less safe);
 * we only spare it from re-emitting the whole spec to express it.
 */
export function buildWireDeliveryPrompt({ draft, unwired }) {
  const nodes = (draft?.nodes ?? []).map(n => ({ id: n.id, type: n.type, mode: n.config?.mode, label: n.label }));
  const edges = draft?.edges ?? [];
  return `A workflow was just built, but ${unwired.length === 1 ? 'one delivery step has' : 'some delivery steps have'} nothing wired into ${unwired.length === 1 ? 'it' : 'them'} — so ${unwired.length === 1 ? 'it' : 'they'} would deliver nothing. Wire ${unwired.length === 1 ? 'it' : 'each'} up.

${outcomeBlock(draft?.outcome)}
STEPS (id · type · what it does):
${nodes.map(n => `  - ${n.id} · ${n.type}${n.mode ? `/${n.mode}` : ''} · ${n.label ?? ''}`).join('\n')}

EDGES that already exist:
${edges.length ? edges.map(e => `  ${e.from} → ${e.to}`).join('\n') : '  (none)'}

These delivery steps have NO incoming edge and need one:
${unwired.map(id => `  - ${id}`).join('\n')}

For EACH orphaned delivery, return the edge that wires it from the step whose output it should send —
the step that PRODUCES the content this delivery is meant to deliver (usually the summarize/extract/
assemble/compose step for its branch). Wire it from an EXISTING step in the list above; do NOT invent
new steps or new ids. If the step that should feed a delivery genuinely does not exist yet, OMIT that
delivery from your answer (leave its edge out) rather than wiring it from the wrong step — a delivery
wired to the wrong source sends the customer the wrong thing.

Return JSON only — only the NEW edges to add, nothing else:
  {"edges":[{"from":"<producing step id>","to":"<orphaned delivery id>"}]}`;
}

export function buildSufficiencyPrompt({ intent, draft }) {
  return `Is this workflow FINISHED — does it do everything the intent asks?

INTENT: "${intent}"
${outcomeBlock(draft?.outcome)}
CURRENT DRAFT:
${JSON.stringify({
    triggers: draft?.triggers,
    nodes: (draft?.nodes ?? []).map(n => ({ id: n.id, type: n.type, mode: n.config?.mode, label: n.label })),
    edges: draft?.edges,
    name: draft?.name,
  }, null, 2)}

It is already VALID and it already delivers everything the outcome promises. The only question
is whether the intent asks for work this draft does not do.

Each node's internal CONFIG is deliberately omitted above (you see only id/type/mode/label) and it
has ALREADY been validated as present and correct — a classify node's categories, a branch node's
\`on\`/cases/edges, a deliver node's channel, every prompt and field list. Do NOT report any of that
as missing: not categories, not cases, not edges, not \`on\`, not mode, not instructions, not config
of any kind. It is not your concern and it IS there. Judge ONLY whether the intent asks for an entire
STEP (a whole node) that no node above performs.

DATA FLOW IS NOT YOUR CONCERN EITHER, and it is the most common way this check goes wrong. Do NOT
report that one step "cannot access" or "has no way to receive" another step's value, that "no edge
carries" something, or that a step "only receives the previous step's output". ANY step can reference
ANY earlier step's output directly as {{step_id.field}} — that is how the engine works, it does not
require an edge, and the referencing config is hidden from you above. A delivery also RETURNS values
(a created Doc returns its link), and a step after it can read them the same way. If every step the
intent asks for EXISTS, the answer is COMPLETE — even when you cannot see how a value reaches one of
them, because you cannot see that either way.

Saying "incomplete" here forces a full, expensive rebuild of the entire workflow. If the rebuild
would produce the same set of steps you already see, the answer was COMPLETE.

BE CONSERVATIVE. A workflow with no AI step is a perfectly good workflow — moving an email into a
spreadsheet needs no model call, and adding one costs the user money on every single run, forever.
Only say it is incomplete if the intent explicitly asks for a WHOLE STEP no node does: a summary
nobody writes, a translation nobody makes, a field nobody extracts, a destination nobody sends to.
"It could be nicer" is not incomplete, and a config detail is never missing. If in doubt, it is COMPLETE.

Return JSON only:
  {"complete":true}
  {"complete":false,"missing":"<the ONE component that is missing, named concretely>"}`;
}

// ── Examples prompt ──────────────────────────────────────────────────────────

export function buildExamplesPrompt({ intent, outcome, triggers }) {
  return `The user is building this workflow:

INTENT: "${intent}"
OUTCOME: ${outcome?.statement ?? '(not yet stated)'}

Propose up to 3 CONCRETE example cases they could confirm — realistic inputs this workflow would
see, each with what the workflow should produce. These become the workflow's test cases, so they
must be specific (a real-looking subject line, a real-looking amount), never generic placeholders.

${triggerGivenGuidance(triggers)}

Include at least one case that should NOT trigger the workflow, if that is meaningful here — the
negative example is the one that finds the bug.

Return JSON only:
{"examples":[{"id":"e1","label":"<short label>","given":{…},"expect":{…},"shouldTrigger":true}]}`;
}

/**
 * One example per PATH the workflow can take.
 *
 * The ordinary example generator runs before the workflow exists, so it cannot know
 * the workflow branches — it proposes up to three cases blind. A router is only
 * proved on the routes actually tested, so a three-way workflow with one sample can
 * never pass its own test: the panel correctly refuses to certify and Go live stays
 * locked. Observed live — a user who answered nothing, accepted every default and got
 * a correct workflow was then told to write test cases by hand, which is precisely the
 * typing the zero-typing path exists to remove.
 *
 * By the time the spec is assembled the paths ARE known, so this asks for an input
 * designed to take each one, naming the path in the workflow's own routing words.
 * It cannot GUARANTEE coverage — only running proves which lane an input takes — so
 * the honest claim is that it gives every path a fair chance, and the oracle still
 * has the last word.
 */
export function buildLaneExamplesPrompt({ intent, outcome, triggers, lanes, existing = [] }) {
  const had = existing.filter(e => e?.label).map(e => `- ${e.label}`).join('\n');
  return `The user is building this workflow:

INTENT: "${intent}"
OUTCOME: ${outcome?.statement ?? '(not yet stated)'}

The finished workflow can take these different paths, and a test only proves the paths
it actually goes down. Propose ONE realistic input for EACH path below — chosen so the
workflow would genuinely take that path:

${lanes.map((l, i) => `${i + 1}. ${l.label}`).join('\n')}
${had ? `\nCases they already have (do not repeat these):\n${had}\n` : ''}
${triggerGivenGuidance(triggers)}

Each input must be specific and realistic — a real-looking subject line, a real-looking
amount — never a generic placeholder, and never a label describing the path.

Return JSON only, one entry per path, in the same order:
{"examples":[{"id":"lane1","label":"<short label naming the path in plain words>","given":{…},"expect":{…},"shouldTrigger":true}]}`;
}

/**
 * `given` is the EVENT the workflow's first step actually receives — and the first
 * step is fed by `given` verbatim. If its shape does not match the trigger's event,
 * the first step gets nonsense: an email→summarize node handed a `{scenario:"…"}`
 * blob reads its OWN guard clause ("if the email is empty or missing → ERROR") and
 * fails a run that would have worked. So the example's `given` MUST be a realistic
 * instance of the trigger's own event shape, with the real content IN `given` (not
 * in `expect` — `expect` is what the workflow PRODUCES from `given`). (P12 G residual.)
 */
function triggerGivenGuidance(triggers) {
  const t = (Array.isArray(triggers) ? triggers : []).find(x => x?.type) ?? triggers?.[0] ?? null;
  const type = t?.type ?? null;
  if (type === 'email') {
    return `This workflow is TRIGGERED BY an incoming email. Each \`given\` MUST be a realistic instance of
that email with these exact keys — and real content, because the first step reads this verbatim:
  {"from": "<sender name and email>", "subject": "<a real-looking subject line>", "body": "<the full email body, 2-4 sentences of realistic content>"}
Put the email IN \`given\`. \`expect\` is what the workflow should PRODUCE from it (e.g. the summary), NOT the email.`;
  }
  if (type === 'schedule') {
    return `This workflow is TRIGGERED ON A SCHEDULE — there is no inbound event, so \`given\` may be an empty
object {} or a minimal context. The first step gathers its own data (a search, a fetch); \`expect\` is what it produces.`;
  }
  return `\`given\` is the exact event the workflow's FIRST step receives and reads verbatim — shape it as a
realistic instance of that event (the real fields, real content), and put the content in \`given\`, not in \`expect\`.`;
}

// ── Decision prompt — induce a table / a routing shape from the examples ─────

export function buildDecisionPrompt({ intent, outcome, examples }) {
  return `Does this workflow need to make a JUDGEMENT — treating some inputs differently from others?

INTENT: "${intent}"
OUTCOME: ${outcome?.statement ?? ''}
EXAMPLES: ${JSON.stringify(examples ?? [], null, 2)}

If every input is treated identically, answer {"needsDecision":false} and stop.

If some inputs are treated differently, there are exactly TWO sanctioned shapes, and the
number of things the judgement depends on picks which:

  ONE judgement, one input  →  an "llm" node with mode:"classify" and a CLOSED list of
                               categories, then a "branch" that routes on it.
  SEVERAL inputs, or a NUMBER ("over $50k", "more than 3 days late")
                            →  a "decision" node: a table whose inputs are declared, whose
                               output is a closed list of answers, and whose rules can be
                               PROVEN to cover every case. Then a "branch" routes on its
                               output.

What is NOT allowed, in either shape: an AI step that emits free text feeding a branch. The
branch matches by exact value, so prose matches nothing and every run falls through the
catch-all — silently. The validator rejects it (LLM_INPUT_NOT_ENUM). A closed set of answers
is what makes the routing checkable, and an AI-judged decision input must be an enum for the
same reason. This is not a style preference; it is the difference between a workflow whose
behaviour can be proven complete and one that cannot.

Return JSON only, using ONE of these two shapes:
{"needsDecision":true,"shape":"classify",
 "classify":{"id":"<id>","categories":["…","…"],"instructions":"<how to decide>"},
 "cases":[{"when":"<category>","to":"<what should happen>"}, {"when":"*","to":"<everything else>"}]}
{"needsDecision":true,"shape":"table",
 "decision":{"id":"<id>","inputs":[{"key":"<k>","type":"number|enum|integer|boolean","values":["…"],"evaluator":"llm|null"}],
             "output":{"key":"<k>","type":"enum","values":["…","…"]},"hitPolicy":"FIRST",
             "rules":[{"when":{"<k>":"<condition>"},"then":"<one of output.values>"}]},
 "cases":[{"when":"<output value>","to":"<what should happen>"}, {"when":"*","to":"<everything else>"}]}`;
}

// ── Gap prompt — suggest an answer for each open gap ─────────────────────────

export function buildGapPrompt({ intent, gaps }) {
  // THE GAP IDS MUST BE IN THE PROMPT. They were not: the gaps were listed as
  // "1., 2., 3." and the model was then asked to answer keyed by `gapId` — a string
  // like `gap_unsatisfied_assertion_save_3` that it had never been shown. So it could
  // not produce one, `suggestionFor()` returned null for EVERY gap, the paid call was
  // discarded, and every row reached the user with an empty box. Worse, a BLOCKING gap
  // is only routed back through the propose loop when it has an answer — so it never
  // was, and "Accept all defaults" could not resolve a blocker at all. The one surface
  // that makes v2's extra rigour affordable was inert. (Found by the test-adversary.)
  return `This workflow has cases nobody has decided about yet.

INTENT: "${intent}"

OPEN GAPS (answer each by its exact id):
${gaps.map(g => `  - id: ${g.id}\n    [${g.class}] ${g.message}${g.hint ? `\n    hint: ${g.hint}` : ''}`).join('\n')}

For each, suggest the single most likely answer, in plain language a non-technical person would
click without hesitation. Be concrete and short (a few words). If the honest answer is "a person
should look at this", say so — that is a good answer, not a failure.

Use the EXACT id shown above for each gap — it is how your answer is matched back.

Return JSON only:
{"suggestions":[{"gapId":"<the exact id from the list above>","answer":"<short plain-language answer>"}]}`;
}

// ── Modify prompt — merge user override into a proposal ──────────────────────

export function buildModifyPrompt({ original, modification }) {
  return `The user wants to modify this workflow component proposal.

ORIGINAL PROPOSAL:
${JSON.stringify(original, null, 2)}

USER'S MODIFICATION REQUEST: "${modification}"

Apply the user's requested change and return an updated proposal in the same JSON format. Return JSON only.`;
}
