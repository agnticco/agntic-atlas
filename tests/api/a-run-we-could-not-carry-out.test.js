/**
 * A TEST WE COULD NOT RUN IS NOT A BROKEN WORKFLOW — THE TEST PANEL'S HALF.
 *
 * ── The defect ───────────────────────────────────────────────────────────────
 *
 * A model that times out at 120s, a 429, a provider refusing us, the box unable
 * to reach a service — none of those say anything about the workflow. Scored as a
 * broken run they read as **"Contract not met"**, lock Go live, and PATCH the
 * workflow to `error`. Re-running passes. The person is told their workflow is
 * broken because our side had a bad minute.
 *
 * ── Why this file exists separately from the converger's ─────────────────────
 *
 * The converger's `verify` node was taught exactly this distinction on
 * 2026-08-01 (`tests/converger/a-test-we-could-not-run.test.js`) and **the test
 * panel never got it** — a fix reaching one of two places, which is the shape
 * this repo has paid for repeatedly. Measured 2026-08-02: `isTransientFailure`
 * was imported by nothing in `src/` or `public/`.
 *
 * ── Where the decision lives, and why there ──────────────────────────────────
 *
 * SERVER-SIDE, on the `run_failed` path, returned as a `transient` flag. The
 * browser holds no copy of the rule, so the two cannot drift. `isTransientFailure`
 * is itself derived from the SAME pattern table the user-facing error message
 * comes from — never a second regex list — and is deliberately NARROW: anything
 * unrecognised stays a REAL failure, because excusing a genuine wiring defect
 * ships a broken workflow while excusing nothing merely costs a re-run.
 *
 * ── The second half, found while building the first ──────────────────────────
 *
 * The `run_failed` path used to return NO `outcomeCheck`. The browser caught the
 * failure through a separate structural check that read `completed` — and that
 * check was removed when the contract oracle went (2026-08-02), so an empty result
 * set would have read as **"not verified"** for a run that demonstrably broke.
 * Every run now yields a verdict. That is pinned here too, because the two changes
 * shipped together and either alone leaves the panel lying in one direction.
 *
 * ── Mutations, run by hand (2026-08-02) ──────────────────────────────────────
 *
 *   M1  `transient` hardwired false            → 1 red (a flake fails the workflow)
 *   M2  `transient` hardwired true             → 2 red (a real defect is excused)
 *   M3  the failure path returns no verdict    → 1 red (a break reads as unproved)
 *   M4  the client stops acting on the flag    → 1 red
 *   M5  the endpoint stops delegating the rule → 1 red
 *
 * M1 AND M2 SURVIVED THE FIRST PASS, and the fix was to the CODE, not the test.
 * The decision was inline in the endpoint's `run_failed` branch, so the only
 * available pins were regexes over its source — and `false && isTransientFailure(…)`
 * leaves the symbol right there in the text, so every one of them stayed green.
 * That is this repo's oldest recorded trap: a grep proves a symbol EXISTS, never
 * that anything ENFORCES it. `judgeFailedRun` was extracted so the decision can be
 * executed; the source pins that remain say in their own comment that they prove
 * wiring only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isTransientFailure } from '../../src/workflows/error-translator.js';
import { evaluateDeliveryRun, judgeFailedRun } from '../../src/workflows/delivery-verdict.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SERVER = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────

describe('what counts as "we could not run it"', () => {
  // THE MEASURED LIST. These are the messages the engine actually produces, not
  // invented ones — a rule proved against a fixture nobody emits is a rule about
  // a program nobody runs.
  const OURS = [
    'LLM call timed out after 120s',
    'extract_email: LLM step failed: LLM call timed out after 120s',
    'HTTP 429: rate limit exceeded',
    'fetch failed',
  ];
  const THEIRS = [
    'assemble sections is invalid JSON: Bad control character in string literal',
    'Failed schema validation: Intro Email Sent.options is missing',
    'no Slack user matches "charles@agntic.co"',
    'UNKNOWN_CONFIG_KEY: append_row',
  ];

  for (const msg of OURS) {
    test(`ours, so the workflow is not blamed: ${msg.slice(0, 44)}`, () => {
      assert.equal(isTransientFailure(msg), true, msg);
    });
  }

  for (const msg of THEIRS) {
    test(`the workflow's, so it must still fail: ${msg.slice(0, 44)}`, () => {
      assert.equal(isTransientFailure(msg), false,
        'excusing a real wiring defect ships a broken workflow — the narrow direction is the safe one: ' + msg);
    });
  }

  test('an unrecognised error is a REAL failure, never excused', () => {
    // The load-bearing default. A new failure mode nobody has seen must block, not
    // sail through — the same fail-closed choice the converger's half makes.
    assert.equal(isTransientFailure('something nobody has ever seen before'), false);
    assert.equal(isTransientFailure(''), false);
    assert.equal(isTransientFailure(null), false);
  });
});

describe('the server decides it, and says so on the failure response', () => {
  // Source-level, and it says so: the `run_failed` branch is inside a `for await`
  // over the engine's event stream inside an Express handler, and cannot be lifted
  // out and executed. Replace with a behavioural check if that handler is ever
  // made extractable.
  // Anchored to the branch's OWN ends, never a fixed byte window. A fixed window
  // has failed over nothing but comment growth three times in this tree
  // (CLAUDE.md records each), which fails a test for formatting and teaches
  // whoever hits it that the pin is noise.
  const branch = (() => {
    const i = SERVER.indexOf("else if (ev.type === 'run_failed')");
    assert.notEqual(i, -1, 'the run_failed branch is gone — re-point this, do not delete it');
    const end = SERVER.indexOf('return res.json(', i);
    assert.notEqual(end, -1, 'the run_failed branch no longer returns a response');
    return SERVER.slice(i, SERVER.indexOf('\n', end));
  })();

  // THESE THREE ARE WIRING ONLY, AND THAT IS ALL A SOURCE PIN CAN PROVE.
  // The DECISION is executed in the block below, against `judgeFailedRun`. It was
  // extracted for exactly this reason: with the logic inline, hardwiring the
  // answer to a constant left every assertion here green (measured 2026-08-02) —
  // a grep proves a symbol exists, never that it enforces anything.
  test('the branch delegates to the one shared rule, not a private copy', () => {
    assert.match(branch, /judgeFailedRun\(/,
      'a second copy of "was this our fault" here is how two halves drift');
  });

  test('and both answers ride on the response the panel reads', () => {
    assert.match(branch, /return res\.json\([\s\S]*?\btransient\b/,
      'the browser cannot act on a flag that never leaves the server');
    assert.match(branch, /return res\.json\([\s\S]*?\boutcomeCheck\b/,
      'without a verdict an empty result set reads as "not verified" for a run that broke');
  });
});

describe('THE DECISION, executed — whose fault was it?', () => {
  const spec = {
    version: 2, name: 'Daily summary',
    nodes: [
      { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize' } },
      { id: 'save', type: 'deliver', label: 'Save', config: { channel: 'inbox_deliver', subject: 'S' } },
    ],
    edges: [{ from: 'summ', to: 'save' }],
  };
  const judge = (error) => judgeFailedRun(spec, { id: 'e1', label: 'A normal morning' },
    { error, steps: [{ nodeId: 'summ', output: 'partial' }], nodeId: 'summ' });

  test('a model timeout is OURS — the workflow is not blamed for it', () => {
    const j = judge('extract_email: LLM step failed: LLM call timed out after 120s');
    assert.equal(j.transient, true,
      'this is the exact message that cost three paid rebuilds on prod and told a person their workflow was broken');
  });

  test('a wiring defect is THEIRS — and must still fail', () => {
    const j = judge('assemble sections is invalid JSON: Bad control character in string literal');
    assert.equal(j.transient, false,
      'excusing a real defect ships a broken workflow — the narrow direction is the safe one');
  });

  test('an unrecognised failure is treated as theirs, never excused', () => {
    assert.equal(judge('something nobody has ever seen before').transient, false);
  });

  test('either way the run is BROKEN — the flag decides blame, not the verdict', () => {
    // A transient failure is still a failure of THIS run. What changes is what the
    // caller does with it (skip and say so), never whether the run passed.
    assert.equal(judge('LLM call timed out after 120s').outcomeCheck.verdict, 'broken');
    assert.equal(judge('UNKNOWN_CONFIG_KEY: append_row').outcomeCheck.verdict, 'broken');
    assert.equal(judge('LLM call timed out after 120s').outcomeCheck.ran, false);
  });
});

describe('a failed run is scored BROKEN, not unproved', () => {
  const spec = {
    version: 2, name: 'Daily summary',
    nodes: [
      { id: 'summ', type: 'llm', label: 'Summarise', config: { mode: 'summarize' } },
      { id: 'save', type: 'deliver', label: 'Save', config: { channel: 'inbox_deliver', subject: 'S' } },
    ],
    edges: [{ from: 'summ', to: 'save' }],
  };

  test('the verdict the failure path now returns', () => {
    const v = evaluateDeliveryRun(spec, { id: 'e1' }, {
      completed: false, error: 'LLM call timed out after 120s',
      steps: [{ nodeId: 'summ', output: 'partial' }], deliveries: [],
    });
    assert.equal(v.verdict, 'broken', 'a run that did not finish is broken');
    assert.equal(v.ran, false);
  });

  test('and the panel reads that as FAILED, not as "nothing was proved"', () => {
    // Extract and EXECUTE the real certification decision, rather than restating
    // it — a restatement passes while production keeps doing the old thing.
    const start = HTML.indexOf('const vOf = function(o)');
    assert.notEqual(start, -1, 'the certification block moved — re-point this');
    const end = HTML.indexOf('const unverified =', start);
    const block = HTML.slice(start, HTML.indexOf(';', end) + 1);
    // eslint-disable-next-line no-new-func
    const certify = new Function('outcomeResults', 'r', 'd', 'issues',
      `${block}\nreturn { passed: passed, unverified: unverified };`);

    const c = certify([{ verdict: 'broken', attempted: 0, missed: [], lanes: [], laneInventory: [] }],
      { ok: true }, { completed: false }, []);
    assert.equal(c.passed, false);
    assert.equal(c.unverified, false,
      'a run that broke is a FAILURE — reporting it as "nothing was proved" is the other lie');
  });
});

describe('the client skips a transient run instead of failing the workflow', () => {
  // Source-level for the same reason: this sits inside `runTest`'s promise chain,
  // closed over the run loop's own state, and cannot be lifted.
  const i = HTML.indexOf('d.completed === false && d.transient');

  test('the transient response is turned into a skip, on the run that returned it', () => {
    assert.notEqual(i, -1,
      'the client no longer acts on the server\'s `transient` flag — a flaky minute is failing workflows again');
    const around = HTML.slice(i, i + 420);
    assert.match(around, /throw e/,
      'it must route to the SAME per-sample catch that already records a dropped connection');
  });

  test('it is decided BEFORE the verdict is folded in', () => {
    // Order matters: folding the result first and skipping afterwards would leave
    // a broken verdict in the evidence for a run nobody could carry out.
    const fold = HTML.indexOf('if (d.outcomeCheck) outcomeResults.push', i - 600);
    assert.ok(fold > i, 'the transient check must come before the result is counted as evidence');
  });

  test('a skipped sample is SAID OUT LOUD, not silently dropped', () => {
    // Two of three samples presented as the whole set is the "certifying the
    // absence of evidence" shape, one step removed.
    assert.match(HTML, /couldn't be run just now/,
      'the panel must tell the person a sample was skipped, and that it was our fault');
    assert.match(HTML, /not in your workflow/);
  });
});
