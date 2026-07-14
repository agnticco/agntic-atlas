/**
 * THE FLAGSHIP — P12 Increment F's acceptance.
 *
 *   inbound email → extract → decide → Airtable record + Slack
 *
 * …buildable **by conversation and clicks alone**: no pasted base ID, no typed
 * example. That sentence is the whole increment, and each half of it is a thing
 * that used to be impossible:
 *
 *   · the base id and the table's columns are READ from the connector and
 *     RESOLVED into the spec (§6.2.3 — never ask for something we can read). A user
 *     who cannot produce `appXXXXXXXXXXXXXX` from memory used to be stuck here, and
 *     "go and find your base id" is the moment a conversational builder stops being
 *     conversational.
 *   · the examples are three REAL emails from their inbox, picked with a click.
 *     Asked to invent test cases people invent EASY ones; the case that finds the
 *     bug is the awkward real one nobody types from memory.
 *
 * WHAT THIS SUITE REFUSES TO DO: drive the live model. The converger's own
 * behaviour is already gated by P3 (it reproduces the frozen canonical spec) and by
 * `converger-adversarial`. What is NEW in F, and what nothing else covers, is the
 * MACHINERY: does the builder actually read the tenant's bases, map onto the columns
 * that exist, refuse to invent one that does not, and produce a spec that PUBLISHES
 * and RUNS end-to-end? Those are deterministic questions, and a test that answers
 * them offline answers them on every commit rather than only when a key is set.
 *
 * The connectors are stubbed at the CAPABILITY HANDLER — the same seam the engine
 * calls through — so everything above it (the schema resolution, the validator, the
 * outcome oracle, the decision table, the fan-out) is the real thing.
 */

import { test, describe, after } from 'node:test';
import assert             from 'node:assert/strict';

import { WorkflowValidator }        from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry }         from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { FlowTester }               from '../../src/workflows/flow-tester.js';
import { scoreGap }                 from '../../src/converger/gap-scorer.js';
import { CapabilityRegistry }       from '../../src/connectors/capability-registry.js';
import { ChannelRegistry }          from '../../src/workflows/channel-registry.js';
import { registerSlackChannel }     from '../../src/connectors/slack/index.js';
import { registerGoogleChannels }   from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { airtableListBases, airtableDescribeBase } from '../../src/connectors/airtable/index.js';
import { IdempotencyStore }      from '../../src/workflows/idempotency-store.js';
import { mkdtempSync, rmSync }   from 'node:fs';
import { tmpdir }                from 'node:os';
import { join }                  from 'node:path';

// ── The tenant's REAL Airtable, as the connector would report it ─────────────
// Note the columns: the user's table says "Deal Size" and "Account". The workflow
// wants to write "Budget" and "Company". THAT MISMATCH IS THE POINT — Airtable
// silently ignores an unknown field name, so a record posted with {"Budget": 80000}
// is created with the column EMPTY and the run reports success. Forever.
const BASES = [
  { id: 'appAAAAAAAAAAAAA1', name: 'Sales CRM', permissionLevel: 'create' },
  { id: 'appBBBBBBBBBBBBB2', name: 'Recruiting', permissionLevel: 'create' },
];
const TABLES = {
  appAAAAAAAAAAAAA1: [
    { id: 'tblLeads', name: 'Leads', fields: [
      { id: 'f1', name: 'Name',      type: 'singleLineText', choices: [] },
      { id: 'f2', name: 'Account',   type: 'singleLineText', choices: [] },
      { id: 'f3', name: 'Deal Size', type: 'number',         choices: [] },
      { id: 'f4', name: 'Priority',  type: 'singleSelect',   choices: ['P1', 'P2', 'P3'] },
    ] },
  ],
};

/** The Airtable REST API, stubbed at the HTTP seam the real helpers call. */
const airtableApi = () => async (method, path) => {
  if (path === '/meta/bases') return { bases: BASES };
  const m = /^\/meta\/bases\/([^/]+)\/tables$/.exec(path);
  if (m) return { tables: (TABLES[m[1]] ?? []).map(t => ({ ...t, fields: t.fields.map(f => ({ ...f, options: { choices: f.choices.map(name => ({ name })) } })) })) };
  throw new Error(`unexpected airtable call: ${method} ${path}`);
};

function catalog() {
  const caps     = new CapabilityRegistry();
  const channels = new ChannelRegistry(caps);
  registerSlackChannel(channels);
  registerGoogleChannels(caps);
  registerAirtableChannels(caps);
  const get = channels.get.bind(channels);
  channels.get = (id) => { const c = get(id); return c ? { ...c, available: true } : null; };
  return channels;
}

const nodeTypes = registerBuiltInNodeTypes(new NodeTypeRegistry());
const channels  = catalog();
const validator = new WorkflowValidator({ nodeTypes, channelRegistry: channels });
// Availability is a DEPLOYMENT fact (is there a live token on this machine?); this
// suite asserts SHAPE. Without this the scorer reports CHANNEL_UNAVAILABLE and tells
// us nothing about whether the flagship is well-formed.
const CAPS      = { channels: channels.getAll().map(c => ({ ...c, available: true })) };

// ── The spec the converger produces, AFTER the builder resolved the destination ─
// The `fields` are the REAL columns. Getting here without a human typing an id is
// what F exists to do.
const flagship = (over = {}) => ({
  version: 2,
  name: 'Inbound lead triage',
  outcome: {
    statement: 'Every inbound sales email becomes a Leads record with the account and deal size, and a P1 lead is announced in #sales-urgent.',
    assertions: [
      { id: 'a1', kind: 'record_exists', target: 'airtable:Leads', fields: ['Name', 'Account', 'Deal Size', 'Priority'] },
      { id: 'a2', kind: 'message_sent',  target: 'slack:#sales-urgent' },
    ],
  },
  triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
  nodes: [
    { id: 'extract', type: 'llm', label: 'Extract the lead', config: {
      mode: 'extract',
      fields: 'name: the sender\'s name\ncompany: their company\nbudget: the stated budget in dollars',
    } },
    { id: 'score', type: 'decision', label: 'Score it', config: {
      inputs: [{ key: 'budget', type: 'number', from: 'extract.budget' }],
      output: { key: 'priority', type: 'enum', values: ['P1', 'P2', 'P3'] },
      hitPolicy: 'FIRST',
      rules: [
        { when: { budget: '>50000' }, then: 'P1' },
        { when: { budget: '[10000..50000]' }, then: 'P2' },
        { when: { budget: '-' }, then: 'P3' },
      ],
    }, on_error: { retry: 1, then: 'escalate' } },
    { id: 'save', type: 'connector-action', label: 'Save the lead', config: {
      action: 'airtable_create_record',
      baseId: 'appAAAAAAAAAAAAA1',
      tableId: 'Leads',
      // THE REAL COLUMNS — "Deal Size", not "Budget"; "Account", not "Company" — and
      // ONE TEMPLATE PER COLUMN. The first version of this fixture wrote
      // `{{extract.output}}` into every column, which is the WHOLE JSON BLOB in each:
      //     Name = {"name":"Dana","company":"Acme","budget":80000}
      // …and the test passed, because it asserted the KEY was right and never looked
      // at the VALUE. That is the "assert what it SENT, not that it ran" lesson, and it
      // was sitting in the acceptance test for the increment whose entire purpose is
      // this defect. The per-field template grammar ({{step.field}}) exists so that the
      // correct shape is expressible at all. (Found by the independent verifier.)
      fields: { Name: '{{extract.name}}', Account: '{{extract.company}}', 'Deal Size': '{{extract.budget}}', Priority: '{{score.output}}' },
    }, idempotency: { key: '{{extract.output}}', on_conflict: 'skip' } },
    { id: 'announce', type: 'deliver', label: 'Tell #sales-urgent', config: { channel: 'slack', target: '#sales-urgent' } },
  ],
  edges: [
    { from: 'extract', to: 'score' },
    { from: 'score', to: 'save' },
    { from: 'save', to: 'announce' },
  ],
  ...over,
});

// ── 1. The schema is READ, not asked for ────────────────────────────────────

describe('the destination is read from the connector, never pasted', () => {
  test('the tenant\'s real bases are listed', async () => {
    const { bases } = await airtableListBases(airtableApi());
    assert.deepEqual(bases.map(b => b.name), ['Sales CRM', 'Recruiting']);
    assert.match(bases[0].id, /^app[A-Za-z0-9]{14}$/, 'a real base id — the thing no user can recite');
  });

  test('a table\'s REAL columns come back — names, types, and a select\'s closed options', async () => {
    const { tables } = await airtableDescribeBase(airtableApi(), { baseId: 'appAAAAAAAAAAAAA1' });
    const leads = tables.find(t => t.name === 'Leads');
    assert.deepEqual(leads.fields.map(f => f.name), ['Name', 'Account', 'Deal Size', 'Priority']);

    const priority = leads.fields.find(f => f.name === 'Priority');
    assert.deepEqual(priority.choices, ['P1', 'P2', 'P3'],
      'a single-select\'s options are a CLOSED DOMAIN declared by the system of record — the strongest ' +
      'form of the thing §11.7 demands, because nobody guessed it');

    const dealSize = leads.fields.find(f => f.name === 'Deal Size');
    assert.deepEqual(dealSize.choices, [], 'a field with an open domain says so by having no choices');
  });
});

// ── 2. The flagship publishes ───────────────────────────────────────────────

describe('the flagship spec is publishable and complete', () => {
  test('it VALIDATES — every check in the phase, at once', () => {
    const res = validator.validate(flagship());
    assert.equal(res.ok, true,
      `the flagship must publish; got: ${res.errors.map(e => `${e.code}(${e.nodeId ?? 'spec'}: ${e.message})`).join(' | ')}`);
  });

  test('and the converger CERTIFIES it — complete ⇒ publishable', () => {
    const { complete, gaps } = scoreGap(flagship(), { capabilities: CAPS });
    assert.equal(complete, true,
      `unanswered: ${gaps.filter(g => g.resolution === 'unanswered').map(g => g.code).join(', ')}`);
  });

  test('a field the table does NOT have is caught — it is not silently dropped', () => {
    // The defect this whole increment defends against. Airtable ACCEPTS a create
    // with an unknown field name: the record appears, the column is empty, the run
    // says success, and a quarter of leads have no budget before anyone notices.
    // The capability's schema cannot catch it (fields is a free-form object), so the
    // OUTCOME does: the contract promises `Deal Size`, and a spec that writes
    // `Budget` instead does not satisfy it.
    const wrong = flagship();
    wrong.nodes.find(n => n.id === 'save').config.fields = { Name: '{{extract.output}}', Budget: '{{extract.output}}' };

    const res = validator.validate(wrong);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some(e => e.code === 'UNSATISFIED_ASSERTION'),
      `a workflow that promises "Deal Size" and writes "Budget" must not publish; got: ${res.errors.map(e => e.code).join(', ')}`);

    assert.equal(scoreGap(wrong, { capabilities: CAPS }).complete, false,
      'and the converger must not certify it either — otherwise the builder says done and the save button says no');
  });

  test('a hallucinated connector param is rejected (the closed config hole)', () => {
    const bad = flagship();
    bad.nodes.find(n => n.id === 'save').config.tableName = 'Leads';   // Airtable's REST API has one; ours does not
    const res = validator.validate(bad);
    assert.ok(res.errors.some(e => e.code === 'UNKNOWN_CONFIG_KEY' && e.field === 'config.tableName'));
  });
});

// ── 3. …and it RUNS, end to end ─────────────────────────────────────────────

describe('the flagship runs: email in → record + Slack out', () => {
  // A REAL IdempotencyStore, because the flagship WRITES and a write in a workflow
  // must be deduplicated. The engine refuses to run a step that declares an
  // idempotency key with no store wired ("a step that claims to deduplicate and does
  // not is worse than one that never claimed to") — and production wires one
  // (server.js). A harness without one is testing a program nobody runs.
  const dir   = mkdtempSync(join(tmpdir(), 'atlas-flagship-'));
  const store = new IdempotencyStore({ dbPath: join(dir, 'idem.sqlite') }).init();

  const runIt = async (email, { tenantId = 't1' } = {}) => {
    const created = [];
    const posted  = [];
    const registry = {
      get: (id) => ({ id, available: true, configSchema: channels.get(id)?.configSchema ?? [] }),
      getHandler: (id) => async ({ config, body }) => {
        if (id === 'airtable_create_record') { created.push({ table: config.tableId, fields: config.fields }); return { id: 'rec1', created: true }; }
        if (id === 'slack')                  { posted.push(body); return { delivered: true, ts: '1.0' }; }
        throw new Error(`unexpected capability: ${id}`);
      },
    };
    // The extract step returns the lead as JSON; the decision reads `budget` from it.
    const llm = { invoke: async () => ({ content: JSON.stringify(email) }) };
    const tester = new FlowTester({ nodeTypes, channelRegistry: registry, llm, idempotencyStore: store });
    const events = [];
    for await (const e of tester.run(flagship(), { initialContext: email, tenantId, workflowId: 'w1' })) events.push(e);
    return { events, created, posted };
  };

  after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('a $80k lead is scored P1, written to the REAL columns, and announced', async () => {
    const { events, created, posted } = await runIt({ name: 'Dana', company: 'Acme', budget: 80000 });

    assert.equal(events.some(e => e.type === 'run_failed'), false,
      events.find(e => e.type === 'run_failed')?.error ?? '');

    assert.equal(created.length, 1, 'exactly one record');
    assert.equal(created[0].table, 'Leads');
    assert.ok('Deal Size' in created[0].fields,
      'the record must use the column that EXISTS. "Budget" would be accepted by Airtable and silently ignored.');

    // ASSERT THE VALUES, not just the column names. A record whose every column holds
    // the entire extract blob has the right KEYS and is still garbage — and that is
    // exactly what this fixture used to produce, green.
    assert.deepEqual(created[0].fields, {
      Name: 'Dana', Account: 'Acme', 'Deal Size': '80000', Priority: 'P1',
    }, 'each column gets ITS OWN value — not the whole JSON blob in every one');

    assert.equal(posted.length, 1, 'and #sales-urgent was told');
    assert.equal(/"value"|"rule"/.test(String(posted[0])), false,
      'Slack gets the CONTENT, not the decision\'s audit record — a decision is a control node');
  });

  test('a $500 lead is scored P3 — the same table, a different answer', async () => {
    const { created } = await runIt({ name: 'Bo', company: 'Tyre Kickers', budget: 500 });
    assert.equal(created[0].fields.Priority, 'P3');
  });

  test('a RE-FIRED trigger does not write the lead twice', async () => {
    // The flagship writes, and a write in a workflow is the shape that generates
    // support tickets: an email trigger that fires twice creates the customer twice.
    // The spec declares idempotency; this proves the declaration is honoured rather
    // than merely present.
    const lead = { name: 'Rae', company: 'Repeat Ltd', budget: 90000 };
    const first  = await runIt(lead);
    const second = await runIt(lead);
    assert.equal(first.created.length, 1);
    assert.equal(second.created.length, 0, 'the same lead, arriving twice, is written once');
  });

  test('…and one tenant\'s dedupe never silences another\'s', async () => {
    // The cross-tenant leak from Increment B, at the flagship's own write. If the
    // idempotency scope ever loses its tenant, tenant B's identical lead is "already
    // written" — B's record silently never appears, and B's step is handed A's output.
    const lead = { name: 'Rae', company: 'Repeat Ltd', budget: 90000 };   // the SAME lead as above
    const other = await runIt(lead, { tenantId: 't2' });
    assert.equal(other.created.length, 1,
      'tenant t2 has never seen this lead — a dedupe scoped without a tenant would swallow it');
  });

  test('a lead with NO budget FAILS LOUDLY — it never guesses, and never silently drops', async () => {
    // `llm` mode extract returns null for a field it cannot find (its own system
    // prompt says so), and a null must never decide via the catch-all. The step
    // fails, and because the decision carries on_error:escalate, a person is told.
    const { events, created } = await runIt({ name: 'Sam', company: 'Vague Inc', budget: null });
    assert.equal(created.length, 0, 'no record may be written on a lead nobody could score');
    const failed = events.find(e => e.type === 'run_failed');
    assert.ok(failed, 'the run must fail rather than write a P3 lead nobody decided was P3');
    assert.equal(failed.escalated, true, 'and it must reach a person');
  });
});
