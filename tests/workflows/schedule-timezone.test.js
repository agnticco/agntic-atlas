/**
 * A scheduled workflow fires at the time the user asked for, in the zone they asked
 * for.
 *
 * Found while fixing a cosmetic-looking complaint ("chat said 4:34 UTC"). The
 * scheduler decided "is this due?" against SERVER-LOCAL time — `now.getDay()`,
 * `toDateString()`, `scheduled.setHours(...)` — while the spec has carried a declared
 * `timezone` per schedule trigger all along. Nothing read it: a grep for `timezone`
 * across workflow-store.js and workflow-scheduler.js returned nothing.
 *
 * The production box is Etc/UTC. So "every weekday at 9am America/Chicago" fired at
 * 9am UTC — 4am Chicago. The workflow ran, reported success, and was five hours
 * early. Silent, user-reachable, and it breaks the one thing a scheduled workflow
 * promises.
 *
 * Three decisions had to move into that zone together, and each is its own bug if
 * missed: which DAY it is, whether it already ran TODAY, and how long since due.
 * There is a test below for each.
 *
 * These drive the real `_flowScheduleState` on a real store, because the defect was
 * in that method's own arithmetic.
 */

// ── PIN THE PROCESS ZONE TO THE PRODUCTION BOX'S, BEFORE ANY Date IS TOUCHED ──
// Without this these tests are machine-dependent, which is the wrong kind of green.
// The defect is that the scheduler used SERVER-LOCAL time; a developer machine on
// America/Chicago is accidentally correct, so the bug is invisible there and only
// appears on the prod box (Etc/UTC). Reverting the fix then killed one test locally
// and would have killed six in CI — a suite whose verdict depends on where it runs
// cannot be trusted either way. Pinned to UTC so it reproduces production exactly.
process.env.TZ = 'UTC';

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowStore } from '../../src/workflows/workflow-store.js';

let dir, store, realNow;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-sched-tz-'));
  store = new WorkflowStore({ dbPath: dir });
});
after(() => {
  globalThis.Date = realNow ?? globalThis.Date;
  try { store?.close?.(); } catch { /* best effort */ }
  rmSync(dir, { recursive: true, force: true });
});

/** Freeze the clock at a real instant, so "now" is a fact rather than a guess. */
function at(iso) {
  const fixed = new Date(iso).getTime();
  if (!realNow) realNow = globalThis.Date;
  class FrozenDate extends realNow {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  globalThis.Date = FrozenDate;
}
beforeEach(() => { if (realNow) globalThis.Date = realNow; });

/** A workflow with one schedule trigger, straight into `_flowScheduleState`. */
const wf = ({ cron, timezone, last_run = null }) => ({
  kind: 'flow', status: 'active', last_run,
  triggers: [{ type: 'schedule', cron, timezone }],
});

describe('a schedule fires in its declared timezone', () => {
  test('9am America/Chicago is NOT due at 9am UTC — the whole defect, in one line', () => {
    // 09:00 UTC on a Monday is 04:00 in Chicago. The user asked for 9am. Firing here
    // is five hours early, and it reported success.
    at('2026-07-27T09:00:00Z');

    // MUTATION: revert the daily/weekly block to `now.getDay()` /
    // `scheduled.setHours(hh, mm, 0, 0)` and this returns 'due' — the shipped
    // behaviour — turning this red.
    assert.equal(
      store._flowScheduleState(wf({ cron: '0 9 * * 1-5', timezone: 'America/Chicago' })),
      null,
      'must NOT be due: it is 4am where the user is',
    );
  });

  test('and it IS due at 9am Chicago — the guard did not just break scheduling', () => {
    // The failure mode of a timezone fix is a workflow that never fires at all.
    at('2026-07-27T14:00:00Z');   // 09:00 CDT
    assert.equal(
      store._flowScheduleState(wf({ cron: '0 9 * * 1-5', timezone: 'America/Chicago' })),
      'due',
    );
  });

  test('WHICH DAY: a weekday trigger is not due on a UTC Saturday that is still Friday there', () => {
    // 02:00 UTC Saturday = 21:00 Friday in Chicago. Cron says Mon-Fri. Judged in UTC
    // the day-of-week check rejects it; judged locally it is Friday evening, which is
    // past 9am, so the honest answer is 'overdue' — not silently skipped.
    at('2026-08-01T02:00:00Z');
    const state = store._flowScheduleState(wf({ cron: '0 9 * * 1-5', timezone: 'America/Chicago' }));
    assert.notEqual(state, null, 'the local day is Friday — the trigger applies');
    assert.equal(state, 'overdue', 'and 9am Friday is long past, so it is overdue, not due');
  });

  test('ALREADY RAN TODAY: the calendar day rolls over in the user\'s zone, not UTC', () => {
    // Ran 01:00 UTC Tuesday = 20:00 Monday in Chicago. At 14:00 UTC Tuesday (09:00
    // CDT Tuesday) it is a NEW local day, so it must fire. Judged in UTC both
    // instants are Tuesday, so it would be wrongly suppressed for a whole day.
    at('2026-07-28T14:00:00Z');
    assert.equal(
      store._flowScheduleState(wf({
        cron: '0 9 * * 1-5', timezone: 'America/Chicago', last_run: '2026-07-28T01:00:00Z',
      })),
      'due',
      'the last run was Monday evening locally — Tuesday 9am is a new day',
    );
  });

  test('and it does NOT re-fire twice in the same local day', () => {
    at('2026-07-28T14:30:00Z');                       // 09:30 CDT Tuesday
    assert.equal(
      store._flowScheduleState(wf({
        cron: '0 9 * * 1-5', timezone: 'America/Chicago', last_run: '2026-07-28T14:05:00Z',
      })),
      null,
      'already ran this local day',
    );
  });

  test('HOW LONG SINCE DUE: the grace window is measured on the local clock', () => {
    // Default grace is 2h. 09:00 CDT + 90min = still due; + 3h = overdue.
    at('2026-07-27T15:30:00Z');
    assert.equal(store._flowScheduleState(wf({ cron: '0 9 * * *', timezone: 'America/Chicago' })), 'due');
    at('2026-07-27T17:00:00Z');
    assert.equal(store._flowScheduleState(wf({ cron: '0 9 * * *', timezone: 'America/Chicago' })), 'overdue');
  });

  test('a trigger with NO declared zone falls back to the deployment zone', () => {
    const prev = process.env.ATLAS_TIMEZONE;
    try {
      process.env.ATLAS_TIMEZONE = 'America/Chicago';
      at('2026-07-27T09:00:00Z');                     // 04:00 CDT
      assert.equal(store._flowScheduleState(wf({ cron: '0 9 * * *' })), null,
        'no declared zone must not mean "server local"');
      at('2026-07-27T14:00:00Z');                     // 09:00 CDT
      assert.equal(store._flowScheduleState(wf({ cron: '0 9 * * *' })), 'due');
    } finally {
      if (prev === undefined) delete process.env.ATLAS_TIMEZONE; else process.env.ATLAS_TIMEZONE = prev;
    }
  });

  test('UTC-declared schedules behave exactly as before — no regression', () => {
    at('2026-07-27T09:00:00Z');
    assert.equal(store._flowScheduleState(wf({ cron: '0 9 * * 1-5', timezone: 'UTC' })), 'due');
  });

  test('sub-daily intervals are untouched — they are elapsed-time, not wall-clock', () => {
    // `*/5 * * * *` means "every 5 minutes", which has no timezone. Confirming the
    // change did not leak into that path.
    at('2026-07-27T09:00:00Z');
    assert.equal(store._flowScheduleState(wf({ cron: '*/5 * * * *', timezone: 'America/Chicago' })), 'due');
    assert.equal(
      store._flowScheduleState(wf({
        cron: '*/5 * * * *', timezone: 'America/Chicago', last_run: '2026-07-27T08:58:00Z',
      })),
      null,
      'two minutes ago is inside a five-minute interval',
    );
  });
});
