/**
 * A BLANK THE CONVERGER LEFT IS NOT A QUESTION FOR THE USER.
 *
 * Observed live on a three-lane approval build (2026-07-22): the converger emitted
 * a document step with no section list. That is a BLOCKING defect, so the answer
 * went back through a whole-spec rebuild — one Opus pass, 89.7s — which produced
 * the same blank, and the user was asked the identical question a second time, word
 * for word, with a `Use your suggestions` button that demonstrably did not make it
 * stick. The loop is bounded, so it ends in a give-up rather than a spin; it is
 * still a rebuild per round and a question the user cannot answer usefully.
 *
 * The model's own suggested answer was "one section, headed <title>, whose content
 * is the previous step's output" — which is not a judgement call. With exactly one
 * upstream content step there is precisely one thing it can mean, so the validator
 * computes it and the existing structural auto-repair applies it: no model call, no
 * question. Same doctrine as the missing route edge that path already fixes.
 *
 * WHAT THESE PIN, and why each is here:
 *  - the fix is OFFERED at all (the loop above is the cost of it not being);
 *  - it is NARROW — two content parents is a real question about ordering and
 *    headings, and must stay one. A repair that guesses there is worse than a
 *    question, because the user never sees what it chose;
 *  - control steps are not content. A branch reports a route, so counting one as
 *    the body of a document would both pick the wrong source AND make an
 *    ambiguous case look unambiguous;
 *  - the repair MERGES over the node rather than replacing it, so a value the
 *    user already chose is never silently reverted.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';
import { autoRepairStructural } from '../../src/converger/elicitation-graph.js';

// Constructed the way PRODUCTION constructs it (`gap-scorer.js` validatorFor) —
// the option is `nodeTypes`, and a validator given the wrong key silently runs
// with NO per-type checks and reports a clean bill of health. The first draft of
// this suite passed `nodeTypeRegistry` and saw zero issues on a spec with an
// obvious defect. A test that hands in something production does not is testing a
// program nobody runs.
function validatorOf() {
  const reg = new NodeTypeRegistry();
  registerBuiltInNodeTypes(reg);
  return new WorkflowValidator({ nodeTypes: reg });
}

/** A spec whose document step has no sections, fed by `parents` content steps. */
function specWith(parents, extra = {}) {
  const nodes = [
    { id: 'trigger', type: 'trigger', label: 'Email arrives', config: { type: 'email' } },
    ...parents.map((p) => ({ id: p, type: 'llm', label: p, config: { mode: 'summarize', prompt: 'x' } })),
    { id: 'doc', type: 'assemble', label: 'Prepare approved summary', config: { title: 'Email Summary' } },
    { id: 'send', type: 'deliver', label: 'Save', config: { channel: 'inbox', subject: 'S' } },
    ...(extra.nodes ?? []),
  ];
  const edges = [
    ...parents.map((p) => ({ from: 'trigger', to: p })),
    ...parents.map((p) => ({ from: p, to: 'doc' })),
    { from: 'doc', to: 'send' },
    ...(extra.edges ?? []),
  ];
  return { name: 'T', triggers: [{ type: 'email' }], nodes, edges };
}

const sectionIssue = (r) => r.issues.find(i => i.code === 'DIGEST_MISSING_SECTIONS');

describe('a missing section list repairs itself when there is only one answer', () => {
  test('ONE upstream content step — the fix is offered', () => {
    const issue = sectionIssue(validatorOf().validate(specWith(['summarize'])));
    assert.ok(issue, 'the blank must still be reported');
    assert.ok(issue.fix, 'without a fix this goes back through a whole-spec rebuild and re-asks the user');
    assert.equal(issue.fix.op, 'set_config');
    assert.equal(issue.fix.nodeId, 'doc');

    const sections = JSON.parse(issue.fix.config.sections);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].content, '{{summarize.output}}',
      'the body must come from the one step that feeds it');
    assert.equal(sections[0].heading, 'Email Summary',
      'the heading is the title the converger already chose — not an invented one');
  });

  test('applying it actually clears the defect', () => {
    const v = validatorOf();
    const spec = specWith(['summarize']);
    const { draft, applied } = autoRepairStructural(spec, v.validate(spec).issues);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].op, 'set_config');
    assert.ok(!sectionIssue(v.validate(draft)),
      'a repair that does not clear the defect is worse than none — it re-asks having spent the pass');
  });

  test('TWO upstream content steps — NO fix, it stays a question', () => {
    const issue = sectionIssue(validatorOf().validate(specWith(['sum_a', 'sum_b'])));
    assert.ok(issue, 'still reported');
    assert.ok(!issue.fix,
      'order and headings across two sources is a real decision — guessing it silently is worse than asking');
  });

  test('a control step is not content, so a branch parent does not make it unambiguous', () => {
    // doc is fed by ONE summarize AND one branch. Counting the branch would give
    // two parents (no fix); ignoring it entirely gives one — the summarize.
    const spec = specWith(['summarize'], {
      nodes: [{ id: 'route', type: 'branch', label: 'Route',
                config: { on: '{{summarize.output}}', cases: [{ when: '*', to: 'doc' }] } }],
      edges: [{ from: 'summarize', to: 'route' }, { from: 'route', to: 'doc' }],
    });
    const issue = sectionIssue(validatorOf().validate(spec));
    assert.ok(issue?.fix, 'a branch is not a content source, so this is still the one-source case');
    assert.equal(JSON.parse(issue.fix.config.sections)[0].content, '{{summarize.output}}',
      'a branch outputs a route, not prose — using it as the document body would deliver {"value":…}');
  });

  test('the repair MERGES — a value already on the node survives', () => {
    const spec = specWith(['summarize']);
    spec.nodes.find(n => n.id === 'doc').config.intro = 'Here is what came in.';
    const v = validatorOf();
    const { draft } = autoRepairStructural(spec, v.validate(spec).issues);
    const doc = draft.nodes.find(n => n.id === 'doc');
    assert.equal(doc.config.intro, 'Here is what came in.',
      'a repair that drops a neighbouring value is a silent edit to something the user chose');
    assert.ok(doc.config.sections, 'and it still filled the blank');
  });

  test('a section list that is already there is left alone', () => {
    const spec = specWith(['summarize']);
    spec.nodes.find(n => n.id === 'doc').config.sections = '[{"heading":"Mine","content":"{{summarize.output}}"}]';
    const v = validatorOf();
    assert.ok(!sectionIssue(v.validate(spec)), 'nothing to repair');
    const { applied } = autoRepairStructural(spec, v.validate(spec).issues);
    assert.equal(applied.filter(a => a.op === 'set_config').length, 0);
  });
});
