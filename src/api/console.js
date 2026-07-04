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

import { promises as fs } from 'node:fs';
import { logEvent, errFields } from '../utils/event-log.js';
import { generateSopMarkdown } from '../workflows/sop-generator.js';
import { generateRoiMarkdown } from '../workflows/roi-report.js';
import { timeSavedMinutesForRun } from '../workflows/time-saved.js';

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

      // Test runs are real executions (end-to-end, produce output), so they count
      // as runs here — this keeps the metrics band consistent with the run-history
      // list, which shows them with a TEST badge (Q13). Time-saved/ROI still
      // excludes test runs (that measures real-work value, not executions).
      const runs = store.getRuns(req.params.id, 200, {
        userId:   req.user.id,
        tenantId: req.tenant.id,
      });

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

  // ── Defer an overdue run ──────────────────────────────────────────────────
  // Mark a missed scheduled run as handled WITHOUT executing it — sets last_run
  // to now so _flowScheduleState no longer reports it overdue; it fires next at
  // its normal scheduled time. (Owner chose "defer to next scheduled trigger.")
  app.post('/api/console/workflows/:id/defer', requireActiveTenant, (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });
      store.update(req.params.id, { lastRun: new Date().toISOString() }, { userId: req.user.id, snapshot: false });
      logEvent('console.workflow.defer', { workflowId: req.params.id, tenant: req.tenant.id });
      res.json({ ok: true });
    } catch (err) {
      logEvent('console.workflow.defer.error', errFields(err));
      res.status(500).json({ ok: false, error: err.message ?? String(err) });
    }
  });

  // ── Profile (P9) ─────────────────────────────────────────────────────────

  app.get('/api/console/workflows/:id/profile', requireActiveTenant, (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });

      const baselineDurationS = wf.baseline_duration_s ?? 0;
      const runs = store.getRuns(req.params.id, 100, {
        userId:   req.user.id,
        tenantId: req.tenant.id,
      }).filter(r => !r.is_test && r.status === 'success' && r.started_at && r.completed_at);

      const runTimesMs = runs.map(r => new Date(r.completed_at) - new Date(r.started_at));

      const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
      let ytdTimeSavedS = 0;
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].started_at < yearStart) continue;
        // Unified model: measured when a baseline exists, else flat estimate.
        ytdTimeSavedS += timeSavedMinutesForRun(runs[i], baselineDurationS) * 60;
      }

      const lastRunMs = runTimesMs[0] ?? null;

      const sparkline = runs.slice(0, 20).map((r, i) => ({
        durationMs: runTimesMs[i],
        startedAt:  r.started_at,
      }));

      const recentOutputs = runs.slice(0, 5).map((r, i) => {
        let output = typeof r.output === 'string' ? r.output : JSON.stringify(r.output ?? '');
        // Prefer the last non-delivery step's human-readable output over the delivery metadata
        try {
          const steps = r.steps ? (typeof r.steps === 'string' ? JSON.parse(r.steps) : r.steps) : [];
          const meaningful = (Array.isArray(steps) ? steps : [])
            .filter(s => s.type === 'step_completed' && s.nodeId && !String(s.nodeId).includes('deliver') && typeof s.output === 'string' && s.output.length > 10);
          if (meaningful.length > 0) output = meaningful[meaningful.length - 1].output;
        } catch {}
        return { id: r.id, startedAt: r.started_at, durationMs: runTimesMs[i], output };
      });

      res.json({
        profile: {
          baseline: {
            durationS:     baselineDurationS,
            recordingPath: wf.baseline_recording_path || null,
            setAt:         wf.baseline_set_at || null,
          },
          timeSavedYtdS: Math.max(0, ytdTimeSavedS),
          lastRunMs,
          sparkline,
          recentOutputs,
        },
      });
    } catch (err) {
      logEvent('console.profile.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/console/workflows/:id/baseline', requireActiveTenant, (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });

      const { durationS, recordingPath } = req.body;
      if (typeof durationS !== 'number' || durationS <= 0) return res.status(400).json({ error: 'durationS must be a positive number' });

      const fields = {
        baseline_duration_s: Math.round(durationS),
        baseline_set_at:     new Date().toISOString(),
      };
      if (recordingPath) fields.baseline_recording_path = recordingPath;

      store.update(req.params.id, fields, { userId: req.user.id });
      logEvent('console.baseline.set', { workflowId: req.params.id, durationS, tenant: req.tenant.id });
      res.json({ ok: true });
    } catch (err) {
      logEvent('console.baseline.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // Raw binary upload (video/webm). We stream the body ourselves so we don't
  // need express.raw — express.json only parses application/json, leaving other
  // content-types untouched and the stream still readable here.
  app.post('/api/console/workflows/:id/baseline/recording', requireActiveTenant, async (req, res) => {
    try {
      const wf = store.get(req.params.id, { userId: req.user.id });
      if (!wf || wf.tenant_id !== req.tenant.id) return res.status(404).json({ error: 'Not found' });

      const dir = './memory/recordings';
      await fs.mkdir(dir, { recursive: true });

      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', c => chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      const ext = (req.headers['content-type'] || '').includes('mp4') ? 'mp4' : 'webm';
      const filename = `${req.params.id}-${Date.now()}.${ext}`;
      await fs.writeFile(`${dir}/${filename}`, Buffer.concat(chunks));

      const publicPath = `/recordings/${filename}`;
      store.update(req.params.id, { baseline_recording_path: publicPath }, { userId: req.user.id });
      logEvent('console.baseline.recording', { workflowId: req.params.id, filename, tenant: req.tenant.id });
      res.json({ ok: true, path: publicPath });
    } catch (err) {
      logEvent('console.baseline.recording.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // ── All-up ROI summary (P9) ───────────────────────────────────────────────

  // Shared ROI computation — used by the JSON endpoint and the export (Q08).
  const computeRoi = (userId, tenantId) => {
    const workflows = store.list({ userId, tenantId });
    let totalTimeSavedMinutes = 0;
    let totalRuns = 0;
    const byWorkflow = [];
    for (const wf of workflows) {
      const runs = store.getRuns(wf.id, 500, { userId, tenantId })
        .filter(r => !r.is_test && r.status === 'success' && r.started_at && r.completed_at);
      const baselineS = wf.baseline_duration_s ?? 0;
      let wfSavedMinutes = 0;
      for (const r of runs) wfSavedMinutes += timeSavedMinutesForRun(r, baselineS); // unified model
      totalTimeSavedMinutes += wfSavedMinutes;
      totalRuns += runs.length;
      byWorkflow.push({
        id: wf.id,
        name: wf.name || wf.user_intent || 'Untitled',
        runs: runs.length,
        baselineDurationS: baselineS,
        timeSavedMinutes: Math.round(wfSavedMinutes * 10) / 10,
      });
    }
    return {
      totalTimeSavedMinutes: Math.round(totalTimeSavedMinutes * 10) / 10,
      totalRuns,
      byWorkflow,
      generatedAt: new Date().toISOString(),
    };
  };

  app.get('/api/console/roi', requireActiveTenant, (req, res) => {
    try {
      res.json({ roi: computeRoi(req.user.id, req.tenant.id) });
    } catch (err) {
      logEvent('console.roi.error', errFields(err));
      res.status(500).json({ error: err.message });
    }
  });

  // Customer-facing ROI report export (Markdown / PDF), reusing the SOP PDF pipe.
  app.get('/api/console/roi/export', requireActiveTenant, async (req, res) => {
    try {
      const roi = computeRoi(req.user.id, req.tenant.id);
      const tenantName = req.tenant.name || req.tenant.id || 'Your workspace';
      const markdown = generateRoiMarkdown(roi, { tenantName });
      const stamp = (roi.generatedAt || '').slice(0, 10);
      if (req.query.format === 'pdf') {
        const { generateSopPdf } = await import('../workflows/sop-pdf.js');
        const pdf = await generateSopPdf(markdown, `ROI Report — ${tenantName}`);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="roi-report-${stamp}.pdf"`);
        return res.send(pdf);
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="roi-report-${stamp}.md"`);
      res.send(markdown);
    } catch (err) {
      logEvent('console.roi.export.error', errFields(err));
      res.status(500).json({ error: err.message });
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
