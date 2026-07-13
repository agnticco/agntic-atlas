/**
 * Plan entitlements — the single source of truth for what each tier includes.
 *
 * Caps re-derived from measured cost (2026-07-13). See docs/architecture/cost-model-v2.pdf.
 *
 * The unit is the RUN, because runs are legible to buyers. But a run is not a
 * unit of cost: measured run cost spans $0.00056 → $0.20636, a 369× spread that
 * tracks payload size, not workflow complexity. So each cap below is the largest
 * allowance that still yields ~65% gross margin **if every single run is the most
 * expensive shape we could construct** (a web_fetch → extract → rewrite chain),
 * net of Stripe fees. Light users yield 96%+. The low cap IS the safety
 * mechanism: it bounds the blast radius of an expensive workflow without ever
 * constraining what that workflow is allowed to do.
 *
 * activeWorkflows is set to what the run budget can actually FUND, not to a
 * flattering headline. A weekday-daily automation consumes 22 runs/month, so
 * Professional's 75 runs honestly funds ~3 daily workflows, not 10. Advertising
 * 10 while funding 3 is how you manufacture a bait-and-switch.
 *
 * A workflow BUILD costs BUILD_RUN_COST runs from the allowance (see below) —
 * the converger is real spend and was previously capped by nothing at all.
 *
 * `internal` is Atlas's own workspace — unlimited, never sold, not a customer
 * tier. `founding` is RETIRED: it was an unlimited grandfather plan and therefore
 * an unbounded liability. It is kept here mapped to Solo's limits purely so that a
 * stale row can never resolve to "unlimited"; the tenant-store migration moves
 * every founding tenant to a real plan.
 *
 * Tiering is purely quantitative — seats / activeWorkflows / monthlyRuns. There is
 * NO feature-matrix gating; every feature is available on every plan.
 *
 * Never hardcode per-plan `if (plan === 'team')` at call sites — read from here.
 * See docs/architecture/tier-gating.md.
 */

export const PLANS = {
  solo:         { seats: 1,        activeWorkflows: 1,        monthlyRuns: 30  },
  professional: { seats: 1,        activeWorkflows: 3,        monthlyRuns: 75  },
  team:         { seats: 5,        activeWorkflows: 10,       monthlyRuns: 300 },
  business:     { seats: Infinity, activeWorkflows: Infinity, monthlyRuns: 900 },
  // Atlas's own workspace. Unlimited, non-sellable, never offered to a customer.
  internal:     { seats: Infinity, activeWorkflows: Infinity, monthlyRuns: Infinity },
  // RETIRED (2026-07-13). Deliberately mapped to Solo, NOT Infinity: a stale
  // `founding` row must never resolve to an uncapped tenant.
  founding:     { seats: 1,        activeWorkflows: 1,        monthlyRuns: 30  },
};

/**
 * What one workflow build costs from the run allowance.
 *
 * A build is ~21 converger turns and measured at $0.2215 (post prompt-caching,
 * v1.3.8) — almost exactly the price of one worst-case run ($0.20636), hence 1.
 * Before caching a build cost 2.6 run-units, which would have left a Solo user
 * only two builds a month alongside a daily automation; at 1 they get seven.
 *
 * Charged on publish, not per chat turn: a completed workflow is the legible
 * unit, and it keeps a single meter rather than inventing a second currency.
 * Known gap: an abandoned build costs real money and is not billed — bounded by
 * the per-plan daily USD ceiling in tenant-guard.js, not by this.
 */
export const BUILD_RUN_COST = 1;

/** Public, sellable plans in upgrade-ladder order (lowest → highest). */
export const PUBLIC_PLANS = ['solo', 'professional', 'team', 'business'];

/** Display metadata for the sellable plans (labels, monthly USD price, headline limits). */
export const PLAN_META = {
  solo:         { label: 'Solo',         price: 20,  users: 1,          workflows: 1,          runs: 30  },
  professional: { label: 'Professional', price: 50,  users: 1,          workflows: 3,          runs: 75  },
  team:         { label: 'Team',         price: 200, users: 5,          workflows: 10,         runs: 300 },
  business:     { label: 'Business',     price: 600, users: Infinity,   workflows: Infinity,   runs: 900 },
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
 * already at the top public tier, or on a non-sellable plan. `solo` is the
 * fallback for unknown plans, so an unknown plan points at `professional`.
 */
export function nextPlan(plan) {
  // Non-sellable plans have nothing to upsell — never show Atlas's own workspace
  // (or a stale founding row) an upgrade prompt.
  if (plan === 'internal' || plan === 'founding') return null;
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
