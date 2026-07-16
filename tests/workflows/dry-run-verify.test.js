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

describe('runSpecDryRun causes ZERO real side effects and judges the outcome', () => {
  test('the real delivery handler is NEVER called, yet the outcome is judged SATISFIED', async () => {
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
    assert.ok(r.oracleResult, 'a spec with an outcome gets an oracle verdict');
    assert.equal(r.oracleResult.contractPassed, true, 'summarize→#ops keeps its promise on the sample (in dry mode)');
  });

  test('a spec whose promise it does NOT keep is judged FAILED (the loop can tell)', async () => {
    // The outcome promises a Slack post, but the workflow only summarizes — nothing
    // delivers. A real run would send nothing; the dry-run must report contractPassed
    // false so the verify loop knows to fix it (never a false pass).
    const { registry, sent } = recordingRegistry();
    const broken = spec();
    broken.nodes = [broken.nodes[0]];   // drop the delivery
    broken.edges = [];
    const r = await runSpecDryRun({ flowTester: tester(registry), spec: broken, initialContext: 'raw' });

    assert.equal(sent.length, 0, 'still no real send');
    assert.equal(r.oracleResult.contractPassed, false, 'a promise the workflow does not keep must be judged FAILED');
    assert.ok(/nothing reached/i.test(r.oracleResult.contract.find(c => !c.ok)?.reason ?? ''),
      'and the oracle names WHY — nothing reached the promised destination');
  });

  test('no outcome ⇒ no verdict (the caller passes it through untested)', async () => {
    const { registry } = recordingRegistry();
    const bare = spec(); delete bare.outcome;
    const r = await runSpecDryRun({ flowTester: tester(registry), spec: bare, initialContext: 'raw' });
    assert.equal(r.oracleResult, null, 'with no contract there is nothing to judge — oracleResult is null');
    assert.equal(r.completed, true, 'the run itself still completes');
  });
});
