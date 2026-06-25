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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

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
import { CapabilityRegistry } from '../connectors/capability-registry.js';
import { LlamaCppLLM, ModelPool, ChatModel, CostTracker } from '../llm/index.js';
import { EmbeddingModel, TextSplitter, VectorStore, DocumentLoader } from '../rag/index.js';
import { registerSlackChannel, registerSlackTriggers, createSlackCapabilityProvider } from '../connectors/slack/index.js';
import {
  createSlackOAuthFlow, storeSlackToken, getSlackToken, getSlackGrant, disconnectSlack, isOAuthConfigured,
} from '../connectors/slack/oauth.js';
import {
  googleCapabilities, resolveGoogleCapabilities, makeGoogleApi, makeGoogleApiFromToken,
  createGoogleCapabilityProvider, registerGoogleChannels,
  gmailSearch, gmailGetMessage, gmailSend, gmailMarkRead,
  calendarListEvents, calendarCreateEvent,
  driveListFiles, sheetsRead, sheetsAppend, docsRead, docsCreate,
  tasksList, tasksCreate, GOOGLE_CONNECTOR_ID, getGoogleAccessToken,
} from '../connectors/google/index.js';
import { pollGmail, formatEmailContext } from '../connectors/google/gmail-source.js';
import {
  makeAirtableApi,
  registerAirtableChannels, registerWebhookRoute, unregisterWebhookRoute,
  lookupWebhook, allWebhooks as _airtableWebhooks, initWebhookStore, verifyAirtableSignature,
  createAirtableWebhook, deleteAirtableWebhook, fetchWebhookPayloads,
} from '../connectors/airtable/index.js';
import {
  AIRTABLE_CONNECTOR_ID,
  airtableOAuthConfig, isAirtableOAuthConfigured, createAirtableOAuthFlow,
  storeAirtableToken, getAirtableToken, getAirtableAccessToken,
  isAirtableConnected, getAirtableGrant, disconnectAirtable,
  createAirtableCapabilityProvider,
} from '../connectors/airtable/oauth.js';
import { InteractionStore } from '../converger/interaction-store.js';
import { InboxStore } from '../inbox/inbox-store.js';
import { registerInboxCapability, INBOX_CAPABILITY_IDS } from '../inbox/index.js';
import { registerFilesystemCapabilities, FILESYSTEM_CAPABILITY_IDS } from '../connectors/filesystem.js';
import { registerWebCapabilities, webConnectionStatus, WEB_CAPABILITY_IDS } from '../connectors/web/index.js';
import { mountBuilderRoutes } from './builder.js';
import { mountConsoleRoutes } from './console.js';
import { mountAdminRoutes } from '../admin/server.js';
import { logEvent, errFields } from '../utils/event-log.js';

const PORT = Number(process.env.PORT ?? 3000);
const WORKFLOWS_DB = process.env.WORKFLOWS_DB ?? './memory/workflows/workflows.sqlite';
const SOURCES_DB   = process.env.SOURCES_DB   ?? './memory/workflows/sources.sqlite';
// Base directory for per-tenant RAG stores: VECTOR_DIR/<tenantId>/company.sqlite.
const VECTOR_DIR   = process.env.VECTOR_DIR   ?? './memory/vectors';

// Per-tenant sources.json helpers — module-level so both bootSpine (filesystem
// connector registration) and createApp (RAG knowledge routes) can call them.
function sourcesPath(tenantId) {
  const safe = String(tenantId).replace(/[^a-z0-9_-]/gi, '');
  return join(VECTOR_DIR, safe, 'sources.json');
}
function readSources(tenantId) {
  const p = sourcesPath(tenantId);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}
const LOCAL_MODEL_PATH = process.env.LOCAL_MODEL_PATH
  ?? resolve('models/qwen2.5-0.5b-instruct-q4_k_m.gguf');
const EMBEDDING_PROVIDER   = process.env.EMBEDDING_PROVIDER ?? 'local';
const EMBEDDING_MODEL_PATH = process.env.EMBEDDING_MODEL_PATH
  ?? resolve('models/nomic-embed-text-v1.5.Q4_K_M.gguf');
// Auth store/key locations — env-overridable so checks can run hermetically
// against a temp dir instead of writing to ./memory. Defaults match the
// auth subsystem's own defaults.
const INTERACTIONS_DB       = process.env.INTERACTIONS_DB       ?? './memory/interactions.sqlite';
const AIRTABLE_WEBHOOKS_FILE = process.env.AIRTABLE_WEBHOOKS_FILE ?? './memory/airtable-webhooks.json';
const INBOX_DB               = process.env.INBOX_DB               ?? './memory/inbox.sqlite';
const AUTH_DB     = process.env.AUTH_DB     ?? './memory/auth.sqlite';
const AUTH_SECRET = process.env.AUTH_SECRET ?? './memory/.jwt-secret';
const OAUTH_DB    = process.env.OAUTH_DB    ?? './memory/oauth.sqlite';
const OAUTH_KEY   = process.env.OAUTH_KEY   ?? './memory/.oauth-key';

const ensureDir = (file) => { try { mkdirSync(dirname(file), { recursive: true }); } catch { /* ok */ } };

/** Public-safe user shape for API responses (never leaks password_hash). */
const pubUser = (u) => ({ id: u.id, email: u.email, role: u.role, tenant_id: u.tenant_id, display_name: u.display_name });

// Set the session JWT as an HttpOnly cookie (in addition to the JSON body the
// SPA stores). The cookie lets top-level browser navigations — notably the
// OAuth connect/callback redirects — carry the session, which a Bearer header
// cannot. `requireAuth` reads this `session` cookie first (see auth/middleware).
function setSessionCookie(res, token) {
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30d, matches the bearer-session TTL
  });
}

// Verify a Slack request signature (Events API). Signs `v0:{ts}:{rawBody}` with
// the app's signing secret; rejects on mismatch or a >5min-old timestamp (replay).
function verifySlackSignature(req, signingSecret) {
  const ts  = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${req.rawBody?.toString('utf8') ?? ''}`;
  const mine = 'v0=' + createHmac('sha256', signingSecret).update(base).digest('hex');
  try { return mine.length === sig.length && timingSafeEqual(Buffer.from(mine), Buffer.from(sig)); }
  catch { return false; }
}

// A node that posts to / calls Slack (so it needs the tenant's Slack token).
const isSlackNode = (n) =>
  (n?.type === 'deliver' && String(n?.config?.channel ?? '').startsWith('slack')) ||
  (n?.type === 'connector-action' && String(n?.config?.action ?? '').startsWith('slack'));

const AIRTABLE_ACTION_IDS = new Set([
  'airtable_list_records', 'airtable_get_record', 'airtable_search_records',
  'airtable_create_record', 'airtable_update_record', 'airtable_delete_record',
]);
const isAirtableNode = (n) =>
  (n?.type === 'deliver' && AIRTABLE_ACTION_IDS.has(n?.config?.channel)) ||
  (n?.type === 'connector-action' && AIRTABLE_ACTION_IDS.has(n?.config?.action));

const GOOGLE_ACTION_IDS = new Set([
  'gmail_search', 'gmail_get_message', 'gmail_send', 'gmail_mark_read',
  'calendar_list_events', 'calendar_create_event',
  'drive_list_files', 'sheets_read', 'sheets_append',
  'docs_read', 'docs_create', 'tasks_list', 'tasks_create',
]);
const isGoogleNode = (n) =>
  (n?.type === 'deliver' && GOOGLE_ACTION_IDS.has(n?.config?.channel)) ||
  (n?.type === 'connector-action' && GOOGLE_ACTION_IDS.has(n?.config?.action));

// ── Connector credential registry ────────────────────────────────────────────
// Per-tenant credential handling for EVERY connector, in one place. Each entry
// declares: which workflow nodes it owns, the human name, how to resolve THIS
// tenant's token, which config field to inject it into, and an optional dev
// escape hatch (for connectors with an operator env token). Adding a connector —
// now or in future — is ONE entry here; no run-path changes, nothing per-workflow.
const CONNECTOR_INJECTORS = [
  {
    id: 'slack',
    name: 'Slack',
    ownsNode: isSlackNode,
    resolveToken: (tenantId, { oauthTokenStore, cipher }) =>
      getSlackToken({ oauthTokenStore, cipher, tenantId })?.botToken ?? null,
    field: 'token',
    devEscape: (tenantId) => !!process.env.SLACK_DEV_TENANT && tenantId === process.env.SLACK_DEV_TENANT,
  },
  {
    id: 'google',
    name: 'Google',
    ownsNode: isGoogleNode,
    resolveToken: async (tenantId, { oauthTokenStore, cipher, userId }) =>
      getGoogleAccessToken({ oauthTokenStore, cipher, tenantId, userId }),
    field: 'googleToken',
    devEscape: () => false,
  },
  {
    id: 'airtable',
    name: 'Airtable',
    ownsNode: isAirtableNode,
    resolveToken: async (tenantId, { oauthTokenStore, cipher }) =>
      getAirtableAccessToken({ oauthTokenStore, cipher, tenantId }),
    field: 'airtableToken',
    devEscape: () => false,
  },
];

// Inject the owning tenant's credentials into every connector node of a workflow/
// spec, so the run acts as that tenant — never a shared/operator token. Used by
// EVERY run path (run-test, event dispatch, scheduler). Connector-agnostic.
async function injectTenantTokens(obj, tenantId, deps) {
  if (!tenantId || !(obj?.nodes?.length)) return obj;
  let nodes = obj.nodes;
  let changed = false;
  for (const c of CONNECTOR_INJECTORS) {
    if (!nodes.some(c.ownsNode)) continue;
    const tok = await c.resolveToken(tenantId, deps);
    if (!tok) continue;
    nodes = nodes.map((n) => (c.ownsNode(n) && n?.config?.[c.field] == null) ? { ...n, config: { ...n.config, [c.field]: tok } } : n);
    changed = true;
  }
  return changed ? { ...obj, nodes } : obj;
}

// Inject tenant + user identity into inbox_deliver nodes so the handler knows
// which user's inbox to write to. Called alongside injectTenantTokens before
// every run path (REST, scheduler, event dispatch).
function injectInboxContext(spec, tenantId, userId, extras = {}) {
  if (!tenantId || !userId || !(spec?.nodes?.length)) return spec;
  const isInbox = (n) => n?.type === 'deliver' && n?.config?.channel === 'inbox_deliver';
  if (!spec.nodes.some(isInbox)) return spec;
  const nodes = spec.nodes.map((n) => isInbox(n)
    ? { ...n, config: { ...n.config, _tenantId: tenantId, _userId: userId, ...extras } }
    : n);
  return { ...spec, nodes };
}

// Inject tenant identity into search_inbox connector-action nodes.
function injectInboxCapabilityContext(spec, tenantId) {
  if (!tenantId || !(spec?.nodes?.length)) return spec;
  const isInboxCap = (n) => n?.type === 'connector-action' && INBOX_CAPABILITY_IDS.has(n?.config?.action);
  if (!spec.nodes.some(isInboxCap)) return spec;
  const nodes = spec.nodes.map((n) => isInboxCap(n)
    ? { ...n, config: { ...n.config, _tenantId: tenantId } }
    : n);
  return { ...spec, nodes };
}

// Inject tenant identity into filesystem_read / filesystem_list nodes so the
// handler can validate the path against the tenant's approved folders.
function injectFilesystemContext(spec, tenantId) {
  if (!tenantId || !(spec?.nodes?.length)) return spec;
  const isFs = (n) => n?.type === 'connector-action' && FILESYSTEM_CAPABILITY_IDS.has(n?.config?.action);
  if (!spec.nodes.some(isFs)) return spec;
  const nodes = spec.nodes.map((n) => isFs(n)
    ? { ...n, config: { ...n.config, _tenantId: tenantId } }
    : n);
  return { ...spec, nodes };
}

// A connector this tenant must connect before the spec can run (owns a node but
// has no resolvable token and no dev escape). Returns its name, or null. Generic.
async function unconnectedConnector(spec, tenantId, deps) {
  for (const c of CONNECTOR_INJECTORS) {
    if (!(spec?.nodes ?? []).some(c.ownsNode)) continue;
    if (c.devEscape?.(tenantId)) continue;
    const tok = await c.resolveToken(tenantId, deps);
    if (!tok) return c.name;
  }
  return null;
}

// Route a verified Slack event to the owning tenant's matching workflows. Tenant
// isolation is hard: the event's team_id must resolve to exactly one tenant's
// stored Slack install, and only THAT tenant's active flows are considered — and
// each runs with that tenant's OWN Slack token.
async function dispatchSlackEvent(spine, body) {
  const teamId = body?.team_id;
  const ev = body?.event ?? {};
  // Only real user messages — skip bot echoes, edits, joins, etc.
  if (!teamId || ev.type !== 'message' || ev.bot_id || ev.subtype) return;

  const tenantId = spine.auth.oauthTokenStore.findTenantByAccount?.({ connectorId: 'slack', account: teamId });
  if (!tenantId) { logEvent('slack.event.no_tenant', { teamId }); return; }

  const channelMatches = (t) => {
    const want = t.filter?.channel;
    if (!want) return true;                       // no channel filter → any channel
    return want === ev.channel || String(want).replace(/^#/, '') === ev.channel; // id match (names need resolution — see doc)
  };
  const flows = spine.engine.workflowStore.list({ tenantId, kind: 'flow', status: 'active' })
    .filter((w) => (w.triggers ?? []).some((t) => t.type === 'event' && t.connector === 'slack' && t.event === 'message' && channelMatches(t)));

  if (!flows.length) return;
  const slackDeps = { oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher };
  const context = `New Slack message in <#${ev.channel}> from <@${ev.user}>:\n\n${ev.text ?? ''}`;
  for (const wf of flows) {
    logEvent('slack.event.dispatch', { tenant: tenantId, workflow: wf.slug, channel: ev.channel });
    let tenantWf = await injectTenantTokens(wf, tenantId, { ...slackDeps, userId: wf.user_id });
    tenantWf = injectInboxContext(tenantWf, tenantId, tenantWf.user_id ?? '');
    tenantWf = injectFilesystemContext(tenantWf, tenantId);
    tenantWf = injectInboxCapabilityContext(tenantWf, tenantId);
    try { await spine.engine.workflowScheduler._executeFlow(tenantWf, { trigger: 'event', emailContext: context }); }
    catch (err) { logEvent('slack.event.error', { tenant: tenantId, workflow: wf.slug, ...errFields(err) }); }
  }
}

// Route an Airtable webhook notification to matching workflows.
// Airtable only sends a ping (base + webhook id); payloads are fetched separately.
async function dispatchAirtableEvent(spine, body) {
  const baseId    = body?.base?.id;
  const webhookId = body?.webhook?.id;
  if (!baseId || !webhookId) return;

  const route = lookupWebhook(webhookId);
  if (!route) { logEvent('airtable.event.no_route', { baseId, webhookId }); return; }

  const { tenantId } = route;
  const airtableDeps = { oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher };
  const pat  = await getAirtableAccessToken({ oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId });
  if (!pat) { logEvent('airtable.event.no_token', { tenantId }); return; }

  const api = makeAirtableApi(pat);
  let payloads;
  try {
    const result = await fetchWebhookPayloads(api, { baseId, webhookId });
    payloads = result.payloads;
  } catch (err) {
    logEvent('airtable.event.payload_error', { tenantId, webhookId, ...errFields(err) });
    return;
  }
  if (!payloads.length) return;

  const flows = spine.engine.workflowStore.list({ tenantId, kind: 'flow', status: 'active' })
    .filter((w) => (w.triggers ?? []).some((t) =>
      t.type === 'event' && t.connector === 'airtable' && t.event === 'record_changed' &&
      (!t.filter?.baseId || t.filter.baseId === baseId)));

  if (!flows.length) return;
  const context = `Airtable record changed in base ${baseId}.\n\nChanges:\n${JSON.stringify(payloads.slice(0, 3), null, 2)}`;
  for (const wf of flows) {
    logEvent('airtable.event.dispatch', { tenant: tenantId, workflow: wf.slug });
    let tenantWf = await injectTenantTokens(wf, tenantId, { ...airtableDeps, userId: wf.user_id });
    tenantWf = injectInboxContext(tenantWf, tenantId, tenantWf.user_id ?? '');
    tenantWf = injectFilesystemContext(tenantWf, tenantId);
    tenantWf = injectInboxCapabilityContext(tenantWf, tenantId);
    try { await spine.engine.workflowScheduler._executeFlow(tenantWf, { trigger: 'event', emailContext: context }); }
    catch (err) { logEvent('airtable.event.error', { tenant: tenantId, workflow: wf.slug, ...errFields(err) }); }
  }
}

/**
 * Build the LLM pool. Priority: Anthropic (cloud) → OpenAI (cloud) → local weights.
 * Returns null only when nothing is configured — engine still boots but llm nodes
 * fail at run time with a clear message.
 */
function buildLLM(costTracker = null) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const openaiKey    = process.env.OPENAI_API_KEY?.trim();

  if (anthropicKey) {
    const fast      = new ChatModel({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: anthropicKey });
    const balanced  = new ChatModel({ provider: 'anthropic', model: 'claude-sonnet-4-6',         apiKey: anthropicKey });
    const powerful  = new ChatModel({ provider: 'anthropic', model: 'claude-sonnet-4-6',         apiKey: anthropicKey });
    return new ModelPool({ tiers: { fast, balanced, powerful }, defaultTier: 'balanced', costTracker });
  }

  if (openaiKey) {
    const fast      = new ChatModel({ provider: 'openai', model: 'gpt-4o-mini', apiKey: openaiKey });
    const balanced  = new ChatModel({ provider: 'openai', model: 'gpt-4o',      apiKey: openaiKey });
    const powerful  = new ChatModel({ provider: 'openai', model: 'gpt-4o',      apiKey: openaiKey });
    return new ModelPool({ tiers: { fast, balanced, powerful }, defaultTier: 'balanced', costTracker });
  }

  if (!existsSync(LOCAL_MODEL_PATH)) return null;
  const local = new LlamaCppLLM({ modelPath: LOCAL_MODEL_PATH, contextSize: 2048 });
  return new ModelPool({ tiers: { fast: local, balanced: local, powerful: local }, defaultTier: 'balanced', costTracker });
}

/** Construct the execution engine with `llm` (a ModelPool) injected. */
async function buildEngine(workflowStore, llm, costTracker = null) {
  ensureDir(SOURCES_DB);
  const sourceRegistry = new SourceRegistry({ dbPath: SOURCES_DB });
  await sourceRegistry.init();

  const capabilityRegistry = new CapabilityRegistry();

  const channelRegistry = new ChannelRegistry(capabilityRegistry);
  registerBuiltInChannels(channelRegistry, {});           // in-app + webhook; mcp channel is opt-in
  registerSlackChannel(channelRegistry);                  // Slack step/delivery channels (ChannelRegistry adapter)
  registerSlackTriggers(capabilityRegistry);              // Slack trigger capabilities
  registerGoogleChannels(capabilityRegistry);             // All Google step/delivery/trigger capabilities
  registerAirtableChannels(capabilityRegistry);           // Airtable CRUD + record-changed trigger

  const nodeTypeRegistry = new NodeTypeRegistry();
  registerBuiltInNodeTypes(nodeTypeRegistry);

  const workflowValidator = new WorkflowValidator({ sourceRegistry, channelRegistry, nodeTypes: nodeTypeRegistry });

  // Scheduler is constructed (FlowTester uses it for preview fetches) but NOT
  // started — the spine runs no background tick yet; scheduled triggers are P2/P7.
  const workflowScheduler = new WorkflowScheduler({ workflowStore, sourceRegistry, costTracker });
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

  return { workflowStore, sourceRegistry, capabilityRegistry, channelRegistry, nodeTypeRegistry, workflowValidator, workflowScheduler, flowTester, workflowService, llm };
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
 * Per-tenant inbox RAG store — same embedder/splitter as the company store but
 * backed by inbox.sqlite so inbox artifacts are independently queryable.
 */
function buildInboxRag(sharedRag) {
  const { embedder, splitter } = sharedRag;
  const handles = new Map();

  async function forTenant(tenantId) {
    if (!tenantId) throw new Error('InboxRAG requires a tenant (refusing unscoped access)');
    const cached = handles.get(tenantId);
    if (cached) return cached;
    const safe = String(tenantId).replace(/[^a-z0-9_-]/gi, '');
    if (!safe) throw new Error('InboxRAG requires a valid tenant');
    const dbPath = join(VECTOR_DIR, safe, 'inbox.sqlite');
    ensureDir(dbPath);
    const vectorStore = new VectorStore({ sqlitePath: dbPath });
    await vectorStore.load();
    const h = {
      vectorStore, dbPath,
      async ingest(text, metadata = {}) {
        const chunks = await splitter._call([{ pageContent: text, metadata }]);
        const embeddings = await embedder._call(chunks.map(c => c.pageContent));
        await vectorStore.add(chunks, embeddings);
        return chunks.length;
      },
      async query(q, k = 5) {
        const qemb = await embedder._call(q);
        return vectorStore.search(qemb, k);
      },
    };
    handles.set(tenantId, h);
    return h;
  }

  return {
    forTenant,
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

  const costTracker = new CostTracker();

  // Wire CostTracker to persist every LLM call to llm_cost_log, with tenant
  // attribution derived from userId → tenant_id via the user store.
  // Must run after auth is initialized so userStore is available.
  {
    const userStore = auth.userStore;
    const _tenantCache = new Map();
    costTracker.setStore({
      recordCost(record) {
        try {
          let tenantId = null;
          if (record.userId) {
            if (!_tenantCache.has(record.userId)) {
              _tenantCache.set(record.userId, userStore.findById(record.userId)?.tenant_id ?? null);
            }
            tenantId = _tenantCache.get(record.userId);
          }
          workflowStore.insertCostCall({
            id:          randomUUID(),
            ts:          record.timestamp,
            sessionId:   record.sessionId,
            userId:      record.userId,
            tenantId,
            tier:        record.tier,
            model:       record.model,
            context:     record.context,
            tokensIn:    record.inputTokens,
            tokensOut:   record.outputTokens,
            costUsd:     record.costUsd ?? 0,
            webSearches: record.webSearchRequests ?? 0,
          });
        } catch { /* never crash a workflow over a cost log write */ }
      },
      recordCompression() { /* not persisted */ },
    });
  }

  const llm = buildLLM(costTracker);
  const engine = await buildEngine(workflowStore, llm, costTracker);
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
    let emails;
    try {
      emails = await pollGmail({ workflow, tenantId, userId, oauthTokenStore: auth.oauthTokenStore, cipher: auth.tokenCipher, oauthClient: auth.oauth });
    } catch (err) {
      logEvent({ kind: 'gmail.poll.error', tenant: tenantId, workflowId: workflow.id, error: err.message });
      return [];
    }
    logEvent({ kind: 'gmail.poll.ok', tenant: tenantId, workflowId: workflow.id, found: emails.length, filter: trigger?.filter });
    return emails.map(formatEmailContext); // strings — injected as initialContext
  });

  // Scheduled + email-triggered runs act as the OWNING tenant: inject that
  // tenant's connector tokens before each automatic run (connector-agnostic).
  engine.workflowScheduler.registerTokenInjector(async (workflow) => {
    let w = await injectTenantTokens(workflow, workflow.tenant_id ?? 'default', {
      oauthTokenStore: auth.oauthTokenStore, cipher: auth.tokenCipher, userId: workflow.user_id,
    });
    w = injectInboxContext(w, w.tenant_id ?? 'default', w.user_id ?? '');
    w = injectFilesystemContext(w, w.tenant_id ?? 'default');
    w = injectInboxCapabilityContext(w, w.tenant_id ?? 'default');
    return w;
  });

  // Send a Slack alert when a workflow exhausts all retry attempts.
  // The workflow's error_handling.notify field controls the target:
  //   { type: 'slack', channel: '#ops-alerts' }
  engine.workflowScheduler.registerErrorNotifier(async (workflow, error) => {
    const notify = workflow.error_handling?.notify;
    if (!notify) return;
    if (notify.type !== 'slack') return;
    const channel = notify.channel ?? notify.target;
    if (!channel) return;
    const tenantId = workflow.tenant_id ?? 'default';
    let token;
    try {
      const grant = getSlackGrant({ oauthTokenStore: auth.oauthTokenStore, tenantId });
      token = grant?.botToken;
    } catch { /* no grant */ }
    token ??= process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const text = `⚠️ Workflow *${workflow.name ?? workflow.slug}* failed after all retry attempts.\n\`${error?.message ?? String(error)}\``;
    await fetch(`https://slack.com/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel, text }),
    });
  });

  // Start the background tick loop (email polling + scheduled workflow execution).
  engine.workflowScheduler.start();

  // Per-user inbox — delivery destination + dedicated inbox RAG store.
  // inbox.sqlite is SEPARATE from company.sqlite so inbox artifacts are
  // independently queryable from the general knowledge store.
  ensureDir(INBOX_DB);
  const inboxStore = new InboxStore({ dbPath: INBOX_DB });
  const ragInbox = buildInboxRag(rag);
  registerInboxCapability(engine.capabilityRegistry, {
    inboxStore,
    getRagInbox: ragInbox.forTenant.bind(ragInbox),
  });

  // Filesystem connector — tenant-scoped read + list for workflows.
  // Sandboxed to folders the tenant has connected via the Filesystem page.
  registerFilesystemCapabilities(engine.capabilityRegistry, {
    getApprovedFolders: (tenantId) => readSources(tenantId),
  });

  registerWebCapabilities(engine.capabilityRegistry, { llm: engine.llm });

  const slack = createSlackCapabilityProvider({ oauthTokenStore: auth.oauthTokenStore, apiBase: process.env.SLACK_API_URL });
  const slackOAuth = createSlackOAuthFlow();
  const google = createGoogleCapabilityProvider({ oauthTokenStore: auth.oauthTokenStore });
  const airtableProvider = createAirtableCapabilityProvider({ oauthTokenStore: auth.oauthTokenStore });

  const interactionStore = new InteractionStore({ dbPath: INTERACTIONS_DB });
  interactionStore.init();

  return {
    auth,
    engine,
    rag,
    ragInbox,
    inboxStore,
    slack,
    slackOAuth,
    google,
    airtable: airtableProvider,
    interactionStore,
    get llm() { return engine.llm; },
    costTracker,
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
      try { ragInbox.close?.(); } catch { /* ignore */ }
      try { inboxStore.close?.(); } catch { /* ignore */ }
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
  // Capture the raw body so connector webhooks (e.g. Slack Events) can verify
  // request signatures over the exact bytes Slack signed.
  app.use(express.json({ limit: '4mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  // Request log: one JSON line per request (method, path, status, ms, tenant).
  // Lets us see — from the log file alone — whether a request even reached the
  // server (e.g. distinguishing a real app error from a proxy/tunnel 502 that
  // never arrived). req.tenant/req.user are populated by per-route auth before
  // 'finish' fires. Static asset noise is skipped.
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/assets/') || req.path === '/favicon.ico') return;
      logEvent('http', {
        method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0,
        tenant: req.tenant?.id ?? null, user: req.user?.id ?? null,
      });
    });
    next();
  });

  app.use(express.static(join(process.cwd(), 'public')));
  app.use('/recordings', express.static(join(process.cwd(), 'memory/recordings')));

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
      setSessionCookie(res, jwt);
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
      setSessionCookie(res, token);
      const tenantRow = spine.auth.tenantStore.get(user.tenant_id);
      const tenant = tenantRow ? { id: tenantRow.id, name: tenantRow.name } : null;
      res.json({ ok: true, token, user: pubUser(user), tenant });
    } catch (err) { res.status(400).json({ error: err.message ?? String(err) }); }
  });
  app.post('/auth/logout', requireAuth, (req, res) => {
    try { spine.auth.sessionStore.revoke(req.session.id); } catch { /* ignore */ }
    res.clearCookie('session', { path: '/' });
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

  // ── User preferences ──────────────────────────────────────────────────────
  const VALID_HOMEPAGE_MODULES = ['ai_greeting','workflow_health','recent_activity','success_rate','top_workflows','quick_run','next_scheduled','failure_alerts','time_saved','ai_tip','workflows_list'];

  app.get('/api/user/preferences', requireActiveTenant, (req, res) => {
    const prefs = spine.auth.userStore.getPreferences(req.user.id, req.tenant.id);
    res.json({ ok: true, ...prefs });
  });

  app.put('/api/user/preferences', requireActiveTenant, (req, res) => {
    const { homepageModules } = req.body ?? {};
    if (!Array.isArray(homepageModules) || homepageModules.some(m => !VALID_HOMEPAGE_MODULES.includes(m))) {
      return res.status(400).json({ error: 'invalid homepageModules' });
    }
    spine.auth.userStore.update(req.user.id, { preferences: { homepageModules } }, req.tenant.id);
    res.json({ ok: true, homepageModules });
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

  // ── Knowledge base: folder indexing ──────────────────────────────────────────
  // Sources list helpers are defined at module scope (below) so both bootSpine
  // (filesystem connector registration) and createApp (RAG routes) can use them.

  function writeSources(tenantId, sources) {
    const p = sourcesPath(tenantId);
    ensureDir(p);
    writeFileSync(p, JSON.stringify(sources, null, 2));
  }

  app.get('/rag/sources', requireActiveTenant, (req, res) => {
    res.json({ sources: readSources(req.tenant.id) });
  });

  // Build a vision function for DocumentLoader: reads the file, calls Anthropic
  // vision to get a text description, returns it. Returns null when no API key.
  function buildVisionFn() {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    return async function visionFn(filePath) {
      const { readFileSync } = await import('fs');
      const ext  = filePath.split('.').pop().toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const data = readFileSync(filePath).toString('base64');
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data } },
          { type: 'text', text: `Describe this image in detail for document search indexing. Extract any visible text verbatim. Note key objects, people, charts, or data visible. File: ${filePath.split('/').pop()}` },
        ]}],
      });
      return resp.content?.[0]?.text ?? null;
    };
  }

  // Strip HTML tags to plain text using jsdom.
  async function stripHtmlToText(html) {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    for (const el of doc.querySelectorAll('script, style, noscript')) el.remove();
    return (doc.body?.textContent ?? doc.documentElement?.textContent ?? '')
      .replace(/\s+/g, ' ').trim();
  }

  // Describe a base64-encoded image (data URL) via Anthropic vision. Returns text.
  async function describeImageDataUrl(dataUrl, fileName) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const [header, b64] = dataUrl.split(',');
    const mimeMatch = header?.match(/data:([^;]+);/);
    const mime = (mimeMatch?.[1] ?? 'image/jpeg');
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
        { type: 'text', text: `Describe this image in detail for document search indexing. Extract any visible text verbatim. Note key objects, people, charts, or data visible. File: ${fileName}` },
      ]}],
    });
    return resp.content?.[0]?.text ?? null;
  }

  app.post('/rag/index-folder', requireActiveTenant, async (req, res) => {
    const folderPath = req.body?.path;
    if (typeof folderPath !== 'string' || !folderPath.trim()) {
      return res.status(400).json({ error: '`path` is required' });
    }
    const absPath = resolve(folderPath.trim());
    if (!existsSync(absPath)) {
      return res.status(400).json({ error: `Path not found: ${absPath}` });
    }
    try {
      const loader = new DocumentLoader({ visionFn: buildVisionFn() });
      const docs   = await loader._call(absPath);
      const rag    = await spine.rag.forTenant(req.tenant.id);
      let chunks   = 0;
      for (const doc of docs) {
        chunks += await rag.ingest(doc.pageContent, {
          source:      'folder',
          source_path: doc.metadata?.source ?? absPath,
          folder_root: absPath,
          tenant_id:   req.tenant.id,
        });
      }
      // Upsert into sources list
      const sources = readSources(req.tenant.id);
      if (!sources.find(s => s.path === absPath)) {
        sources.push({ path: absPath, addedAt: Date.now(), files: docs.length, chunks });
        writeSources(req.tenant.id, sources);
      } else {
        const idx = sources.findIndex(s => s.path === absPath);
        sources[idx] = { ...sources[idx], files: docs.length, chunks, reindexedAt: Date.now() };
        writeSources(req.tenant.id, sources);
      }
      res.json({ ok: true, path: absPath, files: docs.length, chunks });
    } catch (err) {
      res.status(500).json({ error: `index-folder failed: ${err.message ?? String(err)}` });
    }
  });

  app.delete('/rag/sources', requireActiveTenant, (req, res) => {
    const pathStr = (req.body?.path ?? '').trim();
    if (!pathStr) return res.status(400).json({ error: '`path` is required' });
    // Match by exact stored value first; also try resolved absolute path for legacy path-based sources
    const maybeAbs = (pathStr.startsWith('/') || pathStr.startsWith('~')) ? resolve(pathStr) : null;
    const sources = readSources(req.tenant.id)
      .filter(s => s.path !== pathStr && (maybeAbs === null || s.path !== maybeAbs));
    writeSources(req.tenant.id, sources);
    res.json({ ok: true, removed: pathStr });
  });

  // Accept file contents uploaded from the browser (folder picker flow).
  // Ingests each file into the tenant's RAG store and records the folder in sources.json.
  app.post('/rag/ingest-files', requireActiveTenant, async (req, res) => {
    const { folderName, files } = req.body ?? {};
    if (!folderName || !Array.isArray(files) || !files.length) {
      return res.status(400).json({ error: '`folderName` and non-empty `files` array required' });
    }
    const MAX_FILES = 300;
    const MAX_BYTES = 200_000;
    try {
      const rag = await spine.rag.forTenant(req.tenant.id);
      let chunks = 0;
      let ingested = 0;
      for (const { path: filePath, content } of files.slice(0, MAX_FILES)) {
        if (typeof content !== 'string' || !content.trim()) continue;
        const ext = (filePath.split('.').pop() ?? '').toLowerCase();

        let text;
        if (content.startsWith('data:image/')) {
          // Image sent as base64 data URL — describe via vision
          const fileName = filePath.split('/').pop() ?? filePath;
          text = await describeImageDataUrl(content, fileName).catch(() => null);
          if (!text) continue;
        } else if (ext === 'html' || ext === 'htm') {
          // HTML — strip tags to plain text
          text = await stripHtmlToText(content).catch(() => null);
          if (!text) continue;
        } else {
          text = content.slice(0, MAX_BYTES);
        }

        if (!text.trim()) continue;
        chunks += await rag.ingest(text.slice(0, MAX_BYTES), {
          source:      'upload',
          source_path: filePath,
          folder_root: folderName,
          tenant_id:   req.tenant.id,
        });
        ingested++;
      }
      const sources = readSources(req.tenant.id);
      const entry   = { path: folderName, addedAt: Date.now(), files: ingested, chunks, source: 'upload' };
      const idx     = sources.findIndex(s => s.path === folderName);
      if (idx >= 0) sources[idx] = { ...sources[idx], ...entry, reindexedAt: Date.now() };
      else sources.push(entry);
      writeSources(req.tenant.id, sources);
      res.json({ ok: true, folderName, files: ingested, chunks });
    } catch (err) {
      res.status(500).json({ error: `ingest-files failed: ${err.message ?? String(err)}` });
    }
  });

  // ── Inbox ─────────────────────────────────────────────────────────────────────

  app.get('/inbox', requireActiveTenant, (req, res) => {
    const { limit = 50, offset = 0 } = req.query;
    const messages = spine.inboxStore.list(req.tenant.id, req.user.id, {
      limit: Number(limit), offset: Number(offset),
    });
    const unread = spine.inboxStore.unreadCount(req.tenant.id, req.user.id);
    res.json({ messages, unread });
  });

  app.get('/inbox/:id', requireActiveTenant, (req, res) => {
    const msg = spine.inboxStore.get(req.tenant.id, req.user.id, req.params.id);
    if (!msg) return res.status(404).json({ error: 'not found' });
    res.json(msg);
  });

  app.patch('/inbox/:id/read', requireActiveTenant, (req, res) => {
    const msg = spine.inboxStore.markRead(req.tenant.id, req.user.id, req.params.id);
    if (!msg) return res.status(404).json({ error: 'not found' });
    res.json(msg);
  });

  app.delete('/inbox/:id', requireActiveTenant, (req, res) => {
    const result = spine.inboxStore.delete(req.tenant.id, req.user.id, req.params.id);
    res.json(result);
  });

  // Semantic search over this tenant's inbox artifacts (inbox.sqlite, separate
  // from the company-knowledge store). Body: { query, k? }.
  app.post('/inbox/search', requireActiveTenant, async (req, res) => {
    try {
      const q = req.body?.query;
      if (typeof q !== 'string' || !q.trim()) return res.status(400).json({ error: '`query` is required' });
      const k = Math.min(Number(req.body?.k ?? 8), 20);
      const rag = await spine.ragInbox.forTenant(req.tenant.id);
      const hits = await rag.query(q, k);
      res.json({
        query: q,
        hits: hits.map((h) => ({ score: h.score, content: h.pageContent ?? h.content ?? '', metadata: h.metadata ?? {} })),
      });
    } catch (err) {
      res.status(500).json({ error: `inbox search failed: ${err.message ?? String(err)}` });
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
      const slack     = await spine.slack.resolveForTenant(req.tenant.id);
      const google    = await spine.google.resolveForTenant(req.tenant.id, req.user.id);
      const airtable  = spine.airtable.resolveForTenant(req.tenant.id);
      // Narrow triggers to those whose connector is actually connected for this tenant.
      const connected = new Set();
      if (slack?.actions?.some(a => a.available)) connected.add('slack');
      if (google?.actions?.some(a => a.available)) connected.add('google');
      if (airtable.connected) connected.add('airtable');
      const triggers = spine.engine.capabilityRegistry
        .list({ position: 'trigger' })
        .map(t => ({ ...t, available: t.available && (!t.connector || connected.has(t.connector)) }));
      res.json({
        channels: spine.engine.channelRegistry.getAll(),
        triggers,
        connectors: { slack, google, airtable },
      });
    } catch (err) {
      res.status(500).json({ error: `capabilities failed: ${err.message ?? String(err)}` });
    }
  });

  // ── Slack connector OAuth (client authorizes the Atlas app; per-tenant token) ──
  // Start the install — returns the "Add to Slack" authorize URL (UI/redirect later).
  app.get('/connectors/slack/authorize', requireActiveTenant, async (req, res) => {
    try {
      if (!isOAuthConfigured()) return res.status(501).json({ error: 'Slack OAuth is not configured on this deployment' });
      const { authorizeUrl } = await spine.slackOAuth.start({ tenantId: req.tenant.id, userId: req.user.id });
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
        // Store the team_id as `account` so inbound Slack events (which carry
        // team_id) route to this exact tenant. Falls back to the team name.
        tenantId: grant.tenantId, botToken: grant.botToken, scopes: grant.scopes,
        account: grant.team?.id ?? grant.account,
      });
      spine.slack.refresh(grant.tenantId);
      // The browser is mid-navigation from Slack — send it back to the app.
      res.redirect('/?connected=slack');
    } catch (err) { res.redirect('/?connect_error=slack&reason=' + encodeURIComponent(err.message ?? String(err))); }
  });

  // Slack Events API receiver. NOT auth-gated — Slack POSTs here; the request
  // SIGNATURE (over the raw body, with the app signing secret) is the trust
  // anchor. Requires SLACK_SIGNING_SECRET + the app's Event Subscriptions
  // configured with this URL. Acks within 3s, then dispatches asynchronously.
  app.post('/connectors/slack/events', (req, res) => {
    const body = req.body ?? {};
    if (body.type === 'url_verification') return res.json({ challenge: body.challenge });
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret) return res.status(501).json({ error: 'Slack events not configured (set SLACK_SIGNING_SECRET)' });
    if (!verifySlackSignature(req, secret)) return res.status(401).json({ error: 'bad signature' });
    res.status(200).end(); // ack immediately
    if (body.type === 'event_callback') {
      dispatchSlackEvent(spine, body).catch((err) => logEvent('slack.event.error', errFields(err)));
    }
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
      if (!sessionUser) return res.redirect('/?connect_error=google&reason=' + encodeURIComponent('unknown or expired state — restart the connection'));
      const result = await spine.auth.oauth.handleCallback({ query: req.query, sessionUser });
      spine.google.refresh(pending.tenantId, pending.userId);
      res.redirect('/?connected=google');
    } catch (err) { res.redirect('/?connect_error=google&reason=' + encodeURIComponent(err.message ?? String(err))); }
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
    // A test run has no real inbound event, so the entry node (e.g. summarize)
    // would have no upstream content. Let callers seed a representative sample
    // event as `initialContext` — the same mechanism the P3 runnability check
    // uses — so the builder's "Run test" fires every step against a sample.
    const initialContext = req.body?.initialContext;
    const t0 = Date.now();
    const tenantId = req.tenant?.id ?? null;
    logEvent('run.start', { tenant: tenantId, user: req.user?.id ?? null, nodes: (spec.nodes ?? []).map(n => n.type), seeded: initialContext != null });
    try {
      // If authenticated, run in the caller's tenant: inject THAT tenant's stored
      // Slack token into every slack node (deliver + connector-action). A tenant
      // that hasn't connected Slack must NOT borrow the operator's dev env token —
      // fail closed instead (hard isolation). The env token only stands in with no
      // tenant (headless) or for the designated dev tenant. Inside the try so a
      // token decrypt error returns JSON, never an HTML 500 the UI can't parse.
      if (req.tenant) {
        const deps = { oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, userId: req.user?.id };
        const missing = await unconnectedConnector(spec, req.tenant.id, deps);
        if (missing) {
          logEvent('run.connector_not_connected', { tenant: tenantId, connector: missing });
          return res.json({ runId: null, completed: false, error: `${missing} isn't connected for this workspace — connect it first, then run the test.`, steps: [] });
        }
        spec = await injectTenantTokens(spec, req.tenant.id, deps);
        spec = injectInboxContext(spec, req.tenant.id, req.user.id);
        spec = injectFilesystemContext(spec, req.tenant.id);
        spec = injectInboxCapabilityContext(spec, req.tenant.id);
      }
      // If spec has a persisted workflow_id, open a workflow_run row so the admin
      // console can track test-run cost. Non-test (scheduled) runs are handled
      // by WorkflowScheduler.  startRun() also resolves tenant/user from the
      // workflow row — no risk of cross-tenant attribution.
      let dbRun = null;
      if (spec.id) {
        try { dbRun = spine.engine.workflowStore.startRun(spec.id, { isTest: true }); } catch { /* best-effort */ }
      }
      // Pre-register userId when dbRun is available — ensures cost records
      // before the first LLM call carry tenant attribution.
      if (dbRun && req.user?.id) {
        spine.costTracker?.setSessionUser?.(`flow-run-${dbRun.id}`, req.user.id);
      }
      let runId = null, completed = false, output = null;
      const steps = [];
      const flowOpts = { ...(initialContext != null ? { initialContext } : {}), ...(dbRun ? { runId: dbRun.id } : {}) };
      for await (const ev of spine.engine.flowTester.run(spec, flowOpts)) {
        if (ev.type === 'run_started') {
          runId = ev.runId;
          // Register when dbRun was unavailable (spec had no id) — sessionId
          // only known after FlowTester generates it.
          if (!dbRun && req.user?.id) {
            spine.costTracker?.setSessionUser?.(`flow-run-${runId}`, req.user.id);
          }
        }
        else if (ev.type === 'step_completed') { steps.push({ nodeId: ev.nodeId, output: ev.output }); logEvent('run.step', { tenant: tenantId, runId, nodeId: ev.nodeId }); }
        else if (ev.type === 'run_completed') { completed = true; output = ev.output; }
        else if (ev.type === 'run_failed') {
          logEvent('run.failed', { tenant: tenantId, runId, failedStep: steps.length, error: typeof ev.error === 'string' ? ev.error : (ev.error?.message ?? JSON.stringify(ev.error)), ms: Date.now() - t0 });
          const failCost = spine.costTracker?.getSessionCost?.(`flow-run-${runId}`) ?? null;
          if (dbRun) { try { spine.engine.workflowStore.failRun(dbRun.id, ev.error, failCost); } catch { /* best-effort */ } }
          // A failed STEP is an expected test outcome, not a gateway error. Return
          // 200 with completed:false so the real error reaches the UI — a 5xx here
          // gets swallowed and replaced by Cloudflare's own error page through the
          // tunnel, hiding the actual cause.
          return res.json({ runId, completed: false, error: ev.error, steps });
        }
      }
      // Read cost from the CostTracker before it gets evicted. The flow tester
      // registers costs under sessionId "flow-run-<runId>".
      const runCost = spine.costTracker?.getSessionCost?.(`flow-run-${runId}`) ?? null;
      if (dbRun) { try { spine.engine.workflowStore.completeRun(dbRun.id, output, runCost); } catch { /* best-effort */ } }
      logEvent('run.ok', { tenant: tenantId, runId, steps: steps.length, ms: Date.now() - t0 });
      // step_completed outputs are shrunk to strings by the executor; coerce back
      // to objects so delivery results (e.g. the Slack { delivered, ts }) surface.
      const coerce = (o) => {
        if (o && typeof o === 'object') return o;
        if (typeof o === 'string') { try { return JSON.parse(o); } catch { /* not json */ } }
        return null;
      };
      const deliveries = steps.map((s) => coerce(s.output)).filter((o) => o && o.delivered);
      res.json({ runId, completed, output, deliveries, steps, cost: runCost });
    } catch (err) {
      logEvent('run.error', { tenant: tenantId, ms: Date.now() - t0, ...errFields(err) });
      res.status(500).json({ error: `run failed: ${err.message ?? String(err)}` });
    }
  });

  // ── Airtable connector ─────────────────────────────────────────────────────
  // OAuth 2.0 + PKCE. Requires AIRTABLE_CLIENT_ID + AIRTABLE_CLIENT_SECRET.
  // Workspace-level install: one token per tenant; first admin to connect installs for all.
  const airtableFlow = createAirtableOAuthFlow();

  // JSON authorize endpoint — same as oauth/start but returns { authorizeUrl } for
  // fetch-based clients that need to handle the redirect themselves (UI connect flow).
  app.get('/connectors/airtable/authorize', requireActiveTenant, (req, res) => {
    if (!isAirtableOAuthConfigured()) {
      return res.status(501).json({ error: 'Airtable OAuth not configured (set AIRTABLE_CLIENT_ID and AIRTABLE_CLIENT_SECRET)' });
    }
    try {
      const { authorizeUrl } = airtableFlow.start({ tenantId: req.tenant.id, userId: req.user.id });
      res.json({ authorizeUrl });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start OAuth flow — redirect the browser to Airtable's consent screen.
  app.get('/connectors/airtable/oauth/start', requireActiveTenant, (req, res) => {
    if (!isAirtableOAuthConfigured()) {
      return res.status(501).json({ error: 'Airtable OAuth not configured (set AIRTABLE_CLIENT_ID and AIRTABLE_CLIENT_SECRET)' });
    }
    try {
      const { authorizeUrl } = airtableFlow.start({ tenantId: req.tenant.id, userId: req.user.id });
      res.redirect(authorizeUrl);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // OAuth callback — Airtable redirects here after the user consents.
  app.get('/connectors/airtable/callback', requireActiveTenant, async (req, res) => {
    if (req.query.error) return res.status(400).json({ error: req.query.error });
    try {
      const result = await airtableFlow.complete({ state: req.query.state, code: req.query.code, sessionUserId: req.user.id });
      storeAirtableToken({
        oauthTokenStore: spine.auth.oauthTokenStore,
        cipher: spine.auth.tokenCipher,
        tenantId: result.tenantId,
        accessToken:  result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn:    result.expiresIn,
        scope:        result.scope,
      });
      spine.airtable.refresh(result.tenantId);
      // Redirect back to the settings/connectors page.
      res.redirect('/?connected=airtable');
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Connection status.
  app.get('/connectors/airtable/status', requireActiveTenant, (req, res) => {
    const grant = getAirtableGrant({ oauthTokenStore: spine.auth.oauthTokenStore, tenantId: req.tenant.id });
    res.json(grant ?? { connected: false });
  });

  const WEB_DISABLED_FILE = process.env.WEB_DISABLED_FILE ?? './memory/web-disabled.json';
  function readWebDisabled() {
    try { return new Set(JSON.parse(readFileSync(WEB_DISABLED_FILE, 'utf8'))); } catch { return new Set(); }
  }
  function writeWebDisabled(set) {
    ensureDir(WEB_DISABLED_FILE);
    writeFileSync(WEB_DISABLED_FILE, JSON.stringify([...set]));
  }

  app.get('/connectors/web/status', requireActiveTenant, (req, res) => {
    const base = webConnectionStatus();
    const disabled = readWebDisabled().has(req.tenant.id);
    res.json({ ...base, connected: base.connected && !disabled, disabled });
  });

  app.post('/connectors/web/enable', requireActiveTenant, (req, res) => {
    const set = readWebDisabled();
    set.delete(req.tenant.id);
    writeWebDisabled(set);
    res.json({ ok: true });
  });

  app.delete('/connectors/web', requireActiveTenant, (req, res) => {
    const set = readWebDisabled();
    set.add(req.tenant.id);
    writeWebDisabled(set);
    res.json({ ok: true });
  });

  // Disconnect — best-effort delete all registered webhooks, then remove the token.
  app.delete('/connectors/airtable', requireActiveTenant, async (req, res) => {
    const tenantId = req.tenant.id;
    const token = await getAirtableAccessToken({ oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId });
    if (token) {
      const api = makeAirtableApi(token);
      for (const [webhookId, entry] of _airtableWebhooks()) {
        if (entry?.tenantId !== tenantId) continue;
        try { await deleteAirtableWebhook(api, { baseId: entry.baseId, webhookId }); } catch { /* best-effort */ }
        unregisterWebhookRoute(webhookId);
      }
    }
    const removed = disconnectAirtable({ oauthTokenStore: spine.auth.oauthTokenStore, tenantId });
    res.json({ ok: true, removed });
  });

  // Register a webhook for an Airtable base (called after publishing a workflow with an airtable_record_changed trigger).
  app.post('/connectors/airtable/webhooks', requireActiveTenant, async (req, res) => {
    const { baseId, tableId } = req.body ?? {};
    if (!baseId) return res.status(400).json({ error: 'baseId is required' });
    const tenantId = req.tenant.id;
    const token = await getAirtableAccessToken({ oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId });
    if (!token) return res.status(403).json({ error: 'Airtable not connected for this tenant' });
    try {
      const api = makeAirtableApi(token);
      const notificationUrl = `${process.env.OAUTH_REDIRECT_BASE ?? `http://localhost:${PORT}`}/connectors/airtable/events`;
      const { webhookId, macSecretBase64 } = await createAirtableWebhook(api, { baseId, tableId, notificationUrl });
      registerWebhookRoute({ webhookId, tenantId, baseId, macSecretBase64 });
      res.json({ ok: true, webhookId });
    } catch (err) { res.status(500).json({ error: err.message ?? String(err) }); }
  });

  // Airtable webhook event receiver. NOT auth-gated — Airtable POSTs here.
  // Only sends a ping (base + webhook id); actual payloads fetched in dispatchAirtableEvent.
  app.post('/connectors/airtable/events', (req, res) => {
    const body      = req.body ?? {};
    const webhookId = body?.webhook?.id;
    const route     = webhookId ? lookupWebhook(webhookId) : null;
    // Verify HMAC if we have a secret for this webhook.
    if (route?.macSecretBase64 && !verifyAirtableSignature(req, route.macSecretBase64)) {
      return res.status(401).json({ error: 'bad signature' });
    }
    res.status(200).end(); // ack immediately — Airtable requires <30s response
    dispatchAirtableEvent(spine, body).catch((err) => logEvent('airtable.event.error', errFields(err)));
  });

  mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth, readSources });
  mountConsoleRoutes(app, { spine, requireActiveTenant });
  mountAdminRoutes(app, { spine, requireAuth, requirePlatformAdmin, optionalAuth });

  return app;
}

export async function start() {
  initWebhookStore(AIRTABLE_WEBHOOKS_FILE);
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
