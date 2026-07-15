/**
 * #19 — the builder auto-repairs its OWN structural bugs (zero-typing).
 *
 * A missing branch/route edge, or an ambiguous extra parent edge, is a defect in
 * the graph the converger drew — not a decision a user can make. The validator
 * computes the exact mechanical fix and carries it as `gap.fix`; the gaps node
 * applies it directly (no LLM, no question) and re-scores. This suite pins that:
 *
 *   1. the structural codes carry a machine-applicable `fix`,
 *   2. applying it makes an otherwise-stranded spec COMPLETE and publishable,
 *   3. a re-score follows, so a repair can't ship a new problem silently,
 *   4. gaps with NO fix (genuine decisions) are left untouched.
 *
 * These are the gaps that, before #19, left the build at "Incomplete" with Run
 * test disabled — the dominant live-testing failure. A green run here means the
 * zero-typing path clears them without the user typing anything.
 */

import { test, describe }        from 'node:test';
import assert                    from 'node:assert/strict';
import { scoreGap, unansweredGaps } from '../../src/converger/gap-scorer.js';
import { autoRepairStructural }  from '../../src/converger/elicitation-graph.js';

const CAPS = { channels: [
  { id: 'slack',         available: true, configSchema: [{ key: 'target' }] },
  { id: 'inbox_deliver', available: true, configSchema: [{ key: 'subject' }] },
] };

const score = (spec) => scoreGap(spec, { capabilities: CAPS });

// Apply the same bounded repair loop the gaps node runs.
function repair(spec) {
  let draft = spec, result = score(spec), applied = [];
  for (let pass = 0; pass < 4; pass++) {
    const r = autoRepairStructural(draft, result.gaps);
    if (!r.applied.length) break;
    applied.push(...r.applied);
    draft = r.draft;
    result = score(draft);
  }
  return { draft, result, applied };
}

// A branch triage spec whose branch→post_urgent edge is MISSING (the case names
// the target, but nothing is drawn to it). BRANCH_CASE_NO_EDGE.
function missingBranchEdgeSpec() {
  return {
    version: 2, name: 'Triage',
    outcome: {
      statement: 'Urgent support emails post to #urgent, the rest to #support.',
      assertions: [
        { id: 'a1', kind: 'message_sent', target: 'slack:#urgent'  },
        { id: 'a2', kind: 'message_sent', target: 'slack:#support' },
      ], examples: [],
    },
    triggers: [{ type: 'email', filter: 'to:support@acme.com' }],
    nodes: [
      { id: 'classify', type: 'llm', label: 'Classify',
        config: { mode: 'classify', categories: 'urgent\nnormal', instructions: 'Classify urgency.' } },
      { id: 'route', type: 'branch', label: 'Route',
        config: { on: '{{classify.output}}', cases: [ { when: 'urgent', to: 'post_urgent' }, { when: '*', to: 'post_normal' } ] } },
      { id: 'post_urgent', type: 'deliver', label: 'Post urgent', config: { channel: 'slack', target: '#urgent' } },
      { id: 'post_normal', type: 'deliver', label: 'Post normal', config: { channel: 'slack', target: '#support' } },
    ],
    edges: [ { from: 'classify', to: 'route' }, { from: 'route', to: 'post_normal' } ],
  };
}

describe('#19 — BRANCH_CASE_NO_EDGE auto-repairs to complete', () => {
  test('the gap carries a structured add_edge fix', () => {
    const g = score(missingBranchEdgeSpec()).gaps.find(x => x.code === 'BRANCH_CASE_NO_EDGE');
    assert.ok(g, 'the defect is detected');
    assert.deepEqual(g.fix, { op: 'add_edge', from: 'route', to: 'post_urgent' });
  });

  test('without repair the build is STRANDED (blocking gaps remain)', () => {
    const before = score(missingBranchEdgeSpec());
    assert.ok(unansweredGaps(before).some(g => g.code === 'BRANCH_CASE_NO_EDGE'),
      'the missing edge blocks the build');
    assert.equal(before.complete, false);
  });

  test('applying the fix draws the edge and clears the cascade', () => {
    const { draft, result, applied } = repair(missingBranchEdgeSpec());
    // the one edge fix was applied…
    assert.ok(applied.some(a => a.op === 'add_edge' && a.from === 'route' && a.to === 'post_urgent'));
    assert.ok(draft.edges.some(e => e.from === 'route' && e.to === 'post_urgent'), 'the edge now exists');
    // …and the whole cascade it caused (orphan + no-input) is gone.
    assert.deepEqual(unansweredGaps(result), [], 'no blocking gaps remain');
    assert.equal(result.complete, true, 'the spec is now complete and publishable');
  });
});

describe('#19 — ON_ERROR_ROUTE_NO_EDGE auto-repairs', () => {
  // A node routes failures to a handler but no edge is drawn — the failure path
  // would never run and the workflow would report success anyway.
  function spec() {
    return {
      version: 2, name: 'Digest',
      outcome: {
        statement: 'Every inbound email is summarized to the inbox.',
        assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Email Summary' }], examples: [],
      },
      triggers: [{ type: 'email', filter: 'to:me@acme.com' }],
      nodes: [
        { id: 'summarize', type: 'llm', label: 'Summarize',
          config: { mode: 'summarize', instructions: 'Summarize it.' },
          on_error: { retry: 0, then: 'route_to:notify' } },
        { id: 'save',   type: 'deliver', label: 'Save',   config: { channel: 'inbox_deliver', subject: 'Email Summary' } },
        { id: 'notify', type: 'deliver', label: 'Notify', config: { channel: 'inbox_deliver', subject: 'Summary failed' } },
      ],
      edges: [ { from: 'summarize', to: 'save' } ],  // summarize→notify (the error route) MISSING
    };
  }
  test('the gap carries the add_edge fix and repair draws the route edge', () => {
    const g = score(spec()).gaps.find(x => x.code === 'ON_ERROR_ROUTE_NO_EDGE');
    assert.ok(g, 'the defect is detected');
    assert.deepEqual(g.fix, { op: 'add_edge', from: 'summarize', to: 'notify' });
    const { draft, result } = repair(spec());
    assert.ok(draft.edges.some(e => e.from === 'summarize' && e.to === 'notify'), 'the error-route edge now exists');
    assert.ok(!unansweredGaps(result).some(g => g.code === 'ON_ERROR_ROUTE_NO_EDGE'), 'the gap is cleared');
  });
});

describe('#19 — BRANCH_TARGET_EXTRA_PARENT auto-repairs by removing the ambiguous edge', () => {
  // post_urgent is reached BOTH from the branch and from classify — so it would
  // run whichever way the branch routed, and the branch would decide nothing.
  function spec() {
    const s = missingBranchEdgeSpec();
    s.edges = [
      { from: 'classify', to: 'route' },
      { from: 'route', to: 'post_normal' },
      { from: 'route', to: 'post_urgent' },
      { from: 'classify', to: 'post_urgent' },   // the ambiguous EXTRA parent
    ];
    return s;
  }
  test('the gap carries a remove_edges fix and repair drops the extra edge', () => {
    const g = score(spec()).gaps.find(x => x.code === 'BRANCH_TARGET_EXTRA_PARENT');
    assert.ok(g, 'the defect is detected');
    assert.equal(g.fix.op, 'remove_edges');
    assert.ok(g.fix.edges.some(e => e.from === 'classify' && e.to === 'post_urgent'));
    const { draft, result } = repair(spec());
    assert.ok(!draft.edges.some(e => e.from === 'classify' && e.to === 'post_urgent'),
      'the ambiguous edge was removed');
    assert.ok(draft.edges.some(e => e.from === 'route' && e.to === 'post_urgent'),
      'the branch edge is kept — the target is still reachable');
    assert.ok(!unansweredGaps(result).some(g => g.code === 'BRANCH_TARGET_EXTRA_PARENT'), 'the gap is cleared');
  });
});

describe('#19 — gaps with NO fix are left untouched (a decision is not a bug)', () => {
  test('a semantic/blocking gap without a fix is not silently mutated', () => {
    // A deliver to a hallucinated channel is a genuine gap with no mechanical fix.
    const spec = {
      version: 2, name: 'Bad channel',
      outcome: { statement: 'Post to Discord.', assertions: [{ id: 'a1', kind: 'message_sent', target: 'discord:#x' }], examples: [] },
      triggers: [{ type: 'email', filter: 'to:me@acme.com' }],
      nodes: [
        { id: 's', type: 'llm', label: 'S', config: { mode: 'summarize', instructions: 'x' } },
        { id: 'd', type: 'deliver', label: 'D', config: { channel: 'discord', target: '#x' } },
      ],
      edges: [{ from: 's', to: 'd' }],
    };
    const before = score(spec);
    const withFix = before.gaps.filter(g => g.fix);
    assert.equal(withFix.length, 0, 'no gap here carries a mechanical fix');
    const { applied, draft } = repair(spec);
    assert.deepEqual(applied, [], 'auto-repair changed nothing');
    assert.deepEqual(draft.edges, spec.edges, 'the graph is untouched');
  });
});
