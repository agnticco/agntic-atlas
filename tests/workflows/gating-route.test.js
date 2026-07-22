/**
 * A PROMISE MUST BE STATED IN A LANGUAGE THE WORKFLOW SPEAKS.
 *
 * Found by the QA Manager's first shakedown (2026-07-22, SHA 95d4b40). A real
 * three-lane approval build produced a contract whose condition was
 * `urgent_approved` — a conjunction ("urgent AND approved") written as one invented
 * word, in a field that holds a single route value. No node can ever produce it, so
 * the workflow's central promise was permanently uncheckable while the panel showed
 * it to the user as the contract. Atlas said so in its own log:
 *
 *   "no step here can produce 'urgent_approved' (the routes are: urgent, routine,
 *    junk, none, approve, reject, timeout) — that promise can never be checked"
 *
 * The conjunction never needed to be expressible: the DEEPEST gate on a path
 * implies every gate above it. The approval branch is only reachable from the
 * urgent lane, so "approved" selects exactly the runs "urgent AND approved" does.
 *
 * NOTE ON THE FIXTURE: the delivery channel is `in_app`, which is the product's
 * actual default. An earlier draft used `channel: 'inbox'` — not a real channel id —
 * so the node had no effect at all, nothing owned the assertion, and the whole
 * end-to-end path silently did nothing while the unit tests passed. A fixture that
 * names something production does not is a test of a program nobody runs.
 *
 * WHAT THESE PIN, and why each is here rather than obvious:
 *  - NEAREST, not any. This is the whole correctness argument. Naming the outer
 *    gate (`urgent`) would enforce the promise on runs that went urgent and were
 *    REJECTED — a false failure on a workflow behaving exactly as designed.
 *  - a branch whose lanes ALL converge on the step decides nothing about whether it
 *    runs, so it is not a gate. Counting it would invent a condition nobody set.
 *  - a step nothing gates yields null, which is not a failure — it means the
 *    promise is unconditional.
 *  - the repair restates the CHECK, never the user's words.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gatingRouteFor } from '../../src/workflows/outcome-oracle.js';
import { autoRepairStructural } from '../../src/converger/elicitation-graph.js';

/**
 * The live shape: classify → 3 lanes; the urgent lane passes through a human
 * approval and a SECOND branch before the inbox delivery.
 *
 *   trigger → classify → route ──urgent──→ ask → approved? ──approve──→ file
 *                              ├─routine─→ file_routine
 *                              └─*───────→ stop
 */
function approvalSpec() {
  return {
    name: 'T',
    triggers: [{ type: 'email' }],
    nodes: [
      { id: 'trigger', type: 'trigger', label: 'Email', config: { type: 'email' } },
      { id: 'classify', type: 'llm', label: 'Classify',
        config: { mode: 'classify', prompt: 'x', categories: ['urgent', 'routine', 'junk'] } },
      { id: 'route', type: 'branch', label: 'Route',
        config: { on: '{{classify.output}}', cases: [
          { when: 'urgent', to: 'ask' }, { when: 'routine', to: 'file_routine' }, { when: '*', to: 'stop' }] } },
      { id: 'ask', type: 'human', label: 'Ask Charles',
        config: { prompt: 'ok?', decisions: ['approve', 'reject'],
                  channels: [{ type: 'slack', target: '@charles' }], timeout: { after: '48h' } } },
      { id: 'approved', type: 'branch', label: 'Approved?',
        config: { on: '{{ask.decision}}', cases: [
          { when: 'approve', to: 'file' }, { when: '*', to: 'stop' }] } },
      { id: 'file', type: 'deliver', label: 'File it', config: { channel: 'in_app', subject: 'Summary' } },
      { id: 'file_routine', type: 'deliver', label: 'File routine', config: { channel: 'in_app', subject: 'Routine' } },
      { id: 'stop', type: 'assemble', label: 'Stop', config: { title: 'x', sections: '[]' } },
    ],
    edges: [
      { from: 'trigger', to: 'classify' }, { from: 'classify', to: 'route' },
      { from: 'route', to: 'ask' }, { from: 'route', to: 'file_routine' }, { from: 'route', to: 'stop' },
      { from: 'ask', to: 'approved' },
      { from: 'approved', to: 'file' }, { from: 'approved', to: 'stop' },
    ],
  };
}

describe('which route actually gates a step', () => {
  test('takes the NEAREST gate, not the outermost', () => {
    const g = gatingRouteFor(approvalSpec(), 'file');
    assert.ok(g, 'the delivery IS gated — reporting nothing would make the promise unconditional');
    assert.deepEqual(g.values, ['approve']);
    assert.equal(g.branch, 'approved',
      'naming "urgent" would enforce the promise on runs that went urgent and were REJECTED');
  });

  test('a step on a single-branch lane reports that lane', () => {
    assert.deepEqual(gatingRouteFor(approvalSpec(), 'file_routine').values, ['routine']);
  });

  test('a step every lane reaches is NOT gated — no condition is invented', () => {
    // Every case of `route` converges on the same delivery. The branch decides which
    // way the work goes, but not WHETHER this step runs — so it is not a condition,
    // and naming one would put a promise on the workflow the user never made.
    //
    // This one is here because it initially existed only in a weak form that passed
    // whether the rule was implemented or not: removing the guard left the whole
    // suite green. Mutation is the only reason it is written this way.
    const spec = {
      nodes: [
        { id: 'classify', type: 'llm', label: 'C',
          config: { mode: 'classify', prompt: 'x', categories: ['urgent', 'routine'] } },
        { id: 'route', type: 'branch', label: 'R',
          config: { on: '{{classify.output}}', cases: [
            { when: 'urgent', to: 'a' }, { when: 'routine', to: 'b' }, { when: '*', to: 'c' }] } },
        { id: 'a', type: 'llm', label: 'A', config: { mode: 'summarize', prompt: 'x' } },
        { id: 'b', type: 'llm', label: 'B', config: { mode: 'summarize', prompt: 'x' } },
        { id: 'c', type: 'llm', label: 'C2', config: { mode: 'summarize', prompt: 'x' } },
        { id: 'file', type: 'deliver', label: 'F', config: { channel: 'in_app', subject: 'S' } },
      ],
      edges: [
        { from: 'classify', to: 'route' },
        { from: 'route', to: 'a' }, { from: 'route', to: 'b' }, { from: 'route', to: 'c' },
        { from: 'a', to: 'file' }, { from: 'b', to: 'file' }, { from: 'c', to: 'file' },
      ],
    };
    assert.equal(gatingRouteFor(spec, 'file'), null,
      'every lane reaches it, so nothing decides whether it runs — reporting "urgent" would ' +
      'silently narrow an unconditional promise to one lane');
  });

  test('a lane reached ONLY via the catch-all names no value', () => {
    const spec = approvalSpec();
    // `stop` is reached only by catch-alls on both branches.
    const g = gatingRouteFor(spec, 'stop');
    assert.ok(!g || !g.values.includes('*'), 'a catch-all names no value, so it cannot be a condition');
  });

  test('a workflow with no branch gates nothing', () => {
    const spec = { nodes: [{ id: 'a', type: 'llm' }, { id: 'b', type: 'deliver' }],
                   edges: [{ from: 'a', to: 'b' }] };
    assert.equal(gatingRouteFor(spec, 'b'), null,
      'unconditional is a real answer — it means the `when` should be dropped, not invented');
  });

  test('an unknown step id is not an error', () => {
    assert.equal(gatingRouteFor(approvalSpec(), 'nope'), null);
  });
});

describe('the uncheckable promise repairs itself', () => {
  /** The gap as the scorer emits it for this spec — index 0, one delivery. */
  const gapFor = (when) => ({
    id: 'gap_conditional_a1', code: 'CONDITIONAL_UNPROVEN',
    fix: { op: 'set_assertion_when', index: 0, when },
  });

  function specWithContract(when) {
    const s = approvalSpec();
    s.outcome = {
      statement: 'File urgent mail I have approved',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Summary', when }],
    };
    return s;
  }

  test('the condition is restated in the workflow\'s own words', () => {
    const { draft, applied } = autoRepairStructural(specWithContract('urgent_approved'), [gapFor('approve')]);
    assert.equal(applied.length, 1);
    assert.equal(draft.outcome.assertions[0].when, 'approve');
  });

  test('the user\'s WORDS are never edited — only the machine check', () => {
    const before = specWithContract('urgent_approved');
    const { draft } = autoRepairStructural(before, [gapFor('approve')]);
    assert.equal(draft.outcome.statement, 'File urgent mail I have approved',
      'rewriting the statement would be editing what the user asked for');
    assert.equal(draft.outcome.assertions[0].target, 'inbox:Summary', 'and the promise still names its destination');
    assert.equal(draft.outcome.assertions[0].id, 'a1');
  });

  test('other assertions are untouched', () => {
    const s = specWithContract('urgent_approved');
    s.outcome.assertions.push({ id: 'a2', kind: 'message_sent', target: 'inbox:Routine', when: 'routine' });
    const { draft } = autoRepairStructural(s, [gapFor('approve')]);
    assert.equal(draft.outcome.assertions[0].when, 'approve');
    assert.equal(draft.outcome.assertions[1].when, 'routine', 'the repair is indexed, not a blanket rewrite');
  });

  test('an index that does not exist is skipped, not crashed on', () => {
    const { applied } = autoRepairStructural(specWithContract('urgent_approved'),
      [{ id: 'g', code: 'CONDITIONAL_UNPROVEN', fix: { op: 'set_assertion_when', index: 7, when: 'approve' } }]);
    assert.equal(applied.length, 0);
  });
});
