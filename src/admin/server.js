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

export function mountAdminRoutes(app, { spine, requireAuth, requirePlatformAdmin }) {
  const store    = spine.engine.workflowStore;
  const tenants  = spine.auth.tenantStore;

  // Guard: every admin route requires an authenticated platform admin.
  // requirePlatformAdmin already calls requireAuth first.
  const adminOnly = [requireAuth, requirePlatformAdmin];

  // ── Admin UI shell ────────────────────────────────────────────────────────

  app.get('/admin', adminOnly, (_req, res) => {
    const uiPath = path.join(__dirname, 'index.html');
    if (existsSync(uiPath)) {
      return res.sendFile(uiPath);
    }
    res.status(404).send('Admin UI not found');
  });

  app.get('/admin/ui', adminOnly, (_req, res) => {
    res.redirect('/admin');
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
  // Required by P10 gate: /admin/tenants/:id/cost returns cost breakdown

  app.get('/admin/tenants/:id/cost', adminOnly, (req, res) => {
    try {
      const tenant = tenants.get(req.params.id);
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      const totals = _tenantCostMetrics(store.db, tenant.id);
      const byWorkflow = store.db.prepare(`
        SELECT w.name, w.slug, r.workflow_id,
               COUNT(*) AS runs,
               SUM(r.tokens_in)  AS tokens_in,
               SUM(r.tokens_out) AS tokens_out,
               SUM(r.cost_usd)   AS cost_usd,
               SUM(r.llm_calls)  AS llm_calls,
               MAX(r.started_at) AS last_run_at
        FROM workflow_runs r
        LEFT JOIN workflows w ON w.id = r.workflow_id
        WHERE r.tenant_id = ? AND r.is_test = 0
        GROUP BY r.workflow_id
        ORDER BY cost_usd DESC
      `).all(tenant.id);
      const daily = store.db.prepare(`
        SELECT date(r.started_at) AS day,
               SUM(r.tokens_in)   AS tokens_in,
               SUM(r.tokens_out)  AS tokens_out,
               SUM(r.cost_usd)    AS cost_usd,
               COUNT(*)           AS runs
        FROM workflow_runs r
        WHERE r.tenant_id = ? AND r.is_test = 0
          AND r.started_at >= date('now', '-30 days')
        GROUP BY day
        ORDER BY day
      `).all(tenant.id);
      res.json({ tenantId: tenant.id, ...totals, byWorkflow, daily });
    } catch (err) {
      logEvent('admin.tenant.cost.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── System-wide usage summary ─────────────────────────────────────────────

  app.get('/admin/usage', adminOnly, (req, res) => {
    try {
      const allTenants = tenants.list();
      const overall = store.db.prepare(`
        SELECT COUNT(*)        AS total_runs,
               SUM(tokens_in)  AS tokens_in,
               SUM(tokens_out) AS tokens_out,
               SUM(cost_usd)   AS cost_usd,
               SUM(llm_calls)  AS llm_calls
        FROM workflow_runs
        WHERE is_test = 0
      `).get();
      const perTenant = allTenants.map(t => ({
        tenantId: t.id,
        name:     t.name ?? t.slug,
        ...(_tenantCostMetrics(store.db, t.id)),
      }));
      const daily = store.db.prepare(`
        SELECT date(started_at) AS day,
               tenant_id,
               SUM(cost_usd) AS cost_usd,
               COUNT(*) AS runs
        FROM workflow_runs
        WHERE is_test = 0 AND started_at >= date('now', '-30 days')
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
    SELECT COUNT(*)        AS runs,
           SUM(tokens_in)  AS tokens_in,
           SUM(tokens_out) AS tokens_out,
           SUM(cost_usd)   AS cost_usd,
           SUM(llm_calls)  AS llm_calls
    FROM workflow_runs WHERE tenant_id = ? AND is_test = 0
  `).get(tenantId);
  return {
    runs:        row.runs ?? 0,
    tokensIn:    row.tokens_in  ?? 0,
    tokensOut:   row.tokens_out ?? 0,
    costUsd:     +(row.cost_usd  ?? 0).toFixed(6),
    llmCalls:    row.llm_calls  ?? 0,
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
