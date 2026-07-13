#!/usr/bin/env node
/**
 * Tier caps — margin guard.
 *
 * The caps in src/entitlements are not preferences, they are derived from
 * measured LLM cost (docs/architecture/cost-model-v2.pdf). This check re-derives
 * the margin at every cap and fails if any plan could lose money — so that raising
 * a cap forces you to redo the arithmetic instead of quietly shipping a tier that
 * bleeds.
 *
 * Run: node --env-file-if-exists=.env scripts/checks/tier-caps.mjs
 */
import { PLANS, PLAN_META, PUBLIC_PLANS, SELF_SERVE_PLANS, BUILD_RUN_COST, entitlement, isSelfServe } from '../../src/entitlements/index.js';

// ── Measured inputs (2026-07-13, post prompt-caching v1.3.8) ─────────────────
// Worst run we could construct across eight connectors: web_fetch -> extract ->
// rewrite, whose cost is a 47k-token article payload. Caching does not touch it.
const WORST_RUN_USD  = 0.20636;
const BUILD_USD      = 0.2215;
const STRIPE = (p) => p * 0.029 + 0.30;

// A plan must hold this margin even if EVERY run is the worst possible shape.
const MIN_WORST_CASE_GM = 0.60;

let failed = 0;
const fail = (msg) => { console.error('  FAIL  ' + msg); failed++; };
const ok   = (msg) => console.log('  ok    ' + msg);

console.log('TIER CAPS — margin guard\n');

// 1. THE INVARIANT: unlimited runs ⇒ not self-serve.
//
// An unlimited plan anyone can buy with a card is an unbounded cost liability —
// exactly the hole the retired `founding` plan left open. Unlimited is allowed
// ONLY on a consultative plan, where the contract is priced against real usage.
for (const plan of PUBLIC_PLANS) {
  const runs = entitlement(plan, 'monthlyRuns');
  const finite = Number.isFinite(runs);
  if (!finite && isSelfServe(plan)) {
    fail(`${plan}: UNLIMITED runs AND self-serve — anyone with a card can create unbounded cost`);
  } else if (!finite) {
    ok(`${plan}: unlimited runs, but consultative (not self-serve) — priced per engagement`);
  } else {
    ok(`${plan}: monthlyRuns is finite (${runs})`);
  }
}

// A consultative plan must not have a listed price, or the pricing page will
// render a number a customer can hold you to for an unscoped engagement.
for (const plan of PUBLIC_PLANS) {
  if (!isSelfServe(plan) && PLAN_META[plan]?.price != null) {
    fail(`${plan}: consultative but has a listed price ($${PLAN_META[plan].price}) — must be "Talk to us"`);
  }
}

// 2. `founding` is retired and must never resolve to unlimited again.
if (!Number.isFinite(PLANS.founding?.monthlyRuns ?? Infinity)) {
  fail("founding: still unlimited — a stale row would be an uncapped tenant");
} else {
  ok('founding: retired, capped (a stale row cannot be uncapped)');
}

// 3. Worst-case margin at each cap, charging builds against the same meter.
console.log('\nWorst-case gross margin (every run the most expensive shape):\n');
console.log('  plan          price   runs   COGS@cap   Stripe    GM');
for (const plan of SELF_SERVE_PLANS) {
  const price = PLAN_META[plan].price;
  const runs  = entitlement(plan, 'monthlyRuns');
  const cogs  = runs * WORST_RUN_USD;
  const gm    = (price - cogs - STRIPE(price)) / price;
  const line  = `  ${plan.padEnd(13)} $${String(price).padStart(4)}  ${String(runs).padStart(5)}  `
              + `$${cogs.toFixed(2).padStart(8)}  $${STRIPE(price).toFixed(2).padStart(6)}  ${(gm * 100).toFixed(0).padStart(3)}%`;
  console.log(line);
  if (gm < MIN_WORST_CASE_GM) {
    fail(`${plan}: worst-case GM ${(gm * 100).toFixed(0)}% is below the ${MIN_WORST_CASE_GM * 100}% floor`);
  }
}

// 4. A build must be charged, and priced at roughly what it costs.
console.log('');
if (!(BUILD_RUN_COST >= 1)) {
  fail('BUILD_RUN_COST is 0 — converger spend would be metered by nothing (the old hole)');
} else {
  const charged = BUILD_RUN_COST * WORST_RUN_USD;
  ok(`a build costs ${BUILD_RUN_COST} run-unit(s) = $${charged.toFixed(4)} of allowance vs $${BUILD_USD} real cost`);
  if (charged < BUILD_USD * 0.75) {
    fail(`build is under-charged: ${BUILD_RUN_COST} run-unit(s) only covers $${charged.toFixed(4)} of a $${BUILD_USD} build`);
  }
}

// 5. Every plan must fund at least one weekday-daily automation (22 runs/month),
//    or the workflow count we advertise is a promise the run budget cannot keep.
console.log('');
const DAILY = 22;
for (const plan of SELF_SERVE_PLANS) {
  const runs = entitlement(plan, 'monthlyRuns');
  const wfs  = entitlement(plan, 'activeWorkflows');
  const funded = Math.floor(runs / DAILY);
  if (Number.isFinite(wfs) && funded < wfs) {
    fail(`${plan}: advertises ${wfs} workflows but ${runs} runs only funds ${funded} daily ones`);
  } else {
    ok(`${plan}: ${runs} runs funds ${funded} daily automation(s); advertises ${wfs}`);
  }
}

console.log('');
if (failed) {
  console.error(`TIER-CAPS-FAIL (${failed} problem${failed === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log('TIER-CAPS-PASS');
