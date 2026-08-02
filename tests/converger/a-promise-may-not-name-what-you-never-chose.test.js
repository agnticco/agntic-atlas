/**
 * A PROMISE MAY NOT NAME A DESTINATION THE WORKFLOW BUILDS AS IT RUNS.
 *
 * MEASURED ACROSS EVERY STORED WORKFLOW, 2026-08-02: of 58 promises on 41 workflows,
 * **23 (40%) named a destination no built step matches** — and 11 of those were this
 * shape: the step's destination is computed at run time (`{{write_briefing.date_title}}`,
 * `{{extract_email.subject}}`), so no literal exists for any repair to match.
 *
 * THE CAUSE IS ORDERING. `outcome` runs at STEP 0 — before `process`, `examples`,
 * `analyze`, `plan`, `generate` — so the contract is written from the opening sentence,
 * before the workflow exists. It invents a destination name; `generate` then builds the
 * steps that actually decide where things go; nothing reconciles them except
 * `retargetStaleAssertion`, which needs a literal the person typed.
 *
 * WITNESSED, three builds in a row: the person asked for a briefing saved as a Doc
 * "titled with that day's date". Atlas built exactly that — and held itself to a
 * document called "Daily AI Briefing", a name they never said and it never creates.
 *
 * THE FIX PROMISES LESS, AND ONLY THE INVENTED PART. The KIND came from the person
 * ("a document is created in Google Docs") and stays; the specific name did not and
 * goes. A connector-only target is already first-class — the runtime check reads an
 * empty locator as "some delivery to this connector is enough" — so the promise stays
 * checkable rather than becoming unfalsifiable.
 *
 * MOST OF THIS FILE IS THE OTHER DIRECTION. Anything that promises less is one step from
 * a way to pass by promising nothing, so the cases that must NOT generalise outnumber
 * the one that must.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { generaliseComputedTarget, autoRepairStructural } from '../../src/converger/elicitation-graph.js';
import { setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';
import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';

function catalog() {
  const reg = new CapabilityRegistry();
  registerGoogleChannels(reg);
  setCapabilityCatalog(reg);
}

/** The prod shape: an extract step, then a Doc whose title it computes. */
const draftWith = (title, target = 'gdocs:Daily AI Briefing') => ({
  name: 'Daily briefing',
  outcome: {
    statement: 'A briefing is saved as a Google Doc titled with the date.',
    assertions: [{ id: 'a1', kind: 'document_exists', target }],
  },
  nodes: [
    { id: 'write_briefing', type: 'llm', label: 'Write', config: { mode: 'extract', fields: 'date_title: x' } },
    { id: 'save_doc', type: 'deliver', label: 'Save', config: { channel: 'docs_create', title, content: 'body' } },
  ],
  edges: [{ from: 'write_briefing', to: 'save_doc' }],
});

const GAP = (target = 'gdocs:Daily AI Briefing') =>
  ({ id: 'g1', code: 'UNSATISFIED_ASSERTION', target, message: 'nothing reached it' });

describe('the invented name is dropped, the promise is kept', () => {
  test('a computed destination generalises to the service', () => {
    catalog();
    const move = generaliseComputedTarget(draftWith('{{write_briefing.date_title}}'), GAP(), new Set());
    assert.ok(move, 'a promise no literal can ever match must not simply fail forever');
    assert.equal(move.target, 'gdocs', 'the service is kept — only the invented name goes');
    assert.equal(move.from, 'gdocs:Daily AI Briefing');
  });

  test('applied through the real repair seam, and recorded', () => {
    catalog();
    const r = autoRepairStructural(draftWith('{{write_briefing.date_title}}'), [GAP()], { userSaid: new Set() });
    assert.equal(r.draft.outcome.assertions[0].target, 'gdocs');
    assert.ok(r.applied.some(a => a.op === 'generalise_assertion_target'),
      'a promise quietly weakened with no record is exactly what must not happen');
  });

  test('the KIND and the user\'s own sentence are untouched', () => {
    catalog();
    const before = draftWith('{{write_briefing.date_title}}');
    const r = autoRepairStructural(before, [GAP()], { userSaid: new Set() });
    assert.equal(r.draft.outcome.assertions[0].kind, 'document_exists',
      'the kind of promise came from the person and must survive');
    assert.equal(r.draft.outcome.statement, before.outcome.statement,
      'their words are never edited — only the machine-checkable target');
  });

  test('a condition on the promise survives', () => {
    catalog();
    const d = draftWith('{{write_briefing.date_title}}');
    d.outcome.assertions[0].when = 'urgent';
    const r = autoRepairStructural(d, [GAP()], { userSaid: new Set() });
    assert.equal(r.draft.outcome.assertions[0].when, 'urgent',
      'promising on one lane only must not silently become promising on all of them');
  });
});

describe('it does NOT become a way to pass by promising nothing', () => {
  test('a destination the PERSON typed is left alone', () => {
    // Then the promise is right and the workflow is wrong — the opposite repair.
    catalog();
    const move = generaliseComputedTarget(
      draftWith('{{write_briefing.date_title}}'), GAP(), new Set(['Daily AI Briefing']));
    assert.equal(move, null,
      'weakening a promise the person actually asked for is the worst version of this');
  });

  test('a LITERAL destination that merely differs is a real mismatch, not a rename', () => {
    catalog();
    const move = generaliseComputedTarget(
      draftWith('Some Other Document'), GAP(), new Set());
    assert.equal(move, null,
      'the two CAN be compared and they differ — that finding must survive');
  });

  test('no step of that kind reaching that service is still "no step does that"', () => {
    catalog();
    const d = draftWith('{{write_briefing.date_title}}');
    d.nodes = d.nodes.filter(n => n.type !== 'deliver');   // nothing writes a document at all
    assert.equal(generaliseComputedTarget(d, GAP(), new Set()), null,
      'a promise nothing keeps must keep failing — generalising would hide it');
  });

  test('a promise about a DIFFERENT service is not generalised onto this one', () => {
    catalog();
    const move = generaliseComputedTarget(
      draftWith('{{write_briefing.date_title}}', 'sheets:Some Tab'), GAP('sheets:Some Tab'), new Set());
    assert.equal(move, null,
      'the workflow writes a Doc; a promise about Sheets is unkept and must say so');
  });

  test('a promise that is already service-only is left alone', () => {
    catalog();
    assert.equal(generaliseComputedTarget(draftWith('{{x.y}}', 'gdocs'), GAP('gdocs'), new Set()), null,
      'nothing to drop — and re-entering here would churn the contract');
  });

  test('a gap that is not an unkept promise never triggers it', () => {
    catalog();
    const r = autoRepairStructural(draftWith('{{write_briefing.date_title}}'),
      [{ id: 'g2', code: 'DIGEST_MISSING_SECTIONS', target: 'gdocs:Daily AI Briefing' }],
      { userSaid: new Set() });
    assert.equal(r.draft.outcome.assertions[0].target, 'gdocs:Daily AI Briefing',
      'only an UNSATISFIED_ASSERTION may move a promise');
  });
});
