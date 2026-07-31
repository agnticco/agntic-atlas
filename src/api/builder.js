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
import { isOpaqueProviderId } from '../workflows/outcome-oracle.js';
import { mailerConfigured } from '../utils/mailer.js';
import { getGoogleAccessToken } from '../connectors/google/index.js';
import { getSlackToken } from '../connectors/slack/oauth.js';
import { getAirtableAccessToken } from '../connectors/airtable/oauth.js';
import {
  syncAirtableWebhooksForTenant, isAirtableRecordChangedTrigger, checkAirtableTriggersArmable,
} from '../connectors/airtable/webhook-sync.js';
// Refuses a publish whose trigger nothing could ever run. Must be checked BEFORE
// the connector-specific arming checks — see that module's header for why.
import { checkTriggersRunnable } from '../workflows/trigger-runnable.js';
import { sumTimeSavedMinutes, timeSavedMinutesForRun, isValueRun, isLiveRun } from '../workflows/time-saved.js';
// The test-run sentence is COMPOSED from the run's evidence, never written by a
// model. See the module header, and POST /api/builder/test-summary below.
import { composeRunSummary } from '../workflows/run-summary.js';
import { APP_VERSION } from '../version.js';
import { notesSince } from '../release-notes.js';
import { sendMail } from '../utils/mailer.js';
import { renderInviteEmail } from '../auth/invite-email.js';
import { oauthRedirectBase } from '../connectors/oauth-redirect.js';
import { seatLimit, entitlement, entitlementsFor, nextPlan, PLAN_META, BUILD_RUN_COST, PUBLIC_PLANS, isSelfServe } from '../entitlements/index.js';
import { isBillingConfigured } from '../billing/stripe.js';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
// Drips whitespace so a >100s build isn't cut by the proxy (524). See the module.
import { keepAlive } from './keep-alive.js';
// Deterministic backstop: strips invented Atlas navigation out of a chat reply
// before the user can act on it. See the module for why the prompt rule alone
// is not enough.
import { scrubInventedNavigation } from './chat-navigation-guard.js';
// Stops Atlas offering an output the workflow has no instruction to produce.
import { unbackedArtifacts, artifactCorrectionFor } from './chat-artifact-guard.js';

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

// ── BUILDS RUN IN THE BACKGROUND ─────────────────────────────────────────────
// A build used to BE an HTTP request: the client POSTed and the connection stayed
// open for however long the graph took — minutes on a real workflow. Everything
// about that was fragile. A closed tab, a refresh, a phone locking, a flaky
// connection or a deploy took the build with it, and the proxy had to be placated
// with a whitespace drip (keepAlive) purely to stop it cutting a healthy request.
//
// Now the request only STARTS the work. The graph runs detached, its progress is
// recorded here, and the client polls. The build no longer belongs to a socket.
//
// Paired with session rehydration, the durability story is: the graph's own state is
// on disk, so a build survives the process; this map is only "what is happening right
// now", and losing it costs a poll that says `unknown`, not the build.
const buildIntro = new Map();      // threadId → the conversational opener, attached to the first question
const builds = new Map();          // threadId → { status, value, error, startedAt, updatedAt }
const BUILD_TTL_MS = 60 * 60 * 1000;

function sweepBuilds() {
  const cutoff = Date.now() - BUILD_TTL_MS;
  for (const [k, v] of builds) if ((v.updatedAt ?? 0) < cutoff) builds.delete(k);
}

/**
 * Run `fn` detached and record where it got to. Returns immediately.
 *
 * A rejection is CAPTURED, never left to the process: an unhandled rejection in a
 * detached build would take the whole server down and every other tenant's work with
 * it — the one failure mode that is strictly worse than the long request this
 * replaces. A GraphInterrupt is not an error; it is the build asking a question, and
 * it is recorded as the thing to show the user.
 */
function startBuildJob(threadId, fn) {
  sweepBuilds();
  builds.set(threadId, { status: 'running', value: null, error: null, startedAt: Date.now(), updatedAt: Date.now() });
  Promise.resolve()
    .then(fn)
    .then(
      (value) => builds.set(threadId, { status: 'ready', value, error: null, startedAt: builds.get(threadId)?.startedAt ?? Date.now(), updatedAt: Date.now() }),
      (err) => {
        const interrupt = (err instanceof GraphInterrupt || err?.interruptValue) ? (err.interruptValue ?? err) : null;
        if (interrupt) {
          builds.set(threadId, { status: 'ready', value: interrupt, error: null, startedAt: builds.get(threadId)?.startedAt ?? Date.now(), updatedAt: Date.now() });
          return;
        }
        logEvent('builder.job_failed', { threadId, ...errFields(err) });
        builds.set(threadId, { status: 'error', value: null, error: String(err?.message ?? err), startedAt: builds.get(threadId)?.startedAt ?? Date.now(), updatedAt: Date.now() });
      },
    );
}

// threadId → the DRAFT workflow row this build belongs to. Lets the server persist
// a finished build the moment it exists, instead of waiting for the browser to
// acknowledge it — see the autosave in /respond.
const sessionDraft = new Map();

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

// ── Reasoning beat hub (Increment #22) ───────────────────────────────────────
// The converger is a reasoning agent; the right-panel REASONING surface streams
// the *why* behind each step as it builds. The build itself runs synchronously
// inside POST /sessions and each /respond — this is a SEPARATE, purely additive
// side-channel. `narrate(threadId, beat)` pushes a short beat onto the session's
// buffer and emits it live; GET .../reasoning replays the buffer then streams new
// beats over SSE. If nobody subscribes (or the EventSource errors), the build is
// byte-for-byte unchanged: beats are just free server strings dropped on the floor.
//
// Keyed strictly by threadId, and each hub records the OWNING tenant/user so the
// SSE endpoint can prove the caller owns the stream — one session's beats can
// never leak into another's (or another tenant's).
const reasoningHubs = new Map();          // threadId → { emitter, buffer, seq, tenantId, userId }
// Retained for a late/reconnecting subscriber's replay. Sized to hold a whole
// extended-thinking stream (the ~3072-token thinking budget arrives as up to
// ~1.5k word-level deltas), so a build that runs `generate` INSIDE the initial
// POST /sessions pass — before the client's EventSource connects — still replays
// the full chain of thought rather than only its tail. The live path (stream
// opened before generate runs) never depends on the buffer.
const REASONING_BUFFER_CAP = 2000;
// 'thinking' carries the model's RAW reasoning tokens (streamed live during
// `generate`); the rest are discrete human-legible status beats.
// 'node' carries a STRUCTURED node (id/type/label/mode) as the converger WRITES the
// spec, for the live in-chat graph build — it has no `text`, so narrate() handles it
// on its own path below rather than through the text normaliser.
const BEAT_KINDS = new Set(['read', 'wire', 'fix', 'check', 'prose', 'thinking', 'node']);

function openReasoningHub(threadId, { tenantId = null, userId = null } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);             // a reconnecting EventSource re-subscribes; never warn
  const hub = { emitter, buffer: [], seq: 0, tenantId, userId };
  reasoningHubs.set(threadId, hub);
  return hub;
}

// Push a beat. Normalizes to the closed shape { kind, text, detail? } (+ an internal
// _seq for SSE Last-Event-ID dedupe on reconnect). Best-effort: never throws into the
// graph, and silently no-ops when the session has no hub (build with no listener wired).
function narrate(threadId, beat) {
  const hub = reasoningHubs.get(threadId);
  if (!hub || !beat) return;
  const kind = BEAT_KINDS.has(beat.kind) ? beat.kind : 'read';

  // A 'node' beat is structured (the live build), not text. Buffer + emit it directly.
  if (kind === 'node') {
    if (!beat.node || !beat.node.id) return;
    const b = { kind, node: beat.node };
    if (beat.streamId != null) b.streamId = String(beat.streamId);
    b._seq = ++hub.seq;
    hub.buffer.push(b);
    if (hub.buffer.length > REASONING_BUFFER_CAP) hub.buffer.splice(0, hub.buffer.length - REASONING_BUFFER_CAP);
    try { hub.emitter.emit('beat', b); } catch { /* no subscriber */ }
    return;
  }

  const raw  = typeof beat.text === 'string' ? beat.text : '';
  // A 'thinking' delta is a RAW model token — whitespace between words is meaningful,
  // so we must NOT trim it, and drop only a truly empty string. Discrete status beats
  // are human-authored lines: trim and drop-if-blank as before.
  const text = kind === 'thinking' ? raw : raw.trim();
  if (!text) return;
  const b = { kind, text };
  if (beat.detail != null && String(beat.detail).trim()) b.detail = String(beat.detail).trim();
  // A thinking delta carries its stream's id so the client keeps one generation's
  // thinking in its own growing block (a revise-rebuild starts a fresh one).
  if (kind === 'thinking' && beat.streamId != null) b.streamId = String(beat.streamId);
  b._seq = ++hub.seq;
  hub.buffer.push(b);
  if (hub.buffer.length > REASONING_BUFFER_CAP) {
    hub.buffer.splice(0, hub.buffer.length - REASONING_BUFFER_CAP);
  }
  try { hub.emitter.emit('beat', b); } catch { /* no subscriber */ }
}

// The client-facing SSE payload for a buffered beat: the closed public shape, with
// the internal _seq stripped (it rides the SSE `id:` line, not the data) and streamId
// carried only when present (thinking beats).
function beatPayload(b) {
  return {
    kind: b.kind,
    ...(b.text != null ? { text: b.text } : {}),
    ...(b.node ? { node: b.node } : {}),
    ...(b.detail ? { detail: b.detail } : {}),
    ...(b.streamId ? { streamId: b.streamId } : {}),
  };
}

// Assemble a build's CHAIN OF THOUGHT from its reasoning buffer, for persistence with
// the workflow (operator 2026-07-16) — the permanent "how this was decided" record.
// `text` is the joined raw thinking a human reads; `beats` keeps the structured record
// (thinking + node + status) for provenance. Returns null when there is nothing to store
// (no hub, or the buffer was empty). Best-effort: never throws into the publish path.
function reasoningTranscript(threadId) {
  try {
    const hub = reasoningHubs.get(threadId);
    if (!hub || !Array.isArray(hub.buffer) || !hub.buffer.length) return null;
    const beats = hub.buffer.map((b) => beatPayload(b));
    const text = beats.filter((b) => b.kind === 'thinking').map((b) => b.text || '').join('').trim();
    if (!text && !beats.length) return null;
    return { text, beats, capturedAt: new Date().toISOString() };
  } catch { return null; }
}

// End the stream and free the entry. Called wherever a session is deleted, so a hub
// never outlives its session. Signals subscribers to close (so their EventSource does
// not retry-storm a dead thread).
function closeReasoningHub(threadId) {
  const hub = reasoningHubs.get(threadId);
  if (!hub) return;
  try { hub.emitter.emit('end'); } catch { /* ignore */ }
  reasoningHubs.delete(threadId);
}

// Exported for unit tests (the hub is server-internal; these are the primitives).
export { reasoningHubs, openReasoningHub, narrate, closeReasoningHub, REASONING_BUFFER_CAP };
// `buildChatSystem` is exported for the same reason: the rule that a build OFFER must
// carry the Build it button lives only in prompt text, so the only pin available for it
// is an assertion on that text (same idiom as tests/converger/plan-grounding-prompt.test.js).
export { buildChatSystem };

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
- MAILBOX / SOURCE GROUNDING: only promise to read a source that is actually CONNECTED. An email workflow reads the ONE Gmail account this workspace has connected — it cannot open a different mailbox. If the user names another address (support@…, sales@…, a shared mailbox or group) that isn't the connected account, do NOT say you'll "read support@…" or "watch that inbox". Either treat it as a filter on the connected inbox and say so plainly ("I'll watch your connected inbox for mail addressed to support@… — that works if support@ forwards there"), or, if it's a separate mailbox, name the gap: "That looks like a separate mailbox — the workflow reads the Gmail account you've connected. Does support@ forward into it?" Never claim to read, access, or monitor a source that isn't a connected connector; when unsure, ask.
- ATLAS'S OWN SCREENS — NEVER DESCRIBE THEM FROM MEMORY. You do not have this interface in front of you. Any screen, settings page, menu, tab, section or setup procedure you describe from your own knowledge is invented, and it sends a non-technical user hunting for something that does not exist. There is exactly ONE place in Atlas you are allowed to name: Connections, in the left sidebar. When someone asks how to connect a service, say "open Connections in the left sidebar" — and STOP. Do NOT describe what is inside it, do NOT name a section, heading, tab or button within it, and do NOT invent a "workspace settings" screen, an "Integrations" or "Connectors" section, or a "Settings → …" path: none of those exist here. If a service is not in the connectors list above, say plainly that Atlas cannot connect to it yet, offer whatever genuinely workable alternatives you can (forwarding the content in, pasting it into the chat, a connected app that gets close) — that part is useful, keep doing it — and point at the same one place, Connections in the left sidebar. If you do not know where something lives in Atlas, say you are not sure and point at Connections; never guess, and never name a second screen.
- SLACK CHANNELS: your job is to understand and REWRITE the intent, not to resolve resources. Do NOT interrogate whether a named Slack channel exists or ask "should I create it or pick another?" — you don't have the live channel list, and after the spec is built the builder verifies every channel against the real account and offers, with buttons, to create the missing one or pick an existing one. Just carry the channel the user named through into build_intent; the deterministic step owns the create/pick question. (This is only about channel existence — keep asking your legitimate clarifying questions about the inbox/source, trigger, and destination.)
- ready_to_build:true is WHAT PUTS THE "Build it" BUTTON ON THE SCREEN. It is not a claim that the user already agreed and it does not skip their consent — they still press the button, then review and approve every step. It is simply what makes your offer something they can ACT on.
- So set ready_to_build:true in BOTH of these cases, and write build_intent for both — one clear paragraph covering trigger + steps + destination, folding in everything discussed:
  (a) the user clearly signals they want to build ("let's do it", "set it up", "yes, build it", "go ahead"); or
  (b) YOU are the one offering, because you now have enough to describe the whole thing ("Want me to set this up?").
- NEVER make a build offer while holding ready_to_build:false. An offer with no button is a dead end: the user has read "Want me to set this up?", has nothing to press, and has to guess the exact words that unlock it. The offer and the button are ONE act — if you are offering, the button ships with the offer.
- ready_to_build stays false while you are still working it out — you are asking about the trigger, the processing or the destination, or the user is just chatting. In that case do NOT offer to build in the same breath: ask your next single question and leave the flag false.

BUILD A WORKFLOW vs DO ONE THING NOW — decide this FIRST, and get it right:
- A TRIGGER or RECURRING phrase — "when/whenever a … arrives", "every morning/day/week", "each new …",
  "for everyone on …", "automatically" — is ALWAYS a WORKFLOW, no matter how the sentence ends.
  "When a new email arrives, summarize it … build it now" is a WORKFLOW; "build it now" / "set it up now"
  means BUILD THE WORKFLOW now, NOT perform an action now. Set ready_to_build:true with a build_intent and
  call NO tools.
- DO NOT INVENT UNITS THE USER DID NOT GIVE. If they say "over 50000", write "over 50,000" — never "£50,000"
  and never "$50,000". A currency symbol you chose is a detail they never stated, and they will read it back
  as a decision they made. (Seen live: the same threshold rendered as £ in the chat and $ in the plan, from
  one user message that contained no currency at all.) The same goes for time zones, date formats and any
  other unit — carry the user's own wording through unchanged, and ask once if the unit genuinely matters.
- THERE IS NO TOOL THAT CREATES A WORKFLOW. Building happens ONLY via ready_to_build:true. So if you are
  about to call a delivery/action tool (inbox, email, Slack, a record) to "set up", "start", "turn on",
  or "test" a recurring workflow — STOP: that is the wrong path. Set ready_to_build instead.
- NEVER claim a workflow is "built", "running", "live", "set up", "on", or "being built" from the chat —
  not even "on it, building now" or "once it's running". Building has NOT started and does not start from
  your message. After you set ready_to_build:true the user still has to click "Build it", then review and
  approve the workflow step by step, then test it, before anything goes live. So on the turn you set
  ready_to_build:true, your reply MUST NOT imply building is underway or done ("On it! Building now…",
  "You'll get a confirmation once it's running", a 🎉) — that claims a state that does not exist and the
  user will act on it. Instead, say plainly that they can hit Build it and you'll put it together and walk
  them through it before it goes live. Describe WHAT it will do, never that it IS happening.
- Only a genuinely ONE-OFF request for a single thing right now ("email Bob this note", "DM me today's
  summary", "what's on my calendar?") is a direct action.
- Don't do both in one turn: a build turn calls NO action tools; an action turn does not set ready_to_build.

DIRECT ACTIONS — you have tools for each connected service.
- READ-ONLY tools (search/list/read/get — calendar, drive, sheets, email search, web) you may call freely to answer a question or gather context.
- OUTWARD-FACING actions (sending an email, posting to Slack, creating or updating a record) are NEVER performed silently. When you call such a tool it is HELD for the user's confirmation and NOT executed — the user gets a Confirm button. So: describe plainly what you propose to do (who it goes to, the subject, the gist), then STOP and let them confirm. NEVER say you sent / posted / created something unless a tool result actually confirms it ran — a "NOT_PERFORMED" result means it is waiting on the user.
- Do NOT use tools speculatively or when the user is just exploring.
- IMPORTANT: building a workflow is NOT a direct action and has NO tool. When the user says "build it" / "set it up" / "go ahead", do NOT call any tool — set ready_to_build:true with a build_intent.
${connectorBlock}

OUTPUT FORMAT — every response MUST be valid JSON, no exceptions, no markdown fences:
{"reply":"<your message to the user>","ready_to_build":false,"build_intent":null}
Everything you want to say goes in "reply". Nothing goes outside the JSON object.

NEVER put a plain double-quote character inside the "reply" text. To quote a word, a subject line or a
phrase the user typed, use SINGLE quotes: 'ATLASGATE', 'APPROVED'. An unescaped double-quote ends the
JSON string early — the rest of your message is DISCARDED mid-sentence and the reply cannot be read at
all. This is the single most common way a reply is lost, and it happens exactly when you quote the
user's own words back to them.`;
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
// An id-level fallback signal for a mutating/outward-facing capability, for the
// rare case a write action is registered `step`-only (e.g. drive_create_folder,
// gmail_mark_read). Word-boundaried so "address" ≠ "add".
const CHAT_WRITE_VERB = /(?:^|_)(create|update|delete|remove|append|write|add|send|post|move|mark|archive|invite|share|reply|upload)(?:_|$)/i;

/**
 * Is this chat tool OUTWARD-FACING / side-effecting — i.e. does calling it change
 * something outside Atlas (send an email, post to Slack, write/create a record)?
 * Such actions are NEVER performed silently from chat; they are captured and held
 * for the user's explicit confirmation (see the executor gate below).
 *
 * FAIL-CLOSED: an unknown capability is treated as side-effecting. Under-gating a
 * send is the dangerous direction; over-confirming a harmless read is merely a
 * click. A `delivery` position is the authoritative "this sends" signal; the verb
 * regex catches the few write actions registered step-only.
 */
function isSideEffectingChatTool(cap) {
  if (!cap) return true;
  if (Array.isArray(cap.positions) && cap.positions.includes('delivery')) return true;
  return CHAT_WRITE_VERB.test(cap.id || '');
}

// Build the human-facing confirmation line for a pending action.
/**
 * The one line a person reads before approving an action Atlas wants to take.
 *
 * IT HAS TO SAY WHAT IS BEING ACTED ON. This looked only for a recipient and a
 * subject, so anything that CREATES something — whose arguments are a name and a
 * place, not a `to` — fell through to the bare capability name. Witnessed on prod
 * 2026-07-29: asked to add three Airtable columns, the confirmation listed
 *
 *     Add Airtable Column
 *     Add Airtable Column
 *     Add Airtable Column
 *
 * three identical rows, with the column names sitting unused in `args`. That is the
 * same rule the step-approval card exists for — never ask someone to approve
 * something you have not shown them — and it is worse here, because this is the last
 * gate before Atlas changes something in a system of record.
 *
 * Generic by argument shape, never by capability name: `name` is what a create takes,
 * and the location keys below cover a table, a folder, a file or a calendar. An
 * opaque provider id (`appXXXXXXXXXXXXXX`) is suppressed — it identifies nothing to
 * a reader, and the same rule already governs the promise checker.
 */
export function describePendingAction(cap, args = {}) {
  const base    = cap?.name || cap?.id || 'action';
  const to      = args.to || args.target || args.user || args.channel || args.email;
  const what    = args.name || args.fieldName || args.columnName;
  const subject = args.subject || args.title;
  const rawWhere = args.tableId || args.table || args.folder || args.path
                || args.spreadsheetId || args.calendarId;
  const where = rawWhere && !isOpaqueProviderId(rawWhere) ? rawWhere : null;
  return [
    base,
    to ? `→ ${to}` : null,
    what ? `“${what}”` : null,
    subject && subject !== what ? `“${subject}”` : null,
    where && where !== to ? `in ${where}` : null,
  ].filter(Boolean).join(' ');
}

// When `pending` is supplied, side-effecting tool calls are CAPTURED into it and
// NOT executed — the chat surfaces them for confirmation and they run only via the
// dedicated /chat/execute-action endpoint. Read-only tools always run.
function makeChatToolExecutor(spine, req, sessionId, opts = {}) {
  const pending = Array.isArray(opts.pending) ? opts.pending : null;
  return async function executeChatTools(toolCalls, msgArray) {
    await Promise.all(toolCalls.map(async (tc) => {
      let resultStr;
      try {
        const registry = spine.engine?.capabilityRegistry;
        const handler  = registry?.getHandler(tc.name);
        if (!handler) throw new Error(`Unknown tool: ${tc.name}`);
        const cap    = registry.get(tc.name);
        // ── THE CONFIRMATION GATE ────────────────────────────────────────────
        // An outward-facing action (send email, post to Slack, create/write a
        // record) is NEVER performed straight from chat. It is captured and
        // returned to the user to confirm — because "send a branded email to my
        // CRM list" must not fire live emails while the user is still talking.
        // The action runs only when the user clicks confirm (→ execute-action).
        if (pending && isSideEffectingChatTool(cap)) {
          pending.push({ id: `act${pending.length + 1}`, name: tc.name, args: tc.args ?? {}, label: describePendingAction(cap, tc.args ?? {}) });
          resultStr = JSON.stringify({ status: 'NOT_PERFORMED', reason: 'This outward-facing action was NOT performed. It is held for the user to confirm. Tell the user plainly what you propose to do (who it goes to, what it says) and let them confirm — do NOT claim it is done.' });
          logEvent('chat.tool.gated', { tenant: req.tenant?.id ?? null, tool: tc.name });
        } else {
          const config = { ...(tc.args ?? {}) };
          await injectCapabilityCredentials(cap, config, { auth: spine.auth, tenant: req.tenant, user: req.user });
          const result = await handler({ config, body: config.body ?? null, title: config.title ?? null, sessionId });
          resultStr = JSON.stringify(result ?? {});
          logEvent('chat.tool.ok', { tenant: req.tenant?.id ?? null, tool: tc.name });
        }
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
function isDoneRun(r) { return isLiveRun(r) && (r.status === 'success' || r.status === 'error'); }

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

export function mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth, readSources, tenantGuard, dryRunSpecForTenant = null }) {
  // No-op guard when not supplied (keeps the builder mountable in isolation/tests).
  const guard = tenantGuard ?? ((_req, _res, next) => next());

  // Keep Airtable's record-change watches in step with what is actually live.
  // Anything that changes WHICH workflows are active, or what their triggers watch,
  // has to run this — otherwise a deleted workflow leaves a webhook firing into
  // nothing, and a paused one keeps waking up.
  //
  // Fire-and-forget: the user's action has already succeeded by the time this runs,
  // so it must never block the response or turn a good save into an error. It logs
  // either way, so a failure is findable rather than invisible.
  const reconcileAirtable = (tenantId, why) =>
    syncAirtableWebhooksForTenant(spine, tenantId)
      .then((r) => {
        if (r.created?.length || r.removed?.length || r.failed?.length) {
          logEvent('airtable.webhooks.reconcile', {
            tenant: tenantId, why,
            created: r.created?.length ?? 0, removed: r.removed?.length ?? 0, failed: r.failed?.length ?? 0,
          });
        }
      })
      .catch((e) => logEvent('airtable.webhooks.reconcile_error', { tenant: tenantId, why, error: String(e?.message ?? e) }));

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
      // Outward-facing actions the model tried to perform are captured here, held
      // for the user to confirm, and surfaced on the terminal `done` event.
      const pendingActions = [];
      const executeChatTools = makeChatToolExecutor(spine, req, chatSessionId, { pending: pendingActions });
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
            content: last.content + '\n\n[Format: whether or not you call a tool, your text response must be exactly: {"reply":"<your message>","ready_to_build":<true or false>,"build_intent":<a string or null>} — and inside the reply text use SINGLE quotes only, never a double-quote, which would truncate your message.]',
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
      // True once we've streamed reply text to the client THIS round. If the model
      // then reveals a mid-stream tool call, that streamed reply is stale (the round
      // is discarded and re-run), so the client must clear it — otherwise the re-run's
      // reply is APPENDED to it and the message renders twice (found in live testing).
      let clientHasPartial = false;
      // One prose-instead-of-JSON retry per request, never a loop.
      let envelopeRetried = false;
      // One shot only — see the artifact guard below. A guard that can loop is a
      // worse bug than the one it fixes.
      let artifactRetried = false;
      // Exactly the text the client has been sent as `chunk` events — i.e. what the
      // USER can read on screen. Every chunk goes through sendChunk so this stays
      // truthful; it is cleared whenever a partial is withdrawn (`reset`), because
      // the client clears its bubble on that event too.
      let visibleText = '';

      const sendChunk = (text) => {
        if (!text || closed) return;
        visibleText += text;
        sseWrite({ type: 'chunk', text });
        clientHasPartial = true;
      };

      // Withdraw whatever is on screen: the client empties the streaming bubble.
      const withdrawPartial = () => {
        if (closed) return;
        sseWrite({ type: 'reset' });
        visibleText = '';
        clientHasPartial = false;
      };

      // ── NAVIGATION BACKSTOP ────────────────────────────────────────────────
      // Last thing before `done`: if the reply the user is reading points them at
      // an Atlas screen that does not exist, withdraw it and re-send the corrected
      // text. The prompt rule (ATLAS'S OWN SCREENS) is the mechanism; this is what
      // makes it enforceable. Uses the SAME withdraw-and-replace path the mid-stream
      // tool case already relies on, so the user ends up with one clean bubble.
      const correctInventedNavigation = () => {
        if (closed || !visibleText) return false;
        const scrubbed = scrubInventedNavigation(visibleText);
        if (!scrubbed.changed) return false;
        withdrawPartial();
        sendChunk(scrubbed.text);
        logEvent('chat.navigation.corrected', { tenant: req.tenant?.id ?? null });
        return true;
      };

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
        if (replyBuf) { sendChunk(replyBuf); replyBuf = ''; }
      };

      // Tool-use + streaming loop.
      // Anthropic tool-use turns yield NO intermediate text chunks — only a single
      // final AIMessage with toolCalls. Text turns yield many small delta AIMessages.
      // Peeking at the first gen.next() cleanly distinguishes the two cases.
      // A complex intent can legitimately touch several connectors before it has
      // enough to reply (e.g. list Drive files → describe the sheet → read the sheet
      // → look at Knowledge). Give it room; the forced-reply fallback below still
      // guarantees a response if it somehow never converges.
      const MAX_TOOL_ROUNDS = 6;
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
          // If we already streamed a reply this round, tell the client to drop it so the
          // re-run's reply replaces it rather than doubling it.
          if (clientHasPartial) withdrawPartial();
          extractState = 'searching'; searchBuf = ''; replyBuf = ''; streamedText = ''; escapeNext = false;
          for (const tc of midStreamToolCalls) sseWrite({ type: 'tool', name: tc.name });
          msgArray.push(new AIMessage(midStreamChunk?.content ?? '', midStreamChunk?.additionalKwargs ?? { toolCalls: midStreamToolCalls }));
          await executeChatTools(midStreamToolCalls, msgArray);
          continue;
        }

        let parsedMeta = null;
        try { parsedMeta = JSON.parse(extractJsonLoose(streamedText)); } catch {}

        // ── The model answered in PROSE instead of the JSON envelope ────────────
        //
        // Known behaviour when tools are in play (CLAUDE.md, Known gotchas): the
        // words are fine, but `ready_to_build` is unreadable — so the BUILD BUTTON
        // never renders and the conversation dead-ends on a reply that reads like it
        // is about to build. Observed TWICE in one live session; both times the user
        // had to type "build it" to move on, and once the prose was cut mid-sentence.
        //
        // Asking the model to try again is already the proven recovery for the
        // tool-budget case below, so use it here too: ONCE, with tools DISABLED so
        // it cannot start another tool round, and with the format spelled out. The
        // partial prose is withdrawn first (`reset`) so the retry replaces it rather
        // than appending — the same care the mid-stream tool path takes.
        if (!parsedMeta?.reply && !envelopeRetried) {
          envelopeRetried = true;
          logEvent('chat.envelope.retry', { tenant: req.tenant?.id ?? null, turns: messages.length });
          if (clientHasPartial) withdrawPartial();
          msgArray.push(new AIMessage(streamedText));
          msgArray.push({ role: 'user', content: 'Send that same message again, formatted EXACTLY as this JSON and nothing else: {"reply":"<your message>","ready_to_build":<true or false>,"build_intent":<a string or null>} — and inside the reply text use SINGLE quotes only. A double-quote inside it ends the string early and loses the rest of your message, which is what just went wrong.' });
          extractState = 'searching'; searchBuf = ''; replyBuf = ''; streamedText = ''; escapeNext = false;
          try {
            for await (const chunk of llm.stream(msgArray, { configurable: invokeConfig.configurable })) {
              processToken(typeof chunk.content === 'string' ? chunk.content : '');
            }
            try { parsedMeta = JSON.parse(extractJsonLoose(streamedText)); } catch { parsedMeta = null; }
          } catch (err) {
            // The retry is a BONUS, never a new way to fail: on any error fall through
            // and show whatever the first answer said.
            logEvent('chat.envelope.retry.failed', { tenant: req.tenant?.id ?? null, ...errFields(err) });
          }
        }

        // ── AN OFFER MAY NOT PROMISE WHAT THE BUILD WILL NOT MAKE ─────────────
        // Operator, 2026-07-28: "This can never happen, especially if a google doc
        // is a piece of the contract." Witnessed: a reply offering to "summarise
        // both into a single Google Doc" on a build whose `build_intent` — the
        // paragraph the workflow is actually assembled from — never mentioned one.
        // No document was created anywhere.
        //
        // Re-ask rather than edit: the promise arrived as one clause of a numbered
        // sentence, so cutting the sentence deletes the whole offer and cutting the
        // clause leaves "post the doc" pointing at nothing. See chat-artifact-guard.
        // Once only, tools off, exactly like the envelope retry above — a guard that
        // can loop is a worse bug than the one it fixes.
        if (parsedMeta?.reply && !artifactRetried) {
          const unbacked = unbackedArtifacts(parsedMeta.reply, parsedMeta.build_intent ?? '');
          if (unbacked.length) {
            artifactRetried = true;
            logEvent('chat.unbacked_artifact', {
              tenant: req.tenant?.id ?? null, artifacts: unbacked.map(u => u.id),
            });
            if (clientHasPartial) withdrawPartial();
            msgArray.push(new AIMessage(streamedText));
            msgArray.push({ role: 'user', content: artifactCorrectionFor(unbacked) });
            extractState = 'searching'; searchBuf = ''; replyBuf = ''; streamedText = ''; escapeNext = false;
            try {
              for await (const chunk of llm.stream(msgArray, { configurable: invokeConfig.configurable })) {
                processToken(typeof chunk.content === 'string' ? chunk.content : '');
              }
              try { parsedMeta = JSON.parse(extractJsonLoose(streamedText)); } catch { /* keep the first */ }
            } catch (err) {
              // Like the envelope retry: a BONUS, never a new way to fail.
              logEvent('chat.unbacked_artifact.retry_failed', { tenant: req.tenant?.id ?? null, ...errFields(err) });
            }
          }
        }

        // Envelope still missing — show the raw text so the user is never left with
        // an empty reply. They lose the button, not the answer.
        if (extractState === 'searching' && streamedText && !closed) {
          const CHUNK = 40;
          for (let i = 0; i < streamedText.length; i += CHUNK) {
            sendChunk(streamedText.slice(i, i + CHUNK));
          }
        }

        correctInventedNavigation();

        const readyToBuild = parsedMeta ? !!parsedMeta.ready_to_build : false;
        const buildIntent  = (parsedMeta && typeof parsedMeta.build_intent === 'string' && parsedMeta.build_intent.trim()) ? parsedMeta.build_intent.trim() : null;

        logEvent('chat.reply', { tenant: req.tenant?.id ?? null, turns: messages.length, readyToBuild, parsed: !!parsedMeta?.reply, retried: envelopeRetried, pending: pendingActions.length });
        sseWrite({ type: 'done', readyToBuild, buildIntent, pendingActions });
        clearInterval(heartbeat);
        res.end();
        return;
      }

      // Exhausted the tool-round budget without the model producing a text reply.
      // Rather than dumping an error on the user (which is exactly what happened with
      // a brand-kit + Sheets intent — the model kept calling tools, including a wasted
      // web_fetch on an asset path, and never replied), FORCE a final answer: one more
      // turn with tools DISABLED, so the model MUST respond from what it has gathered.
      // This guarantees the chat always returns something usable.
      try {
        msgArray.push({ role: 'user', content: 'You now have enough information. Do NOT call any more tools. Reply now, using what you have gathered, with exactly: {"reply":"<your message>","ready_to_build":<true or false>,"build_intent":<a string or null>}' });
        const finalConfig = { configurable: invokeConfig.configurable }; // NO tools → the model has to answer
        extractState = 'searching'; searchBuf = ''; replyBuf = ''; streamedText = ''; escapeNext = false;
        for await (const chunk of llm.stream(msgArray, finalConfig)) {
          processToken(typeof chunk.content === 'string' ? chunk.content : '');
        }
        if (extractState === 'searching' && streamedText && !closed) {
          const CHUNK = 40;
          for (let i = 0; i < streamedText.length; i += CHUNK) sendChunk(streamedText.slice(i, i + CHUNK));
        }
        correctInventedNavigation();
        let parsedMeta = null;
        try { parsedMeta = JSON.parse(extractJsonLoose(streamedText)); } catch {}
        const readyToBuild = parsedMeta ? !!parsedMeta.ready_to_build : false;
        const buildIntent  = (parsedMeta && typeof parsedMeta.build_intent === 'string' && parsedMeta.build_intent.trim()) ? parsedMeta.build_intent.trim() : null;
        logEvent('chat.reply', { tenant: req.tenant?.id ?? null, turns: messages.length, readyToBuild, parsed: !!parsedMeta?.reply, forcedFinal: true, pending: pendingActions.length });
        sseWrite({ type: 'done', readyToBuild, buildIntent, pendingActions });
        clearInterval(heartbeat);
        res.end();
        return;
      } catch (e) {
        logEvent('chat.error', { tenant: req.tenant?.id ?? null, ...errFields(e), phase: 'forced-final-reply' });
        sseWrite({ type: 'error', error: 'Atlas gathered your data but had trouble replying. Try again, or rephrase in a sentence or two.' });
        clearInterval(heartbeat);
        res.end();
      }
    } catch (err) {
      clearInterval(heartbeat);
      logEvent('chat.error', { tenant: req.tenant?.id ?? null, ...errFields(err) });
      sseWrite({ type: 'error', error: cleanLLMError(err) });
      res.end();
    }
  });

  // ── POST /api/builder/chat/execute-action ───────────────────────────────────
  // Runs ONE outward-facing action the chat proposed, AFTER the user has clicked
  // confirm in the UI. This is the ONLY path by which a chat-initiated send / post
  // / write actually executes — the chat tool loop itself never performs one (see
  // the confirmation gate in makeChatToolExecutor). The capability is re-validated
  // here and MUST be side-effecting, so this endpoint can't be repurposed to run an
  // arbitrary or read-only handler. Body: { name, args }.
  app.post('/api/builder/chat/execute-action', requireActiveTenant, async (req, res) => {
    const { name, args } = req.body ?? {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    try {
      const registry = spine.engine?.capabilityRegistry;
      const handler  = registry?.getHandler(name);
      const cap      = registry?.get(name);
      if (!handler || !cap) return res.status(404).json({ error: `Unknown action: ${name}` });
      if (!isSideEffectingChatTool(cap)) return res.status(400).json({ error: 'That action does not require confirmation.' });
      const sessionId = `chat-action-${req.user?.id ?? 'anon'}-${Date.now()}`;
      spine.costTracker?.setSessionUser?.(sessionId, req.user?.id);
      const config = { ...(args ?? {}) };
      await injectCapabilityCredentials(cap, config, { auth: spine.auth, tenant: req.tenant, user: req.user });
      const result = await handler({ config, body: config.body ?? null, title: config.title ?? null, sessionId });
      logEvent('chat.action.executed', { tenant: req.tenant?.id ?? null, tool: name });
      // App-level failures stay 2xx so the UI can read them (Cloudflare replaces
      // origin 5xx with its own page); a real success is ok:true.
      res.json({ ok: true, result: result ?? {} });
    } catch (err) {
      logEvent('chat.action.error', { tenant: req.tenant?.id ?? null, tool: name, ...errFields(err) });
      res.status(200).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // ── POST /api/builder/test-summary ──────────────────────────────────────────
  // The sentence a person reads in chat after pressing Run test.
  //
  // THIS NO LONGER ASKS A MODEL. It used to: it built a context string and told the
  // model to "be specific — say what the workflow actually did". The only per-run
  // material it handed over was `deliveries[0]` (from the LAST example of the
  // sequence) and an output excerpt, so the model never learned which example,
  // which lane, or that a sample's verdict was `not_exercised` — and it filled the
  // gap. Live, after a PASSING test, it told a tester the workflow "classified it
  // as spam, routed it to the correct path, and then summarized and delivered it to
  // both the #ops channel and to charles@agntic.co as promised". Spam is the branch
  // whose entire promise is to do NOTHING, and the panel two inches above said so.
  //
  // The operator's rule: the product does not describe its own run results in free
  // prose. The sentence is COMPOSED, deterministically, from the same objects the
  // panel renders — `outcomeResults` (each carrying the oracle's three-way
  // `verdict`) and `laneCoverage` — so the two surfaces cannot disagree. The
  // composer is a pure module so the sentence itself can be asserted; see
  // src/workflows/run-summary.js for why it is not a closure in here.
  //
  // Body:    { spec, result: { verdict, completed, outcomeResults, laneCoverage, error } }
  // Returns: { summary }
  app.post('/api/builder/test-summary', requireActiveTenant, (req, res) => {
    const { spec, result } = req.body ?? {};
    if (!spec || !result) return res.status(400).json({ error: 'spec and result are required' });
    try {
      // Older clients send no `verdict`; fall back to the boolean so they still work.
      // The composer weakens this against the evidence anyway — it can never claim
      // more than the run's own results support.
      const verdict = result.verdict ?? (result.completed ? 'passed' : 'failed');
      const summary = composeRunSummary({
        spec,
        verdict,
        outcomeResults: result.outcomeResults,
        laneCoverage:   result.laneCoverage,
        // Attached for the failed stance only, inside the composer. Deliberately
        // the ONLY run-level field passed: `steps`, `deliveries` and `output` are
        // not handed over at all, so no sentence can narrate one example's
        // delivery as the whole run's.
        runError: result.error,
      });

      // ── THE GO-LIVE INDICATOR, ON THE RECORD ────────────────────────────────
      // "Did this workflow pass?" was only ever a sentence on a screen. To run a
      // test→observe→fix loop over repeated builds you need it as data, tied to a
      // workflow, alongside HOW MUCH was actually proven — a pass with one sample
      // and a pass with every lane covered are not the same result, and pooling
      // them is how "it works" survives a shape that only works sometimes.
      const marks = Array.isArray(result.outcomeResults)
        ? result.outcomeResults.map(o => String(o?.verdict ?? o?.outcome ?? '')).filter(Boolean)
        : [];
      const lanes = result.laneCoverage ?? {};
      logEvent('test.summary', {
        tenant:     req.tenant?.id ?? null,
        workflowId: req.body?.workflowId ?? null,
        workflow:   typeof spec?.name === 'string' ? spec.name.slice(0, 80) : null,
        verdict,
        examples:   Array.isArray(result.outcomeResults) ? result.outcomeResults.length : 0,
        kept:       marks.filter(m => m === 'kept').length,
        broken:     marks.filter(m => m === 'broken').length,
        lanesCovered: Number.isFinite(lanes.applicable) && Number.isFinite(lanes.total)
          ? lanes.total - (Array.isArray(lanes.uncovered) ? lanes.uncovered.length : 0) : null,
        lanesTotal:   Number.isFinite(lanes.total) ? lanes.total : null,
        chars: summary.length,
      });
      return res.json({ summary });
    } catch (err) {
      logEvent('test.summary.error', { tenant: req.tenant?.id ?? null, ...errFields(err) });
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });
  // ── CAPABILITIES, IN ONE PLACE ─────────────────────────────────────────────
  // What the converger is allowed to know about this tenant: which connectors are
  // live, the real Airtable bases/tables/columns, the delivery channel catalog, the
  // approval channels, and any knowledge context. Extracted from POST /sessions so
  // a session REHYDRATED after a restart is built from exactly the same picture —
  // a second, drifting copy is how one path ends up certifying against a catalog the
  // other never saw (CLAUDE.md: CHANNELS_UNVERIFIED).
  // ONE definition of a converger. POST /sessions builds one for a new thread;
  // rehydrateSession() builds an identical one for a thread whose in-memory handle
  // was lost (a restart, a deploy). Two constructions would drift, and the drift
  // would be invisible until a resumed build behaved unlike the one that started.
  function makeConverger({ req, threadId, capabilities }){
    return createConverger({
      llm:              spine.llm,
      capabilities,
      // The converger reads the tenant's real Airtable bases, tables and columns
      // (and their real emails) instead of asking them to be typed. §6.2.3.
      invokeCapability: makeCapabilityInvoker(spine, req, threadId),
      interactionStore: spine.interactionStore,
      tenantId:         req.tenant.id,
      userId:           req.user?.id,
      // P13-0 seam #3 — destination resolution reads the connector's DECLARED schema
      // discovery from this catalog rather than the literal string 'airtable', so any
      // connector that declares it gets click-to-pick instead of "paste an id".
      capabilityCatalog: spine.engine?.capabilityRegistry ?? null,
      // The graph narrates its reasoning through this (Increment #22). Bound to the
      // threadId so every converger node can call cfg.configurable.narrate(beat)
      // without knowing which session it is in. Additive — absent, the graph is silent.
      narrate:          (beat) => narrate(threadId, beat),
      // Run the draft through the real engine in DRY-RUN mode (#23). The `verify`
      // node calls this to test its own workflow on a sample event before handing
      // off — no real sends/writes, terminal side-effects stubbed. Bound to this
      // tenant/user so the run injects the right credentials and stays cost-attributed.
      // Additive + fail-safe: absent (no server wrapper) ⇒ `verify` passes straight
      // through to ratify, so a build is never blocked on the self-test being wired.
      runDryRun:        dryRunSpecForTenant
        ? (spec, given) => dryRunSpecForTenant(spine, spec, { tenantId: req.tenant.id, userId: req.user?.id, initialContext: given })
        : null,
    });
  }

  // ── A BUILD SURVIVES THE SERVER ────────────────────────────────────────────
  // `sessions` is an in-memory Map, so a restart or a deploy ended every build in
  // flight. The next thing the user sent came back "session not found or already
  // complete", and a conversation they had spent minutes on was gone — observed live,
  // immediately after a failed build had offered them a retry.
  //
  // Nothing about that was necessary. Both halves of a session are ALREADY durable:
  // the graph's own state is checkpointed to disk by FileCheckpointer
  // (./memory/converger/<threadId>.jsonl), and who owns the thread is in the
  // interaction store. Only the JavaScript handle was lost — so rebuild it.
  //
  // OWNERSHIP IS ENFORCED BY CONSTRUCTION: getSession() is tenant-scoped, so a thread
  // belonging to another workspace simply is not found. A threadId is guessable
  // (`build-<tenant>-<epoch-ms>`), which is exactly why the tenant must come from the
  // caller's session and never from the id.
  async function rehydrateSession(threadId, req) {
    const live = sessions.get(threadId);
    if (live) return live;
    let row = null;
    try { row = spine.interactionStore?.getSession?.(req.tenant.id, threadId) ?? null; } catch { row = null; }
    if (!row) return null;                 // unknown here, or another tenant's
    if (row.completed_at) return null;     // finished — resuming is not a thing
    // No checkpoint on disk ⇒ nothing to resume from; say not-found rather than hand
    // back a converger that would start the graph over from the beginning.
    if (!(await hasCheckpoint(threadId))) return null;

    // The SAME intent the build started with, from the stored row — so the knowledge
    // context a resumed build sees matches the one it was reasoning with.
    const capabilities = await buildCapabilities(req, row.intent ?? null);
    const converger = makeConverger({ req, threadId, capabilities });
    sessions.set(threadId, converger);
    // The beat hub is in memory too; reopen it so the reasoning panel can attach.
    openReasoningHub(threadId, { tenantId: req.tenant.id, userId: req.user?.id });
    spine.costTracker?.setSessionUser?.(threadId, req.user?.id);
    logEvent('builder.session_rehydrated', { tenant: req.tenant.id, threadId });
    return converger;
  }

  // Does the graph have state for this thread? The checkpointer owns the file layout,
  // so ask it rather than guessing at a path here — a hard-coded filename is a second
  // definition waiting to drift.
  async function hasCheckpoint(threadId) {
    try {
      const { FileCheckpointer } = await import('../graph/checkpointer/index.js');
      const cp = new FileCheckpointer({ dir: './memory/converger' });
      const got = await cp.load(threadId);
      return !!got;
    } catch { return false; }
  }

  async function buildCapabilities(req, intent = null) {
  // Operator identity lets the converger resolve "me"/"DM me" to a real target.
  let capabilities = { operator: { name: req.user?.display_name ?? null, email: req.user?.email ?? null } };
  // ── WHOSE 8AM? ──────────────────────────────────────────────────────────────
  // A schedule built without this defaulted to UTC in silence: "Every Monday at
  // 8am (UTC)" is not 8am to anyone outside it, and no screen said which 8am was
  // meant. The browser has always known; it was simply never asked. Validated as a
  // real IANA zone before it is trusted — a bad string here would put a workflow on
  // the wrong clock, which is worse than having no default at all. A DEFAULT only:
  // a timezone the user says in words still wins.
  const rawTz = typeof req.body?.timezone === 'string' ? req.body.timezone.trim() : '';
  if (rawTz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: rawTz });   // throws on nonsense
      capabilities.userTimezone = rawTz;
    } catch { /* not a zone we can honour — fall through to asking */ }
  }
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
          // ── WHO IS THE OPERATOR *IN SLACK*? ──────────────────────────────
          // Their Atlas login and their Slack account are different identities.
          // The prompt used to hand the model the LOGIN email as a DM target, so a
          // build addressed its approval DM to an address with no Slack account and
          // every run failed "no Slack user matches" — see
          // `resolveOperatorSlackIdentity`. Resolved once here, from the live
          // workspace, so the converger is never told to write an address that
          // cannot receive.
          capabilities.operator.slack =
            await spine.slack.resolveOperatorSlackIdentity(req.tenant.id, req.user?.email, { botToken });
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
    // THE STATE OF KNOWLEDGE IS REPORTED EVEN WHEN IT IS EMPTY.
    //
    // Silence about an empty knowledge base is not neutral. On 2026-07-30, told "I
    // uploaded the documents to Atlas under Knowledge", Atlas replied *"Perfect — I can
    // pull from your Knowledge docs in the workflow"* with nothing there at all — it had
    // never been told, so it filled the gap with the agreeable assumption. Connectors
    // have always said "(none connected)"; knowledge said nothing.
    capabilities.knowledge = { documentCount: allSources.length,
                               names: allSources.map(s => s.name || s.path).filter(Boolean).slice(0, 20) };
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
    return capabilities;
  }


  // ── POST /api/builder/sessions ───────────────────────────────────────────────
  // Start a new converger session from a plain-language intent.
  // Body: { intent: string }
  // Returns: { threadId, interrupt }
  app.post('/api/builder/sessions', requireActiveTenant, async (req, res) => {
    const { intent } = req.body ?? {};
    if (!intent?.trim()) return res.status(400).json({ error: 'intent is required' });

    // Slow builds must not be cut by the proxy — see keepAlive() below.
    const alive = keepAlive(res);

    const capabilities = await buildCapabilities(req, intent);

    const threadId  = `build-${req.tenant.id}-${Date.now()}`;
    // Open the reasoning beat hub BEFORE the graph runs, so beats emitted during
    // this first synchronous pass (outcome → process → examples → analyze → …) are
    // buffered and replayed to the EventSource the client opens right after it gets
    // this threadId back. Owner is recorded for the SSE ownership check.
    openReasoningHub(threadId, { tenantId: req.tenant.id, userId: req.user?.id });
    // Register user attribution so converger LLM cost records carry tenant_id.
    spine.costTracker?.setSessionUser?.(threadId, req.user?.id);
    // Start intro message after threadId exists so it shares the same session attribution.
    const introP = introMessage(spine, intent, threadId);
    const converger = makeConverger({ req, threadId, capabilities });

    sessions.set(threadId, converger);
    if (typeof req.body?.workflowId === 'string' && req.body.workflowId) {
      sessionDraft.set(threadId, req.body.workflowId);
    }

    // START the build; do not hold the request open for it. The graph can run for
    // minutes, and a socket is the wrong thing to hang that on — see `builds` above.
    startBuildJob(threadId, async () => {
      await converger.run(threadId, intent);
      return { type: 'done' };
    });
    logEvent('session.start', { tenant: req.tenant?.id ?? null, threadId, background: true });

    // The opener is attached by the status endpoint when the first question arrives,
    // so this response does not wait on it either.
    introP.then((intro) => { if (intro) buildIntro.set(threadId, intro); }).catch(() => {});

    alive.send({ threadId, status: 'running' }, 202);
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
    // A build in flight when the server restarted is NOT gone: the graph state is on
    // disk and the thread's owner is in the interaction store, so the handle is rebuilt
    // on demand. Only a thread this tenant does not own, or one with no checkpoint, is
    // genuinely not found.
    if (!(await rehydrateSession(threadId, req))) {
      return res.status(404).json({ error: 'session not found or already complete' });
    }

    // Same as POST /sessions: start the resume, do not hold the socket for it.
    if (builds.get(threadId)?.status === 'running') {
      // Already working. Answering twice must not run the graph twice.
      return res.status(202).json({ threadId, status: 'running' });
    }
    startBuildJob(threadId, () => serializePerThread(threadId, async () => {
      let result;
      try {
        const converger = await rehydrateSession(threadId, req);
        if (!converger) { const e = new Error('session not found or already complete'); e._stale = true; throw e; }
        result = await converger.resume(threadId, req.body);
      } catch (err) {
        // A stale/duplicate resume (the thread already advanced) is not a failure — the
        // real work was done by the resume that got there first. Return a benign no-op the
        // client ignores, and NEVER surface the raw `CompiledGraph.resume()…` text.
        if (err?._stale || isStaleResumeError(err)) {
          logEvent('respond.duplicate', { tenant: req.tenant?.id ?? null, threadId, sent: req.body?.type });
          return { type: 'noop', reason: 'already_handled' };
        }
        logEvent('respond.error', { tenant: req.tenant?.id ?? null, threadId, sent: req.body?.type, ...errFields(err) });
        throw err;   // recorded as `error` by startBuildJob; the poll reports it plainly
      }

      logEvent('respond.ok', { tenant: req.tenant?.id ?? null, threadId, sent: req.body?.type, interrupt: result?.type, background: true });

      // ── PERSIST A FINISHED BUILD THE MOMENT IT EXISTS ────────────────────────
      //
      // A build that took six minutes completed server-side, logged `respond.ok`
      // with the whole workflow in hand — and the BROWSER never received it
      // ("TypeError: Failed to fetch"). Nothing was saved, because the only thing
      // that ever wrote the spec was the client acknowledging it, and the user was
      // told to start over from "+ New workflow". Minutes of model work, and the
      // user's place in a long conversation, thrown away because one HTTP response
      // did not land.
      //
      // The server has the spec right here. Write it to the draft row now. If the
      // response never arrives, opening that draft recovers the finished build
      // instead of an empty conversation.
      //
      // Draft rows ONLY (`status === 'draft'`), so this can never touch a live
      // workflow, and it is strictly best-effort: a failure here must not turn a
      // successful build into an error.
      const spec = result?.spec;
      const draftId = sessionDraft.get(threadId);
      if (draftId && spec && Array.isArray(spec.nodes) && spec.nodes.length) {
        try {
          const store = spine.engine.workflowStore;
          const row = store.get(draftId, { userId: req.user.id });
          if (row && row.tenant_id === req.tenant.id && row.status === 'draft') {
            const patch = { nodes: spec.nodes };
            if (Array.isArray(spec.edges))    patch.edges = spec.edges;
            if (Array.isArray(spec.triggers)) patch.triggers = spec.triggers;
            if (typeof spec.name === 'string' && spec.name) patch.name = spec.name;
            // The CONTRACT rides along. The client-driven autosave omits it, which is
            // the same omission that left `outcome` NULL on every stored workflow
            // (F11) — a recovered draft with no promise cannot be certified against
            // anything.
            if (spec.outcome !== undefined) patch.outcome = spec.outcome;
            store.update(draftId, patch, { userId: req.user.id, snapshot: false });
            logEvent('builder.build.autosaved', { tenant: req.tenant?.id ?? null, workflowId: draftId, nodes: spec.nodes.length });
          }
        } catch (err) {
          logEvent('builder.build.autosave.error', { tenant: req.tenant?.id ?? null, workflowId: draftId, ...errFields(err) });
        }
      }

      if (result?.type === 'done') { sessions.delete(threadId); sessionDraft.delete(threadId); closeReasoningHub(threadId); }
      return result;
    }));
    return res.status(202).json({ threadId, status: 'running' });
  });

  // ── GET /api/builder/sessions/:threadId/status ───────────────────────────────
  // Where the build has got to. `running` means keep polling; `ready` carries the
  // question (or completion) to act on; `error` carries a plain message.
  //
  // `unknown` is its own answer and deliberately not an error: after a restart the
  // graph state is still on disk but this process has no memory of what was in
  // flight, so the honest reply is "I do not know" — the client offers to continue
  // from the last checkpoint rather than pretending the build is lost or, worse,
  // silently starting it again.
  app.get('/api/builder/sessions/:threadId/status', requireActiveTenant, async (req, res) => {
    const { threadId } = req.params;
    // Tenant-scoped: a threadId is guessable, so ownership comes from the caller's
    // session, never from the id.
    let row = null;
    try { row = spine.interactionStore?.getSession?.(req.tenant.id, threadId) ?? null; } catch { row = null; }
    if (!row) return res.status(404).json({ error: 'session not found' });

    const job = builds.get(threadId);
    if (!job) {
      return res.json({ threadId, status: row.completed_at ? 'done' : 'unknown' });
    }
    if (job.status === 'running') return res.json({ threadId, status: 'running' });
    if (job.status === 'error') {
      // NEVER the raw throw. A detached job's error is a JavaScript message — the one
      // that reached a user during the shakedown was literally "alive is not defined",
      // which tells them nothing and reads as the product falling apart. The real text
      // is already in the log (`builder.job_failed`) where it belongs.
      return res.json({ threadId, status: 'error',
        error: 'Atlas hit a snag finishing that step. Your work is saved — tell me what to change and I\'ll carry on.' });
    }

    const interrupt = job.value ?? null;
    // The opener rides along with the first question the user actually sees.
    const intro = buildIntro.get(threadId);
    if (intro && interrupt && (interrupt.type === 'proposal' || interrupt.type === 'clarification') && !interrupt.intro) {
      interrupt.intro = intro;
      buildIntro.delete(threadId);
    }
    return res.json({ threadId, status: 'ready', interrupt });
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

  // ── GET /api/builder/sessions/:threadId/reasoning ────────────────────────────
  // Live "why/how" narration for a build (Increment #22). A SEPARATE, additive SSE
  // channel — the synchronous /sessions + /respond flow is unchanged and does not
  // depend on it. On connect we replay the buffered beats (so a client that opens
  // slightly late still sees the opening narration), then stream each new beat.
  //
  // Tenant/session isolation: the threadId is minted server-side with the tenant
  // baked in, and the hub records its OWNER — we serve the stream only when the
  // hub's tenant equals the authenticated caller's, so one tenant can never read
  // another's reasoning (or another session's). Reconnects carry Last-Event-ID, so
  // the replay skips beats the client already saw (no duplicates on a network blip).
  app.get('/api/builder/sessions/:threadId/reasoning', requireActiveTenant, (req, res) => {
    const { threadId } = req.params;
    const hub = reasoningHubs.get(threadId);

    // Ownership FIRST, before any SSE header is flushed: refuse a threadId this
    // caller does not own with a real 403. (A mismatched tenant already knows the
    // threadId doesn't belong to them, so 403 leaks nothing 404 wouldn't.) Once
    // flushHeaders() has run the status is locked to 200, so this must precede it.
    if (hub && hub.tenantId && req.tenant?.id && hub.tenantId !== req.tenant.id) {
      return res.status(403).end();
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const sseWrite = (obj, id) => {
      if (closed) return;
      try { res.write(`${id != null ? `id: ${id}\n` : ''}data: ${JSON.stringify(obj)}\n\n`); } catch { closed = true; }
    };
    const endStream = () => {
      if (closed) return;
      try { res.write('event: end\ndata: {}\n\n'); } catch { /* ignore */ }
      closed = true;
      try { res.end(); } catch { /* ignore */ }
    };

    // No hub → the session already finished (or the threadId isn't a live build).
    // Emit a terminal `end` event and close so the client's EventSource stops
    // rather than reconnecting every few seconds against a dead thread.
    if (!hub) { endStream(); return; }

    // Replay everything after the client's last-seen beat (0 on a fresh connection).
    const lastId = Number(req.headers['last-event-id'] || 0) || 0;
    for (const b of hub.buffer) {
      if (b._seq > lastId) sseWrite(beatPayload(b), b._seq);
    }

    const onBeat = (b) => sseWrite(beatPayload(b), b._seq);
    const onEnd  = () => { cleanup(); endStream(); };
    hub.emitter.on('beat', onBeat);
    hub.emitter.on('end', onEnd);

    const heartbeat = setInterval(() => {
      if (!closed) { try { res.write(': hb\n\n'); } catch { closed = true; } }
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      try { hub.emitter.removeListener('beat', onBeat); } catch { /* ignore */ }
      try { hub.emitter.removeListener('end', onEnd); } catch { /* ignore */ }
    };
    req.on('close', () => { closed = true; cleanup(); });
  });

  // ── DELETE /api/builder/sessions/:threadId ───────────────────────────────────
  app.delete('/api/builder/sessions/:threadId', requireActiveTenant, async (req, res) => {
    sessionDraft.delete(req.params.threadId);
    const { threadId } = req.params;
    const converger = sessions.get(threadId);
    if (converger) {
      try { await converger.abandon(threadId); } catch { /* ignore */ }
      sessions.delete(threadId);
    }
    closeReasoningHub(threadId);
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
        // Health counts describe the LIVE workflow, so they exclude test runs —
        // the same policy `isDoneRun` already applies to the aggregates below.
        // Without this, a workflow that has only ever been test-run shows a
        // 100% success rate under "Top workflows" and inflates the
        // platform-wide success_rate module (F14, second surface).
        const liveRuns = runs.filter(isLiveRun);
        const ok   = liveRuns.filter(r => r.status === 'success').length;
        const fail = liveRuns.filter(r => r.status === 'error').length;
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
          runCount: liveRuns.length, successCount: ok, failCount: fail,
          testRunCount: runs.length - liveRuns.length,
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
    reconcileAirtable(req.tenant.id, 'delete');   // tear down a watch nothing needs any more
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

    // A trigger nothing can run must be refused BEFORE the connector-specific
    // checks, because those only recognise their own shape — a malformed trigger
    // matches none of them and would sail through as "nothing to arm".
    {
      const runnable = checkTriggersRunnable(spec);
      if (!runnable.ok) {
        logEvent('builder.update.trigger_not_runnable', { tenant: req.tenant?.id ?? null, workflowId: id, code: runnable.code });
        return res.status(422).json({ ok: false, code: runnable.code, error: runnable.error });
      }
    }

    // Same fail-closed rule as first publish: this route IS the publish path for
    // most workflows. An edit that cannot be armed must not be accepted, or the
    // user is left with a live-looking workflow that stopped being able to fire.
    if ((spec.triggers ?? []).some(isAirtableRecordChangedTrigger)) {
      const armable = await checkAirtableTriggersArmable(spine, req.tenant.id, spec);
      if (!armable.ok) {
        logEvent('builder.update.trigger_not_armable', { tenant: req.tenant?.id ?? null, workflowId: id, code: armable.code });
        return res.status(422).json({ ok: false, code: armable.code, error: armable.error });
      }
    }

    let result;
    try {
      result = await spine.engine.workflowService.update(
        id,
        {
          name: spec.name ?? existing.name, description: spec.description, triggers: spec.triggers, nodes: spec.nodes, edges: spec.edges, errorHandling: spec.errorHandling,
          // THE CONTRACT MUST TRAVEL ON THE PUT, OR IT IS NEVER STORED AT ALL.
          //
          // This route is not the "edit an existing workflow" path it reads like —
          // it is the PUBLISH path for essentially every workflow. `_ensureDraft`
          // (public/index.html) creates the backing draft row on the FIRST message,
          // so `S.workflowId` is always set by the time the user approves, and
          // `_saveWorkflow` therefore sends PUT, not POST. The POST branch below —
          // which does carry `outcome`, via `{ ...spec }` — is close to unreachable
          // from the product.
          //
          // Omitting the key here meant `patch.outcome === undefined`, which
          // `workflowService.update` correctly reads as INHERIT; the inherited value
          // was the draft row's, and a draft row is born with no outcome. So the
          // contract was dropped on the way in, every time: 100% of stored workflows
          // had `outcome = NULL` and `spec_version = 1`, including rows the builder
          // had just displayed a contract for. That silently disabled
          // `UNSATISFIED_ASSERTION` on every subsequent edit and left the SOP with no
          // contract to render (P12 Increment C's moat and two of G's deliverables).
          //
          // `undefined` vs `null` is load-bearing and preserved: an absent key still
          // INHERITS the stored contract (so a caller that doesn't know about
          // outcomes cannot wipe one), while an explicit `null` still RETRACTS it.
          ...(spec.outcome !== undefined ? { outcome: spec.outcome } : {}),
        },
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

    // An edit can add, move or drop a watched base. Awaited, not fire-and-forget:
    // if the new trigger cannot be armed the workflow must not be left LIVE, so we
    // mark it broken and say so rather than reporting a successful publish.
    try {
      const armed = await syncAirtableWebhooksForTenant(spine, req.tenant.id);
      if (armed.failed?.length) throw new Error(armed.failed[0].error ?? 'the Airtable watch could not be created');
    } catch (e) {
      try { store.update(id, { status: 'error' }, { userId: req.user.id }); } catch { /* best-effort */ }
      logEvent('builder.update.trigger_not_armed', { tenant: req.tenant?.id ?? null, workflowId: id, error: String(e?.message ?? e) });
      return res.status(502).json({
        ok: false, code: 'TRIGGER_NOT_ARMED',
        error: 'Your changes were saved, but Atlas could not set up the Airtable watch they need — so this workflow has been marked as not running rather than left looking live. Try publishing again, or reconnect Airtable.',
      });
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
    reconcileAirtable(req.tenant.id, `status:${status}`);  // pausing must stop the watch, not just the runs
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
    const { spec, intent, testRun, threadId } = req.body ?? {};
    if (!spec?.nodes) return res.status(400).json({ error: 'spec with nodes[] is required' });

    // Capture the build's chain of thought (operator 2026-07-16) from this session's
    // reasoning buffer, to persist alongside the workflow. Best-effort — a missing
    // transcript never blocks publish.
    const buildReasoning = threadId ? reasoningTranscript(threadId) : null;

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

    // ── Refuse to publish a workflow whose trigger cannot be armed ────────────
    // Checked BEFORE anything is written, so the common failures (no base named,
    // Airtable not connected) never produce a workflow at all. 422 rather than 400:
    // the request is well-formed, the world just isn't ready for it.
    // Refused first, and for every trigger — the connector checks below only
    // recognise their own shape, so a trigger they cannot parse reads to them as
    // "nothing to arm" and publishes. That is how a workflow ends up live and
    // unable to fire.
    {
      const runnable = checkTriggersRunnable(spec);
      if (!runnable.ok) {
        logEvent('persist.trigger_not_runnable', { tenant: req.tenant?.id ?? null, code: runnable.code });
        return res.status(422).json({ ok: false, code: runnable.code, error: runnable.error });
      }
    }

    const needsAirtableWatch = (spec.triggers ?? []).some(isAirtableRecordChangedTrigger);
    if (needsAirtableWatch) {
      const armable = await checkAirtableTriggersArmable(spine, req.tenant.id, spec);
      if (!armable.ok) {
        logEvent('persist.trigger_not_armable', { tenant: req.tenant?.id ?? null, code: armable.code });
        return res.status(422).json({ ok: false, code: armable.code, error: armable.error });
      }
    }

    let result;
    try {
      result = await spine.engine.workflowService.create(
        { ...spec, userIntent: intent ?? spec.name, status: 'active', buildReasoning },
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

    // ── Arm the triggers that need something created on the OTHER side ────────
    // An Airtable "when a record changes" trigger is not live just because the
    // workflow is saved: Airtable only sends events to a webhook we asked it for.
    //
    // FAIL CLOSED (operator, 2026-07-24). If the watch cannot be set up, the
    // publish is REFUSED and the workflow is rolled back — a saved workflow that
    // says "live" and cannot fire is precisely the lie this product exists to
    // prevent, and a warning banner next to a green tick is not enough. The cheap
    // reasons were already refused above, before anything was written; this is the
    // one that can only be found by asking Airtable.
    try {
      const armed = await syncAirtableWebhooksForTenant(spine, req.tenant.id);
      if (armed.created?.length || armed.removed?.length || armed.failed?.length) {
        logEvent('persist.airtable_webhooks', {
          tenant: req.tenant.id, workflowId: result.workflow.id,
          created: armed.created?.length ?? 0, removed: armed.removed?.length ?? 0, failed: armed.failed?.length ?? 0,
        });
      }
      if (armed.failed?.length || (armed.missingBase && needsAirtableWatch)) {
        throw new Error(armed.failed?.[0]?.error ?? 'the Airtable watch could not be created');
      }
    } catch (e) {
      // Roll the publish back so no dead workflow is left behind, then reconcile
      // again so no orphan webhook is left at Airtable's end either.
      try { spine.engine.workflowStore.delete(result.workflow.id, { userId: req.user.id }); } catch { /* best-effort */ }
      syncAirtableWebhooksForTenant(spine, req.tenant.id).catch(() => {});
      logEvent('persist.airtable_arm_failed', {
        tenant: req.tenant?.id ?? null, workflowId: result.workflow.id, error: String(e?.message ?? e),
      });
      return res.status(502).json({
        ok: false, code: 'TRIGGER_NOT_ARMED',
        error: 'Atlas could not set up the Airtable watch this workflow needs, so it was not published — it would have looked live without ever running. This is usually Airtable being briefly unreachable or the connection needing renewing. Try again, or reconnect Airtable.',
      });
    }

    logEvent('persist.ok', { tenant: req.tenant?.id ?? null, workflowId: result.workflow.id, slug: result.workflow.slug });
    res.json({ ok: true, workflowId: result.workflow.id, workflow: result.workflow });
  });
}
