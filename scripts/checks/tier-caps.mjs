#!/usr/bin/env node
/**
 * Tier caps — structural guard on the plan ladder.
 *
 * Atlas ships the machinery to run as a metered service (see src/entitlements),
 * dormant by default. This check enforces the properties of that ladder that are
 * about SAFETY rather than about any particular price list, so the machinery
 * cannot be edited into a shape that quietly creates unbounded cost.
 *
 * It reads `PLANS` DIRECTLY rather than through `entitlement()`. That distinction
 * is load-bearing: `entitlement()` resolves through `effectivePlan()`, which
 * rewrites every plan to the unlimited `internal` tier when Atlas is self-hosted —
 * which is the DEFAULT. Asking it here would report every plan as unlimited and
 * fail, on a deployment that is not selling anything at all. This check is about
 * the table, not about how this particular box is configured.
 *
 * Run: node scripts/checks/tier-caps.mjs
 */
import { PLANS, PLAN_META, PUBLIC_PLANS, isSelfServe } from '../../src/entitlements/index.js';

let failed = 0;
const fail = (msg) => { console.error('  FAIL  ' + msg); failed++; };
const ok   = (msg) => console.log('  ok    ' + msg);

/** The plan table's own value, never the current deployment's effective one. */
const runsFor = (plan) => PLANS[plan]?.monthlyRuns ?? Infinity;

console.log('TIER CAPS — structural guard\n');

// 1. THE INVARIANT: unlimited runs ⇒ not self-serve.
//
// An unlimited plan anyone can buy with a card is an unbounded cost liability —
// exactly the hole the retired `founding` plan left open. Unlimited is allowed
// ONLY on a consultative plan, where the contract is priced against real usage.
for (const plan of PUBLIC_PLANS) {
  const runs = runsFor(plan);
  const finite = Number.isFinite(runs);
  if (!finite && isSelfServe(plan)) {
    fail(`${plan}: UNLIMITED runs AND self-serve — anyone with a card can create unbounded cost`);
  } else if (!finite) {
    ok(`${plan}: unlimited runs, but consultative (not self-serve) — priced per engagement`);
  } else {
    ok(`${plan}: monthlyRuns is finite (${runs})`);
  }
}

// 2. A consultative plan must not carry a listed price, or the pricing page shows
//    a number a customer can hold you to for an unscoped engagement.
for (const plan of PUBLIC_PLANS) {
  if (!isSelfServe(plan) && PLAN_META[plan]?.price != null) {
    fail(`${plan}: consultative but has a listed price — must be "Talk to us"`);
  } else if (!isSelfServe(plan)) {
    ok(`${plan}: consultative and correctly unpriced`);
  }
}

// 3. `founding` is retired and must never resolve to unlimited again.
if (!Number.isFinite(runsFor('founding'))) {
  fail('founding: still unlimited — a stale row would be an uncapped tenant');
} else {
  ok('founding: retired, capped (a stale row cannot be uncapped)');
}

// 4. Every sellable plan must be a real entry in the table. A plan offered for
//    sale that does not exist would fall back to the entry tier's limits while
//    charging its own price.
for (const plan of PUBLIC_PLANS) {
  if (!PLANS[plan]) fail(`${plan}: listed as a public plan but absent from PLANS`);
  else if (!PLAN_META[plan]) fail(`${plan}: in PLANS but has no display metadata`);
  else ok(`${plan}: defined in both PLANS and PLAN_META`);
}

console.log(failed ? `\nTIER-CAPS-FAIL (${failed})` : '\nTIER-CAPS-PASS');
process.exit(failed ? 1 : 0);
