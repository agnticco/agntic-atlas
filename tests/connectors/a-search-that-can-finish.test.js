/**
 * A GMAIL SEARCH THAT CAN ACTUALLY FINISH.
 *
 * ── What was measured (prod, 2026-08-02) ─────────────────────────────────────
 *
 * A weekly-digest workflow — search unread mail from the past 7 days, summarise it,
 * deliver it — could not complete a test run, three attempts in a row, each failing
 * at ~381 seconds with:
 *
 *     compile_digest: LLM step failed: LLM call timed out after 120s
 *
 * Its stored config asked for `maxResults: 100`. The engine's own log said
 * `failedStep: 1` — the search had COMPLETED and the AI step was what threw. The AI
 * node races a single 120s timer with no retry (node-types/llm.js), so the search
 * itself accounted for ~260 of those seconds: about 2.6s per message, which is
 * exactly what 100 sequential round trips costs.
 *
 * TWO SEPARATE FAULTS, and fixing either alone leaves the workflow broken:
 *
 *  1. `gmailSearch` fetched each message body one after another. Four minutes
 *     before the workflow's real work even started.
 *  2. Nothing bounded the fan-in. A hundred full email bodies then went into ONE
 *     model call, which cannot read them inside its ceiling however fast they
 *     arrived.
 *
 * This would have failed identically at 8am on a Monday. It is not a
 * test-environment artefact, and the test refusing to certify it was correct.
 *
 * ── Mutations, run by hand (2026-08-02) ──────────────────────────────────────
 *
 *   M1  fetch sequentially again                  → 2 red
 *   M2  drop the ceiling (honour maxResults: 100) → 2 red
 *   M3  cap silently, with no `truncated` notice  → 1 red
 *   M4  batches concatenated out of order         → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { gmailSearch, GMAIL_SEARCH_MAX } from '../../src/connectors/google/index.js';

/**
 * A stand-in for the authenticated Google caller that RECORDS CONCURRENCY.
 *
 * Every body fetch holds for a tick, so a sequential implementation peaks at 1 in
 * flight and a batched one peaks at its batch size. That is the difference this
 * file exists to hold, and it cannot be seen by counting calls.
 */
function fakeGapi(total, { delayMs = 5 } = {}) {
  const ids = Array.from({ length: total }, (_, i) => ({ id: `m${i}` }));
  let inFlight = 0, peak = 0;
  const fetched = [];
  const gapi = async (method, path, opts) => {
    if (path.endsWith('/messages')) {
      const want = opts?.params?.maxResults ?? 10;
      return { messages: ids.slice(0, want) };
    }
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, delayMs));
    inFlight--;
    const id = path.split('/').pop();
    fetched.push(id);
    return { id, payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }], body: { data: '' } } };
  };
  return { gapi, stats: () => ({ peak, fetched }) };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('message bodies are fetched in parallel, not one at a time', () => {
  test('several are in flight at once', async () => {
    const { gapi, stats } = fakeGapi(24);
    await gmailSearch(gapi, { query: 'is:unread', maxResults: 24 });
    const { peak } = stats();
    assert.ok(peak > 1,
      `every body fetch is its own round trip — doing them one after another is what made a search take four minutes (peak in flight: ${peak})`);
  });

  test('but not all at once — a large result set must not open a socket per message', async () => {
    // Unbounded parallelism turns a slow search into a rate-limited failing one.
    const { gapi, stats } = fakeGapi(50);
    await gmailSearch(gapi, { query: 'is:unread', maxResults: 50 });
    const { peak } = stats();
    assert.ok(peak <= 16, `the fetch must be batched, not unbounded (peak: ${peak})`);
  });

  test('and the order Gmail returned them in is preserved', async () => {
    // Gmail returns newest-first and a digest reads in that order. A parallel fetch
    // that shuffled the results would silently change every workflow reading them.
    const { gapi } = fakeGapi(20);
    const r = await gmailSearch(gapi, { query: 'is:unread', maxResults: 20 });
    const subjects = r.messages.map(m => m.subject);
    assert.deepEqual(subjects, Array.from({ length: 20 }, (_, i) => `Subject m${i}`),
      'batches must be concatenated in sequence, and each batch keep its own order');
  });
});

describe('a search is bounded, and says so', () => {
  test('it reads at most the ceiling, however many were asked for', async () => {
    const { gapi } = fakeGapi(200);
    const r = await gmailSearch(gapi, { query: 'is:unread newer_than:7d', maxResults: 100 });
    assert.equal(r.messages.length, GMAIL_SEARCH_MAX,
      'a hundred email bodies cannot be read by one model call however fast they arrive');
  });

  test('and it NEVER caps silently', async () => {
    // Quietly returning 50 of 100 reads as "that is all there was". Saying what was
    // dropped is the rule this codebase already applies to sample trimming.
    const { gapi } = fakeGapi(200);
    const r = await gmailSearch(gapi, { query: 'is:unread', maxResults: 100 });
    assert.equal(r.truncated, true);
    assert.equal(r.requested, 100);
    assert.equal(r.limit, GMAIL_SEARCH_MAX);
    assert.match(String(r.note), /at most 50/,
      'the caller must be able to tell a reader there was more');
  });

  test('an ordinary request is untouched — no notice, no cap', async () => {
    // The anti-false-positive direction, and the common case: the capability's own
    // default is 10, and nothing about a normal search may change.
    const { gapi } = fakeGapi(200);
    const r = await gmailSearch(gapi, { query: 'from:ups.com', maxResults: 10 });
    assert.equal(r.messages.length, 10);
    assert.equal(r.truncated, undefined, 'a request inside the ceiling was not truncated');
    assert.equal(r.note, undefined);
  });

  test('the default is still 10 when nothing is asked for', async () => {
    const { gapi } = fakeGapi(200);
    const r = await gmailSearch(gapi, { query: 'is:unread' });
    assert.equal(r.messages.length, 10);
  });

  test('fewer results than asked for is not a truncation', async () => {
    const { gapi } = fakeGapi(3);
    const r = await gmailSearch(gapi, { query: 'is:unread', maxResults: 20 });
    assert.equal(r.messages.length, 3);
    assert.equal(r.truncated, undefined);
  });
});

describe('the ceiling is declared where the builder reads it', () => {
  test('the capability says so in its own description and hint', async () => {
    // A prompt is a belief about model behaviour and is pinned by nothing — the
    // clamp above is the mechanism. This is what stops the converger ASKING for a
    // hundred in the first place, so the two agree instead of one silently
    // overruling the other.
    const { registerGoogleChannels } = await import('../../src/connectors/google/index.js');
    const caps = [];
    registerGoogleChannels({ register: (c) => caps.push(c) }, {});
    const search = caps.find(c => c.id === 'gmail_search');
    assert.ok(search, 'gmail_search must still be registered');
    assert.match(String(search.description), new RegExp(`at most ${GMAIL_SEARCH_MAX}`),
      'the converger reads the description — it must state the limit');
    const maxField = (search.configSchema ?? []).find(f => f.key === 'maxResults');
    assert.match(String(maxField?.hint), new RegExp(String(GMAIL_SEARCH_MAX)));
  });
});
