/**
 * Branch-aware runtime oracle — ADVERSARIAL FINDINGS (test-adversary, #34).
 *
 * These are the two cases where the branch-aware SKIP can let a run that delivered
 * nothing self-test as PASSED. Read the reachability note on each: one is a latent
 * fragility NOT reachable through the production caller, the other is a
 * contract-COVERAGE property (correct-by-design for the oracle, a gap for the
 * converger). Neither is added to the gate or the sweep — a RED test in a swept
 * suite would corrupt the sweep baseline.
 *
 * ── FINDING 1 (RED): union-based `taken` conflates branches ───────────────────
 *
 * `runRouteInfo` builds ONE `taken` set as the union over ALL branches, with no
 * per-branch attribution. `assertionApplicability` then skips a conditional whose
 * `when` is not in that global set. So if branch B2's route value is absent from
 * `taken` while branch B1's is present, an assertion gated on B2 is skipped because
 * B1 took a DIFFERENT value — violating the stated guard "skip ONLY when a
 * *different* route was positively read" (the different route read belongs to a
 * different branch). If B2's lane delivered nothing, the run FALSE-PASSES.
 *
 * REACHABILITY: LOW / not through the production caller. server.js:2261 passes the
 * FULL `steps` array, and the engine records a step for every executed node, so an
 * executed branch source is always present and normalises to a non-empty value
 * (classify→string, decision→.value, human→.decision). This test reproduces the
 * hole by omitting B2's source step from `steps` — a shape a real run does not
 * produce. It is a RESIDUAL (a fragility in `runRouteInfo`'s union, not a
 * user-reachable silent defect), left RED to document the gap. The fix is to track
 * `taken` PER BRANCH and match a conditional only against its own branch's route.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { evaluateExampleRun, runRouteInfo } from '../../src/workflows/outcome-oracle.js';

const verdict = (r, id) => r.contract.find(c => c.id === id);

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

describe('FINDING 1 (RED, low-reachability residual): union `taken` masks a broken lane in another branch', () => {
  test('b2 took paid (gmail broken) but its source is absent from taken; b1 took urgent → a2 is wrongly SKIPPED', () => {
    // b1's source (c1=urgent) IS recorded; b2's source (c2=paid) is NOT — so `taken`
    // is {urgent} only. The engine still routed b2→paid→s3 (gmail), which delivered
    // nothing. The oracle should ENFORCE a2 (its lane was active) and FAIL.
    const run = {
      completed: true, error: null,
      deliveries: [{ delivered: true, channel: 'slack', target: '#support' }],   // gmail lane missing
      steps: [
        { nodeId: 'c1', output: 'urgent' },
        // c2 output intentionally absent (the reproducing condition)
        { nodeId: 's1', output: { delivered: true, channel: 'slack', target: '#support' } },
        { nodeId: 's3', output: { delivered: true, channel: 'gmail_send', to: 'vip@acme.com', dryRun: true, wouldDeliver: false } },
      ],
    };
    const info = runRouteInfo(twoBranchSpec(), run);
    assert.deepEqual([...info.taken], ['urgent'], 'reproduces the condition: b2 route not captured');

    const r = evaluateExampleRun(twoBranchSpec(), { given: {} }, run);
    // CORRECT behaviour: a2's paid lane was active and delivered nothing → must fail.
    // CURRENT behaviour: a2 is skipped (paid not in the global `taken`) → false pass.
    assert.equal(verdict(r, 'a2').skipped, undefined,
      'a2 must NOT be skipped — its lane (paid) was active and its gmail delivery is missing');
    assert.equal(r.contractPassed, false,
      'a run whose paid lane delivered nothing must not self-test as contract-kept');
  });
});

/**
 * ── FINDING 2 (GREEN, documented): all-conditional, none-match ⇒ vacuous pass ─
 *
 * If the taken route matches NO assertion's `when` (the contract does not cover
 * that lane), every conditional assertion is skipped and the example passes even
 * if the lane delivered nothing. This is correct FOR THE ORACLE — you cannot break
 * a promise you never made — but it means an under-covered contract (a lane with
 * no assertion) hides a broken lane. The converger's coverage-gap analysis is what
 * must guarantee every lane carries an assertion; the runtime oracle cannot. Pinned
 * GREEN to lock the behaviour and name the boundary. If the converger ever ships a
 * spec whose branch has a lane no assertion covers, THIS is the silent hole.
 */
describe('FINDING 2 (documented): a taken lane no assertion covers ⇒ vacuous pass', () => {
  function partialSpec() {
    return {
      version: 2,
      outcome: { assertions: [
        { id: 'a1', kind: 'message_sent', target: 'slack:#support', when: 'urgent' },
        { id: 'a2', kind: 'message_sent', target: 'slack:#sales',   when: 'billing' },
        // NO assertion for the `general` / catch-all lane.
      ] },
      nodes: [
        { id: 'triage', type: 'llm', config: { mode: 'classify', categories: ['urgent', 'billing', 'general'], instructions: 'x' } },
        { id: 'route', type: 'branch', config: { on: 'triage.output', cases: [
          { when: 'urgent', to: 's1' }, { when: 'billing', to: 's2' }, { when: '*', to: 's3' } ] } },
        { id: 's1', type: 'deliver', config: { channel: 'slack', target: '#support' } },
        { id: 's2', type: 'deliver', config: { channel: 'slack', target: '#sales' } },
        { id: 's3', type: 'deliver', config: { channel: 'inbox_deliver', subject: 'x' } },
      ],
      edges: [],
    };
  }

  test('classified "general", delivered NOTHING, still passes — because no assertion covers general', () => {
    const run = { completed: true, error: null, deliveries: [],
      steps: [{ nodeId: 'triage', output: 'general' }, { nodeId: 'route', output: { value: 'general', matched: '*', to: 's3' } }] };
    const r = evaluateExampleRun(partialSpec(), { given: {} }, run);
    assert.equal(verdict(r, 'a1').skipped, true);
    assert.equal(verdict(r, 'a2').skipped, true);
    // DOCUMENTED current behaviour: vacuous pass. This is the oracle's floor, not a
    // guarantee the workflow delivered — the converger must cover every lane.
    assert.equal(r.contractPassed, true,
      'the oracle keeps a contract it made no promise about; coverage is the converger\'s job');
  });
});
