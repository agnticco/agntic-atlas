/**
 * A workflow whose every step the person has confirmed must be testable — even
 * if the flag that says so was lost in transit.
 *
 * WITNESSED 2026-07-28 (local, after a server restart mid-session — which is what
 * every deploy does to anyone building at the time). The canvas read
 *
 *     7 / 7 APPROVED · every step approved
 *
 * while the panel beside it read "Building · 3 steps · 2 paths" with Run test
 * greyed out under "Confirm every step to start testing". It survived a full page
 * reload. Every step confirmed, nothing testable, Go live unreachable, and no
 * error shown anywhere — the product telling someone to do the thing they had
 * just finished doing.
 *
 * CAUSE: `awaitingGraphApproval` and `phase` are both cleared by a server
 * round-trip at the end of the approval walkthrough. If that round-trip never
 * lands, they stay stranded at their mid-build values, and the gate read only
 * those flags. The observable fact — every step confirmed — outranks them.
 *
 * The client is one HTML file with no module seam, so these are source
 * assertions, the same technique `lane-examples.test.js` uses.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
const fn  = (() => {
  const i = src.indexOf('_testUnlocked() {');
  assert.ok(i > 0, 'the shared gate must exist');
  return src.slice(i, i + 600);
})();

describe('the test gate is one derivation, not two copies', () => {
  // The expression lived inline in BOTH the contract panel and the footer. Two
  // copies of a rule that must agree is how they come to disagree — the same
  // duplication that let the build-time and runtime delivery checks drift apart.
  test('it is defined once', () => {
    assert.equal((src.match(/_testUnlocked\(\)\s*\{/g) || []).length, 1);
  });

  test('and all three readers call it rather than re-deriving it', () => {
    // THERE WERE THREE COPIES, NOT TWO. The contract panel, the footer, and
    // `runTest` itself. Unifying only the first two produced the worst version of
    // the bug: the button ENABLED and pressing it did nothing — no request, no
    // error, no feedback. A disabled button at least explains itself.
    assert.equal((src.match(/this\._testUnlocked\(\)/g) || []).length, 3,
      'the panel, the footer AND the run handler must read the same gate');
  });

  test('the run handler cannot disagree with the button', () => {
    const i = src.indexOf('runTest() {');
    assert.ok(i > 0);
    const body = src.slice(i, i + 900);
    assert.match(body, /!this\._testUnlocked\(\)/, 'runTest must gate on the shared derivation');
    assert.doesNotMatch(body, /S\.phase !== "proposed"/,
      'a private copy of the rule here is what made a live button do nothing');
  });
});

describe('a confirmed walkthrough cannot be stranded by a lost flag', () => {
  test('the happy path still unlocks on the flags alone', () => {
    assert.match(fn, /!S\.awaitingGraphApproval && S\.phase === "proposed"/,
      'a normal finished build must unlock exactly as before');
  });

  test('every step confirmed also unlocks it', () => {
    assert.match(fn, /liveConfirmed/, 'the gate must consider what the person actually confirmed');
    assert.match(fn, /done >= total/, 'all steps confirmed is the observable fact that outranks the flag');
  });

  test('a spec is still required — nothing unlocks on an empty draft', () => {
    assert.match(fn, /if \(!S\.spec\) return false;/);
  });
});

describe('it does not unlock mid-build', () => {
  // While steps stream in, confirmed-equals-revealed is a transient coincidence:
  // two revealed and two ticked is not a finished walkthrough. Once the stream
  // stops, the two are equal only when the last step really has been ticked.
  test('a build still streaming cannot satisfy the fallback', () => {
    assert.match(fn, /!S\.thinking/,
      'confirmed-equals-revealed must not count while steps are still arriving');
  });

  test('zero steps never counts as "all steps confirmed"', () => {
    assert.match(fn, /total > 0/,
      'an empty node list would otherwise make 0 >= 0 unlock a workflow with no steps');
  });
});
