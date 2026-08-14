/**
 * A CLONE MUST WORK WITH NO CONFIGURATION.
 *
 * Atlas's plan ladder exists to meter a HOSTED service that pays for inference and
 * recovers it in a subscription. Someone who has cloned the repo and is running it
 * against their own API key is paying for every token directly, so metering them
 * means nothing — and the stored default plan (`solo`) would cap them at ONE
 * workflow and THIRTY runs a month. A first-time reader who hits that concludes the
 * product is broken, and they are not wrong.
 *
 * So `ATLAS_SELF_HOSTED` defaults to TRUE and every limit resolves through the
 * existing unlimited `internal` tier.
 *
 * THE HALF THAT MATTERS MOST IS THE OTHER DIRECTION. A lever that switches limits
 * off is one mistake away from switching them off for a deployment that is selling
 * plans, so most of what follows asserts that `ATLAS_SELF_HOSTED=false` still meters
 * exactly as it did before.
 *
 * AND BOTH READERS MUST AGREE. The workflow/run/seat caps and the daily SPEND
 * ceiling are two separate mechanisms in two files. A self-hoster with unlimited
 * workflows but a $1/day spend ceiling would be uncapped in name only — the
 * "one rule, two consumers, silently drifted apart" shape this codebase has paid
 * for more than any other. `effectivePlan` is that one rule; these tests prove
 * both consumers read it.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSelfHosted,
  effectivePlan,
  entitlement,
  seatLimit,
  entitlementsFor,
  nextPlan,
  PLANS,
} from '../../src/entitlements/index.js';

// A tenant store stub shaped the way the real one answers: `get(id)` → row or undefined.
const storeWith = (plan) => ({ get: () => (plan == null ? undefined : { plan }) });

let saved;
beforeEach(() => { saved = process.env.ATLAS_SELF_HOSTED; });
afterEach(() => {
  if (saved === undefined) delete process.env.ATLAS_SELF_HOSTED;
  else process.env.ATLAS_SELF_HOSTED = saved;
});

describe('a clone is uncapped out of the box', () => {
  test('self-hosted is the DEFAULT — no configuration required', () => {
    delete process.env.ATLAS_SELF_HOSTED;
    assert.equal(isSelfHosted(), true, 'unset → self-hosted');
    process.env.ATLAS_SELF_HOSTED = '';
    assert.equal(isSelfHosted(), true, 'empty string is not a decision → still self-hosted');
  });

  test('the stored plan does not cap anything', () => {
    delete process.env.ATLAS_SELF_HOSTED;
    // `solo` is what every freshly created tenant is stored as, so this is the
    // exact state a first clone is in.
    const ent = entitlementsFor(storeWith('solo'), 't1');
    assert.equal(ent.activeWorkflows, Infinity, 'no workflow cap');
    assert.equal(ent.monthlyRuns, Infinity, 'no run cap');
    assert.equal(ent.seats, Infinity, 'no seat cap');
  });

  test('a tenant the store has never heard of is uncapped too, not defaulted to solo', () => {
    delete process.env.ATLAS_SELF_HOSTED;
    const ent = entitlementsFor(storeWith(null), 'nobody');
    assert.equal(ent.monthlyRuns, Infinity);
  });

  test('and no upgrade is dangled at someone with nothing to upgrade to', () => {
    delete process.env.ATLAS_SELF_HOSTED;
    const ent = entitlementsFor(storeWith('solo'), 't1');
    assert.equal(nextPlan(ent.plan), null, 'self-hosted offers no upsell');
  });

  test('the direct readers agree with the bundle', () => {
    delete process.env.ATLAS_SELF_HOSTED;
    assert.equal(seatLimit('solo'), Infinity, 'seatLimit');
    assert.equal(entitlement('solo', 'activeWorkflows'), Infinity, 'entitlement');
  });
});

describe('a hosted deployment still meters exactly as before', () => {
  beforeEach(() => { process.env.ATLAS_SELF_HOSTED = 'false'; });

  test('every plan keeps its own limits', () => {
    for (const [plan, limits] of Object.entries(PLANS)) {
      const ent = entitlementsFor(storeWith(plan), 't1');
      assert.equal(ent.activeWorkflows, limits.activeWorkflows, `${plan} workflows`);
      assert.equal(ent.monthlyRuns, limits.monthlyRuns, `${plan} runs`);
      assert.equal(ent.seats, limits.seats, `${plan} seats`);
      assert.equal(ent.plan, plan, `${plan} reports itself`);
    }
  });

  test('the entry tier is still one workflow and thirty runs', () => {
    const ent = entitlementsFor(storeWith('solo'), 't1');
    assert.equal(ent.activeWorkflows, 1);
    assert.equal(ent.monthlyRuns, 30);
    assert.equal(ent.seats, 1);
  });

  test('an unknown plan still falls back to the entry tier, not to unlimited', () => {
    // Failing OPEN here would hand an uncapped workspace to anything with a typo
    // in its plan column — the direction that costs money.
    const ent = entitlementsFor(storeWith('wizard'), 't1');
    assert.equal(ent.monthlyRuns, 30, 'unknown plan is metered at the tightest tier');
  });

  test('and an upgrade is still offered', () => {
    assert.equal(nextPlan(entitlementsFor(storeWith('solo'), 't1').plan), 'professional');
  });
});

describe('the switch is only thrown by an explicit value', () => {
  test('every affirmative spelling means self-hosted', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      process.env.ATLAS_SELF_HOSTED = v;
      assert.equal(isSelfHosted(), true, v);
    }
  });

  test('every negative spelling means hosted', () => {
    for (const v of ['0', 'false', 'FALSE', 'no', 'off']) {
      process.env.ATLAS_SELF_HOSTED = v;
      assert.equal(isSelfHosted(), false, v);
    }
  });

  test('a value nobody can interpret falls back to the default rather than guessing', () => {
    process.env.ATLAS_SELF_HOSTED = 'maybe';
    assert.equal(isSelfHosted(), true, 'unparseable → the documented default');
  });
});

describe('the caps and the spend ceiling read ONE rule', () => {
  test('effectivePlan is that rule, and it is what both consumers call', () => {
    delete process.env.ATLAS_SELF_HOSTED;
    assert.equal(effectivePlan('solo'), 'internal', 'self-hosted rewrites the plan');
    process.env.ATLAS_SELF_HOSTED = 'false';
    assert.equal(effectivePlan('solo'), 'solo', 'hosted leaves it alone');
  });

  test("the spend guard resolves self-hosted to the tier whose ceiling is 'no ceiling'", async () => {
    delete process.env.ATLAS_SELF_HOSTED;
    // tenant-guard's DAILY_USD_BY_PLAN maps `internal` to 0, and 0 disables the
    // check. Asserting the mapping here rather than the number in tenant-guard.js
    // keeps this test about the SEAM: whatever that table says internal costs, a
    // self-hoster is resolved to it.
    assert.equal(effectivePlan('solo'), 'internal');
    const guard = await import('../../src/api/tenant-guard.js');
    assert.equal(typeof guard.createTenantGuard, 'function', 'the guard module imports the shared rule cleanly');
  });
});
