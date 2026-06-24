/**
 * Builder API — HTTP surface for the converger-driven P4 builder UI.
 *
 * Mounted via mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth })
 * inside createApp(). Each route is auth-gated at the requireActiveTenant level.
 *
 * Session lifecycle:
 *   POST /api/builder/sessions          — start a converger session
 *   POST /api/builder/sessions/:id/respond — send accept/reject/modify/clarify/approve
 *   DELETE /api/builder/sessions/:id    — abandon
 *
 * Workflow persistence:
 *   POST /api/builder/workflows         — create + activate a converger-emitted spec
 *
 * Identity:
 *   GET  /api/builder/me                — current user + tenant (for the UI header)
 */

import { createConverger } from '../converger/index.js';
import { GraphInterrupt }  from '../graph/index.js';
import { SystemMessage, HumanMessage } from '../core/message.js';
import { logEvent, errFields } from '../utils/event-log.js';
import { channelIdForCapability } from '../connectors/slack/index.js';
import { webConnectionStatus } from '../connectors/web/index.js';

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
    try {
      const body = JSON.parse(m[2]);
      const type = body?.error?.type;
      if (type === 'api_error' || type === 'overloaded_error') {
        return 'The AI service is temporarily unavailable. Please try again in a moment.';
      }
      if (body?.error?.message) return body.error.message;
    } catch { /* fall through */ }
  }
  return err?.message ?? raw;
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

function pubUser(u) {
  return { id: u.id, email: u.email, display_name: u.display_name ?? u.email, role: u.role };
}

// Build the conversational system prompt with live connector context injected.
// connectorLines: string[] of "- ConnectorName: what it can do" per connected connector.
function buildChatSystem(connectorLines = []) {
  const connectorBlock = connectorLines.length
    ? `\nConnectors this workspace has connected:\n${connectorLines.join('\n')}`
    : `\nNo connectors are connected yet. If asked, say none are set up and suggest visiting Connections in the sidebar.`;

  return `You are Atlas, a warm assistant for non-technical business operators. You help people automate repetitive work — but you are also happy to just chat, answer questions, or think an idea through.

OUTPUT FORMAT — you MUST respond with valid JSON every time, no exceptions, no markdown fences:
{"reply":"<your message to the user>","ready_to_build":false,"build_intent":null}

The "reply" field is your natural conversational response. Everything you want to say goes there. Nothing goes outside the JSON.

BEHAVIOR:
- Tone: natural, concise, friendly — like a helpful colleague. Match the user's register.
- Small talk and general questions: answer them normally inside "reply".
- Don't pressure the user to build. If they just want to chat, just chat.
- When they describe automation: explore ONE question at a time — trigger (what starts it?), processing, destination. Don't dump a list of fields.
- FILE ACCESS: if the intent involves reading files, documents, PDFs, or attachments — check the connectors list. If Filesystem is listed, name the folder. If not, surface the gap before building: e.g. "To read that file in the workflow you'd need a folder connected under Knowledge. Set that up first?"
- ready_to_build stays false until the user clearly signals they want to build (e.g. "let's do it", "set it up", "yes, build it", "go ahead"). At that point set ready_to_build:true and write build_intent: one clear paragraph covering trigger + steps + destination, folding in everything discussed.
- If they seem close but haven't confirmed, gently offer ("Want me to set this up?") but keep ready_to_build:false.
${connectorBlock}`;
}

// Tolerant JSON extraction: strip code fences, else grab the first {...} block.
function extractJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const obj = text.match(/\{[\s\S]*\}/);
  return obj ? obj[0] : text.trim();
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
async function introMessage(spine, intent) {
  try {
    const llm = spine.llm;
    const t = llm?.tiers?.fast ?? llm?.tiers?.balanced ?? llm;
    if (!t?.invoke) return null;
    const sys = new SystemMessage(
      'You are Atlas, a warm, plain-spoken assistant that builds automations by talking with non-technical business operators. Never use technical jargon.');
    const user = new HumanMessage(
      `The user wants to automate: "${intent}".\n\nReply with ONE short, friendly sentence (max ~20 words) that acknowledges what you'll help them set up and signals you'll go one step at a time. No opener like "Sure"/"Great", no lists, no quotes — just the sentence.`);
    const res = await t.invoke([sys, user]);
    const text = (typeof res === 'string' ? res : res?.content ?? '').trim();
    return text || null;
  } catch { return null; }
}

export function mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth, readSources }) {

  // ── GET /api/builder/me ──────────────────────────────────────────────────────
  app.get('/api/builder/me', requireAuth, (req, res) => {
    res.json({ user: pubUser(req.user), tenant: { id: req.tenant.id, name: req.tenant.name } });
  });

  // ── GET /api/builder/greeting ────────────────────────────────────────────────
  // Returns a fresh, varied opening message for every new builder session.
  // Fast tier — called on app load and on "New workflow", so latency matters.
  app.get('/api/builder/greeting', requireActiveTenant, async (req, res) => {
    const FALLBACK = "Hey, I'm Atlas. I can help you automate things — or we can just talk it through first. What's on your mind?";
    try {
      const llm = spine.llm;
      const t = llm?.tiers?.fast ?? llm?.tiers?.balanced ?? llm;
      if (!t?.invoke) return res.json({ ok: true, greeting: FALLBACK });

      const name = (req.user?.display_name || '').trim().split(/\s+/)[0] || null;

      const raw = await t.invoke([
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
      ]);

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
  // Returns: { reply, readyToBuild, buildIntent }
  app.post('/api/builder/chat', requireActiveTenant, async (req, res) => {
    const { messages } = req.body ?? {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages[] is required' });
    }
    try {
      const llm = spine.llm;
      const t = llm?.tiers?.balanced ?? llm?.tiers?.fast ?? llm;
      if (!t?.invoke) return res.status(503).json({ error: 'LLM unavailable' });

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
      try {
        const sl  = await spine.slack.resolveForTenant(req.tenant.id);
        const go  = await spine.google.resolveForTenant(req.tenant.id, req.user.id);
        const at  = spine.airtable.resolveForTenant(req.tenant.id);
        const web = webConnectionStatus();

        const connectedSet = new Set();
        if (sl.connected)  connectedSet.add('slack');
        if (go.connected)  connectedSet.add('google');
        if (at.connected)  connectedSet.add('airtable');
        if (web.connected) connectedSet.add('web');

        connectorLines.push(...connectorLinesFromRegistry(spine.engine.capabilityRegistry, connectedSet));

        // Filesystem: not in the CapabilityRegistry (sandboxed by tenant folder list), add manually.
        const fsSources = (readSources?.(req.tenant.id) ?? []).filter(s => s.path?.startsWith('/'));
        if (fsSources.length) {
          const names = fsSources.map(s => s.path.split('/').pop()).join(', ');
          connectorLines.push(`- Filesystem: read files from approved folders (${names})`);
        }
      } catch { /* non-fatal */ }

      // Retrieve relevant knowledge base + inbox context via RAG.
      let ragBlock = '';
      try {
        const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content ?? '';
        if (lastUserMsg) {
          const rag  = await spine.rag.forTenant(req.tenant.id);
          const hits = await rag.query(lastUserMsg, 6);
          const useful = (hits ?? []).filter(h => (h.score ?? 0) > 0.25).slice(0, 4);
          if (useful.length) {
            const ctx = useful.map(h => {
              const label = h.metadata?.subject || h.metadata?.source_path || h.metadata?.source || 'source';
              return `[${label}]\n${h.pageContent ?? h.content ?? ''}`;
            }).join('\n\n---\n\n');
            ragBlock = `\n\nRelevant content retrieved from the knowledge base and inbox:\n${ctx}`;
          }
        }
      } catch { /* non-fatal */ }

      const raw = await withLLMRetry(() => t.invoke([{ role: 'system', content: buildChatSystem(connectorLines) + ragBlock }, ...history]));
      const text = (typeof raw === 'string' ? raw : raw?.content ?? '').trim();

      let parsed = null;
      try { parsed = JSON.parse(extractJsonLoose(text)); } catch { /* fall through */ }
      if (parsed && typeof parsed.reply === 'string') {
        logEvent('chat.reply', { tenant: req.tenant?.id ?? null, turns: messages.length, readyToBuild: !!parsed.ready_to_build });
        return res.json({
          reply: parsed.reply,
          readyToBuild: !!parsed.ready_to_build,
          buildIntent: (typeof parsed.build_intent === 'string' && parsed.build_intent.trim()) ? parsed.build_intent.trim() : null,
        });
      }
      // Model didn't return our JSON envelope — treat its text as a plain reply.
      logEvent('chat.reply', { tenant: req.tenant?.id ?? null, turns: messages.length, parsed: false });
      return res.json({ reply: text || "I'm here — what would you like to work on?", readyToBuild: false, buildIntent: null });
    } catch (err) {
      logEvent('chat.error', { tenant: req.tenant?.id ?? null, ...errFields(err) });
      res.status(500).json({ error: cleanLLMError(err) });
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
      const t = llm?.tiers?.fast ?? llm;
      if (!t?.invoke) return res.status(503).json({ error: 'LLM unavailable' });

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

      const raw = await withLLMRetry(() => t.invoke([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Summarize this test run:\n\n${ctx}` },
      ]));
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

    // Generate the conversational opener in parallel with the converger's first
    // turn so it costs no extra wall-clock.
    const introP = introMessage(spine, intent);

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
      // Scope-aware, position-tagged catalog: only what this tenant can actually run.
      capabilities.channels   = annotateChannelCatalog(spine.engine.channelRegistry.getAll(), { slack, google, airtable });
      // Narrow triggers to connected connectors only.
      const connectedIds = new Set(['slack', 'google'].filter(id => id === 'slack' ? slack : google));
      if (airtable.connected) connectedIds.add('airtable');
      if (web.connected)      connectedIds.add('web');
      capabilities.triggers = spine.engine.capabilityRegistry
        .list({ position: 'trigger' })
        .map(t => ({ ...t, available: t.available && (!t.connector || connectedIds.has(t.connector)) }));

      // Filesystem: pass connected folder names so the converger can reference
      // them by name and knows whether to ask for a clarification.
      const fsSources = (readSources?.(req.tenant.id) ?? []).filter(s => s.path?.startsWith('/'));
      capabilities.filesystem = fsSources.map(s => s.path.split('/').pop());
    } catch { /* non-fatal — converger still works with empty capabilities */ }

    const threadId  = `build-${req.tenant.id}-${Date.now()}`;
    const converger = createConverger({
      llm:              spine.llm,
      capabilities,
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

    res.json({ connectors, users });
  });

  // ── POST /api/builder/sessions/:threadId/respond ─────────────────────────────
  // Send a response to the current interrupt.
  // Body: { type: 'accept'|'reject'|'modify'|'clarification'|'approve'|'request_changes', ... }
  // Returns: the next interrupt payload, or { type: 'done', spec, confirmationLog }
  app.post('/api/builder/sessions/:threadId/respond', requireActiveTenant, async (req, res) => {
    const { threadId } = req.params;
    const converger = sessions.get(threadId);
    if (!converger) return res.status(404).json({ error: 'session not found or already complete' });

    let result;
    try {
      result = await converger.resume(threadId, req.body);
    } catch (err) {
      logEvent('respond.error', { tenant: req.tenant?.id ?? null, threadId, sent: req.body?.type, ...errFields(err) });
      return res.status(500).json({ error: err.message ?? String(err) });
    }

    logEvent('respond.ok', { tenant: req.tenant?.id ?? null, threadId, sent: req.body?.type, interrupt: result?.type });
    if (result?.type === 'done') sessions.delete(threadId);
    res.json(result);
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

      // Build enriched workflow objects once — shared across modules.
      const workflows = wfs.map(wf => {
        const runs = store.getRuns(wf.id, 20, { userId, tenantId }) || [];
        const ok   = runs.filter(r => r.status === 'success').length;
        const fail = runs.filter(r => r.status === 'error').length;
        const last = runs[0] ?? null;
        const trg  = (wf.triggers || [])[0] ?? null;
        return {
          id: wf.id, name: wf.name || wf.user_intent || 'Untitled',
          status: wf.status,
          trigger: trg?.label || trg?.type || 'manual',
          triggerType: trg?.type || 'manual',
          schedule: trg?.schedule || trg?.cron || null,
          runCount: runs.length, successCount: ok, failCount: fail,
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

      // ── LLM tier for fast calls ──────────────────────────────────────────
      const llm = spine.llm;
      const t   = llm?.tiers?.fast ?? llm?.tiers?.balanced ?? llm;
      const llmJson = async (prompt) => {
        if (!t?.invoke) return null;
        const raw = await t.invoke([
          new SystemMessage('You are Atlas. Return only valid JSON — no markdown, no extra text.'),
          new HumanMessage(prompt),
        ]).catch(() => null);
        const text = (typeof raw === 'string' ? raw : raw?.content ?? '').trim();
        try {
          const j = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim() ?? text.match(/\{[\s\S]*\}/)?.[0] ?? text;
          return JSON.parse(j);
        } catch { return null; }
      };

      // ── Compute all modules in parallel where possible ───────────────────
      const wfLines = workflows.length
        ? workflows.map(w => `  - "${w.name}" [${w.status}] trigger:${w.trigger} runs:${w.runCount} failures:${w.failCount}${w.lastRunAt ? ' last:' + new Date(w.lastRunAt).toLocaleDateString() : ''}`).join('\n')
        : '  (no workflows yet)';

      const [greetingData, tipData, alertData] = await Promise.all([
        // ai_greeting
        llmJson(
          `User: ${userName}, good ${tod}\nActive: ${activeWfs.length}, total runs: ${totalRuns}, failed last runs: ${failedWfs.length}\nWorkflows:\n${wfLines}\n\nReturn JSON:\n{"greeting":"<warm personal greeting, 1 sentence, reference something specific about their automations>","headline":"<1 compelling observation about their automation activity>"}`
        ),
        // ai_tip
        workflows.length
          ? llmJson(`User ${userName} has these workflows:\n${wfLines}\n\nReturn JSON with one actionable tip to improve their automation setup:\n{"tip":"<1-2 sentence specific, actionable suggestion>"}`)
          : Promise.resolve(null),
        // failure_alerts
        failedWfs.length
          ? llmJson(`These workflows last ran with errors:\n${failedWfs.map(w => `  - "${w.name}": ${w.lastError || 'unknown error'}`).join('\n')}\n\nReturn JSON:\n{"summary":"<1-2 sentence overview of the failures and a suggested next step>"}`)
          : Promise.resolve(null),
      ]);

      // ── Collect recent activity across all workflows ──────────────────────
      const allRuns = workflows.flatMap(w =>
        w.recentRuns.map(r => ({ workflowName: w.name, workflowId: w.id, status: r.status, at: r.started_at }))
      ).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);

      // ── Assemble module payloads ──────────────────────────────────────────
      const successRate = totalRuns > 0 ? Math.round((totalOk / totalRuns) * 100) : null;
      const timeSavedMins = totalRuns * 3; // 3 min saved per automated run

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
        time_saved: {
          minutes: timeSavedMins,
          display: timeSavedMins >= 60
            ? (timeSavedMins / 60 < 10 ? (timeSavedMins / 60).toFixed(1) : Math.round(timeSavedMins / 60)) + ' hrs'
            : timeSavedMins + ' min',
        },
        ai_tip: tipData ?? { tip: 'Add more workflows to see personalized tips here.' },
      };

      logEvent('home.ok', { tenant: tenantId, wfCount: workflows.length });
      res.json({ ok: true, user: { name: userName, email: req.user.email }, workflows, modules });
    } catch (err) {
      logEvent('home.error', errFields(err));
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
      const t = llm?.tiers?.balanced ?? llm?.tiers?.fast ?? llm;
      if (!t?.invoke) return res.status(503).json({ error: 'LLM unavailable' });

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

      const raw = await t.invoke([
        new SystemMessage(
          `You are Atlas, a workflow automation assistant. You receive a workflow spec (JSON) and a user's change request and return an updated spec.\n\nWorkflow spec format:\n- triggers[]: array of trigger objects (type, config, label)\n- nodes[]: array of step objects (id, type, label, config). Types: summarize, llm, extract, rewrite, connector-action, deliver\n- edges[]: array of {from, to} connections\n\n${capCtx}\n\nRules:\n- Apply ONLY what the user asked for. Don't restructure unrelated parts.\n- Preserve all existing node ids, edge connections, and config fields not mentioned in the change.\n- For schedule triggers, config.cron is a cron expression (e.g. "0 6 * * *" = 6am daily), config.timezone is a tz name (e.g. "America/Chicago"), config.label is a human label.\n- For llm/summarize nodes, config.instructions is the prompt.\n- For deliver nodes, config.channel MUST be one of the AVAILABLE DELIVERY CHANNEL IDs — use the alias table to map plain-English requests to the right id. NEVER invent a channel id.\n- For connector-action nodes, config.action MUST be one of the AVAILABLE STEP ACTIONS.\n- If the user requests a delivery method or step action that is UNAVAILABLE or not listed, keep the relevant node UNCHANGED and explain specifically what connector or scope is needed to enable it.\n- Return ONLY valid JSON with exactly this shape: {"explanation":"<one sentence describing what you changed>","spec":{...updated spec...}}\n- No markdown fences, no extra text.`
        ),
        new HumanMessage(
          `Current spec:\n${specSummary}\n\nChange request: "${change}"\n\nReturn the updated spec as JSON.`
        ),
      ]);

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
      const t = llm?.tiers?.fast ?? llm?.tiers?.balanced ?? llm;
      if (!t?.invoke) return res.status(503).json({ error: 'LLM unavailable' });

      const name      = workflow.name || workflow.user_intent || 'this workflow';
      const trigger   = (workflow.triggers || []).map(tr => tr.label || tr.type).filter(Boolean).join(', ') || 'unknown trigger';
      const steps     = (workflow.nodes || []).map(n => n.label || n.type).filter(Boolean).join(' → ') || 'no steps configured';
      const status    = workflow.status || 'unknown';

      const raw = await t.invoke([
        new SystemMessage('You are Atlas, a warm assistant helping non-technical operators manage their automations. Be concise, specific, and conversational — no lists, no bullet points.'),
        new HumanMessage(
          `You are reviewing a workflow the user wants to edit.\n\nName: "${name}"\nTrigger: ${trigger}\nSteps: ${steps}\nStatus: ${status}\n\nWrite ONE short message (2–3 sentences) that: briefly describes what this workflow does in plain language, then invites the user to tell you what to change, fix, or add. Be specific to THIS workflow — not generic. Do not start with "Sure", "Great", or similar filler.`
        ),
      ]);
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
          store.completeRun(run.id, testRun.output ?? null);
        } else {
          store.failRun(run.id, testRun.error || 'Test failed');
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
        name: 'New workflow', nodes: [], edges: [], triggers: [],
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

  // ── POST /api/builder/workflows ──────────────────────────────────────────────
  // Persist and activate a converger-emitted spec as a real workflow.
  // Body: { spec, intent }
  // Returns: { ok, workflowId } or { ok: false, error }
  app.post('/api/builder/workflows', requireActiveTenant, async (req, res) => {
    const { spec, intent, testRun } = req.body ?? {};
    if (!spec?.nodes) return res.status(400).json({ error: 'spec with nodes[] is required' });

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

    // Retroactively log the builder test run under the new workflowId.
    if (testRun && (testRun.status === 'success' || testRun.status === 'error')) {
      try {
        const store = spine.engine.workflowStore;
        const run = store.startRun(result.workflow.id, { isTest: true });
        for (const step of (testRun.steps || [])) store.appendStep(run.id, step);
        if (testRun.status === 'success') {
          store.completeRun(run.id, testRun.output ?? null);
        } else {
          store.failRun(run.id, testRun.error || 'Test failed');
        }
      } catch (e) { /* non-fatal — run logged best-effort */ }
    }

    logEvent('persist.ok', { tenant: req.tenant?.id ?? null, workflowId: result.workflow.id, slug: result.workflow.slug });
    res.json({ ok: true, workflowId: result.workflow.id, workflow: result.workflow });
  });
}
