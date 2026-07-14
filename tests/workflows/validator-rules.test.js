/**
 * The publish gate — every rule, negative AND positive. (Test Adversary, P12-C.)
 *
 * WHY THIS FILE EXISTS
 *
 * `mutation-sweep.mjs` widened its TARGETS to `workflow-validator.js` in Increment
 * C and the survivor list came back damning: essentially the ENTIRE legacy publish
 * gate could be deleted with the suite still green. `if (false)` on MISSING_NAME,
 * EMPTY_WORKFLOW, MALFORMED_NODE, MISSING_NODE_ID, DUPLICATE_NODE_ID,
 * UNKNOWN_NODE_TYPE, MISSING_CONFIG, MISSING_TRIGGER, MISSING_DELIVER,
 * MALFORMED_EDGE, EDGE_BAD_FROM, EDGE_BAD_TO, SELF_LOOP, ORPHAN_NODE,
 * DELIVER_NO_INPUT, CYCLE_DETECTED, UNKNOWN_CHANNEL, CHANNEL_UNAVAILABLE,
 * CHANNEL_MISSING_CONFIG — all survivors. Not one of those rules was pinned by
 * anything. The new C rules were tested; the gate they were bolted onto was not.
 *
 * HOW EACH TEST IS WRITTEN (CLAUDE.md, "a green suite proved nothing four times"):
 *
 *   • EVERY rule gets a POSITIVE case. A validator test that only ever feeds bad
 *     input passes identically if the rule is `if (true)` — and in Increment B a
 *     rule really was rejecting every CORRECT spec behind a green negative-only
 *     test. Each `describe` therefore asserts both "the bad shape is rejected"
 *     and "the good shape is accepted".
 *   • The CONTROL (`the good spec produces no issues at all`) is the load-bearing
 *     one: it is what stops any of these rules from becoming `if (true)`.
 *   • The channel checks run with a REAL-SHAPED channelRegistry, because the
 *     production validator (src/api/server.js:542) is constructed WITH one.
 *     A test that omits it is testing a configuration production never uses.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';

/**
 * A channel registry shaped exactly like the one server.js hands the validator:
 * `get(id) → { id, available, unavailableReason, configSchema }`.
 * `slack_locked` is present-but-not-ready — the CHANNEL_UNAVAILABLE shape.
 */
const CHANNELS = new Map(Object.entries({
  in_app:                 { id: 'in_app',       available: true, configSchema: [] },
  webhook:                { id: 'webhook',      available: true, configSchema: [] },
  slack:                  { id: 'slack',        available: true, configSchema: [{ key: 'target' }] },
  gmail_send:             { id: 'gmail_send',   available: true, configSchema: [{ key: 'to' }, { key: 'subject' }] },
  sheets_append:          { id: 'sheets_append', available: true, configSchema: [{ key: 'spreadsheetId' }, { key: 'range' }] },
  airtable_create_record: { id: 'airtable_create_record', available: true, configSchema: [{ key: 'baseId' }, { key: 'tableId' }, { key: 'fields' }] },
  slack_history:          { id: 'slack_history', available: true, actionOnly: true, configSchema: [{ key: 'target' }] },
  slack_locked:           { id: 'slack_locked', available: false, unavailableReason: 'Slack is not connected', configSchema: [] },
}));
const channelRegistry = { get: (id) => CHANNELS.get(id) ?? null };

const nodeTypes = () => registerBuiltInNodeTypes(new NodeTypeRegistry());
const V  = () => new WorkflowValidator({ nodeTypes: nodeTypes(), channelRegistry });
/** The validator with NO channel registry — the gap-scorer's configuration. */
const Vbare = () => new WorkflowValidator({ nodeTypes: nodeTypes() });

const run    = (def) => V().validate(def);
const codes  = (def) => run(def).issues.map(i => i.code);
const errors = (def) => run(def).errors.map(e => e.code);

/**
 * The CONTROL. A v1 spec (no `version`, no `outcome`) so that the outcome
 * contract stays out of the way and each rule below is isolated.
 */
function base(overrides = {}) {
  return {
    name: 'Daily digest',
    triggers: [{ type: 'schedule', cron: '0 9 * * *' }],
    nodes: [
      { id: 'sum', type: 'llm',     label: 'Summarize', config: { mode: 'summarize', instructions: 'Summarize the mail.' } },
      { id: 'out', type: 'deliver', label: 'Inbox',     config: { channel: 'in_app', title: 'Digest' } },
    ],
    edges: [{ from: 'sum', to: 'out' }],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the control — without this every rule below could be `if (true)`', () => {
  test('a correct spec produces NO issues at all, not even a warning', () => {
    const r = run(base());
    assert.deepEqual(r.issues, [], `a valid spec must be silent; got: ${JSON.stringify(r.issues, null, 2)}`);
    assert.equal(r.ok, true);
  });
});

// ── 1. Top-level shape ───────────────────────────────────────────────────────
describe('MISSING_NAME', () => {
  test('a blank name is rejected', () => {
    assert.ok(errors(base({ name: '   ' })).includes('MISSING_NAME'));
    assert.ok(errors(base({ name: undefined })).includes('MISSING_NAME'));
  });
  test('a name is accepted (positive)', () => {
    assert.equal(errors(base()).includes('MISSING_NAME'), false);
  });
});

describe('EMPTY_WORKFLOW', () => {
  test('no steps is rejected — and nothing else is even checked', () => {
    // The early return matters: a nodeless spec must not also be accused of
    // missing a trigger and a deliver. One clear error, not three confusing ones.
    assert.deepEqual(codes(base({ nodes: [], edges: [] })), ['EMPTY_WORKFLOW']);
  });
  test('a spec with steps is accepted (positive)', () => {
    assert.equal(errors(base()).includes('EMPTY_WORKFLOW'), false);
  });
});

// ── 2. Node-level ────────────────────────────────────────────────────────────
describe('MALFORMED_NODE / MISSING_NODE_ID / DUPLICATE_NODE_ID', () => {
  test('a non-object node is rejected', () => {
    // NOTE: only the STRING case is asserted here. A `null` node makes validate()
    // THROW rather than report MALFORMED_NODE — see FINDING 5 in
    // tests/converger/moat-adversarial.test.js (workflow-validator.js:238).
    const spec = base();
    spec.nodes.push('a step');
    assert.ok(errors(spec).includes('MALFORMED_NODE'));
  });

  test('a node with no id is rejected', () => {
    const spec = base();
    spec.nodes.push({ type: 'llm', config: { mode: 'summarize' } });
    assert.ok(errors(spec).includes('MISSING_NODE_ID'));
  });

  test('a blank id is rejected too — a whitespace id is not an id', () => {
    const spec = base();
    spec.nodes.push({ id: '   ', type: 'llm', config: { mode: 'summarize' } });
    assert.ok(errors(spec).includes('MISSING_NODE_ID'));
  });

  test('two steps sharing an id is rejected', () => {
    const spec = base();
    spec.nodes.push({ id: 'sum', type: 'llm', config: { mode: 'summarize' } });
    const e = errors(spec);
    assert.ok(e.includes('DUPLICATE_NODE_ID'), `got: ${e.join(', ')}`);
  });

  test('distinct ids on well-formed nodes are accepted (positive)', () => {
    const e = errors(base());
    assert.equal(e.includes('MALFORMED_NODE'), false);
    assert.equal(e.includes('MISSING_NODE_ID'), false);
    assert.equal(e.includes('DUPLICATE_NODE_ID'), false);
  });
});

describe('UNKNOWN_NODE_TYPE', () => {
  test('a type no registry knows is rejected, and the message lists what IS allowed', () => {
    const spec = base();
    spec.nodes[0] = { id: 'sum', type: 'wizardry', config: {} };
    const issue = run(spec).issues.find(i => i.code === 'UNKNOWN_NODE_TYPE');
    assert.ok(issue, 'an unsupported type must not be shrugged at');
    assert.match(issue.hint, /llm/, 'the hint must tell the author what they CAN use');
  });
  test('every registered type is accepted (positive)', () => {
    // If UNKNOWN_NODE_TYPE were `if (true)` this would fail on the first type.
    for (const type of nodeTypes().typeIds()) {
      const spec = base({ nodes: [
        { id: 'x', type, config: {} },
        { id: 'out', type: 'deliver', config: { channel: 'in_app' } },
      ], edges: [{ from: 'x', to: 'out' }] });
      assert.equal(errors(spec).includes('UNKNOWN_NODE_TYPE'), false,
        `"${type}" is registered but the validator called it unsupported`);
    }
  });
});

describe('MISSING_CONFIG — the GENERIC required-key loop', () => {
  // This one had NOTHING pinning it. The existing "missing required config" test
  // used an `llm` node whose every schema key is `optional: true` — so the
  // MISSING_CONFIG it observed came from llm's OWN validate() hook, not from the
  // generic loop. `if (false)` on the generic loop left the suite green. The only
  // types with a genuinely required key are deliver.channel, connector-action.action
  // and assemble.title/sections, so the loop has to be exercised through those.
  test('a deliver with no channel is rejected by the generic loop', () => {
    const spec = base();
    spec.nodes[1].config = {};
    const issue = run(spec).issues.find(i => i.code === 'MISSING_CONFIG' && i.field === 'config.channel');
    assert.ok(issue, 'deliver.channel is required by deliver\'s schema and nothing else enforces it');
    assert.equal(issue.nodeId, 'out');
  });

  test('a connector-action with no action is rejected', () => {
    const spec = base();
    spec.nodes[0] = { id: 'sum', type: 'connector-action', config: {} };
    assert.ok(run(spec).issues.some(i => i.code === 'MISSING_CONFIG' && i.field === 'config.action'));
  });

  test('an assemble with no title is rejected', () => {
    const spec = base();
    spec.nodes[0] = { id: 'sum', type: 'assemble',
                      config: { sections: '[{"heading":"h","content":"c"}]' } };
    assert.ok(run(spec).issues.some(i => i.code === 'MISSING_CONFIG' && i.field === 'config.title'));
  });

  test('a whitespace-only required value counts as missing', () => {
    const spec = base();
    spec.nodes[1].config = { channel: '   ' };
    assert.ok(run(spec).issues.some(i => i.code === 'MISSING_CONFIG' && i.field === 'config.channel'));
  });

  test('a fully-configured node is accepted (positive)', () => {
    assert.equal(errors(base()).includes('MISSING_CONFIG'), false);
  });
});

describe('UNKNOWN_CONFIG_KEY is scoped: only `deliver` inherits the CHANNEL\'s keys', () => {
  // The channel-schema union (Increment C) must apply to `deliver` and to nothing
  // else. Widen it to every node type and an `llm` step could quietly carry
  // `target` — a key llm's run() never reads — and the check that exists to catch
  // exactly that ("model": "claude-opus-4-5") stops catching it.
  test('an llm step carrying a CHANNEL\'s key is still rejected for BOTH keys', () => {
    const spec = base();
    spec.nodes[0].config = { mode: 'summarize', channel: 'slack', target: '#ops' };
    const fields = run(spec).issues.filter(i => i.code === 'UNKNOWN_CONFIG_KEY').map(i => i.field).sort();
    assert.deepEqual(fields, ['config.channel', 'config.target'],
      'an llm step reads neither `channel` nor `target`; borrowing slack\'s schema for it would hide `target`');
  });

  test('a deliver DOES inherit the selected channel\'s keys (positive)', () => {
    const spec = base();
    spec.nodes[1].config = { channel: 'sheets_append', spreadsheetId: 'abc', range: 'A:C' };
    assert.equal(errors(spec).includes('UNKNOWN_CONFIG_KEY'), false,
      'sheets_append genuinely reads spreadsheetId/range — rejecting it makes every Sheet delivery unpublishable');
    assert.equal(run(spec).ok, true);
  });

  test('…but a key NO channel declares is still rejected on a deliver', () => {
    const spec = base();
    spec.nodes[1].config = { channel: 'sheets_append', spreadsheetId: 'abc', range: 'A:C', model: 'claude-opus-4-5' };
    const issue = run(spec).issues.find(i => i.code === 'UNKNOWN_CONFIG_KEY');
    assert.ok(issue);
    assert.equal(issue.field, 'config.model');
  });
});

// ── 3. Trigger + deliver presence ────────────────────────────────────────────
describe('MISSING_TRIGGER', () => {
  test('no triggers[] and no trigger node is rejected', () => {
    assert.ok(errors(base({ triggers: [] })).includes('MISSING_TRIGGER'));
    assert.ok(errors(base({ triggers: undefined })).includes('MISSING_TRIGGER'));
  });
  test('a triggers[] entry satisfies it (positive)', () => {
    assert.equal(errors(base()).includes('MISSING_TRIGGER'), false);
  });
  test('a trigger NODE also satisfies it, with no triggers[] (positive)', () => {
    // Both encodings are legal — demanding the node shape wrongly rejected every
    // runnable event/email spec (CLAUDE.md, P4 salvage edit).
    const spec = base({ triggers: [] });
    spec.nodes.unshift({ id: 'trig', type: 'trigger', config: { time: '09:00' } });
    spec.edges.unshift({ from: 'trig', to: 'sum' });
    assert.equal(errors(spec).includes('MISSING_TRIGGER'), false);
  });
});

describe('MISSING_DELIVER', () => {
  test('a workflow with no destination is rejected', () => {
    const spec = base({ nodes: [{ id: 'sum', type: 'llm', config: { mode: 'summarize' } }], edges: [] });
    assert.ok(errors(spec).includes('MISSING_DELIVER'));
  });
  test('one deliver node satisfies it (positive)', () => {
    assert.equal(errors(base()).includes('MISSING_DELIVER'), false);
  });
});

// ── 4. Edges ─────────────────────────────────────────────────────────────────
describe('MALFORMED_EDGE / EDGE_BAD_FROM / EDGE_BAD_TO / SELF_LOOP', () => {
  test('an edge with no `to` is rejected', () => {
    assert.ok(errors(base({ edges: [{ from: 'sum' }] })).includes('MALFORMED_EDGE'));
  });
  test('an edge that is not an object is rejected', () => {
    assert.ok(errors(base({ edges: ['sum->out'] })).includes('MALFORMED_EDGE'));
  });
  test('an edge from a step that does not exist is rejected', () => {
    assert.ok(errors(base({ edges: [{ from: 'ghost', to: 'out' }] })).includes('EDGE_BAD_FROM'));
  });
  test('an edge to a step that does not exist is rejected', () => {
    assert.ok(errors(base({ edges: [{ from: 'sum', to: 'ghost' }] })).includes('EDGE_BAD_TO'));
  });
  test('a step wired to itself is rejected', () => {
    const spec = base();
    spec.edges.push({ from: 'sum', to: 'sum' });
    assert.ok(errors(spec).includes('SELF_LOOP'));
  });
  test('well-formed edges between real steps are accepted (positive)', () => {
    const e = errors(base());
    for (const c of ['MALFORMED_EDGE', 'EDGE_BAD_FROM', 'EDGE_BAD_TO', 'SELF_LOOP']) {
      assert.equal(e.includes(c), false, `${c} fired on a correct edge`);
    }
  });
});

// ── 5. Reachability ──────────────────────────────────────────────────────────
describe('ORPHAN_NODE / DELIVER_NO_INPUT', () => {
  test('a step connected to nothing warns', () => {
    const spec = base();
    spec.nodes.push({ id: 'lonely', type: 'llm', label: 'Lonely', config: { mode: 'summarize' } });
    const issue = run(spec).issues.find(i => i.code === 'ORPHAN_NODE');
    assert.ok(issue);
    assert.equal(issue.severity, 'warning', 'an orphan does not block publish — it just never runs');
    assert.equal(issue.nodeId, 'lonely');
  });

  test('a connected step does NOT warn (positive)', () => {
    assert.equal(codes(base()).includes('ORPHAN_NODE'), false,
      'every connected step would be called an orphan if this check were `if (true)`');
  });

  test('a deliver with no incoming edge is a hard error — it has nothing to send', () => {
    const spec = base();
    spec.nodes.push({ id: 'out2', type: 'deliver', label: 'Second', config: { channel: 'in_app' } });
    spec.edges.push({ from: 'sum', to: 'out2' });
    assert.equal(errors(spec).includes('DELIVER_NO_INPUT'), false, 'control: it IS wired');

    const spec2 = base();
    spec2.nodes.push({ id: 'out2', type: 'deliver', label: 'Second', config: { channel: 'in_app' } });
    const issue = run(spec2).issues.find(i => i.code === 'DELIVER_NO_INPUT');
    assert.ok(issue, 'a deliver with no input must not publish');
    assert.equal(issue.severity, 'error');
    assert.equal(issue.nodeId, 'out2');
  });

  test('a single-node workflow skips reachability entirely (positive)', () => {
    // nodes.length > 1 — a lone deliver (trigger → deliver, no DAG) is legal.
    const spec = base({
      nodes: [{ id: 'out', type: 'deliver', label: 'Inbox', config: { channel: 'in_app', body: 'ping' } }],
      edges: [],
    });
    const e = errors(spec);
    assert.equal(e.includes('DELIVER_NO_INPUT'), false);
    assert.equal(codes(spec).includes('ORPHAN_NODE'), false);
  });
});

// ── 6. Cycles ────────────────────────────────────────────────────────────────
describe('CYCLE_DETECTED', () => {
  test('a backward edge is rejected', () => {
    const spec = base();
    spec.nodes.push({ id: 'mid', type: 'llm', label: 'Mid', config: { mode: 'summarize' } });
    spec.edges = [{ from: 'sum', to: 'mid' }, { from: 'mid', to: 'out' }, { from: 'out', to: 'sum' }];
    assert.ok(errors(spec).includes('CYCLE_DETECTED'));
  });
  test('a diamond (fan-out then fan-in) is NOT a cycle (positive)', () => {
    // The DFS colours nodes GRAY/BLACK; a naive "already visited" check would
    // call this a cycle and reject a perfectly ordinary parallel DAG.
    const spec = base({
      nodes: [
        { id: 'a', type: 'llm', label: 'A', config: { mode: 'summarize' } },
        { id: 'b', type: 'llm', label: 'B', config: { mode: 'summarize' } },
        { id: 'c', type: 'llm', label: 'C', config: { mode: 'summarize' } },
        { id: 'out', type: 'deliver', label: 'Inbox', config: { channel: 'in_app' } },
      ],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' },
              { from: 'b', to: 'out' }, { from: 'c', to: 'out' }],
    });
    assert.equal(errors(spec).includes('CYCLE_DETECTED'), false);
    assert.equal(run(spec).ok, true);
  });
});

// ── 7. Channels — the checks that only exist when a registry is wired ────────
describe('UNKNOWN_CHANNEL / CHANNEL_UNAVAILABLE / CHANNEL_MISSING_CONFIG', () => {
  test('a channel that is not in the build is rejected', () => {
    const spec = base();
    spec.nodes[1].config = { channel: 'teams_send' };
    const issue = run(spec).issues.find(i => i.code === 'UNKNOWN_CHANNEL');
    assert.ok(issue, 'a hallucinated channel must fail at build time, not at 6am');
    assert.equal(issue.nodeId, 'out');
  });

  test('a registered but NOT READY channel is rejected, and says why', () => {
    const spec = base();
    spec.nodes[1].config = { channel: 'slack_locked' };
    const issue = run(spec).issues.find(i => i.code === 'CHANNEL_UNAVAILABLE');
    assert.ok(issue);
    assert.match(issue.message, /not connected/, 'the reason from the registry must reach the user');
  });

  test('a registered, ready channel is accepted (positive)', () => {
    const spec = base();
    spec.nodes[1].config = { channel: 'slack', target: '#ops' };
    const e = errors(spec);
    assert.equal(e.includes('UNKNOWN_CHANNEL'), false);
    assert.equal(e.includes('CHANNEL_UNAVAILABLE'), false);
    assert.equal(run(spec).ok, true);
  });

  test('a webhook with no url is rejected', () => {
    const spec = base();
    spec.nodes[1].config = { channel: 'webhook' };
    const issue = run(spec).issues.find(i => i.code === 'CHANNEL_MISSING_CONFIG');
    assert.ok(issue);
    assert.equal(issue.field, 'config.url');
  });

  test('a webhook WITH a url is accepted (positive)', () => {
    const spec = base();
    spec.nodes[1].config = { channel: 'webhook', url: 'https://example.com/hook' };
    assert.equal(errors(spec).includes('CHANNEL_MISSING_CONFIG'), false,
      'if this check were `if (true)` every correct webhook would be rejected');
    assert.equal(run(spec).ok, true);
  });

  test('the channel checks apply to `deliver` ONLY — a connector-action\'s `channel` param is not a delivery channel', () => {
    // Slack step capabilities take a `channel` param (a Slack channel name).
    // Judging that against the delivery catalog would reject `#ops` as an
    // "unknown channel" and make every Slack lookup step unpublishable.
    const spec = base();
    spec.nodes[0] = { id: 'sum', type: 'connector-action', label: 'History',
                      config: { action: 'slack_history', channel: '#ops' } };
    const e = errors(spec);
    assert.equal(e.includes('UNKNOWN_CHANNEL'), false, `got: ${e.join(', ')}`);
    assert.equal(e.includes('CHANNEL_MISSING_CONFIG'), false);
  });

  test('with NO registry wired, channel identity is simply not judged', () => {
    // The gap-scorer runs this configuration when the tenant catalog is unknown.
    // Unknowable is not the same as wrong — but it IS a weaker check, and that
    // weakening is what this test documents.
    const spec = base();
    spec.nodes[1].config = { channel: 'teams_send' };
    assert.equal(Vbare().validate(spec).errors.map(e => e.code).includes('UNKNOWN_CHANNEL'), false);
  });
});

// ── 8. The write warning ─────────────────────────────────────────────────────
describe('WRITE_WITHOUT_IDEMPOTENCY', () => {
  const withStep = (node) => base({
    nodes: [node, { id: 'out', type: 'deliver', label: 'Inbox', config: { channel: 'in_app' } }],
    edges: [{ from: node.id, to: 'out' }],
  });

  test('a write with no idempotency key warns', () => {
    const spec = withStep({ id: 'save', type: 'connector-action', label: 'Save',
                            config: { action: 'airtable_create_record', baseId: 'app1', tableId: 'Leads' } });
    const issue = run(spec).issues.find(i => i.code === 'WRITE_WITHOUT_IDEMPOTENCY');
    assert.ok(issue);
    assert.equal(issue.severity, 'warning', 'plenty of writes are naturally idempotent — this must not block publish');
    assert.equal(run(spec).ok, true);
  });

  test('the SAME write WITH an idempotency key does not warn (positive)', () => {
    // Without this, the check could be `if (true)` — warning on every write,
    // including the ones the author already made safe. A warning that always
    // fires is a warning nobody reads.
    const spec = withStep({ id: 'save', type: 'connector-action', label: 'Save',
                            idempotency: { key: '{{trigger.output}}', on_conflict: 'skip' },
                            config: { action: 'airtable_create_record', baseId: 'app1', tableId: 'Leads' } });
    assert.equal(codes(spec).includes('WRITE_WITHOUT_IDEMPOTENCY'), false);
  });

  test('a READ does not warn (positive)', () => {
    const spec = withStep({ id: 'rows', type: 'connector-action', label: 'List',
                            config: { action: 'airtable_list_records', baseId: 'app1', tableId: 'Leads' } });
    assert.equal(codes(spec).includes('WRITE_WITHOUT_IDEMPOTENCY'), false,
      'listing records writes nothing — warning about it would train people to ignore the warning');
  });
});

// ── 9. branch: MISSING_CONFIG is not BRANCH_BAD_ON ───────────────────────────
describe('a branch missing its parts reports WHICH part', () => {
  // These two used to be interchangeable to the suite. They are not to the user:
  // "you didn't say what to route on" and "you routed on a step that doesn't
  // exist" have different fixes, and the second is what fires when a typo makes
  // the catch-all swallow 100% of traffic.
  const branchSpec = (cfg) => base({
    nodes: [
      { id: 'cls',   type: 'llm',     label: 'Classify', config: { mode: 'classify', categories: 'urgent\nroutine' } },
      { id: 'route', type: 'branch',  label: 'Route',    config: cfg },
      { id: 'out',   type: 'deliver', label: 'Inbox',    config: { channel: 'in_app' } },
      { id: 'esc',   type: 'deliver', label: 'Escalate', config: { channel: 'slack', target: '#urgent' } },
    ],
    edges: [{ from: 'cls', to: 'route' }, { from: 'route', to: 'out' }, { from: 'route', to: 'esc' }],
  });

  test('no `on` → MISSING_CONFIG on config.on, and NOT BRANCH_BAD_ON', () => {
    const spec = branchSpec({ cases: [{ when: 'urgent', to: 'esc' }, { when: '*', to: 'out' }] });
    const e = errors(spec);
    assert.ok(run(spec).issues.some(i => i.code === 'MISSING_CONFIG' && i.field === 'config.on'));
    // The negative half is the load-bearing one. `on` is also a REQUIRED key in
    // branch's configSchema, so the generic MISSING_CONFIG loop fires here too —
    // asserting only "some issue on config.on has code MISSING_CONFIG" passes
    // even with the branch-specific check deleted, because the generic one is
    // laundering the result. Assert what must NOT be there instead: a branch that
    // says nothing is not a branch that says the wrong thing, and telling the user
    // "you routed on a step that doesn't exist" when they routed on nothing sends
    // them looking for a typo that isn't there.
    assert.equal(e.includes('BRANCH_BAD_ON'), false, `got: ${e.join(', ')}`);
  });

  test('no cases → MISSING_CONFIG on config.cases', () => {
    const spec = branchSpec({ on: 'cls.output', cases: [] });
    const issue = run(spec).issues.find(i => i.field === 'config.cases');
    assert.ok(issue);
    assert.equal(issue.code, 'MISSING_CONFIG');
  });

  test('a typo in `on` → BRANCH_BAD_ON (not MISSING_CONFIG)', () => {
    const spec = branchSpec({ on: 'clasify.output', cases: [{ when: 'urgent', to: 'esc' }, { when: '*', to: 'out' }] });
    assert.ok(errors(spec).includes('BRANCH_BAD_ON'));
  });

  test('a complete branch is accepted (positive)', () => {
    const spec = branchSpec({ on: 'cls.output', cases: [{ when: 'urgent', to: 'esc' }, { when: '*', to: 'out' }] });
    const e = errors(spec);
    assert.equal(e.includes('MISSING_CONFIG'), false, `got: ${e.join(', ')}`);
    assert.equal(e.includes('BRANCH_BAD_ON'), false);
    assert.equal(run(spec).ok, true);
  });
});

// ── 10. The outcome contract, v1 vs v2 ───────────────────────────────────────
describe('MISSING_OUTCOME is scoped to spec v2', () => {
  test('a v2 spec with no outcome is rejected', () => {
    assert.ok(errors(base({ version: 2 })).includes('MISSING_OUTCOME'),
      'a v2 workflow with no contract cannot be checked against anything');
  });

  test('a v1 spec with no outcome is fine (positive) — the DB is full of them', () => {
    assert.equal(errors(base()).includes('MISSING_OUTCOME'), false,
      'holding v1 specs to a contract they never made makes every stored workflow unpublishable overnight');
  });

  test('an outcome with an EMPTY assertion list is rejected', () => {
    const spec = base({ version: 2, outcome: { statement: 'Something happens.', assertions: [] } });
    assert.ok(errors(spec).includes('MISSING_OUTCOME'));
  });

  test('an outcome whose assertions are not even an array is rejected, not ignored', () => {
    const spec = base({ version: 2, outcome: { statement: 'x', assertions: { a: 1 } } });
    assert.ok(errors(spec).includes('MISSING_OUTCOME'));
  });

  test('a v2 spec with a satisfied assertion is accepted (positive)', () => {
    const spec = base({
      version: 2,
      outcome: { statement: 'The digest lands in the inbox.',
                 assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Digest' }] },
    });
    assert.equal(run(spec).ok, true, `got: ${errors(spec).join(', ')}`);
  });
});

describe('a malformed assertion names ITSELF in the error', () => {
  test('an assertion with no id is identified by its target', () => {
    const spec = base({
      version: 2,
      outcome: { assertions: [{ kind: 'vibes_improved', target: 'slack:#ops' }] },   // no id
    });
    const issue = run(spec).issues.find(i => i.code === 'MALFORMED_ASSERTION');
    assert.ok(issue);
    assert.match(issue.message, /slack:#ops/,
      'an error that cannot name which assertion it means is an error nobody can act on');
  });
});

describe('a FIELDS assertion is checked even when it has no id', () => {
  // `checkOutcome` keys satisfied assertions by `id ?? target`, and the validator
  // looks the assertion back up by the same key. Drop either fallback and an
  // id-less assertion's promised fields are never checked — the promise is
  // silently dropped, which is defect #1 in its subtler form.
  const spec = (fields) => base({
    version: 2,
    outcome: { assertions: [{ kind: 'record_exists', target: 'airtable:Leads', fields }] },
    nodes: [
      { id: 'save', type: 'connector-action', label: 'Save',
        config: { action: 'airtable_create_record', baseId: 'app1', tableId: 'Leads',
                  fields: { Name: '{{trigger.output}}', Company: '{{trigger.output}}' } } },
      { id: 'out', type: 'deliver', label: 'Inbox', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'save', to: 'out' }],
  });

  test('a promised field the node never sets is reported', () => {
    const issue = run(spec(['Name', 'Company', 'Budget'])).issues.find(i => i.code === 'UNSATISFIED_ASSERTION');
    assert.ok(issue, 'an id-less assertion is still an assertion');
    assert.match(issue.message, /Budget/);
    assert.equal(issue.nodeId, 'save');
  });

  test('fields the node DOES set are accepted (positive)', () => {
    assert.equal(errors(spec(['Name', 'Company'])).includes('UNSATISFIED_ASSERTION'), false);
  });
});

// ── P12 Increment D — `.decision` is a HUMAN field (BRANCH_BAD_ON) ────────────
test('a branch routing on `.decision` of a NON-human step is rejected', () => {
  // `.decision` is a field only a `human` node produces. Routing on `llm.decision`
  // is meaningless — the engine would throw rather than misroute — so it is a
  // build-time error (BRANCH_BAD_ON), not a runtime surprise.
  const spec = {
    name: 'x', kind: 'flow',
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [
      { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'd' } },
      { id: 'gate',  type: 'branch', config: { on: '{{draft.decision}}', cases: [{ when: 'approve', to: 'd' }, { when: '*', to: 'no' }] } },
      { id: 'd',     type: 'deliver', config: { channel: 'in_app' } },
      { id: 'no',    type: 'assemble', config: { title: 'no', sections: '[]' } },
    ],
    edges: [{ from: 'draft', to: 'gate' }, { from: 'gate', to: 'd' }, { from: 'gate', to: 'no' }],
  };
  assert.ok(codes(spec).includes('BRANCH_BAD_ON'), 'only a human step has a .decision to route on');
  // Positive: `.decision` on an actual human node is fine.
  const ok = {
    name: 'x', kind: 'flow',
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [
      { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'd' } },
      { id: 'ask',   type: 'human', config: { prompt: 'ok?', decisions: ['approve', 'reject'], channels: [{ type: 'inbox' }], timeout: { after: '48h', then: 'reject' } } },
      { id: 'gate',  type: 'branch', config: { on: '{{ask.decision}}', cases: [{ when: 'approve', to: 'd' }, { when: '*', to: 'no' }] } },
      { id: 'd',     type: 'deliver', config: { channel: 'in_app' } },
      { id: 'no',    type: 'assemble', config: { title: 'no', sections: '[]' } },
    ],
    edges: [{ from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' }, { from: 'gate', to: 'd' }, { from: 'gate', to: 'no' }],
  };
  assert.ok(!codes(ok).includes('BRANCH_BAD_ON'), 'a human .decision routes fine');
});

// ── P12 Increment D — human-gate branches (mutation-sweep coverage) ───────────
import { approvalChannelView } from '../../src/workflows/approval-channels.js';
const Vappr = () => new WorkflowValidator({ nodeTypes: nodeTypes(), channelRegistry, approvalChannels: approvalChannelView(['inbox', 'slack', 'email']) });
const humanSpec = (askOverrides = {}, edges = null, extraNodes = []) => ({
  name: 'x', kind: 'flow',
  triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
  nodes: [
    { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'd' } },
    { id: 'ask',   type: 'human', config: { prompt: 'ok?', decisions: ['approve', 'reject'], channels: [{ type: 'inbox' }], timeout: { after: '48h', then: 'reject' }, ...askOverrides } },
    { id: 'gate',  type: 'branch', config: { on: '{{ask.decision}}', cases: [{ when: 'approve', to: 'd' }, { when: '*', to: 'no' }] } },
    { id: 'd',     type: 'deliver', config: { channel: 'in_app' } },
    { id: 'no',    type: 'assemble', config: { title: 'no', sections: '[]' } },
    ...extraNodes,
  ],
  edges: edges ?? [{ from: 'draft', to: 'ask' }, { from: 'ask', to: 'gate' }, { from: 'gate', to: 'd' }, { from: 'gate', to: 'no' }],
});
const apprCodes = (spec) => Vappr().validate(spec).issues.filter(i => i.severity === 'error').map(i => i.code);

describe('a human node with NO channels', () => {
  test('is rejected — a question with nowhere to go reaches nobody', () => {
    assert.ok(apprCodes(humanSpec({ channels: [] })).includes('APPROVAL_CHANNEL_NOT_CONNECTED'));
  });
  test('a human WITH a channel is accepted (positive)', () => {
    assert.ok(!apprCodes(humanSpec()).includes('APPROVAL_CHANNEL_NOT_CONNECTED'));
  });
});

describe('HUMAN_ANSWER_NOT_ROUTED vs a terminal human', () => {
  test('a TERMINAL human (no successors) is fine — nothing runs after it to gate', () => {
    // Kills the mutant that makes `if (successors.length)` always true: a human
    // with no outgoing edges must NOT be flagged as ungated.
    const spec = {
      name: 'x', kind: 'flow',
      triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
      nodes: [
        { id: 'draft', type: 'llm', config: { mode: 'freeform', prompt: 'd' } },
        { id: 'ack',   type: 'human', config: { prompt: 'seen?', decisions: ['approve', 'reject'], channels: [{ type: 'inbox' }], timeout: { after: '48h', then: 'reject' } } },
      ],
      edges: [{ from: 'draft', to: 'ack' }],
    };
    assert.ok(!apprCodes(spec).includes('HUMAN_ANSWER_NOT_ROUTED'), 'a terminal human gates nothing');
  });
});

describe('DUPLICATE_ASSERTION_ID', () => {
  test('two outcome assertions sharing an id are rejected', () => {
    const spec = {
      name: 'x', kind: 'flow', version: 2,
      outcome: { statement: 's', assertions: [
        { id: 'a', kind: 'message_sent', target: 'slack:#x' },
        { id: 'a', kind: 'message_sent', target: 'slack:#y' },
      ] },
      triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
      nodes: [{ id: 'd', type: 'deliver', config: { channel: 'in_app' } }],
      edges: [],
    };
    assert.ok(apprCodes(spec).includes('DUPLICATE_ASSERTION_ID'), 'a colliding id silently drops an assertion — reject it');
  });
});

// P12 — foreach validate() branches (mutation-sweep survivors)
describe('foreach validate', () => {
  const foreachSpec = (steps) => ({
    name: 'x', kind: 'flow',
    triggers: [{ type: 'schedule', config: { cron: '0 9 * * *' } }],
    nodes: [
      { id: 'rows', type: 'connector-action', config: { action: 'airtable_search_records', baseId: 'b', tableId: 't' } },
      { id: 'loop', type: 'foreach', config: { over: 'rows.output', steps } },
      { id: 'out',  type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [{ from: 'rows', to: 'loop' }, { from: 'loop', to: 'out' }],
  });
  test('a foreach with NO steps is rejected (MISSING_CONFIG)', () => {
    assert.ok(codes(foreachSpec([])).includes('MISSING_CONFIG'), 'a loop with nothing to do per item is a mistake');
  });
  test('a write inside a foreach with no idempotency warns (WRITE_WITHOUT_IDEMPOTENCY)', () => {
    const spec = foreachSpec([{ id: 'mk', type: 'connector-action', config: { action: 'airtable_create_record', baseId: 'b', tableId: 't', fields: '{}' } }]);
    assert.ok(codes(spec).includes('WRITE_WITHOUT_IDEMPOTENCY'), 'N writes per fire with no key is the highest-risk write shape');
  });
  test('a write inside a foreach WITH an idempotency key does not warn (positive)', () => {
    const spec = foreachSpec([{ id: 'mk', type: 'connector-action', idempotency: { key: '{{item}}' }, config: { action: 'airtable_create_record', baseId: 'b', tableId: 't', fields: '{}' } }]);
    assert.ok(!codes(spec).includes('WRITE_WITHOUT_IDEMPOTENCY'), 'a keyed write in a loop is fine');
  });
});
