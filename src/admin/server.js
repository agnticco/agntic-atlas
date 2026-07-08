/**
 * Admin observability API — P10.
 *
 * Mounted via mountAdminRoutes(app, { spine, requireAuth, requirePlatformAdmin })
 * All routes require platform-admin role; non-admin receives 403.
 * Each per-tenant query is scoped with WHERE tenant_id = :id — cross-tenant
 * leakage is structurally impossible (one tenant cannot reach another's rows).
 *
 *   GET /admin/tenants                      — all tenants + headline metrics
 *   GET /admin/tenants/:id                  — single tenant overview
 *   GET /admin/tenants/:id/runs             — run count + breakdown by status
 *   GET /admin/tenants/:id/cost             — cost breakdown (total + per-workflow)
 *   GET /admin/usage                        — system-wide usage summary
 */

import { logEvent, errFields } from '../utils/event-log.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { renderInviteEmail } from '../auth/invite-email.js';
import { sendMail } from '../utils/mailer.js';
import { oauthRedirectBase } from '../connectors/oauth-redirect.js';
import { screenshotToDataUrl } from '../api/tickets.js';
import { renderTicketBrief, ticketGithubTitle, ticketGithubLabels } from '../support/ticket-brief.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function mountAdminRoutes(app, { spine, requireAuth, requirePlatformAdmin, optionalAuth }) {
  const store    = spine.engine.workflowStore;
  const tenants  = spine.auth.tenantStore;

  // Guard: every data route requires an authenticated platform admin.
  // requirePlatformAdmin already calls requireAuth first.
  const adminOnly = [requireAuth, requirePlatformAdmin];

  // ── Admin UI shell (no auth — HTML is public; data calls enforce auth) ────

  app.get('/admin', (_req, res) => {
    const uiPath = path.join(__dirname, 'index.html');
    if (existsSync(uiPath)) return res.sendFile(uiPath);
    res.status(404).send('Admin UI not found');
  });

  app.get('/admin/ui', (_req, res) => res.redirect('/admin'));

  // Who-am-I: returns the current user so the admin SPA can decide whether to
  // show the login form or the dashboard. Uses optionalAuth — no 401/403 thrown.
  app.get('/admin/me', optionalAuth ?? ((_req, _res, next) => next()), (req, res) => {
    if (!req.user) return res.json({ user: null, isAdmin: false });
    const platformTenantId = spine.auth.platformTenantId;
    const isAdmin = req.user.role === 'admin' && req.user.tenant_id === platformTenantId;
    res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role }, isAdmin });
  });

  // ── Tenant list ───────────────────────────────────────────────────────────

  app.get('/admin/tenants', adminOnly, (req, res) => {
    try {
      const allTenants = tenants.list();
      const result = allTenants.map(t => {
        const metrics = _tenantRunMetrics(store.db, t.id);
        // "pending" = the workspace has been created/invited but nobody has signed
        // in yet (no user has a last_login_at).
        const pending = !spine.auth.userStore.hasLogin(t.id);
        return { ...t, metrics, pending };
      });
      res.json({ tenants: result });
    } catch (err) {
      logEvent('admin.tenants.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Create a workspace (provision tenant + first admin + email invite) ──────
  app.post('/admin/tenants', adminOnly, async (req, res) => {
    try {
      const name  = String(req.body?.name ?? '').trim();
      const email = String(req.body?.admin?.email ?? req.body?.email ?? '').trim().toLowerCase();
      const plan  = String(req.body?.plan ?? 'starter');
      if (!name) return res.status(400).json({ error: 'Workspace name is required.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'A valid admin email is required.' });

      // Derive a slug from the name, deduped against existing workspaces.
      let root = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workspace';
      if (root.length < 2) root += '-ws';
      let slug = root, n = 2;
      while (tenants.getBySlug(slug)) slug = `${root}-${n++}`;

      // 1. Tenant (with plan).
      const tenant = tenants.create({ name, slug, plan });

      // 2. First admin — random password; they set their own via the invite link.
      const admin = await spine.auth.authProvider.register({
        tenantId: tenant.id, email, password: randomBytes(24).toString('base64url'), role: 'admin', display_name: '',
      });

      // 3. 7-day invite token → email a set-password link (same /?reset= flow).
      let invited = false, inviteLink = null;
      try {
        const token = spine.auth.passwordResetStore.create({
          userId: admin.id, tenantId: tenant.id, ttlMs: 7 * 24 * 60 * 60 * 1000,
        });
        const base = oauthRedirectBase();
        inviteLink = `${base}/?reset=${encodeURIComponent(token)}`;
        const mail = renderInviteEmail({ inviteLink, userEmail: email, workspaceName: name, base });
        const r = await sendMail({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
        invited = !!r?.delivered;
      } catch (mailErr) {
        logEvent('admin.tenant.invite_error', { tenant: tenant.id, error: mailErr.message ?? String(mailErr) });
      }

      logEvent('admin.tenant.created', { tenant: tenant.id, plan: tenant.plan, invited });
      // When email wasn't delivered (mailer unconfigured), hand back the link so the
      // operator can still onboard the admin manually.
      res.json({ ok: true, tenant, admin: { id: admin.id, email: admin.email }, invited, ...(invited ? {} : { inviteLink }) });
    } catch (err) {
      logEvent('admin.tenant.create_error', errFields(err));
      res.status(400).json({ error: err.message ?? String(err) });
    }
  });

  // ── Tenant lifecycle: suspend / reactivate (billing hold) + archive / restore ─
  // suspend/archive halt the tenant everywhere (users locked out via isActive,
  // scheduled runs skipped via the scheduler's tenant gate). Data is retained.
  function lifecycle(action, fn) {
    app.post(`/admin/tenants/:id/${action}`, adminOnly, (req, res) => {
      try {
        const tenant = fn(req.params.id);
        logEvent(`admin.tenant.${action}`, { tenant: req.params.id });
        res.json({ ok: true, tenant });
      } catch (err) {
        res.status(400).json({ error: err.message ?? String(err) });
      }
    });
  }
  lifecycle('suspend',  (id) => tenants.setStatus(id, 'suspended'));
  lifecycle('activate', (id) => tenants.setStatus(id, 'active'));
  lifecycle('archive',  (id) => tenants.archive(id));
  lifecycle('restore',  (id) => tenants.restore(id));

  // ── Single tenant overview ────────────────────────────────────────────────

  app.get('/admin/tenants/:id', adminOnly, (req, res) => {
    try {
      const tenant = tenants.get(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      const runs    = _tenantRunMetrics(store.db, tenant.id);
      const cost    = _tenantCostMetrics(store.db, tenant.id);
      const recent  = _tenantRecentRuns(store.db, tenant.id, 10);
      res.json({ tenant, runs, cost, recent });
    } catch (err) {
      logEvent('admin.tenant.get.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Per-tenant run counts ─────────────────────────────────────────────────
  // Required by P10 gate: /admin/tenants/:id/runs returns run count

  app.get('/admin/tenants/:id/runs', adminOnly, (req, res) => {
    try {
      const tenant = tenants.get(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      const metrics = _tenantRunMetrics(store.db, tenant.id);
      const byWorkflow = store.db.prepare(`
        SELECT w.name, w.slug, r.workflow_id,
               COUNT(*) AS total,
               SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS succeeded,
               SUM(CASE WHEN r.status = 'error'   THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN r.is_test = 1         THEN 1 ELSE 0 END) AS test_runs,
               MAX(r.started_at) AS last_run_at
        FROM workflow_runs r
        LEFT JOIN workflows w ON w.id = r.workflow_id
        WHERE r.tenant_id = ?
        GROUP BY r.workflow_id
        ORDER BY last_run_at DESC
      `).all(tenant.id);
      res.json({ tenantId: tenant.id, ...metrics, byWorkflow });
    } catch (err) {
      logEvent('admin.tenant.runs.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Per-tenant cost breakdown ─────────────────────────────────────────────
  // Required by P10 gate: /admin/tenants/:id/cost returns cost breakdown.
  // Queries llm_cost_log for full coverage: converger turns, workflow nodes,
  // web search, and any other LLM call surface — not just workflow_runs.

  app.get('/admin/tenants/:id/cost', adminOnly, (req, res) => {
    try {
      const tenant = tenants.get(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      const totals     = _tenantCostMetrics(store.db, tenant.id);
      const projection = _tenantSpendProjection(store.db, tenant.id);
      // Break down by context label (converger / web_search / workflow:slug:nodeId / etc.)
      const byContext = store.db.prepare(`
        SELECT context,
               COUNT(*)           AS calls,
               SUM(tokens_in)     AS tokens_in,
               SUM(tokens_out)    AS tokens_out,
               SUM(cost_usd)      AS cost_usd,
               SUM(web_searches)  AS web_searches,
               MAX(ts)            AS last_call_at
        FROM llm_cost_log
        WHERE tenant_id = ?
        GROUP BY context
        ORDER BY cost_usd DESC
      `).all(tenant.id);
      const daily = store.db.prepare(`
        SELECT date(ts)          AS day,
               SUM(tokens_in)   AS tokens_in,
               SUM(tokens_out)  AS tokens_out,
               SUM(cost_usd)    AS cost_usd,
               COUNT(*)         AS calls,
               SUM(web_searches) AS web_searches
        FROM llm_cost_log
        WHERE tenant_id = ?
          AND ts >= date('now', '-30 days')
        GROUP BY day
        ORDER BY day
      `).all(tenant.id);
      // Execution-level run breakdown (run count, status) — still useful alongside cost log
      const byWorkflow = store.db.prepare(`
        SELECT w.name, w.slug, r.workflow_id,
               COUNT(*) AS runs,
               SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS succeeded,
               SUM(CASE WHEN r.status = 'error'   THEN 1 ELSE 0 END) AS failed,
               MAX(r.started_at) AS last_run_at
        FROM workflow_runs r
        LEFT JOIN workflows w ON w.id = r.workflow_id
        WHERE r.tenant_id = ? AND r.is_test = 0
        GROUP BY r.workflow_id
        ORDER BY last_run_at DESC
      `).all(tenant.id);
      // Activity feed: every individual LLM call for this tenant, newest first.
      // One row per call — each tagged by its context (the UI derives the kind:
      // Conversation / Converger / Workflow execution / Web search). Capped at
      // ACTIVITY_LIMIT; `activityTotal` lets the UI show how many are hidden.
      const ACTIVITY_LIMIT = 250;
      const activity = store.db.prepare(`
        SELECT ts, context, tier, model, tokens_in, tokens_out, cost_usd, web_searches, session_id
        FROM llm_cost_log
        WHERE tenant_id = ?
        ORDER BY ts DESC
        LIMIT ?
      `).all(tenant.id, ACTIVITY_LIMIT);
      const activityTotal = totals.llmCalls;
      res.json({ tenantId: tenant.id, ...totals, ...projection, byContext, daily, byWorkflow, activity, activityTotal });
    } catch (err) {
      logEvent('admin.tenant.cost.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── System-wide usage summary ─────────────────────────────────────────────
  // Totals from llm_cost_log (full coverage) + run counts from workflow_runs.

  app.get('/admin/usage', adminOnly, (req, res) => {
    try {
      const allTenants = tenants.list();
      const overallCost = store.db.prepare(`
        SELECT COUNT(*)          AS total_calls,
               SUM(tokens_in)   AS tokens_in,
               SUM(tokens_out)  AS tokens_out,
               SUM(cost_usd)    AS cost_usd,
               SUM(web_searches) AS web_searches
        FROM llm_cost_log
      `).get();
      const overallRuns = store.db.prepare(`
        SELECT COUNT(*) AS total_runs
        FROM workflow_runs WHERE is_test = 0
      `).get();
      const trackingRow = store.db.prepare(`SELECT MIN(ts) AS since FROM llm_cost_log`).get();
      // Platform-wide trailing-30d spend + projected monthly run-rate.
      const overallWin = store.db.prepare(`
        SELECT SUM(cost_usd) AS cost_30d,
               julianday('now') - julianday(MIN(ts)) AS span_days
        FROM llm_cost_log WHERE ts >= date('now', '-30 days')
      `).get();
      const overallProjection = _projectMonthly(overallWin?.cost_30d, overallWin?.span_days);
      const overall = {
        ...overallCost,
        total_runs:     overallRuns.total_runs ?? 0,
        tracking_since: trackingRow?.since ?? null,
        ...overallProjection,
      };
      const perTenant = allTenants.map(t => ({
        tenantId: t.id,
        name:     t.name ?? t.slug,
        ...(_tenantCostMetrics(store.db, t.id)),
        ...(_tenantSpendProjection(store.db, t.id)),
      }));
      const daily = store.db.prepare(`
        SELECT date(ts)   AS day,
               tenant_id,
               SUM(cost_usd)    AS cost_usd,
               COUNT(*)         AS calls,
               SUM(web_searches) AS web_searches
        FROM llm_cost_log
        WHERE ts >= date('now', '-30 days')
        GROUP BY day, tenant_id
        ORDER BY day
      `).all();
      res.json({ overall, perTenant, daily });
    } catch (err) {
      logEvent('admin.usage.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Support tickets (triage + coding-agent hand-off) ──────────────────────
  // Cross-tenant reads by design — gated by requirePlatformAdmin. The submit
  // endpoint (POST /api/tickets) is tenant-scoped and lives in src/api/tickets.js.

  const tickets = spine.tickets ?? null;
  const ticketsUnavailable = (res) => res.status(503).json({ error: 'ticketing unavailable' });

  // List with optional status/type/tenant filters + headline counts.
  app.get('/admin/tickets', adminOnly, (req, res) => {
    try {
      if (!tickets) return ticketsUnavailable(res);
      const { status, type, tenant } = req.query ?? {};
      const rows = tickets.list({ status: status || null, type: type || null, tenantId: tenant || null });
      // Attach a friendly workspace name per ticket for the list view.
      const nameCache = new Map();
      const list = rows.map((t) => {
        if (!nameCache.has(t.tenant_id)) {
          let n = null; try { n = tenants.get(t.tenant_id)?.name ?? null; } catch { /* ignore */ }
          nameCache.set(t.tenant_id, n);
        }
        const { context, ...rest } = t; // omit the full context blob from the list payload
        return { ...rest, tenantName: nameCache.get(t.tenant_id) ?? t.tenant_id };
      });
      res.json({ tickets: list, counts: tickets.counts() });
    } catch (err) {
      logEvent('admin.tickets.list.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // Single ticket — full context + inline screenshot + the Markdown brief.
  app.get('/admin/tickets/:id', adminOnly, (req, res) => {
    try {
      if (!tickets) return ticketsUnavailable(res);
      const t = tickets.get(req.params.id);
      if (!t) return res.status(404).json({ error: 'Ticket not found' });
      let tenantName = t.tenant_id;
      try { tenantName = tenants.get(t.tenant_id)?.name ?? t.tenant_id; } catch { /* ignore */ }
      const screenshot = t.screenshot_path ? screenshotToDataUrl(t.screenshot_path) : null;
      const adminUrl = `${oauthRedirectBase()}/admin`;
      const brief = renderTicketBrief(t, { adminUrl });
      res.json({ ticket: { ...t, tenantName }, screenshot, brief, githubConfigured: !!(process.env.GITHUB_REPO && process.env.GITHUB_TOKEN) });
    } catch (err) {
      logEvent('admin.tickets.get.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // Markdown brief as a downloadable file (coding-agent hand-off).
  app.get('/admin/tickets/:id/brief', adminOnly, (req, res) => {
    try {
      if (!tickets) return ticketsUnavailable(res);
      const t = tickets.get(req.params.id);
      if (!t) return res.status(404).json({ error: 'Ticket not found' });
      const adminUrl = `${oauthRedirectBase()}/admin`;
      const md = renderTicketBrief(t, { adminUrl });
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${t.id}.md"`);
      res.send(md);
    } catch (err) {
      logEvent('admin.tickets.brief.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // Update triage fields (status / notes).
  app.patch('/admin/tickets/:id', adminOnly, (req, res) => {
    try {
      if (!tickets) return ticketsUnavailable(res);
      const { status, adminNotes } = req.body ?? {};
      const patch = {};
      if (status !== undefined) patch.status = status;
      if (adminNotes !== undefined) patch.adminNotes = adminNotes;
      const t = tickets.update(req.params.id, patch);
      if (!t) return res.status(404).json({ error: 'Ticket not found' });
      logEvent('admin.tickets.updated', { ticket: t.id, status: t.status });
      res.json({ ok: true, ticket: t });
    } catch (err) {
      logEvent('admin.tickets.update.error', errFields(err));
      res.status(400).json({ error: err.message });
    }
  });

  // File the ticket as a GitHub issue (coding-agent hand-off). Requires
  // GITHUB_REPO ("owner/repo") + GITHUB_TOKEN (repo/issues scope) on the box.
  app.post('/admin/tickets/:id/github', adminOnly, async (req, res) => {
    try {
      if (!tickets) return ticketsUnavailable(res);
      const repo = process.env.GITHUB_REPO;
      const token = process.env.GITHUB_TOKEN;
      if (!repo || !token) {
        return res.status(400).json({ error: 'GitHub not configured — set GITHUB_REPO and GITHUB_TOKEN on the server.' });
      }
      const t = tickets.get(req.params.id);
      if (!t) return res.status(404).json({ error: 'Ticket not found' });
      if (t.github_issue_url) return res.json({ ok: true, url: t.github_issue_url, number: t.github_issue_number, already: true });

      const adminUrl = `${oauthRedirectBase()}/admin`;
      const payload = {
        title: ticketGithubTitle(t),
        body: renderTicketBrief(t, { adminUrl }),
        labels: ticketGithubLabels(t),
      };
      const ghHeaders = {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'atlas-support-tickets',
        'x-github-api-version': '2022-11-28',
      };
      const url = `https://api.github.com/repos/${repo}/issues`;
      let ghRes = await fetch(url, { method: 'POST', headers: ghHeaders, body: JSON.stringify(payload) });
      // A repo without our labels 422s — retry once without labels rather than fail.
      if (ghRes.status === 422) {
        ghRes = await fetch(url, { method: 'POST', headers: ghHeaders, body: JSON.stringify({ title: payload.title, body: payload.body }) });
      }
      if (!ghRes.ok) {
        const detail = await ghRes.text().catch(() => '');
        logEvent('admin.tickets.github.error', { ticket: t.id, status: ghRes.status, detail: detail.slice(0, 500) });
        return res.status(502).json({ error: `GitHub responded ${ghRes.status}. Check GITHUB_REPO/GITHUB_TOKEN and its scopes.` });
      }
      const issue = await ghRes.json();
      const updated = tickets.update(t.id, { githubIssueUrl: issue.html_url, githubIssueNumber: issue.number });
      logEvent('admin.tickets.github.filed', { ticket: t.id, number: issue.number });
      res.json({ ok: true, url: issue.html_url, number: issue.number, ticket: updated });
    } catch (err) {
      logEvent('admin.tickets.github.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });
}

// ── Private query helpers ────────────────────────────────────────────────────

function _tenantRunMetrics(db, tenantId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN is_test = 1        THEN 1 ELSE 0 END) AS test_runs,
           MIN(started_at) AS first_run_at,
           MAX(started_at) AS last_run_at
    FROM workflow_runs WHERE tenant_id = ?
  `).get(tenantId);
  return {
    totalRuns:   row.total ?? 0,
    succeeded:   row.succeeded ?? 0,
    failed:      row.failed ?? 0,
    running:     row.running ?? 0,
    testRuns:    row.test_runs ?? 0,
    firstRunAt:  row.first_run_at ?? null,
    lastRunAt:   row.last_run_at ?? null,
  };
}

function _tenantCostMetrics(db, tenantId) {
  const row = db.prepare(`
    SELECT COUNT(*)          AS calls,
           SUM(tokens_in)   AS tokens_in,
           SUM(tokens_out)  AS tokens_out,
           SUM(cost_usd)    AS cost_usd,
           SUM(web_searches) AS web_searches
    FROM llm_cost_log WHERE tenant_id = ?
  `).get(tenantId);
  return {
    llmCalls:    row.calls        ?? 0,
    tokensIn:    row.tokens_in    ?? 0,
    tokensOut:   row.tokens_out   ?? 0,
    costUsd:     +(row.cost_usd   ?? 0).toFixed(6),
    webSearches: row.web_searches ?? 0,
  };
}

// Project a monthly run-rate from a trailing-window spend and the span of days
// observed within it. A tenant active the full 30 days projects ≈ its actual
// 30-day spend; one active fewer days projects its observed rate forward to 30.
// daysObserved is returned so the UI can label the projection honestly.
function _projectMonthly(cost30dRaw, spanDaysRaw) {
  const cost30dUsd = +(cost30dRaw ?? 0);
  const span = Math.min(30, Math.max(1, spanDaysRaw ?? 0));
  const estMonthlyUsd = cost30dUsd > 0 ? cost30dUsd * (30 / span) : 0;
  return {
    cost30dUsd:    +cost30dUsd.toFixed(6),
    estMonthlyUsd: +estMonthlyUsd.toFixed(2),
    daysObserved:  +span.toFixed(1),
  };
}

function _tenantSpendProjection(db, tenantId) {
  const win = db.prepare(`
    SELECT SUM(cost_usd) AS cost_30d,
           julianday('now') - julianday(MIN(ts)) AS span_days
    FROM llm_cost_log
    WHERE tenant_id = ? AND ts >= date('now', '-30 days')
  `).get(tenantId);
  return _projectMonthly(win?.cost_30d, win?.span_days);
}

function _tenantRecentRuns(db, tenantId, limit = 10) {
  return db.prepare(`
    SELECT r.id, r.workflow_id, w.name AS workflow_name, w.slug,
           r.status, r.started_at, r.completed_at, r.is_test,
           r.tokens_in, r.tokens_out, r.cost_usd, r.llm_calls,
           r.time_saved_minutes
    FROM workflow_runs r
    LEFT JOIN workflows w ON w.id = r.workflow_id
    WHERE r.tenant_id = ?
    ORDER BY r.started_at DESC
    LIMIT ?
  `).all(tenantId, limit);
}
