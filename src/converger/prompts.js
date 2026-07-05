/**
 * prompts — LLM prompt builders for the converger.
 *
 * All prompts ask for JSON only. The converger never asks the LLM to produce
 * prose — it either produces a structured proposal or a structured question.
 */

import { gapLabel } from './gap-scorer.js';

// ── Capability summary for system prompt ─────────────────────────────────────

function capabilitySummary(capabilities) {
  const connectors = capabilities?.connectors ?? {};
  if (!Object.keys(connectors).length) return '(none connected)';
  return Object.entries(connectors).map(([id, c]) => {
    const available = (c.actions ?? []).filter(a => a.available !== false);
    return `${id.toUpperCase()}: ${available.map(a => a.id).join(', ')}`;
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
    else if (t.id === 'gmail_new_message') spec = '{"type":"email","filter":"from:example.com is:unread"}';
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
  return `\nKNOWLEDGE BASE CONTENT (relevant excerpts from this tenant's knowledge base — use these to inform proposals, e.g. correct field names, document structure, or domain terms):\n${chunks}\n`;
}

function operatorSummary(capabilities) {
  const op = capabilities?.operator;
  if (!op?.email) return '';
  const who = op.name ? `${op.name} <${op.email}>` : op.email;
  return `
THE OPERATOR (the person you are building this for): ${who}.
When they say "me", "myself", "DM me", or "send it to me", deliver via a Slack direct message: { channel:"slack_dm", user:"${op.email}" }.
`;
}

function triggerSummary(capabilities) {
  const triggers = capabilities?.triggers ?? {};
  const defaults = {
    email:    'Fires when a new Gmail message matches a filter. Config: filter (Gmail query), maxResults',
    schedule: 'Fires on a recurring schedule. Config: cron (cron expression e.g. "0 9 * * 1-5"), timezone (e.g. "America/New_York"), label',
    manual:   'Fires each time the user manually triggers the workflow. No config required.',
    one_time: 'Runs exactly once immediately when published, then deactivates. Use for "do this now" or "run this once". No config required.',
    webhook:  'Fires when an HTTP POST is received at a generated endpoint. Config: path (optional slug)',
    event:    'Fires on a connector event (e.g. new Slack message). Config: connector, event, filter (optional)',
  };
  const available = Object.keys(triggers).length ? triggers : defaults;
  return Object.entries(available).map(([type, desc]) =>
    `- ${type}: ${typeof desc === 'string' ? desc : desc.description ?? ''}`
  ).join('\n');
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

// The tenant's EXISTING Slack channels, so the converger can proactively create a
// named channel that doesn't exist yet instead of building a workflow that 404s (S8-3).
// Returns '' when the channel list is unknown (never assert existence we can't verify).
function slackChannelsBlock(capabilities) {
  const chans = capabilities?.slackChannels;
  if (!Array.isArray(chans)) return '';
  if (!chans.length) {
    return `\nEXISTING SLACK CHANNELS: none found. Any Slack channel the user names must be created FIRST via a "slack_create_channel" setup action (params: { name:"<name without #>" }) before the deliver node.`;
  }
  return `\nEXISTING SLACK CHANNELS (the bot can already post to these): ${chans.map(c => '#' + c).join(', ')}.\nIf the user names a Slack channel that is NOT in this list, you MUST propose a "slack_create_channel" setup action (params: { name:"<name without #>" }) BEFORE the deliver node — never build a deliver to a channel that doesn't exist yet.`;
}

// ── System prompt (shared across all converger LLM calls) ────────────────────

export function buildSystemPrompt(capabilities) {
  return `You are a workflow architect. Your job is to turn a user's intent into a structured automation spec, one component at a time.
${operatorSummary(capabilities)}
AVAILABLE CONNECTOR ACTIONS:
${capabilitySummary(capabilities)}
${airtableSchemaSummary(capabilities)}
${filesystemSummary(capabilities)}
${knowledgeContextBlock(capabilities)}
AVAILABLE TRIGGER TYPES:
${triggerSummary(capabilities)}
${connectorTriggerSummary(capabilities)}

TRIGGER INFERENCE RULES:
- Intent mentions "every morning/daily/weekly/hourly/on a schedule/recurring" → schedule trigger
- Intent mentions "when email/gmail/message arrives" → email trigger
- Intent mentions "do this now/run this once/one time/just this once/immediately" → one_time trigger
- Intent mentions "manually/on demand/whenever I want/each time I ask" → manual trigger
- Intent mentions "webhook/HTTP POST/external call/API call" → webhook trigger
- Intent mentions "when Slack message/new row/connector event fires" → event trigger
- If ambiguous between one_time and manual, ask: "Should this run once immediately, or each time you trigger it manually?"
- If trigger type genuinely unclear, ask: "What should start this workflow?"

AVAILABLE NODE TYPES (only these — every one is runnable by the engine today):
- summarize: Summarize text with AI (config: instructions, format)
- llm: Run a custom AI prompt (config: prompt, model). IMPORTANT: when this node consumes connector-action outputs (Drive files, Airtable records, etc.), the prompt MUST begin with a guard clause, e.g.: "If the provided data is empty or missing (e.g. files:[], records:[]), output EXACTLY: ERROR: required data not found — do not compose content." This prevents silent hallucination when a connector returns no results.
- extract: Extract structured fields from text (config: fields[])
- rewrite: Rewrite/transform text (config: instructions, tone)
- connector-action: Call a connector capability MID-workflow to GET or DO something, then pass the result to the next step (config: { action:"<id>", ...params }). Use this ONLY when the workflow genuinely needs to reach into a connector mid-flow — e.g. pull a Slack channel's history, look up a user, create/invite to a channel. Do NOT use it to "fetch" the data a trigger already delivers, and never for the final delivery (use deliver). If no connector action is needed, skip it entirely. Available actions:
${stepSummary(capabilities)}
- deliver: Send the final result to a destination. Choose config.channel from the destinations below and set ONLY its routing fields — the message body is filled automatically from the previous step's output, so never put the content in config. MULTIPLE DESTINATIONS: if the user asks to send the result to more than one place (e.g. "email me AND save a Google Doc", "post to Slack and email the team"), add ONE deliver node PER destination, each with its own edge from the final content node (fan-out) — the engine runs them all. Never silently drop a requested destination. Deliver nodes are always terminal (nothing runs after them).
  AVAILABLE DELIVERY DESTINATIONS (these are the only ones connected/runnable right now — never invent one):
${deliverySummary(capabilities)}
  Guidance: a "#channel" goes to channel "slack" with target. A DM / "send it to me" / "message <person>" goes to channel "slack_dm" with user = their email or @handle. If the user wants a Slack channel but hasn't named one, ask which channel.${slackChannelsBlock(capabilities)}

HOW INPUT ENTERS THE WORKFLOW:
- Workflows are event-driven. The TRIGGER provides the input — e.g. an email trigger
  delivers the matching email's content into the first step. Do NOT add a step to
  "fetch" or "pull" data mid-workflow; choose the right trigger instead (an email
  trigger to react to new mail, a schedule trigger to run periodically, etc.).
- An EVENT trigger (email, connector event) hands its payload to the first step as the
  input — don't add a step to re-"fetch" what the trigger already delivers.
- A CONTENTLESS trigger (schedule, manual, one_time, webhook) provides NO data. If the
  workflow then operates on connector data — e.g. "summarize the #general channel", "digest
  my unread emails", "report on yesterday's messages" — the FIRST step MUST be a
  connector-action that fetches that data, because the transform steps
  (summarize/extract/rewrite) have nothing to work on otherwise. Use ONLY an action listed in
  "Available actions" above — those are the actions THIS workspace's scopes actually allow. If
  no listed action can fetch the needed data, tell the user that capability isn't enabled
  (e.g. a missing Slack scope) instead of inventing one. Never use a "tool" or "fetch" node.
- Use connector-action for side-effects too (post then pin, look up a user, create a channel).

HOW DATA PASSES BETWEEN STEPS (hard engine limits — violating these makes the workflow FAIL at runtime):
- Every step automatically receives the FULL output of the previous step as its input. To reference an
  earlier step explicitly, the ONLY forms the engine resolves are {{prev}} and {{<nodeId>.output}}.
  There is NO field-path, array-index, or wildcard support: {{node.results[0].id}},
  {{node.results[*].id}}, {{node.items[*].x}}, {{node.field.sub}} are passed through LITERALLY and
  break the step (e.g. a connector gets the raw "{{…[*]…}}" string → "Invalid id value"). NEVER emit
  any {{…}} that contains '.', '[', ']' or '*' other than the exact form {{nodeId.output}}.
- A connector-action runs EXACTLY ONCE and CANNOT loop or map over a list — the engine has no per-item
  iteration. So NEVER add a step that "fetches the full content of each result" / "gets each item" /
  "enriches every row". When a search or list action returns multiple items, pass its whole output
  straight to the next summarize/llm node, which reads the entire list at once. If a search already
  returns usable fields (sender, subject, snippet, etc.), do NOT add a second connector-action to
  fetch each row — that pattern is unrunnable. Prefer the FEWEST steps that satisfy the intent.

OUTPUT FORMATTING — the engine passes the previous node's output to the deliver node as-is. It does
NOT reformat it. The "output format" shown next to each delivery channel above is non-negotiable — you
MUST instruct the content-generating node (summarize/llm/rewrite) to produce exactly that format:

- output format: mrkdwn (slack, slack_dm) — include in the node's instructions:
  "Format output as Slack mrkdwn: *bold* for headers, • for list items, blank line between sections.
  No HTML tags of any kind."
- output format: html (gmail_send) — fold the HTML formatting into the instructions of the LAST
  content-producing LLM/summarize/rewrite node that feeds the deliver step, exactly like the other
  formats: "Format the output as clean inner HTML for an email body — <h2>/<h3> headers, <p>
  paragraphs, <ul>/<li> lists. Do NOT include <html>/<body> wrappers." Only add a SEPARATE dedicated
  formatting node when there is NO LLM/summarize/rewrite node feeding the deliver step (e.g. a pure
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

INFER THE FORMAT EARLY: apply the right format instruction from the FIRST LLM/summarize/rewrite node,
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
  • Uploaded Knowledge content (RAG-indexed): no special node — the AI retrieves it through
    context in summarize/llm/extract steps. Do NOT ask for a folder.
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
{"component":"trigger","spec":{"type":"one_time"},"rationale":"<one sentence>"}
{"component":"trigger","spec":{"type":"webhook","path":"/hooks/my-workflow"},"rationale":"<one sentence>"}
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
- "do this now/run this once/one time/just this once" → one_time (no need to ask)
- "manually/on demand/whenever I want" → manual (no need to ask)
- "webhook/HTTP POST/external call" → webhook (no need to ask)
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

export function buildProposePrompt({ intent, clarifications, draft, gap, setupResults }) {
  const prior = (clarifications ?? []).map(({ q, a }) => `  Q: ${q}\n  A: ${a}`).join('\n');
  const draftStr = JSON.stringify({
    triggers: draft.triggers,
    nodes:    draft.nodes?.map(n => ({ id: n.id, type: n.type, label: n.label })),
    edges:    draft.edges,
    name:     draft.name,
  }, null, 2);

  return `Build the next component of this workflow.

INTENT: "${intent}"
${prior ? `\nCLARIFICATIONS:\n${prior}\n` : ''}${setupResultsSummary(setupResults)}
CURRENT DRAFT:
${draftStr}

NEXT GAP TO FILL: ${gapLabel(gap)}
${gap.needsEdges ? `\nVALID NODE IDs: ${(draft.nodes ?? []).map(n => n.id).filter(Boolean).join(', ')}\nEdges must use only these IDs — never "trigger" or any other keyword.` : ''}
Propose the single next component that fills this gap. Return JSON only.`;
}

// ── Modify prompt — merge user override into a proposal ──────────────────────

export function buildModifyPrompt({ original, modification }) {
  return `The user wants to modify this workflow component proposal.

ORIGINAL PROPOSAL:
${JSON.stringify(original, null, 2)}

USER'S MODIFICATION REQUEST: "${modification}"

Apply the user's requested change and return an updated proposal in the same JSON format. Return JSON only.`;
}
