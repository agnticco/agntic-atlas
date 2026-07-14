/**
 * The COLUMN MAPPING's own guards. (P12 Increment F.)
 *
 * `mapFieldsToColumns` asks a model which REAL column each intended field belongs in.
 * That model is an LLM being asked about a closed set — so a column IT invents is the
 * exact defect this function exists to prevent, merely introduced by us instead of by
 * the spec's author. The `real` filter is what stops that, and nothing executed it:
 * the adversary's own POSITIVE case is satisfied by a different filter (an intended
 * key nobody asked for), so the mutation `real.get(...) → String(proposed)` SURVIVED
 * the whole suite.
 *
 * These drive the real graph through the production call path (createConverger →
 * run → resume), the same way `src/api/builder.js` drives it.
 */

import { test, describe, after } from 'node:test';
import assert                    from 'node:assert/strict';
import { mkdtempSync, rmSync }   from 'node:fs';
import { tmpdir }                from 'node:os';
import { join }                  from 'node:path';

import { createConverger }          from '../../src/converger/index.js';
import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { realCatalog }              from '../helpers/catalog.js';

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const catalog   = realCatalog();
const CAPS      = { channels: catalog.getAll().map(c => ({ ...c, available: true })) };
const validator = new WorkflowValidator({ nodeTypes, channelRegistry: catalog });

const REAL_BASE = 'appAAAAAAAAAAAAA1';
const COLUMNS   = ['Name', 'Deal Size'];

const tmpDirs = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-map-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

/** Drive the whole loop offline. `map` is what the MAPPING model answers with. */
async function converge(map) {
  const invokeCapability = async (id, params = {}) => {
    if (id === 'airtable_list_bases')    return { bases: [{ id: REAL_BASE, name: 'Sales CRM' }] };
    if (id === 'airtable_describe_base') return { baseId: params.baseId, tables: [
      { id: 'tblLeads', name: 'Leads', fields: COLUMNS.map((name, i) => ({ id: `f${i}`, name, type: 'singleLineText', choices: [] })) },
    ] };
    if (id === 'gmail_search') return { messages: [] };
    throw new Error(`unstubbed capability: ${id}`);
  };

  const draftIn = (p) => { const m = /CURRENT DRAFT:\n(\{[\s\S]*?\n\})\n/.exec(p); try { return JSON.parse(m[1]); } catch { return {}; } };
  const J = (o) => ({ content: JSON.stringify(o) });

  const llm = { invoke: async (messages) => {
    const p = String(messages[messages.length - 1].content);
    if (p.includes('OUTCOME CONTRACT')) return J({ candidates: [{ id: 'c1', statement: 'Leads are saved with their budget.',
      assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name', 'Budget'] }] }] });
    if (p.includes('What starts this workflow'))       return J({ trigger: { type: 'email', filter: 'to:leads@acme.com' } });
    if (p.includes('CONCRETE example cases'))          return J({ examples: [] });
    if (p.includes('Analyze this automation intent'))  return J({ ready: true });
    if (p.includes('Is this workflow FINISHED'))       return J({ complete: true });
    if (p.includes('cases nobody has decided about'))  return J({ suggestions: [] });
    if (p.includes('REAL columns are'))                return J({ map });
    if (p.includes('Build the next component')) {
      const d   = draftIn(p);
      const has = (id) => (d.nodes ?? []).some(n => n.id === id);
      if (!has('extract')) return J({ component: 'node', spec: { id: 'extract', type: 'llm', label: 'E',
        config: { mode: 'extract', fields: 'name: the name\nbudget: the budget' } } });
      if (!has('save'))    return J({ component: 'node', spec: { id: 'save', type: 'connector-action', label: 'Save',
        config: { action: 'airtable_create_record', baseId: 'appPLACEHOLDER', tableId: 'Leads',
                  fields: { Name: '{{extract.name}}', Budget: '{{extract.budget}}' } },
        idempotency: { key: '{{extract.name}}', on_conflict: 'skip' } } });
      if (!(d.edges ?? []).some(e => e.from === 'extract' && e.to === 'save')) return J({ component: 'edge', spec: { from: 'extract', to: 'save' } });
      // NO `deliver` NODE. This workflow's whole job is to move data: the Airtable
      // record IS the outcome. It used to need a pointless delivery bolted on to
      // satisfy MISSING_DELIVER — a checklist shaped like one workflow, imposed on
      // every workflow. (Raised by the operator.)
      return J({ component: 'name', spec: 'Leads' });
    }
    return J({});
  } };

  const conv = createConverger({ llm, capabilities: CAPS, invokeCapability, checkpointerDir: scratch() });
  const reply = { outcome_check: () => ({ id: 'c1' }), example_request: () => ({ type: 'skip' }),
                  proposal: () => ({ type: 'accept' }), clarification: () => ({ answer: 'yes' }),
                  gap_review: () => ({ acceptDefaults: true }), ratify: () => ({ type: 'approve' }) };

  let iv;
  try { await conv.run('m1', 'save leads to airtable'); iv = { type: 'done' }; }
  catch (err) { iv = err.interruptValue ?? err; }
  let last = null;
  for (let i = 0; i < 60 && iv?.type !== 'done'; i++) {
    if (iv.type === 'ratify') last = iv;
    iv = await conv.resume('m1', (reply[iv.type] ?? (() => ({ type: 'accept' })))(iv));
  }
  const spec = iv?.spec ?? last?.spec ?? null;
  const save = (spec?.nodes ?? []).find(n => n.id === 'save');
  return { spec, save };
}

describe('the mapping model is not trusted', () => {
  test('a column the MAPPER invents is never written', async () => {
    // It maps `budget` onto a column that does not exist. If we take its word for it,
    // Airtable receives "Deal Sizes" (plural), silently ignores it, and creates the
    // record with an empty column — which is the defect, introduced by the very step
    // written to prevent it.
    const { save } = await converge({ Name: 'Name', Budget: 'Deal Sizes' });
    const written = Object.keys(save?.config?.fields ?? {});
    assert.deepEqual(written.filter(k => !COLUMNS.includes(k)), [],
      `the spec writes ${JSON.stringify(written)} into a table whose columns are ${JSON.stringify(COLUMNS)}`);
    assert.deepEqual(written, ['Name'], 'the invented column is dropped; the real one survives');
  });

  test('…and the promise it could not keep BLOCKS the publish', async () => {
    // Dropping the column is only half honest. The outcome still promises the budget
    // will be recorded, and now nothing records it — so the spec must NOT publish, and
    // the user must be told. A silent drop performed by the anti-silent-drop code would
    // be the worst outcome of all.
    const { spec } = await converge({ Name: 'Name', Budget: 'Deal Sizes' });
    const res = validator.validate(spec);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.code === 'UNSATISFIED_ASSERTION'),
      `got: ${res.errors.map(e => e.code).join(', ')}`);
  });

  test('POSITIVE: a correct mapping writes the real column AND restates the promise', async () => {
    const { spec, save } = await converge({ Name: 'Name', Budget: 'Deal Size' });
    assert.deepEqual(Object.keys(save.config.fields).sort(), ['Deal Size', 'Name']);
    assert.equal(save.config.fields['Deal Size'], '{{extract.budget}}',
      'the COLUMN is renamed; the VALUE the author wrote is not touched');

    const promised = spec.outcome.assertions[0].fields;
    assert.ok(promised.includes('Deal Size'),
      'the contract must be restated in the table\'s own words, or it fails against the node it just fixed');
    const res = validator.validate(spec);
    assert.equal(res.ok, true,
      `complete ⇒ publishable, ON THE SUCCESS PATH — which is exactly where it used to be false. got: ${res.errors.map(e => e.code + ':' + e.message).join(' | ')}`);
  });
});
