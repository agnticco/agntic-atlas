/**
 * Builder API — HTTP surface for the converger-driven P4 builder UI.
 *
 * Mounted via mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth })
 * inside createApp(). Each route is auth-gated at the requireActiveTenant level.
 *
 * Session lifecycle:
 *   POST /api/builder/sessions                  — start a converger session
 *   POST /api/builder/sessions/:id/respond      — accept|reject|modify|clarify|approve|setup_executed
 *   POST /api/builder/sessions/:id/setup        — execute a one-off setup action (create folder, etc.)
 *   DELETE /api/builder/sessions/:id            — abandon
 *
 * Workflow persistence:
 *   POST /api/builder/workflows         — create + activate a converger-emitted spec
 *
 * Identity:
 *   GET  /api/builder/me                — current user + tenant (for the UI header)
 */

import { createConverger } from '../converger/index.js';
import { GraphInterrupt }  from '../graph/index.js';
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from '../core/message.js';
import { logEvent, errFields } from '../utils/event-log.js';
import { channelIdForCapability } from '../connectors/slack/index.js';
import { webConnectionStatus } from '../connectors/web/index.js';
import { availableApprovalChannels } from '../workflows/approval-channels.js';
import { mailerConfigured } from '../utils/mailer.js';
import { getGoogleAccessToken } from '../connectors/google/index.js';
import { getSlackToken } from '../connectors/slack/oauth.js';
import { getAirtableAccessToken } from '../connectors/airtable/oauth.js';
import { sumTimeSavedMinutes, timeSavedMinutesForRun, isValueRun } from '../workflows/time-saved.js';
import { APP_VERSION } from '../version.js';
import { notesSince } from '../release-notes.js';
import { sendMail } from '../utils/mailer.js';
import { renderInviteEmail } from '../auth/invite-email.js';
import { oauthRedirectBase } from '../connectors/oauth-redirect.js';
import { seatLimit, entitlement, entitlementsFor, nextPlan, PLAN_META, BUILD_RUN_COST, PUBLIC_PLANS, isSelfServe } from '../entitlements/index.js';
import { isBillingConfigured } from '../billing/stripe.js';
import { randomBytes } from 'node:crypto';

// Retry an LLM call up to maxRetries times on transient provider errors (500/529/503).
async function withLLMRetry(fn, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      const transient = err.status === 500 || err.status === 529 || err.status === 503;
      if (!transient || attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
  }
}

// Extract a user-facing message from an Anthropic SDK error.
// SDK format: "<status> <json_body>" — parse and humanize; fall back to raw.
function cleanLLMError(err) {
  const raw = String(err?.message ?? err);
  const m = raw.match(/^(\d+)\s*(\{[\s\S]+\})/);
  if (m) {
    const status = Number(m[1]);
    try {
      const body = JSON.parse(m[2]);
      const type = body?.error?.type;
      // Transient service issues → tell the operator to retry.
      if (type === 'api_error' || type === 'overloaded_error' || type === 'rate_limit_error'
          || status >= 500 || status === 429) {
        return 'The AI service is temporarily unavailable. Please try again in a moment.';
      }
      // Context-length is the one 400 an operator can actually act on.
      const msg = String(body?.error?.message || '');
      if (/prompt is too long|maximum.*token|context.*length/i.test(msg)) {
        return 'This conversation got too long for the AI to process. Start a fresh workflow or shorten your request.';
      }
      // Everything else — 400 invalid_request_error (incl. tool_use/tool_result
      // mismatches), auth/permission faults — is an internal error, not operator-
      // actionable. Never surface raw SDK text (R17); the caller logs the real
      // error server-side (logEvent 'chat.error').
      return 'Something went wrong handling that message. Please try again.';
    } catch { /* fall through */ }
  }
  // Non-SDK errors (network, our own throws): generic message, no raw leak.
  return 'Something went wrong handling that message. Please try again.';
}

// Project connector scope-aware availability onto the channel catalog, so the
// converger only ever offers capabilities THIS tenant's granted scopes can run.
// resolvedByConnector: { slack: resolvedSlack, google: resolvedGoogle, ... }
function annotateChannelCatalog(channels, resolvedByConnector = {}) {
  // Support legacy single-arg call (resolvedByConnector is the slack object directly).
  const slack  = resolvedByConnector?.connector === 'slack' ? resolvedByConnector : resolvedByConnector.slack;
  const google = resolvedByConnector?.connector === 'google' ? resolvedByConnector : resolvedByConnector.google;

  // Slack: map channelId → {available, reason} using the connector's capability→channel mapping.
  const slackAvail = {};
  if ((slack?.grantedScopes ?? []).length > 0) {
    for (const a of slack?.actions ?? []) {
      slackAvail[channelIdForCapability(a.id)] = { available: a.available, reason: a.unavailableReason };
    }
  }

  // Google: actionId matches channel id directly (registration uses the same IDs).
  const googleAvail = {};
  if ((google?.grantedScopes ?? []).length > 0) {
    for (const a of google?.actions ?? []) {
      googleAvail[a.id] = { available: a.available, reason: a.unavailableReason };
    }
  }

  // Airtable: same pattern as Google — actionId matches capability id.
  const airtable = resolvedByConnector?.airtable;
  const airtableAvail = {};
  if ((airtable?.grantedScopes ?? []).length > 0) {
    for (const a of airtable?.actions ?? []) {
      airtableAvail[a.id] = { available: a.available, reason: a.unavailableReason };
    }
  }

  return (channels ?? []).map(c => {
    const positions = c.positions ?? (c.actionOnly ? ['step'] : ['step', 'delivery']);
    if (c.connector === 'slack') {
      const sa = slackAvail[c.id];
      if (!sa) return { ...c, positions };
      return { ...c, positions, available: c.available && sa.available, unavailableReason: sa.reason ?? c.unavailableReason };
    }
    if (c.connector === 'google') {
      const ga = googleAvail[c.id];
      if (!ga) return { ...c, positions };
      return { ...c, positions, available: c.available && ga.available, unavailableReason: ga.reason ?? c.unavailableReason };
    }
    if (c.connector === 'airtable') {
      const aa = airtableAvail[c.id];
      if (!aa) return { ...c, positions };
      return { ...c, positions, available: c.available && aa.available, unavailableReason: aa.reason ?? c.unavailableReason };
    }
    return { ...c, positions };
  });
}

// Build connector context lines from the live CapabilityRegistry.
// Returns one line per connected connector — "- DisplayName: cap1, cap2, ..."
// connectedSet: Set of connector ids that are actually connected for this tenant.
// Used for both the chat system prompt and the edit-change prompt.
const CONNECTOR_DISPLAY = {
  slack:      'Slack',
  google:     'Google Workspace',
  airtable:   'Airtable',
  web:        'Web',
  filesystem: 'Filesystem',
};

function connectorLinesFromRegistry(capabilityRegistry, connectedSet) {
  const byConnector = new Map();
  for (const cap of (capabilityRegistry?.list() ?? [])) {
    if (!cap.connector) continue;            // built-ins (in_app, webhook) — no connector field
    if (!connectedSet.has(cap.connector)) continue;
    if (!cap.available) continue;
    if (!byConnector.has(cap.connector)) byConnector.set(cap.connector, []);
    byConnector.get(cap.connector).push(cap.name);
  }
  return [...byConnector.entries()].map(([id, names]) => {
    const display = CONNECTOR_DISPLAY[id] ?? id;
    return `- ${display}: ${[...new Set(names)].join(', ')}`;
  });
}

// Build the full capability context block for the edit-change prompt.
// Includes delivery channels, step actions, and a connector summary — all live from the registry.
// connectedSet: Set of connector ids the TENANT has actually OAuth-connected. When provided,
// capabilities from unconnected connectors are moved to the unavailable list even if isReady().
function editChangeCapabilityContext(channelRegistry, capabilityRegistry, connectedSet) {
  const all = channelRegistry?.getAll() ?? [];

  const isConnected = (c) => !c.connector || !connectedSet || connectedSet.has(c.connector);

  const deliveryAll  = all.filter(c => !c.actionOnly);
  const availDel     = deliveryAll.filter(c => c.available && isConnected(c));
  const unavailDel   = deliveryAll.filter(c => !c.available || !isConnected(c));
  const channelList  = availDel.map(c => `  - "${c.id}" — ${c.name}`).join('\n') || '  (none connected)';
  const unavailNote  = unavailDel.length
    ? `\nUNAVAILABLE delivery channels (do NOT use — connector not connected):\n${unavailDel.map(c => `  - "${c.id}" — ${c.name}`).join('\n')}`
    : '';

  const stepAll      = all.filter(c => c.actionOnly && c.available && isConnected(c));
  const stepList     = stepAll.length
    ? stepAll.map(c => {
        const fields = (c.configSchema ?? []).filter(f => f.key !== 'body').map(f => f.key + (f.optional ? '?' : '')).join(', ');
        return `  - "${c.id}" — ${c.name}${fields ? ` (config fields: ${fields})` : ''}`;
      }).join('\n')
    : '  (none connected)';

  return `AVAILABLE DELIVERY CHANNEL IDs (the ONLY valid values for config.channel on a deliver node):
${channelList}${unavailNote}

AVAILABLE STEP ACTIONS (valid values for config.action on a connector-action node):
${stepList}

Channel name aliases — map user requests to the correct channel id:
- "email", "gmail", "send email", "email me"           → "gmail_send"
- "slack channel", "post to slack", "#channel"          → "slack"
- "dm", "direct message", "slack dm", "message me"      → "slack_dm"
- "sheets", "google sheets", "spreadsheet", "append"    → "sheets_append"
- "doc", "google doc", "document"                       → "docs_create"
- "calendar", "calendar event", "schedule meeting"       → "calendar_create_event"
- "tasks", "google tasks", "to-do"                      → "tasks_create"
- "search web", "web search", "look up online"          → connector-action with action "web_search"
- "fetch url", "read page", "scrape url"                → connector-action with action "web_fetch"
- "atlas inbox", "send to inbox", "store in inbox"      → "inbox_deliver"
- "search inbox", "from inbox", "inbox context"         → connector-action with action "search_inbox"`;
}

// In-process session map: threadId → converger instance.
// Sessions are short-lived (one building conversation), so in-memory is correct.
const sessions = new Map();

// Per-session serialization for /respond. The build graph is a single stateful
// thread: resuming it twice concurrently is a race — the first resume advances past
// the interrupt and the second finds no `resumeFrom` and throws, leaking a raw
// `CompiledGraph.resume()…` string into the chat. A double-click, a retry, or two
// tabs are enough to trigger it. Chaining every /respond for a threadId through one
// promise makes resumes strictly sequential, so a duplicate runs AFTER the first has
// settled (and is then handled as an already-advanced no-op) rather than racing it.
const respondChains = new Map();
function serializePerThread(threadId, task) {
  const prev = respondChains.get(threadId) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  // Keep the chain from growing unbounded / holding rejections.
  respondChains.set(threadId, next.catch(() => {}));
  next.finally(() => { if (respondChains.get(threadId) === next.catch(() => {})) respondChains.delete(threadId); }).catch(() => {});
  return next;
}
// True for the "you resumed a thread that already advanced / finished" family —
// never load-bearing (the prior resume already did the work), so it must not reach
// the user as a stack trace.
function isStaleResumeError(err) {
  const m = String(err?.message ?? err ?? '');
  return /has no resumeFrom|no checkpoint found for thread|session not found or already complete/i.test(m);
}

function pubUser(u) {
  return { id: u.id, email: u.email, display_name: u.display_name ?? u.email, role: u.role };
}

// Build the conversational system prompt with live connector context injected.
// connectorLines: string[] of "- ConnectorName: what it can do" per connected connector.
// user: { name, email } — injected so the model knows who it's talking to.
function buildChatSystem(connectorLines = [], user = null) {
  const connectorBlock = connectorLines.length
    ? `\nConnectors this workspace has connected:\n${connectorLines.join('\n')}`
    : `\nNo connectors are connected yet. If asked, say none are set up and suggest visiting Connections in the sidebar.`;

  const userBlock = user
    ? `\nYou are speaking with ${user.name}${user.email ? ` (${user.email})` : ''}.`
    : '';

  return `You are Atlas, a warm assistant for non-technical business operators. You help people automate repetitive work — and you build the automation yourself, right here in this conversation — but you are also happy to just chat, answer questions, or think an idea through.${userBlock}

BEHAVIOR:
- Tone: natural, concise, friendly — like a helpful colleague. Match the user's register.
- Small talk and general questions: answer them normally inside "reply".
- Don't pressure the user to build. If they just want to chat, just chat.
- When they describe automation: explore ONE question at a time — trigger (what starts it?), processing, destination. Don't dump a list of fields.
- YOU BUILD IT. Building a workflow from a plain-language description is exactly what you do. Never tell the user you can't build it, that it needs a developer, or that a separate human team will take it from here — when they confirm, YOU assemble it. The only thing that happens after ready_to_build:true is the system turning YOUR build_intent into a running workflow.
- FILE ACCESS: if the intent involves reading files, documents, PDFs, or attachments — check the connectors list. If Filesystem is listed, name the folder. If not, surface the gap before building: e.g. "To read that file in the workflow you'd need a folder connected under Knowledge. Set that up first?"
- ready_to_build stays false until the user clearly signals they want to build (e.g. "let's do it", "set it up", "yes, build it", "go ahead"). At that point set ready_to_build:true and write build_intent: one clear paragraph covering trigger + steps + destination, folding in everything discussed.
- If they seem close but haven't confirmed, gently offer ("Want me to set this up?") but keep ready_to_build:false.

DIRECT ACTIONS — you have tools for each connected service. When the user asks you to DO something now (e.g. "send an email", "search my calendar", "DM me"), use the appropriate tool immediately — do not ask them to confirm, just act. After the tool completes, report what happened in your reply field in the JSON format below. Do NOT use tools speculatively or when the user is just exploring — only when they explicitly ask you to perform an action.
- IMPORTANT: building a workflow is NOT a direct action and has NO tool. When the user says "build it" / "set it up" / "go ahead", do NOT call any tool and do NOT look for a build tool — that is the signal to set ready_to_build:true with a build_intent, nothing more. Tools are only for one-off actions the user wants performed live in the chat.
${connectorBlock}

OUTPUT FORMAT — every response MUST be valid JSON, no exceptions, no markdown fences:
{"reply":"<your message to the user>","ready_to_build":false,"build_intent":null}
Everything you want to say goes in "reply". Nothing goes outside the JSON object.`;
}

// Tolerant JSON extraction: strip code fences, else grab the first {...} block.
function extractJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const obj = text.match(/\{[\s\S]*\}/);
  return obj ? obj[0] : text.trim();
}

// Convert a capability's configSchema array to an Anthropic JSON Schema for tool input.
function configSchemaToInputSchema(configSchema) {
  const properties = {};
  const required = [];
  for (const field of (configSchema ?? [])) {
    if (!field.key) continue;
    properties[field.key] = {
      type: field.type === 'number' ? 'number' : 'string',
      description: [field.label, field.hint].filter(Boolean).join('. '),
    };
    if (!field.optional) required.push(field.key);
  }
  return { type: 'object', properties, required };
}

// Build Anthropic tool definitions for all step-position capabilities that belong
// to a connected connector. Triggers and delivery-only capabilities are excluded —
// they aren't meaningful as one-off chat actions.
function buildChatTools(registry, connectedSet) {
  if (!registry) return [];
  const tools = [];
  for (const cap of registry.list({ position: 'step' })) {
    if (cap.connector && !connectedSet.has(cap.connector)) continue;
    tools.push({
      name:         cap.id,
      description:  cap.description || cap.name,
      input_schema: configSchemaToInputSchema(cap.configSchema),
    });
  }
  return tools;
}

// Inject connector credentials into a capability config object (mutates config).
// Mirrors the workflow run path's token injection — same connectors, same store access.
async function injectCapabilityCredentials(cap, config, { auth, tenant, user }) {
  if (!cap?.connector) return config;
  if (cap.connector === 'google') {
    const tok = await getGoogleAccessToken({ oauthTokenStore: auth.oauthTokenStore, cipher: auth.tokenCipher, tenantId: tenant.id, userId: user.id });
    if (tok) config.googleToken = tok;
  } else if (cap.connector === 'slack') {
    const grant = getSlackToken({ oauthTokenStore: auth.oauthTokenStore, cipher: auth.tokenCipher, tenantId: tenant.id });
    if (grant?.botToken) config.token = grant.botToken;
    // So slack_create_channel can invite the operator to the channel it creates —
    // otherwise only the bot joins and the channel is invisible to them (S8-6).
    if (user?.email) config._operatorEmail = user.email;
  } else if (cap.connector === 'airtable') {
    const tok = await getAirtableAccessToken({ oauthTokenStore: auth.oauthTokenStore, cipher: auth.tokenCipher, tenantId: tenant.id });
    if (tok) config.airtableToken = tok;
  }
  return config;
}

function isConnectorConnected(cap) {
  if (!cap) return false;
  if (Array.isArray(cap.grantedScopes) && cap.grantedScopes.length) return true;
  if (cap.hasUserToken) return true;
  return false;
}

// A warm, plain-language opener that acknowledges the intent before the first
// step proposal — so Atlas eases into building instead of dropping a config card
// cold. Generated on the fast tier and run concurrently with the converger so it
// adds no perceptible latency. Returns null on any failure (purely additive).
async function introMessage(spine, intent, sessionId) {
  try {
    const llm = spine.llm;
    if (!llm?.invoke) return null;
    const sys = new SystemMessage(
      'You are Atlas, a warm, plain-spoken assistant that builds automations by talking with non-technical business operators. Never use technical jargon.');
    const user = new HumanMessage(
      `The user wants to automate: "${intent}".\n\nReply with ONE short, friendly sentence (max ~20 words) that acknowledges what you'll help them set up and signals you'll go one step at a time. No opener like "Sure"/"Great", no lists, no quotes — just the sentence.`);
    const res = await llm.invoke([sys, user], { configurable: { modelTier: 'fast', sessionId, costContext: 'chat.intro' } });
    const text = (typeof res === 'string' ? res : res?.content ?? '').trim();
    return text || null;
  } catch { return null; }
}

// Execute a batch of tool calls and append ToolMessage results to msgArray.
// Used by both the clean tool round and the mid-stream text+tool case.
// Delivery capabilities have body/title in configSchema (the LLM fills them);
// we pass them as named params so handlers can read from either config or params.
//
// sessionId is threaded into every handler so LLM-backed capabilities (e.g.
// web_search, which makes its own Anthropic call) attribute their cost to this
// tenant via the CostTracker's session→user map. Without it, those sub-calls
// log with session='unknown' and tenant_id=NULL — orphaned from per-tenant
// aggregates. Mirrors the engine's connector-action contract (sessionId +
// costContext). costContext is left to each capability's own default so it
// self-labels (web_search → 'web_search', keeping the cost-by-surface view honest).
function makeChatToolExecutor(spine, req, sessionId) {
  return async function executeChatTools(toolCalls, msgArray) {
    await Promise.all(toolCalls.map(async (tc) => {
      let resultStr;
      try {
        const registry = spine.engine?.capabilityRegistry;
        const handler  = registry?.getHandler(tc.name);
        if (!handler) throw new Error(`Unknown tool: ${tc.name}`);
        const cap    = registry.get(tc.name);
        const config = { ...(tc.args ?? {}) };
        await injectCapabilityCredentials(cap, config, { auth: spine.auth, tenant: req.tenant, user: req.user });
        const result = await handler({ config, body: config.body ?? null, title: config.title ?? null, sessionId });
        resultStr = JSON.stringify(result ?? {});
        logEvent('chat.tool.ok', { tenant: req.tenant?.id ?? null, tool: tc.name });
      } catch (toolErr) {
        resultStr = JSON.stringify({ error: toolErr.message ?? String(toolErr) });
        logEvent('chat.tool.error', { tenant: req.tenant?.id ?? null, tool: tc.name, ...errFields(toolErr) });
      }
      msgArray.push(new ToolMessage(resultStr, tc.id));
    }));
  };
}

/**
 * Let the CONVERGER call a connector capability at BUILD time. (P12 Increment F.)
 *
 * This is what turns "paste your Airtable base ID" into a click. The converger
 * cannot know a tenant's base ids, table names or column headers — but the tenant's
 * OAuth token can read all three, and we already hold it. §6.2.3: never ask for
 * something we can read.
 *
 * It reuses `injectCapabilityCredentials` — the SAME credential path the chat tool
 * executor and the engine use — so a capability invoked from the builder is
 * authorised exactly as it is anywhere else. A second credential path would be a
 * second place for a tenant's token to leak into the wrong tenant's call.
 *
 * Read-only by construction is NOT enforced here and does not need to be: the
 * converger only ever calls the `*_list_*` / `*_describe_*` capabilities (see
 * elicitation-graph.js), and a capability that writes is one the USER approves as a
 * step in their workflow, not one the builder fires while they are still talking.
 */
function makeCapabilityInvoker(spine, req, sessionId) {
  return async function invokeCapability(capabilityId, params = {}) {
    const registry = spine.engine?.capabilityRegistry;
    const handler  = registry?.getHandler(capabilityId);
    if (!handler) throw new Error(`Unknown capability: ${capabilityId}`);
    const cap    = registry.get(capabilityId);
    const config = { ...params };
    await injectCapabilityCredentials(cap, config, { auth: spine.auth, tenant: req.tenant, user: req.user });
    const out = await handler({ config, body: null, title: null, sessionId });
    logEvent('builder.capability.ok', { tenant: req.tenant?.id ?? null, capability: capabilityId });
    return out;
  };
}

// ── Home dashboard ("Data" layout) metric helpers ───────────────────────────
// All derived from real run rows — no fabricated values. See the run-log schema
// in workflow-store.js (started_at/completed_at/status/is_test/time_saved_minutes).

const DAY_MS  = 86_400_000;
const HRS = (mins) => Math.round((mins / 60) * 10) / 10; // one decimal

// Neutralise user-controlled strings (workflow names, error text) before they
// are embedded in an LLM prompt: strip line breaks so a name can't inject fake
// list items / instructions, drop the delimiter quotes, and hard-cap length.
// The home greeting/tip/alert prompts interpolate workflow names, so a name is
// an untrusted-input surface even though it is only ever the caller's own data.
function promptSafe(s, max = 80) {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`"]/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** Format total minutes as the same "X hrs" / "X min" convention the home uses. */
function fmtDuration(mins) {
  const m = Math.round(mins);
  if (m >= 60) { const h = m / 60; return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' hrs'; }
  return m + ' min';
}

/** Local midnight for a Date (server tz) — bucket boundary for day series. */
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

/** Short weekday label, e.g. "Mon". */
function dayLabel(d) { return d.toLocaleDateString('en-US', { weekday: 'short' }); }

/** Short month label, e.g. "Jan". */
function monthLabel(i) { return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][i]; }

/**
 * Derive a per-run trigger label from the owning workflow's trigger definition.
 * Per-run trigger type is not stored on the run — this reflects how the workflow
 * is configured to fire (Schedule · time / Email / Event / Manual).
 */
function triggerLabel(triggers) {
  const t = Array.isArray(triggers) ? triggers[0] : null;
  if (!t) return 'Manual';
  const type = (t.type || '').toLowerCase();
  if (type === 'schedule' || type === 'cron') {
    const time = cronToTime(t.schedule || t.cron);
    return time ? `Schedule · ${time}` : 'Schedule';
  }
  if (type === 'email' || type === 'gmail') return 'Email';
  if (type === 'manual' || type === '') return 'Manual';
  if (t.label) return t.label;
  // connector/event triggers → Title-cased type
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/[_-]+/g, ' ');
}

/** Parse the minute+hour fields of a 5-field cron into a "5:00 AM" clock label. */
function cronToTime(cron) {
  if (!cron || typeof cron !== 'string') return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hr = parts[1];
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hr)) return null; // skip */N and ranges
  const h = parseInt(hr, 10), m = parseInt(min, 10);
  if (h > 23 || m > 59) return null;
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** A run counts toward "done" activity when it is a real (non-test) success or error. */
function isDoneRun(r) { return !r.is_test && (r.status === 'success' || r.status === 'error'); }

/**
 * Composite health score (0–100) over a set of done runs: the success ratio,
 * penalised for workflows currently broken or overdue. Returns null when the
 * window has no runs (no signal). Rating bands documented at the call site.
 */
function successPct(doneRuns) {
  if (!doneRuns.length) return null;
  const ok = doneRuns.filter(r => r.status === 'success').length;
  return Math.round((ok / doneRuns.length) * 100);
}

function healthRating(score) {
  if (score >= 95) return 'Excellent';
  if (score >= 85) return 'Great';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Needs attention';
}

export function mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth, readSources, tenantGuard }) {
  // No-op guard when not supplied (keeps the builder mountable in isolation/tests).
  const guard = tenantGuard ?? ((_req, _res, next) => next());

  // ── GET /api/builder/me ──────────────────────────────────────────────────────
  app.get('/api/builder/me', requireAuth, (req, res) => {
    res.json({ user: pubUser(req.user), tenant: { id: req.tenant.id, name: req.tenant.name }, version: APP_VERSION });
  });

  // ── What's New — release notes since the user last acknowledged ───────────────
  // GET returns the current version + any release-note entries the user hasn't
  // seen yet (by their stored last_seen_version). POST /ack marks them seen.
  app.get('/api/builder/whats-new', requireActiveTenant, (req, res) => {
    try {
      const prefs = spine.auth?.userStore?.getPreferences?.(req.user.id, req.tenant.id) ?? {};
      res.json({ version: APP_VERSION, entries: notesSince(prefs.last_seen_version ?? null) });
    } catch (err) { res.status(500).json({ error: err.message ?? String(err) }); }
  });

  app.post('/api/builder/whats-new/ack', requireActiveTenant, (req, res) => {
    try {
      const prefs = { ...(spine.auth.userStore.getPreferences(req.user.id, req.tenant.id) ?? {}) };
      prefs.last_seen_version = APP_VERSION;
      spine.auth.userStore.update(req.user.id, { preferences: prefs }, req.tenant.id);
      res.json({ ok: true, version: APP_VERSION });
    } catch (err) { res.status(500).json({ error: err.message ?? String(err) }); }
  });

  // ── Team: members list + invite teammate (seat-gated) + remove ──────────────
  const activeMembers = (tenantId) => spine.auth.userStore.list(tenantId).filter((u) => !u.disabled_at);

  app.get('/api/builder/team', requireActiveTenant, (req, res) => {
    try {
      const tenant = spine.auth.tenantStore.get(req.tenant.id);
      const limit = seatLimit(tenant?.plan);
      const members = activeMembers(req.tenant.id).map((u) => ({
        id: u.id, email: u.email, display_name: u.display_name, role: u.role,
        pending: !u.last_login_at, is_you: u.id === req.user.id,
      }));
      res.json({
        members, plan: tenant?.plan ?? 'solo', isAdmin: req.user.role === 'admin',
        seats: { used: members.length, limit: limit === Infinity ? null : limit },
      });
    } catch (err) { res.status(500).json({ error: err.message ?? String(err) }); }
  });

  // Live plan + usage snapshot for the sidebar meter / account flyout. The
  // workflows meter is the loud adoption constraint; runs is the hard monthly cap.
  // `limit: null` means unlimited (∞ plans).
  app.get('/api/builder/usage', requireActiveTenant, (req, res) => {
    try {
      const ent = entitlementsFor(spine.auth.tenantStore, req.tenant.id);
      const store = spine.engine.workflowStore;
      const tenantRow = spine.auth.tenantStore.get(req.tenant.id);
      const cap = (v) => (v === Infinity ? null : v);
      // First day of next calendar month — when the run budget resets.
      const [y, m] = store.currentRunPeriod().split('-').map(Number);
      const resetsOn = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString().slice(0, 10);
      // Serve the plan catalog from PLAN_META rather than letting the client
      // hardcode it. The UI previously carried its own copy of the tiers, which
      // silently drifted from what the server enforces (it was still advertising
      // Professional at 10 workflows / 200 runs after the caps were re-derived).
      // One source of truth, or the pricing modal lies again.
      const plural = (n, one, many) => (n === Infinity ? `Unlimited ${many}` : `${n} ${n === 1 ? one : many}`);
      const catalog = PUBLIC_PLANS.map((id) => {
        const m = PLAN_META[id];
        const selfServe = isSelfServe(id);
        return {
          id,
          label: m.label,
          // Consultative plans have no price to show — never render a number the
          // customer could hold us to for an unscoped engagement.
          price: selfServe ? `$${m.price}` : "Let's talk",
          selfServe,
          workflows: plural(m.workflows, 'live automation', 'live automations'),
          runs: m.runs === Infinity ? 'Unlimited runs' : `${m.runs.toLocaleString()} runs / mo`,
          users: plural(m.users, 'user', 'users'),
        };
      });

      res.json({
        plan: ent.plan,
        planLabel: PLAN_META[ent.plan]?.label ?? ent.plan,
        upgradeTo: nextPlan(ent.plan),
        billingConfigured: isBillingConfigured(),
        manageable: !!tenantRow?.stripe_customer_id,
        catalog,
        consultEmail: 'hello@agntic.co',
        workflows: { used: store.countActiveForTenant(req.tenant.id), limit: cap(ent.activeWorkflows) },
        runs:      { used: store.getRunCount(req.tenant.id), limit: cap(ent.monthlyRuns), resetsOn },
        seats:     { used: activeMembers(req.tenant.id).length, limit: cap(ent.seats) },
      });
    } catch (err) { res.status(500).json({ error: err.message ?? String(err) }); }
  });

  app.post('/api/builder/team/invite', requireActiveTenant, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only workspace admins can invite teammates.' });
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const role = req.body?.role === 'admin' ? 'admin' : 'user';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (spine.auth.userStore.findByEmail(email)) return res.status(409).json({ error: 'That email is already in use on Atlas.' });

      const tenant = spine.auth.tenantStore.get(req.tenant.id);
      const limit = seatLimit(tenant?.plan);
      if (activeMembers(req.tenant.id).length >= limit) {
        return res.status(402).json({ error: `Your ${tenant?.plan ?? 'plan'} plan includes ${limit} seat${limit === 1 ? '' : 's'}. Upgrade to add teammates.`, code: 'PLAN_LIMIT', feature: 'seats' });
      }

      const member = await spine.auth.authProvider.register({
        tenantId: req.tenant.id, email, password: randomBytes(24).toString('base64url'), role, display_name: '',
      });
      let invited = false, inviteLink = null;
      try {
        const token = spine.auth.passwordResetStore.create({ userId: member.id, tenantId: req.tenant.id, ttlMs: 7 * 24 * 60 * 60 * 1000 });
        const base = oauthRedirectBase();
        inviteLink = `${base}/?reset=${encodeURIComponent(token)}`;
        const mail = renderInviteEmail({ inviteLink, userEmail: email, workspaceName: tenant?.name ?? 'your workspace', base });
        const r = await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
        invited = !!r?.delivered;
      } catch (mailErr) { logEvent('team.invite.mail_error', { tenant: req.tenant.id, error: mailErr.message ?? String(mailErr) }); }

      logEvent('team.invite', { tenant: req.tenant.id, by: req.user.id, invited });
      res.json({ ok: true, member: { id: member.id, email: member.email, role: member.role, pending: true, is_you: false }, invited, ...(invited ? {} : { inviteLink }) });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });

  app.post('/api/builder/team/:userId/remove', requireActiveTenant, (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only workspace admins can remove teammates.' });
      if (req.params.userId === req.user.id) return res.status(400).json({ error: "You can't remove yourself." });
      spine.auth.userStore.disable(req.params.userId, req.tenant.id); // tenant-guarded; no-op if not in this tenant
      try { spine.auth.sessionStore.revokeAllForUser(req.params.userId); } catch { /* best effort */ }
      logEvent('team.remove', { tenant: req.tenant.id, by: req.user.id, target: req.params.userId });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });

  // ── GET /api/builder/greeting ────────────────────────────────────────────────
  // Returns a fresh, varied opening message for every new builder session.
  // Fast tier — called on app load and on "New workflow", so latency matters.
  app.get('/api/builder/greeting', requireActiveTenant, async (req, res) => {
    const FALLBACK = "Hey, I'm Atlas. I can help you automate things — or we can just talk it through first. What's on your mind?";
    try {
      const llm = spine.llm;
      if (!llm?.invoke) return res.json({ ok: true, greeting: FALLBACK });
      const greetSessionId = `greeting-${req.user?.id ?? 'anon'}-${Date.now()}`;
      spine.costTracker?.setSessionUser?.(greetSessionId, req.user?.id);

      const name = (req.user?.display_name || '').trim().split(/\s+/)[0] || null;

      const raw = await llm.invoke([
        new SystemMessage(
          'You are Atlas — a sharp, direct assistant that helps business operators automate repetitive work by talking through it naturally.'
        ),
        new HumanMessage(
          `Generate a brief, natural opening line to start a fresh conversation with ${name ? `an operator named ${name}` : 'an operator'} who is about to describe something they want to automate.${name ? ` Address them by first name (${name}).` : ''}

Vary the approach each time — cycle through these angles without repeating the same one:
- Ask what is eating their time today
- Name a common automation category (follow-ups, reports, alerts, data sync, notifications, approvals)
- Invite them to describe the most repetitive thing they do
- Ask what they wish just happened automatically

Rules:
- 1 sentence, 2 at most. Under 25 words total.
- Never open with "Hello", "Hi", "Hey", or any standalone greeting word
- Never say "I'm here to help", "How can I assist", or "Great question"
- Sound confident and specific, not like a chatbot intro
- Output ONLY the greeting text, nothing else`
        )
      ], { configurable: { modelTier: 'fast', sessionId: greetSessionId, costContext: 'chat.greeting' } });

      const text = (typeof raw === 'string' ? raw : raw?.content ?? '').trim().replace(/^["']|["']$/g, '');
      res.json({ ok: true, greeting: text || FALLBACK });
    } catch {
      res.json({ ok: true, greeting: FALLBACK });
    }
  });

  // ── POST /api/builder/chat ───────────────────────────────────────────────────
  // The conversational front door. The user talks to Atlas naturally — small talk,
  // questions, or thinking through an idea — and Atlas only signals readiness to
  // BUILD a workflow once the user is clearly ready. Stateless: the client sends
  // the running message history each turn.
  // Body:    { messages: [{ role:'user'|'assistant', content }] }
  // Returns: SSE stream of events: {type:'tool',name} | {type:'reply',reply,readyToBuild,buildIntent}
  // SSE keeps bytes flowing to Cloudflare Tunnel so long tool-use turns don't 524.
  app.post('/api/builder/chat', requireActiveTenant, guard, async (req, res) => {
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages[] is required' });
    }

    // Flush SSE headers immediately so Cloudflare sees a response before any timeouts fire.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    const sseWrite = (obj) => {
      if (closed) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { closed = true; }
    };

    // Heartbeat: send an SSE comment every 15 s to keep Cloudflare Tunnel alive.
    // Without this, a >100 s LLM call (e.g. processing large web search results)
    // produces no bytes, Cloudflare aborts the body stream, and the browser sees
    // "Failed to fetch" even though the server eventually completed the work.
    const heartbeat = setInterval(() => {
      if (!closed) try { res.write(': heartbeat\n\n'); } catch { closed = true; }
    }, 15000);

    try {
      const llm = spine.llm;
      if (!llm?.invoke) { sseWrite({ type: 'error', error: 'LLM unavailable' }); res.end(); return; }
      // Route through ModelPool (not a raw tier) so _trackUsage() fires.
      const chatSessionId = `chat-${req.user?.id ?? 'anon'}-${Date.now()}`;
      spine.costTracker?.setSessionUser?.(chatSessionId, req.user?.id);

      // Normalize history: assistant messages must be JSON-formatted so the model
      // sees its own prior turns in the correct envelope and continues the pattern.
      // When the client stores a prose fallback (parsed:false), wrapping it here
      // prevents the model from learning that prose is an acceptable format.
      const history = messages.slice(-24)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => {
          if (m.role !== 'assistant') return { role: m.role, content: m.content };
          let content = m.content.trim();
          try { JSON.parse(content); return { role: 'assistant', content }; } catch { /* not JSON */ }
          // Plain prose — wrap in the expected envelope so the model sees a consistent format.
          return { role: 'assistant', content: JSON.stringify({ reply: content, ready_to_build: false, build_intent: null }) };
        });

      // Resolve live connector grants and build connector lines from the registry.
      // Any connector registered in the CapabilityRegistry appears automatically.
      const connectorLines = [];
      const connectedSet = new Set();
      try {
        const sl  = await spine.slack.resolveForTenant(req.tenant.id);
        const go  = await spine.google.resolveForTenant(req.tenant.id, req.user.id);
        const at  = spine.airtable.resolveForTenant(req.tenant.id);
        const web = webConnectionStatus();

        if (sl.connected)  connectedSet.add('slack');
        if (go.connected)  connectedSet.add('google');
        if (at.connected)  connectedSet.add('airtable');
        if (web.connected) connectedSet.add('web');

        connectorLines.push(...connectorLinesFromRegistry(spine.engine.capabilityRegistry, connectedSet));

        // Filesystem + Knowledge: not in the CapabilityRegistry, add manually.
        const allKnSources = readSources?.(req.tenant.id) ?? [];
        const fsSources    = allKnSources.filter(s => s.path?.startsWith('/'));
        const upSources    = allKnSources.filter(s => !s.path?.startsWith('/'));
        if (fsSources.length) {
          const names = fsSources.map(s => s.path.split('/').pop()).join(', ');
          connectorLines.push(`- Filesystem: read files from connected folders (${names}) via filesystem_read`);
        }
        if (upSources.length) {
          const names = upSources.map(s => s.path).join(', ');
          connectorLines.push(`- Knowledge uploads (RAG-indexed, searchable in context): ${names}`);
        }
      } catch { /* non-fatal */ }

      // Retrieve relevant knowledge base + inbox context via RAG.
      // If the user message contains /SourceName references, those sources are
      // searched first with a lower threshold; results are prepended before the
      // generic search so the LLM sees the pinned content prominently.
      let ragBlock = '';
      try {
        const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content ?? '';
        if (lastUserMsg) {
          const rag  = await spine.rag.forTenant(req.tenant.id);

          // Extract explicit /SourceName references (e.g. from the / picker pill).
          const slashRefs = [...new Set(
            (lastUserMsg.match(/\/([^\s/]+)/g) || []).map(r => r.slice(1).toLowerCase())
          )];

          let pinnedCtx = '';
          if (slashRefs.length) {
            // Fetch more candidates so filtering has enough to work with.
            const allHits = await rag.query(lastUserMsg, 16);
            const pinned = (allHits ?? []).filter(h => {
              const src = (h.metadata?.source_path || h.metadata?.source || '').toLowerCase();
              const name = src.split('/').filter(Boolean).pop() || src;
              return slashRefs.some(ref => name.includes(ref) || src.includes(ref));
            }).slice(0, 4);
            if (pinned.length) {
              pinnedCtx = pinned.map(h => {
                const label = h.metadata?.subject || h.metadata?.source_path || h.metadata?.source || 'source';
                return `[${label}]\n${h.pageContent ?? h.content ?? ''}`;
              }).join('\n\n---\n\n');
            }
          }

          // Generic search for remaining context (skip if pinned already covered enough).
          const hits = await rag.query(lastUserMsg, 6);
          const useful = (hits ?? []).filter(h => (h.score ?? 0) > 0.25).slice(0, 4);
          const generalCtx = useful.map(h => {
            const label = h.metadata?.subject || h.metadata?.source_path || h.metadata?.source || 'source';
            return `[${label}]\n${h.pageContent ?? h.content ?? ''}`;
          }).join('\n\n---\n\n');

          const fullCtx = [pinnedCtx, generalCtx].filter(Boolean).join('\n\n---\n\n');
          if (fullCtx) {
            ragBlock = `\n\nRelevant content retrieved from the knowledge base and inbox:\n${fullCtx}`;
          }
        }
      } catch { /* non-fatal */ }

      const chatUser = { name: req.user.display_name || req.user.email, email: req.user.email };
      const chatTools = buildChatTools(spine.engine?.capabilityRegistry, connectedSet);
      const executeChatTools = makeChatToolExecutor(spine, req, chatSessionId);
      const invokeConfig = {
        configurable: { modelTier: 'balanced', sessionId: chatSessionId, costContext: 'chat' },
        ...(chatTools.length ? { tools: chatTools } : {}),
      };

      // Tool-use loop: the model may call tools before returning the final JSON reply.
      // Max 3 rounds to prevent runaway loops. Each iteration:
      //   1. Call the LLM (with tools on every turn so it can chain calls).
      //   2. If the model issued tool calls, execute each capability and append results.
      //   3. Repeat until no tool calls or max iterations reached.
      const msgArray = [
        { role: 'system', content: buildChatSystem(connectorLines, chatUser) + ragBlock },
        ...history,
      ];
      // When tools are in play Claude can drift from the JSON envelope and reply in prose.
      // Reinforce the format contract on the last user message — the most salient
      // position — so the model sees the constraint immediately before its turn.
      if (chatTools.length && msgArray.length > 1) {
        const last = msgArray[msgArray.length - 1];
        if (last?.role === 'user' && typeof last.content === 'string') {
          msgArray[msgArray.length - 1] = {
            ...last,
            content: last.content + '\n\n[Format: whether or not you call a tool, your text response must be exactly: {"reply":"<your message>","ready_to_build":false,"build_intent":null}]',
          };
        }
      }
      // Streaming state machine: extracts the "reply" field value from the JSON envelope
      // character by character as tokens arrive, forwarding only the visible text.
      // Falls back to raw text if the model omits the envelope (e.g. after tool use).
      let extractState = 'searching'; // 'searching' | 'streaming' | 'done'
      let searchBuf = '';
      let replyBuf  = '';
      let streamedText = '';
      let escapeNext = false;

      const processStreamChar = (ch) => {
        if (escapeNext) {
          const MAP = { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
          replyBuf += MAP[ch] ?? ch;
          escapeNext = false;
        } else if (ch === '\\') {
          escapeNext = true;
        } else if (ch === '"') {
          extractState = 'done';
        } else {
          replyBuf += ch;
        }
      };

      const processToken = (t) => {
        streamedText += t;
        for (const ch of t) {
          if (extractState === 'done') break;
          if (extractState === 'searching') {
            searchBuf += ch;
            const m = searchBuf.match(/"reply"\s*:\s*"/);
            if (m) {
              extractState = 'streaming';
              escapeNext = false;
              const rest = searchBuf.slice(m.index + m[0].length);
              searchBuf = '';
              for (const rc of rest) processStreamChar(rc);
            }
          } else {
            processStreamChar(ch);
          }
        }
        if (replyBuf && !closed) { sseWrite({ type: 'chunk', text: replyBuf }); replyBuf = ''; }
      };

      // Tool-use + streaming loop.
      // Anthropic tool-use turns yield NO intermediate text chunks — only a single
      // final AIMessage with toolCalls. Text turns yield many small delta AIMessages.
      // Peeking at the first gen.next() cleanly distinguishes the two cases.
      const MAX_TOOL_ROUNDS = 3;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const gen = llm.stream(msgArray, invokeConfig);
        const { value: firstChunk, done: firstDone } = await gen.next();
        if (firstDone) break;

        const firstToolCalls = firstChunk?.additionalKwargs?.toolCalls;
        if (Array.isArray(firstToolCalls) && firstToolCalls.length) {
          // ── Tool round ────────────────────────────────────────────────────────
          // Drain generator (no more chunks after the summary yield in tool rounds).
          for await (const _ of gen) {} // eslint-disable-line no-unused-vars

          for (const tc of firstToolCalls) sseWrite({ type: 'tool', name: tc.name });
          msgArray.push(new AIMessage(firstChunk.content ?? '', firstChunk.additionalKwargs ?? {}));

          await executeChatTools(firstToolCalls, msgArray);
          continue; // next round
        }

        // ── Final text round: stream reply to the client as tokens arrive ──────
        // Also catches mixed text-preamble + tool-call responses: if mid-stream tool
        // calls appear (model said something then decided to use a tool), capture them
        // and loop rather than dropping them.
        let midStreamToolCalls = null, midStreamChunk = null;
        processToken(typeof firstChunk.content === 'string' ? firstChunk.content : '');
        for await (const chunk of gen) {
          const tc = chunk?.additionalKwargs?.toolCalls;
          if (Array.isArray(tc) && tc.length) { midStreamToolCalls = tc; midStreamChunk = chunk; break; }
          processToken(typeof chunk.content === 'string' ? chunk.content : '');
        }

        if (midStreamToolCalls) {
          // Model emitted text preamble then tool calls in the same turn.
          // Discard the preamble from the *client* stream (it's not the JSON reply),
          // but re-submit the assistant turn with its FULL additionalKwargs — crucially
          // `_anthropicContent`, which holds the original tool_use blocks. Pushing a bare
          // { toolCalls } (missing _anthropicContent) made _prepareAnthropicMessages fall
          // back to empty content, so the resent assistant turn had no tool_use blocks
          // while executeChatTools still appended tool_result blocks referencing their
          // ids — Anthropic then 400s ("tool_use ids without tool_result blocks") and the
          // raw error leaked to the operator (R17). Mirror the clean-round path (above).
          extractState = 'searching'; searchBuf = ''; replyBuf = ''; streamedText = ''; escapeNext = false;
          for (const tc of midStreamToolCalls) sseWrite({ type: 'tool', name: tc.name });
          msgArray.push(new AIMessage(midStreamChunk?.content ?? '', midStreamChunk?.additionalKwargs ?? { toolCalls: midStreamToolCalls }));
          await executeChatTools(midStreamToolCalls, msgArray);
          continue;
        }

        // If the model skipped the JSON envelope, stream the raw text directly.
        if (extractState === 'searching' && streamedText && !closed) {
          const CHUNK = 40;
          for (let i = 0; i < streamedText.length; i += CHUNK) {
            sseWrite({ type: 'chunk', text: streamedText.slice(i, i + CHUNK) });
          }
        }

        let parsedMeta = null;
        try { parsedMeta = JSON.parse(extractJsonLoose(streamedText)); } catch {}
        const readyToBuild = parsedMeta ? !!parsedMeta.ready_to_build : false;
        const buildIntent  = (parsedMeta && typeof parsedMeta.build_intent === 'string' && parsedMeta.build_intent.trim()) ? parsedMeta.build_intent.trim() : null;

        logEvent('chat.reply', { tenant: req.tenant?.id ?? null, turns: messages.length, readyToBuild, parsed: !!parsedMeta?.reply });
        sseWrite({ type: 'done', readyToBuild, buildIntent });
        clearInterval(heartbeat);
        res.end();
        return;
      }

      // Exhausted tool rounds without a text response (shouldn't happen in practice).
      sseWrite({ type: 'error', error: 'Max tool rounds reached without a text reply.' });
      clearInterval(heartbeat);
      res.end();
    } catch (err) {
      clearInterval(heartbeat);
      logEvent('chat.error', { tenant: req.tenant?.id ?? null, ...errFields(err) });
      sseWrite({ type: 'error', error: cleanLLMError(err) });
      res.end();
    }
  });

  // ── POST /api/builder/test-summary ──────────────────────────────────────────
  // Generate a conversational summary of a completed test run for the chat UI.
  // Body:    { spec, result: { completed, steps, deliveries, output, error } }
  // Returns: { summary }
  app.post('/api/builder/test-summary', requireActiveTenant, async (req, res) => {
    const { spec, result } = req.body ?? {};
    if (!spec || !result) return res.status(400).json({ error: 'spec and result are required' });
    try {
      const llm = spine.llm;
      if (!llm?.invoke) return res.status(503).json({ error: 'LLM unavailable' });
      const summarySessionId = `test-summary-${req.user?.id ?? 'anon'}-${Date.now()}`;
      spine.costTracker?.setSessionUser?.(summarySessionId, req.user?.id);

      const name = spec.name || 'this workflow';
      const triggerLabel = ((spec.triggers || [])[0]?.label) || ((spec.triggers || [])[0]?.type) || 'trigger';
      const nodeList = (spec.nodes || []).map(n => `${n.label || n.type} (${n.type})`).join(' → ');
      const { completed, steps = [], deliveries = [], output, error } = result;

      let ctx = `Workflow: "${name}"\nTrigger: ${triggerLabel}\nNodes: ${nodeList}\nResult: ${completed ? 'ALL STEPS PASSED' : 'FAILED'}`;
      if (deliveries.length > 0) {
        const d = deliveries[0];
        ctx += `\nDelivery: message sent to ${d.channel || 'the destination channel'}${d.ts ? ' ✓' : ''}`;
      }
      if (output && typeof output === 'string')   ctx += `\nOutput excerpt: ${output.slice(0, 350)}`;
      if (output && typeof output === 'object')   ctx += `\nOutput: ${JSON.stringify(output).slice(0, 350)}`;
      if (!completed && error)                    ctx += `\nError: ${String(error).slice(0, 250)}`;
      if (!completed && steps.length > 0)         ctx += `\nCompleted ${steps.length} step(s) before failure`;

      const SYSTEM = `You are Atlas, an AI workflow assistant. The user just ran a test of their workflow. Write a 2-3 sentence summary of what happened, in plain language a non-technical person would understand. Be specific — say what the workflow actually did (or what broke), not just "the test passed/failed". Don't use quotes around the workflow name. If it passed, be warm and specific. If it failed, be clear about what went wrong.`;

      const raw = await withLLMRetry(() => llm.invoke(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Summarize this test run:\n\n${ctx}` }],
        { configurable: { modelTier: 'fast', sessionId: summarySessionId, costContext: 'chat.test-summary' } },
      ));
      const summary = (typeof raw === 'string' ? raw : raw?.content ?? '').trim();

      logEvent('test.summary', { tenant: req.tenant?.id ?? null, completed, chars: summary.length });
      return res.json({ summary });
    } catch (err) {
      logEvent('test.summary.error', { tenant: req.tenant?.id ?? null, ...errFields(err) });
      res.status(500).json({ error: cleanLLMError(err) });
    }
  });

  // ── POST /api/builder/sessions ───────────────────────────────────────────────
  // Start a new converger session from a plain-language intent.
  // Body: { intent: string }
  // Returns: { threadId, interrupt }
  app.post('/api/builder/sessions', requireActiveTenant, async (req, res) => {
    const { intent } = req.body ?? {};
    if (!intent?.trim()) return res.status(400).json({ error: 'intent is required' });

    // Operator identity lets the converger resolve "me"/"DM me" to a real target.
    let capabilities = { operator: { name: req.user?.display_name ?? null, email: req.user?.email ?? null } };
    try {
      const slack    = await spine.slack.resolveForTenant(req.tenant.id);
      const google   = await spine.google.resolveForTenant(req.tenant.id, req.user.id);
      const airtable = spine.airtable.resolveForTenant(req.tenant.id);
      const web      = webConnectionStatus();
      capabilities.connectors = { slack, google, airtable, web: { connected: web.connected } };

      // Fetch Airtable base + table schema so the converger can propose real
      // baseId / tableId values instead of placeholder strings.
      if (airtable.connected) {
        try {
          const { getAirtableAccessToken } = await import('../connectors/airtable/oauth.js');
          const pat = await getAirtableAccessToken({
            oauthTokenStore: spine.auth.oauthTokenStore,
            cipher: spine.auth.tokenCipher,
            tenantId: req.tenant.id,
          });
          if (pat) {
            const headers = { authorization: `Bearer ${pat}` };
            const basesRes = await fetch('https://api.airtable.com/v0/meta/bases', { headers });
            if (basesRes.ok) {
              const { bases = [] } = await basesRes.json();
              const schema = await Promise.all(bases.map(async (b) => {
                try {
                  const tRes = await fetch(`https://api.airtable.com/v0/meta/bases/${b.id}/tables`, { headers });
                  if (!tRes.ok) return { id: b.id, name: b.name, tables: [] };
                  const { tables = [] } = await tRes.json();
                  return {
                    id: b.id, name: b.name,
                    tables: tables.map(t => ({
                      id: t.id, name: t.name,
                      fields: (t.fields ?? []).map(f => ({ name: f.name, type: f.type })),
                    })),
                  };
                } catch { return { id: b.id, name: b.name, tables: [] }; }
              }));
              capabilities.airtableSchema = schema;
            }
          }
        } catch { /* non-fatal */ }
      }
      // Existing Slack channels, so the converger can tell whether a named target
      // already exists — and proactively propose a create_channel setup action for
      // one that doesn't (S8-3) instead of silently building a workflow that 404s.
      if (slack) {
        try {
          // getSlackToken returns { botToken, scopes } (or null); fall back to the
          // env bot token (dev escape hatch) so the fetch works however Slack is wired.
          const grant = getSlackToken({ oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId: req.tenant.id });
          const botToken = grant?.botToken ?? process.env.SLACK_BOT_TOKEN;
          if (botToken) {
            const apiBase = process.env.SLACK_API_URL ?? 'https://slack.com/api';
            const r = await fetch(`${apiBase}/conversations.list?exclude_archived=true&limit=200&types=public_channel,private_channel`, { headers: { authorization: `Bearer ${botToken}` } });
            const d = await r.json();
            if (d?.ok) capabilities.slackChannels = (d.channels ?? []).map(c => c.name).filter(Boolean);
          }
        } catch { /* non-fatal */ }
      }
      // Scope-aware, position-tagged catalog: only what this tenant can actually run.
      capabilities.channels   = annotateChannelCatalog(spine.engine.channelRegistry.getAll(), { slack, google, airtable });
      // Narrow triggers to connected connectors only.
      const connectedIds = new Set(['slack', 'google'].filter(id => id === 'slack' ? slack : google));
      if (airtable.connected) connectedIds.add('airtable');
      if (web.connected)      connectedIds.add('web');
      capabilities.triggers = spine.engine.capabilityRegistry
        .list({ position: 'trigger' })
        .map(t => ({ ...t, available: t.available && (!t.connector || connectedIds.has(t.connector)) }));

      // Filesystem: any source with an absolute path is readable via filesystem_read /
      // filesystem_list in workflows — this now includes browser-uploaded Knowledge
      // folders, which are persisted to an app-managed path (S8-9). Expose each folder's
      // absolute path + file names so the converger can propose a valid filesystem_read.
      const allSources = readSources?.(req.tenant.id) ?? [];
      const fsSources    = allSources.filter(s => s.path?.startsWith('/'));
      const uploadSources = allSources.filter(s => !s.path?.startsWith('/'));
      capabilities.filesystem = fsSources.map(s => ({
        name:  s.name || s.path.split('/').pop(),
        path:  s.path,
        files: Array.isArray(s.fileNames) ? s.fileNames.slice(0, 40) : [],
      }));
      capabilities.knowledgeUploads = uploadSources.map(s => s.name || s.path);
    } catch { /* non-fatal — converger still works with empty capabilities */ }

    // THE CHANNEL CATALOG IS NOT OPTIONAL.
    //
    // Everything above runs inside one try whose catch is "non-fatal" — but it is
    // network-bound (three connector `resolveForTenant` calls), and the catalog is
    // assigned near the END of it. So an expired refresh token or a rate limit
    // left `capabilities.channels` UNSET, which silently switched off the
    // converger's ability to check that a delivery channel exists at all
    // (gap-scorer: CHANNELS_UNVERIFIED). The guard disappeared exactly when it was
    // most needed: with no catalog, the model has none in its prompt either, so it
    // is at its most likely to invent one.
    //
    // The registry is LOCAL and cannot fail for network reasons, so there is
    // always a catalog to fall back to. An unannotated one is worse than the
    // scope-aware one above — but it is infinitely better than none, because none
    // means the check does not run. (Found by the independent verifier.)
    if (!Array.isArray(capabilities.channels) || !capabilities.channels.length) {
      try { capabilities.channels = spine.engine.channelRegistry.getAll(); } catch { /* registry itself is down */ }
    }

    // ── The approval channels (P12 Increment D) ──────────────────────────────
    // Same reasoning, one door along. A `human` node asks over inbox / slack /
    // email, and APPROVAL_CHANNEL_NOT_CONNECTED is the check that a question can
    // actually reach somebody. Publish always runs it (server.js constructs the
    // validator with this view); the scorer must run it too, or a workflow that
    // pauses on a Slack workspace nobody connected scores COMPLETE and then
    // refuses to save — and at run time waits forever for an answer nobody was
    // ever asked for.
    //
    // Derived from the SAME local registry (`inbox` needs no connector, which is
    // what lets escalation always have somewhere to go), so it cannot be knocked
    // out by a network failure the way the annotated catalog above could.
    try {
      capabilities.approvalChannels = availableApprovalChannels(
        spine.engine.channelRegistry, { mailer: mailerConfigured() },
      );
    } catch { /* registry itself is down — the scorer then refuses to certify */ }

    // Query RAG for knowledge relevant to this intent so the converger's LLM
    // calls can see what's actually in the knowledge base (not just folder names).
    if (intent) {
      try {
        const rag  = await spine.rag.forTenant(req.tenant.id);
        const hits = await rag.query(intent, 6);
        const useful = (hits ?? []).filter(h => (h.score ?? 0) > 0.2).slice(0, 4);
        if (useful.length) {
          capabilities.knowledgeContext = useful.map(h => {
            const label = h.metadata?.subject || h.metadata?.source_path || h.metadata?.source || 'knowledge';
            return { label, content: (h.pageContent ?? h.content ?? '').slice(0, 600) };
          });
        }
      } catch { /* non-fatal */ }
    }

    const threadId  = `build-${req.tenant.id}-${Date.now()}`;
    // Register user attribution so converger LLM cost records carry tenant_id.
    spine.costTracker?.setSessionUser?.(threadId, req.user?.id);
    // Start intro message after threadId exists so it shares the same session attribution.
    const introP = introMessage(spine, intent, threadId);
    const converger = createConverger({
      llm:              spine.llm,
      capabilities,
      // The converger reads the tenant's real Airtable bases, tables and columns
      // (and their real emails) instead of asking them to be typed. §6.2.3.
      invokeCapability: makeCapabilityInvoker(spine, req, threadId),
      interactionStore: spine.interactionStore,
      tenantId:         req.tenant.id,
      userId:           req.user?.id,
    });

    sessions.set(threadId, converger);

    let interrupt;
    try {
      await converger.run(threadId, intent);
      interrupt = { type: 'done' };
    } catch (err) {
      if (err instanceof GraphInterrupt || err?.interruptValue) {
        interrupt = err.interruptValue ?? err;
      } else {
        logEvent('session.error', { tenant: req.tenant?.id ?? null, threadId, phase: 'start', ...errFields(err) });
        sessions.delete(threadId);
        return res.status(500).json({ error: err.message ?? String(err) });
      }
    }
    logEvent('session.start', { tenant: req.tenant?.id ?? null, threadId, interrupt: interrupt?.type });

    // Attach the conversational opener to the first interrupt so the UI can show
    // it before the first proposal/question.
    const intro = await introP.catch(() => null);
    if (intro && interrupt && (interrupt.type === 'proposal' || interrupt.type === 'clarification')) {
      interrupt.intro = intro;
    }

    res.json({ threadId, interrupt });
  });

  // ── GET /api/builder/mentions ────────────────────────────────────────────────
  // Powers the @-mention autocomplete: active connected connectors + the other
  // users in the caller's tenant. Tenant-scoped and available to any member
  // (not admin-gated), unlike GET /users.
  app.get('/api/builder/mentions', requireActiveTenant, async (req, res) => {
    const tenantId = req.tenant.id;
    let users = [];
    try {
      users = (spine.auth.userStore.list(tenantId) || [])
        .filter(u => !u.disabled_at)
        .map(u => ({ id: u.id, name: u.display_name || u.email, email: u.email, kind: 'user' }));
    } catch { /* non-fatal */ }

    const connectors = [];
    try {
      if (isConnectorConnected(await spine.slack.resolveForTenant(tenantId))) {
        connectors.push({ id: 'slack', name: 'Slack', kind: 'connector' });
      }
    } catch { /* non-fatal */ }
    try {
      if (isConnectorConnected(await spine.google.resolveForTenant(tenantId, req.user?.id))) {
        connectors.push({ id: 'google', name: 'Google', kind: 'connector' });
      }
    } catch { /* non-fatal */ }
    try {
      const at = spine.airtable.resolveForTenant(tenantId);
      if (at.connected) connectors.push({ id: 'airtable', name: 'Airtable', kind: 'connector' });
    } catch { /* non-fatal */ }
    try {
      const web = webConnectionStatus();
      if (web.connected) connectors.push({ id: 'web', name: 'Web', kind: 'connector' });
    } catch { /* non-fatal */ }

    res.json({ connectors, users });
  });

  // ── POST /api/builder/sessions/:threadId/respond ─────────────────────────────
  // Send a response to the current interrupt.
  // Body: { type: 'accept'|'reject'|'modify'|'clarification'|'approve'|'request_changes', ... }
  // Returns: the next interrupt payload, or { type: 'done', spec, confirmationLog }
  app.post('/api/builder/sessions/:threadId/respond', requireActiveTenant, async (req, res) => {
    const { threadId } = req.params;
    if (!sessions.get(threadId)) return res.status(404).json({ error: 'session not found or already complete' });

    let result;
    try {
      // Serialize: a concurrent /respond for this thread waits for the in-flight one,
      // so two resumes can never race on the same graph checkpoint.
      result = await serializePerThread(threadId, async () => {
        const converger = sessions.get(threadId);
        if (!converger) { const e = new Error('session not found or already complete'); e._stale = true; throw e; }
        return converger.resume(threadId, req.body);
      });
    } catch (err) {
      // A stale/duplicate resume (the thread already advanced) is not a failure — the
      // real work was done by the resume that got there first. Return a benign no-op the
      // client ignores, and NEVER surface the raw `CompiledGraph.resume()…` text.
      if (err?._stale || isStaleResumeError(err)) {
        logEvent('respond.duplicate', { tenant: req.tenant?.id ?? null, threadId, sent: req.body?.type });
        return res.json({ type: 'noop', reason: 'already_handled' });
      }
      logEvent('respond.error', { tenant: req.tenant?.id ?? null, threadId, sent: req.body?.type, ...errFields(err) });
      // A genuine failure gets a plain, human message — not a stack trace in the chat.
      return res.status(500).json({ error: 'Atlas hit a snag finishing that step. Try again, or start over from “+ New workflow”.' });
    }

    logEvent('respond.ok', { tenant: req.tenant?.id ?? null, threadId, sent: req.body?.type, interrupt: result?.type });
    if (result?.type === 'done') sessions.delete(threadId);
    res.json(result);
  });

  // ── POST /api/builder/sessions/:threadId/setup ───────────────────────────────
  // Execute any registered capability as a one-off setup action during a converger
  // session. The converger proposes setup_action with a capabilityId from the live
  // catalog; the client confirms, calls this endpoint, then sends
  // { type:'setup_executed', result } to /respond.
  //
  // Token injection mirrors the workflow run path: Google→googleToken, Slack→token,
  // Airtable→airtableToken. Any capability in the CapabilityRegistry with a handle
  // can be used — no hardcoded action list needed.

  app.post('/api/builder/sessions/:threadId/setup', requireActiveTenant, async (req, res) => {
    const { capabilityId, params = {} } = req.body ?? {};
    try {
      if (!capabilityId) return res.status(400).json({ error: 'capabilityId is required' });

      const registry = spine.engine.capabilityRegistry;
      // Tolerant id resolution (S8-4): the converger sometimes proposes a capability's
      // MANIFEST id (e.g. "create_channel") while the registry holds the executable
      // CHANNEL id ("slack_create_channel"), or drops the connector prefix. Try the raw
      // id first, then the Slack namespace bridge, then connector-prefixed variants, then
      // a suffix match against the live registry — so "Create it now" actually runs.
      const candidates = [];
      const pushCand = (id) => { if (id && !candidates.includes(id)) candidates.push(id); };
      pushCand(capabilityId);
      pushCand(channelIdForCapability(capabilityId));           // slack manifest → channel id
      for (const p of ['slack', 'google', 'airtable']) pushCand(`${p}_${capabilityId}`);
      let resolvedId = candidates.find(id => registry.getHandler(id));
      if (!resolvedId) {
        const match = (registry.list() ?? []).find(c => c.id === capabilityId || c.id.endsWith(`_${capabilityId}`));
        if (match && registry.getHandler(match.id)) resolvedId = match.id;
      }
      const handler = resolvedId ? registry.getHandler(resolvedId) : null;
      if (!handler) return res.status(400).json({ error: `Capability not found: ${capabilityId}` });

      const cap    = registry.get(resolvedId);
      const config = await injectCapabilityCredentials(cap, { ...params }, { auth: spine.auth, tenant: req.tenant, user: req.user });

      const result = await handler({ config, body: null });
      logEvent('builder.setup.ok', { tenant: req.tenant.id, capabilityId, resolvedId });
      res.json({ result });
    } catch (err) {
      logEvent('builder.setup.error', { tenant: req.tenant?.id ?? null, capabilityId, ...errFields(err) });
      res.status(500).json({ error: err.message ?? String(err) });
    }
  });

  // ── DELETE /api/builder/sessions/:threadId ───────────────────────────────────
  app.delete('/api/builder/sessions/:threadId', requireActiveTenant, async (req, res) => {
    const { threadId } = req.params;
    const converger = sessions.get(threadId);
    if (converger) {
      try { await converger.abandon(threadId); } catch { /* ignore */ }
      sessions.delete(threadId);
    }
    res.json({ ok: true });
  });

  // ── GET /api/builder/home ─────────────────────────────────────────────────────
  // Personalized homepage data. Returns all 10 module payloads; frontend filters
  // by the user's saved homepageModules preference.
  // Returns: { ok, user, workflows, modules: { ai_greeting, workflow_health, ... } }
  app.get('/api/builder/home', requireActiveTenant, async (req, res) => {
    try {
      const store    = spine.engine.workflowStore;
      const userId   = req.user.id;
      const tenantId = req.tenant.id;
      const userName = req.user.display_name || req.user.email.split('@')[0];

      const wfs  = store.list({ userId, tenantId });
      const hour = new Date().getHours();
      const tod  = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

      // Flat index of every run (with owning-workflow context) — powers the
      // day/month/window aggregates below without re-querying.
      const runIndex = [];

      // Build enriched workflow objects once — shared across modules.
      const workflows = wfs.map(wf => {
        // 500 (not 20) so run counts and time-saved aren't undercounted for
        // high-volume workflows; matches the ROI report's window.
        const runs = store.getRuns(wf.id, 500, { userId, tenantId }) || [];
        const ok   = runs.filter(r => r.status === 'success').length;
        const fail = runs.filter(r => r.status === 'error').length;
        const last = runs[0] ?? null;
        const trg  = (wf.triggers || [])[0] ?? null;
        const baseline = wf.baseline_duration_s ?? 0;
        for (const r of runs) {
          runIndex.push({
            wfId: wf.id, wfName: wf.name || wf.user_intent || 'Untitled',
            triggers: wf.triggers || [], baseline,
            status: r.status, is_test: r.is_test,
            started_at: r.started_at, completed_at: r.completed_at,
            time_saved_minutes: r.time_saved_minutes,
          });
        }
        return {
          id: wf.id, name: wf.name || wf.user_intent || 'Untitled',
          status: wf.status,
          trigger: trg?.label || trg?.type || 'manual',
          triggerType: trg?.type || 'manual',
          schedule: trg?.schedule || trg?.cron || null,
          runCount: runs.length, successCount: ok, failCount: fail,
          // Unified time-saved: real successful runs only, measured-or-estimated
          // per run (see time-saved.js). Home total === ROI total === sum(Profile).
          savedMinutes: sumTimeSavedMinutes(runs, wf.baseline_duration_s ?? 0),
          lastRunAt: last?.started_at ?? null,
          lastRunStatus: last?.status ?? null,
          lastError: last?.error ?? null,
          recentRuns: runs.slice(0, 5),
        };
      });

      const totalRuns = workflows.reduce((s, w) => s + w.runCount, 0);
      const totalOk   = workflows.reduce((s, w) => s + w.successCount, 0);
      const activeWfs = workflows.filter(w => w.status === 'active');
      const pausedWfs = workflows.filter(w => w.status === 'paused');
      const failedWfs = workflows.filter(w => w.lastRunStatus === 'error');

      // ── LLM helper for fast home module calls ───────────────────────────
      const llm = spine.llm;
      const homeSessionId = `home-${req.user?.id ?? 'anon'}-${Date.now()}`;
      spine.costTracker?.setSessionUser?.(homeSessionId, req.user?.id);
      const llmJson = async (prompt) => {
        if (!llm?.invoke) return null;
        const raw = await llm.invoke(
          [new SystemMessage('You are Atlas. Return only valid JSON — no markdown, no extra text.'), new HumanMessage(prompt)],
          { configurable: { modelTier: 'fast', sessionId: homeSessionId, costContext: 'chat.home' } },
        ).catch(() => null);
        const text = (typeof raw === 'string' ? raw : raw?.content ?? '').trim();
        try {
          const j = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? text.match(/\{[\s\S]*\}/)?.[0] ?? text;
          return JSON.parse(j);
        } catch { return null; }
      };

      // ── Compute all modules in parallel where possible ───────────────────
      const wfLines = workflows.length
        ? workflows.map(w => `  - "${promptSafe(w.name)}" [${w.status}] trigger:${promptSafe(w.trigger, 40)} runs:${w.runCount} failures:${w.failCount}${w.lastRunAt ? ' last:' + new Date(w.lastRunAt).toLocaleDateString() : ''}`).join('\n')
        : '  (no workflows yet)';

      const [greetingData, tipData, alertData] = await Promise.all([
        // ai_greeting
        llmJson(
          `User: ${userName}, good ${tod}\nActive: ${activeWfs.length}, total runs: ${totalRuns}, failed last runs: ${failedWfs.length}\nWorkflows:\n${wfLines}\n\nReturn JSON:\n{"greeting":"<warm personal greeting, 1 sentence, reference something specific about their automations>","headline":"<1 compelling observation about their automation activity>"}`
        ),
        // ai_tip
        workflows.length
          ? llmJson(`User ${userName} has these workflows:\n${wfLines}\n\nReturn JSON with one actionable tip to improve their automation setup:\n{"tip":"<1-2 sentence specific, actionable suggestion>"}\n\nRULES: base the tip ONLY on facts visible in the list above (names, status, trigger, run and failure counts). Do NOT invent claims about resource usage, cost, or system load — a paused workflow does not run and consumes nothing. If nothing clearly needs improving, give a genuinely useful optimization or next-step idea grounded in what they have.`)
          : Promise.resolve(null),
        // failure_alerts
        failedWfs.length
          ? llmJson(`These workflows last ran with errors:\n${failedWfs.map(w => `  - "${promptSafe(w.name)}": ${promptSafe(w.lastError || 'unknown error', 160)}`).join('\n')}\n\nReturn JSON:\n{"summary":"<1-2 sentence overview of the failures and a suggested next step>"}`)
          : Promise.resolve(null),
      ]);

      // ── Collect recent activity across all workflows ──────────────────────
      const allRuns = workflows.flatMap(w =>
        w.recentRuns.map(r => ({ workflowName: w.name, workflowId: w.id, status: r.status, at: r.started_at }))
      ).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);

      // ── Assemble module payloads ──────────────────────────────────────────
      const successRate = totalRuns > 0 ? Math.round((totalOk / totalRuns) * 100) : null;
      // Unified, honest estimate: sum of per-run saved minutes across real
      // successful runs (test + failed runs no longer inflate it).
      const timeSavedMins = Math.round(workflows.reduce((s, w) => s + w.savedMinutes, 0));

      // ── Data-layout metrics (all derived from runIndex — no fabrication) ────
      const now      = Date.now();
      const doneRuns = runIndex.filter(isDoneRun);
      const savedFor = (r) => timeSavedMinutesForRun(r, r.baseline ?? 0);

      // Failed run attempts (distinct from workflow_health.failed = broken workflows).
      const failedRuns = doneRuns.filter(r => r.status === 'error').length;

      // Retries (heuristic — no retry column exists): an error run of a workflow
      // immediately followed by another run of the SAME workflow within 15 min,
      // which is how the scheduler's retry wrapper produces back-to-back rows.
      const RETRY_WINDOW_MS = 15 * 60 * 1000;
      let retries = 0;
      {
        const byWf = new Map();
        for (const r of doneRuns) {
          if (!byWf.has(r.wfId)) byWf.set(r.wfId, []);
          byWf.get(r.wfId).push(r);
        }
        for (const list of byWf.values()) {
          const asc = [...list].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));
          for (let i = 0; i < asc.length; i++) {
            if (asc[i].status !== 'error' || !asc[i].completed_at) continue;
            const next = asc[i + 1];
            if (next && (new Date(next.started_at) - new Date(asc[i].completed_at)) <= RETRY_WINDOW_MS) retries++;
          }
        }
      }

      // Health score: success ratio over the last 30 days, penalised for
      // currently-broken / overdue workflows. Trend = raw success-% delta vs the
      // prior 30-day window. Falls back to all-time success when 30d is empty.
      const overdueCount = ((store.getOverdue?.() ?? []).filter(w => w.tenant_id === tenantId && w.user_id === userId)).length;
      const cur30  = doneRuns.filter(r => (now - new Date(r.started_at)) <= 30 * DAY_MS);
      const prev30 = doneRuns.filter(r => { const age = now - new Date(r.started_at); return age > 30 * DAY_MS && age <= 60 * DAY_MS; });
      const curRaw = successPct(cur30) ?? successPct(doneRuns);
      let healthModule = null;
      if (curRaw !== null) {
        const penalised = Math.max(0, Math.min(100, curRaw - 8 * failedWfs.length - 5 * overdueCount));
        const prevRaw   = successPct(prev30);
        healthModule = {
          score: penalised,
          rating: healthRating(penalised),
          trend: prevRaw === null ? 0 : curRaw - prevRaw,
        };
      }

      // 7-day activity: per-day run count + hours saved (oldest → newest).
      const activity7d = [];
      for (let i = 6; i >= 0; i--) {
        const dayStart = startOfDay(new Date(now - i * DAY_MS)).getTime();
        const dayEnd   = dayStart + DAY_MS;
        const inDay    = doneRuns.filter(r => { const t = new Date(r.started_at).getTime(); return t >= dayStart && t < dayEnd; });
        activity7d.push({
          day:   dayLabel(new Date(dayStart)),
          runs:  inDay.length,
          hours: HRS(inDay.filter(isValueRun).reduce((s, r) => s + savedFor(r), 0)),
        });
      }

      // Performance trend: month-by-month (Jan → current month) of this year.
      const yearNow = new Date(now).getFullYear();
      const curMonth = new Date(now).getMonth();
      const months = [];
      let yearRuns = 0;
      for (let m = 0; m <= curMonth; m++) {
        const inMonth = doneRuns.filter(r => { const d = new Date(r.started_at); return d.getFullYear() === yearNow && d.getMonth() === m; });
        yearRuns += inMonth.length;
        months.push({ month: monthLabel(m), runs: inMonth.length, hours: HRS(inMonth.filter(isValueRun).reduce((s, r) => s + savedFor(r), 0)) });
      }
      const monthsElapsed = curMonth + 1;
      const performanceTrend = {
        months,
        avgRunsPerMonth: Math.round((yearRuns / monthsElapsed) * 10) / 10,
        totalThisYear: yearRuns,
      };

      // Time-saved this week + goal.
      const weekMinutes = doneRuns.filter(r => isValueRun(r) && (now - new Date(r.started_at)) <= 7 * DAY_MS)
        .reduce((s, r) => s + savedFor(r), 0);
      const prefs = spine.auth?.userStore?.getPreferences?.(userId, tenantId) ?? {};
      const goalMinutes = Number.isFinite(prefs.timeSavedGoalMinutes) ? prefs.timeSavedGoalMinutes : 600; // default 10 hrs

      // Recent runs, page 1 (+ total for the pager).
      const runsPage = store.getRunsPage({ tenantId, userId, limit: 5, offset: 0 });
      const recentRunsRows = runsPage.rows.map(r => ({
        workflowId: r.workflow_id,
        workflowName: r.wf_name || r.wf_user_intent || 'Untitled',
        trigger: triggerLabel(r.wf_triggers),
        status: r.status,
        at: r.started_at,
      }));

      const modules = {
        ai_greeting: greetingData ?? {
          greeting: `Good ${tod}, ${userName}.`,
          headline: activeWfs.length ? `${activeWfs.length} workflow${activeWfs.length !== 1 ? 's' : ''} running automatically.` : 'No workflows yet — build your first automation.',
        },
        workflow_health: {
          active: activeWfs.length,
          paused: pausedWfs.length,
          failed: failedWfs.length,
          total: workflows.length,
        },
        recent_activity: allRuns,
        success_rate: {
          rate: successRate !== null ? successRate + '%' : '—',
          totalRuns,
          successRuns: totalOk,
          failedRuns,
          retries,
        },
        top_workflows: [...workflows].sort((a, b) => b.runCount - a.runCount).slice(0, 5).map(w => ({
          id: w.id, name: w.name, runCount: w.runCount,
          successRate: w.runCount > 0 ? Math.round((w.successCount / w.runCount) * 100) + '%' : '—',
        })),
        quick_run: activeWfs.map(w => ({ id: w.id, name: w.name })),
        next_scheduled: workflows
          .filter(w => w.triggerType === 'schedule' || w.triggerType === 'cron')
          .map(w => ({ id: w.id, name: w.name, schedule: w.schedule || 'Scheduled', lastRunAt: w.lastRunAt })),
        failure_alerts: failedWfs.length
          ? { summary: alertData?.summary || `${failedWfs.length} workflow${failedWfs.length !== 1 ? 's' : ''} failed on the last run.`, workflows: failedWfs.map(w => ({ id: w.id, name: w.name })) }
          : null,
        // Scheduled workflows that missed their run beyond the grace window while
        // the scheduler was offline — surfaced so the owner can run now / defer.
        overdue: (() => {
          const od = (store.getOverdue?.() ?? [])
            .filter(w => w.tenant_id === tenantId && w.user_id === userId)
            .map(w => ({ id: w.id, name: w.name || w.user_intent || 'Untitled', schedule: (w.triggers?.[0]?.label) || (w.triggers?.[0]?.cron) || 'scheduled' }));
          return od.length ? { workflows: od } : null;
        })(),
        time_saved: {
          minutes: timeSavedMins,
          display: timeSavedMins >= 60
            ? (timeSavedMins / 60 < 10 ? (timeSavedMins / 60).toFixed(1) : Math.round(timeSavedMins / 60)) + ' hrs'
            : timeSavedMins + ' min',
          weekMinutes: Math.round(weekMinutes),
          weekDisplay: fmtDuration(weekMinutes),
          goalMinutes,
          goalDisplay: fmtDuration(goalMinutes),
        },
        ai_tip: tipData ?? { tip: 'Add more workflows to see personalized tips here.' },
        // ── Data-layout modules ──────────────────────────────────────────────
        health_score: healthModule,        // { score, rating, trend } | null
        activity_7d: activity7d,           // [{ day, runs, hours }] oldest→newest
        performance_trend: performanceTrend, // { months:[{month,runs,hours}], avgRunsPerMonth, totalThisYear }
        recent_runs: { rows: recentRunsRows, total: runsPage.total, offset: 0, limit: 5 },
      };

      logEvent('home.ok', { tenant: tenantId, wfCount: workflows.length });
      res.json({ ok: true, user: { name: userName, email: req.user.email }, workflows, modules });
    } catch (err) {
      logEvent('home.error', errFields(err));
      res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // ── GET /api/builder/home/runs ────────────────────────────────────────────
  // Paged "Recent runs" for the home Data table (Prev/Next). Scoped to tenant+user.
  app.get('/api/builder/home/runs', requireActiveTenant, (req, res) => {
    try {
      const store    = spine.engine.workflowStore;
      const userId   = req.user.id;
      const tenantId = req.tenant.id;
      const limit    = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 5));
      const offset   = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const page     = store.getRunsPage({ tenantId, userId, limit, offset });
      const rows = page.rows.map(r => ({
        workflowId: r.workflow_id,
        workflowName: r.wf_name || r.wf_user_intent || 'Untitled',
        trigger: triggerLabel(r.wf_triggers),
        status: r.status,
        at: r.started_at,
      }));
      res.json({ ok: true, rows, total: page.total, offset, limit });
    } catch (err) {
      logEvent('home.runs.error', errFields(err));
      res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // ── POST /api/builder/edit-change ────────────────────────────────────────────
  // Apply a natural-language change request to an existing workflow spec.
  // The LLM reads the live spec, applies the change, and returns the modified spec
  // plus a plain-language explanation of what it did. Bypasses the converger's
  // full proposal flow — used when editing a published workflow from the console.
  // Body:    { spec, change }
  // Returns: { ok, spec, explanation } | { ok: false, error }
  app.post('/api/builder/edit-change', requireActiveTenant, async (req, res) => {
    const { spec, change } = req.body ?? {};
    if (!spec?.nodes) return res.status(400).json({ error: 'spec with nodes[] is required' });
    if (!change?.trim()) return res.status(400).json({ error: 'change is required' });
    try {
      const llm = spine.llm;
      if (!llm?.invoke) return res.status(503).json({ error: 'LLM unavailable' });
      const editSessionId = `edit-change-${req.user?.id ?? 'anon'}-${Date.now()}`;
      spine.costTracker?.setSessionUser?.(editSessionId, req.user?.id);

      const specSummary = JSON.stringify(spec, null, 2);

      // Resolve per-tenant OAuth connection status so the model only sees
      // channels the tenant has actually connected (not just isReady() env vars).
      let editConnectedSet = null;
      try {
        const sl  = await spine.slack.resolveForTenant(req.tenant.id);
        const go  = await spine.google.resolveForTenant(req.tenant.id, req.user.id);
        const at  = spine.airtable.resolveForTenant(req.tenant.id);
        const web = webConnectionStatus();
        editConnectedSet = new Set();
        if (sl.connected)  editConnectedSet.add('slack');
        if (go.connected)  editConnectedSet.add('google');
        if (at.connected)  editConnectedSet.add('airtable');
        if (web.connected) editConnectedSet.add('web');
      } catch { /* non-fatal — fall back to isReady()-only filtering */ }

      const capCtx = editChangeCapabilityContext(spine.engine?.channelRegistry, spine.engine?.capabilityRegistry, editConnectedSet);

      const raw = await llm.invoke([
        new SystemMessage(
          `You are Atlas, a workflow automation assistant. You receive a workflow spec (JSON) and a user's change request and return an updated spec.\n\nWorkflow spec format:\n- triggers[]: array of trigger objects (type, config, label)\n- nodes[]: array of step objects (id, type, label, config). Types: summarize, llm, extract, rewrite, connector-action, deliver\n- edges[]: array of {from, to} connections\n\n${capCtx}\n\nRules:\n- Apply ONLY what the user asked for. Don't restructure unrelated parts.\n- Preserve all existing node ids, edge connections, and config fields not mentioned in the change.\n- To REMOVE a step: actually DELETE its object from nodes[] AND delete every edge that references its id. If it was in the middle of the chain, add an edge from its upstream node to its downstream node so the chain stays connected (e.g. removing "fetch" from search→fetch→summarize leaves search→summarize). Do NOT leave the node in place.\n- Data references between steps: the engine resolves ONLY {{prev}} and {{nodeId.output}}. NEVER use array indexing, wildcards, or field paths like {{node.results[*].id}} or {{node.field.sub}} — they are passed through literally and break at runtime. A connector-action runs once and cannot loop over a list; never add a step to "fetch each item".\n- For schedule triggers, config.cron is a cron expression (e.g. "0 6 * * *" = 6am daily), config.timezone is a tz name (e.g. "America/Chicago"), config.label is a human label.\n- For llm/summarize nodes, config.instructions is the prompt.\n- For deliver nodes, config.channel MUST be one of the AVAILABLE DELIVERY CHANNEL IDs — use the alias table to map plain-English requests to the right id. NEVER invent a channel id.\n- For connector-action nodes, config.action MUST be one of the AVAILABLE STEP ACTIONS.\n- If the user requests a delivery method or step action that is UNAVAILABLE or not listed, keep the relevant node UNCHANGED and explain specifically what connector or scope is needed to enable it.\n- Return ONLY valid JSON with exactly this shape: {"explanation":"<one sentence describing what you changed>","spec":{...updated spec...}}\n- No markdown fences, no extra text.`
        ),
        new HumanMessage(
          `Current spec:\n${specSummary}\n\nChange request: "${change}"\n\nReturn the updated spec as JSON.`
        ),
      ], { configurable: { modelTier: 'balanced', sessionId: editSessionId, costContext: 'chat.edit-change' } });

      const text = (typeof raw === 'string' ? raw : raw?.content ?? '').trim();
      let parsed = null;
      try {
        const jsonStr = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? text.match(/\{[\s\S]*\}/)?.[0] ?? text;
        parsed = JSON.parse(jsonStr);
      } catch {
        return res.status(500).json({ ok: false, error: 'LLM returned unparseable response.' });
      }

      if (!parsed.spec?.nodes) {
        return res.status(500).json({ ok: false, error: 'LLM did not return a valid spec.' });
      }

      // S7-10: structural safety net — if the model "removed" a step but left an
      // edge pointing at the now-missing node, drop those dangling edges so the
      // result is a runnable chain rather than a spec that fails on the next run.
      const ids = new Set((parsed.spec.nodes || []).map(n => n.id));
      if (Array.isArray(parsed.spec.edges)) {
        parsed.spec.edges = parsed.spec.edges.filter(e => e && ids.has(e.from) && ids.has(e.to));
      }

      logEvent('edit.change.ok', { tenant: req.tenant?.id ?? null });
      res.json({ ok: true, spec: parsed.spec, explanation: parsed.explanation ?? 'Done.' });
    } catch (err) {
      logEvent('edit.change.error', errFields(err));
      res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // ── POST /api/builder/edit-intro ─────────────────────────────────────────────
  // Generate a contextual LLM opener for the edit flow — reviews the live workflow
  // and returns a short natural message describing what it does + inviting changes.
  // Body: { workflow }   Returns: { message }
  app.post('/api/builder/edit-intro', requireActiveTenant, async (req, res) => {
    const { workflow } = req.body ?? {};
    if (!workflow) return res.status(400).json({ error: 'workflow is required' });
    try {
      const llm = spine.llm;
      if (!llm?.invoke) return res.status(503).json({ error: 'LLM unavailable' });
      const editIntroSessionId = `edit-intro-${req.user?.id ?? 'anon'}-${Date.now()}`;
      spine.costTracker?.setSessionUser?.(editIntroSessionId, req.user?.id);

      const name      = workflow.name || workflow.user_intent || 'this workflow';
      const trigger   = (workflow.triggers || []).map(tr => tr.label || tr.type).filter(Boolean).join(', ') || 'unknown trigger';
      const steps     = (workflow.nodes || []).map(n => n.label || n.type).filter(Boolean).join(' → ') || 'no steps configured';
      const status    = workflow.status || 'unknown';

      const raw = await llm.invoke([
        new SystemMessage('You are Atlas, a warm assistant helping non-technical operators manage their automations. Be concise, specific, and conversational — no lists, no bullet points.'),
        new HumanMessage(
          `You are reviewing a workflow the user wants to edit.\n\nName: "${name}"\nTrigger: ${trigger}\nSteps: ${steps}\nStatus: ${status}\n\nWrite ONE short message (2–3 sentences) that: briefly describes what this workflow does in plain language, then invites the user to tell you what to change, fix, or add. Be specific to THIS workflow — not generic. Do not start with "Sure", "Great", or similar filler.`
        ),
      ], { configurable: { modelTier: 'fast', sessionId: editIntroSessionId, costContext: 'chat.edit-intro' } });
      const message = (typeof raw === 'string' ? raw : raw?.content ?? '').trim();
      logEvent('edit.intro.ok', { tenant: req.tenant?.id ?? null, workflowId: workflow.id });
      res.json({ message: message || `I'm looking at ${name}. What would you like to change?` });
    } catch (err) {
      logEvent('edit.intro.error', errFields(err));
      res.status(500).json({ error: err.message ?? String(err) });
    }
  });

  // ── GET /api/builder/workflows/deleted ──────────────────────────────────────
  // List recently soft-deleted workflows (30-day recovery window).
  // Must be registered before /:id routes so Express doesn't treat "deleted" as an id.
  app.get('/api/builder/workflows/deleted', requireActiveTenant, (req, res) => {
    const store = spine.engine.workflowStore;
    const workflows = store.listDeleted({ userId: req.user.id, tenantId: req.tenant.id });
    const cutoffMs = 30 * 24 * 60 * 60 * 1000;
    const enriched = workflows.map(w => ({
      ...w,
      daysUntilPurge: Math.max(0, Math.ceil((new Date(w.deleted_at).getTime() + cutoffMs - Date.now()) / 86400000)),
    }));
    res.json({ ok: true, workflows: enriched });
  });

  // ── DELETE /api/builder/workflows/:id ────────────────────────────────────────
  // Soft-delete a workflow (sets deleted_at; recoverable for 30 days).
  app.delete('/api/builder/workflows/:id', requireActiveTenant, (req, res) => {
    const store = spine.engine.workflowStore;
    const ok = store.softDelete(req.params.id, { userId: req.user.id, tenantId: req.tenant.id });
    if (!ok) return res.status(404).json({ ok: false, error: 'Workflow not found' });
    logEvent('builder.delete.ok', { tenant: req.tenant?.id ?? null, workflowId: req.params.id });
    res.json({ ok: true });
  });

  // ── POST /api/builder/workflows/:id/restore ───────────────────────────────────
  // Restore a soft-deleted workflow within the 30-day window.
  app.post('/api/builder/workflows/:id/restore', requireActiveTenant, (req, res) => {
    const store = spine.engine.workflowStore;
    const ok = store.restore(req.params.id, { userId: req.user.id, tenantId: req.tenant.id });
    if (!ok) return res.status(404).json({ ok: false, error: 'Workflow not found or not deleted' });
    logEvent('builder.restore.ok', { tenant: req.tenant?.id ?? null, workflowId: req.params.id });
    res.json({ ok: true });
  });

  // ── PUT /api/builder/workflows/:id ───────────────────────────────────────────
  // Update an existing workflow with a revised spec from the builder.
  // Body: { spec, intent, testRun }
  // Returns: { ok, workflowId } or { ok: false, error }
  app.put('/api/builder/workflows/:id', requireActiveTenant, async (req, res) => {
    const { spec, intent, testRun } = req.body ?? {};
    const { id } = req.params;
    if (!spec?.nodes) return res.status(400).json({ error: 'spec with nodes[] is required' });

    const store = spine.engine.workflowStore;
    const existing = store.get(id, { userId: req.user.id });
    if (!existing || existing.tenant_id !== req.tenant.id) {
      return res.status(404).json({ ok: false, error: 'Workflow not found' });
    }

    let result;
    try {
      result = await spine.engine.workflowService.update(
        id,
        { name: spec.name ?? existing.name, description: spec.description, triggers: spec.triggers, nodes: spec.nodes, edges: spec.edges, errorHandling: spec.errorHandling },
        { userId: req.user.id },
      );
    } catch (err) {
      logEvent('builder.update.error', { tenant: req.tenant?.id ?? null, workflowId: id, ...errFields(err) });
      return res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }

    if (!result.ok) {
      logEvent('builder.update.invalid', { tenant: req.tenant?.id ?? null, workflowId: id, error: result.error });
      return res.status(400).json({ ok: false, error: result.error, issues: result.issues });
    }

    if (testRun && (testRun.status === 'success' || testRun.status === 'error')) {
      try {
        const store = spine.engine.workflowStore;
        const run = store.startRun(id, { isTest: true });
        for (const step of (testRun.steps || [])) store.appendStep(run.id, step);
        if (testRun.status === 'success') {
          store.completeRun(run.id, testRun.output ?? null, testRun.cost ?? null);
        } else {
          store.failRun(run.id, testRun.error || 'Test failed', testRun.cost ?? null);
        }
      } catch (e) { /* non-fatal */ }
    }

    // Activate draft workflows on first publish; also clear error status on re-publish.
    if (existing.status === 'draft' || existing.status === 'error') {
      store.update(id, { status: 'active' }, { userId: req.user.id });
      result.workflow.status = 'active';
    }

    logEvent('builder.update.ok', { tenant: req.tenant?.id ?? null, workflowId: id });
    res.json({ ok: true, workflowId: result.workflow.id, workflow: result.workflow });
  });

  // ── PATCH /api/builder/workflows/:id/status ─────────────────────────────────
  // Mark a workflow broken (error) or recover it (active). Used by the tester
  // to surface a red dot on a failed test run without requiring a re-publish.
  app.patch('/api/builder/workflows/:id/status', requireActiveTenant, (req, res) => {
    const { status } = req.body ?? {};
    if (!['error', 'active'].includes(status)) return res.status(400).json({ error: 'status must be error or active' });
    const store = spine.engine.workflowStore;
    const wf = store.get(req.params.id, { userId: req.user.id });
    if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });
    store.update(req.params.id, { status }, { userId: req.user.id });
    logEvent('builder.workflow.status', { tenant: req.tenant?.id ?? null, workflowId: req.params.id, status });
    res.json({ ok: true, status });
  });

  // ── PATCH /api/builder/workflows/:id/name ────────────────────────────────────
  // Rename a workflow without running the validator (works for drafts with no nodes too).
  app.patch('/api/builder/workflows/:id/name', requireActiveTenant, (req, res) => {
    const { name } = req.body ?? {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const store = spine.engine.workflowStore;
    const wf = store.get(req.params.id, { userId: req.user.id });
    if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });
    store.update(req.params.id, { name: String(name).trim() }, { userId: req.user.id });
    logEvent('builder.rename', { tenant: req.tenant?.id ?? null, workflowId: req.params.id });
    res.json({ ok: true });
  });

  // ── POST /api/builder/draft ──────────────────────────────────────────────────
  // Create a minimal empty draft so the sidebar entry persists immediately.
  // Bypasses the validator (empty nodes would fail EMPTY_WORKFLOW check).
  app.post('/api/builder/draft', requireActiveTenant, (req, res) => {
    try {
      const store = spine.engine.workflowStore;
      const wf = store.create({
        name: 'New workflow', slug: `new-workflow-${Date.now().toString(36)}`,
        nodes: [], edges: [], triggers: [],
        userIntent: 'New workflow', status: 'draft', kind: 'flow',
        userId: req.user.id, tenantId: req.tenant.id,
      });
      logEvent('builder.draft.create', { tenant: req.tenant?.id ?? null, workflowId: wf.id });
      res.json({ ok: true, workflowId: wf.id });
    } catch (err) {
      logEvent('builder.draft.error', { tenant: req.tenant?.id ?? null, ...errFields(err) });
      res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // ── PUT /api/builder/workflows/:id/draft ─────────────────────────────────────
  // Autosave an in-progress draft spec server-side (Q23) so unpublished work is
  // recoverable across devices — NOT validated and NOT activated (status stays
  // 'draft'). Only touches draft rows so it can never clobber a live workflow.
  app.put('/api/builder/workflows/:id/draft', requireActiveTenant, (req, res) => {
    try {
      const { spec } = req.body ?? {};
      const store = spine.engine.workflowStore;
      const existing = store.get(req.params.id, { userId: req.user.id });
      if (!existing || existing.tenant_id !== req.tenant.id) return res.status(404).json({ ok: false, error: 'Not found' });
      if (existing.status !== 'draft') return res.status(409).json({ ok: false, error: 'Not a draft' });
      const patch = {};
      if (spec && typeof spec === 'object') {
        if (typeof spec.name === 'string' && spec.name) patch.name = spec.name;
        if (typeof spec.description === 'string')       patch.description = spec.description;
        if (Array.isArray(spec.nodes))                  patch.nodes = spec.nodes;
        if (Array.isArray(spec.edges))                  patch.edges = spec.edges;
        if (Array.isArray(spec.triggers))               patch.triggers = spec.triggers;
      }
      if (Object.keys(patch).length) store.update(req.params.id, patch, { userId: req.user.id, snapshot: false });
      res.json({ ok: true });
    } catch (err) {
      logEvent('builder.draft.save.error', { tenant: req.tenant?.id ?? null, workflowId: req.params.id, ...errFields(err) });
      res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // ── POST /api/builder/workflows ──────────────────────────────────────────────
  // Persist and activate a converger-emitted spec as a real workflow.
  // Body: { spec, intent }
  // Returns: { ok, workflowId } or { ok: false, error }
  app.post('/api/builder/workflows', requireActiveTenant, async (req, res) => {
    const { spec, intent, testRun } = req.body ?? {};
    if (!spec?.nodes) return res.status(400).json({ error: 'spec with nodes[] is required' });

    // ── activeWorkflows gate — the loud adoption constraint ──────────────────
    // Only PUBLISHED (active) workflows count; drafts are unlimited. This route
    // always creates a NEW workflow (edits go through PUT), so being at the cap
    // blocks the next publish. Existing live workflows keep running untouched.
    const ent = entitlementsFor(spine.auth.tenantStore, req.tenant.id);
    const wfLimit = ent.activeWorkflows;
    if (wfLimit !== Infinity && spine.engine.workflowStore.countActiveForTenant(req.tenant.id) >= wfLimit) {
      const planLabel = PLAN_META[ent.plan]?.label ?? ent.plan;
      logEvent('persist.plan_limit', { tenant: req.tenant.id, feature: 'activeWorkflows', plan: ent.plan });
      return res.status(402).json({
        ok: false, code: 'PLAN_LIMIT', feature: 'activeWorkflows', plan: ent.plan, upgradeTo: nextPlan(ent.plan),
        error: wfLimit === 1
          ? `Your ${planLabel} plan runs 1 live automation at a time. Upgrade to run more in parallel.`
          : `Your ${planLabel} plan includes ${wfLimit} live automations. Upgrade to publish more.`,
      });
    }

    let result;
    try {
      result = await spine.engine.workflowService.create(
        { ...spec, userIntent: intent ?? spec.name, status: 'active' },
        { userId: req.user.id, tenantId: req.tenant.id },
      );
    } catch (err) {
      logEvent('persist.error', { tenant: req.tenant?.id ?? null, ...errFields(err) });
      return res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }

    if (!result.ok) {
      logEvent('persist.invalid', { tenant: req.tenant?.id ?? null, error: result.error, issues: (result.issues ?? []).map(i => i.code) });
      return res.status(400).json({ ok: false, error: result.error, issues: result.issues });
    }

    // A build costs BUILD_RUN_COST runs from the monthly allowance. The converger
    // is ~21 LLM turns (about the price of one worst-case run), and until now it
    // was metered by nothing at all — a tenant could burn far more than their
    // subscription building workflows without ever touching a run cap.
    //
    // Charged only on a SUCCESSFUL publish, and never blocks: the workflow already
    // exists at this point, so failing here would take the user's money-equivalent
    // and give them nothing. Over-cap simply means their next RUN is refused by the
    // scheduler's budget check, which is the correct place to say no.
    try {
      spine.engine.workflowStore.chargeRunUnits(req.tenant.id, BUILD_RUN_COST);
      logEvent('persist.build_charged', { tenant: req.tenant.id, units: BUILD_RUN_COST });
    } catch (e) {
      // Never fail a publish over the meter.
      logEvent('persist.build_charge_failed', { tenant: req.tenant?.id ?? null, error: String(e?.message ?? e) });
    }

    // Retroactively log the builder test run under the new workflowId.
    if (testRun && (testRun.status === 'success' || testRun.status === 'error')) {
      try {
        const store = spine.engine.workflowStore;
        // R8: backdate the run's start by the real test duration the builder measured,
        // so run history shows the true elapsed time instead of the ~1ms write gap.
        const durMs = Number(testRun.durationMs) > 0 ? Number(testRun.durationMs) : 0;
        const startedAt = durMs ? new Date(Date.now() - durMs).toISOString() : null;
        const run = store.startRun(result.workflow.id, { isTest: true, startedAt });
        for (const step of (testRun.steps || [])) store.appendStep(run.id, step);
        if (testRun.status === 'success') {
          store.completeRun(run.id, testRun.output ?? null, testRun.cost ?? null);
        } else {
          store.failRun(run.id, testRun.error || 'Test failed', testRun.cost ?? null);
        }
      } catch (e) { /* non-fatal — run logged best-effort */ }
    }

    logEvent('persist.ok', { tenant: req.tenant?.id ?? null, workflowId: result.workflow.id, slug: result.workflow.slug });
    res.json({ ok: true, workflowId: result.workflow.id, workflow: result.workflow });
  });
}
