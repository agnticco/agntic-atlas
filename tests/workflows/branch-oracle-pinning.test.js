/**
 * Branch-aware runtime oracle — ADVERSARIAL PINNING (test-adversary, #34).
 *
 * The fix under attack (src/workflows/outcome-oracle.js: routeDomainOf,
 * runRouteInfo, assertionApplicability, evaluateExampleRun) makes a CONDITIONAL
 * assertion (`{ when: 'urgent' }`) be SKIPPED on a sample that took a different
 * lane. The risk is a FALSE PASS: a lane that does NOT deliver self-testing clean
 * because the oracle wrongly skipped the assertion it should have enforced.
 *
 * These tests attack the guard from angles the existing branch-outcome-oracle.test.js
 * does not: a decision-node source, a human-node source, case/whitespace coercion
 * on the TAKEN lane, a delivery to the WRONG target, `delivered:false`, a template
 * locator, and a REACHABLE multi-branch run (both sources recorded) with a broken
 * lane. Every one asserts the CONSEQUENCE (contractPassed + the per-assertion verdict),
 * so a check that skipped everything would not pass.
 *
 * All GREEN: each pins a guard that HOLDS. The single reachable-doubt finding lives
 * in branch-oracle-adversarial.test.js.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import {
  evaluateExampleRun,
  runRouteInfo,
  assertionApplicability,
} from '../../src/workflows/outcome-oracle.js';

const verdict = (r, id) => r.contract.find(c => c.id === id);

// ── A decision-node source ───────────────────────────────────────────────────
// The branch routes on a `decision` whose output enum is the closed domain. The
// oracle must read the decided value ({value:'P1'}) as the taken route, enforce the
// matching lane, skip the other, and FAIL CLOSED on a `when` no rule can produce.
function decisionSpec() {
  const score = {
    id: 'score', type: 'decision',
    config: {
      inputs: [{ key: 'sev', from: 'x.output', type: 'enum', values: ['low', 'high'] }],
      output: { key: 'priority', values: ['P1', 'P2'] },     // ARRAY — the converger's shape (prompts.js:226)
      hitPolicy: 'FIRST',
      rules: [{ when: { sev: 'high' }, then: 'P1' }, { when: { sev: 'low' }, then: 'P2' }],
    },
  };
  return {
    version: 2,
    outcome: { assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#p1', when: 'P1' },
      { id: 'a2', kind: 'message_sent', target: 'slack:#p2', when: 'P2' },
      { id: 'a3', kind: 'message_sent', target: 'slack:#p9', when: 'P9' },  // impossible route
    ] },
    nodes: [
      score,
      { id: 'route', type: 'branch', config: { on: 'score.output', cases: [
        { when: 'P1', to: 's1' }, { when: '*', to: 's2' } ] } },
      { id: 's1', type: 'deliver', config: { channel: 'slack', target: '#p1' } },
      { id: 's2', type: 'deliver', config: { channel: 'slack', target: '#p2' } },
    ],
    edges: [],
  };
}
function decisionRun(value, laneDelivery) {
  const lane = value === 'P1' ? 's1' : 's2';
  const steps = [{ nodeId: 'score', output: { value, text: value, rule: {} } }];
  const deliveries = [];
  if (laneDelivery) { steps.push({ nodeId: lane, output: laneDelivery }); deliveries.push(laneDelivery); }
  return { completed: true, error: null, steps, deliveries };
}

describe('decision-node source', () => {
  test('the closed domain is the decision output enum (read from {value})', () => {
    const info = runRouteInfo(decisionSpec(), decisionRun('P1', { delivered: true, channel: 'slack', target: '#p1' }));
    assert.deepEqual([...info.domain].sort(), ['p1', 'p2']);
    assert.deepEqual([...info.taken], ['p1']);
  });

  test('the P1 lane is enforced, P2 skipped, and the impossible P9 fails closed', () => {
    const r = evaluateExampleRun(decisionSpec(), { given: {} }, decisionRun('P1', { delivered: true, channel: 'slack', target: '#p1' }));
    assert.equal(verdict(r, 'a1').ok, true);
    assert.equal(verdict(r, 'a1').applicable, true);
    assert.equal(verdict(r, 'a2').skipped, true);
    assert.equal(verdict(r, 'a3').ok, false, 'P9 is unprovable — must fail closed, never skip');
    assert.notEqual(verdict(r, 'a3').skipped, true);
    assert.equal(r.contractPassed, false, 'the impossible P9 promise blocks the example');
  });

  test('ANTI-WEAKENING: the P1 lane delivering NOTHING still fails', () => {
    const s = decisionSpec();
    s.outcome.assertions = s.outcome.assertions.filter(a => a.id !== 'a3'); // drop the malformed one
    const r = evaluateExampleRun(s, { given: {} }, decisionRun('P1', null));
    assert.equal(verdict(r, 'a1').ok, false);
    assert.match(verdict(r, 'a1').reason, /nothing reached/i);
    assert.match(verdict(r, 'a1').reason, /#p1/i, 'and it must still name the destination');
    assert.equal(r.contractPassed, false);
  });
});

// ── A human-node source ──────────────────────────────────────────────────────
function humanSpec() {
  return {
    version: 2,
    outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:c@x.com', when: 'approve' }] },
    nodes: [
      { id: 'ask', type: 'human', config: { prompt: 'ok?', decisions: 'approve\nreject',
        timeout: { after: '1h', then: 'reject' }, channels: ['inbox'] } },
      { id: 'route', type: 'branch', config: { on: 'ask.decision', cases: [
        { when: 'approve', to: 's1' }, { when: '*', to: 's2' } ] } },
      { id: 's1', type: 'deliver', config: { channel: 'gmail_send', to: 'c@x.com' } },
      { id: 's2', type: 'deliver', config: { channel: 'inbox_deliver', subject: 'x' } },
    ],
    edges: [],
  };
}

describe('human-node source', () => {
  test('the taken decision is read from {decision}; approve enforces the gmail lane', () => {
    const run = { completed: true, error: null,
      deliveries: [{ delivered: true, channel: 'gmail_send', to: 'c@x.com' }],
      steps: [{ nodeId: 'ask', output: { decision: 'approve', by: 'user:1' } },
              { nodeId: 's1', output: { delivered: true, channel: 'gmail_send', to: 'c@x.com' } }] };
    const info = runRouteInfo(humanSpec(), run);
    assert.deepEqual([...info.taken], ['approve']);
    const r = evaluateExampleRun(humanSpec(), { given: {} }, run);
    assert.equal(verdict(r, 'a1').ok, true);
    assert.equal(r.contractPassed, true);
  });

  test('a REJECT sample skips the approve-lane promise (does not fail it)', () => {
    const run = { completed: true, error: null,
      deliveries: [{ delivered: true, channel: 'inbox_deliver' }],
      steps: [{ nodeId: 'ask', output: { decision: 'reject' } },
              { nodeId: 's2', output: { delivered: true, channel: 'inbox_deliver' } }] };
    const r = evaluateExampleRun(humanSpec(), { given: {} }, run);
    assert.equal(verdict(r, 'a1').skipped, true);
    assert.equal(r.contractPassed, true, 'the approve promise does not apply to a reject sample');
  });

  test('ANTI-WEAKENING: approve taken but the gmail lane delivered nothing → FAIL', () => {
    const run = { completed: true, error: null, deliveries: [],
      steps: [{ nodeId: 'ask', output: { decision: 'approve' } }] };
    const r = evaluateExampleRun(humanSpec(), { given: {} }, run);
    assert.equal(verdict(r, 'a1').ok, false);
    assert.equal(r.contractPassed, false);
  });
});

// ── Coercion / wrong target / delivered:false on the TAKEN lane ───────────────
function classifySpec() {
  return {
    version: 2,
    outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#support', when: 'urgent' }] },
    nodes: [
      { id: 'triage', type: 'llm', config: { mode: 'classify', categories: ['urgent', 'billing', 'general'], instructions: 'x' } },
      { id: 'route', type: 'branch', config: { on: 'triage.output', cases: [
        { when: 'urgent', to: 's1' }, { when: '*', to: 's2' } ] } },
      { id: 's1', type: 'deliver', config: { channel: 'slack', target: '#support' } },
      { id: 's2', type: 'deliver', config: { channel: 'inbox_deliver', subject: 'x' } },
    ],
    edges: [],
  };
}

describe('the TAKEN lane is checked strictly (case / target / delivered flag)', () => {
  test('a route value "URGENT " (case + trailing space) still matches when:"urgent" and ENFORCES', () => {
    // Same normalisation branch.js matches() uses, so the oracle agrees with the engine
    // on which lane was taken. The delivery goes to the WRONG channel → must still fail.
    const run = { completed: true, error: null,
      deliveries: [{ delivered: true, channel: 'slack', target: '#random' }],
      steps: [{ nodeId: 'triage', output: 'URGENT ' },
              { nodeId: 's1', output: { delivered: true, channel: 'slack', target: '#random' } }] };
    const info = runRouteInfo(classifySpec(), run);
    assert.deepEqual([...info.taken], ['urgent'], 'coercion must not lose the taken lane');
    const r = evaluateExampleRun(classifySpec(), { given: {} }, run);
    assert.equal(verdict(r, 'a1').applicable, true, 'the urgent lane WAS taken — it must be enforced, not skipped');
    assert.equal(verdict(r, 'a1').ok, false, 'delivery went to #random, not #support');
    assert.equal(r.contractPassed, false);
  });

  test('a delivery to the taken lane with delivered:false FAILS', () => {
    const run = { completed: true, error: null,
      deliveries: [{ delivered: false, channel: 'slack', target: '#support' }],
      steps: [{ nodeId: 'triage', output: 'urgent' },
              { nodeId: 's1', output: { delivered: false, channel: 'slack', target: '#support' } }] };
    const r = evaluateExampleRun(classifySpec(), { given: {} }, run);
    assert.equal(verdict(r, 'a1').ok, false, 'delivered:false is not a delivery');
    assert.equal(r.contractPassed, false);
  });

  test('a correct delivery to the taken lane PASSES (positive control)', () => {
    const run = { completed: true, error: null,
      deliveries: [{ delivered: true, channel: 'slack', target: '#support' }],
      steps: [{ nodeId: 'triage', output: 'urgent' },
              { nodeId: 's1', output: { delivered: true, channel: 'slack', target: '#support' } }] };
    const r = evaluateExampleRun(classifySpec(), { given: {} }, run);
    assert.equal(r.contractPassed, true);
  });
});

// ── A REACHABLE multi-branch run: both sources recorded, one lane broken ──────
// Two independent branches. Both execute, so a real run records BOTH source
// outputs; `taken` is {normal, paid}. The paid lane's gmail delivery is broken and
// MUST be caught — the union must not let branch b1's route mask branch b2's miss.
function twoBranchSpec() {
  return {
    version: 2,
    outcome: { assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#support',    when: 'urgent' },
      { id: 'a2', kind: 'message_sent', target: 'gmail:vip@acme.com', when: 'paid' },
    ] },
    nodes: [
      { id: 'c1', type: 'llm', config: { mode: 'classify', categories: ['urgent', 'normal'], instructions: 'x' } },
      { id: 'b1', type: 'branch', config: { on: 'c1.output', cases: [{ when: 'urgent', to: 's1' }, { when: '*', to: 's2' }] } },
      { id: 'c2', type: 'llm', config: { mode: 'classify', categories: ['paid', 'free'], instructions: 'x' } },
      { id: 'b2', type: 'branch', config: { on: 'c2.output', cases: [{ when: 'paid', to: 's3' }, { when: '*', to: 's4' }] } },
      { id: 's1', type: 'deliver', config: { channel: 'slack', target: '#support' } },
      { id: 's2', type: 'deliver', config: { channel: 'inbox_deliver', subject: 'x' } },
      { id: 's3', type: 'deliver', config: { channel: 'gmail_send', to: 'vip@acme.com' } },
      { id: 's4', type: 'deliver', config: { channel: 'inbox_deliver', subject: 'y' } },
    ],
    edges: [],
  };
}

describe('multi-branch (both sources recorded — the reachable shape)', () => {
  test('b1=normal, b2=paid, gmail BROKEN → a2 is enforced and the example FAILS', () => {
    const run = { completed: true, error: null,
      deliveries: [{ delivered: true, channel: 'inbox_deliver' }],   // only b1's catch-all delivered
      steps: [{ nodeId: 'c1', output: 'normal' }, { nodeId: 'c2', output: 'paid' },
              { nodeId: 's2', output: { delivered: true, channel: 'inbox_deliver' } }] };
    const info = runRouteInfo(twoBranchSpec(), run);
    assert.deepEqual([...info.taken].sort(), ['normal', 'paid']);
    const r = evaluateExampleRun(twoBranchSpec(), { given: {} }, run);
    assert.equal(verdict(r, 'a1').skipped, true, 'urgent lane not taken (b1=normal)');
    assert.equal(verdict(r, 'a2').applicable, true, 'paid lane WAS taken (b2=paid)');
    assert.equal(verdict(r, 'a2').ok, false, 'the gmail delivery was missing');
    assert.equal(r.contractPassed, false, 'a broken lane in the second branch must not be masked by the first');
  });

  test('b1=urgent, b2=paid, BOTH delivered → PASSES', () => {
    const run = { completed: true, error: null,
      deliveries: [{ delivered: true, channel: 'slack', target: '#support' },
                   { delivered: true, channel: 'gmail_send', to: 'vip@acme.com' }],
      steps: [{ nodeId: 'c1', output: 'urgent' }, { nodeId: 'c2', output: 'paid' },
              { nodeId: 's1', output: { delivered: true, channel: 'slack', target: '#support' } },
              { nodeId: 's3', output: { delivered: true, channel: 'gmail_send', to: 'vip@acme.com' } }] };
    const r = evaluateExampleRun(twoBranchSpec(), { given: {} }, run);
    assert.equal(r.contractPassed, true);
  });
});

// ── Template locator on the taken lane (resolved at run time → matches) ───────
describe('template locator on the taken lane', () => {
  test('a template target on the assertion enforces the lane but matches any destination', () => {
    const s = classifySpec();
    s.outcome.assertions = [{ id: 'a1', kind: 'message_sent', target: 'slack:{{ch}}', when: 'urgent' }];
    const run = { completed: true, error: null,
      deliveries: [{ delivered: true, channel: 'slack', target: '#whatever' }],
      steps: [{ nodeId: 'triage', output: 'urgent' },
              { nodeId: 's1', output: { delivered: true, channel: 'slack', target: '#whatever' } }] };
    const r = evaluateExampleRun(s, { given: {} }, run);
    assert.equal(verdict(r, 'a1').applicable, true);
    assert.equal(verdict(r, 'a1').ok, true, 'a template locator is undecidable → any slack delivery satisfies it');
    // …but NO slack delivery at all still fails.
    const run2 = { completed: true, error: null, deliveries: [], steps: [{ nodeId: 'triage', output: 'urgent' }] };
    assert.equal(evaluateExampleRun(s, { given: {} }, run2).contractPassed, false);
  });
});

// ── assertionApplicability unit edges: null-ish `when` is UNCONDITIONAL ───────
describe('assertionApplicability — null-ish `when` is unconditional (always enforced)', () => {
  const info = { hasBranch: true, domain: new Set(['urgent']), taken: new Set(['general']) };
  for (const when of [undefined, null, '', '   ']) {
    test(`when=${JSON.stringify(when)} → conditional:false, applies:true`, () => {
      assert.deepEqual(assertionApplicability({ target: 'slack:#x', when }, info),
        { conditional: false, applies: true });
    });
  }
  test('an ARRAY `when` is treated as malformed (fail closed), never skipped', () => {
    const a = assertionApplicability({ target: 'slack:#x', when: ['urgent', 'billing'] }, info);
    assert.equal(a.applies, false);
    assert.equal(a.malformed, true);
  });
});
