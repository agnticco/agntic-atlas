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
import { numEnv } from '../utils/env.js';
import { effectivePlan } from '../entitlements/index.js';

/**
 * Daily USD ceiling, per plan. A single flat limit is not a guard — it was $25/day
 * for EVERY plan, i.e. up to ~$750/month of inference on a $20/month subscription,
 * a 37x downside. Each ceiling below is ~1.5x the plan's own monthly price spread
 * over a day: generous enough that no legitimate user ever sees it, tight enough
 * that a runaway tenant cannot cost multiples of what they pay.
 *
 * This is a backstop, not the primary control — the monthly run cap is. It exists
 * to bound the surfaces the run cap does not meter (notably abandoned builds and
 * free-form chat, which cost real money and produce no workflow).
 */
const DAILY_USD_BY_PLAN = {
  solo:         1,    // $20/mo plan
  professional: 3,    // $50/mo
  team:         10,   // $200/mo
  business:     30,   // $600/mo
  internal:     0,    // Atlas's own workspace — unbounded (0 = disabled)
  founding:     1,    // retired; treated as solo
};

export function createTenantGuard({ workflowStore, tenantStore = null }) {
  // Env override applies to every plan (escape hatch / incident lever). When
  // unset, the per-plan table above is used.
  const DAILY_USD_OVERRIDE = numEnv('TENANT_DAILY_USD_LIMIT', 0);
  const MAX_CONCURRENT     = numEnv('TENANT_MAX_CONCURRENT', 6);
  const inflight = new Map(); // tenantId -> in-flight count

  const dailyLimitFor = (tenantId) => {
    if (DAILY_USD_OVERRIDE > 0) return DAILY_USD_OVERRIDE;
    // Read the plan through the SAME rule the entitlement gates use. Self-hosted
    // resolves to `internal` (ceiling 0 = disabled), so a self-hoster does not end
    // up with unlimited workflows but a $1/day spend cap — two halves of one
    // decision drifting apart is the defect shape this codebase has paid for most.
    // `TENANT_DAILY_USD_LIMIT` above still overrides everything, including this,
    // which is how a self-hoster opts back into a brake.
    const plan = effectivePlan(tenantStore?.get?.(tenantId)?.plan);
    // Unknown plan → the tightest ceiling. Failing closed on an unrecognised plan
    // is the safe direction for a spend guard.
    return DAILY_USD_BY_PLAN[plan] ?? DAILY_USD_BY_PLAN.solo;
  };

  return function tenantGuard(req, res, next) {
    const tenantId = req.tenant?.id;
    if (!tenantId) return next(); // unauthenticated / no tenant — nothing to scope

    // 1. Daily USD ceiling, scaled to what the tenant actually pays
    const DAILY_USD = dailyLimitFor(tenantId);
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
