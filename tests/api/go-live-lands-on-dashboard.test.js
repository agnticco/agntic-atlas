/**
 * GOING LIVE LANDS ON THE DASHBOARD — AND STAYS THERE.
 *
 * Operator, 2026-07-29: "The last screen before go live keeps popping up. The
 * dashboard should be the default screen after selecting go live."
 *
 * TWO SEPARATE THINGS PUT THEM THERE, and the second is the one that made it
 * "keep" happening:
 *
 *  1. Publishing parked on a "Workflow is live" card for 1.8s before moving on.
 *
 *  2. `phase: "published"` was pure CLIENT state, and it was PERSISTED. So the
 *     card came back on EVERY app load, for as long as that slice survived — you
 *     published once and then clicked "View live dashboard" past it every session
 *     afterwards. (Confirmed in this session: every reload of prod landed there.)
 *
 * It also had to be re-checked against the server on restore, because nothing else
 * could tell it the workflow had since been PAUSED — it would sit there with a
 * pulsing green dot claiming a paused workflow was running. Sending people to the
 * dashboard settles that too: it reads its status from the server, so there is no
 * stale claim to correct and no second place that reports whether a workflow runs.
 *
 * The card is deleted, not merely bypassed. An unreachable screen is how a fixed
 * behaviour comes back — this repo already carries one dead approval mechanism as
 * a recorded residual, and one is enough.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function code(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

describe('publishing goes straight to the dashboard', () => {
  const src = (() => {
    const i = HTML.indexOf('approveDraft() {');
    assert.ok(i > 0, '`approveDraft` is gone — re-point this test');
    // ANCHORED TO THE METHODS, NOT TO A BYTE COUNT. This used to slice a fixed 3000
    // characters, so it went red the moment `_saveWorkflow` grew a comment — failing
    // over FORMATTING rather than behaviour. (2026-08-01: exactly that happened, and
    // it is the third fixed window in this tree to do it.) `approveDraft` only
    // delegates; the publish logic is all in `_saveWorkflow`, so span both and stop
    // where that method does. Every assertion below is unchanged.
    const end = HTML.indexOf('// ── panels', i);
    assert.ok(end > i, "the marker closing `_saveWorkflow` moved — re-point this test");
    return code(HTML.slice(i, end));
  })();

  test('it opens the console for the workflow it just published', () => {
    assert.match(src, /self\.openConsole\(wfId\)/);
  });

  test('with no timed detour through a card on the way', () => {
    assert.doesNotMatch(src, /setTimeout\(function\(\) \{ self\.openConsole/,
      'the 1.8s "Workflow is live" pause is the detour that was removed');
  });

  test('and it no longer parks the client in a "published" phase', () => {
    assert.doesNotMatch(src, /phase: "published"/,
      'that phase is what got persisted and came back on every load');
  });
});

describe('reopening Atlas does not put the card back', () => {
  const src = (() => {
    const i = HTML.indexOf('_restoreBuild(tid, email) {');
    assert.ok(i > 0, '`_restoreBuild` is gone — re-point this test');
    return code(HTML.slice(i, i + 1800));
  })();

  test('a restored published slice opens its dashboard instead', () => {
    assert.match(src, /slice\.phase === 'published' && slice\.workflowId.*openConsole\(slice\.workflowId\)/s);
  });

  test('and returns, so the build view is not also restored underneath it', () => {
    // Falling through to `_applyBuildSlice` would mount the build view behind the
    // console and leave two screens fighting over the same state.
    const i = src.indexOf("slice.phase === 'published'");
    assert.match(src.slice(i, i + 200), /return; \}/);
  });

  test('the stale-status re-check is gone with the screen that needed it', () => {
    assert.ok(!HTML.includes('_verifyStillLive'),
      'it existed only to correct a screen that claimed "running" from client state');
  });
});

describe('the card itself is deleted, not left dormant', () => {
  test('no template block and no view-model key', () => {
    assert.ok(!HTML.includes('modeLive'), 'an unreachable screen is how this comes back');
  });

  test('the phrases that were only on that card are gone', () => {
    // Comments are stripped: the entries below quote the wording they removed, and
    // an assertion a comment can turn red is worse than no assertion.
    const src = code(HTML);
    for (const gone of ['Workflow is live', 'Pipeline · live', 'View live dashboard',
                        'Running automatically']) {
      assert.ok(!src.includes(gone), `"${gone}" still renders somewhere`);
    }
  });

  test('and nothing is left branching on a phase that cannot happen', () => {
    // Six expressions read `phase === "published"`. With that phase unreachable they
    // were constant-false branches — not dead code exactly, but a reader would take
    // them as live behaviour. Collapsed to the branch that actually ran.
    assert.ok(!/published \?/.test(code(HTML)));
    assert.ok(!/const published = S\.phase/.test(HTML));
  });

  test('the review card BEFORE go live is untouched', () => {
    // `draftNodes` fed both screens. Deleting one must not take the other with it —
    // that card is where a person approves the workflow in the first place.
    assert.ok(HTML.includes('{{ draftNodes }}'), 'the go-live review card must survive');
    assert.match(HTML, /Approve &amp; go live|Approve & go live/,
      'the approve control is the whole point of the screen before go live');
  });
});
