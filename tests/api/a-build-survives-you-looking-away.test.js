/**
 * A FINISHED BUILD WAS LOST BECAUSE THE USER GLANCED AT ANOTHER WORKFLOW.
 *
 * WITNESSED ON PROD, 2026-07-30 (`build-platform-1785414984862`) — Charles's own
 * build: a daily 6am AI-news briefing emailed to him.
 *
 * He started it and, while it thought, clicked two other workflows in the sidebar.
 * The server log records that plainly — two `PUT /api/builder/workflows/<id>/draft`
 * autosaves for OTHER workflow ids, at 12:38:36 and 12:38:41. Opening another
 * workflow replaces `state.threadId`, and the poll loop opens with:
 *
 *     if (self.state.threadId !== threadId) return;   // conversation moved on
 *
 * A silent return. No message, nothing on screen, no record kept. The build carried
 * on and finished 44 seconds later at 12:39:25 — a complete, correct three-step
 * workflow (web search → summarise → email), paused at its walkthrough, waiting to
 * be approved. Nobody was listening. Returning to the conversation showed the
 * reasoning and NOTHING ELSE: no steps, no graph, no note, no way to reach it. The
 * panel read "Not started". A reload made no difference.
 *
 * THE RESULT WAS NEVER GONE. Measured against prod the next day, `/status` still
 * answered `status:"ready"` with the entire spec in it. The build was unreachable
 * only because the sole copy of its identity lived in a closure that had returned.
 *
 * That is the whole defect: the build was moved onto the server so that "a closed
 * tab, a refresh, a locked phone or a deploy no longer takes the build with it" —
 * the server half held, the BROWSER half was never built. Nothing wrote down which
 * build was in flight.
 *
 * Glancing at another workflow while a build thinks for two minutes is an ordinary
 * thing to do, and it cost the entire build.
 *
 * THE FIX, AND WHY IT IS IN THREE PARTS:
 *   · the thread id is written down when the build starts (`_rememberBuild`);
 *   · the "conversation moved on" return stops POLLING but keeps the record;
 *   · reopening the conversation asks the server and draws what is waiting
 *     (`_pickUpPendingBuild`, called from `_applyBuildSlice` — the one place both a
 *     page load and an in-app reopen pass through).
 *
 * The record is cleared only once the build has been SEEN: drawn, lost, or failed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/**
 * Lift whole methods out of the page and make them callable.
 *
 * Each method is taken by MATCHING ITS BRACES from the `{` that opens its body, and
 * the results are joined with COMMAS into an object literal. Both details are
 * load-bearing and both have broken this harness before:
 *
 *   · earlier versions sliced "to the next `\n  }\n`", which silently swallowed the
 *     following method whenever the one being lifted was a ONE-LINER — as
 *     `_pendingKey` is. Matching braces handles both shapes.
 *   · class members concatenated without commas parse as neither a class nor an
 *     object literal.
 *
 * Quoted strings are skipped while counting, so a brace inside a string cannot end
 * a method early.
 */
function lift(names) {
  const parts = names.map((n) => {
    const at = HTML.indexOf('\n  ' + n + '(');
    assert.ok(at > 0, `${n} is no longer defined in public/index.html — re-point this test`);
    const open = HTML.indexOf('{', HTML.indexOf('(', at));
    let depth = 0, quote = null, i = open;
    for (; i < HTML.length; i++) {
      const c = HTML[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    assert.ok(depth === 0 && i < HTML.length, `could not find the end of ${n}`);
    return HTML.slice(at + 3, i + 1);
  });
  // eslint-disable-next-line no-eval
  return eval('({\n' + parts.join(',\n') + '\n})');
}

const METHODS = ['_pendingKey', '_rememberBuild', '_forgetBuild', '_rememberedBuild', '_pickUpPendingBuild'];

/** A component double with just enough of the page to run those methods. */
function makeApp(opts = {}) {
  const store = opts.store ?? new Map();
  const app = {
    state: { tenantId: 'platform', userEmail: 'hello@agntic.co', workflowId: opts.workflowId ?? null },
    _H: () => ({}),
    _readJson: async (r) => r,
    setState(p) { Object.assign(this.state, p); this.setStateCalls.push(p); },
    setStateCalls: [],
    drew: [],
    polled: [],
    streamed: [],
    _handleInterrupt(iv) { this.drew.push(iv); },
    _pollBuild(t) { this.polled.push(t); },
    _openReasoningStream(t) { this.streamed.push(t); },
    fetched: [],
  };
  Object.assign(app, lift(METHODS));
  // The real localStorage contract: strings in, strings or null out.
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  global.fetch = async (url) => {
    app.fetched.push(url);
    if (opts.reject) throw new Error('offline');
    return { ok: true, data: opts.status ?? { status: 'unknown' } };
  };
  app._store = store;
  return app;
}

const READY = {
  status: 'ready',
  interrupt: { type: 'generated_workflow', spec: { nodes: [{ id: 'n1' }], name: 'Daily AI briefing' } },
};

describe('the build in flight is written down', () => {
  test('remembering it survives a fresh page, because it is not in memory', () => {
    const a = makeApp({ workflowId: 'wf-1' });
    a._rememberBuild('build-platform-1785414984862');
    // A SECOND app instance — the reload — reads it back. This is the whole point:
    // the previous version kept the build's identity only in a closure.
    const b = makeApp({ store: a._store });
    assert.equal(b._rememberedBuild().threadId, 'build-platform-1785414984862');
    assert.equal(b._rememberedBuild().workflowId, 'wf-1');
  });

  test('it is scoped to the person and the workspace', () => {
    // Two accounts on one browser must never collect each other's builds.
    const a = makeApp({ workflowId: 'wf-1' });
    a._rememberBuild('build-A');
    const b = makeApp({ store: a._store });
    b.state.userEmail = 'someone-else@agntic.co';
    assert.equal(b._rememberedBuild(), null);
  });

  test('nothing is written for a build with no thread', () => {
    const a = makeApp();
    a._rememberBuild(null);
    a._rememberBuild('');
    assert.equal(a._rememberedBuild(), null);
  });

  test('a corrupt record reads as no record, not a crash', () => {
    const a = makeApp();
    a._store.set(a._pendingKey(), '{not json');
    assert.equal(a._rememberedBuild(), null);
    a._store.set(a._pendingKey(), JSON.stringify({ threadId: 42 }));
    assert.equal(a._rememberedBuild(), null, 'a non-string thread id is not a thread id');
  });

  test('storage being unavailable does not break the build', () => {
    // Private mode, a full quota, a blocked origin. The poll still works; only the
    // resume is lost, and that must not take the build down with it.
    const a = makeApp();
    global.localStorage = { getItem: () => { throw new Error('denied'); },
                            setItem: () => { throw new Error('denied'); },
                            removeItem: () => { throw new Error('denied'); } };
    assert.doesNotThrow(() => a._rememberBuild('build-x'));
    assert.doesNotThrow(() => a._forgetBuild());
    assert.equal(a._rememberedBuild(), null);
  });
});

describe('THE PROD CASE: coming back collects the finished build', () => {
  test('a build that finished unwatched is drawn', async () => {
    const a = makeApp({ workflowId: 'wf-1', status: READY });
    a._rememberBuild('build-platform-1785414984862');
    await a._pickUpPendingBuild({ workflowId: 'wf-1' });
    assert.equal(a.drew.length, 1, 'the finished build was not drawn');
    assert.equal(a.drew[0].type, 'generated_workflow');
    assert.equal(a.drew[0].spec.name, 'Daily AI briefing');
  });

  test('…and the thread is made current FIRST, or the draw is discarded', async () => {
    // `_handleInterrupt` and every answer the user then gives are guarded on
    // `state.threadId` matching. Drawing into a stale thread renders the graph and
    // then refuses the approval — worse than not drawing it.
    const a = makeApp({ workflowId: 'wf-1', status: READY });
    a._rememberBuild('build-platform-1785414984862');
    await a._pickUpPendingBuild({ workflowId: 'wf-1' });
    assert.equal(a.state.threadId, 'build-platform-1785414984862');
    const setThread = a.setStateCalls.findIndex(c => c.threadId);
    assert.ok(setThread === 0, 'the thread must be set before the interrupt is handled');
  });

  test('a build still running is re-attached, not redrawn', async () => {
    const a = makeApp({ workflowId: 'wf-1', status: { status: 'running' } });
    a._rememberBuild('b1');
    await a._pickUpPendingBuild({ workflowId: 'wf-1' });
    assert.deepEqual(a.polled, ['b1'], 'the poll was not resumed');
    assert.deepEqual(a.drew, [], 'nothing was ready to draw');
  });

  test('the reasoning stream comes back too', async () => {
    // Without it the user watches a build with no visible thinking, which reads as
    // frozen — the state this whole area exists to avoid.
    for (const status of [READY, { status: 'running' }]) {
      const a = makeApp({ workflowId: 'wf-1', status });
      a._rememberBuild('b1');
      await a._pickUpPendingBuild({ workflowId: 'wf-1' });
      assert.deepEqual(a.streamed, ['b1'], JSON.stringify(status.status));
    }
  });

  test('it asks the SERVER, and does not trust the record', async () => {
    const a = makeApp({ workflowId: 'wf-1', status: READY });
    a._rememberBuild('b1');
    await a._pickUpPendingBuild({ workflowId: 'wf-1' });
    assert.deepEqual(a.fetched, ['/api/builder/sessions/b1/status']);
  });
});

describe('it never draws someone else\'s build', () => {
  test('a record for another workflow is left alone', async () => {
    const a = makeApp({ workflowId: 'wf-OTHER', status: READY });
    a._rememberBuild('b1');                       // recorded against wf-OTHER
    await a._pickUpPendingBuild({ workflowId: 'wf-1' });
    assert.deepEqual(a.drew, [], 'one conversation\'s build was drawn into another');
    assert.deepEqual(a.fetched, [], 'it should not even ask');
  });

  test('an unknown workflow on either side draws nothing', async () => {
    // `null === null` is the trap: a first build has no workflow id yet, and treating
    // that as a match would draw it into whatever conversation was opened next.
    for (const [rec, slice] of [[null, 'wf-1'], ['wf-1', null], [null, null]]) {
      const a = makeApp({ workflowId: rec, status: READY });
      a._rememberBuild('b1');
      await a._pickUpPendingBuild({ workflowId: slice });
      assert.deepEqual(a.drew, [], `rec=${rec} slice=${slice}`);
    }
  });

  test('no record at all is a no-op', async () => {
    const a = makeApp({ workflowId: 'wf-1', status: READY });
    await a._pickUpPendingBuild({ workflowId: 'wf-1' });
    assert.deepEqual(a.fetched, []);
    assert.deepEqual(a.drew, []);
  });
});

describe('a record that can never be collected is dropped', () => {
  test('a build the server has forgotten is forgotten here too', async () => {
    // Otherwise every page load, forever, asks about a build that is gone.
    for (const status of [{ status: 'unknown' }, { status: 'error', error: 'x' }, { status: 'done' }, {}]) {
      const a = makeApp({ workflowId: 'wf-1', status });
      a._rememberBuild('b1');
      await a._pickUpPendingBuild({ workflowId: 'wf-1' });
      assert.equal(a._rememberedBuild(), null, JSON.stringify(status));
      assert.deepEqual(a.drew, [], JSON.stringify(status));
    }
  });

  test('but being OFFLINE keeps it, so a flaky moment is not a lost build', async () => {
    const a = makeApp({ workflowId: 'wf-1', reject: true });
    a._rememberBuild('b1');
    await a._pickUpPendingBuild({ workflowId: 'wf-1' });
    assert.ok(a._rememberedBuild(), 'a failed request must not discard the build');
  });
});

/**
 * The wiring. These are SOURCE-level checks and weaker than the behavioural ones
 * above, and they are here because the three call sites live inside methods that
 * cannot be lifted and executed in isolation — `_pollBuild` closes over timers,
 * `_handleInterrupt` over the renderer, `_send` over the network. This repo has
 * already been bitten by a generalisation silently reverted inside a closure
 * nothing could reach, so the alternative is no pin at all. Replace these with
 * behavioural checks if those methods are ever made extractable.
 */
describe('the three call sites are wired', () => {
  test('the build is remembered as soon as it starts', () => {
    const at = HTML.indexOf('self.setState({ threadId: r.data.threadId });');
    assert.ok(at > 0, 're-point this test');
    assert.match(HTML.slice(at, at + 260), /_rememberBuild\(r\.data\.threadId\)/);
  });

  test('"the conversation moved on" no longer discards it', () => {
    const at = HTML.indexOf('const tick = () => {');
    assert.ok(at > 0, 're-point this test');
    const body = HTML.slice(at, at + 1400);
    assert.match(body, /if \(self\.state\.threadId !== threadId\) return;/,
      'the guard itself must stay — polling a conversation nobody is on is wrong');
    assert.match(body, /deliberately LEFT IN PLACE/,
      'the reason must be written down, or the next reader "tidies" a _forgetBuild back in');
    assert.doesNotMatch(body.slice(0, body.indexOf('if (self.state.workflowId)')), /_forgetBuild/,
      'forgetting the build here is the defect');
  });

  test('the record keeps up with the workflow id the server assigns', () => {
    // A first build has no workflow id until the draft autosaves; without this the
    // pickup can never prove ownership and refuses to draw a legitimate build.
    const at = HTML.indexOf('const tick = () => {');
    assert.match(HTML.slice(at, at + 1400), /if \(self\.state\.workflowId\) self\._rememberBuild\(threadId\)/);
  });

  test('it is cleared once the build has been DRAWN', () => {
    const at = HTML.indexOf('_handleInterrupt(iv) {');
    assert.ok(at > 0, 're-point this test');
    const body = HTML.slice(at, at + 900);
    const drew = body.indexOf('_renderInterrupt(iv) === true');
    const forget = body.indexOf('_forgetBuild()');
    assert.ok(forget > drew && drew > 0,
      'clearing it before the interrupt is drawn drops the build in the exact case the record exists for');
  });

  test('…and when the user is told it is not coming', () => {
    const at = HTML.indexOf('_buildLost(message) {');
    assert.match(HTML.slice(at, at + 400), /_forgetBuild\(\)/);
  });

  test('the pickup runs from the one place both doors pass through', () => {
    const at = HTML.indexOf('_applyBuildSlice(slice, extra) {');
    assert.ok(at > 0, 're-point this test');
    const end = HTML.indexOf('\n  }\n', at);
    const body = HTML.slice(at, end);
    assert.match(body, /this\._pickUpPendingBuild\(slice\)/);
    assert.ok(body.indexOf('_pickUpPendingBuild') > body.indexOf('this.setState(Object.assign({}, slice, overrides))'),
      'the slice must be applied before the build is drawn over it');
  });

  test('and both doors really do go through it', () => {
    // If either stops calling _applyBuildSlice, that door loses the pickup silently.
    for (const caller of ['_restoreBuild(tid, email) {', 'openConsole']) {
      const at = HTML.indexOf(caller);
      assert.ok(at > 0, caller);
    }
    assert.match(HTML.slice(HTML.indexOf('_restoreBuild(tid, email) {'), HTML.indexOf('_restoreBuild(tid, email) {') + 1600),
      /this\._applyBuildSlice\(slice\)/);
  });
});
