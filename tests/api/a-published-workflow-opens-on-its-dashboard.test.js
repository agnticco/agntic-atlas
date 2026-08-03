/**
 * A PUBLISHED WORKFLOW OPENS ON ITS DASHBOARD, NOT THE GO-LIVE SCREEN.
 *
 * ── Witnessed 2026-08-03, by Charles ────────────────────────────────────────
 *
 * Publish a workflow, click away to another, click back — and it opens on the
 * go-live screen again. It reads as though publishing did not take, and the
 * obvious next move is to press Approve a second time.
 *
 * `consoleSidebarWfs` is the browser's CACHED list. Publishing flips the workflow
 * to `active` on the server; if that list has not been refetched since, the entry
 * still says `draft` and `openConsole` routes back into the builder.
 *
 * THE 2026-08-01 FIX WAS RIGHT AND DID NOT COVER THIS. It chained the
 * post-publish `openConsole` off a refreshed list — the instant of publishing.
 * Every LATER reopen reads whatever the cache holds. Same symptom, one door along:
 * a live workflow that goes on presenting itself as a draft.
 *
 * ── And the other half: a real run left no trace where anyone looks ──────────
 *
 * The `run.ok` / `run.failed` lines in the event log are written by the HTTP
 * route, so every one carries a `test-…` id. A run started by a SCHEDULE or a
 * CONNECTOR EVENT — the only kind that matters in production — wrote nothing.
 *
 * Measured cost the same day: a Slack message fired a workflow, it ran and
 * delivered in 67ms, and three rounds were spent diagnosing a failure that had
 * not happened. Two wrong hypotheses were floated on the way. The run row in the
 * database was always right; it simply was not where anyone was looking.
 *
 * ── Mutations, run by hand (2026-08-03) ─────────────────────────────────────
 *
 *   M1  a cached `draft` is trusted again        → 2 red
 *   M2  the re-entry guard is dropped (loops)    → 1 red
 *   M3  the scheduler stops logging a success    → 1 red
 *   M4  the scheduler stops logging a failure    → 1 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HTML = readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const SCHED = readFileSync(path.join(ROOT, 'src/workflows/workflow-scheduler.js'), 'utf8');

describe('a cached draft is confirmed before it routes anywhere', () => {
  const open = (() => {
    const i = HTML.indexOf('  openConsole(wfId) {');
    assert.notEqual(i, -1, '`openConsole` is GONE — re-point this, do not delete the test');
    return HTML.slice(i, i + 3000);
  })();

  test('a cached `draft` triggers a refetch rather than the builder', () => {
    assert.match(open, /wf\.status === 'draft' && !this\._confirmingDraft/,
      'the stale cache must not decide where a published workflow opens');
    assert.match(open, /_loadWorkflows\(\)[\s\S]{0,200}openConsole\(wfId\)/,
      'it must refetch and then re-enter with a list it can trust');
  });

  test('and it re-enters exactly ONCE', () => {
    // Without the guard the second pass sees `draft` again and refetches forever —
    // a spinner instead of a screen, which is worse than the bug being fixed.
    assert.match(open, /this\._confirmingDraft = true;/);
    assert.match(open, /self0\._confirmingDraft = false;/,
      'the flag must be cleared, or a genuine draft can never be opened again');
  });

  test('a genuine draft still opens in the builder', () => {
    // The anti-overreach direction: after the refetch, a workflow that really is a
    // draft must reach the original branch untouched.
    assert.match(open, /if \(wf && wf\.status === 'draft'\) \{/,
      'the draft branch must survive — this adds a confirmation, it does not replace it');
  });

  test('a cached `active` is never re-checked', () => {
    // One direction only. Being wrong the other way opens a dashboard for a draft,
    // which the console handles, and a request on every open is a real cost.
    const before = open.slice(0, open.indexOf("_confirmingDraft"));
    assert.doesNotMatch(before, /status === 'active'[\s\S]{0,80}_loadWorkflows/,
      'no refetch on the common path');
  });
});

describe('a real run says so in the log people read', () => {
  test('the scheduler records a success', () => {
    assert.match(SCHED, /noteRun\('flow\.run\.ok'/,
      'a scheduled or event-triggered run that WORKED must be visible');
    assert.match(SCHED, /flow\.run\.ok'[\s\S]{0,220}trigger:/,
      'and must say what started it — schedule and connector-event are told apart here');
  });

  test('and a failure', () => {
    assert.match(SCHED, /noteRun\('flow\.run\.failed'/);
    assert.match(SCHED, /flow\.run\.failed'[\s\S]{0,260}error:/,
      'with the reason, so nobody has to bisect the database for it');
  });

  test('LOGGING CAN NEVER BREAK A RUN', () => {
    // The first version called `logEvent` bare, inside the run's own try block.
    // Where the event log cannot be written it throws, the catch reads that as the
    // RUN failing, and a workflow that succeeded is recorded `error` — twelve tests
    // went red. A diagnostic that turns working runs into failures is strictly
    // worse than the blindness it was added to cure.
    assert.match(SCHED, /const noteRun = \([\s\S]{0,200}try \{ logEvent\([\s\S]{0,60}catch/,
      'the log call must be wrapped so a failure to write can never fail the run');
  });

  test('they carry the run id, so the log and the runs table can be joined', () => {
    for (const kind of ['flow\\.run\\.ok', 'flow\\.run\\.failed']) {
      assert.match(SCHED, new RegExp(`${kind}'[\\s\\S]{0,260}runId:`),
        'the row and the line must be the same run');
    }
  });
});
