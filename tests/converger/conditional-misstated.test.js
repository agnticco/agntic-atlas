/**
 * A promise about a step behind an approval gate must be checked against THAT
 * gate — not against the classifier lane further upstream.
 *
 * WITNESSED 2026-07-28 (local build, then reproduced in the contract of a prod
 * build). On the canonical classify→approve→route shape the converger wrote:
 *
 *   { kind:'message_sent', target:'slack:#atlas-test-temp', when:'urgent_complaint' }
 *
 * `urgent_complaint` IS a real route value, so the old check — "does SOME branch
 * route on this value?" — passed it. But the post sits behind the APPROVAL branch,
 * two branches down. Atlas deliberately runs every gated example BOTH ways, so on
 * each reject pass the post correctly did not happen and was scored as a broken
 * promise. The panel read "Contract not met · 4 of 9 promises fell short"; three of
 * the four were reject passes being punished for rejecting. Go live stayed locked
 * on a workflow that was behaving exactly as designed.
 *
 * `gatingRouteFor` has always known the right answer — its own comment says picking
 * the outer gate "would enforce the promise on runs that went urgent and were
 * REJECTED". It simply was never consulted once `when` looked like a valid route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreGap } from '../../src/converger/gap-scorer.js';
import { autoRepairStructural } from '../../src/converger/elicitation-graph.js';

/** classify → route → [urgent → summarize → approve-gate → route → post | normal → airtable | spam → stop] */
function approvalShapeSpec(when) {
  return {
    name: 'Inbound triage',
    triggers: [{ type: 'email' }],
    outcome: {
      statement: 'urgent complaints get approved before posting',
      assertions: [
        { id: 'a1', kind: 'message_sent', target: 'slack:#atlas-test-temp', when },
      ],
    },
    nodes: [
      { id: 'classify', type: 'llm', label: 'Classify', config: { mode: 'classify', categories: ['urgent_complaint', 'normal_enquiry', 'spam'] } },
      { id: 'route_category', type: 'branch', label: 'Route by type', config: { on: 'classify.output', cases: [
        { when: 'urgent_complaint', to: 'summarize' },
        { when: 'normal_enquiry',   to: 'stop_other' },
        { when: '*',                to: 'stop_other' },
      ] } },
      { id: 'summarize', type: 'llm', label: 'Summarize', config: { mode: 'summarize' } },
      { id: 'approve', type: 'human', label: 'Ask Charles', config: { prompt: 'ok?', decisions: ['approve', 'reject'], channels: [{ type: 'slack', target: 'charles@agntic.co' }] } },
      { id: 'route_approval', type: 'branch', label: 'Route by decision', config: { on: 'approve.decision', cases: [
        { when: 'approve', to: 'post' },
        { when: 'reject',  to: 'stop_rejected' },
        { when: '*',       to: 'stop_rejected' },
      ] } },
      { id: 'post', type: 'deliver', label: 'Post to #atlas-test-temp', config: { channel: 'slack', target: '#atlas-test-temp' } },
      { id: 'stop_rejected', type: 'stop', label: 'End — rejected', config: {} },
      { id: 'stop_other', type: 'stop', label: 'End — other', config: {} },
    ],
    edges: [
      { from: 'classify', to: 'route_category' },
      { from: 'route_category', to: 'summarize' },
      { from: 'route_category', to: 'stop_other' },
      { from: 'summarize', to: 'approve' },
      { from: 'approve', to: 'route_approval' },
      { from: 'route_approval', to: 'post' },
      { from: 'route_approval', to: 'stop_rejected' },
    ],
  };
}

const misstatedGap = (spec) =>
  scoreGap(spec).gaps.find(g => g.code === 'CONDITIONAL_MISSTATED');

test('a promise conditioned on the classifier lane is restated as the approval gate', () => {
  const spec = approvalShapeSpec('urgent_complaint');
  const gap = misstatedGap(spec);
  assert.ok(gap, 'expected the mis-stated condition to be caught');
  assert.equal(gap.fix.op, 'set_assertion_when');
  assert.equal(gap.fix.when, 'approve');
});

test('the repair rewrites only the machine-checkable condition, not the user’s words', () => {
  const spec = approvalShapeSpec('urgent_complaint');
  const { draft, applied } = autoRepairStructural(spec, scoreGap(spec).gaps);
  assert.equal(draft.outcome.assertions[0].when, 'approve');
  assert.equal(draft.outcome.assertions[0].target, 'slack:#atlas-test-temp', 'target untouched');
  assert.equal(draft.outcome.statement, spec.outcome.statement, 'the user’s own sentence is untouched');
  assert.ok(applied.some(a => a.op === 'set_assertion_when'));
});

test('after the repair the spec re-scores clean of this gap', () => {
  const spec = approvalShapeSpec('urgent_complaint');
  const { draft } = autoRepairStructural(spec, scoreGap(spec).gaps);
  assert.equal(misstatedGap(draft), undefined, 'repair must be stable, not re-fire forever');
});

// ── THE ANTI-FALSE-PASS CASES ────────────────────────────────────────────────

test('a promise that ALREADY names its own gate is left alone', () => {
  const spec = approvalShapeSpec('approve');
  assert.equal(misstatedGap(spec), undefined, 'a correct condition must not be rewritten');
});

test('a promise gated by the classifier only is left alone', () => {
  // The DM to the approver really is gated by the urgent lane and nothing deeper —
  // rewriting that one would be the mirror-image defect.
  const spec = approvalShapeSpec('urgent_complaint');
  spec.outcome.assertions = [
    { id: 'a1', kind: 'message_sent', target: 'slack:charles@agntic.co', when: 'urgent_complaint' },
  ];
  assert.equal(misstatedGap(spec), undefined, 'the approval DM is correctly gated by the urgent lane');
});

test('an unconditional promise is untouched', () => {
  const spec = approvalShapeSpec('urgent_complaint');
  delete spec.outcome.assertions[0].when;
  assert.equal(misstatedGap(spec), undefined);
});
