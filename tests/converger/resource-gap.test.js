/**
 * RESOURCE_NOT_FOUND — the converger must never wire a workflow to a resource that does
 * not exist in the tenant's connected account (Increment #25).
 *
 * These pin the GAP SCORER's half: given a spec + the live lists builder.js fetched onto
 * `capabilities` (slackChannels, airtableSchema, connectors), a wire to a channel/base/
 * table the tenant doesn't have is a BLOCKING gap — and an EXISTING one is not. The
 * create-or-pick RESOLUTION (elicitation-graph.js `gaps`/`resourceSetup`) is exercised
 * end-to-end in graph-paths.test.js; here we prove the detector and the fail-closed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreGap, unansweredGaps } from '../../src/converger/gap-scorer.js';
import { buildSystemPrompt } from '../../src/converger/prompts.js';

// The delivery catalog, shaped like `capabilities.channels`, so the spec is otherwise
// complete (the validator's channel checks pass). Same shape as gap-oracle.test.js.
const CHANNELS = [
  { id: 'slack',                  available: true, configSchema: [{ key: 'target' }] },
  { id: 'gmail_send',             available: true, configSchema: [{ key: 'to' }, { key: 'subject' }] },
  { id: 'inbox_deliver',          available: true, configSchema: [{ key: 'subject' }] },
  { id: 'airtable_create_record', available: true, configSchema: [{ key: 'baseId' }, { key: 'tableId' }, { key: 'fields' }] },
];

// A live builder session (connectors present) with both connectors connected.
const caps = (over = {}) => ({
  channels: CHANNELS,
  connectors: { slack: { connected: true }, airtable: { connected: true } },
  slackChannels: ['general', 'logistics', 'random'],
  airtableSchema: [
    { id: 'app1', name: 'CRM', tables: [{ id: 'tblL', name: 'Leads', fields: [{ name: 'Name' }] }] },
  ],
  ...over,
});

const score = (spec, c = caps()) => scoreGap(spec, { capabilities: c });
const codes = (r) => r.gaps.map(g => g.code);
const resourceGap = (r) => r.gaps.find(g => g.code === 'RESOURCE_NOT_FOUND');

// A Slack workflow, complete except for its channel target.
const slackSpec = (target) => ({
  version: 2, name: 'UPS digest',
  outcome: {
    statement: `Summarize into ${target}.`,
    assertions: [{ id: 'a1', kind: 'message_sent', target: `slack:${target}` }],
    examples: [],
  },
  triggers: [{ type: 'email', filter: 'from:ups.com' }],
  nodes: [
    { id: 'sum',  type: 'llm', label: 'Summarize', config: { mode: 'summarize', instructions: 'Summarize.' } },
    { id: 'post', type: 'deliver', label: 'Post', config: { channel: 'slack', target } },
  ],
  edges: [{ from: 'sum', to: 'post' }],
});

// An Airtable write workflow (deliver-shaped, how the converger emits it).
const airtableSpec = (config) => ({
  version: 2, name: 'Lead capture',
  outcome: { assertions: [{ id: 'a1', kind: 'record_exists', target: 'airtable:Leads' }], examples: [] },
  triggers: [{ type: 'email' }],
  nodes: [{ id: 'save', type: 'deliver', label: 'Save', config }],
  edges: [],
});

describe('the system prompt DEFERS channel existence to the deterministic gap', () => {
  // If the model preempts with its own free-text clarification about a missing channel,
  // the user gets a blank text box and NO list of real channels — the buttons the
  // RESOURCE_NOT_FOUND surface renders never appear. So the prompt must tell the model to
  // BUILD the deliver and let the builder verify, not to ask or propose a setup action.
  const prompt = buildSystemPrompt({ slackChannels: ['ops', 'general'] });

  test('lists the existing channels as context', () => {
    assert.match(prompt, /#ops/);
    assert.match(prompt, /#general/);
  });

  test('does NOT tell the model to propose a slack_create_channel setup for a missing channel', () => {
    assert.doesNotMatch(prompt, /MUST propose a "slack_create_channel"/i);
    assert.doesNotMatch(prompt, /must be created FIRST via a "slack_create_channel"/i);
  });

  test('tells the model to build the deliver and let the builder verify', () => {
    assert.match(prompt, /do NOT ask/i);
    assert.match(prompt, /builder verifies|builder checks/i);
  });
});

describe('Slack channel existence', () => {
  test('a channel NOT in slackChannels → a BLOCKING RESOURCE_NOT_FOUND gap', () => {
    const r = score(slackSpec('#does-not-exist-xyz'));
    const g = resourceGap(r);
    assert.ok(g, `expected RESOURCE_NOT_FOUND; got: ${codes(r).join(', ')}`);
    assert.equal(g.blocking, true);
    assert.equal(g.resolution, 'unanswered');
    assert.equal(r.complete, false, 'a spec with a missing resource must not be complete');
    // Carries what the resolver UI needs.
    assert.equal(g.resource.kind, 'slack_channel');
    assert.equal(g.resource.name, 'does-not-exist-xyz');
    assert.equal(g.resource.canCreate, true);
    assert.equal(g.resource.createCapabilityId, 'slack_create_channel');
    assert.deepEqual(g.resource.options.map(o => o.value), ['general', 'logistics', 'random']);
  });

  test('a channel that DOES exist → no resource gap, and the spec is complete', () => {
    const r = score(slackSpec('#logistics'));
    assert.equal(resourceGap(r), undefined, `got: ${codes(r).join(', ')}`);
    assert.equal(r.complete, true);
  });

  test('case-insensitive: #Logistics matches logistics', () => {
    const r = score(slackSpec('#Logistics'));
    assert.equal(resourceGap(r), undefined);
  });

  test('a templated target ({{…}}) is resolved at run time — never flagged', () => {
    const r = score(slackSpec('{{route.output}}'));
    assert.equal(resourceGap(r), undefined);
  });
});

describe('fail-closed when the live list did not load', () => {
  test('connected + a Slack ref + NO slackChannels → RESOURCE_UNVERIFIED (blocking), not a silent pass', () => {
    const r = score(slackSpec('#logistics'), caps({ slackChannels: undefined }));
    assert.ok(codes(r).includes('RESOURCE_UNVERIFIED'), `got: ${codes(r).join(', ')}`);
    assert.equal(r.complete, false);
  });

  test('connected + an Airtable ref + NO airtableSchema → RESOURCE_UNVERIFIED (blocking)', () => {
    const spec = airtableSpec({ channel: 'airtable_create_record', baseId: 'app1', tableId: 'Leads', fields: { Name: 'x' } });
    const r = score(spec, caps({ airtableSchema: undefined }));
    assert.ok(codes(r).includes('RESOURCE_UNVERIFIED'), `got: ${codes(r).join(', ')}`);
    assert.equal(r.complete, false);
  });
});

describe('NON-BREAKING: verification is opt-in on a live session', () => {
  test('a bare catalog (no connectors key) never adds a resource gap, even for a missing channel', () => {
    const bare = { channels: CHANNELS };            // the 200+ existing-suite shape
    const r = scoreGap(slackSpec('#does-not-exist-xyz'), { capabilities: bare });
    assert.equal(resourceGap(r), undefined, `got: ${codes(r).join(', ')}`);
    assert.ok(!codes(r).includes('RESOURCE_UNVERIFIED'));
    assert.equal(r.complete, true, 'the pre-#25 behaviour must be preserved exactly');
  });

  test('a disconnected connector is left to CHANNEL_UNAVAILABLE, not double-flagged here', () => {
    const c = caps({ connectors: { slack: { connected: false }, airtable: { connected: true } } });
    const r = score(slackSpec('#does-not-exist-xyz'), c);
    assert.equal(resourceGap(r), undefined, 'no RESOURCE gap when the connector isn\'t connected');
  });
});

describe('Airtable base / table existence', () => {
  test('a base the tenant does NOT have → RESOURCE_NOT_FOUND (pick-only, no create)', () => {
    const spec = airtableSpec({ channel: 'airtable_create_record', baseId: 'appZZZZZZZZZZZZZZ', tableId: 'Leads', fields: { Name: 'x' } });
    const g = resourceGap(score(spec));
    assert.ok(g);
    assert.equal(g.resource.kind, 'airtable_base');
    assert.equal(g.resource.canCreate, false);
    assert.equal(g.resource.createCapabilityId, null);
    assert.deepEqual(g.resource.options.map(o => o.label), ['CRM']);
  });

  test('a real base but a MISSING table → RESOURCE_NOT_FOUND (airtable_table)', () => {
    const spec = airtableSpec({ channel: 'airtable_create_record', baseId: 'app1', tableId: 'Nonexistent', fields: { Name: 'x' } });
    const g = resourceGap(score(spec));
    assert.ok(g);
    assert.equal(g.resource.kind, 'airtable_table');
    assert.equal(g.resource.baseId, 'app1');
    assert.deepEqual(g.resource.options.map(o => o.value), ['Leads']);
  });

  test('a real base + real table → no resource gap', () => {
    const spec = airtableSpec({ channel: 'airtable_create_record', baseId: 'app1', tableId: 'Leads', fields: { Name: 'x' } });
    assert.equal(resourceGap(score(spec)), undefined);
  });

  test('base matched by NAME as well as id', () => {
    const spec = airtableSpec({ channel: 'airtable_create_record', baseId: 'CRM', tableId: 'Leads', fields: { Name: 'x' } });
    assert.equal(resourceGap(score(spec)), undefined);
  });
});

describe('resources inside a foreach are checked too', () => {
  test('a Slack post to a missing channel inside a foreach → RESOURCE_NOT_FOUND', () => {
    const spec = {
      version: 2, name: 'Fan out',
      outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#logistics' }], examples: [] },
      triggers: [{ type: 'email' }],
      nodes: [
        { id: 'rows', type: 'connector-action', label: 'List', config: { action: 'airtable_list_records', baseId: 'app1', tableId: 'Leads' } },
        { id: 'loop', type: 'foreach', label: 'Each', config: { over: 'rows.output', steps: [
          { id: 'ping', type: 'deliver', label: 'Ping', config: { channel: 'slack', target: '#ghost-channel' } },
        ] } },
      ],
      edges: [{ from: 'rows', to: 'loop' }],
    };
    const g = resourceGap(score(spec));
    assert.ok(g, `expected a resource gap for the in-loop deliver; got: ${codes(score(spec)).join(', ')}`);
    assert.equal(g.resource.name, 'ghost-channel');
    assert.equal(g.nodeId, 'ping');
  });
});

describe('a resolved resource CLEARS the gap on re-score', () => {
  test('repointing the target at an existing channel clears it', () => {
    const before = score(slackSpec('#does-not-exist-xyz'));
    assert.ok(resourceGap(before));
    const after = score(slackSpec('#logistics'));                 // the PICK outcome
    assert.equal(resourceGap(after), undefined);
    assert.equal(after.complete, true);
  });

  test('optimistically adding the created channel to slackChannels clears it (the CREATE outcome)', () => {
    const spec = slackSpec('#newly-made');
    assert.ok(resourceGap(score(spec)));
    const withCreated = caps({ slackChannels: ['general', 'logistics', 'random', 'newly-made'] });
    const after = score(spec, withCreated);
    assert.equal(resourceGap(after), undefined);
    assert.equal(after.complete, true);
  });
});
