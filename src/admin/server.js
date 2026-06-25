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
        return { ...t, metrics };
      });
      res.json({ tenants: result });
    } catch (err) {
      logEvent('admin.tenants.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

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
      const totals = _tenantCostMetrics(store.db, tenant.id);
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
      res.json({ tenantId: tenant.id, ...totals, byContext, daily, byWorkflow });
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
      const overall = { ...overallCost, total_runs: overallRuns.total_runs ?? 0, tracking_since: trackingRow?.since ?? null };
      const perTenant = allTenants.map(t => ({
        tenantId: t.id,
        name:     t.name ?? t.slug,
        ...(_tenantCostMetrics(store.db, t.id)),
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
