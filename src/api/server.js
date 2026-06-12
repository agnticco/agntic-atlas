/**
 * Atlas — API spine.
 *
 * NOT a port of the salvage `agntic-prod/src/api/server.js`. Grown deliberately
 * from the P0 thin spine; mounts only what is wired so far:
 *
 *   1. Execution engine — WorkflowStore + the full registry/validator/scheduler
 *      stack, with a local-model ModelPool injected as the engine's LLM
 *      (so `llm`/`summarize`/`rewrite`/… nodes run on open-source models).
 *   2. Auth + credential vault (better-sqlite3 stores, JWT secret, AES-256-GCM key).
 *   3. RAG for company context — local GGUF embeddings + a persistent sqlite vector
 *      store, exposed over `POST /rag/ingest` and `POST /rag/query`.
 *
 * Routes: `GET /health` (unauth), `POST /rag/ingest`, `POST /rag/query`. Deferred
 * subsystems (MCP runtime, agent-graph converger, full workflow REST/CRUD) arrive
 * in the phases that need them — grow as needed, do not bulk-port the salvage server.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { createAuthSubsystem } from '../auth/index.js';
import {
  WorkflowStore,
  SourceRegistry,
  ChannelRegistry,
  registerBuiltInChannels,
  NodeTypeRegistry,
  registerBuiltInNodeTypes,
  WorkflowValidator,
  WorkflowScheduler,
  FlowTester,
  WorkflowService,
} from '../workflows/index.js';
import { LlamaCppLLM, ModelPool, ChatModel } from '../llm/index.js';
import { EmbeddingModel, TextSplitter, VectorStore } from '../rag/index.js';
import { registerSlackChannel, createSlackCapabilityProvider } from '../connectors/slack/index.js';
import {
  createSlackOAuthFlow, storeSlackToken, getSlackToken, getSlackGrant, disconnectSlack, isOAuthConfigured,
} from '../connectors/slack/oauth.js';
import {
  googleCapabilities, resolveGoogleCapabilities, makeGoogleApi, createGoogleCapabilityProvider,
  gmailSearch, gmailGetMessage, gmailSend, gmailMarkRead,
  calendarListEvents, calendarCreateEvent,
  driveListFiles, sheetsRead, sheetsAppend, docsRead, docsCreate,
  tasksList, tasksCreate, GOOGLE_CONNECTOR_ID,
} from '../connectors/google/index.js';
import { pollGmail, formatEmailContext } from '../connectors/google/gmail-source.js';
import { InteractionStore } from '../converger/interaction-store.js';

const PORT = Number(process.env.PORT ?? 3000);
const WORKFLOWS_DB = process.env.WORKFLOWS_DB ?? './memory/workflows/workflows.sqlite';
const SOURCES_DB   = process.env.SOURCES_DB   ?? './memory/workflows/sources.sqlite';
// Base directory for per-tenant RAG stores: VECTOR_DIR/<tenantId>/company.sqlite.
const VECTOR_DIR   = process.env.VECTOR_DIR   ?? './memory/vectors';
const LOCAL_MODEL_PATH = process.env.LOCAL_MODEL_PATH
  ?? resolve('models/qwen2.5-0.5b-instruct-q4_k_m.gguf');
const EMBEDDING_PROVIDER   = process.env.EMBEDDING_PROVIDER ?? 'local';
const EMBEDDING_MODEL_PATH = process.env.EMBEDDING_MODEL_PATH
  ?? resolve('models/nomic-embed-text-v1.5.Q4_K_M.gguf');
// Auth store/key locations — env-overridable so checks can run hermetically
// against a temp dir instead of writing to ./memory. Defaults match the
// auth subsystem's own defaults.
const INTERACTIONS_DB = process.env.INTERACTIONS_DB ?? './memory/interactions.sqlite';
const AUTH_DB     = process.env.AUTH_DB     ?? './memory/auth.sqlite';
const AUTH_SECRET = process.env.AUTH_SECRET ?? './memory/.jwt-secret';
const OAUTH_DB    = process.env.OAUTH_DB    ?? './memory/oauth.sqlite';
const OAUTH_KEY   = process.env.OAUTH_KEY   ?? './memory/.oauth-key';

const ensureDir = (file) => { try { mkdirSync(dirname(file), { recursive: true }); } catch { /* ok */ } };

/** Public-safe user shape for API responses (never leaks password_hash). */
const pubUser = (u) => ({ id: u.id, email: u.email, role: u.role, tenant_id: u.tenant_id, display_name: u.display_name });

/**
 * Build the LLM pool. Priority: Anthropic (cloud) → OpenAI (cloud) → local weights.
 * Returns null only when nothing is configured — engine still boots but llm nodes
 * fail at run time with a clear message.
 */
function buildLLM() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openaiKey    = process.env.OPENAI_API_KEY?.trim();

  if (anthropicKey) {
    const fast      = new ChatModel({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: anthropicKey });
    const balanced  = new ChatModel({ provider: 'anthropic', model: 'claude-sonnet-4-6',         apiKey: anthropicKey });
    const powerful  = new ChatModel({ provider: 'anthropic', model: 'claude-sonnet-4-6',         apiKey: anthropicKey });
    return new ModelPool({ tiers: { fast, balanced, powerful }, defaultTier: 'balanced' });
  }

  if (openaiKey) {
    const fast      = new ChatModel({ provider: 'openai', model: 'gpt-4o-mini', apiKey: openaiKey });
    const balanced  = new ChatModel({ provider: 'openai', model: 'gpt-4o',      apiKey: openaiKey });
    const powerful  = new ChatModel({ provider: 'openai', model: 'gpt-4o',      apiKey: openaiKey });
    return new ModelPool({ tiers: { fast, balanced, powerful }, defaultTier: 'balanced' });
  }

  if (!existsSync(LOCAL_MODEL_PATH)) return null;
  const local = new LlamaCppLLM({ modelPath: LOCAL_MODEL_PATH, contextSize: 2048 });
  return new ModelPool({ tiers: { fast: local, balanced: local, powerful: local }, defaultTier: 'balanced' });
}

/** Construct the execution engine with `llm` (a ModelPool) injected. */
async function buildEngine(workflowStore, llm) {
  ensureDir(SOURCES_DB);
  const sourceRegistry = new SourceRegistry({ dbPath: SOURCES_DB });
  await sourceRegistry.init();

  const channelRegistry = new ChannelRegistry();
  registerBuiltInChannels(channelRegistry, {});           // in-app + webhook; mcp channel is opt-in
  registerSlackChannel(channelRegistry);                  // P1: Slack post-to-channel (chat.postMessage)

  const nodeTypeRegistry = new NodeTypeRegistry();
  registerBuiltInNodeTypes(nodeTypeRegistry);

  const workflowValidator = new WorkflowValidator({ sourceRegistry, channelRegistry, nodeTypes: nodeTypeRegistry });

  // Scheduler is constructed (FlowTester uses it for preview fetches) but NOT
  // started — the spine runs no background tick yet; scheduled triggers are P2/P7.
  const workflowScheduler = new WorkflowScheduler({ workflowStore, sourceRegistry });
  const flowTester = new FlowTester({
    sourceRegistry,
    scheduler: workflowScheduler,
    llm,
    channelRegistry,
    nodeTypes: nodeTypeRegistry,
  });
  workflowScheduler.flowTester = flowTester;

  const workflowService = new WorkflowService({
    workflowStore, nodeTypeRegistry, channelRegistry, sourceRegistry, workflowValidator, workflowScheduler,
  });

  return { workflowStore, sourceRegistry, channelRegistry, nodeTypeRegistry, workflowValidator, workflowScheduler, flowTester, workflowService, llm };
}

/**
 * Build the company-context RAG store: local GGUF embeddings + a persistent
 * sqlite vector backend. Exposes ingest()/query() used by the HTTP routes and
 * the wiring check.
 */
function buildRag() {
  // Embedder + splitter are stateless compute, shared across tenants. The vector
  // store is PHYSICALLY per tenant: each tenant's documents live in their own
  // sqlite file under VECTOR_DIR/<tenantId>/, so cross-tenant retrieval is not even
  // expressible — there is no shared table to leak from. The resolver is the
  // pluggable "connector to where a tenant's RAG data lives" (could later point at
  // a dedicated external store per tenant without changing callers).
  const embedder = new EmbeddingModel({ provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL_PATH });
  const splitter = new TextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
  const handles = new Map(); // tenantId -> { vectorStore, ingest, query, dbPath }

  function tenantDbPath(tenantId) {
    // tenantId is a constrained slug / 'platform' / 'default'; guard against any
    // path-traversal regardless.
    const safe = String(tenantId).replace(/[^a-z0-9_-]/gi, '');
    if (!safe) throw new Error('RAG requires a valid tenant');
    return join(VECTOR_DIR, safe, 'company.sqlite');
  }

  async function forTenant(tenantId) {
    if (!tenantId) throw new Error('RAG requires a tenant (refusing unscoped access)');
    const cached = handles.get(tenantId);
    if (cached) return cached;
    const dbPath = tenantDbPath(tenantId);
    ensureDir(dbPath);
    const vectorStore = new VectorStore({ sqlitePath: dbPath });
    await vectorStore.load();
    const h = {
      vectorStore,
      dbPath,
      async ingest(text, metadata = {}) {
        const chunks = await splitter._call([{ pageContent: text, metadata }]);
        const embeddings = await embedder._call(chunks.map((c) => c.pageContent));
        await vectorStore.add(chunks, embeddings);
        return chunks.length;
      },
      async query(q, k = 4) {
        const qemb = await embedder._call(q);
        return vectorStore.search(qemb, k);
      },
    };
    handles.set(tenantId, h);
    return h;
  }

  return {
    embedder, splitter, forTenant, provider: EMBEDDING_PROVIDER,
    close() { for (const h of handles.values()) { try { h.vectorStore.close?.(); } catch { /* ignore */ } } },
  };
}

/**
 * Boot every wired subsystem. Returns live handles + close(). Throws on a failed
 * boot — a failed boot must not serve traffic.
 */
export async function bootSpine() {
  ensureDir(WORKFLOWS_DB);
  const workflowStore = new WorkflowStore({ dbPath: WORKFLOWS_DB });
  await workflowStore.init();

  const auth = await createAuthSubsystem({
    dbPath: AUTH_DB, secretPath: AUTH_SECRET, oauthDbPath: OAUTH_DB, oauthKeyPath: OAUTH_KEY,
  });

  const llm = buildLLM();
  const engine = await buildEngine(workflowStore, llm);
  const rag = buildRag();
  // Slack capability provider: auto-detects the bot token's granted scopes (cached)
  // and resolves the capability map so /capabilities + the converger see only what
  // this client's workspace actually allows.
  // Wire the Gmail email poller into the scheduler so email-trigger flows fire.
  // The poller is a closure over auth (oauthTokenStore + cipher) and resolves
  // the per-tenant/per-user Google token at poll time.
  engine.workflowScheduler.registerEmailPoller(async (workflow) => {
    // Email triggers store the userId of the connected Google account in trigger.userId.
    const trigger = (workflow.triggers ?? []).find((t) => t.type === 'email');
    const userId = trigger?.userId ?? workflow.user_id;
    const tenantId = workflow.tenant_id ?? 'default';
    if (!userId) return [];
    const emails = await pollGmail({ workflow, tenantId, userId, oauthTokenStore: auth.oauthTokenStore, cipher: auth.tokenCipher });
    return emails.map(formatEmailContext); // strings — injected as initialContext
  });

  const slack = createSlackCapabilityProvider({ oauthTokenStore: auth.oauthTokenStore, apiBase: process.env.SLACK_API_URL });
  const slackOAuth = createSlackOAuthFlow();
  const google = createGoogleCapabilityProvider({ oauthTokenStore: auth.oauthTokenStore });

  const interactionStore = new InteractionStore({ dbPath: INTERACTIONS_DB });
  interactionStore.init();

  return {
    auth,
    engine,
    rag,
    slack,
    slackOAuth,
    google,
    interactionStore,
    get llm() { return engine.llm; },
    // Dispose Metal contexts/models before exit — freeing an embedding context
    // and a chat model together at process exit can trip an upstream llama.cpp
    // Metal assert (node-llama-cpp PR #17869). Ordered disposal avoids it.
    async disposeModels() {
      try { await rag.embedder.dispose?.(); } catch { /* ignore */ }
      try { await engine.llm?.tiers?.balanced?.dispose?.(); } catch { /* ignore */ }
    },
    close() {
      try { engine.workflowScheduler.stop?.(); } catch { /* ignore */ }
      try { workflowStore.close?.(); } catch { /* ignore */ }
      try { rag.close?.(); } catch { /* ignore */ }
      try { auth.close?.(); } catch { /* ignore */ }
    },
  };
}

/**
 * Build the express app around already-booted subsystems. Kept separate from
 * bootSpine() so tests can assert routes without standing up a listener.
 */
export function createApp(spine) {
  const app = express();
  app.use(cors());
  app.use(cookieParser());
  app.use(express.json({ limit: '4mb' }));

  const optionalAuth = spine.auth?.middleware?.optionalAuth ?? ((_req, _res, next) => next());
  // RAG holds company context → no anonymous access. requireAuth resolves req.tenant,
  // and every RAG call is scoped to that tenant's own physically-isolated store.
  const requireAuth = spine.auth?.middleware?.requireAuth
    ?? ((_req, res) => res.status(401).json({ error: 'Unauthorized' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version: '0.1.0',
      engine: spine.engine ? 'ok' : 'down',
      auth: spine.auth ? 'ok' : 'down',
      llm: spine.engine?.llm ? 'ready' : 'unconfigured',
      rag: spine.rag ? 'ok' : 'down',
    });
  });

  const requirePlatformAdmin = spine.auth?.middleware?.requirePlatformAdmin
    ?? ((_req, res) => res.status(403).json({ error: 'Forbidden' }));
  // requireAuth + the caller's tenant must be active (platform tenant is always active).
  const requireActiveTenant = [requireAuth, (req, res, next) => {
    if (req.tenant && !spine.auth.tenantStore.isActive(req.tenant.id)) {
      return res.status(403).json({ error: 'tenant suspended' });
    }
    next();
  }];

  // ── First-run setup (creates the platform admin) ──────────────────────────
  app.get('/setup/status', (_req, res) => {
    res.json({ required: spine.auth.userStore.countForTenant(spine.auth.platformTenantId) === 0 });
  });
  app.post('/setup', async (req, res) => {
    try {
      const { token, email, password, display_name } = req.body ?? {};
      const user = await spine.auth.completeBootstrap({ token, email, password, display_name });
      const { token: jwt } = spine.auth.issueSession({ user });
      res.json({ ok: true, token: jwt, user: pubUser(user) });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });

  // ── Login / logout ────────────────────────────────────────────────────────
  app.post('/auth/login', async (req, res) => {
    try {
      const user = await spine.auth.authProvider.authenticate({ email: req.body?.email, password: req.body?.password });
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      if (!spine.auth.tenantStore.isActive(user.tenant_id)) return res.status(403).json({ error: 'tenant suspended' });
      const { token } = spine.auth.issueSession({ user });
      res.json({ ok: true, token, user: pubUser(user) });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });
  app.post('/auth/logout', requireAuth, (req, res) => {
    try { spine.auth.sessionStore.revoke(req.session.id); } catch { /* ignore */ }
    res.json({ ok: true });
  });

  // ── Tenant management (platform operators only) ─────────────────────────────
  app.get('/tenants', requireAuth, requirePlatformAdmin, (_req, res) => {
    res.json({ tenants: spine.auth.tenantStore.list() });
  });
  app.post('/tenants', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const tenant = spine.auth.tenantStore.create({ name: req.body?.name, slug: req.body?.slug });
      let admin = null;
      const a = req.body?.admin;
      if (a?.email && a?.password) {
        admin = await spine.auth.authProvider.register({ tenantId: tenant.id, email: a.email, password: a.password, role: 'admin', display_name: a.display_name ?? '' });
      }
      res.json({ ok: true, tenant, admin: admin ? pubUser(admin) : null });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });
  app.post('/tenants/:id/users', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const t = spine.auth.tenantStore.get(req.params.id);
      if (!t) return res.status(404).json({ error: 'tenant not found' });
      const u = await spine.auth.authProvider.register({
        tenantId: t.id, email: req.body?.email, password: req.body?.password,
        role: req.body?.role === 'admin' ? 'admin' : 'user', display_name: req.body?.display_name ?? '',
      });
      res.json({ ok: true, user: pubUser(u) });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });
  app.post('/tenants/:id/status', requireAuth, requirePlatformAdmin, (req, res) => {
    try { res.json({ ok: true, tenant: spine.auth.tenantStore.setStatus(req.params.id, req.body?.status) }); }
    catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });

  // ── Users in the caller's own tenant (tenant admin) ─────────────────────────
  app.get('/users', requireActiveTenant, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    res.json({ users: spine.auth.userStore.list(req.tenant.id) });
  });

  // Ingest company context (this tenant only). Body: { text, metadata? } or { documents: [{text, metadata?}] }.
  app.post('/rag/ingest', requireActiveTenant, async (req, res) => {
    try {
      const rag = await spine.rag.forTenant(req.tenant.id);
      const docs = Array.isArray(req.body?.documents)
        ? req.body.documents
        : [{ text: req.body?.text, metadata: req.body?.metadata }];
      if (docs.some((d) => typeof d?.text !== 'string' || !d.text.trim())) {
        return res.status(400).json({ error: 'each document needs a non-empty `text`' });
      }
      let chunks = 0;
      for (const d of docs) chunks += await rag.ingest(d.text, { ...(d.metadata ?? {}), tenant_id: req.tenant.id });
      res.json({ ingested: docs.length, chunks, tenant: req.tenant.id });
    } catch (err) {
      res.status(500).json({ error: `ingest failed: ${err.message ?? String(err)}` });
    }
  });

  // Query company context (this tenant only). Body: { query, k? }.
  app.post('/rag/query', requireActiveTenant, async (req, res) => {
    try {
      const rag = await spine.rag.forTenant(req.tenant.id);
      const q = req.body?.query;
      if (typeof q !== 'string' || !q.trim()) return res.status(400).json({ error: '`query` is required' });
      const k = Number(req.body?.k ?? 4);
      const hits = await rag.query(q, k);
      res.json({
        query: q,
        hits: hits.map((h) => ({ score: h.score, content: h.pageContent, metadata: h.metadata })),
      });
    } catch (err) {
      res.status(500).json({ error: `query failed: ${err.message ?? String(err)}` });
    }
  });

  // Expose the wired capability schemas — the contract the converger (P3) targets.
  // `channels` = delivery channels; `connectors.slack` = the Slack capability map
  // resolved for THIS client's granted scopes (actions carry `available` flags).
  // "Connector/action NOT available is not usable — don't propose it."
  app.get('/capabilities', requireActiveTenant, async (req, res) => {
    try {
      const slack  = await spine.slack.resolveForTenant(req.tenant.id);
      const google = await spine.google.resolveForTenant(req.tenant.id, req.user.id);
      res.json({ channels: spine.engine.channelRegistry.getAll(), connectors: { slack, google } });
    } catch (err) {
      res.status(500).json({ error: `capabilities failed: ${err.message ?? String(err)}` });
    }
  });

  // ── Slack connector OAuth (client authorizes the Atlas app; per-tenant token) ──
  // Start the install — returns the "Add to Slack" authorize URL (UI/redirect later).
  app.get('/connectors/slack/authorize', requireActiveTenant, (req, res) => {
    try {
      if (!isOAuthConfigured()) return res.status(501).json({ error: 'Slack OAuth is not configured on this deployment' });
      const { authorizeUrl } = spine.slackOAuth.start({ tenantId: req.tenant.id, userId: req.user.id });
      res.json({ authorizeUrl });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });
  // OAuth callback. NOT auth-gated: Slack redirects the browser here; the `state`
  // (issued at /authorize, bound to a tenant) is the trust anchor. Stores the
  // workspace bot token encrypted in that tenant's vault.
  app.get('/connectors/slack/callback', async (req, res) => {
    try {
      const grant = await spine.slackOAuth.complete({ state: req.query?.state, code: req.query?.code });
      storeSlackToken({
        oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher,
        tenantId: grant.tenantId, botToken: grant.botToken, scopes: grant.scopes, account: grant.account,
      });
      spine.slack.refresh(grant.tenantId);
      res.json({ ok: true, connected: true, team: grant.account, scopes: grant.scopes });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });
  // Is Slack connected for this tenant?
  app.get('/connectors/slack/status', requireActiveTenant, (req, res) => {
    const grant = getSlackGrant({ oauthTokenStore: spine.auth.oauthTokenStore, tenantId: req.tenant.id });
    res.json({ connected: !!grant, scopes: grant?.scopes ?? [], account: grant?.account ?? null, oauthConfigured: isOAuthConfigured() });
  });
  // Disconnect this tenant's Slack install.
  app.delete('/connectors/slack', requireActiveTenant, (req, res) => {
    const removed = disconnectSlack({ oauthTokenStore: spine.auth.oauthTokenStore, tenantId: req.tenant.id });
    spine.slack.refresh(req.tenant.id);
    res.json({ ok: true, removed });
  });

  // ── Google / G-Suite connector ─────────────────────────────────────────────
  // OAuth install (reuses the generic OAuthClient with googleProviderConfig).
  app.get('/connectors/google/authorize', requireActiveTenant, (req, res) => {
    try {
      const cfg = spine.auth.oauth._provider(GOOGLE_CONNECTOR_ID);
      if (!cfg?.clientId) return res.status(501).json({ error: 'Google OAuth not configured (set GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET)' });
      const { authorizationUrl } = spine.auth.oauth.start({ userId: req.user.id, tenantId: req.tenant.id, connectorId: GOOGLE_CONNECTOR_ID });
      res.json({ authorizeUrl: authorizationUrl });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.get('/connectors/google/callback', async (req, res) => {
    try {
      // The state encodes the userId from the authorize step — extract it so
      // the callback can complete without an active session cookie.
      const pending = spine.auth.oauth._pending?.get(req.query?.state);
      const sessionUser = pending ? { id: pending.userId } : null;
      if (!sessionUser) return res.status(400).json({ error: 'Google callback: unknown or expired state — restart the connection' });
      const result = await spine.auth.oauth.handleCallback({ query: req.query, sessionUser });
      spine.google.refresh(pending.tenantId, pending.userId);
      res.json({ ok: true, connected: true, connector: 'google', account: result?.account });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.get('/connectors/google/status', requireActiveTenant, (req, res) => {
    const row = spine.auth.oauthTokenStore.get({ tenantId: req.tenant.id, userId: req.user.id, connectorId: GOOGLE_CONNECTOR_ID });
    res.json({ connected: !!row, account: row?.account ?? null, scopes: (row?.scope ?? '').split(/\s+/).filter(Boolean) });
  });
  app.delete('/connectors/google', requireActiveTenant, (req, res) => {
    const removed = spine.auth.oauthTokenStore.delete({ tenantId: req.tenant.id, userId: req.user.id, connectorId: GOOGLE_CONNECTOR_ID });
    spine.google.refresh(req.tenant.id, req.user.id);
    res.json({ ok: true, removed });
  });

  // G-Suite action routes — each mirrors a capability map action.
  // All require auth; the Google token is resolved per (tenant, user).
  function gapi(req) {
    return makeGoogleApi({ oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId: req.tenant.id, userId: req.user.id });
  }

  app.post('/google/gmail/search',    requireActiveTenant, async (req, res) => { try { res.json(await gmailSearch(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/gmail/get',       requireActiveTenant, async (req, res) => { try { res.json(await gmailGetMessage(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/gmail/send',      requireActiveTenant, async (req, res) => { try { res.json(await gmailSend(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/gmail/mark-read', requireActiveTenant, async (req, res) => { try { res.json(await gmailMarkRead(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/calendar/events', requireActiveTenant, async (req, res) => { try { res.json(await calendarListEvents(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/calendar/create', requireActiveTenant, async (req, res) => { try { res.json(await calendarCreateEvent(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/drive/files',     requireActiveTenant, async (req, res) => { try { res.json(await driveListFiles(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/sheets/read',     requireActiveTenant, async (req, res) => { try { res.json(await sheetsRead(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/sheets/append',   requireActiveTenant, async (req, res) => { try { res.json(await sheetsAppend(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/docs/read',       requireActiveTenant, async (req, res) => { try { res.json(await docsRead(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/docs/create',     requireActiveTenant, async (req, res) => { try { res.json(await docsCreate(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/tasks/list',      requireActiveTenant, async (req, res) => { try { res.json(await tasksList(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/google/tasks/create',    requireActiveTenant, async (req, res) => { try { res.json(await tasksCreate(gapi(req), req.body)); } catch (e) { res.status(500).json({ error: e.message }); } });

  // G-Suite capabilities (per user, since Google tokens are per-user not per-tenant bot).
  app.get('/connectors/google/capabilities', requireActiveTenant, async (req, res) => {
    try {
      const resolved = await spine.google.resolveForTenant(req.tenant.id, req.user.id);
      res.json(resolved);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Interaction log ───────────────────────────────────────────────────────
  // Tenant-scoped: own sessions only.
  // Platform-admin: all tenants via ?tenant_id= filter or unfiltered.

  app.get('/interactions', requireAuth, (req, res) => {
    try {
      const isPlatformAdmin = req.user?.role === 'admin' && req.user?.tenant_id === spine.auth.platformTenantId;
      if (isPlatformAdmin) {
        const { tenant_id, limit = 200, offset = 0 } = req.query;
        return res.json({ sessions: spine.interactionStore.listAllSessions({ tenantId: tenant_id, limit: Number(limit), offset: Number(offset) }) });
      }
      if (!req.tenant) return res.status(403).json({ error: 'Unauthorized' });
      const { limit = 50, offset = 0 } = req.query;
      res.json({ sessions: spine.interactionStore.listSessions(req.tenant.id, { limit: Number(limit), offset: Number(offset) }) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/interactions/:sessionId', requireAuth, (req, res) => {
    try {
      const tenantId = req.tenant?.id;
      if (!tenantId) return res.status(403).json({ error: 'Unauthorized' });
      const session = spine.interactionStore.getSession(tenantId, req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'not found' });
      const events  = spine.interactionStore.getEvents(tenantId, req.params.sessionId);
      res.json({ session, events });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Platform-admin: aggregate signals for closed-loop inference.
  app.get('/interactions/signals', requireAuth, requirePlatformAdmin, (req, res) => {
    try {
      const { since = 0, tenant_id } = req.query;
      res.json(spine.interactionStore.querySignals({ since: Number(since), tenantId: tenant_id }));
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Run a hand-authored spec through the engine — the "click run" path (no UI yet).
  // Body: { spec } where spec is the proprietary { name, nodes[], edges[], … } shape.
  app.post('/workflows/run', optionalAuth, async (req, res) => {
    let spec = req.body?.spec;
    if (!spec || !Array.isArray(spec.nodes)) {
      return res.status(400).json({ error: 'body.spec with a nodes[] array is required' });
    }
    // If authenticated, run in the caller's tenant: inject that tenant's stored
    // Slack OAuth token into slack deliver nodes (so the workflow posts as the
    // tenant's connected workspace, not a shared env token). Unauthenticated runs
    // fall back to the dev env token in the channel handler.
    if (req.tenant) {
      const tok = getSlackToken({ oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId: req.tenant.id });
      if (tok) {
        spec = { ...spec, nodes: spec.nodes.map((n) =>
          (n?.type === 'deliver' && String(n?.config?.channel ?? '').startsWith('slack') && !n?.config?.token)
            ? { ...n, config: { ...n.config, token: tok.botToken } } : n) };
      }
    }
    try {
      let runId = null, completed = false, output = null;
      const steps = [];
      for await (const ev of spine.engine.flowTester.run(spec, {})) {
        if (ev.type === 'run_started') runId = ev.runId;
        else if (ev.type === 'step_completed') steps.push({ nodeId: ev.nodeId, output: ev.output });
        else if (ev.type === 'run_completed') { completed = true; output = ev.output; }
        else if (ev.type === 'run_failed') return res.status(502).json({ runId, error: ev.error, steps });
      }
      // step_completed outputs are shrunk to strings by the executor; coerce back
      // to objects so delivery results (e.g. the Slack { delivered, ts }) surface.
      const coerce = (o) => {
        if (o && typeof o === 'object') return o;
        if (typeof o === 'string') { try { return JSON.parse(o); } catch { /* not json */ } }
        return null;
      };
      const deliveries = steps.map((s) => coerce(s.output)).filter((o) => o && o.delivered);
      res.json({ runId, completed, output, deliveries, steps });
    } catch (err) {
      res.status(500).json({ error: `run failed: ${err.message ?? String(err)}` });
    }
  });

  return app;
}

export async function start() {
  const spine = await bootSpine();
  const app = createApp(spine);

  const server = app.listen(PORT, () => {
    const llmState = !spine.engine.llm ? 'no-model'
      : process.env.ANTHROPIC_API_KEY ? 'anthropic'
      : process.env.OPENAI_API_KEY    ? 'openai'
      : 'local-model';
    console.log(`atlas spine listening on :${PORT} (engine ok, auth ok, llm ${llmState}, rag ${spine.rag.provider})`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} — shutting down`);
    server.close(async () => { await spine.disposeModels(); spine.close(); process.exit(0); });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, spine };
}

// Boot when run directly (`npm start`), not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error('spine failed to boot:', err);
    process.exit(1);
  });
}
