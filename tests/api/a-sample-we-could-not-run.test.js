/**
 * ONE FLAKY SAMPLE MUST NOT DESTROY THE EVIDENCE OF THE OTHERS.
 *
 * WITNESSED ON PROD 2026-08-02, driving a web-research build. Each example is its own
 * sequential POST and a web-search workflow holds each connection for ~60s. Of three
 * samples, the browser's own resource timings recorded:
 *
 *     run 1   56.8s   3597 bytes   ✓  (200 at the origin)
 *     run 2   61.1s   3516 bytes   ✓  (200 at the origin)
 *     run 3   20.6s      0 bytes   ✗  never reached the server at all
 *
 * A dropped connection — not a workflow defect. One rejection anywhere in the chain
 * jumped straight to the outer `.catch`, which set `testState:"failed"`, DISCARDED both
 * completed verdicts, and PATCHed the workflow to `error`. The panel read:
 *
 *     Contract not met. We ran 0 real examples … 0 of 0 promises fell short
 *     One step failed — review the break below.        (…and no break was rendered)
 *
 * A contract failure declared over ZERO checks, pointing at a break that does not exist,
 * and a workflow marked broken because of someone's network. This product refuses to
 * CERTIFY without evidence; it must equally refuse to CONDEMN without evidence.
 *
 * THE SCORING WAS ALREADY RIGHT. `_applyTestResult` returns `unverified` when nothing is
 * kept and nothing is broken ("nothing broke, but nothing is proved"). It was simply
 * never reached, because the catch bypassed it. So this is about which code path runs,
 * which is why the tests EXECUTE the real methods rather than matching their source.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');

function bodyFrom(start) {
  let depth = 0;
  for (let j = HTML.indexOf('{', start); j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}
function methodSrc(name) {
  const start = HTML.indexOf('\n  ' + name + '(');
  assert.notEqual(start, -1, `\`${name}\` is GONE — re-point this extraction, do not delete the test.`);
  return HTML.slice(start + 1, bodyFrom(start));
}
const bodyOf = (src) => src.slice(src.indexOf('{') + 1, src.lastIndexOf('}'));

// ── the REAL verdict logic, executed ─────────────────────────────────────────
// `_applyTestResult` is a plain method over its arguments and `this.state`, so it can be
// lifted and run. That is the half that decides passed / unverified / failed.
function scoreWith(outcomeResults, spec) {
  const fn = new Function('r', 'd', bodyOf(stripComments(methodSrc('_applyTestResult'))));
  const captured = {};
  const ctx = {
    state: { spec, workflowId: 'w1', testState: 'running' },
    setState: (s) => Object.assign(captured, typeof s === 'function' ? s(ctx.state) : s),
    _H: () => ({}),
    _loadWorkflows: () => {},
    _testInterval: null,
    _testStartMs: Date.now(),
    _postRunSummary: () => {},
    _pipeline: () => [],
  };
  const d = { completed: true, paused: false, steps: [], deliveries: [], output: 'x',
              outcomeResults, error: null };
  try { fn.call(ctx, { ok: true, data: d }, d); } catch (e) { captured._threw = String(e); }
  return captured;
}

const SPEC_WITH_PROMISE = {
  outcome: { statement: 'x', assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Digest' }] },
  nodes: [], edges: [],
};
const KEPT   = { verdict: 'kept',   contractPassed: true,  lanes: [] };
const BROKEN = { verdict: 'broken', contractPassed: false, lanes: [] };

describe('zero evidence is NOT a contract failure', () => {
  test('nothing run at all reads as unverified, never failed', () => {
    const s = scoreWith([], SPEC_WITH_PROMISE);
    assert.equal(s.testState, 'unverified',
      'a contract cannot "fall short" over zero checks — that is condemning without evidence');
  });

  test('and it does not mark the workflow broken', () => {
    const s = scoreWith([], SPEC_WITH_PROMISE);
    assert.notEqual(s.testState, 'failed',
      'a workflow must not be marked error because our own run could not complete');
  });

  test('a genuinely BROKEN sample still fails — the excuse is not a blanket', () => {
    const s = scoreWith([BROKEN], SPEC_WITH_PROMISE);
    assert.equal(s.testState, 'failed',
      'real evidence of a broken promise must still fail, or this becomes a fail-open');
  });

  test('and the samples that DID run still certify', () => {
    const s = scoreWith([KEPT, KEPT], SPEC_WITH_PROMISE);
    assert.equal(s.testState, 'passed',
      'evidence from completed samples must survive — discarding it was the defect');
  });
});

// ── the loop that feeds it ───────────────────────────────────────────────────
describe('the run loop survives a sample it cannot run', () => {
  const src = stripComments(methodSrc('runTest'));

  test('each sample has its own catch, so one rejection cannot end the run', () => {
    assert.match(src, /driveExample\(runSpec\);?\s*\}\)\s*\.catch\(function\(e\)\s*\{[\s\S]{0,220}unrunnable\.push/,
      'a per-sample failure must be recorded and skipped, not thrown to the outer catch');
  });

  test('the set is still SCORED after a failure, not abandoned', () => {
    // `_applyTestResult` is what returns "unverified" for an empty set. The defect was
    // never reaching it.
    assert.match(src, /_applyTestResult/,
      'the accumulated evidence must always reach the scorer');
  });

  test('the outer catch no longer claims the workflow is broken', () => {
    const outer = src.slice(src.lastIndexOf('.catch(function(e)'));
    assert.doesNotMatch(outer, /testState:\s*"failed"/,
      'reaching the outer catch means OUR harness broke, not the customer’s workflow');
    assert.doesNotMatch(outer, /status:\s*'error'/,
      'and it must not PATCH the workflow to error on the strength of our own fault');
  });

  test('a skipped sample is SAID OUT LOUD, not silently absent', () => {
    // Two of three, presented as if it were the whole set, is the "certifying the
    // absence of evidence" shape one step removed.
    const panel = stripComments(methodSrc('_contractPanel'));
    assert.match(panel, /runUnrunnable/,
      'the panel must tell the person a sample was skipped');
    assert.match(panel, /not in your workflow/i,
      'and must say it was our fault, not theirs');
  });
});
