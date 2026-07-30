/**
 * ONLY THE NEWEST QUESTION IS ANSWERABLE; A PAUSED BUILD COMES BACK EXPLAINED.
 *
 * QA Manager findings 7 and 8 (shakedown 2026-07-22).
 *
 * F7: a clarification pushes live answer chips, and prior rounds' chips were never
 * retired — so after the build asked the same thing three times (finding 2, itself
 * now fixed), three "Use your suggestions" buttons sat live at once. A stale one
 * posts an answer to a question the session has already moved past.
 *
 * F8: on a page reload during a gap review the converger session is gone and the
 * answer chips are stripped by persistence, so the user returned to a question with
 * no button and nothing telling them the shortcut had gone or that they could just
 * type the answer.
 *
 * WHY THIS SHAPE. The rules live in a 9000-line browser file with no module boundary,
 * so there is nothing to import — a grep would pass against the broken code. These
 * EXECUTE the real method sources on a stub. Fail-loud: a rename fails the test
 * rather than quietly proving nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HTML = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

/** Extract a named method body and compile it onto a stub component. Fail-loud. */
function method(name) {
  const start = HTML.indexOf(`  ${name}(`);
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  let i = HTML.indexOf('{', start), depth = 0, end = -1;
  for (; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, `could not find the end of \`${name}\``);
  const obj = eval('({ ' + HTML.slice(start, end) + ' })');
  obj.setState = (s) => { obj._captured = Object.assign(obj._captured || {}, s); };
  return obj;
}

describe('retiring stale clarification chips (F7)', () => {
  const c = method('_retireClarifyChips');

  test('a clarification message loses its chips, keeping everything else', () => {
    const msgs = [
      { isAtlas: true, text: 'Question 1?' },
      { isClarify: true, chips: [{ label: 'A' }, { label: 'B' }], chipsLive: true },
    ];
    const out = c._retireClarifyChips(msgs);
    assert.deepEqual(out[1].chips, [], 'a stale chip posts an answer to a question already moved past');
    assert.equal(out[1].chipsLive, false, 'the control is retired on purpose, not lost');
    assert.equal(out[0].text, 'Question 1?', 'non-clarify messages are untouched');
  });

  test('EVERY earlier clarification is retired, not just the last', () => {
    const msgs = [
      { isClarify: true, chips: [{ label: 'A' }] },
      { isAtlas: true, text: 'and another' },
      { isClarify: true, chips: [{ label: 'B' }] },
    ];
    const out = c._retireClarifyChips(msgs);
    const live = out.filter(m => m.isClarify && m.chips.length);
    assert.equal(live.length, 0, 'three live "Use your suggestions" buttons at once is exactly the bug');
  });

  test('it does not mutate the input', () => {
    const msgs = [{ isClarify: true, chips: [{ label: 'A' }] }];
    c._retireClarifyChips(msgs);
    assert.equal(msgs[0].chips.length, 1, 'returning a new array is what makes it safe to feed straight to setState');
  });

  test('a message with no chips is passed through untouched (identity)', () => {
    const m = { isClarify: true, chips: [] };
    assert.equal(c._retireClarifyChips([m])[0], m);
  });
});

describe('a build paused on a question comes back explained (F8)', () => {
  function comp() {
    const o = method('_applyBuildSlice');
    o._retireClarifyChips = method('_retireClarifyChips')._retireClarifyChips;
    o._liveNodesFromSpec = () => [];
    // Collecting a build that finished off screen (2026-07-30). `_applyBuildSlice` is
    // the one place both doors into a conversation pass through, so it calls this on
    // the way out; a double without it cannot run the method at all.
    o._pickUpPendingBuild = () => {};
    return o;
  }

  test('a slice awaiting a clarification gains a guidance note, and the composer opens', () => {
    const o = comp();
    o._applyBuildSlice({
      phase: 'building', inputMode: 'clarify',
      msgs: [{ isAtlas: true, text: 'Which sections?' }, { isClarify: true, chips: [] }],
    });
    const msgs = o._captured.msgs;
    const note = msgs[msgs.length - 1];
    assert.match(note.text, /paused on the questions|tell me in the box/i,
      'a returning user must be told the shortcut is gone and that typing still works');
    assert.notEqual(o._captured.inputMode, 'locked', 'they must be able to type the answer');
  });

  test('a finished build the caller already resolved gets NO such note', () => {
    // callerSetPhase (phase:'proposed') owns the phase — adding a "paused on a
    // question" note there would be a lie about a build that is done.
    const o = comp();
    o._applyBuildSlice(
      { phase: 'building', inputMode: 'clarify', spec: { nodes: [{ id: 'a' }] },
        msgs: [{ isClarify: true, chips: [] }] },
      { phase: 'proposed' });
    const msgs = o._captured.msgs || [];
    assert.ok(!msgs.some(m => /paused on the questions/i.test(m.text || '')),
      'a resolved, finished build must not be told it is waiting on an answer');
  });

  test('a normal build (not awaiting an answer) gets no note', () => {
    const o = comp();
    o._applyBuildSlice({ phase: 'building', inputMode: 'chat',
      msgs: [{ isAtlas: true, text: 'hi' }] });
    const msgs = o._captured.msgs || [];
    assert.ok(!msgs.some(m => /paused on the questions/i.test(m.text || '')));
  });
});
