/**
 * Per-tenant abuse/cost guard for expensive LLM endpoints.
 *
 * Cloudflare rate-limits by IP, not by tenant — so a single workspace (one IP, or
 * many) can still run away with LLM cost. This middleware adds two app-side,
 * per-tenant limits:
 *
 *   1. Daily USD ceiling — reject once a tenant's recorded LLM spend for the
 *      current UTC day reaches TENANT_DAILY_USD_LIMIT. Spend is read from
 *      llm_cost_log (all surfaces). Cost is recorded post-call, so this bounds
 *      runaway to ceiling + at most one in-flight operation — acceptable.
 *   2. Concurrency cap — reject when a tenant already has TENANT_MAX_CONCURRENT
 *      guarded requests in flight (in-memory; correct for the single-process
 *      deployment, and the natural seam to externalize when scaling out).
 *
 * Both limits are env-tunable; set either to 0 to disable. The guard never blocks
 * on its own failure (a bad query lets the request through — fail-open on the
 * guard, not the workload).
 */

import { logEvent } from '../utils/event-log.js';

export function createTenantGuard({ workflowStore }) {
  const DAILY_USD       = Number(process.env.TENANT_DAILY_USD_LIMIT ?? 25);
  const MAX_CONCURRENT  = Number(process.env.TENANT_MAX_CONCURRENT ?? 6);
  const inflight = new Map(); // tenantId -> in-flight count

  return function tenantGuard(req, res, next) {
    const tenantId = req.tenant?.id;
    if (!tenantId) return next(); // unauthenticated / no tenant — nothing to scope

    // 1. Daily USD ceiling
    if (DAILY_USD > 0 && workflowStore?.tenantSpendSince) {
      try {
        const startOfDayUtc = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
        const spent = workflowStore.tenantSpendSince(tenantId, startOfDayUtc);
        if (spent >= DAILY_USD) {
          logEvent('tenant_guard.daily_limit', { tenant: tenantId, spent, limit: DAILY_USD, path: req.path });
          return res.status(429).json({ error: 'Daily usage limit reached for this workspace. It resets at midnight UTC — contact your admin to raise the limit.' });
        }
      } catch { /* fail-open: never block real work because the guard query failed */ }
    }

    // 2. Per-tenant concurrency cap
    const cur = inflight.get(tenantId) ?? 0;
    if (MAX_CONCURRENT > 0 && cur >= MAX_CONCURRENT) {
      logEvent('tenant_guard.concurrency', { tenant: tenantId, inflight: cur, limit: MAX_CONCURRENT, path: req.path });
      return res.status(429).json({ error: 'Too many requests in flight for this workspace — please retry in a moment.' });
    }
    inflight.set(tenantId, cur + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inflight.get(tenantId) ?? 1) - 1;
      if (n <= 0) inflight.delete(tenantId); else inflight.set(tenantId, n);
    };
    res.on('finish', release);
    res.on('close', release); // client disconnect / aborted SSE

    next();
  };
}
