/**
 * WHAT THE BUILD NOTICED ABOUT ITSELF IS NOW SAID OUT LOUD.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 *
 * `selfContradictions` has run on every finished build since the day it was
 * written, at the walkthrough node, and has only ever reached the LOG. Every
 * defect it names — a promise pointing somewhere no step goes, two halves of the
 * promise check disagreeing — was previously found by a person reading a screen
 * carefully, days later. That is exactly what it exists to replace, and it could
 * not, because nobody could see it.
 *
 * ── And a new one it could not have caught ───────────────────────────────────
 *
 * MEASURED ON PROD, 2026-08-02: a weekly digest asked Gmail for `maxResults: 100`
 * and handed every message to a single `llm` step. The search alone took ~260
 * seconds and the AI step blew its own 120s ceiling. The workflow was correct in
 * shape and could not finish — in a test or at 8am on a Monday — and nothing said
 * so until the person had done the whole interview, approved a plan, and confirmed
 * every step. It is knowable from the spec alone, and knowable BEFORE any of that.
 *
 * ── Why it is a NOTE and why notes are not shown ─────────────────────────────
 *
 * The workflow may be perfectly fine: the connector now caps its own fetch, and
 * someone asking for twenty items summarised together is asking for something
 * reasonable. Blocking would be the "a check that fires on a good build teaches
 * people to ignore it" trap this codebase has already been caught by twice. So it
 * is recorded as a note, and the walkthrough shows only errors and warnings —
 * filling the screen where someone decides whether to trust a build with advice is
 * how a real warning stops being read.
 *
 * ── Mutations, run by hand (2026-08-02) ──────────────────────────────────────
 *
 *   M1  the bulk-read check stops looking past intermediate steps → 1 red
 *   M2  it fires even when a foreach handles the items            → 1 red
 *   M3  the walkthrough stops carrying the findings               → 1 red
 *   M4  the walkthrough shows notes too                           → 1 red
 *   M5  a filter expression is not unpacked (false positive back)  → 1 red
 *   M6  the sentence check ignores trigger names (same)            → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { selfContradictions } from '../../src/workflows/self-consistency.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const GRAPH = readFileSync(path.join(ROOT, 'src/converger/elicitation-graph.js'), 'utf8');

const codes = (spec) => selfContradictions(spec).map(f => f.code);

/** THE REAL PROD SHAPE, lifted from the workflow that could not finish. */
const digest = (over = {}) => ({
  name: 'Weekly digest',
  outcome: { statement: 'A weekly digest lands in my inbox.',
             assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Weekly Email Digest' }] },
  nodes: [
    { id: 'search_emails', type: 'connector-action', label: 'Search unread email',
      config: { action: 'gmail_search', query: 'is:unread newer_than:7d', maxResults: 100 } },
    { id: 'compile_digest', type: 'llm', label: 'Compile weekly email digest', config: { mode: 'freeform', prompt: 'x' } },
    { id: 'deliver_inbox', type: 'deliver', label: 'Save to the Atlas inbox',
      config: { channel: 'inbox_deliver', subject: 'Weekly Email Digest' } },
  ],
  edges: [{ from: 'search_emails', to: 'compile_digest' }, { from: 'compile_digest', to: 'deliver_inbox' }],
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a read too big for the AI step it feeds', () => {
  test('the prod shape is noticed', () => {
    const f = selfContradictions(digest()).find(x => x.code === 'TOO_MUCH_FOR_ONE_STEP');
    assert.ok(f, 'the workflow that could not finish must be flagged from its spec alone');
    assert.equal(f.severity, 'note', 'it may be fine — telling someone is not the same as blocking them');
    assert.match(f.message, /up to 100 items/);
    assert.match(f.message, /Compile weekly email digest/, 'name the step that will struggle');
    assert.doesNotMatch(f.message, /maxResults|llm|node/, 'no code names on a sentence a customer reads');
  });

  test('it looks PAST intermediate steps to find the AI one', () => {
    // The read rarely feeds the model directly — an extract or a filter usually sits
    // between them. A check that only looked one hop would miss the common shape.
    const s = digest();
    s.nodes.splice(1, 0, { id: 'tidy', type: 'assemble', label: 'Tidy up', config: {} });
    s.edges = [{ from: 'search_emails', to: 'tidy' }, { from: 'tidy', to: 'compile_digest' },
               { from: 'compile_digest', to: 'deliver_inbox' }];
    assert.ok(codes(s).includes('TOO_MUCH_FOR_ONE_STEP'));
  });

  test('a LOOP is the right answer, so a workflow using one is left alone', () => {
    // `foreach` is exactly what this shape should be. Flagging it would be telling
    // someone off for doing the thing the finding recommends.
    // THE LOOP'S CHILD IS ALSO A TOP-LEVEL NODE, which is how specs in this repo
    // carry them — and it is the ONLY shape in which the guard is observable. A
    // fixture that only nested the step inside `config.steps` passes whether the
    // guard exists or not, because the walk never reaches it either way; that
    // version let the mutation survive (measured 2026-08-02).
    const s = digest();
    s.nodes[1] = { id: 'per_item', type: 'foreach', label: 'For each email',
                   config: { steps: [{ id: 'compile_digest', type: 'llm', label: 'Summarise one', config: {} }] } };
    s.nodes.push({ id: 'compile_digest', type: 'llm', label: 'Summarise one', config: { mode: 'summarize' } });
    s.edges = [{ from: 'search_emails', to: 'per_item' }, { from: 'per_item', to: 'compile_digest' },
               { from: 'compile_digest', to: 'deliver_inbox' }];
    assert.ok(!codes(s).includes('TOO_MUCH_FOR_ONE_STEP'), 'a loop handles the items one at a time');
  });

  test('a small read is silent', () => {
    // The anti-false-positive direction, and the common case: the capability default
    // is 10, and almost every workflow reads a handful.
    const s = digest();
    s.nodes[0].config.maxResults = 10;
    assert.ok(!codes(s).includes('TOO_MUCH_FOR_ONE_STEP'));
  });

  test('a read that never reaches an AI step is silent', () => {
    // Reading a hundred rows straight into a spreadsheet is fine — nothing has to
    // hold them all in its head.
    const s = digest();
    s.nodes.splice(1, 1);
    s.edges = [{ from: 'search_emails', to: 'deliver_inbox' }];
    assert.ok(!codes(s).includes('TOO_MUCH_FOR_ONE_STEP'));
  });

  test('a single-record read is silent', () => {
    const s = digest();
    delete s.nodes[0].config.maxResults;
    s.nodes[0].config.action = 'gmail_get_message';
    assert.ok(!codes(s).includes('TOO_MUCH_FOR_ONE_STEP'));
  });
});

describe('a name the TRIGGER uses is not a destination it got wrong', () => {
  // WITNESSED 2026-08-03 on the first Slack-triggered workflow the product could
  // build. Its trigger is stored as `filter: "channel:#atlas-test-temp"` — the
  // channel lives INSIDE a filter expression — so the exclusion added on
  // 2026-07-30 could not see it, and the check reported a correct workflow as
  // delivering nowhere. Same false positive, through a door that fix didn't cover.
  //
  // It matters more than an ordinary miss: this check is now shown to every user
  // at the walkthrough, and a check that fires on a good build teaches people to
  // ignore it.
  const slack = () => ({
    name: 'Slack summary',
    triggers: [{ type: 'event', connector: 'slack', filter: 'channel:#atlas-test-temp' }],
    outcome: {
      statement: 'Every time any message is posted in #atlas-test-temp, a one-line summary of that message is delivered to the Atlas inbox.',
      assertions: [{ id: 'a1', kind: 'message_sent', target: 'inbox:Slack message summary' }],
    },
    nodes: [
      { id: 'summarize_message', type: 'llm', label: 'One-line summary', config: { mode: 'summarize' } },
      { id: 'save', type: 'deliver', label: 'Save to the Atlas inbox', config: { channel: 'inbox_deliver', subject: 'Slack message summary' } },
    ],
    edges: [{ from: 'summarize_message', to: 'save' }],
  });

  test('the channel it LISTENS on is not reported as a destination', () => {
    assert.deepEqual(codes(slack()), [],
      'a correct Slack workflow must produce no findings at all');
  });

  test('and the real mismatch this check exists for still fires', () => {
    // The anti-regression direction, and the one that matters: the prod Sheets
    // logger whose statement named one spreadsheet while its promise named another.
    const s = {
      name: 'Pricing logger', triggers: [{ type: 'email', filter: 'is:unread' }],
      outcome: { statement: 'Each pricing enquiry is added as a row to "Pricing Emails".',
                 assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Pricing Enquiries' }] },
      nodes: [{ id: 'row', type: 'connector-action', label: 'Add row',
                config: { action: 'sheets_append', spreadsheetId: 'Pricing Enquiries', range: 'Sheet1' } }],
      edges: [],
    };
    const c = codes(s);
    assert.ok(c.includes('STATEMENT_NAMES_ELSEWHERE'), 'the statement names a sheet no step uses');
    assert.ok(c.includes('PROMISE_AND_SENTENCE_DIFFER'), 'and the two halves of the promise disagree');
  });

  test('a workflow whose statement and promise agree stays silent', () => {
    const s = {
      name: 'Pricing logger', triggers: [{ type: 'email', filter: 'is:unread' }],
      outcome: { statement: 'Each pricing enquiry is added as a row to "Pricing Enquiries".',
                 assertions: [{ id: 'a1', kind: 'record_exists', target: 'sheets:Pricing Enquiries' }] },
      nodes: [{ id: 'row', type: 'connector-action', label: 'Add row',
                config: { action: 'sheets_append', spreadsheetId: 'Pricing Enquiries', range: 'Sheet1' } }],
      edges: [],
    };
    assert.deepEqual(codes(s), []);
  });
});

describe('the findings reach the person, not just the log', () => {
  test('the walkthrough carries them on the same interrupt as the steps', () => {
    // On the SAME interrupt, so they cannot arrive on a screen already left.
    const i = GRAPH.indexOf("type: 'generated_workflow'");
    assert.notEqual(i, -1, 'the walkthrough interrupt moved — re-point this');
    const payload = GRAPH.slice(i, GRAPH.indexOf('step: state.step', i));
    assert.match(payload, /\bselfCheck,/, 'the build must hand its own findings to the client');
    assert.match(GRAPH, /selfCheck = contradictions\.map\(/,
      'and they must be the real findings, not a re-derived summary');
  });

  test('the client keeps them, defaulting to none', () => {
    // Additive: a build from a server that does not send this behaves exactly as
    // before, rather than rendering `undefined`.
    assert.match(HTML, /selfCheck: Array\.isArray\(iv\.selfCheck\) \? iv\.selfCheck : \[\]/);
  });

  test('and shows them BEFORE the step-by-step confirmation', () => {
    const i = HTML.indexOf('const flagged = (this.state.selfCheck');
    assert.notEqual(i, -1, 'the walkthrough no longer surfaces the findings');
    const after = HTML.slice(i, i + 900);
    assert.match(after, /_confirmNote/, 'it must sit with the confirm prompt, not somewhere else');
    assert.match(after, /\.\.\.noticed, \{ isNote: true, _confirmNote/,
      'the notice comes FIRST — after the confirm prompt is after the person has started');
  });

  test('NOTES are not shown — only what a person should act on', () => {
    // A screen where someone decides whether to trust a build cannot be filled with
    // advice; that is how a real warning stops being read.
    const i = HTML.indexOf('const flagged = (this.state.selfCheck');
    assert.match(HTML.slice(i, i + 200), /f\.severity !== 'note'/,
      'errors and warnings surface; the rest stays in the log');
  });
});
