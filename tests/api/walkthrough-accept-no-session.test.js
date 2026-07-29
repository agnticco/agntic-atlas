/**
 * APPROVING THE LAST STEP MUST NEVER LEAVE THE PERSON WATCHING A SPINNER FOREVER.
 *
 * WITNESSED BY THE OPERATOR, prod v1.6.52, 2026-07-28. They approved every step of
 * a four-step workflow. The canvas read
 *
 *     4 / 4 APPROVED · every step approved
 *
 * and the panel beside it slid BACK to "Building…" — with the curated fact
 * rotating underneath it, so it looked alive — and Run test greyed out under
 * "Confirm every step to start testing". It never came back. Their words: "when I
 * accepted the last step it went back into chain of thought mode instead of
 * releasing the test."
 *
 * CAUSE: `_send` returns SILENTLY when `this.state.threadId` is null. Approving
 * the last step sets `thinking: true` and then calls `_send({type:'accept'})` — so
 * with no session it locks the input, shows the thinking state, and fires a
 * request that never leaves the browser. Nothing errors. Nothing retries.
 *
 * There are two doors to a null thread with the walkthrough still on screen, and
 * BOTH were reachable in the state the operator was in:
 *   · `_buildLost` — the "your work is safe" path taken when the connection drops.
 *     It nulls the thread and deliberately does NOT clear `awaitingGraphApproval`.
 *   · reopening a draft from the sidebar (three sites, all `threadId: null`).
 *
 * Confirmed against the prod event log for that build: the graph sat paused at
 * `walkthrough` for 21 minutes, and the last `/respond` was the PLAN acceptance 31
 * seconds BEFORE it — no respond was ever sent for the four step confirmations.
 *
 * WHY THIS SHAPE. `public/index.html` is one page with no module seam, so this
 * extracts the REAL `_liveApprove` source and executes it, the same harness
 * `step-approval-card.test.js` uses. A copy would drift; a grep would pass against
 * broken code.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function bodyFrom(i) {
  let j = HTML.indexOf('{', i), depth = 0;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return -1;
}

function methodSrc(name) {
  const start = HTML.indexOf('\n  ' + name + '(');
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  return HTML.slice(start + 1, bodyFrom(start));
}

/**
 * The real `_liveApprove` and `_testUnlocked`, compiled onto a stub whose timers
 * are collected rather than run. `setTimeout`/`clearTimeout` are locals here so the
 * DIRECT eval below binds the method sources to them, exactly as the page binds
 * them to the browser's.
 */
function panel(state) {
  const timers = [];
  // eslint-disable-next-line no-unused-vars -- read by the evaluated method sources
  const setTimeout = (fn, ms) => (timers.push({ fn, ms }), timers.length);
  // eslint-disable-next-line no-unused-vars -- read by the evaluated method sources
  const clearTimeout = () => {};
  const obj = eval('({\n' + methodSrc('_liveApprove') + ',\n' + methodSrc('_testUnlocked') + '\n})');
  obj.state = state;
  obj.setState = (s) => { obj.state = Object.assign({}, obj.state, s); };
  obj.sent = [];
  obj._send = (r) => obj.sent.push(r);
  /** Run the deferred acceptance — the 620ms one, not the 560ms green flash. */
  obj.flush = () => { for (const t of timers) if (t.ms === 620) t.fn(); };
  return obj;
}

const NODES = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
const SPEC  = { nodes: NODES };

function walkthrough(extra) {
  return Object.assign({
    spec: SPEC, liveNodes: NODES, liveConfirmed: 0,
    awaitingGraphApproval: true, liveExplaining: false,
    thinking: false, phase: 'building', threadId: 'build-platform-1',
  }, extra || {});
}

/** Tick every step, then let the deferred acceptance run. */
function approveAll(p) {
  for (let i = 0; i < NODES.length; i++) p._liveApprove();
  p.flush();
  return p;
}

describe('with a live session, nothing changes', () => {
  test('the last tick still sends the acceptance', () => {
    const p = approveAll(panel(walkthrough()));
    assert.deepEqual(p.sent, [{ type: 'accept' }],
      'the graph→test handoff is the whole point of the last tick');
    assert.equal(p.state.thinking, true, 'the server is working, so the thinking state is honest here');
    assert.equal(p.state.awaitingGraphApproval, false);
  });

  test('every step is counted on the way', () => {
    const p = approveAll(panel(walkthrough()));
    assert.equal(p.state.liveConfirmed, 4);
  });
});

describe('with no session, the person is not left waiting on a ghost', () => {
  // This is the operator's bug, exactly as they hit it.
  const lost = () => panel(walkthrough({ threadId: null }));

  test('it does not pretend to be working', () => {
    const p = approveAll(lost());
    assert.equal(p.state.thinking, false,
      '"Building…" over a request that never left the browser is the defect');
  });

  test('the panel stops saying "Building"', () => {
    // The literal complaint: "it went back into chain of thought mode". The panel
    // header reads the phase, so leaving it at "building" reproduces the screenshot
    // even once the spinner stops.
    const p = approveAll(lost());
    assert.equal(p.state.phase, 'proposed');
  });

  test('it does not lock the person out of the composer', () => {
    const p = approveAll(lost());
    assert.notEqual(p.state.inputMode, 'locked',
      'locked input plus a dead request is a page with nothing to click');
  });

  test('and the test panel actually unlocks', () => {
    // The payoff, in the words of the report: "instead of releasing the test".
    const p = approveAll(lost());
    assert.equal(p._testUnlocked(), true,
      'every step confirmed with nothing left to wait for means Run test is available');
  });

  test('nothing is sent, because there is nowhere to send it', () => {
    const p = approveAll(lost());
    assert.deepEqual(p.sent, [], 'a request to a null thread is discarded silently by _send');
  });
});

describe('the guards that made this invisible', () => {
  test('_send really does discard a request with no thread', () => {
    // If this ever starts erroring instead, the branch above can be reconsidered —
    // but a silent discard is what turned a lost connection into a dead page.
    const i = HTML.indexOf('\n  _send(resp) {');
    assert.ok(i > 0, '_send moved — re-point this test');
    assert.match(HTML.slice(i, i + 200), /const self = this, tid = this\.state\.threadId;\s*if \(!tid\) return;/,
      'the silent return is the mechanism this whole file exists for');
  });

  test('the connection-lost path leaves the walkthrough on screen', () => {
    // `_buildLost` nulls the thread and does NOT clear `awaitingGraphApproval` — on
    // purpose, the build is safe on disk. That combination is the reachable state.
    const i = HTML.indexOf('_buildLost(message) {');
    assert.ok(i > 0);
    const body = HTML.slice(i, bodyFrom(i));
    assert.match(body, /threadId: null/);
    assert.doesNotMatch(body, /awaitingGraphApproval/,
      'if this path ever clears the flag, say so here — the reachable state has changed');
  });
});
