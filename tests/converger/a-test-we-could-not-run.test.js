/**
 * A TEST WE COULD NOT RUN HAS NOT SHOWN THE WORKFLOW TO BE WRONG.
 *
 * WITNESSED ON PROD, `build-zz-firstrun-test-1785616455964`, watched live by Charles.
 * A correct Gmail→Sheets logger spent **881 seconds and THREE paid Opus passes**. Two of
 * them were `verify_failed` rebuilds, ordered by the same sentence both times:
 *
 *     extract_email: LLM step failed: LLM call timed out after 120s
 *
 * The self-test ran 385s, then 373s more. **No rebuild can make a model answer faster**,
 * so both passes were unwinnable before they started, and the workflow that came out was
 * the same workflow in substance as the first draft.
 *
 * THE ARGUMENT WAS ALREADY IN THE FILE, ONE DOOR ALONG. The verify node draws exactly
 * this distinction for CONTENT flakes, and its comment says why: *"Rebuilding the whole
 * spec to 'fix' it is futile — the new spec has the same guard and flakes the same way."*
 * That is word-for-word true of a timeout. The code did not cover it: `isContentFlake`
 * requires `!o.error`, so ANY run error counted as a structural wiring defect, including
 * one that says nothing whatsoever about the spec.
 *
 * Same family as this repo's oldest rule — **"not exercised" is a verdict distinct from
 * pass and from fail** — arriving through a door that rule did not cover.
 *
 * AND THE SECOND HALF: the SDK's four retries were UNREACHABLE. `requestTimeoutMs`
 * defaulted to 120000, the same number as the `llm` node's whole-call ceiling, so the
 * first slow request consumed the node's entire budget and no retry could ever fire —
 * while the comment beside it said the per-request timeout existed *"so the SDK's own
 * retry can fire"*. Two limits that must differ, set to the same value.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { isTransientFailure, translateError } from '../../src/workflows/error-translator.js';
import { ChatModel } from '../../src/llm/chat-model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('THE PROD SENTENCE, verbatim', () => {
  test('the timeout that bought two rebuilds is not a workflow defect', () => {
    assert.equal(isTransientFailure('extract_email: LLM step failed: LLM call timed out after 120s'), true);
  });

  test('and it is still translated for the user exactly as before', () => {
    // The classification must READ the existing table, not replace it — a second regex
    // list here is the one-rule-in-two-places defect this repo pays for most.
    assert.equal(translateError('LLM call timed out after 120s').code, 'LLM_TIMEOUT');
  });
});

describe('what else we could not run', () => {
  test('a rate limit and an unreachable network are the provider, not the spec', () => {
    for (const e of [
      'HTTP 429 Too Many Requests',
      'fetch failed',
      'connect ECONNREFUSED 1.2.3.4:443',
      'ETIMEDOUT',
    ]) assert.equal(isTransientFailure(e), true, e);
  });
});

describe('IT IS NARROW ON PURPOSE — the dangerous direction', () => {
  /**
   * Excusing a genuine wiring defect SHIPS A BROKEN WORKFLOW. Excusing nothing costs a
   * rebuild. The first is much worse, so anything unrecognised stays a real failure.
   */
  test('a bad API key is a fact about this deployment and does not go away on a retry', () => {
    assert.equal(isTransientFailure('LLM step failed: HTTP 401 invalid api key'), false);
  });

  test('a step that produced unusable output is REAL — that is the workflow', () => {
    for (const e of [
      'extract returned invalid JSON',
      'assemble sections is invalid JSON: Bad control character in string literal',
      'no channel handler registered for slack',
      'Node "append" has no destination',
      'something nobody has ever seen before',
    ]) assert.equal(isTransientFailure(e), false, e);
  });

  test('nothing at all is not an excuse', () => {
    for (const e of ['', null, undefined, {}]) assert.equal(isTransientFailure(e), false, JSON.stringify(e));
  });

  test('an Error object is read the same way as a string', () => {
    assert.equal(isTransientFailure(new Error('LLM call timed out after 120s')), true);
    assert.equal(isTransientFailure(new Error('invalid api key')), false);
  });
});

describe('THE CAUSE IS GONE, NOT JUST THE SYMPTOM — verify no longer runs anything', () => {
  /**
   * This file was written on 2026-08-01, in the morning, about a build that spent 881
   * seconds and THREE paid Opus passes inside the converger's self-test — two of them
   * `verify_failed` rebuilds ordered by an LLM timeout, which no rebuild can fix.
   *
   * Two describes used to live here and are deliberately gone, because what they pinned
   * cannot happen any more:
   *
   *   · "a run we could not complete is excluded from the rebuild decision" — pinning
   *     `isUnrunnable` / `isContentFlake`, which sorted a failed sample into "rebuild"
   *     or "excuse". There is no rebuild decision now: `verify` has no fix route.
   *   · "THE SILENCE — a build that says nothing reads as a dead one" — pinning the
   *     per-sample narration around each wait. There is no wait to narrate.
   *
   * That afternoon Charles cut the whole thing: *"The verify in the converger should
   * simply be a pass that verifies there is a logically built workflow, not that it
   * keeps its promise. That is what the test is for."* Excusing a timeout was the right
   * fix for a node that should not have been executing the workflow at all.
   *
   * What replaces those pins is one guard: the execution must not come BACK. That is
   * stronger than either of them — an excuse-the-timeout rule is only needed by code
   * that runs the workflow, so if this stays true neither rule can be missed again. The
   * behavioural contract is `tests/converger/verify-loop.test.js`, which drives the real
   * graph and asserts the dry-runner goes uncalled; this is the cheap source-level
   * backstop beside it.
   */
  const SRC = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

  test('the verify node does not execute the draft', () => {
    assert.doesNotMatch(SRC, /await runDryRun\(/,
      'verify is executing the workflow again — that is the TEST\'s job, and doing it '
      + 'here makes every build pay for the run twice');
  });

  test('and has no route that buys a rebuild from a failed run', () => {
    assert.doesNotMatch(SRC, /route:\s*'verify_failed'/,
      'the largest source of futile paid rebuilds in this file\'s history');
    assert.doesNotMatch(SRC, /MAX_VERIFY_ROUNDS/,
      'a bound on a loop that no longer exists is a loop waiting to be restored');
  });

  test('the transient-failure rule it needed is no longer wired to anything here', () => {
    // `isTransientFailure` survives in error-translator.js (it still powers the
    // user-facing error message); it is simply no longer imported by the graph, because
    // nothing in the graph classifies run failures any more.
    assert.doesNotMatch(SRC, /import \{ isTransientFailure \}/);
  });
});

describe('THE SDK RETRIES ARE REACHABLE AGAIN', () => {
  test('the per-request timeout is strictly under the node ceiling', () => {
    // `node-types/llm.js` races the whole invoke against 120s. Equal ceilings meant the
    // first slow request ate the entire budget and maxRetries could never fire once.
    const NODE_BUDGET_MS = 120_000;
    const m = new ChatModel({ provider: 'anthropic', apiKey: 'test', model: 'claude-sonnet-5' });
    assert.ok(m.requestTimeoutMs < NODE_BUDGET_MS,
      `per-request ${m.requestTimeoutMs}ms is not under the node's ${NODE_BUDGET_MS}ms — retries are unreachable`);
    assert.ok(m.requestTimeoutMs * 2 <= NODE_BUDGET_MS,
      'there is not room for a second attempt inside the budget, so the retry still cannot fire');
  });

  test('the node ceiling this is derived from is the one actually shipped', () => {
    // A number agreed with a source file it never reads is how these two drifted apart.
    const LLM = readFileSync(path.join(ROOT, 'src/workflows/node-types/llm.js'), 'utf8');
    assert.match(LLM, /cfg\.timeoutMs \?\? 120_000/,
      'the llm node budget moved — re-derive the per-request timeout with it');
  });

  test('and the retry count is still set to survive a provider incident', () => {
    assert.ok(new ChatModel({ provider: 'anthropic', apiKey: 'test', model: 'claude-sonnet-5' }).maxRetries >= 2);
  });
});
