/**
 * THE GRAPH MUST HANDLE EVERY SHAPE A WORKFLOW CAN TAKE.
 *
 * The builder's live graph has now been wrong about its layout FOUR times, each
 * one patched at the symptom rather than at the rule:
 *
 *   1. a nested branch's targets drawn as one horizontal run, so mutually
 *      exclusive outcomes read as "do this, THEN that";
 *   2. a `decision` sitting before the branch selected as the lane source — it
 *      has `rules`, not `cases`, so lane rendering bailed and the ENTIRE graph
 *      collapsed to a flat line;
 *   3. a plain FAN-OUT (one step feeding two deliveries) not recognised as a
 *      split at all, so two SIMULTANEOUS deliveries rendered as a run-on with
 *      their labels overlapping by 29 real pixels;
 *   4. …and whatever the next unmodelled shape would have been.
 *
 * The rule underneath all four: **A SPLIT IS ANY NODE WITH TWO OR MORE OUTGOING
 * EDGES.** A `branch` is just the split that also carries case labels. This suite
 * pins that rule against every shape the product can build, so the fifth instance
 * fails here instead of in front of a user.
 *
 * It reads the helpers straight out of `public/index.html`. That file is a single
 * self-contained page with no module boundary and no build step, so there is
 * nothing to import — extracting the functions is the only way to execute the
 * REAL code rather than a copy of it, and a copy is exactly what would drift.
 */

import { test, describe } from 'node:test';
import assert             from 'node:assert/strict';
import fs                 from 'node:fs';
import path               from 'node:path';
import { fileURLToPath }  from 'node:url';

const HTML = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

/** Pull one class method out of the page by brace-matching from its declaration. */
function grab(name) {
  const i = HTML.indexOf('  ' + name + '(');
  assert.ok(i >= 0, `method ${name} not found in public/index.html — did it get renamed?`);
  let depth = 0, started = false, j = i;
  for (; j < HTML.length; j++) {
    const c = HTML[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { j++; break; } }
  }
  return HTML.slice(i, j);
}

const METHODS = ['_laneSourceOf', '_isExclusiveSplit', '_splitTargetsOf', '_stepShape', '_stepShapeLabel'];
const Graph = new Function('return class G { ' + METHODS.map(grab).join('\n') + ' }')();
const g = new Graph();
// `_stepShapeLabel` reads state for the plan cache in `_laneLabelFor`; it does not
// here, but give it a state so nothing throws if that changes.
g.state = {};

// ── the shapes ───────────────────────────────────────────────────────────────

const linear = {
  nodes: [{ id: 'a', type: 'llm' }, { id: 'b', type: 'deliver' }],
  edges: [{ from: 'a', to: 'b' }],
};

/** One step feeding two deliveries. BOTH run — this is a broadcast, not a choice. */
const fanOut = {
  nodes: [{ id: 'gen', type: 'llm' }, { id: 'slack', type: 'deliver' }, { id: 'inbox', type: 'deliver' }],
  edges: [{ from: 'gen', to: 'slack' }, { from: 'gen', to: 'inbox' }],
};

/** classify → branch → three lanes. Exactly ONE runs. */
const router = {
  nodes: [
    { id: 'c', type: 'llm' },
    { id: 'r', type: 'branch', config: { cases: [
      { when: 'urgent', to: 's' }, { when: 'billing', to: 'i' }, { when: '*', to: 'q' }] } },
    { id: 's', type: 'deliver' }, { id: 'i', type: 'deliver' }, { id: 'q', type: 'assemble' },
  ],
  edges: [{ from: 'c', to: 'r' }, { from: 'r', to: 's' }, { from: 'r', to: 'i' }, { from: 'r', to: 'q' }],
};

/** A decision produces a VALUE and has ONE outgoing edge; the branch routes. */
const decisionThenBranch = {
  nodes: [
    { id: 'x', type: 'llm' }, { id: 'd', type: 'decision', config: { rules: [] } },
    { id: 'r', type: 'branch', config: { cases: [{ when: 'P1', to: 'a' }, { when: '*', to: 'b' }] } },
    { id: 'a', type: 'deliver' }, { id: 'b', type: 'assemble' },
  ],
  edges: [{ from: 'x', to: 'd' }, { from: 'd', to: 'r' }, { from: 'r', to: 'a' }, { from: 'r', to: 'b' }],
};

describe('the live graph handles every workflow shape', () => {
  test('a linear workflow has no split and stays flat', () => {
    assert.equal(g._laneSourceOf(linear.nodes, linear.edges), null);
    assert.deepEqual(g._stepShape(linear), { steps: 2, paths: 0, parallel: false });
  });

  test('A FAN-OUT IS A SPLIT — the defect that exposed the real rule', () => {
    // Before the fix this returned null (no node was a `branch`), no lanes were
    // computed, and both deliveries were drawn adjacent in the trunk with their
    // labels overlapping. The split is the node with two outgoing edges.
    const src = g._laneSourceOf(fanOut.nodes, fanOut.edges);
    assert.ok(src, 'a step feeding two deliveries IS a split');
    assert.equal(src.id, 'gen');
    assert.deepEqual(g._splitTargetsOf(src, fanOut.edges), ['slack', 'inbox']);
  });

  test('a fan-out is PARALLEL — every lane runs, so it is not a choice', () => {
    const src = g._laneSourceOf(fanOut.nodes, fanOut.edges);
    assert.equal(g._isExclusiveSplit(src), false,
      'drawing a broadcast as a choice tells the user only ONE destination gets it — ' +
      'a worse lie than the run-on this replaced');
  });

  test('a router is EXCLUSIVE — its lanes are alternatives and must be labelled', () => {
    const src = g._laneSourceOf(router.nodes, router.edges);
    assert.equal(src.id, 'r');
    assert.equal(g._isExclusiveSplit(src), true);
    assert.deepEqual(g._splitTargetsOf(src, router.edges), ['s', 'i', 'q']);
  });

  test('a `decision` before the branch is NOT the lane source (regression)', () => {
    // The decision has one outgoing edge, so out-degree picks the branch — the
    // property the previous fix achieved by naming `branch` explicitly, preserved
    // here by the general rule rather than by a special case.
    const src = g._laneSourceOf(decisionThenBranch.nodes, decisionThenBranch.edges);
    assert.equal(src.id, 'r', 'a decision produces a value; the branch routes');
    assert.equal(src.type, 'branch');
  });

  test('several cases routing to ONE node is one lane, not several', () => {
    const shared = {
      nodes: [
        { id: 'c', type: 'llm' },
        { id: 'r', type: 'branch', config: { cases: [
          { when: 'P1', to: 'hot' }, { when: 'P2', to: 'cold' },
          { when: 'P3', to: 'cold' }, { when: '*', to: 'cold' }] } },
        { id: 'hot', type: 'deliver' }, { id: 'cold', type: 'assemble' },
      ],
      edges: [{ from: 'c', to: 'r' }, { from: 'r', to: 'hot' }, { from: 'r', to: 'cold' }],
    };
    const src = g._laneSourceOf(shared.nodes, shared.edges);
    assert.deepEqual(g._splitTargetsOf(src, shared.edges), ['hot', 'cold'],
      'four cases, two lanes — the user sees destinations, not rules');
  });

  test('DUPLICATE EDGES to one target do not manufacture a phantom lane', () => {
    // Found by mutation: removing the dedupe from `_splitTargetsOf` survived the
    // "four cases, two lanes" test above, because THAT fixture has only two edges —
    // its duplication is in `cases`, which the lane walk no longer reads. The
    // dedupe that actually matters is over EDGES, and nothing exercised it.
    //
    // A phantom lane is not cosmetic: lane count drives the fan-out geometry, so a
    // third curve would be drawn to a destination that does not exist, and the
    // empty lane would claim an outcome the workflow never produces.
    const dupEdges = {
      nodes: [
        { id: 'c', type: 'llm' },
        { id: 'r', type: 'branch', config: { cases: [
          { when: 'P1', to: 'hot' }, { when: 'P2', to: 'cold' }, { when: '*', to: 'cold' }] } },
        { id: 'hot', type: 'deliver' }, { id: 'cold', type: 'assemble' },
      ],
      edges: [{ from: 'c', to: 'r' },
              { from: 'r', to: 'hot' }, { from: 'r', to: 'cold' }, { from: 'r', to: 'cold' }],
    };
    const src = g._laneSourceOf(dupEdges.nodes, dupEdges.edges);
    assert.deepEqual(g._splitTargetsOf(src, dupEdges.edges), ['hot', 'cold'],
      'three edges, two destinations — one lane each, no empty third');
    assert.equal(g._stepShape(dupEdges).paths, 2);
  });

  test('STEPS is every step, so the panel and the approval queue agree', () => {
    // SUPERSEDED 2026-07-28 (operator: "everything needs to agree to what the
    // workflow actually is"). This used to stop at the first branch for a router,
    // on the reasoning that only one lane RUNS so the lane nodes are not steps the
    // workflow always takes. Defensible in the abstract, wrong in practice: the
    // same workflow published "4 steps" in the panel and "STEP 5 OF 5" in the
    // approval queue, and a person cannot reconcile two numbers for one thing. The
    // queue's count is the one they walk through and tick off, so it wins.
    assert.deepEqual(g._stepShape(fanOut),  { steps: 3, paths: 2, parallel: true });
    assert.deepEqual(g._stepShape(router),  { steps: 5, paths: 3, parallel: false });
    assert.equal(g._stepShape(router).steps, router.nodes.length,
      'the panel must count what the queue counts — every node');
  });

  test('the panel says "at once" for a broadcast and "paths" for a choice', () => {
    // The parallel/exclusive distinction still matters for PATHS: a fan-out's lanes
    // all run, so calling them "paths" would say a choice is being made when
    // nothing is choosing. Only the STEPS half was superseded.
    assert.equal(g._stepShapeLabel(fanOut), '3 steps · 2 at once');
    assert.equal(g._stepShapeLabel(router), '5 steps · 3 paths');
  });

  test('N-way fan-out is generic, not special-cased to two', () => {
    const three = {
      nodes: [{ id: 'g', type: 'llm' }, { id: 'a', type: 'deliver' },
              { id: 'b', type: 'deliver' }, { id: 'c', type: 'deliver' }],
      edges: [{ from: 'g', to: 'a' }, { from: 'g', to: 'b' }, { from: 'g', to: 'c' }],
    };
    const src = g._laneSourceOf(three.nodes, three.edges);
    assert.equal(g._splitTargetsOf(src, three.edges).length, 3);
    assert.equal(g._stepShape(three).parallel, true);
  });

  test('a node with a self-referencing duplicate edge is still one lane', () => {
    // Duplicate edges to the same target must not manufacture a phantom lane.
    const dup = {
      nodes: [{ id: 'a', type: 'llm' }, { id: 'b', type: 'deliver' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }],
    };
    assert.equal(g._laneSourceOf(dup.nodes, dup.edges), null,
      'two edges to ONE target is not a split — nothing diverges');
  });
});
