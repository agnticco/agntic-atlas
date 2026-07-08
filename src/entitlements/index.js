/**
 * Plan entitlements. The first slice of docs/architecture/tier-gating.md — today
 * it enforces SEATS (users per workspace); other gates (active workflows, monthly
 * runs, sub-daily scheduling, event triggers, retry/notify, ROI export) slot into
 * the same PLANS map as they're built. Never hardcode per-plan `if`s at call
 * sites — read from here.
 */

export const PLANS = {
  starter:    { seats: 1 },
  team:       { seats: Infinity },
  enterprise: { seats: Infinity },
  founding:   { seats: Infinity },
};

/** Entitlement value for a plan (falls back to starter for unknown plans). */
export function entitlement(plan, key) {
  return (PLANS[plan] ?? PLANS.starter)[key];
}

/** Seat limit (max users) for a plan. */
export function seatLimit(plan) {
  return entitlement(plan, 'seats');
}

export class PlanLimitError extends Error {
  constructor(feature, plan, upgradeTo = 'team') {
    super(`plan_limit:${feature}`);
    this.status = 402;
    this.code = 'PLAN_LIMIT';
    this.feature = feature;
    this.plan = plan;
    this.upgradeTo = upgradeTo;
  }
}
