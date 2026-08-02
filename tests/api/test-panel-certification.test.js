/**
 * THE CONTROL THAT GATES "GO LIVE" — pinning the client's certification rule.
 *
 * `reviewDraft()` is the only way into the publish surface and it is gated on
 * `this.state.testState !== "passed"` (public/index.html). So the expression that
 * computes `passed` in `_applyTestResult` IS the Go-live gate, and F12/F16 were
 * that expression saying "passed" over zero evidence.
 *
 * WHY THIS SUITE EXISTS AND WHY IT LOOKS LIKE THIS.
 *
 * The rule lives in a 7000-line browser file with no module boundary, so there is
 * nothing to import — and that is exactly why it went unpinned through two live
 * defects. A grep for the identifiers would satisfy the letter of a check while
 * proving nothing about its POWER (CLAUDE.md, architectural flaw #1: the gate
 * measured the EXISTENCE of tests, not their power).
 *
 * So this EXTRACTS the real source of the decision — verbatim, from `const
 * hasContract` through `const unverified = …;` — and evaluates it against crafted
 * inputs. The extraction is fail-loud: if the block is renamed, moved or deleted,
 * the test FAILS rather than silently passing over nothing. That is deliberate; a
 * self-skipping check on a Go-live gate is how a suite reports a cheerful pass on
 * the thing under test.
 *
 * If this ever becomes importable, delete the extraction and import it. Until then
 * this is the only thing standing between a regression here and a green suite.
 */

import { test, describe } from 'node:test';
import assert   from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HTML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html');

/**
 * Pull the certification block out of `_applyTestResult` and compile it into a
 * function of the state it reads. Throws loudly if the shape it depends on is gone.
 */
function certifier() {
  const src = readFileSync(HTML, 'utf8');
  // RE-POINTED 2026-08-02. The block used to open with `const hasContract` — it
  // read the spec's assertions to decide whether a promise had to be exercised.
  // It no longer reads the contract at all (src/workflows/delivery-verdict.js);
  // it opens at `const vOf`, the per-run verdict reader, which is the first line
  // of the certification decision.
  const start = src.indexOf('const vOf = function(o)');
  assert.notEqual(start, -1,
    'the Go-live certification block is GONE from public/index.html — `const vOf` not found. ' +
    'If it moved, re-point this extraction; do not delete the test.');
  const endMarker = 'const unverified =';
  const endIdx = src.indexOf(endMarker, start);
  assert.notEqual(endIdx, -1, '`const unverified` not found after `const vOf` — the block changed shape.');
  const block = src.slice(start, src.indexOf(';', endIdx) + 1);

  // The block must still reference each input, or it is judging something else.
  // `spec` deliberately LEFT OUT: the decision no longer reads the workflow's
  // promises, only what its runs did. Putting it back would re-pin the rule that
  // was removed.
  for (const ident of ['outcomeResults', 'anyBroken', 'anyAttempt', 'lanesMissing']) {
    assert.ok(block.includes(ident), `the certification block no longer reads \`${ident}\``);
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('spec', 'outcomeResults', 'r', 'd', 'issues',
    `${block}\nreturn { passed: passed, unverified: unverified };`);
  return (state) => fn(
    state.spec ?? null,
    state.outcomeResults ?? [],
    state.r ?? { ok: true },
    state.d ?? { completed: true },
    state.issues ?? [],
  );
}

const CERTIFY = certifier();

/** A spec that PROMISES something — the v2 shape the panel must certify on. */
const withContract = () => ({ outcome: { assertions: [{ id: 'a1', kind: 'message_sent', target: 'slack:#ops' }] } });
/** A v1 spec that promises nothing — the structural fallback still applies. */
const noContract   = () => ({ nodes: [] });

// RE-POINTED 2026-08-02. A result no longer carries a per-promise contract; it
// carries what the run DID. `attempted` is how many deliveries it made, and it is
// the anti-vacuity floor — see src/workflows/delivery-verdict.js.
const kept          = { verdict: 'kept',   attempted: 1 };
const brokenResult  = { verdict: 'broken', attempted: 1 };
// THE SHAPE THAT USED TO BE `not_exercised`: a run that completed cleanly and
// delivered nothing. It is no longer a failure and no longer a third verdict — but
// on its own it still cannot certify, because nothing was sent anywhere.
const quiet         = { verdict: 'kept',   attempted: 0 };

describe('the Go-live gate certifies on the VERDICT, not on a vacuous truth', () => {
  test('a contract with NO results is unverified — Go live stays locked (F12)', () => {
    // The live shape: an ordinary edit cleared `outcome.examples` to 0, so the
    // panel ran zero examples and rendered "every promise held".
    const c = CERTIFY({ spec: withContract(), outcomeResults: [] });
    assert.equal(c.passed, false, 'zero examples cannot certify anything');
    assert.equal(c.unverified, true, 'and it must be reported as unverified, not as a failure');
  });

  test('a contract whose only result is NOT EXERCISED is unverified (F16)', () => {
    // The 3-lane router whose one sample took the do-nothing lane. Note
    // `contractPassed: true` on the result — the old boolean read this as a pass.
    const c = CERTIFY({ spec: withContract(), outcomeResults: [quiet] });
    assert.equal(c.passed, false);
    assert.equal(c.unverified, true);
  });

  test('unverified is NOT a failure — it is its own state', () => {
    // Marking it failed would be the opposite lie, and would flip a live
    // workflow's status on a test that broke nothing.
    const c = CERTIFY({ spec: withContract(), outcomeResults: [quiet] });
    assert.equal(c.passed, false);
    assert.equal(c.unverified, true);
  });

  test('POSITIVE: one KEPT example and nothing broken certifies — Go live unlocks', () => {
    // Without this the rule could be "never certify anything", which is a green
    // suite and an unpublishable product.
    const c = CERTIFY({ spec: withContract(), outcomeResults: [kept] });
    assert.equal(c.passed, true);
    assert.equal(c.unverified, false);
  });

  test('POSITIVE: kept + not_exercised together still certifies', () => {
    // A multi-lane workflow whose samples cover one lane. Something WAS proved
    // and nothing broke, so this is a real pass.
    const c = CERTIFY({ spec: withContract(), outcomeResults: [kept, quiet] });
    assert.equal(c.passed, true);
  });

  test('one BROKEN example blocks Go live even alongside a kept one', () => {
    const c = CERTIFY({ spec: withContract(), outcomeResults: [kept, brokenResult] });
    assert.equal(c.passed, false);
    assert.equal(c.unverified, false, 'this is a real failure, not an absence of evidence');
  });

  test('a result from an OLDER server (no `verdict`) falls back to contractPassed', () => {
    // A deploy where the client is newer than the API must not read `undefined`
    // as "not broken" and certify a failure.
    const legacyPass = { contractPassed: true };
    const legacyFail = { contractPassed: false };
    assert.equal(CERTIFY({ spec: withContract(), outcomeResults: [legacyPass] }).passed, true);
    assert.equal(CERTIFY({ spec: withContract(), outcomeResults: [legacyFail] }).passed, false);
  });
});

// ── THE STRUCTURAL FALLBACK IS GONE (2026-08-02) ────────────────────────────
//
// This block used to pin a two-track rule: a spec carrying promises had to prove
// one, and a v1 spec carrying none could publish on "the run completed cleanly".
// `hasContract` chose the track, and THE ANTI-LAUNDER test below existed because
// forcing that flag to `false` sent a v2 spec down the lenient track.
//
// There is one track now, and it is stricter than either: **zero results never
// certify, whatever the spec says.** Every run produces a result, so an empty set
// means the runs could not be carried out — which is the one thing it must never
// read as a pass. The three v1-fallback tests are therefore gone; what they
// protected is covered by the first test in this file, for every spec at once.
//
// The two tests below are the ones that outlived the rule, and both still matter.
describe('zero evidence never certifies, and the door is gated on the pass', () => {
  test('GO LIVE is reachable ONLY from testState "passed" — "unverified" must not unlock it', () => {
    // `passed:false` above is only meaningful if the state it produces actually
    // locks the door. This reads the door itself. If someone widens `reviewDraft`
    // to `!== "failed"`, every test above still passes and Go live opens on an
    // unverified workflow — the F12 defect restored one method to the right.
    const src = readFileSync(HTML, 'utf8');
    const m = /reviewDraft\(\)\s*\{([^}]*)\}/.exec(src);
    assert.ok(m, 'reviewDraft() not found in public/index.html — re-point this check, do not delete it.');
    assert.match(m[1], /testState\s*!==\s*"passed"/,
      'Go live must be gated on testState === "passed" and nothing looser');
    assert.doesNotMatch(m[1], /unverified/,
      'the unverified state must never be treated as a pass by the publish gate');
  });

  test('THE ANTI-LAUNDER: the fallback must not rescue a spec that DOES promise', () => {
    // RE-POINTED 2026-08-02. The mutation this used to kill was `hasContract =
    // false`, which sent a promising spec down the lenient track. That flag is
    // gone; the mutation it now kills is restoring the `: structural` fallback on
    // the `passed` expression, which would let a clean HTTP round-trip with no
    // runs in it certify a workflow. Same defect (F12), same door, one rule fewer.
    const c = CERTIFY({
      spec: withContract(), outcomeResults: [],
      r: { ok: true }, d: { completed: true }, issues: [],   // a perfectly clean run
    });
    assert.equal(c.passed, false,
      'a clean request is not a run that delivered — an empty result set can never certify');
  });
});
