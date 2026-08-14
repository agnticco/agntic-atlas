/**
 * Plan entitlements — the single source of truth for what each tier includes.
 *
 * NONE OF THIS APPLIES TO A NORMAL INSTALL. Atlas defaults to self-hosted, where
 * every limit below is off — see `isSelfHosted` further down. This table exists for
 * the case where somebody runs Atlas as a metered service for other people, and it
 * is dormant otherwise. The numbers here are an example ladder, not a
 * recommendation; anyone charging for Atlas should set their own against their own
 * costs.
 *
 * The unit is the RUN, because runs are legible to buyers. But a run is NOT a unit
 * of cost — the same run costs wildly different amounts depending on how much text
 * passes through it, and payload size, not workflow complexity, is what drives it.
 * That is the important design note if you re-derive these: a run cap bounds the
 * blast radius of an expensive workflow without ever constraining what that
 * workflow is allowed to do, which is why the limit is a count and not a budget.
 *
 * activeWorkflows should be set to what the run allowance can actually FUND, not to
 * a flattering headline. A weekday-daily automation consumes ~22 runs a month, so a
 * 75-run plan honestly funds about three daily workflows. Advertising ten while
 * funding three is how you manufacture a bait-and-switch.
 *
 * A workflow BUILD costs BUILD_RUN_COST runs from the allowance (see below) — the
 * converger is real spend and was previously capped by nothing at all.
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

import { boolEnv } from '../utils/env.js';

export const PLANS = {
  solo:         { seats: 1,        activeWorkflows: 1,        monthlyRuns: 30  },
  professional: { seats: 1,        activeWorkflows: 3,        monthlyRuns: 75  },
  team:         { seats: 5,        activeWorkflows: 10,       monthlyRuns: 300 },
  // Business is CONSULTATIVE, not self-serve: unlimited everything, plus hands-on
  // integration work. Unlimited runs is only safe because it cannot be bought
  // without a conversation — the deal is priced against the customer's actual
  // usage. See SELF_SERVE_PLANS; the invariant is enforced by
  // scripts/checks/tier-caps.mjs: unlimited ⇒ not self-serve.
  business:     { seats: Infinity, activeWorkflows: Infinity, monthlyRuns: Infinity },
  // Atlas's own workspace. Unlimited, non-sellable, never offered to a customer.
  internal:     { seats: Infinity, activeWorkflows: Infinity, monthlyRuns: Infinity },
  // RETIRED (2026-07-13). Deliberately mapped to Solo, NOT Infinity: a stale
  // `founding` row must never resolve to an uncapped tenant.
  founding:     { seats: 1,        activeWorkflows: 1,        monthlyRuns: 30  },
};

/**
 * Plans a customer can buy themselves, with a card, without talking to anyone.
 *
 * Business is deliberately absent. It grants unlimited runs, and an unlimited plan
 * that anyone can self-serve is an unbounded cost liability — exactly the hole the
 * retired `founding` plan left open. Business is sold consultatively so the
 * contract can be priced against real usage.
 *
 * Checkout validates against THIS list, not PUBLIC_PLANS (which is the display
 * ladder and still includes Business, because it belongs on the pricing page).
 */
export const SELF_SERVE_PLANS = ['solo', 'professional', 'team'];

/** True if `plan` can be purchased through Stripe Checkout without a sales conversation. */
export function isSelfServe(plan) {
  return SELF_SERVE_PLANS.includes(plan);
}

/**
 * What one workflow build costs from the run allowance.
 *
 * A build is roughly twenty converger turns, which came out close enough to the
 * cost of one worst-case run to charge it as exactly that — hence 1. Prompt caching
 * is what made that true; without it a build cost nearer three runs, which would
 * have left someone on the entry tier only a couple of builds a month alongside a
 * daily automation. Re-measure this if you change the converger's model tiers.
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
  solo:         { label: 'Solo',         price: 20,   users: 1,        workflows: 1,        runs: 30  },
  professional: { label: 'Professional', price: 50,   users: 1,        workflows: 3,        runs: 75  },
  team:         { label: 'Team',         price: 200,  users: 5,        workflows: 10,       runs: 300 },
  // price: null → "Talk to us". Consultative: unlimited usage plus integration
  // work, quoted per engagement. Never render a number for this tier.
  business:     { label: 'Business',     price: null, users: Infinity, workflows: Infinity, runs: Infinity, consultative: true },
};

const DEFAULT_PLAN = 'solo';

/**
 * SELF-HOSTED MODE — the single lever that turns the commercial tiers off.
 *
 * The plan ladder above exists to meter a HOSTED service, where Atlas pays for
 * the inference and recovers it in a subscription. Someone running Atlas on their
 * own machine, against their own API key, is paying for every token directly.
 * Metering them is meaningless, and the default plan (`solo`) would cap them at
 * ONE workflow and THIRTY runs a month — a crippled product out of the box, and
 * the surest way to make a first-time reader conclude Atlas does not work.
 *
 * So `ATLAS_SELF_HOSTED` DEFAULTS TO TRUE, and every limit resolves through the
 * existing `internal` tier: unlimited seats, workflows and runs, and (via
 * tenant-guard.js, which reads the same rule) no daily spend ceiling.
 *
 * DEFAULTING TO TRUE IS DELIBERATE AND IS THE WHOLE POINT: a clone must work with
 * NO configuration at all. A hosted deployment that sells plans must opt IN to
 * metering with `ATLAS_SELF_HOSTED=false`, and the server prints which mode it
 * booted in (the `atlas mode:` line in server.js's listen callback) so an uncapped
 * deployment can never be a silent surprise on someone's card — a limit that is
 * invisible until it bites is the failure shape this codebase's history is full of.
 *
 * A self-hoster who still wants a brake has one: `TENANT_DAILY_USD_LIMIT`, which
 * overrides every plan including this mode. It is off unless they set it.
 *
 * Read lazily rather than captured at import, so a test can set the variable and
 * observe the change without re-importing the module.
 */
export function isSelfHosted() {
  return boolEnv('ATLAS_SELF_HOSTED', true);
}

/**
 * The plan a tenant's LIMITS should be read from — the stored plan normally, and
 * the unlimited `internal` tier whenever Atlas is self-hosted.
 *
 * ONE rule with several readers (`entitlement`, `seatLimit`, `entitlementsFor`,
 * and tenant-guard's spend ceiling) rather than each deciding for itself. Two
 * copies of a rule drifting apart is the single most expensive shape in this
 * codebase's history; a self-hoster whose workflow cap is off but whose spend
 * ceiling is still $1/day would be exactly that defect again.
 */
export function effectivePlan(plan) {
  return isSelfHosted() ? 'internal' : plan;
}

/** Entitlement value for a plan (falls back to the adoption tier for unknown plans). */
export function entitlement(plan, key) {
  const p = effectivePlan(plan);
  return (PLANS[p] ?? PLANS[DEFAULT_PLAN])[key];
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
  const stored = tenantStore?.get?.(tenantId)?.plan ?? DEFAULT_PLAN;
  // Self-hosted reports `internal` as the plan too, not merely internal's limits.
  // That is the honest description of an uncapped workspace, and it keeps every
  // downstream reader consistent for free: `nextPlan('internal')` is null, so no
  // upgrade prompt is offered to someone with nothing to upgrade to, and the
  // PLAN_META lookups are all `?.label ?? plan`, so the label degrades safely.
  const plan = effectivePlan(stored);
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
