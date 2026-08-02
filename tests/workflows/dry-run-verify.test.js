/**
 * `runSpecDryRun` — the engine-only core of the converger's self-verification loop.
 * (Increment #23.)
 *
 * The converger's `verify` node runs its own draft through THIS function to prove the
 * workflow works before handing off. The one non-negotiable property: it runs in
 * DRY-RUN mode, so no matter how many fix-retries the loop takes, it causes ZERO real
 * side effects — no email, no record, no Slack post. These tests pin exactly that, by
 * running a real FlowTester with a RECORDING delivery registry that MUST stay empty.
 *
 * THE MUTATION GUARD: `runSpecDryRun` always sets `dryRunDeliveries: true`. Remove or
 * flip that flag in the source and `sent` fills — a real delivery fires — and the
 * first test here goes red. That is the whole safety of the loop, pinned.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { runSpecDryRun }            from '../../src/workflows/dry-run-runner.js';
import { FlowTester }               from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const CONTENT   = 'Q3 shipped 14 features and revenue grew 9%.';

/** A registry that RECORDS every real handler invocation — must stay empty in dry mode. */
function recordingRegistry() {
  const sent = [];
  const registry = {
    get: (id) => ({ id, available: true }),
    getHandler: (id) => async (args) => { sent.push({ channel: id, body: args.body }); return { delivered: true, ts: `${id}-1.1` }; },
  };
  return { registry, sent };
}

function tester(registry) {
  return new FlowTester({ nodeTypes, channelRegistry: registry, llm: { invoke: async () => ({ content: CONTENT }) } });
}

/** summarize → deliver(slack), with an outcome promising the Slack post. */
const spec = () => ({
  name: 'Summarize and post', version: 2, triggers: [{ type: 'email' }],
  outcome: { statement: 'Every report is posted to #ops.',
             assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] },
  nodes: [
    { id: 'sum', type: 'llm',     label: 'Summarize', config: { mode: 'summarize' } },
    { id: 'd',   type: 'deliver', label: 'Slack',     config: { channel: 'slack', target: '#ops' } },
  ],
  edges: [{ from: 'sum', to: 'd' }],
});

// ── RE-POINTED 2026-08-02 ───────────────────────────────────────────────────
// The verdict this module produces stopped being "does a delivery's destination
// match the promise's `target` string" and became "did every step complete, and
// did every delivery land" (src/workflows/delivery-verdict.js — read its header
// for what was removed and why).
//
// THE SAFETY PROPERTY IS UNTOUCHED and is still the reason this file exists: a
// dry run must fire ZERO real handlers, however many times the loop iterates.
// Every test below still asserts it, and it is asserted first.
//
// What changed in each case is named inline. Nothing here was made more lenient
// to accommodate the new rule: the case that used to be caught by "the promise
// names #ops and nothing reached it" is now caught by "this run attempted no
// deliveries at all", which is a stronger statement about the same workflow —
// it does not depend on the promise being written correctly.
describe('runSpecDryRun causes ZERO real side effects and judges the outcome', () => {
  test('the real delivery handler is NEVER called, yet the run is judged KEPT', async () => {
    const { registry, sent } = recordingRegistry();
    const r = await runSpecDryRun({ flowTester: tester(registry), spec: spec(), initialContext: 'raw inbound email' });

    // THE SAFETY PROPERTY: not one real send, even though the workflow "delivered".
    assert.equal(sent.length, 0, 'a dry-run must not fire the real delivery handler — the loop causes no real side effects');

    // The processing step ran for real, so there is a real body to judge.
    assert.equal(r.completed, true);
    assert.equal(r.error, null);

    // The would-deliver receipt was assembled and judged as would-satisfy.
    assert.equal(r.deliveries.length, 1, 'the stubbed delivery is surfaced as a would-deliver receipt');
    assert.equal(r.deliveries[0].delivered, true, 'a would-deliver receipt reads as satisfied for the oracle');
    assert.ok(r.oracleResult, 'a run gets a verdict');
    assert.equal(r.oracleResult.verdict, 'kept', 'summarize→#ops ran and would have delivered');
    assert.equal(r.oracleResult.attempted, 1, 'one delivery was attempted');
    assert.equal(r.oracleResult.delivered, 1, 'and it would have landed');
    assert.deepEqual(r.oracleResult.missed, [], 'nothing fell short');
  });

  test('a workflow that delivers NOTHING attempts nothing — and that is what the caller gates on', async () => {
    // The outcome promises a Slack post, but the workflow only summarizes — nothing
    // delivers. A real run would send nothing.
    //
    // WHAT CHANGED, AND WHY IT IS NOT A WEAKENING. This used to assert
    // `contractPassed === false` because the promise named `slack:#ops` and no
    // delivery matched that string. The verdict no longer reads the promise at
    // all, so per-run this is `kept` — it ran cleanly and everything it tried to
    // send (nothing) landed. The defect is caught one level up, by `attempted`:
    // the panel and the chat sentence both refuse to certify a set in which NO
    // delivery was attempted anywhere (public/index.html `_finishRun`,
    // run-summary.js `derived`).
    //
    // That is a STRONGER catch than the old one, not a looser one: it does not
    // depend on the promise having been written correctly. The old check passed a
    // workflow that delivered nowhere whenever the promise was ALSO wrong in a
    // matching way, and failed workflows that delivered correctly whenever the
    // promise's string merely differed.
    const { registry, sent } = recordingRegistry();
    const broken = spec();
    broken.nodes = [broken.nodes[0]];   // drop the delivery
    broken.edges = [];
    const r = await runSpecDryRun({ flowTester: tester(registry), spec: broken, initialContext: 'raw' });

    assert.equal(sent.length, 0, 'still no real send');
    assert.equal(r.oracleResult.attempted, 0, 'a workflow with no delivery node attempts no deliveries');
    assert.deepEqual(r.oracleResult.landed, [], 'and nothing landed, so there is nothing to certify on');
  });

  test('a spec with no outcome is judged too — every run answers "did it deliver?"', async () => {
    // DELIBERATELY REVERSED 2026-08-02. This used to assert `oracleResult === null`
    // for a spec with no contract, because there were no assertions to score. "Did
    // every step complete and did every delivery land" is answerable for ANY spec,
    // promises or none — and returning nothing was what left the panel with no
    // evidence to show for such a workflow.
    const { registry, sent } = recordingRegistry();
    const bare = spec(); delete bare.outcome;
    const r = await runSpecDryRun({ flowTester: tester(registry), spec: bare, initialContext: 'raw' });
    assert.equal(sent.length, 0, 'still no real send');
    assert.ok(r.oracleResult, 'a spec with no contract is still judged on what it did');
    assert.equal(r.oracleResult.verdict, 'kept');
    assert.equal(r.oracleResult.attempted, 1, 'it delivered, and that is the evidence');
    assert.equal(r.completed, true, 'the run itself still completes');
  });
});
