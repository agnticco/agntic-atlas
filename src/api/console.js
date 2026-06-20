/**
 * Console API — read endpoints for the P5 console UI.
 *
 * Mounted via mountConsoleRoutes(app, { spine, requireActiveTenant })
 * All routes are tenant-scoped; cross-tenant access is structurally impossible.
 *
 *   GET  /api/console/workflows                     — inventory list
 *   GET  /api/console/workflows/:id                 — single workflow + DAG
 *   GET  /api/console/workflows/:id/runs            — run ledger (filterable)
 *   GET  /api/console/workflows/:id/runs/:runId     — per-run detail + steps
 *   GET  /api/console/workflows/:id/metrics         — health rollup
 *   POST /api/console/workflows/:id/pause           — toggle active/paused
 *   GET  /api/console/workflows/:id/sop             — SOP as Markdown (or PDF)
 */

import { logEvent, errFields } from '../utils/event-log.js';
import { generateSopMarkdown } from '../workflows/sop-generator.js';

export function mountConsoleRoutes(app, { spine, requireActiveTenant }) {
  const store = spine.engine.workflowStore;
  const scheduler = spine.engine.workflowScheduler;

  // ── Inventory ────────────────────────────────────────────────────────────

  app.get('/api/console/workflows', requireActiveTenant, (req, res) => {
    try {
      const { status, kind } = req.query;
      const workflows = store.list({
        status: status || null,
        kind:   kind   || null,
        userId:   req.user.id,
        tenantId: req.tenant.id,
      });
      res.json({ workflows });
    } catch (err) {
      logEvent('console.workflows.list.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Single workflow ───────────────────────────────────────────────────────

  app.get('/api/console/workflows/:id', requireActiveTenant, (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });
      res.json({ workflow: wf });
    } catch (err) {
      logEvent('console.workflow.get.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Run ledger ────────────────────────────────────────────────────────────

  app.get('/api/console/workflows/:id/runs', requireActiveTenant, (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });

      const limit = Math.min(Number(req.query.limit) || 50, 200);
      let runs = store.getRuns(req.params.id, limit, {
        userId:   req.user.id,
        tenantId: req.tenant.id,
      });

      // Post-query filters (status, date range, text search)
      const { status, from, to, q } = req.query;
      if (status) runs = runs.filter(r => r.status === status);
      if (from)   runs = runs.filter(r => r.started_at >= from);
      if (to)     runs = runs.filter(r => r.started_at <= to);
      if (q)      runs = runs.filter(r => JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));

      res.json({ runs });
    } catch (err) {
      logEvent('console.runs.list.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Per-run detail ────────────────────────────────────────────────────────

  app.get('/api/console/workflows/:id/runs/:runId', requireActiveTenant, (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });

      const run = store.getRun(req.params.runId, {
        userId:   req.user.id,
        tenantId: req.tenant.id,
      });
      if (!run || run.workflow_id !== req.params.id) return res.status(404).json({ error: 'Run not found' });

      res.json({ run });
    } catch (err) {
      logEvent('console.run.get.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Metrics rollup ────────────────────────────────────────────────────────

  app.get('/api/console/workflows/:id/metrics', requireActiveTenant, (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });

      const runs = store.getRuns(req.params.id, 200, {
        userId:   req.user.id,
        tenantId: req.tenant.id,
      }).filter(r => !r.is_test);

      const total   = runs.length;
      const success = runs.filter(r => r.status === 'success').length;
      const errors  = runs.filter(r => r.status === 'error').length;
      const rate    = total > 0 ? Math.round((success / total) * 100) : null;
      const lastRun = runs[0]?.started_at ?? null;
      const costUsd = runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

      res.json({ metrics: { total, success, errors, rate, lastRun, costUsd } });
    } catch (err) {
      logEvent('console.metrics.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Pause / resume ────────────────────────────────────────────────────────

  app.post('/api/console/workflows/:id/pause', requireActiveTenant, (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });

      const newStatus = wf.status === 'active' ? 'paused' : 'active';
      store.update(req.params.id, { status: newStatus }, { userId: req.user.id });
      logEvent('console.workflow.pause', { workflowId: req.params.id, newStatus, tenant: req.tenant.id });
      res.json({ status: newStatus });
    } catch (err) {
      logEvent('console.workflow.pause.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── Manual run (Run now) ──────────────────────────────────────────────────

  app.post('/api/console/workflows/:id/run', requireActiveTenant, async (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });
      await scheduler.runNow(req.params.id, { trigger: 'manual' });
      const run = store.getLastRun(req.params.id, { userId: req.user.id });
      logEvent('console.workflow.run', { workflowId: req.params.id, tenant: req.tenant.id });
      res.json({ ok: true, run });
    } catch (err) {
      logEvent('console.workflow.run.error', errFields(err));
      res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // ── SOP export ────────────────────────────────────────────────────────────

  app.get('/api/console/workflows/:id/sop', requireActiveTenant, async (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });

      const markdown = generateSopMarkdown(wf);

      if (req.query.format === 'pdf') {
        const { generateSopPdf } = await import('../workflows/sop-pdf.js');
        const pdf = await generateSopPdf(markdown, wf.name || wf.user_intent);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${wf.slug ?? wf.id}-sop.pdf"`);
        return res.send(pdf);
      }

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${wf.slug ?? wf.id}-sop.md"`);
      res.send(markdown);
    } catch (err) {
      logEvent('console.sop.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });
}
