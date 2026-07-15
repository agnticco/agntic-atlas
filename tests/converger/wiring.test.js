import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireEdges, refNodeId } from '../../src/converger/spec-assembler.js';

const has = (edges, from, to) => edges.some(e => e.from === from && e.to === to);

test('refNodeId extracts the base id from every reference form', () => {
  assert.equal(refNodeId('classify_email.output'), 'classify_email');
  assert.equal(refNodeId('{{ ask.decision }}'), 'ask');
  assert.equal(refNodeId('{{extract.budget}}'), 'extract');
  assert.equal(refNodeId('route_lead'), 'route_lead');
  assert.equal(refNodeId(null), null);
  assert.equal(refNodeId(''), null);
});

test('the live defect: a branch missing its input edge gets classify→branch wired', () => {
  // Exactly the shape observed live: the model emitted the branch's OUTPUT edges
  // and the lane chains, but never classify→route_lead, so classify was orphaned
  // and the branch had no feed.
  const draft = {
    triggers: [{ type: 'email' }],
    nodes: [
      { id: 'classify_email', type: 'llm', config: { mode: 'classify', categories: ['lead', 'other'] } },
      { id: 'route_lead', type: 'branch', config: { on: 'classify_email.output', cases: [
        { when: 'lead', to: 'extract_lead' }, { when: '*', to: 'summarize_email' },
      ] } },
      { id: 'extract_lead', type: 'llm', config: { mode: 'extract' } },
      { id: 'summarize_email', type: 'llm', config: { mode: 'summarize' } },
      { id: 'create_crm', type: 'deliver', config: { channel: 'airtable_create_record' } },
      { id: 'inbox', type: 'deliver', config: { channel: 'in_app' } },
    ],
    edges: [
      { from: 'route_lead', to: 'extract_lead' },
      { from: 'route_lead', to: 'summarize_email' },
      { from: 'extract_lead', to: 'create_crm' },
      { from: 'summarize_email', to: 'inbox' },
    ],
  };

  const { edges } = wireEdges(draft);

  // the missing structural edge is now present — the branch is fed
  assert.ok(has(edges, 'classify_email', 'route_lead'), 'classify→branch input edge added');
  // classify is no longer orphaned (it has an outbound edge)
  assert.ok(edges.some(e => e.from === 'classify_email'), 'classify has an outbound edge');
  // both lanes still routed (a real 2-lane branch)
  assert.ok(has(edges, 'route_lead', 'extract_lead'), 'lane A wired');
  assert.ok(has(edges, 'route_lead', 'summarize_email'), 'lane B wired');
});

test('branch outputs are guaranteed even if the model dropped them', () => {
  const draft = {
    nodes: [
      { id: 'c', type: 'llm', config: { mode: 'classify', categories: ['a', 'b'] } },
      { id: 'b', type: 'branch', config: { on: 'c.output', cases: [
        { when: 'a', to: 'x' }, { when: '*', to: 'y' },
      ] } },
      { id: 'x', type: 'deliver', config: {} },
      { id: 'y', type: 'deliver', config: {} },
    ],
    edges: [], // model emitted NOTHING structural
  };
  const { edges } = wireEdges(draft);
  assert.ok(has(edges, 'c', 'b'), 'input wired');
  assert.ok(has(edges, 'b', 'x'), 'output A wired');
  assert.ok(has(edges, 'b', 'y'), 'output B wired');
});

test('a decision gets an input edge from each of its declared inputs', () => {
  const draft = {
    nodes: [
      { id: 'extract', type: 'llm', config: { mode: 'extract' } },
      { id: 'dec', type: 'decision', config: { inputs: [
        { key: 'tier', from: 'extract.output' }, { key: 'sev', from: 'extract.output' },
      ], output: { key: 'priority', values: ['P1', 'P2'] } } },
    ],
    edges: [],
  };
  const { edges } = wireEdges(draft);
  assert.ok(has(edges, 'extract', 'dec'), 'decision input edge wired');
});

test('additive: existing edges are preserved and never duplicated', () => {
  const draft = {
    nodes: [
      { id: 'c', type: 'llm', config: { mode: 'classify', categories: ['a', 'b'] } },
      { id: 'b', type: 'branch', config: { on: 'c.output', cases: [{ when: '*', to: 'x' }] } },
      { id: 'x', type: 'deliver', config: {} },
    ],
    edges: [{ from: 'c', to: 'b' }, { from: 'b', to: 'x' }],
  };
  const { edges } = wireEdges(draft);
  assert.equal(edges.filter(e => e.from === 'c' && e.to === 'b').length, 1, 'no duplicate input edge');
  assert.equal(edges.filter(e => e.from === 'b' && e.to === 'x').length, 1, 'no duplicate output edge');
});

test('never wires to a non-existent node or a self-loop', () => {
  const draft = {
    nodes: [
      { id: 'b', type: 'branch', config: { on: 'ghost.output', cases: [{ when: '*', to: 'b' }, { when: 'x', to: 'missing' }] } },
    ],
    edges: [],
  };
  const { edges } = wireEdges(draft);
  assert.equal(edges.length, 0, 'no edge to a missing source, self, or missing target');
});
