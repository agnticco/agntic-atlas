/**
 * Schema-aware connectors — the last open config hole, closed. (P12 Increment F.)
 *
 * `connector-action` was the ONLY node type left on `configPolicy: 'open'`: its
 * params passed straight through to the handler, unchecked. So a converger that
 * hallucinated `tableName` (Airtable's REST API really does have one — it is the
 * single most likely wrong key an LLM will emit) shipped it, the handler ignored
 * it, the record went to the wrong table or nowhere, and nobody was told.
 *
 * The reason it stayed open was real but incomplete: this node's params ARE
 * per-capability, and its own schema cannot enumerate them. But every CAPABILITY
 * already declares its own `configSchema` — the data was there the whole time and
 * was simply never consulted. So the key set is:
 *
 *     the node's own keys   ∪   the SELECTED CAPABILITY's declared params
 *
 * …which is exactly how `deliver` has resolved its channel's keys since C.
 *
 * TWO WAYS TO GET THIS WRONG, and both have already happened once:
 *
 *  1. ENFORCE AGAINST A LYING SCHEMA. Increment C did: `sheets_append`'s handler
 *     reads spreadsheetId/range, `deliver` declared neither, and EVERY delivery to
 *     a Sheet was rejected at publish — while the converger's own prompt told users
 *     to build exactly that. So this suite asserts, capability by capability, that
 *     THE REAL SHAPES STILL VALIDATE.
 *  2. CHECK A CONFIGURATION PRODUCTION NEVER USES. A validator with no registry
 *     cannot resolve a capability, so its params are UNKNOWABLE — and an unknowable
 *     key set is not a wrong one. It must not judge them. That is safe only because
 *     the gap scorer REFUSES TO CERTIFY in that state (CHANNELS_UNVERIFIED), which
 *     is what keeps `complete ⇒ publishable` true.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { connectorActionNodeType }  from '../../src/workflows/node-types/connector-action.js';
import { scoreGap }                 from '../../src/converger/gap-scorer.js';
import { realCatalog }              from '../helpers/catalog.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const catalog   = realCatalog();
const validator = new WorkflowValidator({ nodeTypes, channelRegistry: catalog });

const spec = (actionCfg) => ({
  name: 'T', version: 1,
  triggers: [{ type: 'manual' }],
  nodes: [
    { id: 'act', type: 'connector-action', label: 'Act', config: actionCfg },
    { id: 'out', type: 'deliver', label: 'Out', config: { channel: 'slack', target: '#ops' } },
  ],
  edges: [{ from: 'act', to: 'out' }],
});
const errsOn = (cfg) => validator.validate(spec(cfg)).errors.filter(e => e.nodeId === 'act');
const codesOn = (cfg) => errsOn(cfg).map(e => e.code);

// ── 1. The regression that C actually shipped ───────────────────────────────

describe('EVERY real capability shape still validates', () => {
  test('a node built from each capability\'s OWN schema is accepted', () => {
    // The check that would have caught Increment C's live defect. If a capability's
    // declared schema and the validator's idea of its keys ever diverge, this fails
    // — rather than a user discovering it when publish refuses to save the workflow
    // the builder just told them to build.
    const rejected = [];
    for (const cap of catalog.getAll()) {
      const cfg = { action: cap.id };
      for (const f of (cap.configSchema ?? [])) {
        if (!f.optional) cfg[f.key] = f.key === 'fields' ? { Name: 'x' } : 'x';
      }
      const bad = errsOn(cfg);
      if (bad.length) rejected.push(`${cap.id}: ${bad.map(e => e.code + '(' + e.field + ')').join(', ')}`);
    }
    assert.deepEqual(rejected, [],
      'a capability the catalog offers must be one the validator accepts — otherwise the builder ' +
      'instructs users to build workflows it will then refuse to save (CLAUDE.md, Increment C)');
  });
});

// ── 2. The hole itself ──────────────────────────────────────────────────────

describe('a hallucinated connector param is REJECTED', () => {
  test('`tableName` on an Airtable create — the most likely wrong key there is', () => {
    // Airtable's REST API has `tableName`. Atlas's capability does not. The old
    // engine passed it through, the handler ignored it, and the record silently
    // went nowhere the user intended.
    const cfg = { action: 'airtable_create_record', baseId: 'appX', tableId: 'tblY', fields: { Name: 'x' }, tableName: 'Leads' };
    const e = errsOn(cfg);
    assert.equal(e.length, 1);
    assert.equal(e[0].code, 'UNKNOWN_CONFIG_KEY');
    assert.equal(e[0].field, 'config.tableName');
  });

  test('POSITIVE: the same node WITHOUT the bad key validates', () => {
    assert.deepEqual(codesOn({ action: 'airtable_create_record', baseId: 'appX', tableId: 'tblY', fields: { Name: 'x' } }), []);
  });

  test('a REQUIRED capability param that is missing is an error, not a 3am surprise', () => {
    // airtable_create_record's handler throws without baseId. It used to publish
    // clean and fail against a real customer's trigger.
    const codes = codesOn({ action: 'airtable_create_record', fields: { Name: 'x' } });
    assert.ok(codes.includes('MISSING_CONFIG'));
  });

  test('an action id that does not exist is caught at BUILD time', () => {
    assert.deepEqual(codesOn({ action: 'airtable_summon_dragon' }), ['UNKNOWN_CONNECTOR_ACTION']);
  });

  test('the node\'s OWN schema is true: it declares what run() reads, and nothing else', () => {
    // run() reads exactly cfg.action and cfg.title. `target` used to be declared
    // here and is NOT read by run() — it is Slack's capability param. A schema that
    // lists keys nothing reads turns the check into theatre (CLAUDE.md, Increment A).
    const keys = connectorActionNodeType.configSchema.map(f => f.key).sort();
    assert.deepEqual(keys, ['action', 'title']);
    assert.equal(connectorActionNodeType.configPolicy, 'closed', 'nothing is open any more');
  });
});

// ── 3. …and it must not judge what it cannot resolve ────────────────────────

describe('an UNRESOLVABLE capability has an unknowable key set, and is not judged', () => {
  const bare = new WorkflowValidator({ nodeTypes });   // no registry — as a test used to build it

  test('with no catalog, real connector params are NOT rejected', () => {
    // An unknowable key set is not a wrong one. Judging it anyway rejects `baseId`
    // purely because the CALLER had no registry — a false rejection produced by the
    // checker's own configuration rather than by anything in the spec.
    const res = bare.validate(spec({ action: 'airtable_create_record', baseId: 'a', tableId: 't', fields: { N: 1 } }));
    assert.equal(res.errors.some(e => e.code === 'UNKNOWN_CONFIG_KEY'), false);
  });

  test('…but the GAP SCORER refuses to certify in that state', () => {
    // This is the half that keeps `complete ⇒ publishable` true. Skipping the check
    // where it cannot run is only safe because nothing can be called COMPLETE there.
    // Publish always has the registry; a scorer without one performs fewer checks
    // than publish does, which is exactly how a spec scores complete and is then
    // rejected at save (the blocker the verifier found in C).
    const s = {
      version: 2, name: 'T',
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name'] }] },
      triggers: [{ type: 'manual' }],
      nodes: [
        { id: 'act', type: 'connector-action', label: 'Act',
          config: { action: 'airtable_create_record', baseId: 'a', tableId: 'Leads', fields: { Name: 'x' } } },
        { id: 'out', type: 'deliver', label: 'Out', config: { channel: 'slack', target: '#ops' } },
      ],
      edges: [{ from: 'act', to: 'out' }],
    };
    const blind = scoreGap(s, { capabilities: {} });          // no catalog at all
    assert.equal(blind.complete, false);
    assert.ok(blind.gaps.some(g => g.code === 'CHANNELS_UNVERIFIED'),
      'a connector-action whose params nobody could check must not be certified complete');
  });
});
