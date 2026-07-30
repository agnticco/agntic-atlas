/**
 * THE BUILD PAGE MUST NEVER GO SILENTLY DEAD ON A REPLY IT CANNOT DRAW.
 *
 * QA run 2026-07-26, the run's most serious finding. A tester typed an answer into
 * the chat box instead of clicking one of the offered buttons. The answer was
 * accepted, the build moved on — and then the page stopped checking for updates
 * entirely: zero network requests over 20 seconds, no spinner, no error message,
 * nothing to click. Reloading and reopening the workflow restored the same dead
 * state.
 *
 * THE INVARIANT PINNED HERE. After the build page handles a reply from the server
 * it must be in exactly one of three states: still polling, showing the user
 * something they can act on, or showing an error. Never a fourth.
 *
 * Why the fourth state existed: `_pollBuild` does NOT re-arm its timer when the
 * server answers `ready` — it hands the whole future of the page to
 * `_handleInterrupt`. Any branch of that handler which returned without drawing
 * anything left no timer, no request in flight, nothing to click and no error. The
 * duplicate-resume no-op (`{type:'noop'}`) and a null interrupt both did exactly
 * that. And neither of `_pollBuild`'s own safety limits could ever fire, because
 * both live inside the closure of a timer that no longer exists.
 *
 * WHY THIS SHAPE. The rules live in a ~9,700-line browser file with no module
 * boundary, so there is nothing to import — a grep would pass against the broken
 * code. These EXECUTE the real method sources (`_handleInterrupt`,
 * `_renderInterrupt`, `_retireClarifyChips`) on a stub, with time and timers
 * injected so the twenty-second budget is exercised for real rather than waited
 * out. Fail-loud: a rename fails the test rather than quietly proving nothing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HTML = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/index.html'), 'utf8');

/** Slice one named method's source out of the client file. Fail-loud. */
function source(name) {
  const start = HTML.indexOf(`  ${name}(`);
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  let i = HTML.indexOf('{', start), depth = 0, end = -1;
  for (; i < HTML.length; i++) {
    if (HTML[i] === '{') depth++;
    else if (HTML[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, `could not find the end of \`${name}\``);
  return HTML.slice(start, end);
}

/**
 * Compile the named real methods onto one object, with `setTimeout` /
 * `clearTimeout` / `Date` shadowed by the injected fakes — so the retry delay and
 * the give-up budget are asserted on real arithmetic, not on wall-clock waits.
 */
function compile(names, fakes) {
  //! nosemgrep: eval-and-function-constructor
  const build = new Function('setTimeout', 'clearTimeout', 'Date',
    `return ({\n${names.map(source).join(',\n')}\n});`);
  return build(fakes.setTimeout, fakes.clearTimeout, fakes.Date);
}

/** A stub build page carrying the REAL handler pair. */
function page(state = {}) {
  const log = { pollBuild: [], buildLost: [], apiError: [], saved: [], sent: [], forgot: [] };
  let clock = 1_000_000;
  let nextId = 1;
  const timers = [];

  const o = compile(['_handleInterrupt', '_renderInterrupt', '_retireClarifyChips'], {
    setTimeout: (fn, ms) => { const t = { id: nextId++, fn, ms, live: true }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers.find(x => x.id === id); if (t) t.live = false; },
    Date: { now: () => clock },
  });

  o.state = {
    threadId: 'T1', msgs: [], spec: null, phase: 'building',
    inputMode: 'locked', thinking: true, ...state,
  };
  o.setState = (s) => Object.assign(o.state, typeof s === 'function' ? s(o.state) : s);

  o._pollBuild = (tid) => log.pollBuild.push(tid);
  o._buildLost = (m) => { log.buildLost.push(m); o.state.threadId = null; o.state.inputMode = 'change'; };
  o._apiError = (m) => { log.apiError.push(m); o.state.thinking = false; };
  o._saveWorkflow = (spec) => log.saved.push(spec);
  o._send = (r) => log.sent.push(r);
  o._closeReasoningStream = () => {};
  // The in-flight build record (2026-07-30). `_handleInterrupt` clears it once the
  // reply has been DRAWN and `_buildLost` clears it when it gives up, so the double
  // needs it to run at all. Logged rather than ignored: "was the build forgotten
  // here?" is a question about the same accountability this file is testing.
  o._forgetBuild = () => log.forgot.push(true);
  o._rememberBuild = () => {};
  o._liveNodesFromSpec = () => [];
  o._animateReveal = () => {};
  o.reset = () => {};

  return {
    o, log, timers,
    advance: (ms) => { clock += ms; },
    /** Fire every timer that is still live, as the browser would. */
    fireTimers: () => {
      for (const t of timers.filter(x => x.live)) { t.live = false; t.fn(); }
    },
    pending: () => timers.filter(t => t.live),
  };
}

// ── THE PIN ────────────────────────────────────────────────────────────────────

describe('a reply the page cannot draw leaves it polling, never dead', () => {
  // The exact shape the server returns for a duplicate/racing answer
  // (`src/api/builder.js` → "return { type: 'noop', reason: 'already_handled' }"),
  // which then reaches the client verbatim through GET …/status as
  // `{ status:'ready', interrupt:{type:'noop'} }`.
  const NOOP = { type: 'noop', reason: 'already_handled' };

  test('the duplicate-answer no-op schedules another check instead of freezing', () => {
    const p = page();
    p.o._handleInterrupt(NOOP);

    assert.equal(p.pending().length, 1,
      'nothing was scheduled — the page has no timer, no request and nothing to click: the freeze');
    p.fireTimers();
    assert.deepEqual(p.log.pollBuild, ['T1'], 'the resumed check must ask about the SAME build');
    assert.deepEqual(p.log.buildLost, [], 'one undrawable reply is not yet a reason to give up');
    assert.deepEqual(p.log.saved, [], 'a reply we could not draw must NEVER look like the step succeeded');
  });

  test('a `ready` with no interrupt at all does the same', () => {
    // GET …/status answers `{ status:'ready', interrupt: job.value ?? null }`, so a
    // null interrupt is a shape the client is genuinely handed.
    const p = page();
    p.o._handleInterrupt(null);
    assert.equal(p.pending().length, 1, 'a null reply used to return silently and end the page');
    p.fireTimers();
    assert.deepEqual(p.log.pollBuild, ['T1']);
  });

  test('the retry is SCHEDULED, not immediate — no request storm', () => {
    // `_pollBuild()` fires its first request synchronously, so re-entering it
    // directly would loop at network speed rather than at the poll interval.
    const p = page();
    p.o._handleInterrupt(NOOP);
    assert.deepEqual(p.log.pollBuild, [], 'the retry must not fire inside this call');
    assert.ok(p.pending()[0].ms >= 1000,
      `retry delay was ${p.pending()[0].ms}ms — that is a hot loop, not a poll`);
  });

  test('the spinner is left up while it goes back to asking', () => {
    const p = page({ thinking: true });
    p.o._handleInterrupt(NOOP);
    assert.equal(p.o.state.thinking, true,
      'stopping the spinner while still waiting tells the user nothing is happening when something is');
  });
});

// ── BOUNDED: IT GIVES UP OUT LOUD, AND SOON ───────────────────────────────────

describe('a reply it can never draw ends in a message, not in silence', () => {
  const NOOP = { type: 'noop' };

  test('a server stuck on an undrawable reply is surfaced within ~20 seconds', () => {
    const p = page();
    let polls = 0;
    for (let i = 0; i < 200; i++) {
      p.o._handleInterrupt(NOOP);
      if (!p.pending().length) break;
      polls++;
      p.advance(1500);
      p.fireTimers();
    }
    assert.equal(p.log.buildLost.length, 1,
      'it must stop and SAY so — a silent 1.5s loop forever is the original bug wearing a timer');
    assert.ok(polls <= 20,
      `it kept re-asking ${polls} times; the user must be told in seconds, not after the 30-minute build limit`);
    assert.match(p.log.buildLost[0], /saved/i,
      'the give-up message must tell the user their work survived');
    assert.deepEqual(p.log.saved, [],
      'giving up must never publish or save — a stuck build is not a finished one');
  });

  test('giving up leaves the user somewhere they can act from', () => {
    const p = page();
    for (let i = 0; i < 200 && p.log.buildLost.length === 0; i++) {
      p.o._handleInterrupt(NOOP);
      p.advance(1500);
      p.fireTimers();
    }
    assert.equal(p.o.state.inputMode, 'change', 'the composer must be usable again');
  });

  test('one drawable reply clears the clock, so a later hiccup gets its full budget', () => {
    const p = page();
    p.o._handleInterrupt(NOOP);                 // starts the stuck-clock
    p.advance(60_000);                          // a long, healthy build passes
    p.o._handleInterrupt({ type: 'clarification', question: 'Which inbox?' });
    p.advance(60_000);
    p.o._handleInterrupt(NOOP);                 // a fresh hiccup, an hour of clock later
    assert.deepEqual(p.log.buildLost, [],
      'a stale stuck-clock would abandon the build on the FIRST hiccup of the next exchange');
    assert.equal(p.pending().length, 1);
  });

  test('with the build session already gone it says so rather than polling a dead thread', () => {
    const p = page({ threadId: null });
    p.o._handleInterrupt(NOOP);
    assert.equal(p.pending().length, 0, 'polling a thread we no longer have can only 404 forever');
    assert.equal(p.log.buildLost.length, 1);
  });
});

// ── ANTI-FALSE-POSITIVE: A REPLY IT *CAN* DRAW MUST STILL JUST DRAW ───────────

describe('replies the page can draw are unaffected', () => {
  test('a question opens the composer and does NOT resume polling', () => {
    const p = page();
    p.o._handleInterrupt({ type: 'clarification', question: 'Which inbox should I watch?' });
    assert.equal(p.o.state.inputMode, 'clarify', 'the user must be able to answer');
    assert.ok(p.o.state.msgs.some(m => /Which inbox/.test(m.text || '')), 'the question must be on screen');
    assert.equal(p.pending().length, 0,
      're-polling a drawn question would re-render it under the user and lose what they had typed');
  });

  test('the finished walkthrough hands over to the editor and does NOT resume polling', () => {
    const p = page();
    p.o._handleInterrupt({ type: 'ratify', spec: { nodes: [{ id: 'a' }] }, publishable: true });
    assert.equal(p.o.state.phase, 'proposed');
    assert.equal(p.o.state.inputMode, 'change');
    assert.equal(p.pending().length, 0);
  });

  test('a finished build still saves', () => {
    const p = page();
    const spec = { nodes: [{ id: 'a' }] };
    p.o._handleInterrupt({ type: 'done', spec });
    assert.deepEqual(p.log.saved, [spec]);
    assert.equal(p.pending().length, 0);
  });
});

// ── A STEP CARD MUST NEVER BE APPENDED INTO THIN AIR ─────────────────────────

describe('a step card whose signal line has left the transcript', () => {
  // The signal line is found by id (`_slId`). When that id names a message that is
  // no longer in the transcript, the update is a silent no-op: the step is dropped,
  // and the page is left with no timer, no error and nothing to click — the same
  // fourth state by a different route. The live example is "Create #<channel>" for
  // a missing destination (`resourceSetup` in elicitation-graph.js), which is a
  // real `{type:'proposal', proposal:{component:'setup_action'}}` in production.
  const SETUP = { type: 'proposal', proposal: { component: 'setup_action', capabilityId: 'slack_create_channel', params: { name: 'requests' }, rationale: 'Create #requests.' } };

  function withHumanStep(p) { p.o._humanStep = () => ({ title: 'Create #requests', desc: 'so the workflow has a destination' }); return p; }

  test('the step is still drawn — a fresh signal line is mounted', () => {
    const p = withHumanStep(page({ msgs: [{ isAtlas: true, text: 'earlier chat' }] }));
    p.o._slId = 'sl_that_is_gone';                 // points at a message not in msgs
    p.o._handleInterrupt(SETUP);

    const line = p.o.state.msgs.find(m => m.isSignalLine);
    assert.ok(line, 'the step was appended into thin air and the page had nothing to click');
    assert.equal(line.steps.length, 1);
    assert.equal(typeof line.steps[0].onConfirm, 'function', 'the user must have a button that does something');
    assert.equal(p.pending().length, 0, 'it WAS drawn, so it must not also resume polling');
  });

  test('an intact signal line is still appended to, not replaced', () => {
    const p = withHumanStep(page({ msgs: [{ isSignalLine: true, _id: 'sl1', steps: [{ id: 'sl_s1', isConfirmed: true }] }] }));
    p.o._slId = 'sl1';
    p.o._handleInterrupt(SETUP);
    const lines = p.o.state.msgs.filter(m => m.isSignalLine);
    assert.equal(lines.length, 1, 'a healthy transcript must not sprout a second signal line');
    assert.equal(lines[0].steps.length, 2, 'the new step joins the existing walkthrough');
  });
});

// ── AN UNKNOWN SHAPE IS AN ERROR, AND MUST NOT STRAND THEM ────────────────────

describe('a genuinely unknown reply shape', () => {
  test('with nothing built, it is a plain error — not a freeze, not a poll loop', () => {
    const p = page({ spec: null });
    p.o._handleInterrupt({ type: 'martian_handshake' });
    assert.equal(p.log.apiError.length, 1, 'an unknown shape must SAY something');
    assert.match(p.log.apiError[0], /martian_handshake/, 'name the shape so it is diagnosable');
    assert.equal(p.pending().length, 0, 'an error is a permitted end state; do not also loop');
    assert.deepEqual(p.log.buildLost, []);
  });

  test('with a workflow already built, it leaves them able to keep working on it', () => {
    // "Start over with + New workflow" is the destructive advice, and it was the
    // ONLY advice here even when the built workflow was safely on disk.
    const p = page({ spec: { nodes: [{ id: 'a' }, { id: 'b' }] } });
    p.o._handleInterrupt({ type: 'martian_handshake' });
    assert.equal(p.log.buildLost.length, 1, 'a saved workflow must not be met with "start over"');
    assert.match(p.log.buildLost[0], /saved/i);
    assert.equal(p.o.state.inputMode, 'change', 'they must be able to type a change');
    assert.deepEqual(p.log.saved, [], 'and it must not be mistaken for a completed build');
  });
});
