/**
 * A TEST RUN NO LONGER HOLDS A SOCKET OPEN FOR MINUTES.
 *
 * ── What was measured (prod, 2026-08-02, four workflows driven in a browser) ──
 *
 * A Monday-digest workflow failed with
 *
 *     compile_digest: LLM step failed: LLM call timed out after 120s
 *     ms: 381832                                    ← 6.4 minutes
 *
 * and the browser never saw it. Cloudflare gives up on an origin request at ~100
 * seconds and returns its own 524, so the panel got an error page instead of the
 * run's answer, said "we couldn't run this — try again", and the retry did exactly
 * the same thing.
 *
 * TWO FIXES FROM EARLIER THE SAME DAY WERE PROVED DEAD BY THIS:
 *  · the client's 4-minute ceiling could never fire — the proxy cut in at ~100s;
 *  · the `transient` flag ("our fault, not your workflow") could never arrive —
 *    it rides on a response, and the response was the thing being lost.
 *
 * A fix that depends on a response is worth nothing when the response is lost. So
 * the run stops being one long request: `background: true` returns a job id at
 * once and the answer is polled. Every request is now short, which is what puts it
 * inside any proxy's limit.
 *
 * ── The property that matters most ───────────────────────────────────────────
 *
 * THERE IS ONE IMPLEMENTATION. `runWorkflowHandler` is unchanged and is shared;
 * backgrounding swaps the socket for a recorder (`captureRes`). A second code path
 * for "the slow case" is how two halves of this system have drifted nine times, so
 * there isn't one — and the test below proves the two routes return the same body.
 *
 * ── Mutations, run by hand (2026-08-02) ──────────────────────────────────────
 *
 *   M1  a forgotten job answers `running` instead of `unknown` → 1 red (spinner returns)
 *   M2  the poll drops its tenant/user scoping                 → 1 red
 *   M3  the background route stops recording a thrown error    → 1 red (job stuck)
 *   M4  the client stops sending `background: true`            → 1 red
 *   M5  the client retries a breached ceiling                  → 1 red, in
 *       `a-sample-we-could-not-run.test.js`, and only AFTER that assertion was
 *       scoped to the gate EXPRESSION. It first matched the phrase anywhere in
 *       `runTest` — where it also appears in the `throw` that RAISES it — so
 *       deleting it from the guard left the suite green. A source pin must be
 *       anchored to the gate, never to the words around it.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SERVER = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────

describe('the engine is entered through ONE handler, whichever route is used', () => {
  test('the handler is named and shared, not duplicated for the slow case', () => {
    assert.match(SERVER, /const runWorkflowHandler = async \(req, res\) => \{/,
      'the run handler must be extracted so both routes can share it');
    // Exactly two call sites: the foreground return, and the awaited background one.
    const calls = SERVER.match(/runWorkflowHandler\(req,/g) || [];
    assert.equal(calls.length, 2,
      'a third caller means a third path that can drift: ' + calls.length);
  });

  test('foreground is still the default — backgrounding is opt-in', () => {
    assert.match(SERVER, /if \(req\.body\?\.background !== true\) return runWorkflowHandler\(req, res\);/,
      'every existing caller (the scheduler, a script, an older page) must be unaffected');
  });

  test('the recorder captures what the handler would have SENT, not a summary of it', () => {
    // The handler calls res.json() from eight places. Capturing means none of them
    // had to change — and none of them can be forgotten.
    assert.match(SERVER, /const captureRes = \(job\) => \(\{/);
    assert.match(SERVER, /json\(payload\) \{[\s\S]{0,220}job\.payload = payload;/,
      'the captured body must be the handler\'s own, verbatim');
    // A `res.status(500).json(...)` in the handler must keep its code, or a failure
    // would be recorded as a success with an error body.
    assert.match(SERVER, /status\(c\) \{ this\._code = c; return this; \}/);
    assert.match(SERVER, /json\(payload\) \{\s*\n\s*job\.code = this\._code;/,
      'the captured code must come from the status() the handler set');
  });
});

describe('a job the server has forgotten is SAID, never spun on', () => {
  test('an unknown job answers `unknown`', () => {
    // A process restart loses the map. The panel must be told, so it can report
    // "we lost track of that test — run it again". The alternative is the
    // 38-minute spinner this whole change exists to end.
    assert.match(SERVER, /if \(!job\) return res\.json\(\{ state: 'unknown' \}\);/,
      'a forgotten job must never be reported as still running');
  });

  test('and the client turns that into a recorded skip, not a spinner', () => {
    assert.match(HTML, /d\.state === 'unknown'[\s\S]{0,120}throw new Error\('we lost track/,
      'the client must raise it, so the per-sample catch records the sample as unrunnable');
    assert.match(HTML, /d\.state === 'running'[\s\S]{0,40}return poll\(\)/,
      'and keep polling only while the server says it is genuinely still working');
  });

  test('the poll is scoped to the tenant AND the user who started it', () => {
    // A job id is guessable. Ownership never comes from the id — the same
    // fail-closed rule a paused test already applies.
    const poll = SERVER.slice(SERVER.indexOf("app.get('/workflows/run/:jobId'"));
    assert.match(poll.slice(0, 1400), /job\.tenantId !== \(req\.tenant\?\.id \?\? null\) \|\| job\.userId !== \(req\.user\?\.id \?\? null\)/,
      'one workspace must not be able to read another\'s test run');
    assert.match(poll.slice(0, 1400), /403/);
  });

  test('a job is never left running by a throw', () => {
    // The socket is already answered, so a throw cannot reach Express — there is no
    // response left to send. Left unrecorded it would be a job that can never
    // finish, and a panel polling it forever.
    const bg = SERVER.slice(SERVER.indexOf("if (req.body?.background !== true)"));
    assert.match(bg.slice(0, 1800), /finally \{[\s\S]{0,260}job\.state === 'running'[\s\S]{0,320}job\.state = 'done'/,
      'a background run that throws must still record an answer');
  });

  test('and it expires, so the map cannot grow without bound', () => {
    assert.match(SERVER, /TEST_RUN_JOB_TTL_MS/);
    assert.match(SERVER, /const sweepRunJobs = \(\) => \{[\s\S]{0,240}TEST_RUN_JOBS\.delete/);
  });

  test('nothing about a test run is parked in the DATABASE', () => {
    // The same hazard `PENDING_TEST_PAUSES` closes by construction: a test run must
    // never become a row something else can later pick up and fire for real.
    assert.match(SERVER, /const TEST_RUN_JOBS = new Map\(\);/,
      'in memory only — a persisted test run is a customer email waiting to be sent by mistake');
  });
});

describe('the client polls, and stops when it should', () => {
  const src = (() => {
    const i = HTML.indexOf('const postOnce = function(body)');
    assert.notEqual(i, -1, 'postOnce is gone — re-point this, do not delete it');
    return HTML.slice(i, HTML.indexOf('const postRun = function', i));
  })();

  test('it asks for a job rather than holding the connection', () => {
    assert.match(src, /background: true/,
      'without this the request is long again and the proxy kills it at ~100s');
    assert.match(src, /\/workflows\/run\/" \+ encodeURIComponent\(jobId\)/,
      'the answer must be polled from the job');
  });

  test('each individual request has a SHORT ceiling', () => {
    // These are now tiny — a POST returning a job id, a GET returning a verdict — so
    // anything near this is a transport fault, not a slow run. The old ceiling was
    // the run's whole duration, which is exactly what could not fit through a proxy.
    assert.match(HTML, /const REQ_TIMEOUT_MS = 30000;/);
    assert.match(src, /fetchWithCeiling\(/);
  });

  test('and the OVERALL wait is bounded too, so it cannot poll forever', () => {
    assert.match(HTML, /const RUN_TIMEOUT_MS = 600000;/);
    assert.match(src, /Date\.now\(\) - startedAt > RUN_TIMEOUT_MS[\s\S]{0,120}throw new Error\('the test run did not finish in time'\)/,
      'a run the engine never finishes must end in an answer, not a spinner');
  });

  test('an older server, or an immediate refusal, still works', () => {
    // Backgrounding is ADDITIVE. A deploy where the page is newer than the API, or a
    // 400 for an invalid spec, has no job to poll and must pass straight through.
    assert.match(src, /if \(!r\.ok \|\| !r\.data \|\| !r\.data\.jobId\) return asResponse\(/,
      'a response with no job id must be handed on, never polled for');
  });

  test('every caller sees ONE response shape, whichever way the answer arrived', () => {
    // `asResponse` returns { ok, status, text() } — what `_readJson` reads — so the
    // eight call sites below are identical for a foreground answer and a polled one.
    // A second shape here would be a second thing to keep in step.
    // Defined just above `postOnce`, so assert against the page rather than the slice.
    assert.match(HTML, /const asResponse = function\(code, payload\)/);
    assert.match(HTML, /text: function\(\) \{ return Promise\.resolve\(JSON\.stringify\(payload\)\); \}/);
    assert.match(src, /return asResponse\(/, 'and postOnce must actually return that shape');
  });
});
