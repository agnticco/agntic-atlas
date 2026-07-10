/**
 * Plan entitlements — the single source of truth for what each tier includes.
 *
 * Pilot/alpha pricing (2026-07-09): a volume-based adoption ladder. Solo is the
 * cheap "get-in-the-door" tier; its loud constraint is ONE active workflow — the
 * pain a user feels first (you can only run one automation at a time, editing it
 * replaces the previous one). Runs are a hard monthly cap (margin protection).
 * Tiering is purely quantitative — seats / activeWorkflows / monthlyRuns — there
 * is NO feature-matrix gating; every feature is available on every plan.
 *
 * `founding` is an internal, grandfathered "unlimited" plan for the existing pilot
 * cohort — not publicly listed, never sold. New tenants default to `solo`.
 *
 * Never hardcode per-plan `if (plan === 'team')` at call sites — read from here.
 * See docs/architecture/tier-gating.md.
 */

export const PLANS = {
  solo:         { seats: 1,        activeWorkflows: 1,        monthlyRuns: 30 },
  professional: { seats: 1,        activeWorkflows: 10,       monthlyRuns: 200 },
  team:         { seats: 5,        activeWorkflows: 50,       monthlyRuns: 1000 },
  business:     { seats: Infinity, activeWorkflows: Infinity, monthlyRuns: 5000 },
  // Grandfathered pilot cohort — unlimited, internal only.
  founding:     { seats: Infinity, activeWorkflows: Infinity, monthlyRuns: Infinity },
};

/** Public, sellable plans in upgrade-ladder order (lowest → highest). */
export const PUBLIC_PLANS = ['solo', 'professional', 'team', 'business'];

/** Display metadata for the sellable plans (labels, monthly USD price, headline limits). */
export const PLAN_META = {
  solo:         { label: 'Solo',         price: 20,  users: 1,          workflows: 1,          runs: 30 },
  professional: { label: 'Professional', price: 50,  users: 1,          workflows: 10,         runs: 200 },
  team:         { label: 'Team',         price: 200, users: 5,          workflows: 50,         runs: 1000 },
  business:     { label: 'Business',     price: 600, users: Infinity,   workflows: Infinity,   runs: 5000 },
};

const DEFAULT_PLAN = 'solo';

/** Entitlement value for a plan (falls back to the adoption tier for unknown plans). */
export function entitlement(plan, key) {
  return (PLANS[plan] ?? PLANS[DEFAULT_PLAN])[key];
}

/** Seat limit (max users) for a plan. */
export function seatLimit(plan) {
  return entitlement(plan, 'seats');
}

/**
 * The next sellable plan up from `plan`, for "Upgrade to X" copy. Returns null if
 * already at the top public tier (or on the internal `founding` plan). `solo` is
 * the fallback for unknown plans, so an unknown plan points at `professional`.
 */
export function nextPlan(plan) {
  if (plan === 'founding') return null; // grandfathered — nothing to upsell
  const idx = PUBLIC_PLANS.indexOf(plan);
  if (idx === -1) return PUBLIC_PLANS[1] ?? null; // unknown → suggest Professional
  return PUBLIC_PLANS[idx + 1] ?? null;           // top tier → null
}

/**
 * Resolve a tenant's full entitlements bundle from the tenant store. Central
 * helper so every gate reads the plan the same way instead of re-deriving it.
 * Returns `{ plan, ...limits }`; falls back to the default plan if the tenant is
 * missing or has an unknown plan.
 */
export function entitlementsFor(tenantStore, tenantId) {
  const plan = tenantStore?.get?.(tenantId)?.plan ?? DEFAULT_PLAN;
  return { plan, ...(PLANS[plan] ?? PLANS[DEFAULT_PLAN]) };
}

export class PlanLimitError extends Error {
  constructor(feature, plan, upgradeTo = nextPlan(plan) ?? 'professional') {
    super(`plan_limit:${feature}`);
    this.status = 402;
    this.code = 'PLAN_LIMIT';
    this.feature = feature;
    this.plan = plan;
    this.upgradeTo = upgradeTo;
  }
}
