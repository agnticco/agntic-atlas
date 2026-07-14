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

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { createAuthSubsystem } from '../auth/index.js';
import {
  WorkflowStore,
  IdempotencyStore,
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
import { ConnectorDemandStore, REQUESTABLE_CONNECTORS, isRequestable } from '../connectors/connector-demand.js';
import { APP_VERSION } from '../version.js';
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
import { TicketStore } from '../support/ticket-store.js';
import { mountTicketRoutes } from './tickets.js';
import { registerInboxCapability, INBOX_CAPABILITY_IDS } from '../inbox/index.js';
import { registerFilesystemCapabilities, FILESYSTEM_CAPABILITY_IDS } from '../connectors/filesystem.js';
import { registerWebCapabilities, webConnectionStatus, WEB_CAPABILITY_IDS } from '../connectors/web/index.js';
import { mountBuilderRoutes } from './builder.js';
import { createTenantGuard } from './tenant-guard.js';
import { mountConsoleRoutes } from './console.js';
import { mountAdminRoutes } from '../admin/server.js';
import { logEvent, errFields } from '../utils/event-log.js';
import { boolEnv, numEnv } from '../utils/env.js';
import { FileCheckpointer } from '../graph/checkpointer/index.js';
import { sendMail, mailerConfigured } from '../utils/mailer.js';
import { renderResetEmail } from '../auth/reset-email.js';
// P12 Increment D — the human approval gate (converger-v2 §7).
import { ApprovalStore } from '../approvals/approval-store.js';
import { ApprovalService } from '../approvals/approval-service.js';
import { availableApprovalChannels, approvalChannelView } from '../workflows/approval-channels.js';
import { oauthRedirectBase } from '../connectors/oauth-redirect.js';
import { entitlementsFor, PUBLIC_PLANS, PLAN_META, isSelfServe } from '../entitlements/index.js';
import { BillingEventStore } from '../billing/billing-event-store.js';
import { handleStripeLifecycle } from '../billing/lifecycle.js';
import {
  isBillingConfigured, createCheckoutSession, createSignupCheckoutSession, createPortalSession,
  changeSubscriptionPlan, constructWebhookEvent, classifyWebhookEvent, BillingNotConfiguredError,
} from '../billing/stripe.js';

const PORT = numEnv('PORT', 3000);
// Cookies are Secure by default (the app runs behind Cloudflare HTTPS); only a
// local non-dev http context needs them off. Default: secure unless NODE_ENV is
// explicitly 'development'. COOKIE_SECURE=0/1 overrides. The old behavior keyed
// on NODE_ENV==='production', which silently shipped insecure cookies whenever
// NODE_ENV was unset (the common case here).
const SECURE_COOKIES = boolEnv('COOKIE_SECURE', process.env.NODE_ENV !== 'development');
const WORKFLOWS_DB = process.env.WORKFLOWS_DB ?? './memory/workflows/workflows.sqlite';
// P12 Increment B — remembers which (step, key) pairs have already run, so a
// re-fired trigger doesn't create the record twice.
const IDEMPOTENCY_DB = process.env.IDEMPOTENCY_DB ?? './memory/workflows/idempotency.sqlite';
const SOURCES_DB   = process.env.SOURCES_DB   ?? './memory/workflows/sources.sqlite';
// Base directory for per-tenant RAG stores: VECTOR_DIR/<tenantId>/company.sqlite.
const VECTOR_DIR   = process.env.VECTOR_DIR   ?? './memory/vectors';
// Per-tenant "internal filesystem" for browser-uploaded Knowledge files. Browsers
// can't hand the server a real path, so uploaded docs are persisted here under an
// app-managed absolute path — which makes them a first-class filesystem folder that
// workflows can read via filesystem_read/filesystem_list, not just RAG. (S8-9)
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR ?? './memory/knowledge';

// Directories that POST /rag/index-folder is allowed to ingest from. Without
// this containment an authenticated user could point it at ANY readable server
// path (.env, ~/.ssh, /etc, another tenant's data) and read it back via RAG.
// Default: the app-managed knowledge dir only. Operators opt-in additional
// server roots via KNOWLEDGE_INDEX_ROOTS (colon-separated absolute paths).
const KNOWLEDGE_INDEX_ROOTS = (() => {
  const roots = new Set([resolve(KNOWLEDGE_DIR)]);
  for (const p of (process.env.KNOWLEDGE_INDEX_ROOTS ?? '').split(':')) {
    const t = p.trim();
    if (t) roots.add(resolve(t));
  }
  return [...roots];
})();
// True iff absPath is one of, or nested under, an allowed root. Paths are
// resolve()'d (so `..` is normalised away) before comparison. Note: a symlink
// *inside* an allowed root could still point outward, but writing symlinks
// there requires filesystem access the app never grants to end users.
function isIndexPathAllowed(absPath) {
  return KNOWLEDGE_INDEX_ROOTS.some(root => absPath === root || absPath.startsWith(root + '/'));
}

// ── Login brute-force throttle ───────────────────────────────────────────────
// In-memory sliding window keyed by client IP + email. Repeated FAILED guesses
// for an account get 429'd; a correct password clears the counter, so a
// legitimate user is never locked out (fail-open). Behind a reverse proxy
// without `trust proxy` req.ip is the proxy's, but the email dimension still
// bounds per-account guessing and the edge (Cloudflare) rate-limits upstream.
const LOGIN_MAX_FAILS = numEnv('LOGIN_MAX_FAILS', 10);
const LOGIN_WINDOW_MS = numEnv('LOGIN_WINDOW_MS', 15 * 60 * 1000);
const _loginFails = new Map(); // key -> { count, resetAt }
function _loginKey(req) { return `${req.ip}|${String(req.body?.email ?? '').toLowerCase().trim()}`; }
function loginRetryAfter(req) {
  const e = _loginFails.get(_loginKey(req));
  if (!e) return 0;
  if (Date.now() > e.resetAt) { _loginFails.delete(_loginKey(req)); return 0; }
  return e.count >= LOGIN_MAX_FAILS ? Math.ceil((e.resetAt - Date.now()) / 1000) : 0;
}
function recordLoginFail(req) {
  const now = Date.now(), k = _loginKey(req), e = _loginFails.get(k);
  if (!e || now > e.resetAt) _loginFails.set(k, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else e.count++;
  if (_loginFails.size > 5000) for (const [key, v] of _loginFails) if (now > v.resetAt) _loginFails.delete(key); // lazy sweep
}
function clearLoginFails(req) { _loginFails.delete(_loginKey(req)); }

// Throttle password-reset requests (per IP + email) so /auth/forgot can't be
// used to email-bomb an address or to probe timing. 5 requests / 15 min.
const _forgotHits = new Map();
function forgotThrottled(req) {
  const key = _loginKey(req), now = Date.now(), win = 15 * 60 * 1000;
  const e = _forgotHits.get(key);
  if (!e || now > e.resetAt) { _forgotHits.set(key, { count: 1, resetAt: now + win }); if (_forgotHits.size > 5000) for (const [k, v] of _forgotHits) if (now > v.resetAt) _forgotHits.delete(k); return false; }
  e.count++;
  return e.count > 5;
}

// Content-Security-Policy — shipped Report-Only so it can't break the app while
// we observe violations at /csp-report. script-src/style-src must allow inline
// + eval (the DC UI framework compiles templates with `new Function` and the
// page carries inline bootstrap scripts), so those directives can't be tightened
// without a UI refactor. The rest (object-src none, base-uri, frame-ancestors,
// form-action, connect-src self, …) is strict and — once reports are clean —
// safe to promote to an enforced Content-Security-Policy header.
const CSP_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "report-uri /csp-report",
].join('; ');

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
// P12 Increment D — approval tokens (hashed, single-use, TTL). Its own database:
// these are credentials, and they do not belong in the same file as workflow data.
const APPROVALS_DB           = process.env.APPROVALS_DB           ?? './memory/approvals/approvals.sqlite';
const TICKETS_DB             = process.env.TICKETS_DB             ?? './memory/tickets/tickets.sqlite';
const BILLING_EVENTS_DB      = process.env.BILLING_EVENTS_DB      ?? './memory/billing/events.sqlite';
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
    secure: SECURE_COOKIES,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30d, matches the bearer-session TTL
  });
}

// ── The approval landing page (P12 Increment D) ──────────────────────────────
// Standalone HTML, no assets, no session: the recipient of an approval email may
// have no Atlas account and no cookie. Everything interpolated here came out of a
// workflow's config or an LLM's output, so it is ESCAPED — an approval page that
// executes the content it is asking you to approve would be a stored-XSS vector
// handed out by email.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>
 body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#14161a;
      margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
 .card{background:#fff;border:1px solid #e4e6ea;border-radius:14px;padding:28px;max-width:600px;width:100%;
       box-shadow:0 1px 3px rgba(0,0,0,.06)}
 h1{font-size:19px;margin:0 0 14px}
 pre{background:#f6f7f9;border:1px solid #e4e6ea;border-radius:8px;padding:14px;white-space:pre-wrap;
     word-break:break-word;max-height:340px;overflow:auto;font-size:14px}
 button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:11px 22px;cursor:pointer}
 .go{background:#111;color:#fff}
 .muted{color:#6b7280;font-size:14px}
</style></head><body><div class="card">${body}</div></body></html>`;

/** The confirmation page. Looks; does not decide. */
function renderApprovalPage(ask, token) {
  if (!ask) {
    return PAGE('Link expired', `<h1>This link is no longer valid</h1>
      <p class="muted">It has already been used, it expired, or the question was answered somewhere else.
      Nothing has been changed.</p>`);
  }
  return PAGE('Approval needed', `
    <h1>${esc(ask.prompt)}</h1>
    ${ask.preview ? `<pre>${esc(ask.preview)}</pre>` : ''}
    <form method="POST" action="/approvals/${esc(token)}">
      <button class="go" type="submit">${esc(ask.decision.charAt(0).toUpperCase() + ask.decision.slice(1))}</button>
    </form>
    <p class="muted">You are about to <strong>${esc(ask.decision)}</strong>. This link can be used once,
    and it expires ${esc(new Date(ask.expiresAt).toUTCString())}.</p>`);
}

function renderApprovalResult(result) {
  return result.ok
    ? PAGE('Recorded', `<h1>Recorded — ${esc(result.decision)}</h1>
        <p class="muted">Thank you. The workflow has been told, and it is carrying on from here.
        You can close this page.</p>`)
    : PAGE('Not recorded', `<h1>Nothing was changed</h1>
        <p class="muted">${esc(result.reason)}</p>`);
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

// NOTE: keep in sync with the Google capability catalog (registerGoogleChannels).
// A capability missing here gets no googleToken injected → "no access token" at
// run time even though it's connected (this is how drive_create_folder broke, R22).
const GOOGLE_ACTION_IDS = new Set([
  'gmail_search', 'gmail_get_message', 'gmail_send', 'gmail_mark_read',
  'calendar_list_events', 'calendar_create_event',
  'drive_list_files', 'drive_create_folder', 'sheets_read', 'sheets_append',
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
  // Legacy 'in_app'/'inbox' were routed to a NO-OP channel handler that returned
  // {delivered:true} but never wrote to the inbox store, so those deliveries silently
  // vanished — the /inbox UI (which reads the store) stayed empty (S8-1). Treat them as
  // the real inbox_deliver capability: normalize the channel + inject tenant/user so the
  // message actually lands in the operator's inbox. Fixes existing AND new workflows.
  const isInbox = (n) => n?.type === 'deliver' && ['inbox_deliver', 'in_app', 'inbox'].includes(n?.config?.channel);
  if (!spec.nodes.some(isInbox)) return spec;
  const nodes = spec.nodes.map((n) => isInbox(n)
    ? { ...n, config: { ...n.config, channel: 'inbox_deliver', subject: n.config.subject ?? n.config.title, _tenantId: tenantId, _userId: userId, ...extras } }
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
/**
 * Resolve a tenant's monthly-run budget status. Used both by the scheduler's
 * run-budget gate (background runs) and could back a REST check. Fails OPEN — any
 * error resolves to `allowed:true` so a bookkeeping fault never halts automations.
 * @returns {{ allowed: boolean, used: number, limit: number|null, plan: string|null }}
 */
// Light per-IP throttle for the public signup-checkout endpoint (>8/min → 429). A
// tenant is only ever created on real payment, so this just curbs Stripe-session spam.
const _signupHits = new Map();
function signupThrottled(req) {
  const ip = req.ip || req.headers?.['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const recent = (_signupHits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  _signupHits.set(ip, recent);
  if (_signupHits.size > 5000) _signupHits.clear(); // crude bound
  return recent.length > 8;
}

function checkRunBudget(spine, tenantId) {
  try {
    const ent = entitlementsFor(spine.auth.tenantStore, tenantId);
    if (ent.monthlyRuns === Infinity) return { allowed: true, used: 0, limit: null, plan: ent.plan };
    const used = spine.engine.workflowStore.getRunCount(tenantId);
    return { allowed: used < ent.monthlyRuns, used, limit: ent.monthlyRuns, plan: ent.plan };
  } catch {
    return { allowed: true, used: 0, limit: null, plan: null };
  }
}

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

  // THE VALIDATOR PUBLISH RUNS ON. Everything that wants to know "would this
  // save?" must be constructed the way THIS is — with the channel catalog AND the
  // approval-channel view. A check built without them is a check on a program
  // nobody runs: it was blind to UNKNOWN_CHANNEL in C, and it would be blind to
  // APPROVAL_CHANNEL_NOT_CONNECTED now (CLAUDE.md — architectural flaw #2).
  const workflowValidator = new WorkflowValidator({
    sourceRegistry, channelRegistry, nodeTypes: nodeTypeRegistry,
    approvalChannels: approvalChannelView(
      availableApprovalChannels(channelRegistry, { mailer: mailerConfigured() }),
    ),
  });

  // Scheduler is constructed (FlowTester uses it for preview fetches) but NOT
  // started — the spine runs no background tick yet; scheduled triggers are P2/P7.
  const workflowScheduler = new WorkflowScheduler({ workflowStore, sourceRegistry, costTracker });

  // P12 Increment B — backs the `idempotency` node attribute. A step that
  // declares an idempotency key with no store wired REFUSES to run, so this must
  // exist before any spec can use one: a step that claims to deduplicate and
  // silently doesn't is worse than one that never claimed to.
  const idempotencyStore = new IdempotencyStore({ dbPath: IDEMPOTENCY_DB }).init();

  const flowTester = new FlowTester({
    sourceRegistry,
    scheduler: workflowScheduler,
    llm,
    channelRegistry,
    nodeTypes: nodeTypeRegistry,
    idempotencyStore,
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
/**
 * Fail fast on misconfiguration instead of silently degrading. The worst silent
 * failure is booting in production with no cloud LLM key and falling back to the
 * local llama model (a known gotcha) — that one throws. Softer issues only warn.
 */
function validateBootConfig() {
  const isProd      = process.env.NODE_ENV === 'production';
  const hasCloudLLM = !!(process.env.ANTHROPIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
  if (isProd && !hasCloudLLM) {
    throw new Error('Production boot requires ANTHROPIC_API_KEY or OPENAI_API_KEY — refusing to silently fall back to the local model. Set a cloud key, or unset NODE_ENV=production for local dev.');
  }
  if (!hasCloudLLM) {
    console.warn('[config] No ANTHROPIC_API_KEY/OPENAI_API_KEY set — LLM will use the local model (dev only).');
  }
  if (!process.env.OAUTH_REDIRECT_BASE) {
    console.warn('[config] OAUTH_REDIRECT_BASE is unset — connector OAuth redirects default to localhost; set it for any non-local deployment.');
  }
  if (!process.env.NODE_ENV) {
    console.warn('[config] NODE_ENV is unset — defaulting to production-safe behavior (Secure cookies on). Set it explicitly: `npm run prod` for deployment, or NODE_ENV=development for local http.');
  }
}

/**
 * Snapshot the SQLite databases at boot so a bad deploy/migration is recoverable.
 * App-side only — off-host/scheduled backups belong in the VPS runbook. Keeps the
 * last DB_BACKUP_KEEP snapshots under ./memory/backups/<timestamp>/. WAL/SHM
 * siblings are copied too so a snapshot taken after a crash (uncheckpointed WAL)
 * stays consistent. Best-effort: never blocks boot.
 */
function backupDatabases() {
  const KEEP = numEnv('DB_BACKUP_KEEP', 7);
  if (KEEP <= 0) return;
  const dbs  = [WORKFLOWS_DB, SOURCES_DB, INTERACTIONS_DB, INBOX_DB, AUTH_DB, OAUTH_DB];
  const root = './memory/backups';
  const dest = join(root, new Date().toISOString().replace(/[:.]/g, '-'));
  try {
    let copied = 0;
    for (const db of dbs) {
      for (const suffix of ['', '-wal', '-shm']) {
        const src = db + suffix;
        if (!existsSync(src)) continue;
        if (!copied) mkdirSync(dest, { recursive: true });
        copyFileSync(src, join(dest, src.split('/').pop()));
        copied++;
      }
    }
    if (!copied) return;
    // Prune old snapshots beyond KEEP (ISO-stamp names sort chronologically).
    const snaps = readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort();
    for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP))) {
      try { rmSync(join(root, old), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    logEvent('boot.db_backup', { dest, files: copied });
  } catch (err) { logEvent('boot.db_backup.error', errFields(err)); }
}

export async function bootSpine() {
  validateBootConfig();
  backupDatabases();
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
            // tokens_in is the uncached remainder once prompt caching is on;
            // the cached prefix lives in these two columns.
            cacheWrite:  record.cacheWriteTokens ?? 0,
            cacheRead:   record.cacheReadTokens  ?? 0,
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

  // Halt scheduled/email-triggered runs for suspended or archived tenants — a
  // non-paying or cancelled tenant's automations must not run (nor cost money).
  // Fail-open: unknown/legacy tenant ids are allowed; only tenants that exist
  // AND are explicitly inactive are skipped.
  engine.workflowScheduler.registerTenantGate((tenantId) => {
    try {
      const t = auth.tenantStore.get(tenantId);
      return !t || (t.status === 'active' && !t.archived_at);
    } catch { return true; }
  });

  // Hard monthly-run cap (plan gate). Skips real runs for tenants who have spent
  // their plan's run budget this month; the budget resets on the 1st. Logs each
  // block so it's visible in the event log. Fails open on any error.
  engine.workflowScheduler.registerRunBudgetCheck((workflow) => {
    const budget = checkRunBudget({ auth, engine }, workflow.tenant_id);
    if (!budget.allowed) {
      logEvent('run.blocked.plan_limit', {
        tenant: workflow.tenant_id, workflow: workflow.id,
        plan: budget.plan, used: budget.used, limit: budget.limit,
      });
    }
    return budget.allowed;
  });

  // Reconcile runs orphaned in 'running' by a prior crash/restart BEFORE the
  // scheduler starts, so the inbox never shows a perma-running run.
  try {
    const reconciled = workflowStore.reconcileStuckRuns();
    if (reconciled > 0) logEvent('boot.reconcile_stuck_runs', { count: reconciled });
  } catch (err) { logEvent('boot.reconcile_stuck_runs.error', errFields(err)); }

  // Sweep abandoned converger checkpoint files (sessions never approved/abandoned),
  // which otherwise accumulate forever. Default 7-day TTL, env-tunable.
  try {
    const ttlMs = numEnv('CONVERGER_TTL_DAYS', 7) * 24 * 60 * 60 * 1000;
    const swept = await new FileCheckpointer({ dir: './memory/converger' }).sweep(ttlMs);
    if (swept > 0) logEvent('boot.converger_sweep', { removed: swept });
  } catch (err) { logEvent('boot.converger_sweep.error', errFields(err)); }

  // Start the background tick loop (email polling + scheduled workflow execution).
  // Single-owner seam for horizontal scale-out: the scheduler MUST run on exactly
  // one instance or scheduled workflows double-fire. On the current single-VPS
  // deployment this is always on; when scaling out, set SCHEDULER_ENABLED=false on
  // every instance except one. See docs/architecture/scaling.md.
  if (boolEnv('SCHEDULER_ENABLED', true)) {
    engine.workflowScheduler.start();
    // Observable proof the tick loop is live (the scheduler's own log.info is
    // silent in this environment). Also record overdue workflows at boot.
    let overdueCount = 0;
    try { overdueCount = (engine.workflowStore.getOverdue?.() ?? []).length; } catch { /* ignore */ }
    logEvent('scheduler.started', { tickMs: engine.workflowScheduler.tickInterval, overdue: overdueCount });
    console.log(`[scheduler] started — tick every ${engine.workflowScheduler.tickInterval / 1000}s; ${overdueCount} workflow(s) overdue at boot`);
  } else {
    logEvent('scheduler.disabled', { reason: 'SCHEDULER_ENABLED=false' });
    console.warn('[scheduler] disabled (SCHEDULER_ENABLED=false) — scheduled workflows + email polling will not run on this instance.');
  }

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

  // ── P12 Increment D — the human approval gate (converger-v2 §7) ────────────
  // The pause has existed since Increment B; nothing DELIVERED the question or
  // could PROVE an answer, so a `human` node was unreachable by design. This is
  // what makes it reachable, and it is wired here — in the one place that can see
  // the inbox, Slack, the mailer and the scheduler at once.
  ensureDir(APPROVALS_DB);
  const approvalStore = new ApprovalStore({ dbPath: APPROVALS_DB }).init();

  const approvals = new ApprovalService({
    approvalStore,
    workflowStore: engine.workflowStore,
    inboxStore,
    // The ONE door back into the engine. It authenticates nothing — every caller
    // above it has already proven who is answering.
    resumeRun: (run, answer) => engine.workflowScheduler.resumeRun(run, answer),
    // Block Kit buttons. Posts as the TENANT's bot, never the operator's: an
    // approval must be asked in the workspace whose data it concerns.
    postSlack: async ({ tenantId, channel, text, blocks }) => {
      let token;
      try { token = getSlackGrant({ oauthTokenStore: auth.oauthTokenStore, tenantId })?.botToken; }
      catch { /* no grant */ }
      token ??= process.env.SLACK_BOT_TOKEN;
      if (!token) throw new Error('Slack is not connected for this workspace');
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ channel, text, blocks }),
      });
      const d = await r.json().catch(() => ({}));
      if (!d.ok) throw new Error(`slack: ${d.error ?? 'post failed'}`);
      return d;
    },
    sendMail: mailerConfigured() ? sendMail : null,
    baseUrl: () => oauthRedirectBase(),
  });

  engine.workflowScheduler.registerAskDeliverer(
    (ctx) => approvals.deliverAsk(ctx),
  );
  engine.workflowScheduler.registerTimeoutHook(
    (ctx) => approvals.onTimeout(ctx),
  );
  // `on_error: { then: 'escalate' }` — Increment B raised the flag and could do
  // nothing with it, because there was no inbox to escalate INTO. Now a failed
  // step that says "tell a person" lands in that person's Approvals list instead
  // of dying in a log nobody reads.
  engine.workflowScheduler.registerEscalationNotifier(async ({ workflow, run, nodeId, error }) => {
    if (!workflow.user_id || !workflow.tenant_id) return;
    inboxStore.create({
      tenantId: workflow.tenant_id,
      userId:   workflow.user_id,
      sourceWorkflowId: workflow.id,
      sourceRunId:      run.id,
      subject: `Needs a person — ${workflow.name ?? workflow.slug}`,
      content: `The step "${nodeId}" failed, and this workflow says a person should be told rather than letting it die in a log.\n\n${String(error ?? '')}\n\nThe run stopped there. Nothing after that step ran.`,
    });
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

  // Support tickets — end-user bug/idea/request submissions, triaged in the admin app.
  ensureDir(TICKETS_DB);
  const ticketStore = new TicketStore({ dbPath: TICKETS_DB });
  await ticketStore.init();

  // Billing lifecycle events (signup / cancel / reactivate) — powers the admin Sales feed.
  ensureDir(BILLING_EVENTS_DB);
  const billingEventStore = new BillingEventStore({ dbPath: BILLING_EVENTS_DB });
  await billingEventStore.init();

  return {
    auth,
    engine,
    rag,
    ragInbox,
    inboxStore,
    approvals,
    tickets: ticketStore,
    billingEvents: billingEventStore,
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
      // Truncate the WAL into the main DB file on clean shutdown so the on-disk
      // file is self-contained (also what a subsequent backup-on-boot snapshots).
      // db.close() checkpoints too, but doing it explicitly first is belt-and-suspenders.
      try { workflowStore.db?.pragma?.('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      try { workflowStore.close?.(); } catch { /* ignore */ }
      try { rag.close?.(); } catch { /* ignore */ }
      try { ragInbox.close?.(); } catch { /* ignore */ }
      try { inboxStore.close?.(); } catch { /* ignore */ }
      try { approvalStore.close?.(); } catch { /* ignore */ }
      try { ticketStore.close?.(); } catch { /* ignore */ }
      try { billingEventStore.close?.(); } catch { /* ignore */ }
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

  // CORS allowlist (defense-in-depth; Cloudflare fronts the real edge). The SPA is
  // same-origin so it isn't subject to CORS anyway; this only bounds cross-origin
  // browser callers. No-Origin requests (curl, server-to-server webhooks, top-level
  // navigations) are always allowed. Configure CORS_ALLOWED_ORIGINS (comma list);
  // default derives from OAUTH_REDIRECT_BASE + localhost.
  const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!corsOrigins.length) {
    if (process.env.OAUTH_REDIRECT_BASE) {
      try { corsOrigins.push(new URL(process.env.OAUTH_REDIRECT_BASE).origin); } catch { /* ignore */ }
    }
    corsOrigins.push(`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`);
  }
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);                  // non-browser / same-origin nav
      return cb(null, corsOrigins.includes(origin));        // cross-origin: allowlist only
    },
    credentials: true,
  }));

  // Security headers (defense-in-depth behind Cloudflare). CSP ships Report-Only
  // (see CSP_POLICY): script/style must stay 'unsafe-inline'/'unsafe-eval' for the
  // SPA, but the rest is strict and reports to /csp-report ahead of enforcement.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0'); // disable legacy auditor (modern best practice)
    if (SECURE_COOKIES) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    res.setHeader('Content-Security-Policy-Report-Only', CSP_POLICY);
    next();
  });

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
    // Correlation id: one per request, echoed as a header so a client/log line can
    // be tied back to every server log entry for that request. Honor an inbound
    // X-Request-Id (e.g. from Cloudflare) when present.
    req.id = req.headers['x-request-id'] || randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
      if (req.path.startsWith('/assets/') || req.path === '/favicon.ico') return;
      logEvent('http', {
        reqId: req.id,
        method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0,
        tenant: req.tenant?.id ?? null, user: req.user?.id ?? null,
      });
    });
    next();
  });

  app.use(express.static(join(process.cwd(), 'public')));
  app.use('/recordings', express.static(join(process.cwd(), 'memory/recordings')));

  // App-wide: never let a browser or shared/proxy cache retain a DYNAMIC
  // response. Static assets above are already served by express.static and keep
  // their normal caching; this only runs for routes that fall through — i.e.
  // every (mostly tenant-scoped, authenticated) API response — so run-history,
  // inbox, and workflow data can't be recovered from cache after logout.
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // CSP violation reports (from the Report-Only policy above). Unauthenticated —
  // browsers post these without credentials — with a tight body cap; logged
  // truncated so a flood can't bloat the event log.
  app.post('/csp-report',
    express.json({ type: ['application/csp-report', 'application/reports+json', 'application/json'], limit: '32kb' }),
    (req, res) => {
      try {
        const items = Array.isArray(req.body) ? req.body.map(r => r?.body ?? r) : [req.body?.['csp-report'] ?? req.body ?? {}];
        for (const r of items.slice(0, 10)) {
          logEvent('csp.report', {
            directive: (r['violated-directive'] ?? r.effectiveDirective ?? '').toString().slice(0, 80),
            blocked:   (r['blocked-uri'] ?? r.blockedURL ?? '').toString().slice(0, 200),
            doc:       (r['document-uri'] ?? r.documentURL ?? '').toString().slice(0, 200),
          });
        }
      } catch { /* never fail on a report */ }
      res.status(204).end();
    });

  const optionalAuth = spine.auth?.middleware?.optionalAuth ?? ((_req, _res, next) => next());
  // RAG holds company context → no anonymous access. requireAuth resolves req.tenant,
  // and every RAG call is scoped to that tenant's own physically-isolated store.
  const requireAuth = spine.auth?.middleware?.requireAuth
    ?? ((_req, res) => res.status(401).json({ error: 'Unauthorized' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version: APP_VERSION,
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

  // Per-tenant abuse/cost guard for expensive LLM endpoints (Cloudflare is per-IP,
  // not per-tenant). Applied to /workflows/run here and /api/builder/chat below.
  // tenantStore is required for the per-plan daily USD ceiling — without it the
  // guard cannot tell a $20 tenant from a $600 one and falls back to the tightest.
  const tenantGuard = createTenantGuard({
    workflowStore: spine.engine.workflowStore,
    tenantStore:   spine.auth.tenantStore,
  });

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
    if (req.rawBody && req.rawBody.length > 8192) return res.status(413).json({ error: 'payload too large' });
    const retryAfter = loginRetryAfter(req);
    if (retryAfter) {
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }
    try {
      const user = await spine.auth.authProvider.authenticate({ email: req.body?.email, password: req.body?.password });
      if (!user) { recordLoginFail(req); return res.status(401).json({ error: 'Invalid credentials' }); }
      if (!spine.auth.tenantStore.isActive(user.tenant_id)) {
        clearLoginFails(req); // credentials were valid — not a failed attempt
        const tenant = spine.auth.tenantStore.get(user.tenant_id);
        // Only a soft-suspended tenant (cancelled) can self-resubscribe; an archived
        // (operator hard-off) one cannot — no reactivation token for those.
        const resubscribable = tenant?.status === 'suspended' && !tenant.archived_at;
        const reactivationToken = resubscribable
          ? spine.auth.tokenService.signScoped({ tenantId: user.tenant_id, scope: 'reactivate', ttlMs: 30 * 60 * 1000 })
          : null;
        return res.status(403).json({
          error: 'tenant suspended',
          code: 'TENANT_SUSPENDED',
          reactivable: !!reactivationToken,
          reactivationToken,
          workspaceName: tenant?.name ?? null,
          plan: tenant && PUBLIC_PLANS.includes(tenant.plan) ? tenant.plan : null,
        });
      }
      clearLoginFails(req);
      const { token } = spine.auth.issueSession({ user });
      setSessionCookie(res, token);
      const tenantRow = spine.auth.tenantStore.get(user.tenant_id);
      const tenant = tenantRow ? { id: tenantRow.id, name: tenantRow.name } : null;
      res.json({ ok: true, token, user: pubUser(user), tenant });
    } catch (err) { recordLoginFail(req); res.status(400).json({ error: err.message ?? String(err) }); }
  });
  app.post('/auth/logout', requireAuth, (req, res) => {
    try { spine.auth.sessionStore.revoke(req.session.id); } catch { /* ignore */ }
    res.clearCookie('session', { path: '/' });
    res.json({ ok: true });
  });

  // ── Password reset (self-service) ──────────────────────────────────────────
  // Request a reset link. ALWAYS returns { ok: true } regardless of whether the
  // email maps to a user — never reveal account existence (anti-enumeration).
  // Rate-limited to prevent email-bombing. The token is emailed; it is never
  // returned in the response.
  app.post('/auth/forgot', async (req, res) => {
    if (req.rawBody && req.rawBody.length > 8192) return res.status(413).json({ error: 'payload too large' });
    const email = String(req.body?.email ?? '').trim();
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (forgotThrottled(req)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    try {
      const user = spine.auth.userStore.findByEmail(email);
      if (user && !user.disabled_at) {
        const token = spine.auth.passwordResetStore.create({ userId: user.id, tenantId: user.tenant_id });
        const base  = oauthRedirectBase();
        const link  = `${base}/?reset=${encodeURIComponent(token)}`;
        const mail  = renderResetEmail({ resetLink: link, userEmail: user.email, base });
        await sendMail({ to: user.email, subject: mail.subject, text: mail.text, html: mail.html })
          .catch((err) => logEvent('auth.forgot.mail.error', errFields(err)));
        logEvent('auth.forgot.issued', { tenant: user.tenant_id, user: user.id });
      } else {
        logEvent('auth.forgot.nomatch', {}); // no email, timing-neutral response
      }
    } catch (err) { logEvent('auth.forgot.error', errFields(err)); }
    res.json({ ok: true });
  });

  // Check a reset token is still valid (for the UI to show the form vs. an
  // "expired link" message). Reveals only validity, never the account.
  app.post('/auth/reset/verify', (req, res) => {
    const valid = !!spine.auth.passwordResetStore.peek(String(req.body?.token ?? ''));
    res.json({ ok: true, valid });
  });

  // Complete a reset: set the new password, consume the token, and revoke all of
  // the user's existing sessions so a stolen session can't survive the reset.
  app.post('/auth/reset', async (req, res) => {
    if (req.rawBody && req.rawBody.length > 8192) return res.status(413).json({ error: 'payload too large' });
    const { token, password } = req.body ?? {};
    const row = spine.auth.passwordResetStore.peek(String(token ?? ''));
    if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    try {
      // changePassword validates strength; if it throws, the token is NOT consumed.
      await spine.auth.authProvider.changePassword({ userId: row.user_id, oldPassword: null, newPassword: password });
    } catch (err) {
      return res.status(400).json({ error: err.message ?? 'Could not set password.' });
    }
    spine.auth.passwordResetStore.markUsed(String(token));
    try { spine.auth.sessionStore.revokeAllForUser(row.user_id); } catch { /* best effort */ }
    logEvent('auth.reset.ok', { tenant: row.tenant_id, user: row.user_id });
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
    // Merge — never clobber other preference keys (e.g. last_seen_version).
    const prefs = { ...(spine.auth.userStore.getPreferences(req.user.id, req.tenant.id) ?? {}), homepageModules };
    spine.auth.userStore.update(req.user.id, { preferences: prefs }, req.tenant.id);
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
    // Containment first — never index outside an allowed root, and don't leak
    // whether an out-of-bounds path exists.
    if (!isIndexPathAllowed(absPath)) {
      logEvent('rag.index-folder.denied', { tenant: req.tenant?.id ?? null, user: req.user?.id ?? null, path: absPath });
      return res.status(403).json({ error: 'Path is not within an allowed knowledge root.' });
    }
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
    const all = readSources(req.tenant.id);
    const removed = all.find(s => s.path === pathStr || (maybeAbs !== null && s.path === maybeAbs) || s.name === pathStr);
    const sources = all.filter(s => s !== removed);
    writeSources(req.tenant.id, sources);
    // Delete the persisted files ONLY for app-managed upload folders (under KNOWLEDGE_DIR).
    // NEVER touch an external index-folder path — that's the user's own directory.
    try {
      const kbRoot = resolve(KNOWLEDGE_DIR);
      if (removed?.source === 'upload' && removed.path?.startsWith('/') &&
          (removed.path === kbRoot || removed.path.startsWith(kbRoot + '/'))) {
        rmSync(removed.path, { recursive: true, force: true });
      }
    } catch { /* best-effort — source entry already removed */ }
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
    // App-managed absolute folder for this upload — persisting the raw files here
    // makes the Knowledge folder a real filesystem folder workflows can read (S8-9).
    const safeTenant = String(req.tenant.id).replace(/[^a-z0-9_-]/gi, '');
    const safeFolder = String(folderName).replace(/[^a-z0-9_.-]/gi, '_') || 'uploads';
    const folderDir  = resolve(join(KNOWLEDGE_DIR, safeTenant, safeFolder));
    try {
      const rag = await spine.rag.forTenant(req.tenant.id);
      let chunks = 0;
      let ingested = 0;
      let wroteFiles = 0;
      const writtenNames = [];
      for (const { path: filePath, content } of files.slice(0, MAX_FILES)) {
        if (typeof content !== 'string' || !content.trim()) continue;
        const ext = (filePath.split('.').pop() ?? '').toLowerCase();
        const isImage = content.startsWith('data:image/');

        let text;
        if (isImage) {
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

        // Persist non-image files to the app filesystem so workflows can filesystem_read
        // them by path. Traversal-safe: the resolved dest must stay under folderDir.
        if (!isImage) {
          try {
            let rel = String(filePath);
            const slash = rel.indexOf('/');
            if (slash >= 0 && rel.slice(0, slash) === folderName) rel = rel.slice(slash + 1);
            rel = rel.replace(/\\/g, '/').split('/').filter(seg => seg && seg !== '.' && seg !== '..').join('/');
            const dest = resolve(join(folderDir, rel));
            if (rel && (dest === folderDir || dest.startsWith(folderDir + '/'))) {
              mkdirSync(dirname(dest), { recursive: true });
              writeFileSync(dest, content.slice(0, MAX_BYTES));
              wroteFiles++;
              writtenNames.push(rel);
            }
          } catch { /* non-fatal — RAG still holds it */ }
        }

        chunks += await rag.ingest(text.slice(0, MAX_BYTES), {
          source:      'upload',
          source_path: filePath,
          folder_root: folderName,
          tenant_id:   req.tenant.id,
        });
        ingested++;
      }
      // Register the source. If we persisted files, store the ABSOLUTE folder path so
      // filesystem_read/list can reach it and the converger treats it as a filesystem
      // folder; image-only uploads (nothing persisted) stay RAG-only under the name.
      const sources = readSources(req.tenant.id);
      const usePath = wroteFiles > 0 ? folderDir : folderName;
      const entry   = { path: usePath, name: folderName, addedAt: Date.now(), files: ingested, chunks, source: 'upload', fileNames: writtenNames.slice(0, 100) };
      const idx     = sources.findIndex(s => s.path === usePath || s.path === folderName || s.name === folderName);
      if (idx >= 0) sources[idx] = { ...sources[idx], ...entry, reindexedAt: Date.now() };
      else sources.push(entry);
      writeSources(req.tenant.id, sources);
      res.json({ ok: true, folderName, files: ingested, chunks, path: usePath });
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

  // ── Slack interactivity — the approval buttons (P12 Increment D, §7.5) ──────
  //
  // A DIFFERENT URL from /connectors/slack/events. Block Kit buttons POST to the
  // app's *Interactivity* Request URL, and they arrive as
  // `application/x-www-form-urlencoded` with the payload in a `payload` field —
  // not as JSON. That is why this route mounts its own body parser: the global
  // one is `express.json`, which would leave `req.body` empty here and the
  // signature unverifiable.
  //
  // NOT auth-gated, and it must not be: Slack has no session with us. THE
  // SIGNATURE IS THE TRUST ANCHOR — HMAC-SHA256 over the raw bytes with the app
  // signing secret, with a 5-minute window against replay. Everything else in
  // this handler (the run id, the node id, the decision) is untrusted input that
  // Slack merely carried; the only thing the signature proves is that Slack sent
  // it, and the only thing the payload proves is WHICH SLACK USER clicked.
  //
  // The tenant is resolved from the Slack TEAM ID, never from the button's value:
  // a value is a routing hint, and a routing hint that could name a tenant would
  // be a cross-tenant forgery primitive.
  app.post(
    '/connectors/slack/interactive',
    express.urlencoded({ extended: false, limit: '256kb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
    async (req, res) => {
      const secret = process.env.SLACK_SIGNING_SECRET;
      if (!secret) return res.status(501).json({ error: 'Slack interactivity not configured (set SLACK_SIGNING_SECRET)' });
      if (!verifySlackSignature(req, secret)) {
        logEvent('approval.slack.bad_signature', {});
        return res.status(401).json({ error: 'bad signature' });
      }

      let payload;
      try { payload = JSON.parse(req.body?.payload ?? '{}'); }
      catch { return res.status(400).json({ error: 'bad payload' }); }

      if (payload.type !== 'block_actions') return res.status(200).end();

      const action = (payload.actions ?? [])[0];
      const [runId, nodeId, decision] = String(action?.value ?? '').split(':');
      const teamId      = payload.team?.id;
      const slackUserId = payload.user?.id;

      // The tenant this Slack workspace belongs to. If the workspace is not
      // connected to any tenant, there is no run it could possibly answer.
      const tenantId = spine.auth.oauthTokenStore.findTenantByAccount?.({ connectorId: 'slack', account: teamId });
      if (!tenantId) {
        logEvent('approval.slack.no_tenant', { teamId });
        return res.status(200).json({ text: 'This Slack workspace isn\'t connected to an Atlas workspace.' });
      }

      const result = await spine.approvals.resolveFromSlack({
        tenantId, slackUserId, runId, nodeId, decision,
      });
      logEvent('approval.slack', { tenant: tenantId, runId, nodeId, decision, ok: result.ok });

      // `replace_original` swaps the message with the outcome, so the buttons are
      // gone and a second reader cannot click a question that has been answered.
      res.status(200).json({
        replace_original: true,
        text: result.ok
          ? `:white_check_mark: *${decision}* — recorded by <@${slackUserId}>.`
          : `:warning: ${result.reason}`,
      });
    },
  );

  // ── Approvals — the magic link (P12 Increment D, §7.3/§7.5) ────────────────
  //
  // THE GET DECIDES NOTHING. It is a link in an email, and a link in an email is
  // fetched by things that are not people: scanning proxies, link checkers, the
  // mail client's own prefetcher. If the GET consumed the token, a corporate
  // security appliance would approve the customer's refund milliseconds after the
  // mail arrived, and the person it was sent to would find the decision already
  // made in their name. So the GET renders a page, and a POST from that page —
  // which no prefetcher will ever issue — is what answers the question.
  //
  // Unauthenticated by necessity: the recipient may have no Atlas account. The
  // TOKEN is the credential — 32 random bytes, stored only as a SHA-256 hash,
  // single-use, expiring, and bound to (run, node, decision) so a forwarded
  // "approve" link cannot be edited into a "reject".
  app.get('/approvals/:token', (req, res) => {
    const ask = spine.approvals.peekToken(req.params.token);
    res.type('html').send(renderApprovalPage(ask, req.params.token));
  });

  app.post('/approvals/:token', async (req, res) => {
    const result = await spine.approvals.resolveFromToken(req.params.token);
    logEvent('approval.email', { ok: result.ok, reason: result.reason ?? null });
    res.type('html').send(renderApprovalResult(result));
  });

  // ── Approvals — the in-app inbox (strong: an authenticated session) ─────────
  // Tenant-scoped at the store, not in this handler: `listAwaitingHuman` puts the
  // tenant in the WHERE clause, so there is no code path on which forgetting a
  // check here could surface another tenant's pending approval.
  app.get('/api/approvals', requireActiveTenant, (req, res) => {
    const runs = spine.engine.workflowStore.listAwaitingHuman({ tenantId: req.tenant.id });
    res.json({
      approvals: runs.map(r => {
        let workflowName = null;
        try { workflowName = spine.engine.workflowStore.get(r.workflow_id)?.name ?? null; } catch { /* best-effort */ }
        return {
          runId:     r.id,
          workflowId: r.workflow_id,
          workflowName,
          nodeId:    r.paused_node,
          prompt:    r.pending_ask?.prompt ?? 'Approve this step?',
          preview:   r.pending_ask?.preview ?? null,
          // The node's OWN answers — not a hardcoded approve/reject. A node may
          // declare any closed set, and the buttons have to offer what the engine
          // will actually accept, or the click is refused as "not one of the
          // answers this step offers" and the person cannot answer their own
          // question.
          decisions: r.pending_ask?.decisions ?? ['approve', 'reject'],
          pausedAt:  r.paused_at,
          expiresAt: r.pause_expires_at,
        };
      }),
    });
  });

  app.post('/api/approvals/:runId/:nodeId', requireActiveTenant, async (req, res) => {
    const result = await spine.approvals.resolveFromInbox({
      tenantId: req.tenant.id,
      userId:   req.user.id,
      runId:    req.params.runId,
      nodeId:   req.params.nodeId,
      decision: req.body?.decision,
    });
    logEvent('approval.inbox', {
      tenant: req.tenant.id, user: req.user.id,
      runId: req.params.runId, decision: req.body?.decision, ok: result.ok,
    });
    // 200 either way — "already answered" is a normal outcome (somebody got there
    // first), not a server error, and the UI needs to read the reason.
    res.json(result);
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
  app.post('/workflows/run', optionalAuth, tenantGuard, async (req, res) => {
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

    // Validate BEFORE executing. The publish path (workflowService.create) already
    // validates, but this — the "Run test" path — did not, so a spec the validator
    // would have rejected was executed against live third-party APIs anyway.
    //
    // That is exactly how the converger's `timeMin: "{{today}}"` reached Google and
    // returned 400 (2026-07-13): BAD_TEMPLATE_REF was catchable at build time, but
    // nobody asked the validator. A build-time error beats a live API failure every
    // time — and on a WRITE node it is the difference between a rejected spec and a
    // corrupt record in someone's CRM.
    //
    // Errors only: warnings still run, so this cannot block a spec that works today.
    // Returns 200 (not 4xx) — Cloudflare replaces origin 5xx with its own HTML error
    // page, which would hide the real issue from the UI. See CLAUDE.md gotchas.
    try {
      const verdict = spine.engine.workflowValidator?.validate?.(spec);
      const errors  = (verdict?.issues ?? []).filter(i => i.severity === 'error');
      if (errors.length) {
        logEvent('run.invalid', { tenant: tenantId, codes: errors.map(e => e.code) });
        return res.json({
          runId: null, completed: false, steps: [],
          error: errors[0].message,
          issues: errors,
        });
      }
    } catch { /* never block a run because the validator itself threw */ }

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
      // tenantId/workflowId are LOAD-BEARING: they scope the idempotency keys.
      // Omitting them used to collapse every tenant into one shared namespace
      // (`unscoped:<nodeId>`), so one tenant's step could be handed another
      // tenant's output. A step that cannot be scoped now refuses to run.
      const flowOpts = {
        ...(initialContext != null ? { initialContext } : {}),
        ...(dbRun ? { runId: dbRun.id } : {}),
        ...(req.tenant ? { tenantId: req.tenant.id } : {}),
        ...(spec.id ? { workflowId: spec.id } : {}),
      };
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
        // ── A TEST RUN NEVER PARKS (P12 Increment D) ───────────────────────
        // This is the builder's "Run test". A `human` step pauses it, and until
        // now that fell off the end of this loop: no steps after the pause, no
        // error, `completed:false` — the button did nothing and said nothing.
        //
        // It must not be made to park, either. A parked run is a REAL run: the
        // timeout sweeper would eventually resolve it and resume it, and the
        // steps after the approval — the customer email, the record — would
        // happen for real, out of a run the user pressed "test" on. So the test
        // stops here and REPORTS the pause: this is where it would ask, this is
        // who it would ask, this is what they would see.
        else if (ev.type === 'run_paused') {
          logEvent('run.paused', { tenant: tenantId, runId, nodeId: ev.nodeId });
          if (dbRun) {
            try { spine.engine.workflowStore.completeRun(dbRun.id, `paused at "${ev.nodeId}" — awaiting a person`, spine.costTracker?.getSessionCost?.(`flow-run-${runId}`) ?? null); }
            catch { /* best-effort */ }
          }
          return res.json({
            runId, completed: false, clean: true, paused: true,
            awaiting: { nodeId: ev.nodeId, ask: ev.ask },
            steps,
            note: `This workflow stops here and asks a person ("${ev.ask?.prompt ?? 'approve this step'}"). In a real run it would wait for their answer before going on.`,
          });
        }
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
      // R14: a step can "complete" (not throw) yet emit the ERROR sentinel that
      // prompts.js instructs LLM nodes to return when required upstream data is
      // missing ("ERROR: required data not found — do not compose content."). That
      // string is otherwise treated as valid output and delivered verbatim, while
      // the verdict reads "safe to publish". Surface these as issues so the test
      // verdict can mean "produced valid output", not merely "ran without throwing".
      const issues = steps
        .map((s) => ({ nodeId: s.nodeId, text: typeof s.output === 'string' ? s.output : '' }))
        .filter((s) => /^\s*ERROR:/i.test(s.text))
        .map((s) => ({ nodeId: s.nodeId, message: s.text.trim().replace(/\s+/g, ' ').slice(0, 300) }));
      const clean = completed && issues.length === 0;
      res.json({ runId, completed, clean, issues, output, deliveries, steps, cost: runCost });
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

  // ── Request-access stubs for not-yet-built connectors (demand capture) ──────
  // Users see these in the Connections flyout; clicking records a per-tenant
  // "vote" so the team can prioritise which connector to build next.
  const connectorDemand = new ConnectorDemandStore();

  app.get('/connectors/requestable', requireActiveTenant, (req, res) => {
    res.json({ connectors: connectorDemand.listFor(req.tenant.id) });
  });

  app.post('/connectors/:id/request-access', requireActiveTenant, (req, res) => {
    const id = req.params.id;
    if (!isRequestable(id)) return res.status(404).json({ error: 'unknown connector' });
    const requestCount = connectorDemand.record(id, {
      tenantId: req.tenant.id, userId: req.user.id, note: req.body?.note,
    });
    logEvent('connector.request_access', { tenantId: req.tenant.id, connector: id, requestCount });
    res.json({ ok: true, youRequested: true, requestCount });
  });

  // Platform-admin aggregate — the "what to build next" demand ranking.
  app.get('/connectors/demand', requireAuth, requirePlatformAdmin, (_req, res) => {
    res.json({ demand: connectorDemand.all() });
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

  // ── Billing (Stripe) ───────────────────────────────────────────────────────
  // Self-serve upgrade: the in-app Upgrade modal POSTs the target plan, we mint a
  // Stripe Checkout session and hand back its URL for the browser to redirect to.
  // Payment confirmation arrives asynchronously at /webhooks/stripe, which flips
  // the tenant's plan. Fails soft when Stripe isn't configured (clean 503).
  app.post('/api/billing/checkout', requireActiveTenant, async (req, res) => {
    try {
      if (!isBillingConfigured()) throw new BillingNotConfiguredError();
      const plan = String(req.body?.plan ?? '');
      if (!PUBLIC_PLANS.includes(plan)) return res.status(400).json({ error: 'Unknown plan.' });
      // Business grants unlimited runs and is quoted per engagement — never
      // reachable by card. A self-serve path into an unlimited plan is an
      // unbounded cost liability.
      if (!isSelfServe(plan)) {
        logEvent('billing.consultative_plan', { tenant: req.tenant?.id ?? null, plan });
        return res.status(409).json({
          error: 'Business is tailored to your team — talk to us and we\'ll scope it with you.',
          code: 'CONSULTATIVE_PLAN', plan,
        });
      }
      const tenant = spine.auth.tenantStore.get(req.tenant.id);

      // Existing subscriber → change the plan IN PLACE (no second subscription, no
      // double charge). Prorated onto the next invoice; card on file is used, so no
      // Checkout redirect. We setPlan + record the change here; the subscription.updated
      // webhook is then a no-op (its plan-already-matches guard prevents a double record).
      if (tenant?.stripe_subscription_id) {
        const before = tenant.plan;
        if (before === plan) return res.json({ ok: true, changed: false }); // nothing to do
        await changeSubscriptionPlan({ subscriptionId: tenant.stripe_subscription_id, plan });
        spine.auth.tenantStore.setPlan(tenant.id, plan);
        try {
          const mrr = (p) => (PUBLIC_PLANS.includes(p) ? PLAN_META[p].price * 100 : 0);
          spine.billingEvents.record({
            type: 'plan_change', tenantId: tenant.id, tenantName: tenant.name, plan, prevPlan: before,
            mrrDeltaCents: mrr(plan) - mrr(before), customerEmail: req.user?.email ?? null,
            subscriptionId: tenant.stripe_subscription_id,
          });
        } catch { /* feed record is best-effort */ }
        logEvent('billing.plan_change.inplace', { tenant: tenant.id, from: before, to: plan });
        return res.json({ ok: true, changed: true, plan });
      }

      // No subscription yet (comped/founding opting in) → new Checkout (first subscription).
      const session = await createCheckoutSession({
        tenantId: req.tenant.id, plan, email: req.user?.email ?? null, baseUrl: oauthRedirectBase(),
      });
      res.json({ ok: true, url: session.url });
    } catch (err) {
      logEvent('billing.checkout.error', { tenant: req.tenant?.id ?? null, code: err.code, error: err.message });
      res.status(err.status ?? 500).json({ error: err.message, code: err.code });
    }
  });

  // Stripe Billing Portal — manage/cancel an existing subscription.
  app.post('/api/billing/portal', requireActiveTenant, async (req, res) => {
    try {
      if (!isBillingConfigured()) throw new BillingNotConfiguredError();
      const tenant = spine.auth.tenantStore.get(req.tenant.id);
      if (!tenant?.stripe_customer_id) return res.status(400).json({ error: 'No billing account is linked to this workspace yet.' });
      const session = await createPortalSession({ customerId: tenant.stripe_customer_id, baseUrl: oauthRedirectBase() });
      res.json({ ok: true, url: session.url });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message, code: err.code });
    }
  });

  // Public, pre-tenant signup checkout — the marketing site (or the in-app signup
  // form) POSTs {email, workspaceName, plan}; the tenant is provisioned by the webhook
  // ONLY on real payment. No auth; lightly throttled. Rejects emails that already have
  // an account (they should sign in / resubscribe instead).
  app.post('/api/signup/checkout', async (req, res) => {
    try {
      if (!isBillingConfigured()) throw new BillingNotConfiguredError();
      if (signupThrottled(req)) return res.status(429).json({ error: 'Too many attempts — try again in a minute.' });
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const plan = String(req.body?.plan ?? '');
      const workspaceName = String(req.body?.workspaceName ?? '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (!PUBLIC_PLANS.includes(plan)) return res.status(400).json({ error: 'Choose a plan.' });
      if (!isSelfServe(plan)) {
        logEvent('billing.signup.consultative_plan', { email, plan });
        return res.status(409).json({
          error: 'Business is tailored to your team — talk to us and we\'ll scope it with you.',
          code: 'CONSULTATIVE_PLAN', plan,
        });
      }
      if (spine.auth.userStore.findByEmail(email)) {
        return res.status(409).json({ error: 'An account with that email already exists — please sign in.', code: 'ACCOUNT_EXISTS' });
      }
      const session = await createSignupCheckoutSession({ email, workspaceName, plan, baseUrl: oauthRedirectBase() });
      logEvent('billing.signup.checkout', { email, plan });
      res.json({ ok: true, url: session.url });
    } catch (err) {
      logEvent('billing.signup.checkout_error', { code: err.code, error: err.message });
      res.status(err.status ?? 500).json({ error: err.message, code: err.code });
    }
  });

  // Resubscribe for a SUSPENDED tenant. The user has no session (login 403s), so this
  // accepts the short-lived reactivation token minted by /auth/login and checks out for
  // the tenant's plan, reusing its Stripe customer. Payment → webhook reactivates.
  app.post('/api/billing/resubscribe', async (req, res) => {
    try {
      if (!isBillingConfigured()) throw new BillingNotConfiguredError();
      const claims = spine.auth.tokenService.verify(String(req.body?.reactivationToken ?? ''));
      if (!claims || claims.scope !== 'reactivate' || !claims.tid) {
        return res.status(401).json({ error: 'This resubscribe link has expired — sign in again to restart.' });
      }
      const tenant = spine.auth.tenantStore.get(claims.tid);
      if (!tenant) return res.status(404).json({ error: 'Workspace not found.' });
      const requested = req.body?.plan;
      const plan = PUBLIC_PLANS.includes(requested) ? requested
        : (PUBLIC_PLANS.includes(tenant.plan) ? tenant.plan : 'solo');
      const session = await createCheckoutSession({
        tenantId: tenant.id, plan, customerId: tenant.stripe_customer_id ?? null,
        baseUrl: oauthRedirectBase(), context: 'resubscribe',
      });
      res.json({ ok: true, url: session.url });
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message, code: err.code });
    }
  });

  // Stripe webhook — no auth; verified by signature over the RAW body (captured as
  // req.rawBody by the global express.json verify hook). classifyWebhookEvent parses
  // it; handleStripeLifecycle provisions/reactivates/suspends the tenant, records the
  // billing event, and fires #sales + customer emails. A thrown critical error → 500
  // so Stripe retries; notifications are best-effort and never throw.
  app.post('/webhooks/stripe', async (req, res) => {
    let event;
    try {
      event = await constructWebhookEvent(req.rawBody, req.headers['stripe-signature']);
    } catch (err) {
      logEvent('billing.webhook.bad_signature', { error: err.message });
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      await handleStripeLifecycle(spine, classifyWebhookEvent(event), { base: oauthRedirectBase() });
      res.json({ received: true });
    } catch (err) {
      logEvent('billing.webhook.error', { type: event?.type, ...errFields(err) });
      res.status(500).json({ error: 'webhook handler failed' });
    }
  });

  mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth, readSources, tenantGuard });
  mountConsoleRoutes(app, { spine, requireActiveTenant });
  mountTicketRoutes(app, { spine, requireActiveTenant });
  mountAdminRoutes(app, { spine, requireAuth, requirePlatformAdmin, optionalAuth });

  // Global error handler — last middleware. Catches anything a route's try/catch
  // missed (including synchronous throws in handlers) so an unhandled error
  // returns a sanitized 500 instead of hanging the socket. The full error goes to
  // the log only — never leak internals to the client.
  app.use((err, req, res, _next) => {
    logEvent('http.unhandled_error', {
      reqId: req.id,
      method: req.method, path: req.path,
      tenant: req.tenant?.id ?? null, user: req.user?.id ?? null,
      ...errFields(err),
    });
    if (res.headersSent) return; // response already streaming (e.g. SSE) — can't change status
    res.status(500).json({ error: 'Internal server error' });
  });

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
  // Slowloris hardening: bound how long a client may take to send request
  // headers. requestTimeout stays generous so a slow but legitimate upload of a
  // full body (JSON capped at 4mb) isn't cut off; it never limits response
  // duration, so SSE streams and long workflow runs are unaffected.
  server.headersTimeout = numEnv('HEADERS_TIMEOUT_MS', 30_000);
  server.requestTimeout = numEnv('REQUEST_TIMEOUT_MS', 300_000);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} — draining`);
    // Stop starting new scheduled runs immediately, then stop accepting new
    // connections and let in-flight requests finish before disposing + exiting.
    try { spine.engine.workflowScheduler.stop?.(); } catch { /* ignore */ }
    server.close(async () => {
      try { await spine.disposeModels(); } catch { /* ignore */ }
      try { spine.close(); } catch { /* ignore */ }
      process.exit(0);
    });
    // Nudge idle keep-alives so server.close can resolve; active requests still finish.
    try { server.closeIdleConnections?.(); } catch { /* ignore */ }
    // Backstop: if connections (e.g. a long SSE stream) don't drain in time, force exit.
    const graceMs = numEnv('SHUTDOWN_GRACE_MS', 10000);
    setTimeout(() => { console.error('drain timeout — forcing exit'); process.exit(1); }, graceMs).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Never die silently. An unhandledRejection is logged but non-fatal — one stray
  // promise shouldn't take the whole server down. An uncaughtException leaves the
  // process in an undefined state, so we log, then exit non-zero; a process manager
  // restarts us and boot reconciliation cleans up any interrupted run.
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logEvent('process.unhandledRejection', errFields(err));
    console.error('unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    logEvent('process.uncaughtException', errFields(err));
    console.error('uncaughtException:', err);
    try { server.close(() => process.exit(1)); } catch { process.exit(1); }
    setTimeout(() => process.exit(1), 3000).unref(); // backstop if close hangs
  });

  return { server, spine };
}

// Boot when run directly (`npm start`), not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error('spine failed to boot:', err);
    process.exit(1);
  });
}
