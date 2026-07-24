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
 *  - it covers MULTIPLE sources too — one section per source, in edge order, each
 *    under its own step's name. The old "two sources stays a question" rule was the
 *    SOURCE of the worst live loop (2026-07-23, ~11 min): a multi-source document left
 *    `sections` blank, the question routed the answer through a whole-spec regenerate
 *    that reproduced the same blank, so it re-asked and never stuck. A complete default
 *    drops no content and is editable — strictly better than a question the user cannot
 *    usefully answer;
 *  - ZERO content parents stays a genuine gap — a document with nothing feeding it has
 *    nothing to lay out;
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

describe('a missing section list repairs itself, single or multi source', () => {
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

  test('TWO upstream content steps — a complete default is offered, one section per source', () => {
    // The old behaviour left this blank and ASKED — and because the answer routed
    // through a whole-spec regenerate that reproduced the blank, it re-asked and never
    // stuck (~11 min live, 2026-07-23). A complete default is strictly better.
    const spec  = specWith(['sum_a', 'sum_b']);
    const issue = sectionIssue(validatorOf().validate(spec));
    assert.ok(issue, 'still reported');
    assert.ok(issue.fix, 'a multi-source document must fill a default now, not ask a question the answer never sticks to');
    const sections = JSON.parse(issue.fix.config.sections);
    assert.equal(sections.length, 2, 'one section per content source — nothing dropped');
    assert.deepEqual(sections.map(s => s.content), ['{{sum_a.output}}', '{{sum_b.output}}'],
      'every source appears, in the order they were wired');
    assert.deepEqual(sections.map(s => s.heading), ['sum_a', 'sum_b'],
      'each section is headed by its own source step, since there is no single title to share');
    // AND applying it clears the defect (a repair that does not is worse than none).
    const { applied, draft } = autoRepairStructural(spec, validatorOf().validate(spec).issues);
    assert.ok(applied.some(a => a.op === 'set_config'));
    assert.ok(!sectionIssue(validatorOf().validate(draft)), 'the blank is gone — the loop is broken');
  });

  test('ZERO content parents — stays a genuine gap (nothing feeds the document)', () => {
    // A document with no content source is not a blank to fill — there is nothing to
    // lay out — so it must stay a real question, never a silently-invented body.
    const spec  = specWith([]);   // doc fed by nothing
    const issue = sectionIssue(validatorOf().validate(spec));
    assert.ok(issue, 'still reported');
    assert.ok(!issue.fix, 'no source means no default — this is a real gap');
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

  test('a document BEHIND an approval gate — looks THROUGH the control step to its content', () => {
    // THE ACTUAL LIVE LOOP (2026-07-23/24). "Compose the approved record" hangs off the
    // approval branch, so its only direct parent is a control node and it has ZERO direct
    // content parents. The first fix gave up here ("< 1 content parents") and the blank
    // went to the user and back through a regenerate that reproduced it — forever. The
    // repair must look THROUGH the branch/human to the summary that feeds them.
    const spec = {
      name: 'T', triggers: [{ type: 'email' }],
      nodes: [
        { id: 'trigger',   type: 'trigger', label: 'Email',   config: { type: 'email' } },
        { id: 'summarize', type: 'llm',     label: 'Summarize', config: { mode: 'summarize', prompt: 'x' } },
        { id: 'ask',       type: 'human',   label: 'Approve', config: { prompt: 'Save?', decisions: ['approve', 'reject'], timeout: { after: '1d' } } },
        { id: 'gate',      type: 'branch',  label: 'Route by approval', config: { on: '{{ask.decision}}', cases: [{ when: 'approve', to: 'doc' }, { when: '*', to: 'drop' }] } },
        { id: 'doc',       type: 'assemble', label: 'Compose approved record', config: { title: 'Email Summary' } },
        { id: 'drop',      type: 'deliver', label: 'Stop',    config: { channel: 'inbox', subject: 'x' } },
        { id: 'send',      type: 'deliver', label: 'Save',    config: { channel: 'inbox', subject: 'S' } },
      ],
      edges: [
        { from: 'trigger', to: 'summarize' }, { from: 'summarize', to: 'ask' }, { from: 'ask', to: 'gate' },
        { from: 'gate', to: 'doc' }, { from: 'gate', to: 'drop' }, { from: 'doc', to: 'send' },
      ],
    };
    const issue = validatorOf().validate(spec).issues
      .find(i => i.code === 'DIGEST_MISSING_SECTIONS' && i.nodeId === 'doc');
    assert.ok(issue, 'the blank must still be reported for the document');
    assert.ok(issue.fix, 'a document behind a gate must look through it, not give up and loop the user');
    const sections = JSON.parse(issue.fix.config.sections);
    assert.equal(sections.length, 1, 'one content source feeds it (through the gate)');
    assert.equal(sections[0].content, '{{summarize.output}}',
      'the body comes from the summary that feeds the gate — seen THROUGH the branch and the human');
    // and applying it clears the defect (breaks the loop).
    const { draft } = autoRepairStructural(spec, validatorOf().validate(spec).issues);
    assert.ok(!validatorOf().validate(draft).issues.some(i => i.code === 'DIGEST_MISSING_SECTIONS' && i.nodeId === 'doc'),
      'the blank is filled without a question — the loop is broken');
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
