/**
 * Branch awareness in the RUNTIME outcome oracle.
 *
 * A branching workflow (classify → branch → N lanes → N deliveries) delivers to
 * exactly ONE lane per input, so its contract carries CONDITIONAL assertions
 * (`{ target:'slack:#support', when:'urgent' }`). A single sample run takes one lane;
 * the oracle must ENFORCE the assertion for the lane it took, SKIP the assertions for
 * the lanes it didn't, and FAIL CLOSED on a `when` that names a value no route can
 * produce.
 *
 * THE LIVE BUG this pins: before the fix, `evaluateExampleRun` enforced every
 * assertion on every run, so a 3-lane branch could never pass its own self-test —
 * one lane delivered, the other two "nothing reached …" — and the verify loop
 * regenerated a correct workflow until it hit the cap and gave up. The regression
 * test is `a 3-lane branch: the urgent sample PASSES (the live bug)`: it FAILS on the
 * pre-fix oracle (a2/a3 unsatisfied) and PASSES after.
 *
 * Written per CLAUDE.md's gate lessons: every guard gets a POSITIVE case (the good
 * shape is accepted) AND the assertion names the CONSEQUENCE (what the run kept /
 * dropped), not merely a boolean, so a check that rejected everything would not pass.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import {
  evaluateExampleRun,
  runRouteInfo,
  assertionApplicability,
  routeDomainOf,
} from '../../src/workflows/outcome-oracle.js';

// A classify → branch → 3-lane spec: urgent→#support, billing_question→#sales,
// general→inbox (via the mandatory catch-all).
function threeLaneSpec() {
  return {
    version: 2,
    name: 'Inbound triage',
    outcome: {
      statement: 'Every inbound message is routed to the right place.',
      assertions: [
        { id: 'a1', kind: 'message_sent', target: 'slack:#support', when: 'urgent' },
        { id: 'a2', kind: 'message_sent', target: 'slack:#sales',   when: 'billing_question' },
        { id: 'a3', kind: 'message_sent', target: 'inbox:Triage',   when: 'general' },
      ],
    },
    triggers: [{ type: 'email', filter: 'is:unread' }],
    nodes: [
      { id: 'triage', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'urgent\nbilling_question\ngeneral', instructions: 'Sort the message.' } },
      { id: 'route', type: 'branch', label: 'Route',
        config: { on: 'triage.output', cases: [
          { when: 'urgent', to: 'send_support' },
          { when: 'billing_question', to: 'send_sales' },
          { when: '*', to: 'save_inbox' },
        ] } },
      { id: 'send_support', type: 'deliver', label: 'To #support', config: { channel: 'slack', target: '#support' } },
      { id: 'send_sales',   type: 'deliver', label: 'To #sales',   config: { channel: 'slack', target: '#sales' } },
      { id: 'save_inbox',   type: 'deliver', label: 'To inbox',    config: { channel: 'inbox_deliver', subject: 'Triage' } },
    ],
    edges: [
      { from: 'triage', to: 'route' },
      { from: 'route', to: 'send_support' },
      { from: 'route', to: 'send_sales' },
      { from: 'route', to: 'save_inbox' },
    ],
  };
}

// A run that classified `category` and delivered to the ONE lane it named. Mirrors the
// engine: only the taken lane's deliver node runs (edge liveness), so only that lane
// appears in deliveries. `laneDelivery` lets a test omit / corrupt the delivery.
function runFor(category, laneDelivery, extraSteps = []) {
  const laneNode = { urgent: 'send_support', billing_question: 'send_sales', general: 'save_inbox' }[category];
  const steps = [
    { nodeId: 'triage', output: category },
    { nodeId: 'route',  output: { value: category, matched: category === 'general' ? '*' : category, to: laneNode } },
    ...extraSteps,
  ];
  const deliveries = [];
  if (laneDelivery) { steps.push({ nodeId: laneNode, output: laneDelivery }); deliveries.push(laneDelivery); }
  return { completed: true, error: null, steps, deliveries };
}

const byId = (contract, id) => contract.find(c => c.id === id);

describe('runRouteInfo / routeDomainOf — reading the route from the run + spec', () => {
  const spec = threeLaneSpec();

  test('the closed route domain is the classify categories', () => {
    const d = routeDomainOf(spec);
    assert.deepEqual([...d].sort(), ['billing_question', 'general', 'urgent']);
  });

  test('the taken route is the classify output for THIS run', () => {
    const info = runRouteInfo(spec, runFor('urgent', { delivered: true, channel: 'slack', target: '#support' }));
    assert.equal(info.hasBranch, true);
    assert.deepEqual([...info.taken], ['urgent']);
    assert.equal(info.domain.has('billing_question'), true);
  });

  test('a linear spec has no branch and an empty route domain', () => {
    const linear = { nodes: [{ id: 'x', type: 'deliver', config: { channel: 'slack', target: '#o' } }] };
    const info = runRouteInfo(linear, { steps: [] });
    assert.equal(info.hasBranch, false);
    assert.equal(info.domain.size, 0);
  });
});

describe('assertionApplicability — which promise applies to a run', () => {
  const info = { hasBranch: true, domain: new Set(['urgent', 'billing_question', 'general']), taken: new Set(['urgent']) };

  test('unconditional (no `when`) always applies', () => {
    assert.deepEqual(assertionApplicability({ target: 'slack:#x' }, info), { conditional: false, applies: true });
  });

  test('the lane that was taken applies', () => {
    const a = assertionApplicability({ target: 'slack:#support', when: 'urgent' }, info);
    assert.equal(a.applies, true);
  });

  test('a lane that was NOT taken is skipped, not failed', () => {
    const a = assertionApplicability({ target: 'slack:#sales', when: 'billing_question' }, info);
    assert.equal(a.applies, false);
    assert.equal(a.malformed, false);
  });

  test('a `when` OUTSIDE the closed route domain is malformed (fail closed), never skipped', () => {
    const a = assertionApplicability({ target: 'slack:#exec', when: 'HIGH' }, info);
    assert.equal(a.applies, false);
    assert.equal(a.malformed, true);
    assert.match(a.reason, /never be checked/);
  });

  test('a conditional promise with NO branch to route it is malformed (fail closed)', () => {
    const a = assertionApplicability({ target: 'slack:#x', when: 'urgent' }, { hasBranch: false, domain: new Set(), taken: new Set() });
    assert.equal(a.applies, false);
    assert.equal(a.malformed, true);
  });

  test('route unknown (empty taken) ENFORCES rather than skips — never a false pass on doubt', () => {
    const a = assertionApplicability({ target: 'slack:#support', when: 'urgent' },
      { hasBranch: true, domain: new Set(['urgent']), taken: new Set() });
    assert.equal(a.applies, true);
  });
});

describe('evaluateExampleRun — a branching workflow self-tests correctly', () => {
  const spec = threeLaneSpec();

  test('a 3-lane branch: the urgent sample PASSES (the live bug)', () => {
    // urgent sample delivers ONLY to #support; #sales and inbox were never reached.
    const run = runFor('urgent', { delivered: true, channel: 'slack', target: '#support', ts: '1.1' });
    const r = evaluateExampleRun(spec, { given: {} }, run);

    assert.equal(r.contractPassed, true, 'the urgent lane delivered; the other two lanes do not apply to this sample');
    assert.equal(byId(r.contract, 'a1').ok, true);
    assert.equal(byId(r.contract, 'a1').applicable, true);
    assert.equal(byId(r.contract, 'a2').applicable, false, '#sales is n/a for an urgent sample');
    assert.equal(byId(r.contract, 'a2').skipped, true);
    assert.equal(byId(r.contract, 'a3').applicable, false, 'inbox is n/a for an urgent sample');
  });

  test('the general sample takes the catch-all lane and PASSES', () => {
    const run = runFor('general', { delivered: true, channel: 'inbox_deliver' });
    const r = evaluateExampleRun(spec, { given: {} }, run);
    assert.equal(r.contractPassed, true);
    assert.equal(byId(r.contract, 'a3').ok, true, 'the inbox promise applied and was kept');
    assert.equal(byId(r.contract, 'a1').skipped, true);
    assert.equal(byId(r.contract, 'a2').skipped, true);
  });

  test('ANTI-WEAKENING: a REAL miss on the taken lane still FAILS', () => {
    // The urgent sample routed to #support but nothing was delivered there (the lane
    // is broken). The fix must not mask this — the applicable assertion must fail.
    const run = runFor('urgent', null);   // no delivery at all
    const r = evaluateExampleRun(spec, { given: {} }, run);
    assert.equal(r.contractPassed, false, 'the applicable lane delivered nothing');
    assert.equal(byId(r.contract, 'a1').ok, false);
    assert.match(byId(r.contract, 'a1').reason, /nothing reached slack:#support/);
    // The other lanes are still merely skipped, not counted against the run.
    assert.equal(byId(r.contract, 'a2').skipped, true);
  });

  test('ANTI-WEAKENING: an UNCONDITIONAL assertion on a branch is ALWAYS enforced', () => {
    // Add a promise with no `when` — a digest that must go out on EVERY run — and a
    // run that did not make it. It must fail even though every conditional lane is fine.
    const s = threeLaneSpec();
    s.outcome.assertions.push({ id: 'a4', kind: 'message_sent', target: 'gmail:ops@acme.com' });
    const run = runFor('urgent', { delivered: true, channel: 'slack', target: '#support' });
    const r = evaluateExampleRun(s, { given: {} }, run);
    assert.equal(r.contractPassed, false, 'the unconditional gmail promise was not kept');
    assert.equal(byId(r.contract, 'a4').ok, false);
    assert.equal(byId(r.contract, 'a4').applicable, true);
  });

  test('FAIL CLOSED: a conditional `when` outside the classify domain is flagged, not skipped', () => {
    const s = threeLaneSpec();
    s.outcome.assertions.push({ id: 'a5', kind: 'message_sent', target: 'slack:#exec', when: 'HIGH' });
    const run = runFor('urgent', { delivered: true, channel: 'slack', target: '#support' });
    const r = evaluateExampleRun(s, { given: {} }, run);
    assert.equal(r.contractPassed, false, 'an uncheckable promise must not read as kept');
    const a5 = byId(r.contract, 'a5');
    assert.equal(a5.ok, false);
    assert.equal(a5.applicable, true, 'flagged — NOT silently skipped');
    assert.notEqual(a5.skipped, true);
    assert.match(a5.reason, /can't check/);
  });

  test('a delivered content-error sentinel FAILS the taken lane but leaves skipped lanes alone', () => {
    // The urgent lane "delivered" but a content step emitted the converger's own
    // "couldn't find the data" sentinel — the promise it fed is broken.
    const run = runFor('urgent',
      { delivered: true, channel: 'slack', target: '#support' },
      [{ nodeId: 'draft', output: 'ERROR: required data not found' }]);
    const r = evaluateExampleRun(spec, { given: {} }, run);
    assert.equal(r.contractPassed, false);
    assert.equal(byId(r.contract, 'a1').ok, false, 'the taken lane fed on an error');
    // A skipped lane never ran; the content-error guard must not touch it.
    assert.equal(byId(r.contract, 'a2').skipped, true);
    assert.equal(byId(r.contract, 'a2').ok, true);
  });
});
