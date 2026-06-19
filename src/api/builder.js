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

// Project a connector's scope-aware action availability onto the channel catalog
// and tag each channel with the workflow positions it can occupy, so the converger
// only ever offers capabilities THIS tenant's granted scopes can actually run.
function annotateChannelCatalog(channels, slackResolved) {
  // Only narrow availability when we actually KNOW the tenant's granted scopes.
  // If scope detection returned nothing (no token / probe failed), fail OPEN —
  // keep the channel's global availability rather than blocking all building.
  const haveScopeInfo = (slackResolved?.grantedScopes ?? []).length > 0;
  const slackAvail = {};
  if (haveScopeInfo) {
    for (const a of slackResolved?.actions ?? []) {
      slackAvail[channelIdForCapability(a.id)] = { available: a.available, reason: a.unavailableReason };
    }
  }
  return (channels ?? []).map(c => {
    const positions = c.actionOnly ? ['step'] : ['step', 'delivery'];
    const sa = slackAvail[c.id];
    if (!sa) return { ...c, positions };
    return { ...c, positions, available: c.available && sa.available, unavailableReason: sa.reason ?? c.unavailableReason };
  });
}

// In-process session map: threadId → converger instance.
// Sessions are short-lived (one building conversation), so in-memory is correct.
const sessions = new Map();

function pubUser(u) {
  return { id: u.id, email: u.email, display_name: u.display_name ?? u.email, role: u.role };
}

// The conversational agent's system prompt. It must feel like a colleague, not a
// form — and it must NOT push the user toward building until they're ready.
const CHAT_SYSTEM = `You are Atlas, a warm, down-to-earth assistant for non-technical business operators. You help people automate repetitive work — but you are also happy to just talk, answer questions, or think an idea through with them.

How to behave:
- Talk like a helpful colleague: natural, concise, and friendly. Match the user's tone. Small talk and general questions are welcome — answer them normally.
- NEVER pressure the user to build a workflow. If they greet you or ask something, just respond. The user may only want to chat.
- When they describe something they want to automate, help them think it through in conversation — gently explore the trigger (what starts it), the steps, and where the result should go, ONE easy question at a time. Don't dump a form or a list of fields on them.
- Atlas can automate things like: watching email/Gmail, running on a schedule, summarizing or rewriting text with AI, extracting information, and delivering results to Slack or email. If asked for something out of scope, say so kindly and suggest the closest thing.
- Only when the user has described an automation AND clearly signals they are ready to build it (e.g. "let's build it", "set that up", "yes, make it", "go ahead") do you set ready_to_build=true and write build_intent: a single clear paragraph capturing the trigger, the processing steps, and the destination, in plain language, folding in everything discussed so far.
- If they seem close but have not confirmed, you may gently offer ("Want me to set this up?") but keep ready_to_build=false until they say yes.

Return ONLY JSON, no markdown fences, no text outside it:
{"reply":"<your natural message to the user>","ready_to_build":<true|false>,"build_intent":<string or null>}`;

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

export function mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth }) {

  // ── GET /api/builder/me ──────────────────────────────────────────────────────
  app.get('/api/builder/me', requireAuth, (req, res) => {
    res.json({ user: pubUser(req.user), tenant: { id: req.tenant.id, name: req.tenant.name } });
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

      const history = messages.slice(-24)
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content }));

      const raw = await t.invoke([{ role: 'system', content: CHAT_SYSTEM }, ...history]);
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
      res.status(500).json({ error: err.message ?? String(err) });
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
      const slack  = await spine.slack.resolveForTenant(req.tenant.id);
      const google = await spine.google.resolveForTenant(req.tenant.id, req.user.id);
      capabilities.connectors = { slack, google };
      // Scope-aware, position-tagged catalog: only what this tenant can actually run.
      capabilities.channels   = annotateChannelCatalog(spine.engine.channelRegistry.getAll(), slack);
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

  // ── POST /api/builder/workflows ──────────────────────────────────────────────
  // Persist and activate a converger-emitted spec as a real workflow.
  // Body: { spec, intent }
  // Returns: { ok, workflowId } or { ok: false, error }
  app.post('/api/builder/workflows', requireActiveTenant, async (req, res) => {
    const { spec, intent } = req.body ?? {};
    if (!spec?.nodes) return res.status(400).json({ error: 'spec with nodes[] is required' });

    let result;
    try {
      result = await spine.engine.workflowService.create(
        { ...spec, userIntent: intent ?? spec.name },
        { userId: req.user.id },
      );
    } catch (err) {
      logEvent('persist.error', { tenant: req.tenant?.id ?? null, ...errFields(err) });
      return res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }

    if (!result.ok) {
      logEvent('persist.invalid', { tenant: req.tenant?.id ?? null, error: result.error, issues: (result.issues ?? []).map(i => i.code) });
      return res.status(400).json({ ok: false, error: result.error, issues: result.issues });
    }
    logEvent('persist.ok', { tenant: req.tenant?.id ?? null, workflowId: result.workflow.id, slug: result.workflow.slug });
    res.json({ ok: true, workflowId: result.workflow.id, workflow: result.workflow });
  });
}
