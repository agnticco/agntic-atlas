/**
 * LANE COVERAGE — a router is only proved on the routes you test (F16).
 *
 * docs/handoff/ui-test-findings-2026-07-19.md, F16: a 3-lane router (urgent →
 * Slack, billing → inbox, general → do nothing) was certified "Contract kept …
 * every promise held — it's cleared to go live" on a SINGLE sample that
 * classified `general`, routed to the do-nothing lane, and executed no delivery
 * node at all. Both delivery promises were reported held without either having
 * ever run.
 *
 * Per-example verdicts cannot catch this — each example is individually honest.
 * It is a property of the SAMPLE SET, so it is judged over the set.
 *
 * WHAT IS PINNED HERE:
 *   1. the F16 shape reports the uncovered lanes, by the user's own case names,
 *   2. exercising every lane clears it (honesty was not bought by blocking all),
 *   3. a workflow with no branch is untouched,
 *   4. lanes are grouped by TARGET, so values sharing a lane count once,
 *   5. the lane a run took is read from the branch's OWN output — not re-derived.
 *
 * (4) and (5) are the load-bearing design choices. Demanding a sample per VALUE
 * rather than per LANE makes coverage unreachable on the decision tables that
 * most need it; re-deriving the selection rule here would be a second copy of
 * `branch.run()`, and decision-analysis.js proved twice that two copies of one
 * rule diverge and produce a proof about a program nobody is running.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { laneCoverage, laneInventoryOf } from '../../src/workflows/outcome-oracle.js';
// RE-POINTED 2026-08-02: lane coverage is unchanged and is still the rule that a
// router is only proved on the routes you test. What changed is where a run's
// `lanes` come from — the per-run judge is now `evaluateDeliveryRun`, which
// returns the same `lanes` / `laneInventory` fields off the same oracle helpers.
import { evaluateDeliveryRun } from '../../src/workflows/delivery-verdict.js';

/** The live 3-lane router, verbatim in shape. */
const routerSpec = () => ({
  version: 2,
  outcome: {
    statement: 'Urgent mail posts to #ops; billing mail is saved to the inbox.',
    assertions: [
      { id: 'a1', kind: 'message_sent', target: 'slack:#ops',    when: 'urgent'  },
      { id: 'a2', kind: 'message_sent', target: 'inbox:billing', when: 'billing' },
    ],
  },
  nodes: [
    { id: 'classify', type: 'llm',    config: { mode: 'classify', categories: 'urgent\nbilling\ngeneral' } },
    { id: 'route',    type: 'branch', config: { on: '{{classify.output}}', cases: [
        { when: 'urgent', to: 'slack' }, { when: 'billing', to: 'inbox' }, { when: '*', to: 'quiet' } ] } },
    { id: 'slack', type: 'deliver',  config: { channel: 'slack', target: '#ops' } },
    { id: 'inbox', type: 'deliver',  config: { channel: 'inbox', target: 'billing' } },
    { id: 'quiet', type: 'assemble', label: 'Do nothing', config: { content: '' } },
  ],
  edges: [{ from: 'classify', to: 'route' }, { from: 'route', to: 'slack' },
          { from: 'route', to: 'inbox' },    { from: 'route', to: 'quiet' }],
});

/** A run that classified `val` and routed to `to`, exactly as the engine records it. */
const run = (val, to, deliveries = []) => ({
  completed: true, error: null, deliveries,
  steps: [
    { nodeId: 'classify', output: val },
    { nodeId: 'route',    output: { value: val, matched: val === 'general' ? '*' : val, to, viaCatchAll: val === 'general' } },
    { nodeId: to,         output: to === 'quiet' ? '' : { delivered: true } },
  ],
});

const evalOf = (spec, r, i = 0) => evaluateDeliveryRun(spec, { id: `e${i}` }, r);

describe('lane coverage over a sample set', () => {
  test('F16: one sample down the do-nothing lane leaves the two delivery lanes UNPROVEN', () => {
    const spec = routerSpec();
    const results = [evalOf(spec, run('general', 'quiet'))];
    const cov = laneCoverage(spec, results);

    assert.equal(cov.applicable, true);
    assert.equal(cov.total, 3, 'three lanes: urgent, billing, and the catch-all');
    assert.equal(cov.covered, 1);
    assert.equal(cov.uncovered.length, 2,
      'a router certified on one lane is a router certified on nothing that matters');

    // Named the way the USER wrote them — a lane reported as `slack` or
    // `deliver_slack_a1` does not tell them which example to supply.
    const labels = cov.uncovered.map(l => l.label).sort();
    assert.deepEqual(labels, ['billing', 'urgent']);
  });

  test('exercising every lane clears it — honesty was not bought by blocking everything', () => {
    const spec = routerSpec();
    const results = [
      evalOf(spec, run('general', 'quiet'), 0),
      evalOf(spec, run('urgent',  'slack', [{ delivered: true, channel: 'slack', locators: ['#ops'] }]), 1),
      evalOf(spec, run('billing', 'inbox', [{ delivered: true, channel: 'inbox', locators: ['billing'] }]), 2),
    ];
    const cov = laneCoverage(spec, results);

    assert.equal(cov.uncovered.length, 0);
    assert.equal(cov.covered, 3);
    // …and the two lanes that carry promises really did keep them.
    assert.equal(results[1].verdict, 'kept');
    assert.equal(results[2].verdict, 'kept');
  });

  test('a workflow with no branch is not subject to lane coverage at all', () => {
    const linear = {
      version: 2,
      outcome: { statement: 'Post the digest.', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
      nodes: [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }], edges: [],
    };
    const r = evaluateDeliveryRun(linear, {}, {
      completed: true, error: null,
      steps: [{ nodeId: 'd', output: { delivered: true } }],
      deliveries: [{ delivered: true, channel: 'slack', locators: ['#ops'] }],
    });
    assert.equal(laneCoverage(linear, [r]).applicable, false,
      'every linear workflow in production must be untouched by this');
    assert.equal(r.verdict, 'kept', 'and must still certify normally');
  });

  test('values sharing a TARGET are one lane, not several', () => {
    // A decision table routing P2 and P3 to the same "stay quiet" step has ONE
    // lane there. Counting per-value would demand a sample per enum member and
    // make coverage unreachable on exactly the tables that most need it.
    const spec = routerSpec();
    spec.nodes[1].config.cases = [
      { when: 'urgent',  to: 'slack' },
      { when: 'billing', to: 'quiet' },   // ← now shares the quiet lane
      { when: '*',       to: 'quiet' },
    ];
    const inv = laneInventoryOf(spec);
    assert.equal(inv.length, 2, 'two distinct targets ⇒ two lanes');

    // One sample down `quiet` covers it however it got there.
    const cov = laneCoverage(spec, [evalOf(spec, run('billing', 'quiet'))]);
    assert.equal(cov.uncovered.length, 1);
    assert.equal(cov.uncovered[0].label, 'urgent');
  });

  test('the lane taken is read from the branch\'s OWN output, not re-matched here', () => {
    // Deliberately contradictory: the classifier said "urgent" but the branch
    // recorded routing to `quiet`. The engine's record must win — anything else
    // means this file holds a second copy of branch.run()'s selection rule.
    const spec = routerSpec();
    const contradictory = {
      completed: true, error: null, deliveries: [],
      steps: [
        { nodeId: 'classify', output: 'urgent' },
        { nodeId: 'route',    output: { value: 'urgent', matched: '*', to: 'quiet', viaCatchAll: true } },
      ],
    };
    const cov = laneCoverage(spec, [evalOf(spec, contradictory)]);
    const uncovered = cov.uncovered.map(l => l.label).sort();
    assert.deepEqual(uncovered, ['billing', 'urgent'],
      'the `quiet` lane is the covered one, because that is where the engine says it went');
  });

  test('TWO branches are counted separately — a lane is (branch, target), not target alone', () => {
    // Found by mutating `laneKey` to drop the branch: it SURVIVED the rest of this
    // file, because every other fixture has one branch. Two-branch specs are the
    // norm on the highest-stakes shape — the approval workflow routes on the
    // classifier AND on the human's decision — and both branches here have a lane
    // pointing at a target of the same name. Keyed on the target alone, covering
    // `stop` in one branch silently marks `stop` covered in the other, and half
    // the router is certified on a sample that never went near it.
    const spec = {
      version: 2,
      outcome: { statement: 'Support mail is drafted, approved, and sent.', assertions: [] },
      nodes: [
        { id: 'classify', type: 'llm',    config: { mode: 'classify', categories: 'support\nother' } },
        { id: 'routeA',   type: 'branch', config: { on: '{{classify.output}}', cases: [
            { when: 'support', to: 'draft' }, { when: '*', to: 'stop' } ] } },
        { id: 'draft',    type: 'llm',    config: { mode: 'freeform', prompt: 'draft' } },
        { id: 'ask',      type: 'human',  config: { prompt: 'send?', decisions: ['approve', 'reject'],
                                                    channels: ['inbox'], timeout: { after: '24h', then: 'reject' } } },
        { id: 'routeB',   type: 'branch', config: { on: '{{ask.decision}}', cases: [
            { when: 'approve', to: 'send' }, { when: '*', to: 'stop' } ] } },
        { id: 'send',     type: 'deliver',  config: { channel: 'slack', target: '#c' } },
        { id: 'stop',     type: 'assemble', label: 'Stop', config: { content: '' } },
      ],
      edges: [],
    };

    // Four lanes, not three: routeA→stop and routeB→stop are DIFFERENT lanes.
    assert.equal(laneInventoryOf(spec).length, 4);

    // A run that classified `other` and stopped: only routeA's catch-all is covered.
    const r = evaluateDeliveryRun(spec, { id: 'e1' }, {
      completed: true, error: null, deliveries: [],
      steps: [
        { nodeId: 'classify', output: 'other' },
        { nodeId: 'routeA',   output: { value: 'other', matched: '*', to: 'stop', viaCatchAll: true } },
      ],
    });
    const cov = laneCoverage(spec, [r]);
    assert.equal(cov.covered, 1, 'exactly one lane was taken');
    assert.equal(cov.uncovered.length, 3);
    // routeB's stop lane must STILL be uncovered — nothing reached the approval at all.
    assert.ok(cov.uncovered.some(l => l.branch === 'routeB' && l.to === 'stop'),
      'the second branch\'s stop lane is its own lane and was never exercised');
  });

  test('the catch-all lane is named readably when it has no case values of its own', () => {
    const spec = routerSpec();
    const inv = laneInventoryOf(spec);
    const quiet = inv.find(l => l.to === 'quiet');
    assert.ok(quiet, 'the catch-all target is a lane like any other');
    // Falls back to the target node's label rather than printing "*".
    assert.equal(quiet.label, 'Do nothing');
    assert.ok(!quiet.label.includes('*'), 'the DMN catch-all marker is not user-facing language');
  });
});
