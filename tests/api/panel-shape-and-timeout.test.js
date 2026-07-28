/**
 * Two screens must not disagree with each other, or with the oracle.
 *
 * The client is one HTML file with no module seam, so these are source
 * assertions — the same technique `lane-examples.test.js` uses. They pin the
 * INVARIANT and name the defect, so a future edit that reintroduces it is caught
 * with an explanation rather than a diff.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');

describe('the test panel counts every path, not just the first branch\'s', () => {
  // MEASURED on a real 12-node, 2-branch workflow (2026-07-28): the panel said
  // "3 steps · 3 paths" while the oracle certified against 5 lanes. The panel
  // stopped at the first split, so it structurally could not see an approval gate
  // downstream of a classifier — and the oracle's number is the one that decides
  // whether Go live unlocks. A person was reading a different workflow from the one
  // being checked.
  test('paths are summed across every branch', () => {
    assert.match(src, /allPaths/, 'the panel must total lanes across all branches');
    assert.match(
      src.slice(src.indexOf('allPaths') - 200, src.indexOf('allPaths') + 400),
      /n\.type !== 'branch'/,
      'the total must be built from branch nodes, mirroring laneInventoryOf',
    );
  });

  test('it still counts DISTINCT targets, so converging cases are one lane', () => {
    const i = src.indexOf('const allPaths');
    assert.match(src.slice(i, i + 300), /_splitTargetsOf/,
      'several cases routing to one node is ONE lane, not several');
  });
});

describe('a timeout the system resolves is not an unrouted answer', () => {
  // The approval card says "after 48h, it counts as reject". The next screen used
  // to warn in red that timeout had "no path of its own". Both described the same
  // configured behaviour and only one could be true.
  //
  // The sweeper settles it: `decision = (then && allowed.has(then)) ? then :
  // TIMEOUT_DECISION` (workflow-scheduler.js). When `then` names another allowed
  // answer the branch wires, the branch never sees `timeout` at all.
  test('the warning is suppressed when the timeout resolves to a wired decision', () => {
    assert.match(src, /timeoutResolved/, 'the client must recognise a resolved timeout');
    const i = src.indexOf('var timeoutThen');
    assert.ok(i > 0, 'the timeout-then lookup must exist');
    const around = src.slice(i, i + 700);
    assert.match(around, /src\.type === 'human'/, 'only a human step declares a timeout');
    assert.match(around, /config\.timeout/, 'it must read the declared timeout');
  });

  test('it is narrow — suppressed only when `then` is actually wired', () => {
    const i = src.indexOf('var timeoutResolved');
    const around = src.slice(i, i + 300);
    assert.match(around, /wired\[timeoutThen\]/,
      'an unwired or absent `then` still leaves timeout reaching the catch-all, so the warning must stay');
  });

  test('the red no-path warning still exists for genuinely unrouted answers', () => {
    assert.match(src, /no path of its own/,
      'suppressing the false case must not remove the check this screen exists for');
  });
});
