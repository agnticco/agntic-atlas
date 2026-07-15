/**
 * The whole-spec generation step. (Converger rearchitecture, Increment 2.)
 *
 * The one-component-at-a-time propose loop reliably emitted visible NODES but
 * dropped invisible EDGES, so branches never branched and classifiers dangled
 * (docs/handoff/converger-rearchitecture.md). Increment 2 emits the COMPLETE spec
 * in one call and then guarantees structure with `wireEdges` (Increment 1). These
 * tests prove:
 *   1. the prompt teaches the branch-wiring the loop kept getting wrong, and
 *   2. the pure merge helper turns a lead-router-shaped model output — even with a
 *      branch INPUT edge missing — into a connected, branch-fed spec with no orphan.
 *
 * No live model: the prompt test is pure, and the merge helper is fed a hand-built
 * model output.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';

import { buildGeneratePrompt } from '../../src/converger/prompts.js';
import { mergeGeneratedSpec }  from '../../src/converger/elicitation-graph.js';

const has = (edges, from, to) => edges.some(e => e.from === from && e.to === to);

// ── The prompt ───────────────────────────────────────────────────────────────

describe('buildGeneratePrompt', () => {
  const prompt = buildGeneratePrompt({
    intent: 'route inbound leads',
    clarifications: [{ q: 'trigger?', a: 'email' }],
    outcome: { statement: 'Leads are routed.', assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#sales' }] },
    draft: { triggers: [{ type: 'email', filter: 'to:leads@acme.com' }], nodes: [] },
    capabilities: {},
    setupResults: {},
  });

  test('returns a string', () => {
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 200);
  });

  test('asks for the WHOLE spec as one { triggers, nodes, edges } object', () => {
    assert.match(prompt, /"triggers"/);
    assert.match(prompt, /"nodes"/);
    assert.match(prompt, /"edges"/);
    assert.match(prompt, /COMPLETE workflow in ONE/i);
  });

  test('teaches the branch-wiring the propose loop kept dropping', () => {
    // Every non-entry node has an inbound edge; the entry node has none.
    assert.match(prompt, /every node except the entry/i);
    assert.match(prompt, /inbound edge/i);
    // The router shape: classify → branch → each lane, with BOTH the input edge and
    // one output edge per case.
    assert.match(prompt, /classify.*branch|branch.*classify/is);
    assert.match(prompt, /INPUT edge/i);
    assert.match(prompt, /OUTPUT edge/i);
    assert.match(prompt, /catch-all/i);
  });

  test('teaches the moat: route only on a closed, declared domain', () => {
    assert.match(prompt, /closed.*domain|domain.*closed/is);
    assert.match(prompt, /classify/i);
    assert.match(prompt, /freeform|prose/i);
  });

  test('teaches exactly one delivery per destination, and no invented ids', () => {
    assert.match(prompt, /ONE delivery node per distinct destination/i);
    assert.match(prompt, /never invent|do not invent|NEVER invent/i);
  });

  test('carries the outcome contract and the already-derived trigger forward', () => {
    assert.match(prompt, /Leads are routed\./);
    assert.match(prompt, /to:leads@acme\.com/);
  });

  test('does not crash on empty/absent args', () => {
    assert.equal(typeof buildGeneratePrompt(), 'string');
    assert.equal(typeof buildGeneratePrompt({ intent: 'x' }), 'string');
  });
});

// ── The merge helper ─────────────────────────────────────────────────────────

describe('mergeGeneratedSpec — a lead-router model output becomes a connected, branched spec', () => {
  // Exactly the failure this rearchitecture fixes: the model emitted the branch's
  // OUTPUT edges and the lane chains, but DROPPED the branch's INPUT edge
  // (classify→route) and the trigger→entry. wireEdges must add classify→route so the
  // branch is fed and the classifier is not orphaned.
  const draft = {
    name: 'Lead Router',
    description: 'routes leads',
    outcome: { statement: 'Leads are routed to the right channel.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#sales' }] },
    triggers: [{ type: 'email', filter: 'to:leads@acme.com' }],
    nodes: [],
    edges: [],
    errorHandling: { retry: 1 },
  };

  const generated = {
    // A DIFFERENT trigger than the draft's — to prove the draft's is preferred.
    triggers: [{ type: 'schedule', cron: '0 9 * * *' }],
    nodes: [
      { id: 'classify_lead', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'hot\nwarm\ncold' } },
      { id: 'route', type: 'branch', label: 'Route',
        config: { on: 'classify_lead.output', cases: [
          { when: 'hot',  to: 'summ_hot' },
          { when: 'warm', to: 'summ_hot' },
          { when: '*',    to: 'log_cold' },
        ] } },
      { id: 'summ_hot', type: 'llm', label: 'Summarize', config: { mode: 'summarize' } },
      { id: 'log_cold', type: 'llm', label: 'Note', config: { mode: 'summarize', length: 'short' } },
      { id: 'notify_sales', type: 'deliver', label: 'Post #sales', config: { channel: 'slack', target: '#sales' } },
      { id: 'notify_ops',   type: 'deliver', label: 'Post #ops',   config: { channel: 'slack', target: '#ops' } },
    ],
    edges: [
      // NOTE: classify_lead→route is DELIBERATELY MISSING (the live defect).
      { from: 'route', to: 'summ_hot' },
      { from: 'route', to: 'log_cold' },
      { from: 'summ_hot', to: 'notify_sales' },
      { from: 'log_cold', to: 'notify_ops' },
    ],
  };

  const merged = mergeGeneratedSpec(draft, generated);

  test('the dropped branch INPUT edge is wired — the branch is fed', () => {
    assert.ok(has(merged.edges, 'classify_lead', 'route'),
      'wireEdges must add classify→branch even though the model dropped it');
  });

  test('the classifier is NOT orphaned (it has an outbound edge)', () => {
    assert.ok(merged.edges.some(e => e.from === 'classify_lead'),
      'classify has an outbound edge, so it is reachable-forward and not a dead node');
  });

  test('no non-entry node is an orphan — every node but the entry has an inbound edge', () => {
    const entry = 'classify_lead';   // fed by the trigger, has no inbound edge by design
    const hasInbound = (id) => merged.edges.some(e => e.to === id);
    for (const n of merged.nodes) {
      if (n.id === entry) {
        assert.equal(hasInbound(n.id), false, 'the entry node is fed by the trigger, not an edge');
      } else {
        assert.ok(hasInbound(n.id), `${n.id} must have an inbound edge (no orphan)`);
      }
    }
  });

  test('both lanes stay routed (a real 2-lane branch)', () => {
    assert.ok(has(merged.edges, 'route', 'summ_hot'), 'lane A routed');
    assert.ok(has(merged.edges, 'route', 'log_cold'), 'lane B routed');
  });

  test('the generated nodes become the draft nodes', () => {
    assert.deepEqual(merged.nodes.map(n => n.id).sort(),
      ['classify_lead', 'log_cold', 'notify_ops', 'notify_sales', 'route', 'summ_hot'].sort());
  });

  test('the already-gathered outcome, name and errorHandling are PRESERVED', () => {
    assert.equal(merged.outcome.statement, 'Leads are routed to the right channel.');
    assert.equal(merged.name, 'Lead Router');
    assert.equal(merged.description, 'routes leads');
    assert.deepEqual(merged.errorHandling, { retry: 1 });
  });

  test('the draft trigger is PREFERRED over the generated one', () => {
    assert.deepEqual(merged.triggers, [{ type: 'email', filter: 'to:leads@acme.com' }],
      'process already derived and confirmed the trigger; the example picker searched on its filter');
  });
});

describe('mergeGeneratedSpec — edge cases', () => {
  test('falls back to the generated trigger when the draft has none', () => {
    const merged = mergeGeneratedSpec(
      { triggers: [], nodes: [], edges: [] },
      { triggers: [{ type: 'manual' }], nodes: [{ id: 'a', type: 'deliver', config: {} }], edges: [] },
    );
    assert.deepEqual(merged.triggers, [{ type: 'manual' }]);
  });

  test('a decision node gets its input edges wired from config.inputs[].from', () => {
    const merged = mergeGeneratedSpec(
      { triggers: [{ type: 'email' }], nodes: [], edges: [] },
      { nodes: [
        { id: 'extract', type: 'llm', config: { mode: 'extract' } },
        { id: 'score', type: 'decision', config: {
          inputs: [{ key: 'budget', from: 'extract.budget' }],
          output: { key: 'tier', values: ['A', 'B'] } } },
      ], edges: [] },
    );
    assert.ok(has(merged.edges, 'extract', 'score'), 'decision input edge wired from its declared input');
  });

  test('is pure — does not mutate the input draft', () => {
    const draft = { triggers: [{ type: 'email' }], nodes: [], edges: [], outcome: null };
    const snapshot = JSON.stringify(draft);
    mergeGeneratedSpec(draft, { nodes: [{ id: 'x', type: 'deliver', config: {} }], edges: [] });
    assert.equal(JSON.stringify(draft), snapshot, 'the source draft is untouched');
  });

  test('handles a null/empty generated output without throwing', () => {
    const draft = { triggers: [{ type: 'email' }], nodes: [], edges: [] };
    assert.doesNotThrow(() => mergeGeneratedSpec(draft, null));
    const merged = mergeGeneratedSpec(draft, {});
    assert.deepEqual(merged.nodes, []);
    assert.deepEqual(merged.triggers, [{ type: 'email' }]);
  });
});
