/**
 * Dry-run execution mode (increment #21) — the execution agent runs the LOGIC for
 * real but VERIFIES terminal side-effect nodes instead of FIRING them.
 *
 * WHY IT EXISTS: increment #23 turns the converger into a coding agent that runs
 * its own draft through this engine to prove it works before handing off. An agent
 * that iterates must not cause real side effects while it loops — no real emails,
 * no records written, no Slack posts — or it spams real deliveries on every
 * fix-retry. Dry-run mode is the safe loop: processing nodes run for real (their
 * output is needed to verify the chain), and every terminal delivery is stubbed
 * into a "would-deliver" receipt.
 *
 * WHAT THESE TESTS PIN (and the failure each guards):
 *   • a `deliver` / writing `connector-action` does NOT call the real handler in
 *     dry mode — 0 calls — and returns a receipt with the four checks;
 *   • processing nodes DO run for real, so the body IS computed and checkable;
 *   • an ill-formed delivery (empty body, unresolved {{template}}) → wouldDeliver
 *     false with the FAILING CHECK NAMED;
 *   • the outcome oracle reads a would-deliver receipt as "would-satisfy" for a
 *     message_sent / record_exists assertion — and a wouldDeliver:false one as NOT
 *     satisfied;
 *   • THE MUTATION GUARD: with the flag OFF (default), the real handler IS called —
 *     delivery fires. Flip the gate (make it always-dry) and this test goes red.
 *     Without it, "dry mode stubs the send" could be implemented as "the send never
 *     fires", byte-for-byte breaking every real run, and the suite would stay green.
 */

import { test, describe }  from 'node:test';
import assert              from 'node:assert/strict';

import { FlowTester, isTerminalSideEffect } from '../../src/workflows/flow-tester.js';
import { NodeTypeRegistry }                 from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes }         from '../../src/workflows/node-types/index.js';
import {
  normalizeDelivery,
  checkAssertionAtRuntime,
  isDeliveryNode,
} from '../../src/workflows/outcome-oracle.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const CONTENT = 'Q3 shipped 14 features and revenue grew 9%.';

/**
 * A channel registry that RECORDS every handler invocation. In dry mode the
 * dry-run interception swaps this handler for a capturing stub, so `sent` must
 * stay empty; in real mode it fills, which is exactly what the mutation guard
 * checks.
 */
function recordingRegistry() {
  const sent = [];
  const registry = {
    get: (id) => ({ id, available: true }),
    getHandler: (id) => async (args) => {
      sent.push({ channel: id, body: args.body });
      return { delivered: true, ts: `${id}-1728000000.0001` };  // a receipt, not content
    },
  };
  return { registry, sent };
}

function tester(registry, extra = {}) {
  return new FlowTester({
    nodeTypes,
    channelRegistry: registry,
    llm: { invoke: async () => ({ content: CONTENT }) },
    ...extra,
  });
}

async function runAll(t, flow, options = {}) {
  const events = [];
  for await (const e of t.run(flow, options)) events.push(e);
  return events;
}

const outputOf = (events, nodeId) => {
  const ev = events.find(e => e.type === 'step_completed' && e.nodeId === nodeId);
  if (!ev) return undefined;
  if (typeof ev.output !== 'string') return ev.output;
  try { return JSON.parse(ev.output); } catch { return ev.output; }  // a plain-string llm output
};

// ── Fixtures ────────────────────────────────────────────────────────────────

/** summarize → deliver(slack). One content step feeding one terminal delivery. */
const slackDeliverySpec = () => ({
  name: 'Summarize and post', version: 2, triggers: [{ type: 'email' }],
  outcome: {
    statement: 'Every report is posted to #ops.',
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }],
  },
  nodes: [
    { id: 'sum', type: 'llm',     label: 'Summarize', config: { mode: 'summarize' } },
    { id: 'd',   type: 'deliver', label: 'Slack',     config: { channel: 'slack', target: '#ops' } },
  ],
  edges: [{ from: 'sum', to: 'd' }],
});

/** extract → connector-action(airtable_create_record). A writing connector-action. */
const airtableWriteSpec = () => ({
  name: 'Create a lead', version: 2, triggers: [{ type: 'email' }],
  outcome: {
    statement: 'Every lead becomes a record.',
    assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:tblLeads' }],
  },
  nodes: [
    { id: 'ex', type: 'llm', label: 'Extract', config: { mode: 'extract', fields: 'name' } },
    { id: 'cr', type: 'connector-action', label: 'Create record',
      config: { action: 'airtable_create_record', baseId: 'appX', tableId: 'tblLeads', fields: '{"Name":"{{ex.name}}"}' } },
  ],
  edges: [{ from: 'ex', to: 'cr' }],
});

// ── 1. Terminal classification (the discriminator this whole mode rides on) ───

describe('isTerminalSideEffect — what gets stubbed vs run for real', () => {
  test('a deliver node and a WRITING connector-action are terminal', () => {
    assert.equal(isTerminalSideEffect({ type: 'deliver', config: { channel: 'slack' } }), true);
    assert.equal(isTerminalSideEffect({ type: 'connector-action', config: { action: 'airtable_create_record' } }), true);
    assert.equal(isTerminalSideEffect({ type: 'connector-action', config: { action: 'gmail_send' } }), true);
  });

  test('READ-only connector-actions are NOT terminal — they run for real', () => {
    // gmail_get_message trips the oracle's isDeliveryNode (via the "_message"
    // suffix) but is correctly a READ here — the reason we classify off the
    // validator's isWriteNode, not isDeliveryNode.
    for (const action of ['gmail_get_message', 'web_search', 'web_fetch',
                          'airtable_list_bases', 'sheets_describe', 'filesystem_read']) {
      assert.equal(isTerminalSideEffect({ type: 'connector-action', config: { action } }), false, action);
    }
  });

  test('a foreach is NOT terminal — it loops for real; its inner writes are stubbed per-substep', () => {
    const loop = { type: 'foreach', config: { steps: [{ type: 'connector-action', config: { action: 'airtable_create_record' } }] } };
    assert.equal(isTerminalSideEffect(loop), false);
  });

  test('processing nodes are never terminal', () => {
    for (const type of ['trigger', 'llm', 'assemble', 'branch', 'decision', 'human']) {
      assert.equal(isTerminalSideEffect({ type, config: {} }), false, type);
    }
  });
});

// ── 2. Dry mode stubs the send; processing nodes run for real ─────────────────

describe('dry-run mode — deliver is verified, not fired', () => {
  test('the real handler is NOT called, and a would-deliver receipt is returned', async () => {
    const { registry, sent } = recordingRegistry();
    const events = await runAll(tester(registry), slackDeliverySpec(),
      { dryRunDeliveries: true, initialContext: 'raw inbound email' });

    assert.equal(sent.length, 0, 'the real delivery handler must not be invoked in dry mode');

    const receipt = outputOf(events, 'd');
    assert.equal(receipt.dryRun, true);
    assert.equal(receipt.wouldDeliver, true);
    assert.equal(receipt.channel, 'slack');
    assert.equal(receipt.target, '#ops');
    assert.deepEqual(receipt.checks,
      { hasBody: true, bodyWellFormed: true, targetPresent: true, capabilityConnected: true });
    // The body was actually computed from the upstream content step (proves the
    // processing chain ran for real), and appears in the preview.
    assert.ok(receipt.contentPreview.includes('Q3'), 'the preview is the real computed body');
  });

  test('the processing step DID run for real (its output is present and real)', async () => {
    const { registry } = recordingRegistry();
    const events = await runAll(tester(registry), slackDeliverySpec(),
      { dryRunDeliveries: true, initialContext: 'raw inbound email' });
    const sumOut = outputOf(events, 'sum');
    // The llm node genuinely executed and produced the summary that then fed the
    // (stubbed) delivery — dry mode does not short-circuit processing.
    assert.ok(JSON.stringify(sumOut).includes('Q3'));
    assert.ok(events.some(e => e.type === 'run_completed'));
  });

  test('a WRITING connector-action is stubbed too (0 handler calls, would-write receipt)', async () => {
    const { registry, sent } = recordingRegistry();
    const events = await runAll(tester(registry), airtableWriteSpec(),
      { dryRunDeliveries: true, initialContext: 'raw', tenantId: 't1', workflowId: 'w1' });

    assert.equal(sent.length, 0, 'a writing connector-action must not fire in dry mode');
    const receipt = outputOf(events, 'cr');
    assert.equal(receipt.dryRun, true);
    assert.equal(receipt.wouldDeliver, true);
    assert.equal(receipt.channel, 'airtable_create_record');
    assert.equal(receipt.checks.targetPresent, true);   // baseId + tableId present
  });

  test('a writing connector-action INSIDE a foreach is stubbed per item (loop runs for real)', async () => {
    const { registry, sent } = recordingRegistry();
    const spec = {
      name: 'Bulk create', version: 2, triggers: [{ type: 'email' }],
      nodes: [{
        id: 'loop', type: 'foreach',
        config: {
          over: '[{"a":1},{"a":2},{"a":3}]',
          steps: [{ id: 'w', type: 'connector-action',
            config: { action: 'airtable_create_record', baseId: 'appX', tableId: 'tbl', fields: '{"A":"{{item}}"}' } }],
        },
      }],
      edges: [],
    };
    const events = await runAll(tester(registry), spec,
      { dryRunDeliveries: true, tenantId: 't1', workflowId: 'w1' });

    assert.equal(sent.length, 0, 'the inner write must be stubbed on every iteration');
    const loop = outputOf(events, 'loop');
    assert.equal(loop.count, 3, 'the loop itself ran for real, 3 iterations');
    assert.equal(loop.results[0].dryRun, true);
    assert.equal(loop.results[0].wouldDeliver, true);
  });
});

// ── 3. Ill-formed deliveries name the failing check ───────────────────────────

describe('dry-run mode — an ill-formed delivery does not "would-deliver"', () => {
  test('empty body → wouldDeliver:false, hasBody named', async () => {
    const { registry, sent } = recordingRegistry();
    // Standalone deliver, no upstream content, no static body — deliver.js has
    // nothing to send. Dry mode records that as a failed check, not a thrown run.
    const spec = {
      name: 'Empty', version: 2, triggers: [{ type: 'email' }],
      nodes: [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }],
      edges: [],
    };
    const events = await runAll(tester(registry), spec, { dryRunDeliveries: true });
    assert.equal(sent.length, 0);
    const receipt = outputOf(events, 'd');
    assert.equal(receipt.wouldDeliver, false);
    assert.equal(receipt.checks.hasBody, false, 'the empty body is the named failing check');
  });

  test('an unresolved {{template}} in the body → wouldDeliver:false, bodyWellFormed named', async () => {
    const { registry } = recordingRegistry();
    const spec = {
      name: 'Leaky', version: 2, triggers: [{ type: 'email' }],
      nodes: [
        { id: 'sum', type: 'llm',     config: { mode: 'summarize' } },
        // {{missing}} is a single-token reference _substitute cannot bind, so it
        // survives into the delivered body — the leaked-template failure the real
        // oracle also guards.
        { id: 'd',   type: 'deliver', config: { channel: 'slack', target: '#ops', body: 'Report: {{missing}}' } },
      ],
      edges: [{ from: 'sum', to: 'd' }],
    };
    const events = await runAll(tester(registry), spec, { dryRunDeliveries: true, initialContext: 'raw' });
    const receipt = outputOf(events, 'd');
    assert.equal(receipt.wouldDeliver, false);
    assert.equal(receipt.checks.hasBody, true);
    assert.equal(receipt.checks.bodyWellFormed, false, 'the unresolved template is the named failing check');
  });

  test('an unconnected/unresolved capability → wouldDeliver:false, capabilityConnected named', async () => {
    // A registry where the channel is not ready. capabilityConnected reads the
    // REAL availability, so the check fails even though the body computes.
    const registry = {
      get: (id) => ({ id, available: false, unavailableReason: 'not connected' }),
      getHandler: () => async () => { throw new Error('should not be called'); },
    };
    const events = await runAll(tester(registry), slackDeliverySpec(),
      { dryRunDeliveries: true, initialContext: 'raw' });
    const receipt = outputOf(events, 'd');
    assert.equal(receipt.wouldDeliver, false);
    assert.equal(receipt.checks.capabilityConnected, false);
  });
});

// ── 4. The outcome oracle reads a dry receipt in a "would-satisfy" sense ───────

describe('outcome oracle — would-satisfy from a dry receipt', () => {
  test('a would-deliver receipt satisfies a message_sent assertion (no real send)', async () => {
    const { registry } = recordingRegistry();
    const spec = slackDeliverySpec();
    const events = await runAll(tester(registry), spec, { dryRunDeliveries: true, initialContext: 'raw' });
    const receipt = outputOf(events, 'd');

    // Same assembly the run entrypoint uses: build a delivery from the node + the
    // (dry) output, then ask the oracle.
    const node = spec.nodes.find(n => n.id === 'd');
    assert.equal(isDeliveryNode(node), true);
    const delivery = normalizeDelivery(node, receipt);
    assert.equal(delivery.delivered, true, 'wouldDeliver:true maps to delivered:true');

    const verdict = checkAssertionAtRuntime(spec.outcome.assertions[0], [delivery]);
    assert.equal(verdict.ok, true, 'the assertion would be satisfied');
  });

  test('a would-deliver record_exists receipt satisfies a record assertion', async () => {
    const { registry } = recordingRegistry();
    const spec = airtableWriteSpec();
    const events = await runAll(tester(registry), spec,
      { dryRunDeliveries: true, initialContext: 'raw', tenantId: 't1', workflowId: 'w1' });
    const receipt = outputOf(events, 'cr');
    const node = spec.nodes.find(n => n.id === 'cr');
    const delivery = normalizeDelivery(node, receipt);
    const verdict = checkAssertionAtRuntime(spec.outcome.assertions[0], [delivery]);
    assert.equal(verdict.ok, true);
  });

  test('a wouldDeliver:FALSE receipt does NOT satisfy the assertion', () => {
    // The would-satisfy path must not weaken the real check: a receipt that would
    // NOT have delivered must read as not-delivered, so the assertion fails.
    const node = { type: 'deliver', config: { channel: 'slack', target: '#ops' } };
    const bad = normalizeDelivery(node, { dryRun: true, wouldDeliver: false, channel: 'slack', checks: {} });
    assert.equal(bad.delivered, false);
    const verdict = checkAssertionAtRuntime({ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }, [bad]);
    assert.equal(verdict.ok, false);
  });

  test('a REAL delivery (no dryRun flag) is unchanged — still delivered:true', () => {
    // normalizeDelivery's would-satisfy branch is inert for real handler returns.
    const node = { type: 'deliver', config: { channel: 'slack', target: '#ops' } };
    const real = normalizeDelivery(node, { delivered: true, ts: '1728.1' });
    assert.equal(real.delivered, true);
  });
});

// ── 5. THE MUTATION GUARD — default OFF fires the real delivery ────────────────

describe('default mode is unchanged — the flag actually gates the stub', () => {
  test('WITHOUT the flag, the real handler IS called and the delivery fires', async () => {
    const { registry, sent } = recordingRegistry();
    const events = await runAll(tester(registry), slackDeliverySpec(),
      { initialContext: 'raw inbound email' });   // no dryRunDeliveries

    // This is the gate. If dry-run were always on (the gate inverted or dropped),
    // sent would be empty and this goes red — proving the flag, not a coincidence.
    assert.equal(sent.length, 1, 'the real delivery must fire when dry-run is OFF');
    assert.ok(sent[0].body.includes('Q3'), 'the real body was sent');

    const out = outputOf(events, 'd');
    assert.notEqual(out?.dryRun, true, 'a real run returns a real receipt, not a dry one');
  });

  test('the constructor default is OFF (a plain tester fires deliveries)', async () => {
    const { registry, sent } = recordingRegistry();
    // No dryRunDeliveries in the constructor and none per-run.
    await runAll(tester(registry), slackDeliverySpec(), { initialContext: 'raw' });
    assert.equal(sent.length, 1);
  });

  test('a per-run flag overrides an OFF constructor default', async () => {
    const { registry, sent } = recordingRegistry();
    const t = new FlowTester({
      nodeTypes, channelRegistry: registry,
      llm: { invoke: async () => ({ content: CONTENT }) },
      dryRunDeliveries: false,
    });
    await runAll(t, slackDeliverySpec(), { dryRunDeliveries: true, initialContext: 'raw' });
    assert.equal(sent.length, 0, 'per-run dry-run wins over the constructor default');
  });
});
