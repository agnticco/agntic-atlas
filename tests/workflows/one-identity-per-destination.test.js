/**
 * THE PROMISE AND THE STEP POINT AT ONE THING, SO THEY CANNOT DISAGREE.
 *
 * A destination lives in three vocabularies at once — what the customer says ("my
 * calendar", "Pricing Enquiries"), what the spec stores (`spreadsheetId: 1BxiMVs0…`),
 * and what the promise states (`google:Calendar`) — and until 2026-07-30 those were
 * bridged by comparing STRINGS in more than thirty places, through alias tables, guess
 * lists and canonicalisation. Nine defects came out of that, each costing paid Opus
 * rebuilds and twice a workflow that could not go live.
 *
 * A workflow now carries a table of the destinations it uses. The step that writes
 * there and the promise about it carry the same id, and the oracle compares ids when
 * both sides have one. Two things pointing at one entry cannot disagree about where
 * they mean, because there is only one of it.
 *
 * WHAT THIS FILE IS REALLY GUARDING is that the change is ADDITIVE. Every spec ever
 * stored has string targets and no ids and must behave exactly as before; a promise
 * with an id and a step without must fall back rather than fail. The "nothing stored
 * today breaks" block is doing more work than the rest of the file.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';
import { registerAirtableChannels } from '../../src/connectors/airtable/index.js';
import { setCapabilityCatalog, satisfiesAssertion, sameDestination } from '../../src/workflows/outcome-oracle.js';
import { indexDestinations, destinationKey, isPinnable } from '../../src/workflows/destinations.js';
import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { productionCatalog } from '../helpers/prod-catalog.js';

// Constructed the way PRODUCTION does — node types AND the capability catalog. A
// validator built without them tests a program nobody runs, which this repo has been
// bitten by before.
const validator = new WorkflowValidator({
  nodeTypes: registerBuiltInNodeTypes(new NodeTypeRegistry()),
  channelRegistry: productionCatalog(),
});

function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  registerAirtableChannels(reg);
  setCapabilityCatalog(reg);
}

/** The cybersecurity briefing that passed on prod and went live. */
const GOOD = () => ({
  name: 'Daily cyber briefing',
  triggers: [{ type: 'schedule', cron: '0 7 * * 1-5', timezone: 'America/Chicago' }],
  outcome: {
    statement: 'Email the briefing to hello@agntic.co.',
    assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' }],
  },
  nodes: [
    { id: 'sum', type: 'llm', label: 'Summarise', config: { mode: 'summarize', instructions: 'x' } },
    { id: 'mail', type: 'deliver', label: 'Email', config: { channel: 'gmail_send', to: 'hello@agntic.co', subject: 's' } },
  ],
  edges: [{ from: 'sum', to: 'mail' }],
});

describe('one destination, one identity', () => {
  test('the step and the promise are stamped with the SAME id', () => {
    catalog();
    const { spec } = indexDestinations(GOOD());
    const node = spec.nodes.find(n => n.id === 'mail');
    const a = spec.outcome.assertions[0];
    assert.ok(a.destinationId, 'the promise was not stamped');
    assert.deepEqual(node.destinationIds, [a.destinationId]);
  });

  test('the table records what and where', () => {
    catalog();
    const { destinations } = indexDestinations(GOOD());
    assert.equal(destinations.length, 1);
    assert.equal(destinations[0].connector, 'gmail');
    assert.equal(destinations[0].locator, 'hello@agntic.co');
  });

  test('two steps writing to one place share the entry', () => {
    catalog();
    const spec = GOOD();
    spec.nodes.push({ id: 'mail2', type: 'deliver', label: 'Email again', config: { channel: 'gmail_send', to: 'hello@agntic.co', subject: 't' } });
    const out = indexDestinations(spec);
    assert.equal(out.destinations.length, 1, 'one place, one entry');
    assert.deepEqual(out.spec.nodes.find(n => n.id === 'mail').destinationIds,
                     out.spec.nodes.find(n => n.id === 'mail2').destinationIds);
  });

  test('spelling does not create a second entry', () => {
    // "#ops" and "ops", "Hello@" and "hello@" — the reason names were never a safe key.
    catalog();
    assert.equal(destinationKey('slack', '#Ops'), destinationKey('slack', 'ops'));
    assert.equal(destinationKey('google_tasks', 'My Tasks'), destinationKey('tasks', 'my tasks'));
  });

  test('a write inside a loop is indexed too', () => {
    catalog();
    const spec = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Leads' }] },
      nodes: [{ id: 'loop', type: 'foreach', config: { steps: [
        { id: 's', type: 'deliver', label: 'Add row', config: { channel: 'sheets_append', spreadsheetId: 'Leads', range: 'A:C' } },
      ] } }],
      edges: [],
    };
    const { spec: out } = indexDestinations(spec);
    const inner = out.nodes[0].config.steps[0];
    assert.ok(inner.destinationIds?.length, 'the loop was not walked into');
    assert.equal(out.outcome.assertions[0].destinationId, inner.destinationIds[0]);
  });
});

describe('the oracle prefers identity over spelling', () => {
  test('matching ids settle it, whatever the names look like', () => {
    catalog();
    // The promise is written in a spelling the string rules would have to work at;
    // the id makes the question trivial.
    const node = { id: 'm', type: 'deliver', destinationIds: ['d1'],
                   config: { channel: 'gmail_send', to: 'hello@agntic.co', subject: 's' } };
    const a = { id: 'a1', kind: 'message_sent', target: 'google:whatever-this-says', destinationId: 'd1' };
    assert.equal(satisfiesAssertion(a, node), true);
  });

  test('DIFFERENT ids are a definite mismatch', () => {
    catalog();
    const node = { id: 'm', type: 'deliver', destinationIds: ['d2'],
                   config: { channel: 'gmail_send', to: 'charles@agntic.co', subject: 's' } };
    const a = { id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co', destinationId: 'd1' };
    assert.equal(satisfiesAssertion(a, node), false,
      'this is the AI-news defect, and now it is structural rather than a string comparison');
  });

  test('but the KIND still decides first', () => {
    // Sharing a destination must not make a promise to SEND satisfiable by a row
    // written to the same place.
    catalog();
    const node = { id: 'r', type: 'deliver', destinationIds: ['d1'],
                   config: { channel: 'sheets_append', spreadsheetId: 'Leads', range: 'A:C' } };
    const a = { id: 'a1', kind: 'message_sent', target: 'sheets:Leads', destinationId: 'd1' };
    assert.equal(satisfiesAssertion(a, node), false);
  });

  test('an approval step is still judged as an ask, not by id', () => {
    catalog();
    const ask = { id: 'ask', type: 'human', destinationIds: ['d9'],
                  config: { prompt: 'ok?', channels: [{ type: 'slack', target: '#ops' }] } };
    assert.equal(satisfiesAssertion({ id: 'a1', kind: 'message_sent', target: 'slack:#ops', destinationId: 'd1' }, ask), true);
  });
});

describe('NOTHING STORED TODAY BREAKS', () => {
  // The block that matters most. Every spec in the database has string targets and no
  // ids, and must behave exactly as it did yesterday.

  test('a spec with no ids anywhere is judged by the old rules', () => {
    catalog();
    const node = { id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'hello@agntic.co', subject: 's' } };
    assert.equal(satisfiesAssertion({ id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' }, node), true);
    assert.equal(satisfiesAssertion({ id: 'a1', kind: 'message_sent', target: 'gmail:someone@else.co' }, node), false);
  });

  test('a promise WITH an id and a step without falls back, never fails', () => {
    // The mixed case a half-migrated spec produces. Answering "no" here would fail
    // correct workflows the moment anything was stamped.
    catalog();
    const node = { id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: 'hello@agntic.co', subject: 's' } };
    const a = { id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co', destinationId: 'd1' };
    assert.equal(sameDestination(a, node), null, 'undecidable, and it must SAY so');
    assert.equal(satisfiesAssertion(a, node), true, 'it must fall through to the string rules');
  });

  test('a step WITH ids and a promise without also falls back', () => {
    catalog();
    const node = { id: 'm', type: 'deliver', destinationIds: ['d1'],
                   config: { channel: 'gmail_send', to: 'hello@agntic.co', subject: 's' } };
    assert.equal(sameDestination({ id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' }, node), null);
    assert.equal(satisfiesAssertion({ id: 'a1', kind: 'message_sent', target: 'gmail:hello@agntic.co' }, node), true);
  });

  test('an indexed spec still PUBLISHES', () => {
    // The first cut of this put the ids inside `node.config`, where an undeclared key
    // is a hard publish failure (`UNKNOWN_CONFIG_KEY`) — it made every workflow in the
    // product unpublishable, and the full suite caught it. The id is bookkeeping ABOUT
    // a step, not a parameter OF it.
    catalog();
    const { spec } = indexDestinations(GOOD());
    const issues = validator.validate(spec).errors;
    assert.deepEqual(issues.map(i => i.code), [], JSON.stringify(issues));
  });

  test('…and the ids are NOT in any node config', () => {
    catalog();
    const { spec } = indexDestinations(GOOD());
    for (const n of spec.nodes) {
      assert.ok(!('destinationIds' in (n.config ?? {})), `${n.id} carries it in config`);
    }
  });
});

describe('what it refuses to give an identity to', () => {
  test('a template destination gets none', () => {
    // It resolves only at run time, so two different real destinations would share one
    // id — worse than having none. It keeps the old undecidable-and-honest behaviour.
    catalog();
    assert.equal(isPinnable('{{extract.sender}}'), false);
    const spec = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'gmail:{{extract.sender}}' }] },
      nodes: [{ id: 'm', type: 'deliver', config: { channel: 'gmail_send', to: '{{extract.sender}}', subject: 's' } }],
      edges: [],
    };
    const { spec: out, destinations } = indexDestinations(spec);
    assert.deepEqual(destinations, []);
    assert.equal(out.outcome.assertions[0].destinationId, undefined);
    assert.equal(out.nodes[0].destinationIds, undefined);
  });

  test('an empty locator gets none', () => {
    assert.equal(isPinnable(''), false);
    assert.equal(isPinnable('   '), false);
  });

  test('A STALE PROMISE IS LEFT WITHOUT ONE, DELIBERATELY', () => {
    // The Sheets defect: the promise named "Pricing Emails" and the step wrote to
    // "Pricing Enquiries". Inventing an entry for the promise would give it an identity
    // of its own and make it look settled — when "this names somewhere no step goes" is
    // exactly the finding that has to survive.
    catalog();
    const spec = {
      outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Pricing Emails' }] },
      nodes: [{ id: 'r', type: 'deliver', config: { channel: 'sheets_append', spreadsheetId: 'Pricing Enquiries', range: 'A:E' } }],
      edges: [],
    };
    const { spec: out, destinations } = indexDestinations(spec);
    assert.equal(out.outcome.assertions[0].destinationId, undefined, 'the stale promise must stay unstamped');
    assert.equal(destinations.length, 1, 'only the place a step actually writes is a destination');
    assert.equal(destinations[0].locator, 'Pricing Enquiries');
  });

  test('junk in does not throw', () => {
    catalog();
    for (const spec of [null, undefined, {}, { nodes: null }, { nodes: [null, 'x'], outcome: { assertions: [null] } }]) {
      assert.doesNotThrow(() => indexDestinations(spec), JSON.stringify(spec));
    }
  });

  test('the table TRAVELS with the spec, not just the ids', () => {
    // Confirmed missing on prod 2026-07-30: the build carried the table, the client was
    // handed `undefined`, because the walkthrough builds its payload from an explicit
    // field list. The ids on nodes and assertions rode along (they are fields on those
    // objects) so comparison worked — but the table is what SAYS what `d1` IS, and a
    // published workflow kept the references while losing what they refer to.
    const src = readFileSync(new URL('../../src/converger/elicitation-graph.js', import.meta.url), 'utf8');
    const at = src.indexOf("type: 'generated_workflow',");
    assert.ok(at > 0, 're-point this test');
    assert.match(src.slice(at, at + 1200), /destinations: finalDraft\.destinations/);
  });

  test('it never edits a locator or moves a destination', () => {
    catalog();
    const before = GOOD();
    const { spec: after } = indexDestinations(before);
    assert.equal(after.nodes.find(n => n.id === 'mail').config.to, 'hello@agntic.co');
    assert.equal(after.outcome.assertions[0].target, 'gmail:hello@agntic.co');
    assert.equal(after.outcome.statement, before.outcome.statement);
  });
});
