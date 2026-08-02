/**
 * A PROMISE MAY NOT NAME A DESTINATION THE WORKFLOW BUILDS AS IT RUNS.
 *
 * Witnessed three builds running, 2026-08-02: the person asked for a briefing saved as a
 * Doc *"titled with that day's date"*. Atlas built exactly that — and held itself to a
 * document called "Daily AI Briefing", a name they never said and it never creates.
 *
 * THE CAUSE IS ORDERING. `outcome` runs at STEP 0, before `process`, `examples`,
 * `analyze`, `plan` and `generate`, so the contract is written from the opening sentence
 * before the workflow exists. It invents a destination; `generate` then builds the steps
 * that decide where things actually go; nothing reconciles them except
 * `retargetStaleAssertion`, which needs a literal the person typed. A destination
 * computed at run time has no such literal, so no repair could fire.
 *
 * ── THIS SHIPPED ONCE AS DEAD CODE, AND THAT IS THE LESSON ───────────────────
 *
 * The first version hung off an `UNSATISFIED_ASSERTION` gap. Measured the same day:
 *
 *     satisfiesAssertion, template locator      : true
 *     satisfiesAssertion, literal that differs  : false
 *
 * Build-time treats a template destination as SATISFIED — undecidable is read as kept —
 * so that gap never fires for a computed destination, which is the only case this repair
 * exists for. It could not run, and never did. The mismatch is real at RUN time: build
 * excuses the template, the test panel then compares the promise against the real
 * receipt and finds "Daily AI Briefing" ≠ "August 2, 2026".
 *
 * So it now runs where the spec has SETTLED and every destination is knowable, asked of
 * every promise unconditionally, rather than waiting for a gap that cannot occur.
 *
 * MOST OF THIS FILE IS THE OTHER DIRECTION. Anything that promises less is one step from
 * a way to pass by promising nothing, so the cases that must NOT generalise outnumber
 * the one that must.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { generaliseComputedTarget } from '../../src/converger/elicitation-graph.js';
import { satisfiesAssertion, setCapabilityCatalog } from '../../src/workflows/outcome-oracle.js';
import { CapabilityRegistry } from '../../src/connectors/capability-registry.js';
import { registerGoogleChannels } from '../../src/connectors/google/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRAPH = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

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

const TEMPLATE = '{{write_briefing.date_title}}';

describe('THE REASON THE FIRST VERSION WAS DEAD', () => {
  test('build-time calls a template destination SATISFIED, so no gap is ever raised', () => {
    catalog();
    const node = draftWith(TEMPLATE).nodes[1];
    assert.equal(satisfiesAssertion({ id: 'a1', kind: 'document_exists', target: 'gdocs:Daily AI Briefing' }, node), true,
      'if this ever returns false, the gap-driven wiring becomes viable again — but until '
      + 'then, keying this repair off UNSATISFIED_ASSERTION is dead code');
  });
});

describe('the invented name is dropped, the promise is kept', () => {
  test('a computed destination generalises to the service', () => {
    catalog();
    const move = generaliseComputedTarget(draftWith(TEMPLATE), 0, new Set());
    assert.ok(move, 'a promise no literal can ever match must not simply fail forever');
    assert.equal(move.target, 'gdocs', 'the service is kept — only the invented name goes');
    assert.equal(move.from, 'gdocs:Daily AI Briefing');
  });

  test('the promise it moves is the one at that index', () => {
    catalog();
    const d = draftWith(TEMPLATE);
    d.outcome.assertions.unshift({ id: 'a0', kind: 'message_sent', target: 'gmail:sam@acme.com' });
    assert.equal(generaliseComputedTarget(d, 0, new Set()), null, 'the email promise is not this one');
    const move = generaliseComputedTarget(d, 1, new Set());
    assert.equal(move?.index, 1, 'and the doc promise is found at its own index');
  });
});

describe('it does NOT become a way to pass by promising nothing', () => {
  test('a destination the PERSON typed is left alone', () => {
    // Then the promise is right and the workflow is wrong — the opposite repair.
    catalog();
    assert.equal(generaliseComputedTarget(draftWith(TEMPLATE), 0, new Set(['Daily AI Briefing'])), null,
      'weakening a promise the person actually asked for is the worst version of this');
  });

  test('a LITERAL destination that merely differs is a real mismatch, not a rename', () => {
    catalog();
    assert.equal(generaliseComputedTarget(draftWith('Some Other Document'), 0, new Set()), null,
      'the two CAN be compared and they differ — that finding must survive');
  });

  test('no step of that kind reaching that service is still "no step does that"', () => {
    catalog();
    const d = draftWith(TEMPLATE);
    d.nodes = d.nodes.filter(n => n.type !== 'deliver');
    assert.equal(generaliseComputedTarget(d, 0, new Set()), null,
      'a promise nothing keeps must keep failing — generalising would hide it');
  });

  test('a promise about a DIFFERENT service is not generalised onto this one', () => {
    catalog();
    assert.equal(generaliseComputedTarget(draftWith(TEMPLATE, 'sheets:Some Tab'), 0, new Set()), null,
      'the workflow writes a Doc; a promise about Sheets is unkept and must say so');
  });

  test('a promise that is already service-only is left alone', () => {
    catalog();
    assert.equal(generaliseComputedTarget(draftWith(TEMPLATE, 'gdocs'), 0, new Set()), null,
      'nothing to drop — and re-entering here would churn the contract');
  });

  test('an index that names no promise does nothing', () => {
    catalog();
    for (const i of [-1, 5, null, undefined, 'x']) {
      assert.equal(generaliseComputedTarget(draftWith(TEMPLATE), i, new Set()), null, String(i));
    }
  });
});

describe('the KIND and the user\'s own words are never touched', () => {
  test('only the target moves', () => {
    catalog();
    const before = draftWith(TEMPLATE);
    before.outcome.assertions[0].when = 'urgent';
    const move = generaliseComputedTarget(before, 0, new Set());
    assert.ok(move);
    // The repair returns only {index, target, from} — it cannot express a change to
    // anything else, which is the strongest form of "kind and when are safe".
    assert.deepEqual(Object.keys(move).sort(), ['from', 'index', 'target']);
    assert.equal(before.outcome.assertions[0].kind, 'document_exists', 'the draft is not mutated');
    assert.equal(before.outcome.assertions[0].when, 'urgent');
  });
});

describe('it is wired where the spec has SETTLED, not to a gap', () => {
  // SOURCE-level: the `verify` node closes over the LLM, graph state and `interrupt`, so
  // it cannot be lifted and executed. Said plainly because it is weaker than the rest.
  test('verify calls it over every promise', () => {
    assert.match(GRAPH, /for \(let i = 0; i < as\.length; i\+\+\) \{[\s\S]{0,120}generaliseComputedTarget\(draft, i, said\)/,
      'it must be asked of every promise, not of a gap');
  });

  test('and it is NOT hung off an UNSATISFIED_ASSERTION gap again', () => {
    const repair = GRAPH.slice(GRAPH.indexOf('export function autoRepairStructural'),
                               GRAPH.indexOf('export function autoRepairStructural') + 3000);
    assert.doesNotMatch(repair, /generaliseComputedTarget/,
      'that gap cannot fire for a template destination — see the first describe in this file');
  });

  test('a generalisation is recorded, never silent', () => {
    assert.match(GRAPH, /converger\.promise_generalised[\s\S]{0,120}from:[\s\S]{0,40}to:/,
      'quietly weakening a promise with no record is exactly what must not happen');
  });
});
