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

// ── System prompt (shared across all converger LLM calls) ────────────────────

export function buildSystemPrompt(capabilities) {
  return `You are a workflow architect. Your job is to turn a user's intent into a structured automation spec, one component at a time.

AVAILABLE CONNECTOR ACTIONS:
${capabilitySummary(capabilities)}

AVAILABLE TRIGGER TYPES:
${triggerSummary(capabilities)}

TRIGGER INFERENCE RULES:
- Intent mentions "every morning/daily/weekly/hourly/on a schedule/recurring" → schedule trigger
- Intent mentions "when email/gmail/message arrives" → email trigger
- Intent mentions "do this now/run this once/one time/just this once/immediately" → one_time trigger
- Intent mentions "manually/on demand/whenever I want/each time I ask" → manual trigger
- Intent mentions "webhook/HTTP POST/external call/API call" → webhook trigger
- Intent mentions "when Slack message/new row/connector event fires" → event trigger
- If ambiguous between one_time and manual, ask: "Should this run once immediately, or each time you trigger it manually?"
- If trigger type genuinely unclear, ask: "What should start this workflow?"

AVAILABLE NODE TYPES:
- summarize: Summarize text with AI (config: instructions, format)
- llm: Run a custom AI prompt (config: prompt, model)
- extract: Extract structured fields from text (config: fields[])
- rewrite: Rewrite/transform text (config: instructions, tone)
- deliver: Send result to a destination (config: channel ["slack","in_app","webhook"], target, title)
- fetch: Fetch a URL (config: url, method)
- tool: Call a specific connector action (config: connector, action, params)

RULES:
- NEVER propose an action or connector that is not listed under AVAILABLE CONNECTOR ACTIONS
- If a user requests an unavailable service, announce it and propose the closest available alternative
- Propose exactly ONE component per response
- Return ONLY valid JSON — no prose, no markdown fences, no explanation outside the JSON

PROPOSAL FORMATS (return exactly one):

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

Name:
{"component":"name","spec":"<workflow name>","rationale":"<one sentence>"}

Clarification (only when genuinely ambiguous — ask ONE focused question):
{"type":"clarification","question":"<single question, no preamble>"}`;
}

// ── Analyze prompt — classify intent specificity ─────────────────────────────

export function buildAnalyzePrompt({ intent, clarifications }) {
  const prior = (clarifications ?? []).map(({ q, a }) => `Q: ${q}\nA: ${a}`).join('\n');
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

Return JSON only:
- If enough info to begin: {"ready":true}
- If trigger type is ambiguous OR destination is unknown: {"ready":false,"question":"<single focused question>"}

Only ask if the answer would materially change the spec. When the trigger type is inferable, proceed without asking.`;
}

// ── Propose prompt — generate next component ─────────────────────────────────

export function buildProposePrompt({ intent, clarifications, draft, gap }) {
  const prior = (clarifications ?? []).map(({ q, a }) => `  Q: ${q}\n  A: ${a}`).join('\n');
  const draftStr = JSON.stringify({
    triggers: draft.triggers,
    nodes:    draft.nodes?.map(n => ({ id: n.id, type: n.type, label: n.label })),
    edges:    draft.edges,
    name:     draft.name,
  }, null, 2);

  return `Build the next component of this workflow.

INTENT: "${intent}"
${prior ? `\nCLARIFICATIONS:\n${prior}\n` : ''}
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
