/**
 * THREE THINGS THE SCREEN GOT WRONG AROUND GOING LIVE — all witnessed in a browser on
 * prod, 2026-08-01, driving a workflow from one sentence through to published.
 *
 * 1 · A LIVE WORKFLOW WENT ON SAYING IT WAS A DRAFT.  The workflow published — the
 *     server returned it as `status: "active"` — and the pane still read "DRAFT ·
 *     REVIEW", "Ready for your approval", "Approving turns this on", with the
 *     "Approve & go live" button still sitting there. It survived a full page reload
 *     AND reopening the workflow from the sidebar. The user has no way to tell their
 *     automation is live, and the obvious move is to press Approve a second time.
 *
 *     TWO causes, and both had to go. `modeDraft` is `phase === "draft"`, and the
 *     publish success path never cleared `phase` (only its two FAILURE paths set it),
 *     while the slice PERSISTS `phase` — so a reload restored the draft pane. And
 *     `openConsole` sends a workflow whose sidebar status is still 'draft' back into
 *     the BUILDER, while `_loadWorkflows()` was fire-and-forget — so it was the
 *     pre-publish list when we arrived, and we bounced straight back.
 *
 *     THE FIX IS NOT phase: "published". That value was deleted on 2026-07-29 for the
 *     mirror-image defect (persisted, so the live card came back on every load — "the
 *     last screen before go live keeps popping up") and its absence is guarded by
 *     `go-live-lands-on-dashboard.test.js`. Both are wrong: the build is simply OVER.
 *
 * 2 · THE TEST PANEL LOOKED HUNG.  Each example is its own sequential `/workflows/run`
 *     that can take a minute or more. The checks list read "4 SAMPLES, NOT YET RUN"
 *     with four motionless ○ for the WHOLE run — measured at 4½ minutes, by which
 *     point three of the four had already completed and returned. The progress
 *     existed; nothing showed it. A still screen is indistinguishable from a hung one,
 *     which is a failure this product has shipped once already.
 *
 * 3 · JARGON ON THE LAST SCREENS BEFORE A REAL SEND.  The line above Run test read
 *     "each destination (docs_create, firstrun@example.test) is confirmed reachable" —
 *     a capability id shown to the customer — while the step card one screen away said
 *     "a new Google Doc" for the very same node. And the card's own "Subject / title"
 *     row printed `{{generate_title.output}}` raw, two rows below a correctly-worded
 *     one, on the screen that exists so a non-technical person can catch a mistake BY
 *     READING.
 *
 * HOW THIS IS CHECKED. The renderers are EXTRACTED FROM THE PAGE AND EXECUTED, never
 * copied — a copy is what drifts, and a grep would pass against broken code. Where a
 * behaviour lives inside a render closure that cannot be lifted, the pin says so.
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
  assert.notEqual(start, -1,
    `\`${name}\` is GONE from public/index.html — re-point this extraction, do not delete the test.`);
  return HTML.slice(start + 1, bodyFrom(start));
}
/** The statements inside a method, so it can be EXECUTED rather than matched. */
const bodyOf = (src) => src.slice(src.indexOf('{') + 1, src.lastIndexOf('}'));

// ── 1 · PUBLISHING ENDS THE BUILD ─────────────────────────────────────────────
describe('a published workflow stops calling itself a draft', () => {
  const src = stripComments(methodSrc('_saveWorkflow'));

  test('the success path leaves the draft phase behind', () => {
    // The precise defect: `phase` appeared ONLY in the two failure branches, so a
    // successful publish left it at whatever it was — "draft".
    assert.match(src, /phase: "chat"/,
      'publishing must move the client out of `draft`, or `modeDraft` keeps rendering '
      + 'the "Approve & go live" pane over a workflow that is already live');
  });

  test('and does not park it in the persisted "published" phase either', () => {
    assert.doesNotMatch(src, /phase: "published"/,
      'that value was removed on 2026-07-29 — it was persisted and the live card came '
      + 'back on every load. Both "draft" and "published" are wrong here.');
  });

  test('the phase it lands in is one that does NOT survive a reload', () => {
    // This is what stops a reload restoring the draft pane, so it is a property of
    // `_persistable`, not a spelling: with the console open, the phase publishing
    // leaves behind must be non-persistable, and "draft" must remain persistable
    // (a genuine unfinished draft still has to come back).
    const persistable = new Function('s', bodyOf(stripComments(methodSrc('_persistable'))));
    assert.equal(persistable({ phase: 'chat', view: 'console' }), false,
      'the published state must not be written back to localStorage');
    assert.equal(persistable({ phase: 'draft', view: 'build' }), true,
      'a real unfinished draft must still be restorable — do not fix this by making '
      + 'everything non-persistable');
  });

  test('the console is opened only AFTER the workflow list has refreshed', () => {
    // `openConsole` routes a workflow whose status is still 'draft' back into the
    // BUILDER. Opening it against the stale pre-publish list is what bounced the
    // user straight back to the pane they had just approved.
    assert.match(src, /_loadWorkflows\(\)[\s\S]{0,220}\.then\(function\(\)\s*\{[\s\S]{0,400}openConsole\(wfId\)/,
      'openConsole must be chained off the list refresh, not fired beside it');
  });

  test('and a failed refresh still opens it rather than stranding them', () => {
    assert.match(src, /\.catch\(function\(\)\s*\{\s*\}\)/,
      'a network hiccup must not leave the user on the draft pane forever');
  });

  test('_loadWorkflows returns its promise, or nothing can wait on it', () => {
    assert.match(stripComments(methodSrc('_loadWorkflows')), /return fetch\(/);
  });
});

// Clearing the phase at publish time cannot reach a slice ALREADY on disk, and that
// slice is what a returning user meets. Confirmed against prod the moment the publish
// fix was deployed: the workflow published minutes earlier still showed the draft pane,
// because its slice predated the fix. The list refresh is where the server's authority
// on status meets the client's stale belief, so it is reconciled there.
describe('a stale draft pane is corrected against the server', () => {
  // EXECUTED, NOT MATCHED. The first version of this block asserted the source text and
  // a mutation that neutered the whole guard (`if (false && …)`) SURVIVED it — a source
  // pin cannot tell a live guard from a dead one. So `_loadWorkflows` is extracted and
  // run against a stubbed fetch, and the assertions are about what it DOES.
  function run(workflows, state) {
    const body = bodyOf(stripComments(methodSrc('_loadWorkflows')));
    const make = new Function('fetch', 'return function() {' + body + '};');
    const calls = { openConsole: [], home: 0 };
    const obj = {
      state: Object.assign({ authToken: 't', consoleSidebarWfs: [] }, state),
      setState(s) { Object.assign(obj.state, s); },
      openConsole(id) { calls.openConsole.push(id); },
      _loadHomeData() { calls.home++; },
    };
    obj._loadWorkflows = make(async () => ({ ok: true, json: async () => ({ workflows }) }));
    return obj._loadWorkflows().then(() => ({ state: obj.state, calls }));
  }

  const LIVE  = [{ id: 'w1', status: 'active' }];
  const DRAFT = [{ id: 'w1', status: 'draft' }];

  test('a draft pane over a LIVE workflow leaves for the console', async () => {
    const { calls } = await run(LIVE, { phase: 'draft', workflowId: 'w1' });
    assert.deepEqual(calls.openConsole, ['w1'],
      'a workflow that is already live must not keep offering "Approve & go live"');
  });

  test('and the phase moves too, or the stale slice is written straight back', async () => {
    const { state } = await run(LIVE, { phase: 'draft', workflowId: 'w1' });
    assert.equal(state.phase, 'chat',
      '`_persistable` treats "draft" as persistable regardless of view — leaving the '
      + 'phase alone means the next reload lands on the draft pane all over again');
  });

  test('a GENUINE unfinished draft keeps its review pane', async () => {
    const { calls, state } = await run(DRAFT, { phase: 'draft', workflowId: 'w1' });
    assert.deepEqual(calls.openConsole, [], 'this one really is a draft — leave it alone');
    assert.equal(state.phase, 'draft');
  });

  test('it leaves ONLY on positive evidence — never on a missing or blank status', async () => {
    // Absence of information must not be read as "it is live": a real draft losing its
    // review pane is the worse bug of the two.
    for (const [label, wfs] of [
      ['absent from the list', [{ id: 'other', status: 'active' }]],
      ['carrying no status',   [{ id: 'w1' }]],
      ['an empty list',        []],
    ]) {
      const { calls } = await run(wfs, { phase: 'draft', workflowId: 'w1' });
      assert.deepEqual(calls.openConsole, [], label);
    }
  });

  test('and it does not fire when there is no draft pane to correct', async () => {
    const { calls } = await run(LIVE, { phase: 'chat', workflowId: 'w1' });
    assert.deepEqual(calls.openConsole, []);
  });
});

// ── 2 · THE TEST PANEL SAYS HOW FAR THROUGH IT IS ─────────────────────────────
describe('the test panel shows progress while it runs', () => {
  const runTest = stripComments(methodSrc('runTest'));

  test('each finished example advances a counter', () => {
    assert.match(runTest, /runProgress/,
      'nothing tracked how many examples had run, so the panel could not say');
    assert.match(runTest, /\.then\(function\(\)\s*\{\s*self\.setState\(\{\s*runProgress:\s*i \+ 1\s*\}\)/,
      'the counter must advance as each example RESOLVES, not all at the end');
  });

  test('the counter starts at zero for this run', () => {
    assert.match(runTest, /runProgress:\s*0/,
      'a stale count from a previous run would show samples as done before they are');
  });

  // The rows themselves are built inside `_contractPanel`, which closes over `this.state`
  // and the row helper and cannot be lifted out — so this pin is SOURCE-level and weaker
  // than the rest of the file. Replace it with a behavioural check if that panel is ever
  // made extractable. (Same honest caveat as the console rail in trigger-caption.test.js.)
  const panel = stripComments(methodSrc('_contractPanel'));

  test('SOURCE PIN · a running sample is distinguished from one not yet started', () => {
    assert.match(panel, /const running = \(TS === "running"\)/);
    assert.match(panel, /const finished = running && i < ranSoFar/);
    assert.match(panel, /const inFlight = running && i === ranSoFar/);
  });

  test('SOURCE PIN · "not yet run" is not printed once the run has started', () => {
    assert.match(panel, /running && ex\.length[\s\S]{0,160}sample[\s\S]{0,40}run"/,
      'the header must count while running instead of claiming nothing has run');
  });

  test('SOURCE PIN · a finished sample is NOT marked as passed', () => {
    // It has RUN. Whether its promise held is scored only once the whole set is in —
    // a tick here would be the "certify before checking" shape this product exists to
    // avoid. The mark is a neutral filled dot.
    assert.match(panel, /finished \? "•" : "○"/,
      'a ✓ here would claim a verdict that has not been reached');
  });
});

// ── 3 · NO CODE NAMES ON THE SCREENS BEFORE A SEND ────────────────────────────
describe('the customer is never shown a capability id or a raw reference', () => {
  const disclosure = stripComments(methodSrc('_runTestDisclosure'));
  const stepDetail = stripComments(methodSrc('_stepDetail'));

  test('the Run test line reuses the ONE rule for naming a destination', () => {
    assert.match(disclosure, /_destinationOf\(Object\.assign\(\{\}, c, \{ channel: ch \}\)\)/,
      'a second, divergent copy of "where does this go" is how one screen said '
      + '"a new Google Doc" and the other said "docs_create" about the same node');
  });

  test('and no longer falls back to the raw channel id', () => {
    assert.doesNotMatch(disclosure, /\|\|\s*String\(ch\)/,
      'that fallback is what printed `docs_create` at the customer');
  });

  test('_destinationOf answers for the capability that leaked', () => {
    // Proves the reuse above actually resolves this case, rather than swapping one
    // silent fallback for another.
    const destinationOf = new Function('cfg', bodyOf(stripComments(methodSrc('_destinationOf'))));
    assert.equal(destinationOf({ channel: 'docs_create' }), 'a new Google Doc');
    assert.equal(destinationOf({ channel: 'inbox_deliver' }), 'your Atlas inbox');
  });

  test('the delivery card describes a {{reference}} instead of printing it', () => {
    assert.match(stepDetail, /'Subject \/ title', this\._plainPreview\(cfg\.title, nodes\)/,
      'this row printed `{{generate_title.output}}` verbatim on the approval card');
  });

  test('and so does the connector card\'s heading', () => {
    assert.match(stepDetail, /'Heading', this\._plainPreview\(cfg\.title, nodes\)/,
      'the same raw title, one branch along — fixed together so they cannot drift');
  });
});
