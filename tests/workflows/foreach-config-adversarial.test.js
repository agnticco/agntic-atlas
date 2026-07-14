/**
 * THE LAUNDERING HOP, AGAIN — a `foreach` around the checks P12 Increment F added.
 *
 * F closed "the last open config hole": a `connector-action`'s params are now checked
 * against the SELECTED CAPABILITY's own schema, its action id must be a real capability,
 * and a required capability param that is missing is an error. All three run in
 * `WorkflowValidator.validate()`'s per-node loop — which iterates `spec.nodes`.
 *
 * A `foreach`'s per-item steps are NOT in `spec.nodes`. They live in `config.steps`.
 *
 * The validator already knows they are real steps: it reaches into `config.steps` for
 * ON_ERROR_IN_FOREACH and for WRITE_WITHOUT_IDEMPOTENCY (workflow-validator.js:942-961),
 * and `isWriteNode` recurses into them for WEAK_APPROVAL_FOR_WRITE (:1463) — that last
 * one *because the adversary found exactly this class of hole in Increment D*
 * ("`WEAK_APPROVAL_FOR_WRITE` was laundered by a `foreach`"). Every OTHER check stops at
 * the loop's edge.
 *
 * That was survivable while `foreach` was unreachable. **Increment F makes it reachable**:
 * `prompts.js` now teaches the converger to emit one, and the example it teaches is
 * *"create a record for every row"* — i.e. an `airtable_create_record` inside the loop,
 * which is precisely the node type whose params F just started checking.
 *
 * CLAUDE.md names this shape three times ("THREE OF THE FOUR WERE A LAUNDERING HOP ONE
 * STEP TO THE LEFT OF A REAL CHECK"). This is the fourth.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { scoreGap }                 from '../../src/converger/gap-scorer.js';
import { nodeEffect }               from '../../src/workflows/outcome-oracle.js';
import { productionCatalog, productionCapabilities } from '../helpers/prod-catalog.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const catalog   = productionCatalog();
const CAPS      = productionCapabilities(catalog);
const validator = new WorkflowValidator({ nodeTypes, channelRegistry: catalog });

/**
 * "Create a record for every row" — the exact shape `prompts.js` (P12 Increment F)
 * teaches the converger to emit. `sub` is the per-item step under test.
 */
const looping = (sub) => ({
  version: 2, name: 'Row loader',
  outcome: {
    statement: 'Every row in the source table becomes a lead, and #ops is told.',
    assertions: [{ id: 'a2', kind: 'message_sent', target: 'slack:#ops' }],
  },
  triggers: [{ type: 'manual' }],
  nodes: [
    { id: 'rows', type: 'connector-action', label: 'Read the rows',
      config: { action: 'airtable_list_records', baseId: 'appAAAAAAAAAAAAA1', tableId: 'Source' } },
    { id: 'loop', type: 'foreach', label: 'For each row',
      config: { over: 'rows.output', steps: [sub], maxItems: 100 } },
    { id: 'out', type: 'deliver', label: 'Tell #ops', config: { channel: 'slack', target: '#ops' } },
  ],
  edges: [{ from: 'rows', to: 'loop' }, { from: 'loop', to: 'out' }],
});

const codesFor = (sub) => validator.validate(looping(sub)).errors.map(e => e.code);

const WRITE = {
  id: 'save', type: 'connector-action',
  config: { action: 'airtable_create_record', baseId: 'appAAAAAAAAAAAAA1', tableId: 'Leads', fields: { Name: '{{item}}' } },
  idempotency: { key: '{{item}}', on_conflict: 'skip' },
};

// ── 0. The control: the shape the converger is now taught to emit must PUBLISH ──

describe('POSITIVE — a well-formed loop still validates', () => {
  test('a correct airtable_create_record inside a foreach is accepted', () => {
    // Without this, every assertion below would pass if the validator rejected ALL
    // loops. (CLAUDE.md: "Every validator rule needs a POSITIVE case.")
    assert.deepEqual(validator.validate(looping(WRITE)).errors.map(e => `${e.code}@${e.nodeId}`), []);
    assert.equal(scoreGap(looping(WRITE), { capabilities: CAPS }).complete, true);
  });
});

// ── 1. The action id ─────────────────────────────────────────────────────────

describe('UNKNOWN_CONNECTOR_ACTION does not stop at the loop\'s edge', () => {
  test('a capability that does not exist, inside a loop, must not publish', () => {
    // Outside the loop this is UNKNOWN_CONNECTOR_ACTION (Increment F's own test proves
    // it: connector-schema.test.js — `airtable_summon_dragon`). Inside one, nothing looks.
    // It publishes clean, and then throws once PER ITEM at run time
    // (connector-action.js:62), inside a loop, against real rows.
    const codes = codesFor({ ...WRITE, config: { ...WRITE.config, action: 'airtable_summon_dragon' } });
    assert.ok(codes.includes('UNKNOWN_CONNECTOR_ACTION'),
      `a loop step naming a capability nobody has is not a workflow with a small omission — ` +
      `it is one that cannot possibly run. got: [${codes.join(', ')}]`);
  });
});

// ── 2. The params ────────────────────────────────────────────────────────────

describe('UNKNOWN_CONFIG_KEY does not stop at the loop\'s edge', () => {
  test('a hallucinated capability param, inside a loop, must not publish', () => {
    // `tableName` is Airtable's REST API param. Atlas's capability has `tableId`. This is
    // the single most likely wrong key an LLM emits, and it is the one F's own suite
    // names — at the top level. One `foreach` hop and the handler silently ignores it.
    const codes = codesFor({ ...WRITE, config: { ...WRITE.config, tableName: 'Leads' } });
    assert.ok(codes.includes('UNKNOWN_CONFIG_KEY'),
      `the check that closed the last open config hole must not have a hole in it. got: [${codes.join(', ')}]`);
  });

  test('the banned `model` key on an llm step, inside a loop, must not publish', () => {
    // `"model": "claude-opus-4-5"` is the hallucination Increment A built
    // UNKNOWN_CONFIG_KEY to kill — the very first check of the phase. Inside a loop it is
    // accepted, and the engine silently ignores it: the user believes they chose a model.
    const codes = codesFor({ id: 'draft', type: 'llm', config: { mode: 'rewrite', prompt: 'x', model: 'claude-opus-4-5' } });
    assert.ok(codes.includes('UNKNOWN_CONFIG_KEY'),
      `got: [${codes.join(', ')}] — a key no code reads is a hallucination wherever it appears`);
  });

  test('a MISSING required capability param, inside a loop, must not publish', () => {
    // `airtable_create_record` cannot run without a baseId: the handler builds
    // `/${baseId}/${tableId}` and posts to `/undefined/Leads`. F made that a build-time
    // error ("an airtable_create_record with no baseId … used to publish clean and fail at
    // 3am against a real customer's trigger") — everywhere except the one place a write is
    // N writes per fire.
    const { baseId, ...noBase } = WRITE.config;
    const codes = codesFor({ ...WRITE, config: noBase });
    assert.ok(codes.includes('MISSING_CONFIG'),
      `got: [${codes.join(', ')}]`);
  });
});

// ── 3. The outcome cannot see into the loop ──────────────────────────────────

describe('the outcome oracle can see a write inside a loop', () => {
  test('a `foreach` that writes has an effect', () => {
    // `nodeEffect()` (outcome-oracle.js:126-174) handles `deliver` and `connector-action`
    // and returns null for everything else — so a `foreach` whose steps write to Airtable
    // is, to the contract, a node that does nothing.
    const eff = nodeEffect({ id: 'loop', type: 'foreach', config: { over: 'rows.output', steps: [WRITE] } });
    assert.ok(eff, 'a loop whose per-item step creates an Airtable record DOES create Airtable records');
    assert.equal(eff.kind, 'record_exists');
    assert.ok(eff.connectors.has('airtable'));
  });

  test('…so "a record for every row" can satisfy its own record_exists assertion', () => {
    // THE SHAPE THE CONVERGER IS NOW TAUGHT TO EMIT. The outcome contract is mandatory,
    // and the honest contract for "create a record for every row" is a `record_exists`.
    // Today the write is invisible to the oracle, so the promise is UNSATISFIED and the
    // workflow CANNOT PUBLISH — the user is told to build a loop by the builder and then
    // refused by the save button, with no way to argue.
    //
    // The two failures are the same fact seen from both ends, and they are jointly
    // vicious: the ONLY way to publish this workflow is to drop the assertion — leaving
    // the loop's write both unpromised AND (see §2 above) entirely unchecked.
    const spec = looping(WRITE);
    spec.outcome.assertions.unshift({ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name'] });

    const res = validator.validate(spec);
    assert.equal(res.ok, true,
      `a loop that creates a record satisfies "a record exists"; got: ${res.errors.map(e => e.code).join(', ')}`);
    assert.equal(scoreGap(spec, { capabilities: CAPS }).complete, true,
      'and the converger must be able to certify it — otherwise the loop it just proposed can never be finished');
  });

  test('POSITIVE: a loop that does NOT write still satisfies nothing', () => {
    // The rule must not be widened into "a foreach satisfies anything". A loop of pure
    // reads has no effect on the world and must never appear to.
    const eff = nodeEffect({ id: 'loop', type: 'foreach', config: { over: 'rows.output', steps: [
      { id: 'read', type: 'connector-action', config: { action: 'airtable_get_record', baseId: 'appAAAAAAAAAAAAA1', tableId: 'Leads', recordId: '{{item}}' } },
    ] } });
    assert.equal(eff, null, 'a read satisfies nothing, and must not appear to (outcome-oracle.js:171)');
  });
});
