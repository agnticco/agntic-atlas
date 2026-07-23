/**
 * REPAIR THE ONE BROKEN THING; DON'T REBUILD ALL THIRTEEN NODES.
 *
 * QA Manager runaway-build finding (2026-07-22). A three-lane approval build took
 * ~9 minutes because its own self-check rejected the spec and the converger threw
 * away the whole workflow and regenerated — a full Opus pass — up to three times.
 * The first rejection (proved from the log) was `DELIVER_NO_INPUT ×3 | MISSING_NAME`.
 *
 * The deterministic repairs already existed — a missing route edge, a missing section
 * list, an uncheckable promise — but they ran in `gaps`, which the build only reaches
 * AFTER the regenerate loop. So a blocker a one-line edit could fix instead paid for a
 * rebuild first. This moves the repair BEFORE the regenerate decision, and adds the
 * cheapest repair of all: a workflow never needs a model to name itself.
 *
 * WHAT THESE PIN:
 *  - a missing name is filled from the outcome the user already confirmed, and NEVER
 *    overrides a name the model did set;
 *  - the fill happens BEFORE a rebuild would (in the auto-repair), so a build blocked
 *    only on a name does not spend an Opus pass on it;
 *  - the repair only runs on a spec the model has actually built — running it on the
 *    empty pre-generate draft would derive a name and then swallow the real one (the
 *    exact regression an existing test caught while this was being written);
 *  - a delivery with nothing wired to it is NOT auto-repaired. Guessing which content
 *    feeds a delivery risks sending the customer the wrong thing — the one failure the
 *    whole outcome system exists to prevent — so it stays the model's job.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { autoRepairStructural } from '../../src/converger/elicitation-graph.js';
import { deriveWorkflowName } from '../../src/workflows/workflow-validator.js';
import { WorkflowValidator } from '../../src/workflows/workflow-validator.js';
import { NodeTypeRegistry } from '../../src/workflows/node-type-registry.js';
import { registerBuiltInNodeTypes } from '../../src/workflows/node-types/index.js';

function validatorOf() {
  const reg = new NodeTypeRegistry();
  registerBuiltInNodeTypes(reg);
  return new WorkflowValidator({ nodeTypes: reg });   // the option PRODUCTION passes
}

describe('deriveWorkflowName', () => {
  test('uses the outcome the user confirmed, clipped to one clause', () => {
    assert.equal(deriveWorkflowName({ outcome: { statement: 'Save each lead to Airtable and DM the team.' } }),
      'Save each lead to Airtable and DM the team');
  });
  test('a long statement is clipped, not dumped whole into the sidebar', () => {
    const n = deriveWorkflowName({ outcome: { statement: 'When an urgent email arrives, classify it and ask Charles to approve before filing it' } });
    assert.ok(n.length <= 49, `derived name too long for a sidebar row: ${n.length}`);
    assert.match(n, /…$/);
  });
  test('falls back to the trigger when there is no outcome', () => {
    assert.equal(deriveWorkflowName({ triggers: [{ type: 'email' }] }), 'Email workflow');
    assert.equal(deriveWorkflowName({ triggers: [{ type: 'schedule' }] }), 'Scheduled workflow');
  });
  test('never returns empty', () => {
    assert.ok(deriveWorkflowName({}).trim().length > 0);
  });
});

describe('the validator offers a mechanical name fix', () => {
  test('MISSING_NAME carries a set_name fix derived from the outcome', () => {
    const spec = {
      // no name
      triggers: [{ type: 'email' }],
      outcome: { statement: 'File urgent mail once approved.' },
      nodes: [
        { id: 't', type: 'trigger', label: 'E', config: { type: 'email' } },
        { id: 'd', type: 'deliver', label: 'Save', config: { channel: 'in_app', subject: 'S' } },
      ],
      edges: [{ from: 't', to: 'd' }],
    };
    const issue = validatorOf().validate(spec).issues.find(i => i.code === 'MISSING_NAME');
    assert.ok(issue, 'a nameless workflow must still be flagged');
    assert.equal(issue.fix?.op, 'set_name');
    assert.equal(issue.fix.name, 'File urgent mail once approved');
  });
});

describe('auto-repair fills a missing name', () => {
  const nameGap = (name) => ({ id: 'g', code: 'MISSING_NAME', fix: { op: 'set_name', name } });

  test('a blank name is filled', () => {
    const { draft, applied } = autoRepairStructural({ name: '', nodes: [], edges: [] }, [nameGap('My workflow')]);
    assert.equal(draft.name, 'My workflow');
    assert.equal(applied[0].op, 'set_name');
  });

  test('a name the model DID set is never overridden', () => {
    const { draft, applied } = autoRepairStructural({ name: 'Leads', nodes: [] }, [nameGap('Leads are saved')]);
    assert.equal(draft.name, 'Leads', 'overriding a real title would silently discard the model\'s choice');
    assert.equal(applied.length, 0);
  });
});

describe('the analyze node wires the repair correctly', () => {
  const GRAPH = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/converger/elicitation-graph.js'), 'utf8');
  const analyze = (() => {
    const s = GRAPH.indexOf("graph.addNode('analyze'");
    const e = GRAPH.indexOf('graph.addNode(', s + 20);
    assert.ok(s > 0 && e > s, 'the analyze node moved — re-point this test');
    return GRAPH.slice(s, e);
  })();

  test('the repair runs only on a spec the model has already built (_generated)', () => {
    // Without this gate the repair fires on the empty pre-generate draft, derives a
    // name from the outcome, and swallows the real name generate later produces.
    assert.match(analyze, /if \(state\._generated\) \{[\s\S]*?autoRepairStructural/,
      'the pre-regen repair must be gated on state._generated');
  });

  test('the repair happens BEFORE scoreGap drives the regenerate decision', () => {
    const repairAt = analyze.indexOf('autoRepairStructural');
    const decideAt = analyze.indexOf('const gap = scoreGap(draft');
    assert.ok(repairAt > 0 && decideAt > repairAt,
      'repairing after the decision would mean the rebuild already fired — the whole point is to prevent it');
  });

  test('the decision reads the REPAIRED draft, not the original', () => {
    assert.match(analyze, /const gap = scoreGap\(draft, /,
      'scoring state.draft here would decide on the un-repaired spec and rebuild anyway');
  });
});

describe('a delivery with nothing wired to it is NOT auto-repaired', () => {
  test('there is no repair op that wires a floating delivery', () => {
    // Guessing which content feeds a delivery risks delivering the wrong thing to the
    // customer. This asserts we did not add such a fix behind our own back.
    const floating = {
      name: 'X', triggers: [{ type: 'email' }],
      nodes: [
        { id: 't', type: 'trigger', label: 'E', config: { type: 'email' } },
        { id: 'a', type: 'llm', label: 'A', config: { mode: 'summarize', prompt: 'x' } },
        { id: 'd', type: 'deliver', label: 'Save', config: { channel: 'in_app', subject: 'S' } },
      ],
      edges: [{ from: 't', to: 'a' }],   // 'd' has NO incoming edge
    };
    const gaps = validatorOf().validate(floating).issues;
    const del = gaps.find(g => g.code === 'DELIVER_NO_INPUT');
    assert.ok(del, 'the floating delivery must still be flagged');
    assert.ok(!del.fix, 'a floating delivery must never carry an auto-wire fix — the model wires it, not us');
    const { applied } = autoRepairStructural(floating, gaps);
    assert.ok(!applied.some(a => a.op === 'add_edge'),
      'auto-repair must not invent an edge into a delivery');
  });
});
