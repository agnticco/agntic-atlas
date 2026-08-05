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
import { createRunGate, minGapMs } from '../workflows/trigger-frequency.js';
import { CapabilityRegistry } from '../connectors/capability-registry.js';
import { ConnectorDemandStore, REQUESTABLE_CONNECTORS, isRequestable } from '../connectors/connector-demand.js';
import { APP_VERSION } from '../version.js';
import { LlamaCppLLM, ModelPool, ChatModel, CostTracker } from '../llm/index.js';
import { EmbeddingModel, TextSplitter, VectorStore, DocumentLoader } from '../rag/index.js';
import { registerSlackChannel, registerSlackTriggers, createSlackCapabilityProvider,
         makeSlackApi, resolveUser, resolveChannel } from '../connectors/slack/index.js';
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
  isAirtableRecordChangedTrigger, syncAirtableWebhooksForTenant,
  refreshAllAirtableWebhooks, airtableNotificationUrl,
} from '../connectors/airtable/webhook-sync.js';
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
import { registerKnowledgeCapabilities, knowledgeState } from '../connectors/knowledge/index.js';
import { mountBuilderRoutes } from './builder.js';
import { createTenantGuard } from './tenant-guard.js';
import { mountConsoleRoutes } from './console.js';
import { mountAdminRoutes } from '../admin/server.js';
import { recordSlackEventSeen } from '../connectors/slack/delivery-record.js';
import { logEvent, errFields } from '../utils/event-log.js';
import { boolEnv, numEnv } from '../utils/env.js';
import { FileCheckpointer } from '../graph/checkpointer/index.js';
import { sendMail, mailerConfigured } from '../utils/mailer.js';
import { renderResetEmail } from '../auth/reset-email.js';
// P12 Increment D — the human approval gate (converger-v2 §7).
import { ApprovalStore } from '../approvals/approval-store.js';
import { ApprovalService } from '../approvals/approval-service.js';
import { availableApprovalChannels, approvalChannelView } from '../workflows/approval-channels.js';
import { deliveriesForStep, setCapabilityCatalog } from '../workflows/outcome-oracle.js';
import { evaluateDeliveryRun, judgeFailedRun } from '../workflows/delivery-verdict.js';
import { runSpecDryRun } from '../workflows/dry-run-runner.js';
import { oauthRedirectBase, redirectReachableFrom } from '../connectors/oauth-redirect.js';
import { CIMD_PATH, clientIdMetadata } from '../connectors/client-identity.js';
import { createMcpConnectFlow } from '../connectors/mcp-connect.js';
import { registerMcpCatalog } from '../connectors/mcp-catalog.js';
import { MCP_DIRECTORY, mcpService } from '../connectors/mcp-directory.js';
import { mcpConnectedFor, mcpOwnerId, mcpConnectorId, ensureMcpToolsLoaded } from '../connectors/connected-services.js';
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

/* ── P13-0 seam #4: which credential a node needs is DECLARED, not listed ─────
 *
 * This used to be three hand-typed Sets of capability ids — and the Google one
 * carried its own warning: *"keep in sync with the Google capability catalog. A
 * capability missing here gets no googleToken injected → 'no access token' at run
 * time even though it's connected (this is how drive_create_folder broke, R22)."*
 *
 * A comment telling the next person to remember something is not a mechanism. The
 * capability already knows which connector it belongs to — it declared it at
 * registration — so credential resolution reads that instead of a parallel list
 * somebody has to maintain. Import a server exposing forty tools and the old shape
 * needed forty strings hand-added here, with a run-time failure for every one
 * missed, on a connector the customer had correctly connected.
 *
 * The catalog is injected once at boot rather than threaded through the six call
 * sites that build `deps` differently. Unset ⇒ the legacy id-prefix fallback, which
 * is exactly what Slack already did, so nothing regresses in a test that builds the
 * injectors without an engine.
 */
let _injectorCatalog = null;
export function setInjectorCatalog(catalog) {
  _injectorCatalog = (catalog && typeof catalog.get === 'function') ? catalog : null;
}

/** The capability id a node invokes, whichever node type it is. */
const capabilityIdOf = (n) =>
  n?.type === 'deliver'           ? String(n?.config?.channel ?? '').trim()
  : n?.type === 'connector-action' ? String(n?.config?.action  ?? '').trim()
  : '';

/**
 * Does this node belong to `connectorId`? Answered by the capability's DECLARED
 * connector. Falls back to the id prefix only for capabilities the catalog does not
 * know — note this fallback CANNOT work for Google (`gmail_search`, `sheets_append`,
 * `docs_create` share no prefix with 'google'), which is precisely why the
 * declaration is the primary source and the list had to exist at all.
 */
export const ownsConnector = (connectorId) => (n) => {
  const id = capabilityIdOf(n);
  if (!id) return false;
  const declared = _injectorCatalog?.get?.(id)?.connector;
  if (declared) return String(declared).toLowerCase() === connectorId;
  const lower = id.toLowerCase();
  return lower === connectorId || lower.startsWith(`${connectorId}_`);
};

const isSlackNode    = ownsConnector('slack');
const isAirtableNode = ownsConnector('airtable');
const isGoogleNode   = ownsConnector('google');

// ── Connector credential registry ────────────────────────────────────────────
// Per-tenant credential handling for EVERY connector, in one place. Each entry
// declares: which workflow nodes it owns, the human name, how to resolve THIS
// tenant's token, which config field to inject it into, and an optional dev
// escape hatch (for connectors with an operator env token). Adding a connector —
// now or in future — is ONE entry here; no run-path changes, nothing per-workflow.
const CONNECTOR_INJECTORS = [
  {
    // ── A ONE-CLICK SERVICE'S CREDENTIAL ──────────────────────────────────
    //
    // Not a hand-typed action list — the P13-0 R22 defect — but the connector a
    // capability DECLARES, resolved through the same catalog everything else
    // reads. A service connected tomorrow is injected tomorrow.
    //
    // Without this the handler runs with no token and correctly refuses, which
    // reads to a customer as "the service is broken" rather than "not connected".
    id: 'mcp',
    name: 'Connected service',
    ownsNode: (n) => {
      const id = n?.config?.action ?? n?.config?.channel;
      if (!id || typeof id !== 'string') return false;
      const svc = mcpService(String(id).split('_')[0]);
      return !!svc;
    },
    resolveToken: (tenantId, { oauthTokenStore, cipher }, node) => {
      const id = node?.config?.action ?? node?.config?.channel;
      const svc = mcpService(String(id ?? '').split('_')[0]);
      if (!svc) return null;
      const row = oauthTokenStore.get({
        tenantId, userId: mcpOwnerId(tenantId), connectorId: mcpConnectorId(svc.id),
      });
      if (!row) return null;
      try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
    },
    field: 'mcpToken',
    perNode: true,          // the token differs per SERVICE, not per tenant
    devEscape: () => false,
  },
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

// A NODE IS A NODE WHEREVER IT LIVES — INCLUDING INSIDE A `foreach` (2026-07-19).
//
// Every injector below walked `spec.nodes` with `.some(pred)` / `.map(pred)`, i.e. the
// TOP LEVEL ONLY. A connector write inside a `foreach` therefore received nothing:
// `nodes.some(isAirtableNode)` was false, the injector short-circuited, and the sub-step
// failed at run time with **"airtable: not connected — authorize via …"** for a connector
// that was connected and healthy. That message sends the user to re-authorize a working
// connector; nothing points at the loop.
//
// It was not one injector. All four had the identical shape, so inside a `foreach`:
//   · injectTenantTokens          → no credentials      (every connector: airtable/google/slack)
//   · injectInboxContext          → no _tenantId/_userId (inbox delivery silently misrouted)
//   · injectInboxCapabilityContext→ no _tenantId
//   · injectFilesystemContext     → no _tenantId        (sandbox check cannot resolve)
// So the canonical bulk-write shape — the one Increment F exists to enable and its own
// prompt teaches ("create a record for every row") — could not run at all.
//
// This is the FIFTH site to get this wrong: the validator (F#3), the outcome oracle (F#4),
// `isWriteNode` (D#4) and `CONTROL_SUBSTEP_TYPES` (E#1) each had to learn it separately.
// CLAUDE.md's own rule is "a check on a node's config is a check on EVERY node's config,
// wherever the node lives" — these are injections rather than checks, which is presumably
// how they escaped every sweep, but they traverse the node list exactly like the checks do.
// Hence ONE pair of helpers, used by all four, rather than four more private fixes.
const someNodeDeep = (nodes, pred) => (nodes ?? []).some((n) =>
  pred(n) || (n?.type === 'foreach' && Array.isArray(n?.config?.steps) && someNodeDeep(n.config.steps, pred)));

const mapNodesDeep = (nodes, fn) => (nodes ?? []).map((n) => {
  const mapped = fn(n);
  // Recurse AFTER `fn` so a foreach node still gets its own turn (it is never a connector
  // node, so this is a no-op for it) and its steps are then mapped with the same function.
  return (mapped?.type === 'foreach' && Array.isArray(mapped?.config?.steps))
    ? { ...mapped, config: { ...mapped.config, steps: mapNodesDeep(mapped.config.steps, fn) } }
    : mapped;
});

// Inject the owning tenant's credentials into every connector node of a workflow/
// spec, so the run acts as that tenant — never a shared/operator token. Used by
// EVERY run path (run-test, event dispatch, scheduler). Connector-agnostic.
async function injectTenantTokens(obj, tenantId, deps) {
  if (!tenantId || !(obj?.nodes?.length)) return obj;

  // ── LOAD BEFORE RUNNING, AT THE ONE PLACE EVERY RUN PATH PASSES THROUGH ───
  //
  // A one-click service's tools live in memory and its grant lives on disk, so
  // after any restart the capability is GONE until something re-reads the
  // catalog. WITNESSED: with the handler fixed, the first real run still failed
  // — `Channel "notion_create-pages" is not wired in this build.` — because the
  // process had booted since the customer connected, and nothing on the run path
  // reloads.
  //
  // A scheduled workflow is the case that matters: it fires at 8am into whatever
  // process happens to be running, with no browser to have warmed anything.
  // Putting it here rather than in each caller is deliberate — this function is
  // documented as the one every run path uses (REST, scheduler, Slack dispatch,
  // Airtable dispatch), and a per-caller fix is how the connected-services list
  // ended up with six copies.
  if (deps?.capabilityRegistry && deps?.oauthTokenStore && deps?.cipher) {
    await ensureMcpToolsLoaded({
      capabilityRegistry: deps.capabilityRegistry,
      oauthTokenStore: deps.oauthTokenStore,
      tokenCipher: deps.cipher,
      tenantId,
      onEvent: logEvent,
    }).catch(() => { /* a service we cannot read must not stop a run that does not use it */ });
  }

  let nodes = obj.nodes;
  let changed = false;
  for (const c of CONNECTOR_INJECTORS) {
    if (!someNodeDeep(nodes, c.ownsNode)) continue;

    // A PER-NODE injector resolves per step, because which credential a step
    // needs depends on WHICH SERVICE it names — one workspace may hold Notion and
    // Linear at once, and a single tenant-wide token would hand a Linear step
    // Notion's credential.
    if (c.perNode) {
      // Collected with the SAME deep walker the injection uses, so a step inside
      // a `foreach` is not missed — "added to the top-level executor, not the
      // sub-loop" is a defect shape this repo has recorded three times.
      const owned = [];
      mapNodesDeep(nodes, (n) => { if (c.ownsNode(n)) owned.push(n); return n; });

      const resolved = new Map();
      for (const n of owned) {
        const key = String(n?.config?.action ?? n?.config?.channel ?? '');
        if (resolved.has(key)) continue;
        resolved.set(key, await c.resolveToken(tenantId, deps, n));
      }
      nodes = mapNodesDeep(nodes, (n) => {
        if (!c.ownsNode(n) || n?.config?.[c.field] != null) return n;
        const tok = resolved.get(String(n?.config?.action ?? n?.config?.channel ?? ''));
        return tok ? { ...n, config: { ...n.config, [c.field]: tok } } : n;
      });
      changed = true;
      continue;
    }

    const tok = await c.resolveToken(tenantId, deps);
    if (!tok) continue;
    nodes = mapNodesDeep(nodes, (n) => (c.ownsNode(n) && n?.config?.[c.field] == null)
      ? { ...n, config: { ...n.config, [c.field]: tok } } : n);
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
  if (!someNodeDeep(spec.nodes, isInbox)) return spec;   // deep: an inbox delivery inside a foreach counts
  const nodes = mapNodesDeep(spec.nodes, (n) => isInbox(n)
    ? { ...n, config: { ...n.config, channel: 'inbox_deliver', subject: n.config.subject ?? n.config.title, _tenantId: tenantId, _userId: userId, ...extras } }
    : n);
  return { ...spec, nodes };
}

// Inject tenant identity into search_inbox connector-action nodes.
function injectInboxCapabilityContext(spec, tenantId) {
  if (!tenantId || !(spec?.nodes?.length)) return spec;
  const isInboxCap = (n) => n?.type === 'connector-action' && INBOX_CAPABILITY_IDS.has(n?.config?.action);
  if (!someNodeDeep(spec.nodes, isInboxCap)) return spec;
  const nodes = mapNodesDeep(spec.nodes, (n) => isInboxCap(n)
    ? { ...n, config: { ...n.config, _tenantId: tenantId } }
    : n);
  return { ...spec, nodes };
}

// Inject tenant identity into filesystem_read / filesystem_list nodes so the
// handler can validate the path against the tenant's approved folders.
const KNOWLEDGE_CAPABILITY_IDS = new Set(['knowledge_search', 'knowledge_write']);

// Also stamps KNOWLEDGE nodes: RAG is physically isolated per tenant and the capability
// REFUSES to run without a tenant in scope rather than searching unscoped — so a node
// that never got stamped fails loudly instead of reading another workspace's documents.
function injectFilesystemContext(spec, tenantId) {
  if (!tenantId || !(spec?.nodes?.length)) return spec;
  // BOTH NODE SHAPES. `knowledge_write` can occupy a DELIVERY position, where the
  // capability id lives in `config.channel` rather than `config.action`. Stamping only
  // `connector-action` would leave that node without a tenant, and the capability
  // refuses to run without one — a workflow that built cleanly would fail at run time.
  // This is the "added to the top-level executor, not the sub-loop" shape: handling one
  // form of a thing and not the other.
  const capIdOf = (n) => (n?.type === 'connector-action' ? n?.config?.action
                       :  n?.type === 'deliver'          ? n?.config?.channel
                       :  null);
  const isFs = (n) => {
    const id = capIdOf(n);
    return !!id && (FILESYSTEM_CAPABILITY_IDS.has(id) || KNOWLEDGE_CAPABILITY_IDS.has(id));
  };
  if (!someNodeDeep(spec.nodes, isFs)) return spec;
  const nodes = mapNodesDeep(spec.nodes, (n) => isFs(n)
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

// Inject THIS tenant's tokens/context into a converger draft, then run it through
// the engine with terminal side-effects STUBBED (dryRunDeliveries) and judge the
// result against its outcome contract. This is the service the converger's
// self-verification loop (`verify` node, #23) calls to test its own draft on a
// sample event — build → run → read → fix — WITHOUT any real send/write/post. The
// injection here mirrors POST /workflows/run exactly, so llm + connector-read steps
// behave as they will in production; only the terminal sends are intercepted. The
// dry-run itself lives in the engine-only `runSpecDryRun` (unit-testable without the
// server); this wrapper is the one place that knows the tenant's credentials.
async function dryRunSpecForTenant(spine, spec, { tenantId = null, userId = null, initialContext = undefined } = {}) {
  let s = spec;
  if (tenantId) {
    const deps = { oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, userId, capabilityRegistry: spine.engine.capabilityRegistry };
    s = await injectTenantTokens(s, tenantId, deps);
    if (userId) s = injectInboxContext(s, tenantId, userId);
    s = injectFilesystemContext(s, tenantId);
    s = injectInboxCapabilityContext(s, tenantId);
  }
  // The oracle judges against the spec's own `outcome`, which injection preserves
  // (it only rewrites `nodes`). Pass the injected spec so deliveries resolve.
  return runSpecDryRun({
    flowTester:  spine.engine.flowTester,
    spec:        s,
    initialContext,
    tenantId,
    costTracker: spine.costTracker,
    userId,
  });
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

/**
 * Resolve a trigger's channel target ("#requests", "requests", or "C0123…") to a
 * Slack channel ID, so a filter written the ONLY way a user knows a channel — by
 * name — can actually match the ID Slack puts on the event.
 *
 * Cached per tenant+target. A successful resolution is cached indefinitely (channel
 * ids are stable); a FAILURE is cached only briefly, because the usual cause is a
 * channel the bot has not been invited to yet, and a permanent negative would mean
 * inviting the bot never takes effect until a restart.
 *
 * Returns null when it cannot be resolved — callers must treat that as "does not
 * match" and say so in the log, never as "matches anything".
 */
const _slackChannelIdCache = new Map(); // JSON.stringify([tenantId, target]) → { id, at }
const SLACK_CHANNEL_MISS_TTL_MS = 60_000;

async function resolveSlackChannelId(spine, tenantId, target) {
  if (!target) return null;
  const raw = String(target);
  if (/^[CGDW][A-Z0-9]+$/i.test(raw)) return raw;   // already an id

  const key = JSON.stringify([tenantId, raw]);      // never concatenate — "ab"+"c" collides with "a"+"bc"
  const hit = _slackChannelIdCache.get(key);
  if (hit && (hit.id || Date.now() - hit.at < SLACK_CHANNEL_MISS_TTL_MS)) return hit.id;

  let id = null;
  try {
    const grant = getSlackToken({ oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId });
    if (grant?.botToken) id = await resolveChannel(makeSlackApi({ token: grant.botToken }), raw);
  } catch { id = null; }                            // not found / no scope / API down → unresolved
  _slackChannelIdCache.set(key, { id, at: Date.now() });
  if (_slackChannelIdCache.size > 2000) _slackChannelIdCache.clear(); // crude bound
  return id;
}

/**
 * Which of a tenant's live workflows does this Slack event actually fire?
 *
 * Exported and pure (channel resolution is injected) because this is the logic
 * that was wrong, and a check has to be able to construct it the way production
 * does. Production passes the real resolver; a test passes a stub.
 *
 * @param {object[]} flows            — the tenant's active flows
 * @param {object}   ev               — the Slack event
 * @param {string}   wantEvent        — 'message' | 'app_mention'
 * @param {Function} resolveChannelId — async (target) => channelId | null
 * @param {Function} [onUnresolved]   — (workflow, target) => void, for logging
 */
export async function selectSlackFlows({ flows, ev, wantEvent, resolveChannelId, onUnresolved }) {
  const isSlackTrigger = (t) => t.type === 'event' && t.connector === 'slack' && t.event === wantEvent;

  // The `keywords` filter is declared on the slack_message trigger's config schema
  // and was previously enforced by NOTHING — the workflow fired on every message
  // while its own definition promised otherwise.
  const keywordMatches = (t) => {
    const raw = t.filter?.keywords ?? t.filter?.keyword;
    if (raw === undefined || raw === null || raw === '') return true;
    const words = (Array.isArray(raw) ? raw : String(raw).split(','))
      .map((w) => String(w).trim().toLowerCase()).filter(Boolean);
    if (!words.length) return true;
    const text = String(ev.text ?? '').toLowerCase();
    return words.some((w) => text.includes(w));
  };

  const matched = [];
  for (const w of (flows ?? [])) {
    const triggers = (w.triggers ?? []).filter(isSlackTrigger);
    if (!triggers.length) continue;
    let hit = false;
    for (const t of triggers) {
      if (!keywordMatches(t)) continue;
      const want = t.filter?.channel;
      if (!want) { hit = true; break; }             // no channel filter → any channel
      // A name ("#requests") is the only form a user knows; resolve it to the id
      // Slack puts on the event. Unresolved means DOES NOT MATCH — never "matches all".
      const id = await resolveChannelId(want);
      if (id && id === ev.channel) { hit = true; break; }
      if (!id) onUnresolved?.(w, String(want));
    }
    if (hit) matched.push(w);
  }
  return matched;
}

/**
 * Which trigger event name (if any) a raw Slack event satisfies.
 *
 * `app_mention` used to be dropped here, which made the "Slack App Mention"
 * trigger — offered by the capability catalog, and emitted by the converger as
 * `event:"app_mention"` — impossible to fire. Bot echoes, edits and joins are
 * still ignored.
 *
 * @returns {'message'|'app_mention'|null}
 */
export function slackEventKind(ev) {
  if (!ev || ev.bot_id || ev.subtype) return null;
  if (ev.type === 'app_mention') return 'app_mention';
  if (ev.type === 'message') return 'message';
  return null;
}

async function dispatchSlackEvent(spine, body) {
  const teamId = body?.team_id;
  const ev = body?.event ?? {};
  // A Slack event satisfies exactly one trigger event name; anything else is ignored.
  const wantEvent = slackEventKind(ev);
  if (!teamId || !wantEvent) return;
  const isMention = wantEvent === 'app_mention';

  // EVERY tenant that installed this Slack workspace, not an arbitrary one. The same
  // workspace can be connected by several tenants — each ran the OAuth flow — and an
  // event from it is genuinely theirs. Picking one silently is what made a live workflow
  // never fire: `T0B3RTT3Z5X` resolved to `agntic` while the only Slack-triggered
  // workflow lived in `platform` (2026-08-01).
  const tenants = spine.auth.oauthTokenStore.findTenantsByAccount?.({ connectorId: 'slack', account: teamId }) ?? [];
  if (!tenants.length) { logEvent('slack.event.no_tenant', { teamId }); return; }
  for (const tenantId of tenants) {
    await dispatchSlackEventForTenant(spine, { tenantId, ev, wantEvent, isMention });
  }
}

/** One tenant's share of an inbound Slack event. Isolated: its own workflows, its own token. */
async function dispatchSlackEventForTenant(spine, { tenantId, ev, wantEvent, isMention }) {
  const flows = await selectSlackFlows({
    // ── A FAILED RUN MUST NOT TAKE A LIVE WORKFLOW OFF THE AIR ───────────────
    //
    // MEASURED 2026-08-03: four Slack messages, ONE run. The first failed, and
    // `_executeFlow` marks the workflow `status: 'error'` so the sidebar dot turns
    // red — which is useful. But this query only ever asked for `active`, so the
    // next three messages matched nothing and were dropped in silence. One bad run
    // permanently disabled a live workflow, and the owner was never told.
    //
    // `error` is a HEALTH signal, not a pause. A workflow that failed last time is
    // still one the customer asked to run, and the commonest causes — a model
    // timing out, a rate limit — are gone by the next event. Only PAUSED means
    // stop, and that is a decision a person made.
    //
    // Scoped to the event path deliberately: the scheduler decides its own due-ness
    // elsewhere, and widening both from here would be changing something that has
    // not been measured.
    flows: spine.engine.workflowStore.list({ tenantId, kind: 'flow' })
      .filter((w) => w.status === 'active' || w.status === 'error'),
    ev, wantEvent,
    resolveChannelId: (target) => resolveSlackChannelId(spine, tenantId, target),
    onUnresolved: (w, target) =>
      logEvent('slack.event.channel_unresolved', { tenant: tenantId, workflow: w.slug, channel: target }),
  });

  if (!flows.length) return;
  const slackDeps = { oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, capabilityRegistry: spine.engine.capabilityRegistry };
  const context = isMention
    ? `Atlas was @-mentioned in <#${ev.channel}> by <@${ev.user}>:\n\n${ev.text ?? ''}`
    : `New Slack message in <#${ev.channel}> from <@${ev.user}>:\n\n${ev.text ?? ''}`;
  for (const wf of flows) {
    logEvent('slack.event.dispatch', { tenant: tenantId, workflow: wf.slug, channel: ev.channel, event: wantEvent });
    let tenantWf = await injectTenantTokens(wf, tenantId, { ...slackDeps, userId: wf.user_id });
    tenantWf = injectInboxContext(tenantWf, tenantId, tenantWf.user_id ?? '');
    tenantWf = injectFilesystemContext(tenantWf, tenantId);
    tenantWf = injectInboxCapabilityContext(tenantWf, tenantId);
    try { await spine.engine.workflowScheduler._executeFlow(tenantWf, { trigger: 'event', emailContext: context }); }
    catch (err) { logEvent('slack.event.error', { tenant: tenantId, workflow: wf.slug, ...errFields(err) }); }
  }
}

// Releases Airtable-triggered runs no faster than each workflow's `checkEvery`
// setting allows, holding (never dropping) anything that arrives inside the window.
const _airtableRunGate = createRunGate();

// Route an Airtable webhook notification to matching workflows.
// Airtable only sends a ping (base + webhook id); payloads are fetched separately.
async function dispatchAirtableEvent(spine, body) {
  const baseId    = body?.base?.id;
  const webhookId = body?.webhook?.id;
  if (!baseId || !webhookId) return;

  const route = lookupWebhook(webhookId);
  if (!route) { logEvent('airtable.event.no_route', { baseId, webhookId }); return; }

  const { tenantId } = route;
  const airtableDeps = { oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, capabilityRegistry: spine.engine.capabilityRegistry };
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

  // `isAirtableRecordChangedTrigger` accepts both the bare `record_changed` and the
  // capability id `airtable_record_changed`. This matcher only ever accepted the
  // bare form, while the converger's generic trigger template emits the capability
  // id — so a correctly-built Airtable trigger matched NOTHING here even before the
  // missing-webhook problem. Two independent silent failures on the same feature.
  // A FAILED RUN MUST NOT TAKE A LIVE WORKFLOW OFF THE AIR — the same rule the
  // Slack path was given hours earlier, and this one did not have. Found by
  // comparing the two dispatchers rather than by anything failing: `error` is a
  // health signal, not a pause, and asking only for `active` means one bad run
  // silently disables a workflow for ever. Only PAUSED means stop.
  const flows = spine.engine.workflowStore.list({ tenantId, kind: 'flow' })
    .filter((w) => (w.status === 'active' || w.status === 'error'))
    .filter((w) => (w.triggers ?? []).some((t) =>
      isAirtableRecordChangedTrigger(t) &&
      (!t.filter?.baseId || t.filter.baseId === baseId)));

  if (!flows.length) return;
  const context = `Airtable record changed in base ${baseId}.\n\nChanges:\n${JSON.stringify(payloads.slice(0, 3), null, 2)}`;
  for (const wf of flows) {
    // Honour "how often may this run?" (`checkEvery`). Airtable PUSHES to us, so
    // there is no checking to slow down — the setting is a floor on how often the
    // workflow may run, which is what a person means when a busy base would
    // otherwise fire the same workflow all day and eat the month's run budget.
    //
    // A change arriving inside the window is DEFERRED, never dropped: the deferred
    // run re-reads the base, so nothing that happened in the gap is lost.
    const gate = _airtableRunGate.request({
      key: JSON.stringify([tenantId, wf.id]),          // never concatenate — collisions
      gapMs: minGapMs(wf, { only: isAirtableRecordChangedTrigger }),
      run: async () => {
        logEvent('airtable.event.dispatch', { tenant: tenantId, workflow: wf.slug });
        let tenantWf = await injectTenantTokens(wf, tenantId, { ...airtableDeps, userId: wf.user_id });
        tenantWf = injectInboxContext(tenantWf, tenantId, tenantWf.user_id ?? '');
        tenantWf = injectFilesystemContext(tenantWf, tenantId);
        tenantWf = injectInboxCapabilityContext(tenantWf, tenantId);
        try { await spine.engine.workflowScheduler._executeFlow(tenantWf, { trigger: 'event', emailContext: context }); }
        catch (err) { logEvent('airtable.event.error', { tenant: tenantId, workflow: wf.slug, ...errFields(err) }); }
      },
    });
    if (gate.released) await gate.promise;             // keep dispatch serial, as before
    else logEvent('airtable.event.deferred', { tenant: tenantId, workflow: wf.slug, waitMs: gate.waitMs, coalesced: gate.coalesced });
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
    // architect: the converger's whole-spec generation — the one reasoning-heavy
    // call per build (n8n-level workflow in a single pass) — runs on Opus. Model
    // id is env-overridable so the exact Opus version is set without a code change.
    // Cost is attributed per build via costContext 'converger' + the build's threadId.
    const architect = new ChatModel({ provider: 'anthropic', model: process.env.CONVERGER_ARCHITECT_MODEL?.trim() || 'claude-opus-4-6', apiKey: anthropicKey });
    return new ModelPool({ tiers: { fast, balanced, powerful, architect }, defaultTier: 'balanced', costTracker });
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
  // P13-0 seams #1/#2/#4 — the oracle derives effect from what a capability DECLARES,
  // and credential resolution reads the connector a capability DECLARES, instead of
  // id-regexes and hand-typed id lists. Both read this one catalog.
  setInjectorCatalog(capabilityRegistry);
  setCapabilityCatalog(capabilityRegistry);

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
      capabilityRegistry: engine.capabilityRegistry,
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
    //
    // `getSlackToken` (with the cipher), NOT `getSlackGrant`. `getSlackGrant`
    // returns { connected, scopes, account } and has NO botToken — so reading
    // `?.botToken` off it is always undefined, and the token silently fell back to
    // the operator's env SLACK_BOT_TOKEN. A tenant with its own connected
    // workspace would have its approval posted into the OPERATOR's Slack (found by
    // the verifier, R1). This is the same decrypt path server.js:353 already uses.
    postSlack: async ({ tenantId, channel, text, blocks }) => {
      let token;
      try { token = getSlackToken({ oauthTokenStore: auth.oauthTokenStore, cipher: auth.tokenCipher, tenantId })?.botToken; }
      catch { /* no grant */ }
      token ??= process.env.SLACK_BOT_TOKEN;
      if (!token) throw new Error('Slack is not connected for this workspace');

      // RESOLVE THE TARGET FIRST. chat.postMessage takes a channel id, a user id or
      // "#name" — never an EMAIL. A human node asked over `slack: someone@corp.com`
      // therefore failed with channel_not_found and the run paused forever waiting
      // for a question nobody was ever sent, while the SAME email resolved fine for a
      // slack_dm delivery. Same resolvers the delivery path uses (see the note in
      // src/connectors/slack/index.js) — one definition, so they cannot disagree.
      const slackApi = makeSlackApi({ token });
      let target = String(channel ?? '').trim();
      if (target.includes('@'))      target = await resolveUser(slackApi, target);
      else if (target.startsWith('#')) target = await resolveChannel(slackApi, target);
      channel = target;

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

  // Knowledge connector — the tenant's own documents, searchable and writable from a
  // workflow. RAG is physically isolated per tenant, so the handle is resolved per
  // tenant and `_tenantId` is stamped into the node config before each run (below),
  // exactly as the filesystem connector does.
  registerKnowledgeCapabilities(engine.capabilityRegistry, {
    forTenant:   (tenantId) => spine.rag.forTenant(tenantId),
    readSources: (tenantId) => readSources(tenantId),
  });

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
  // Browser Knowledge uploads carry each file's contents inline as base64 (a brand
  // kit with logos/images is easily tens of MB), so this ONE path needs a much
  // larger JSON limit than the rest of the API. Mount it BEFORE the global 4mb
  // parser: body-parser marks the body parsed and the global parser then skips it,
  // so every other endpoint keeps the tighter 4mb ceiling. Without this, a large
  // upload 500s with PayloadTooLargeError before the route ever runs.
  app.use('/rag/ingest-files', express.json({ limit: '64mb' }));
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
      // Redact the raw approval token from the logged path (R1310, found by the
      // verifier, R2). The ApprovalStore keeps only the token's SHA-256 hash on
      // disk precisely so a leak yields no usable link — writing the plaintext
      // token into ./memory/logs/atlas-events.log undoes that. Single-use + TTL
      // limit the blast radius, but the log has no business holding a credential.
      const path = req.path.replace(/^(\/approvals\/)[^/]+/, '$1<token>');
      logEvent('http', {
        reqId: req.id,
        method: req.method, path, status: res.statusCode, ms: Date.now() - t0,
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

  // ── WHO ATLAS IS, TO A SERVICE IT HAS NEVER MET (P13-A) ────────────────────
  //
  // PUBLIC AND UNAUTHENTICATED BY NECESSITY: a remote server fetches this while
  // deciding whether to talk to us, long before any customer is involved. It
  // carries no secret and no tenant data — see client-identity.js.
  //
  // The URL of this document IS the client id. Requiring auth here would make
  // Atlas unidentifiable to every service in the phase.
  app.get(CIMD_PATH, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(clientIdMetadata());
  });

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
  // `selfServe` tells the pre-auth login screen whether "Create an account" is a
  // real door. Signup is Stripe-Checkout-only (POST /api/signup/checkout → webhook
  // provisions the tenant), so with no Stripe keys on the box it can only 503. The
  // flag hides the entry rather than letting someone walk into that error. Workspaces
  // are then created by hand via POST /admin/tenants (platform-admin gated).
  app.get('/setup/status', (_req, res) => {
    res.json({
      required: spine.auth.userStore.countForTenant(spine.auth.platformTenantId) === 0,
      selfServe: isBillingConfigured(),
    });
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
      // A connected service's tools are re-read here after a restart, so the
      // builder is never told a workspace can do less than it can.
      await ensureMcpTools(req.tenant.id).catch(() => {});
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

      // ONE derivation, shared with the builder session endpoint — see
      // connected-services.js for why this is not written out here.
      const mcpConnectors = mcpConnectedFor({
        capabilityRegistry: spine.engine.capabilityRegistry,
        oauthTokenStore: spine.auth.oauthTokenStore,
        tenantId: req.tenant.id,
      });

      res.json({
        channels: spine.engine.channelRegistry.getAll(),
        triggers,
        connectors: { slack, google, airtable, ...mcpConnectors },
      });
    } catch (err) {
      res.status(500).json({ error: `capabilities failed: ${err.message ?? String(err)}` });
    }
  });

  // ── REFUSE AN OAUTH ROUND-TRIP THAT CANNOT COME BACK ───────────────────────
  // One middleware over every connector's start route, not a check per connector:
  // the failure is a property of the DEPLOYMENT's redirect base, identical for all
  // of them, and a per-connector copy is how the next connector ships without it.
  //
  // Observed 2026-07-28: a local run carried OAUTH_REDIRECT_BASE=https://dev.agntic.co.
  // Pressing Connect on http://localhost:3000 handed the user to Airtable, which
  // answered "invalid client_id or mismatched redirect_uri" — the provider's error
  // page, in the provider's words, for our misconfiguration. Atlas said nothing at
  // any point, Airtable could not be connected at all, and every table-shaped
  // workflow was untestable locally until the cause was traced back to config.
  //
  // Fail closed and name both values: the round trip provably cannot return, so
  // sending the browser to a provider that will reject it helps nobody.
  app.get(/^\/connectors\/[^/]+\/(authorize|oauth\/start)$/, (req, res, next) => {
    const proto  = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host   = req.get('x-forwarded-host')  || req.get('host');
    const check  = host ? redirectReachableFrom(`${proto}://${host}`) : { ok: true };
    if (check.ok) return next();
    logEvent('connector.oauth_unreachable_base', {
      tenant: req.tenant?.id ?? null, path: req.path, base: check.base, origin: check.origin,
    });
    return res.status(409).json({ error: check.message, base: check.base, origin: check.origin });
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
      // RECORD THAT SLACK CAN REACH US AT ALL, before dispatch and regardless of whether
      // any workflow matches. This is the only evidence Atlas can ever have that Event
      // Subscriptions is delivering here, and the publish gate reads it — see
      // `checkSlackTriggersArmable`. Deliberately outside the dispatch path: an event
      // that matches nothing still proves the plumbing works.
      try {
        const teamId = body?.team_id;
        const tid = teamId ? spine.auth.oauthTokenStore.findTenantByAccount?.({ connectorId: 'slack', account: teamId }) : null;
        recordSlackEventSeen(tid ?? null);
      } catch { /* bookkeeping must never cost an event */ }
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
      // The SAME ambiguity as the event path, with the same consequence: a workspace
      // installed on two tenants resolved to one of them, and an approval click for a run
      // in the other silently found nothing. A run id belongs to exactly ONE tenant, so
      // ask each in install order and use the one that owns it.
      const tenants = spine.auth.oauthTokenStore.findTenantsByAccount?.({ connectorId: 'slack', account: teamId }) ?? [];
      if (!tenants.length) {
        logEvent('approval.slack.no_tenant', { teamId });
        return res.status(200).json({ text: 'This Slack workspace isn\'t connected to an Atlas workspace.' });
      }

      let result = null, tenantId = null;
      for (const t of tenants) {
        const r = await spine.approvals.resolveFromSlack({ tenantId: t, slackUserId, runId, nodeId, decision });
        // Keep the first ANSWER, not the first attempt: a tenant that does not own this
        // run says so, and that is not the outcome to report.
        if (r?.ok) { result = r; tenantId = t; break; }
        result ??= r; tenantId ??= t;
      }
      logEvent('approval.slack', { tenant: tenantId, runId, nodeId, decision, ok: result.ok, candidates: tenants.length });

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

  // ── ANSWERING AN APPROVAL DURING A TEST (2026-07-22) ──────────────────────
  // A `human` step stops a test run, and until now that was the end of it: the
  // panel could REPORT the pause but never answer it, so the half of an approval
  // workflow that matters most — what actually happens on approve versus reject —
  // was exercised by nothing, and "Go live" stayed locked with no way to unlock it.
  //
  // THE RESUME STATE NEVER LEAVES THE SERVER. The engine's checkpoint carries every
  // step's full, un-truncated output. Anything the browser holds, the browser can
  // edit — round-tripping it would let a client hand the engine the very content it
  // claims to have approved. So it is held here, keyed by run, scoped to the tenant
  // AND the user who started it, and it expires.
  //
  // NOTHING IS PARKED IN THE DATABASE. A paused test is not an `awaiting_human` row,
  // so the timeout sweeper can never find one and later fire the steps after the
  // approval — the customer email, the record — for real, out of a run somebody
  // pressed "test" on with nobody watching. That hazard is closed by construction,
  // not by remembering to exclude test runs from the sweep.
  const PENDING_TEST_PAUSES = new Map();
  const PENDING_PAUSE_TTL_MS = 15 * 60 * 1000;
  const sweepPendingPauses = () => {
    const now = Date.now();
    for (const [k, v] of PENDING_TEST_PAUSES) if (v.expiresAt <= now) PENDING_TEST_PAUSES.delete(k);
  };

  // ── A TEST RUN NO LONGER HOLDS A SOCKET OPEN (2026-08-02) ───────────────────
  //
  // MEASURED ON PROD, driving four workflows in a browser. A Monday-digest workflow
  // failed with `compile_digest: LLM step failed: LLM call timed out after 120s`
  // after **381,832 ms — 6.4 minutes**. The browser never saw it: Cloudflare gives
  // up on an origin request at ~100 seconds and returns its own **524**, so the
  // panel got an error page instead of the run's answer, said the honest but useless
  // "we couldn't run this — try again", and the retry did exactly the same thing.
  //
  // TWO THINGS THIS EXPOSED, both worth stating:
  //  · The 4-minute ceiling added to the client on 2026-08-02 was DEAD CODE in
  //    production. Cloudflare killed the connection at ~100s first, so that limit
  //    could never fire.
  //  · The `transient` flag added the same day could not fire either — the run's
  //    answer never reached the browser to carry it. A fix that depends on a
  //    response is worth nothing when the response is what is lost.
  //
  // So the run stops being one long HTTP request. The caller asks for
  // `background: true`, gets a job id back immediately, and polls
  // `GET /workflows/run/:jobId`. Every request is now short, which is what puts it
  // safely inside any proxy's limit — and the engine is untouched: the handler
  // below still runs exactly as it did, writing into a captured response instead of
  // a live socket.
  //
  // NOT PARKED IN THE DATABASE, for the same reason `PENDING_TEST_PAUSES` is not: a
  // test run must never become a row something else can later pick up and fire for
  // real. It lives in memory and expires. A process restart loses it, and the poll
  // then answers `unknown` — which the panel reports as "we lost it, run again"
  // rather than spinning forever. That is the honest answer and it is the one the
  // build poller already gives.
  const TEST_RUN_JOBS = new Map();
  const TEST_RUN_JOB_TTL_MS = 15 * 60 * 1000;
  const sweepRunJobs = () => {
    const now = Date.now();
    for (const [k, v] of TEST_RUN_JOBS) if (v.expiresAt <= now) TEST_RUN_JOBS.delete(k);
  };

  /**
   * A stand-in for `res` that records what the handler would have sent.
   *
   * The run handler calls `res.json()` from eight places (validator refusal,
   * connector not connected, paused, failed, completed, …). Capturing the response
   * means none of them had to change, and none of them can drift from the
   * foreground path — there IS no second path.
   */
  const captureRes = (job) => ({
    _code: 200,
    status(c) { this._code = c; return this; },
    json(payload) {
      job.code = this._code;
      job.payload = payload;
      job.state = 'done';
      job.finishedAt = Date.now();
      job.expiresAt = Date.now() + TEST_RUN_JOB_TTL_MS;
      return this;
    },
  });

  // Poll a backgrounded run. Always HTTP 200 — the run's OWN status rides in the
  // body, exactly as the foreground path returns 200 for a failed step (a 5xx here
  // gets replaced by the proxy's error page, which is the whole defect this route
  // exists to route around).
  app.get('/workflows/run/:jobId', optionalAuth, tenantGuard, (req, res) => {
    sweepRunJobs();
    const job = TEST_RUN_JOBS.get(String(req.params.jobId));
    // Unknown means the process restarted, or it expired. Say so plainly: the panel
    // turns this into "we lost track of that test — run it again", never a spinner.
    if (!job) return res.json({ state: 'unknown' });
    // Same fail-closed scoping as a paused test: the tenant AND the user who
    // started it. A job id is guessable; ownership never comes from the id.
    if (job.tenantId !== (req.tenant?.id ?? null) || job.userId !== (req.user?.id ?? null)) {
      return res.status(403).json({ error: 'that test run belongs to a different session' });
    }
    if (job.state === 'running') return res.json({ state: 'running', elapsedMs: Date.now() - job.startedAt });
    return res.json({ state: 'done', code: job.code, result: job.payload });
  });

  // Run a hand-authored spec through the engine — the "click run" path (no UI yet).
  // Body: { spec } where spec is the proprietary { name, nodes[], edges[], … } shape,
  // OR { resumeRunId, decision } to answer a `human` step this route stopped at.
  // Add `background: true` to get a `{ jobId }` back at once and poll for the answer.
  const runWorkflowHandler = async (req, res) => {
    // ── Answering a pause ───────────────────────────────────────────────────
    // Fails closed on every dimension: the pause must still exist, it must belong
    // to THIS workspace and THIS signed-in user (a session-proven answer is the
    // entire reason the panel is allowed to answer at all — there is one door into
    // the engine and it authenticates nothing, so each channel proves its answerer
    // first), and the answer must be one the step itself declared.
    let resumeState = null;
    if (req.body?.resumeRunId != null) {
      sweepPendingPauses();
      const key = String(req.body.resumeRunId);
      const pend = PENDING_TEST_PAUSES.get(key);
      if (!pend) {
        return res.json({ runId: null, completed: false, steps: [],
          error: 'That question has expired or was already answered — run the test again.' });
      }
      if (pend.tenantId !== (req.tenant?.id ?? null) || pend.userId !== (req.user?.id ?? null)) {
        return res.status(403).json({ error: 'that question belongs to a different session' });
      }
      const decision = String(req.body?.decision ?? '');
      // `ask.decisions` is what a PERSON may answer. It deliberately EXCLUDES the
      // engine's own `timeout` — "never one a person can give" — so the panel can
      // never manufacture silence and call it an answer. Reading the step's own
      // declared answers is also what makes this generic: a gate worded
      // ship/hold works with no change here.
      if (!Array.isArray(pend.ask?.decisions) || !pend.ask.decisions.includes(decision)) {
        return res.status(400).json({
          error: `"${decision}" is not one of the answers this step accepts (${(pend.ask?.decisions ?? []).join(', ') || 'none declared'})`,
        });
      }
      // ONE ANSWER, ONCE — delete before resuming, so a double-click cannot run the
      // steps after the gate twice (the same rule the real resume path enforces
      // with its conditional status flip).
      PENDING_TEST_PAUSES.delete(key);
      resumeState = {
        runId: pend.runId,
        checkpoint: pend.checkpoint,
        priorSteps: pend.steps,
        // Answers ACCUMULATE across pauses: a run with two gates stops twice, and
        // the executor skips any gate that already has an answer. This is what
        // makes N gates work without the route knowing how many there are.
        decisions: {
          ...pend.decisions,
          [pend.nodeId]: {
            decision,
            by: req.user?.id ? `user:${req.user.id}` : 'test',
            at: new Date().toISOString(),
            channel: 'test_panel',
          },
        },
      };
      // Restore the request to the shape the rest of this route expects. The spec
      // stored is the RAW one, pre-token-injection: re-injecting below is both
      // fresher and keeps decrypted tokens out of a 15-minute cache.
      req.body = { ...req.body, spec: pend.spec, initialContext: pend.initialContext, example: pend.example };
    }

    let spec = req.body?.spec;
    if (!spec || !Array.isArray(spec.nodes)) {
      return res.status(400).json({ error: 'body.spec with a nodes[] array is required' });
    }
    const rawSpec = spec;   // pre-injection; what a pause stores
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
      // ── ONE RETIRED CHECK MAY NOT BLOCK A RUN (2026-08-02) ──────────────────
      //
      // `UNSATISFIED_ASSERTION` asks whether the promise's `target` STRING matches
      // a step's destination. That comparison was removed from the test earlier
      // today (src/workflows/delivery-verdict.js) after it produced no findings
      // about a wrong workflow and repeatedly failed correct ones — and the
      // build-time half was deliberately left alone as a separate decision.
      //
      // MEASURED THE SAME DAY, driving a calendar workflow in a browser: BOTH its
      // test runs were refused here, `run.invalid codes:["UNSATISFIED_ASSERTION"]`,
      // before executing. Its promise said `calendar:Connected Calendar`; its step
      // wrote to the account's default calendar. The same place, described two
      // ways. So the retired rule blocked a correct workflow through a door the
      // removal did not cover — the test never got to look at it.
      //
      // SCOPED TO THE RUN PATH ONLY. This does not touch the validator, and it does
      // not touch publishing: `workflowService.create` validates independently and
      // still sees this code. What changes is that a disagreement about what a
      // destination STRING means can no longer stop you finding out whether the
      // workflow works — which is the one thing that can actually settle it.
      const RETIRED_ON_RUN = new Set(['UNSATISFIED_ASSERTION']);
      const errors  = (verdict?.issues ?? [])
        .filter(i => i.severity === 'error' && !RETIRED_ON_RUN.has(i.code));
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
        const deps = { oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, userId: req.user?.id, capabilityRegistry: spine.engine.capabilityRegistry };
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
      // Not on a resume: the row for this test run was opened (and closed) on the
      // leg that paused. Opening a second one would report one test as two runs.
      let dbRun = null;
      if (spec.id && !resumeState) {
        try { dbRun = spine.engine.workflowStore.startRun(spec.id, { isTest: true }); } catch { /* best-effort */ }
      }
      // Pre-register userId when dbRun is available — ensures cost records
      // before the first LLM call carry tenant attribution.
      if (dbRun && req.user?.id) {
        spine.costTracker?.setSessionUser?.(`flow-run-${dbRun.id}`, req.user.id);
      }
      // On a resume the steps from before the pause are carried forward, so the
      // panel and the contract oracle judge the WHOLE run, not just the tail after
      // the answer. (An assertion satisfied by a delivery that happened before the
      // gate would otherwise read as unmet.)
      let runId = resumeState?.runId ?? null, completed = false, output = null;
      const steps = resumeState ? [...resumeState.priorSteps] : [];
      // PRE-ANSWERED GATES (2026-07-24, operator). The Run-test panel no longer stops
      // at an approval step to ask the tester (which meant clicking through one pause
      // per urgent example, with no way for a test to prove the REJECT path). Instead
      // it supplies each gate's answer UP FRONT — `body.decisions` is { [humanNodeId]:
      // "approve"|"reject"|… } — and runs the example once per answer, so BOTH the
      // approve and the reject lane are exercised automatically, no person in the loop.
      // The executor skips a `human` node whose id is already answered (flow-tester
      // `if (node.type==='human' && !decisions[node.id])`), so the run completes
      // straight through instead of pausing. Only on a FRESH run (never a resume, which
      // already carries its own accumulated answers). Every delivery is still dry, so a
      // pre-approved gate sends nothing real. An answer not in the step's own declared
      // set just falls through the branch catch-all — harmless, the same as any
      // unrecognised route — so no validation is needed here.
      const initialDecisions = (!resumeState && req.body?.decisions && typeof req.body.decisions === 'object' && !Array.isArray(req.body.decisions))
        ? Object.fromEntries(Object.entries(req.body.decisions)
            .filter(([, dec]) => typeof dec === 'string' && dec)
            .map(([nid, dec]) => [nid, { decision: dec, by: 'test', at: new Date().toISOString(), channel: 'test_panel' }]))
        : null;
      // tenantId/workflowId are LOAD-BEARING: they scope the idempotency keys.
      // Omitting them used to collapse every tenant into one shared namespace
      // (`unscoped:<nodeId>`), so one tenant's step could be handed another
      // tenant's output. A step that cannot be scoped now refuses to run.
      const flowOpts = {
        ...(initialContext != null ? { initialContext } : {}),
        ...(dbRun ? { runId: dbRun.id } : {}),
        ...(req.tenant ? { tenantId: req.tenant.id } : {}),
        ...(spec.id ? { workflowId: spec.id } : {}),
        // ALWAYS DRY (2026-07-24, operator). /workflows/run is the TEST path — the only
        // callers are the Run-test panel — and a test MUST NEVER SEND REAL MESSAGES (the
        // operator got 5 real Slack DMs from one Run test). Terminal side-effect nodes
        // (deliver + writing connector-actions) are VERIFIED into a would-deliver receipt
        // instead of fired: the outcome oracle reads it as would-satisfy, and a connector
        // `probe` confirms the destination actually EXISTS and is reachable
        // (flow-tester `_dryRunDeliver`), so the test proves "it WILL deliver" without
        // sending. The ONE real delivery is Go-live. Forced here (was opt-in via the
        // request flag) so no client bug or other caller can make a test send for real.
        dryRunDeliveries: true,
        // RESUMING: the executor takes the checkpoint plus the answers given so
        // far. Replayed steps are restored, never re-run, so nothing that already
        // sent happens twice. Keeping the ORIGINAL runId means cost stays attached
        // to one session and the client keeps answering against a stable id.
        ...(resumeState ? { checkpoint: resumeState.checkpoint, decisions: resumeState.decisions, runId: resumeState.runId }
                        : (initialDecisions ? { decisions: initialDecisions } : {})),
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
          // Hold the resume state server-side so the tester can answer (see the
          // note above the route). Without a checkpoint there is nothing to resume
          // from, so the pause is reported exactly as it was before — not answered
          // on a guess.
          const answerable = !!(ev.checkpoint && Array.isArray(ev.ask?.decisions) && ev.ask.decisions.length);
          if (answerable) {
            sweepPendingPauses();
            PENDING_TEST_PAUSES.set(String(runId), {
              runId,
              nodeId: ev.nodeId,
              ask: ev.ask,
              checkpoint: ev.checkpoint,
              steps: [...steps],
              decisions: resumeState?.decisions ?? {},
              spec: rawSpec,
              initialContext,
              example: req.body?.example ?? null,
              tenantId: req.tenant?.id ?? null,
              userId: req.user?.id ?? null,
              expiresAt: Date.now() + PENDING_PAUSE_TTL_MS,
            });
          }
          return res.json({
            runId, completed: false, clean: true, paused: true,
            answerable,
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
          //
          // ── WAS IT THE WORKFLOW, OR COULD WE JUST NOT RUN IT? (2026-08-02) ────
          //
          // A model that times out, a 429, a provider refusing us, the box not
          // reaching a service — none of those say anything about the spec. Scored
          // as a broken run they read as "Contract not met", lock Go live and PATCH
          // the workflow to `error`, on a workflow that is fine. Re-running passes.
          //
          // The converger's `verify` node was taught this distinction on 2026-08-01
          // ("a test we could not run is not a broken workflow") and THE TEST PANEL
          // NEVER GOT IT — the same fix reaching one of two places, which is the
          // shape this repo has paid for repeatedly. `isTransientFailure` is derived
          // from the SAME pattern table the user-facing message comes from, never a
          // second regex list, and it is deliberately NARROW: anything unrecognised
          // stays a real failure, because excusing a genuine wiring defect ships a
          // broken workflow while excusing nothing merely costs a re-run.
          //
          // The FLAG is computed here, server-side, so the browser holds no copy of
          // the rule and the two cannot drift.
          // Both answers come from one pure function so they can be EXECUTED by a
          // check rather than grepped for — this branch cannot be lifted out of the
          // handler, and a source-level pin on it stayed green when the decision
          // was hardwired to a constant.
          const { transient, outcomeCheck: failOutcome } = judgeFailedRun(
            spec,
            req.body?.example ?? { given: initialContext },
            { error: ev.error, steps, nodeId: ev.nodeId ?? null },
          );
          return res.json({ runId, completed: false, error: ev.error, steps, transient, outcomeCheck: failOutcome });
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
      // Assemble the run's deliveries from the delivering NODE, not from the
      // handler's return: handlers are inconsistent (only Slack stamps channel +
      // delivered; inbox omits channel; gmail/airtable omit both), so filtering on
      // a bare `o.delivered` dropped gmail/airtable entirely and left inbox with no
      // channel — the runtime oracle could then confirm only Slack. normalizeDelivery
      // derives channel + destination from the node config, which always has them.
      // `deliveriesForStep` is the ONE rule (outcome-oracle.js) — including the
      // approval step's ask, which the build-time check has always counted and this
      // one used to drop, leaving a DM the run really sent reported as "unproven".
      const nodeById = new Map((spec.nodes ?? []).map((n) => [n.id, n]));
      const deliveries = steps
        .flatMap((s) => deliveriesForStep(nodeById.get(s.nodeId), coerce(s.output)));
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

      // ── DID IT DELIVER? (2026-08-02 — this replaced the contract oracle) ─────
      // The test asks one question of a run: did every step complete, and did every
      // delivery it attempted actually land? See `delivery-verdict.js` for what was
      // removed and why — in short, scoring each run against the promise's
      // destination STRING produced repeated false failures on correct workflows and
      // caught nothing.
      //
      // NO LONGER GATED ON `assertions.length`. A spec with no promises still runs
      // and still delivers, and "did it deliver" is answerable for it — the old gate
      // returned nothing at all for such a spec, which is what left the panel with
      // no evidence to show.
      const outcomeCheck = evaluateDeliveryRun(
        spec,
        req.body?.example ?? { given: initialContext },
        { completed, deliveries, steps, error: null },
      );
      res.json({ runId, completed, clean, issues, output, deliveries, steps, cost: runCost, outcomeCheck });
    } catch (err) {
      logEvent('run.error', { tenant: tenantId, ms: Date.now() - t0, ...errFields(err) });
      res.status(500).json({ error: `run failed: ${err.message ?? String(err)}` });
    }
  };

  // ── THE ROUTE: foreground by default, backgrounded on request ───────────────
  //
  // The handler above is UNCHANGED and is the only implementation. Backgrounding
  // swaps the socket for a recorder; it does not fork the logic. There is no second
  // path that can drift from the first.
  app.post('/workflows/run', optionalAuth, tenantGuard, async (req, res) => {
    if (req.body?.background !== true) return runWorkflowHandler(req, res);

    sweepRunJobs();
    const jobId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const job = {
      state: 'running', startedAt: Date.now(), expiresAt: Date.now() + TEST_RUN_JOB_TTL_MS,
      tenantId: req.tenant?.id ?? null, userId: req.user?.id ?? null,
      payload: null, code: 200,
    };
    TEST_RUN_JOBS.set(jobId, job);
    logEvent('run.backgrounded', { tenant: job.tenantId, jobId });
    res.json({ jobId, state: 'running' });

    // Detached on purpose — the socket is already answered. A throw here can never
    // reach Express (there is no response left to send), so it is caught and
    // RECORDED: a job left `running` for ever is the 38-minute spinner this whole
    // change exists to end. `runWorkflowHandler` has its own try/catch around the
    // engine; this covers everything outside it, including a throw before that
    // catch is reached.
    try {
      await runWorkflowHandler(req, captureRes(job));
    } catch (err) {
      logEvent('run.background_error', { tenant: job.tenantId, jobId, ...errFields(err) });
    } finally {
      if (job.state === 'running') {
        job.state = 'done';
        job.code = 200;
        job.payload = { runId: null, completed: false, steps: [],
          error: 'The test run stopped unexpectedly before it could report a result.' };
        job.finishedAt = Date.now();
        job.expiresAt = Date.now() + TEST_RUN_JOB_TTL_MS;
      }
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

  // ── Connecting a service nobody hand-built (P13-A) ─────────────────────────
  //
  // ONE customer action: pick a name, approve on the service's own screen, come
  // back connected. Everything the service needs to know about Atlas it reads
  // from the identity document above; everything Atlas needs to know about the
  // service it discovers at connect time. Neither side was configured by a person.

  const mcpFlow = createMcpConnectFlow();
  const mcpOwner = mcpOwnerId;

  /** Is this workspace connected to this service? */
  function mcpGrant(tenantId, serverId) {
    return spine.auth.oauthTokenStore.get({
      tenantId, userId: mcpOwner(tenantId), connectorId: mcpConnectorId(serverId),
    });
  }

  /**
   * Read a connected service's catalog and put its tools in the one registry.
   *
   * BEST-EFFORT AND LOUD. A service that cannot be read right now must not take
   * the process down or block a connect that genuinely succeeded — but it must
   * also never look like a service with no tools, so the failure is logged and
   * returned rather than swallowed.
   */
  async function loadMcpTools({ tenantId, serverId }) {
    const svc = mcpService(serverId);
    const grant = mcpGrant(tenantId, serverId);
    if (!svc || !grant) return { ok: false, reason: 'not_connected' };
    let token;
    try { token = spine.auth.tokenCipher.decrypt(grant.access_token_enc); } catch { return { ok: false, reason: 'unreadable_token' }; }

    try {
      const out = await registerMcpCatalog(spine.engine.capabilityRegistry, {
        url: svc.url, connector: serverId, headers: { authorization: `Bearer ${token}` },
      });
      logEvent('mcp.catalog.loaded', { tenant: tenantId, server: serverId, tools: out.count, skipped: out.skipped.length });
      return { ok: true, ...out };
    } catch (err) {
      logEvent('mcp.catalog.failed', { tenant: tenantId, server: serverId, error: String(err.message).slice(0, 200) });
      return { ok: false, reason: 'unreadable_catalog', error: String(err.message) };
    }
  }

  /**
   * A RESTART MUST NOT SILENTLY LOSE A CONNECTED SERVICE'S TOOLS.
   *
   * The catalog lives in memory; the grant lives on disk. So after a deploy the
   * token is still there and the tools are gone — and a workflow already built on
   * one of them would fail with the capability simply absent. That is the shape
   * this codebase records more than any other: the state survives, the thing that
   * could act on it does not, and nothing says so.
   *
   * Rather than a boot-time sweep over every tenant (which would make startup wait
   * on six third-party services), each tenant's services are re-read the first
   * time that tenant asks what it can do. Loaded servers are remembered per
   * process, so this costs one request per service per restart, not per call.
   */
  // Shared with the builder — see connected-services.js. Anything that asks
  // what a workspace is connected to must first make sure it can SEE it.
  const ensureMcpTools = (tenantId) => ensureMcpToolsLoaded({
    capabilityRegistry: spine.engine.capabilityRegistry,
    oauthTokenStore: spine.auth.oauthTokenStore,
    tokenCipher: spine.auth.tokenCipher,
    tenantId,
    onEvent: logEvent,
  });

  /** The pick-a-service list. Names only — never an address to paste. */
  app.get('/connectors/mcp/servers', requireActiveTenant, async (req, res) => {
    await ensureMcpTools(req.tenant.id).catch(() => {});
    res.json({
      servers: MCP_DIRECTORY.map((s) => ({
        id: s.id, name: s.name,
        connected: !!mcpGrant(req.tenant.id, s.id),
        tools: spine.engine.capabilityRegistry.list().filter((c) => c.connector === s.id).length,
      })),
    });
  });

  app.get('/connectors/mcp/:server/status', requireActiveTenant, (req, res) => {
    const svc = mcpService(req.params.server);
    if (!svc) return res.status(404).json({ error: 'unknown service' });
    const grant = mcpGrant(req.tenant.id, svc.id);
    res.json({
      connected: !!grant, id: svc.id, name: svc.name,
      tools: spine.engine.capabilityRegistry.list().filter((c) => c.connector === svc.id).length,
    });
  });

  /**
   * START CONNECTING A SERVICE — ONE DECISION, TWO RENDERINGS.
   *
   * There are two doors into this flow and they must never drift: the browser
   * can NAVIGATE here (a redirect all the way out to the service), or the app
   * can ASK (JSON, so a refusal lands as a sentence in the Connections panel
   * instead of a raw JSON page in the customer's face). This function decides;
   * the two routes below only render. Writing the decision twice is the shape
   * this codebase has paid for more than any other.
   *
   * @returns {{kind:'refused'|'already'|'authorize', ...}}
   */
  async function beginMcpConnect({ tenantId, userId, svc }) {
    const begun = await mcpFlow.beginConnect({
      tenantId, userId, connector: svc.id, mcpUrl: svc.url, serviceName: svc.name,
    });
    // A service we cannot identify ourselves to is REFUSED IN WORDS, never
    // degraded into asking this person for a credential. This is the end of
    // the identity chain and there is deliberately nothing after it.
    if (!begun.ok) {
      logEvent('mcp.connect.unsupported', { tenant: tenantId, server: svc.id, reason: begun.reason });
      return { kind: 'refused', message: begun.message, code: begun.reason };
    }
    // Nothing to approve — the service took our identity as-is.
    if (!begun.needsAuth) {
      await loadMcpTools({ tenantId, serverId: svc.id });
      return { kind: 'already' };
    }
    return { kind: 'authorize', authorizeUrl: begun.authorizeUrl };
  }

  app.get('/connectors/mcp/:server/oauth/start', requireActiveTenant, async (req, res) => {
    const svc = mcpService(req.params.server);
    if (!svc) return res.status(404).json({ error: 'unknown service' });
    try {
      const out = await beginMcpConnect({ tenantId: req.tenant.id, userId: req.user.id, svc });
      if (out.kind === 'refused') return res.status(501).json({ error: out.message, code: out.code });
      if (out.kind === 'already') return res.redirect(`/?connected=${svc.id}`);
      res.redirect(out.authorizeUrl);
    } catch (err) {
      logEvent('mcp.connect.failed', { tenant: req.tenant.id, server: svc.id, error: String(err.message).slice(0, 200) });
      res.status(502).json({ error: `Could not start connecting ${svc.name}: ${err.message}` });
    }
  });

  /**
   * The same start, as JSON — what the Connections panel calls.
   *
   * The panel asks rather than navigates for one reason: a service at the end of
   * the identity chain is refused with a sentence a person can act on, and a
   * navigation would render that sentence as `{"error":…}` on a blank page.
   * Mirrors `/connectors/airtable/authorize`, which exists for the same reason.
   */
  app.get('/connectors/mcp/:server/authorize', requireActiveTenant, async (req, res) => {
    const svc = mcpService(req.params.server);
    if (!svc) return res.status(404).json({ error: 'unknown service' });
    try {
      const out = await beginMcpConnect({ tenantId: req.tenant.id, userId: req.user.id, svc });
      if (out.kind === 'refused') return res.status(501).json({ error: out.message, code: out.code });
      if (out.kind === 'already') return res.json({ connected: true });
      res.json({ authorizeUrl: out.authorizeUrl });
    } catch (err) {
      logEvent('mcp.connect.failed', { tenant: req.tenant.id, server: svc.id, error: String(err.message).slice(0, 200) });
      res.status(502).json({ error: `Could not start connecting ${svc.name}: ${err.message}` });
    }
  });

  // ONE callback for every service — the identity document's redirect must be
  // stable, so `state` says which service came back, not the URL.
  app.get('/connectors/mcp/callback', requireActiveTenant, async (req, res) => {
    if (req.query.error) return res.status(400).json({ error: String(req.query.error) });
    try {
      const done = await mcpFlow.completeConnect({
        state: req.query.state, code: req.query.code, sessionUserId: req.user.id,
      });
      spine.auth.oauthTokenStore.upsert({
        tenantId: done.tenantId,
        userId: mcpOwner(done.tenantId),
        connectorId: mcpConnectorId(done.connector),
        accessTokenEnc: spine.auth.tokenCipher.encrypt(done.accessToken),
        refreshTokenEnc: done.refreshToken ? spine.auth.tokenCipher.encrypt(done.refreshToken) : null,
        scope: done.scope,
        expiry: Date.now() + done.expiresIn * 1000,
        account: done.mcpUrl,
      });
      const loaded = await loadMcpTools({ tenantId: done.tenantId, serverId: done.connector });
      // Connected but unreadable is its OWN state, and the person is told which
      // one they are in. "Connected, no tools" would read as a service that can
      // do nothing.
      res.redirect(`/?connected=${done.connector}${loaded.ok ? '' : '&catalog=unread'}`);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * DISCONNECT — delete this workspace's grant, and ONLY that.
   *
   * The tools deliberately stay in the registry. A capability catalog is a
   * property of the SERVICE, not of a tenant (see connected-services.js), so it
   * is shared by every workspace in this process — tearing it down here would
   * disconnect Notion for one customer by removing it from all of them.
   *
   * Deleting the grant IS the revocation, and it is fail-closed at both layers
   * that matter: `mcpConnectedFor` requires a grant, so the service leaves this
   * tenant's view and the interview stops offering it; and the run path refuses
   * before making any request when it cannot resolve a credential, rather than
   * calling the service anonymously.
   */
  app.delete('/connectors/mcp/:server', requireActiveTenant, (req, res) => {
    const svc = mcpService(req.params.server);
    if (!svc) return res.status(404).json({ error: 'unknown service' });
    const removed = spine.auth.oauthTokenStore.delete({
      tenantId: req.tenant.id, userId: mcpOwner(req.tenant.id), connectorId: mcpConnectorId(svc.id),
    });
    logEvent('mcp.disconnected', { tenant: req.tenant.id, server: svc.id });
    res.json({ ok: true, removed: !!removed });
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

  // Register a webhook for an Airtable base BY HAND.
  //
  // Publishing now arms its own triggers (see webhook-sync.js), so this is no
  // longer the only door — it is the manual/diagnostic one. It goes through the
  // same notification-URL helper as the automatic path, because two callback URLs
  // derived two different ways is how one of them silently ends up wrong.
  app.post('/connectors/airtable/webhooks', requireActiveTenant, async (req, res) => {
    const { baseId, tableId } = req.body ?? {};
    if (!baseId) return res.status(400).json({ error: 'baseId is required' });
    const tenantId = req.tenant.id;
    const token = await getAirtableAccessToken({ oauthTokenStore: spine.auth.oauthTokenStore, cipher: spine.auth.tokenCipher, tenantId });
    if (!token) return res.status(403).json({ error: 'Airtable not connected for this tenant' });
    try {
      const api = makeAirtableApi(token);
      const { webhookId, macSecretBase64 } = await createAirtableWebhook(api, {
        baseId, tableId, notificationUrl: airtableNotificationUrl(),
      });
      registerWebhookRoute({ webhookId, tenantId, baseId, tableId: tableId ?? null, macSecretBase64 });
      res.json({ ok: true, webhookId });
    } catch (err) { res.status(500).json({ error: err.message ?? String(err) }); }
  });

  // Reconcile this tenant's Airtable watches against its live workflows on demand.
  // The same call publish makes — exposed so a tenant that connected Airtable AFTER
  // publishing, or whose webhook was lost, can arm without republishing.
  app.post('/connectors/airtable/webhooks/sync', requireActiveTenant, async (req, res) => {
    const result = await syncAirtableWebhooksForTenant(spine, req.tenant.id);
    logEvent('airtable.webhooks.sync', {
      tenant: req.tenant.id, created: result.created?.length ?? 0,
      removed: result.removed?.length ?? 0, failed: result.failed?.length ?? 0, reason: result.reason ?? null,
    });
    res.json(result);
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

  mountBuilderRoutes(app, { spine, requireActiveTenant, requireAuth, readSources, tenantGuard, dryRunSpecForTenant });
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

  // ── Keep Airtable's record-change watches alive ────────────────────────────
  // Airtable expires a webhook 7 days after its last refresh. A webhook created
  // once and never renewed dies quietly, and the workflow it feeds simply stops
  // firing with nothing to show the user — the same silent failure as never
  // creating it, only a week late. Renew daily: frequent enough that several
  // consecutive failures still leave days of headroom, cheap enough to ignore.
  const refreshEveryMs = numEnv('AIRTABLE_WEBHOOK_REFRESH_MS', 24 * 60 * 60 * 1000);
  const refreshWebhooks = () =>
    refreshAllAirtableWebhooks(spine)
      .then((r) => { if (r.refreshed || r.failed || r.dropped) logEvent('airtable.webhooks.refresh', r); })
      .catch((err) => logEvent('airtable.webhooks.refresh_error', errFields(err)));
  refreshWebhooks();                                            // once at boot, so a restart also heals
  const refreshTimer = setInterval(refreshWebhooks, refreshEveryMs);
  refreshTimer.unref();                                         // never hold the process open

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} — draining`);
    // Stop starting new scheduled runs immediately, then stop accepting new
    // connections and let in-flight requests finish before disposing + exiting.
    try { spine.engine.workflowScheduler.stop?.(); } catch { /* ignore */ }
    clearInterval(refreshTimer);
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
