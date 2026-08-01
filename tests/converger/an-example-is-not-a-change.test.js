/**
 * ASKING FOR A TEST CASE IS NOT ASKING FOR A CHANGE — AND COUNTING IS NOT COVERAGE.
 *
 * Two defects from one prod build (`build-platform-1785513701920`, 2026-07-31), which
 * compounded into "a correct workflow cannot be cleared to go live":
 *
 * 1. **The top-up that gives every path a test input skipped.** Its gate read
 *    `lanes.length <= have.length` — two COUNTS — so two paths with three samples all
 *    aimed at the SAME path logged `enough_samples_already` and left the other path with
 *    nothing. Measured that day: `lanes: 2, had: 3`, error path unproved.
 * 2. **So the panel asked the person for one**, in its own words — *"give me an example
 *    that takes it and I'll check the rest"* — and typing one took the `ratify_feedback`
 *    route into a **107-second whole-spec regenerate** that renamed the route from
 *    `error` to `none` and **did not add the example**. The one remedy the product offers
 *    cost a paid rebuild, did not work, and moved the spec underneath someone who had
 *    asked for nothing to move.
 *
 * THE ANTI-FALSE-POSITIVE CASES ARE THE POINT HERE. Reading a genuine change request as
 * a test case would silently ignore someone asking for their workflow to be different —
 * far worse than the wasted rebuild this removes. So every doubt, every malformed answer
 * and every failure resolves to CHANGE, which is exactly the behaviour that shipped
 * before this existed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  unprovedLanes, laneKeyOf, readTestCaseRequest, withTestCase, buildTestCaseRequestPrompt,
} from '../../src/converger/test-case-request.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The prod shape: two paths off one branch, and samples aimed wherever we say. */
function twoPathSpec(examples) {
  return {
    name: 'Pricing enquiry logger',
    nodes: [
      { id: 'classify', type: 'llm', config: { mode: 'classify', categories: 'valid\nerror' } },
      { id: 'route', type: 'branch',
        config: { on: 'classify.output',
                  cases: [{ when: 'valid', to: 'append_row' },
                          { when: 'error', to: 'do_nothing' },
                          { when: '*',     to: 'do_nothing' }] } },
      { id: 'append_row', type: 'deliver', label: 'Append row',
        config: { channel: 'sheets_append', spreadsheetId: '1DG5qZ9', range: 'Sheet1', values: [['a']] } },
      { id: 'do_nothing', type: 'stop', label: 'End — no usable content', config: {} },
    ],
    edges: [{ from: 'classify', to: 'route' }, { from: 'route', to: 'append_row' }, { from: 'route', to: 'do_nothing' }],
    outcome: { statement: 'Logs pricing enquiries.', examples },
  };
}

const LANES = unprovedLanes(twoPathSpec([]));

describe('COUNTING IS NOT COVERAGE — the gate that skipped the top-up', () => {
  test('THE PROD CASE: two paths, three samples, all aimed at one path', () => {
    // `lanes: 2, had: 3` logged `enough_samples_already` and the error path got nothing.
    const spec = twoPathSpec([
      { id: 'e1', given: { subject: 'Pricing?' },  lane: 'append_row' },
      { id: 'e2', given: { subject: 'How much?' }, lane: 'append_row' },
      { id: 'e3', given: { subject: 'Costs?' },    lane: 'append_row' },
    ]);
    const open = unprovedLanes(spec);
    assert.equal(open.length, 1, 'three samples on one path read as covering both');
    assert.equal(laneKeyOf(open[0]), 'do_nothing');
  });

  test('an example that names NO path covers nothing', () => {
    // Attribution is unknowable for samples generated before the workflow existed, and
    // "we cannot tell" must never read as "covered" — that is how an unproved path gets
    // reported as tested.
    const spec = twoPathSpec([
      { id: 'e1', given: { subject: 'a' } }, { id: 'e2', given: { subject: 'b' } },
      { id: 'e3', given: { subject: 'c' } }, { id: 'e4', given: { subject: 'd' } },
    ]);
    assert.equal(unprovedLanes(spec).length, 2, 'unattributed samples were counted as cover');
  });

  test('every path claimed ⇒ nothing is open, and no top-up is paid for', () => {
    const spec = twoPathSpec([
      { id: 'e1', given: { subject: 'a' }, lane: 'append_row' },
      { id: 'e2', given: { subject: 'b' }, lane: 'do_nothing' },
    ]);
    assert.deepEqual(unprovedLanes(spec), []);
  });

  test('an example with no input claims nothing, however it is labelled', () => {
    const spec = twoPathSpec([{ id: 'e1', lane: 'do_nothing' }, { id: 'e2', given: { subject: 'a' }, lane: 'append_row' }]);
    assert.equal(unprovedLanes(spec).length, 1);
    assert.equal(laneKeyOf(unprovedLanes(spec)[0]), 'do_nothing');
  });

  test('a workflow that does not branch has no path to miss', () => {
    const spec = { nodes: [{ id: 'a', type: 'deliver', config: { channel: 'slack', target: '#ops' } }], edges: [], outcome: {} };
    assert.deepEqual(unprovedLanes(spec), []);
  });

  test('the graph reads path coverage from THIS function, not its own copy', () => {
    // SOURCE-level and weaker than the rest, said plainly: the verify node closes over
    // the LLM and the dry runner and cannot be lifted. It is here because the first
    // version of this fix computed the same rule inline in the graph AND in this module
    // — two answers to one question, which is the defect shape this repo has paid for
    // more than any other.
    const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');
    assert.match(SRC, /const openLanes = unprovedLanes\(assembleSpec\(draft\)\)/);
    // Scoped to the GATE EXPRESSION, not to the words: the first version of this
    // assertion searched for `lanes.length <= have.length` anywhere in the file and
    // matched the comment explaining why that gate was wrong — a test red forever for
    // a reason that has nothing to do with the code.
    assert.match(SRC, /:\s*!openLanes\.length\s+\?\s*'every_path_already_claimed'/,
      'the top-up gate no longer asks which paths are open');
    assert.doesNotMatch(SRC, /\?\s*'enough_samples_already'/,
      'the count-based skip is back — three samples on one path will skip the top-up again');
  });
});

describe('AN EXAMPLE IS NOT A CHANGE', () => {
  test('a described input becomes an example aimed at the open path', () => {
    const got = readTestCaseRequest({
      kind: 'test_case',
      example: { label: 'Empty body', lane: 'do_nothing', given: { subject: 'Pricing?', body: '' } },
    }, LANES);
    assert.ok(got, 'a well-formed test case was refused');
    assert.equal(got.lane, 'do_nothing');
    assert.deepEqual(got.given, { subject: 'Pricing?', body: '' });
  });

  test('a CHANGE request is refused, and falls through to the rebuild', () => {
    assert.equal(readTestCaseRequest({ kind: 'change' }, LANES), null);
  });

  test('anything unrecognised is treated as a change', () => {
    // Every doubt resolves the safe way: today's behaviour, never worse.
    for (const answer of [null, undefined, {}, { kind: '' }, { kind: 'test_case' },
                          { kind: 'test_case', example: null }, { kind: 'TEST_CASE' }, 'test_case']) {
      assert.equal(readTestCaseRequest(answer, LANES), null, JSON.stringify(answer));
    }
  });

  test('a test case with NO input is refused — there is nothing to run', () => {
    assert.equal(readTestCaseRequest({ kind: 'test_case', example: { lane: 'do_nothing', label: 'x' } }, LANES), null);
    assert.equal(readTestCaseRequest({ kind: 'test_case', example: { lane: 'do_nothing', given: {} } }, LANES), null);
  });

  test('a test case naming NO path, or a path that is not open, is refused', () => {
    // Adding it would grow the sample count while leaving the path exactly as unproved
    // as before — which reads on the panel as progress and is not.
    assert.equal(readTestCaseRequest({ kind: 'test_case', example: { given: { a: 1 }, label: 'x' } }, LANES), null);
    assert.equal(readTestCaseRequest({ kind: 'test_case', example: { given: { a: 1 }, lane: 'no_such_path' } }, LANES), null);
  });

  test('the path id is matched however it is cased or spaced', () => {
    const got = readTestCaseRequest({ kind: 'test_case', example: { given: { a: 1 }, lane: '  DO_NOTHING ' } }, LANES);
    assert.equal(got?.lane, 'do_nothing');
  });
});

describe('adding it to the build', () => {
  test('the example lands on the draft', () => {
    const ex = readTestCaseRequest({ kind: 'test_case', example: { lane: 'do_nothing', given: { body: '' } } }, LANES);
    const next = withTestCase({ outcome: { examples: [{ id: 'e1', given: { a: 1 }, lane: 'append_row' }] } }, ex);
    assert.equal(next.outcome.examples.length, 2);
    assert.equal(next.outcome.examples.at(-1).lane, 'do_nothing');
  });

  test('and it CLOSES the path it was aimed at', () => {
    // The whole point. If the added example did not claim the lane, the panel would ask
    // for another one and the person would type forever.
    const ex = readTestCaseRequest({ kind: 'test_case', example: { lane: 'do_nothing', given: { body: '' } } }, LANES);
    const spec = withTestCase(twoPathSpec([{ id: 'e1', given: { a: 1 }, lane: 'append_row' }]), ex);
    assert.deepEqual(unprovedLanes(spec), []);
  });

  test('a second attempt at the same path REPLACES the first', () => {
    // A second try means the first did not do the job; keeping both leaves the panel
    // showing a sample they have already superseded.
    const a = readTestCaseRequest({ kind: 'test_case', example: { lane: 'do_nothing', given: { body: 'v1' } } }, LANES);
    const b = readTestCaseRequest({ kind: 'test_case', example: { lane: 'do_nothing', given: { body: 'v2' } } }, LANES);
    const next = withTestCase(withTestCase(twoPathSpec([]), a), b);
    assert.equal(next.outcome.examples.length, 1);
    assert.deepEqual(next.outcome.examples[0].given, { body: 'v2' });
  });

  test('the draft is returned untouched when there is nothing to add', () => {
    const draft = twoPathSpec([]);
    assert.equal(withTestCase(draft, null), draft);
  });
});

describe('the question put to the model', () => {
  const prompt = () => buildTestCaseRequestPrompt({
    feedback: 'Test the error path too: an email with an empty body.',
    lanes: LANES, intent: 'log pricing enquiries', outcome: { statement: 'Logs them.' },
  });

  test('it names the open paths by the id an answer must use', () => {
    assert.match(prompt(), /\(id: do_nothing\)/);
  });

  test("it carries the person's words verbatim", () => {
    assert.match(prompt(), /an email with an empty body/);
  });

  test('and it says which way to resolve a doubt', () => {
    // The instruction is a belief about model behaviour and is pinned by nothing; the
    // refusals above are what make being wrong about it safe. It is asserted anyway so
    // it cannot be dropped silently.
    assert.match(prompt(), /If you are not sure, answer "change"/);
  });
});

describe('BOTH doors into the rebuild use the one rule', () => {
  // The walkthrough's "request changes" and ratify's feedback both reach the whole-spec
  // regenerate. A rule about what a person's message MEANS, written twice, is the shape
  // this codebase has paid for most — so this asserts there is exactly one helper and
  // that both call it. SOURCE-level; neither node can be lifted.
  const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

  test('there is exactly one helper, and it is called twice', () => {
    const calls = SRC.match(/await testCaseFromFeedback\(/g) ?? [];
    assert.equal(calls.length, 2, 'a door was added or removed without the shared rule');
    assert.equal((SRC.match(/async function testCaseFromFeedback\(/g) ?? []).length, 1);
  });

  test('a test case re-presents the spec instead of regenerating it', () => {
    assert.match(SRC, /phase:\s*'re_ratifying'/);
    assert.match(SRC, /if \(state\.phase === 're_ratifying'\) return 'ratify'/);
  });
});
