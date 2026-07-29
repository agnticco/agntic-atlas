/**
 * A SCHEDULE THAT DECLARES NO ZONE RUNS IN THE WRONG ONE, AND SAYS NOTHING.
 *
 * MEASURED ON PROD, 2026-07-29. Three stored schedule triggers, every one of them
 *
 *     {"type":"schedule","cron":"0 17 * * 1-5"}
 *
 * with no `timezone` field at all — next to a workflow named "Every weekday at 5pm
 * CDT" and a plan card that said "5:00 pm CDT (America/Chicago)".
 *
 * The scheduler is not at fault. It reads
 * `t.timezone ?? t.config?.timezone ?? deploymentTimeZone()`, and honouring the
 * declared zone was itself a recorded fix (workflow-store.js). But the prod box is
 * Etc/UTC, so a trigger declaring nothing fires at 17:00 UTC — NOON in Chicago. The
 * run succeeds, the dashboard shows green, and the workflow is five hours early
 * having told the user to the minute when it would run.
 *
 * That is the shape this codebase treats as blocking: user-reachable, silent, and
 * it looks like success.
 *
 * The prompt has asked for a zone all along and the model kept omitting it. A
 * prompt is a belief about model behaviour; this is the mechanism that makes being
 * wrong about it harmless.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stampScheduleTimezone, mergeGeneratedSpec } from '../../src/converger/elicitation-graph.js';

const TZ = 'America/Chicago';

describe('a blank zone is filled', () => {
  test('the exact prod trigger gets one', () => {
    const [t] = stampScheduleTimezone([{ type: 'schedule', cron: '0 17 * * 1-5' }], TZ);
    assert.equal(t.timezone, TZ);
    assert.equal(t.cron, '0 17 * * 1-5', 'nothing else about the trigger may change');
  });

  test('a trigger that only has a cron counts as a schedule', () => {
    const [t] = stampScheduleTimezone([{ cron: '0 9 * * *' }], TZ);
    assert.equal(t.timezone, TZ);
  });
});

describe('what it must NOT do', () => {
  test('it never overrides a zone the model declared', () => {
    // The model may know something the browser does not — a workflow for a team in
    // another office. Filling a blank is help; overwriting is a different bug.
    const [t] = stampScheduleTimezone([{ type: 'schedule', cron: '0 9 * * *', timezone: 'Europe/London' }], TZ);
    assert.equal(t.timezone, 'Europe/London');
  });

  test('nor one declared under config', () => {
    const [t] = stampScheduleTimezone([{ type: 'schedule', cron: '0 9 * * *', config: { timezone: 'Asia/Tokyo' } }], TZ);
    assert.equal(t.timezone, undefined, 'already declared where the scheduler also looks');
  });

  test('it leaves every other kind of trigger alone', () => {
    for (const t of [{ type: 'email', filter: 'is:unread' },
                     { type: 'event', connector: 'airtable' },
                     { type: 'manual' }]) {
      assert.deepEqual(stampScheduleTimezone([t], TZ)[0], t);
    }
  });

  test('and does nothing when no zone is known', () => {
    // A guessed zone would be worse than the deployment fallback: it would look
    // declared and authoritative while being no better informed.
    const t = { type: 'schedule', cron: '0 9 * * *' };
    assert.deepEqual(stampScheduleTimezone([t], '')[0], t);
    assert.deepEqual(stampScheduleTimezone([t], null)[0], t);
    assert.deepEqual(stampScheduleTimezone([t], undefined)[0], t);
  });

  test('junk in, junk out — never a crash', () => {
    assert.deepEqual(stampScheduleTimezone(null, TZ), null);
    assert.deepEqual(stampScheduleTimezone([null, 'x'], TZ), [null, 'x']);
  });
});

describe('it is applied where every build passes', () => {
  const gen = { nodes: [{ id: 'a', type: 'llm' }], edges: [],
                triggers: [{ type: 'schedule', cron: '0 17 * * 1-5' }] };

  test('a model-supplied trigger is stamped', () => {
    const merged = mergeGeneratedSpec({ triggers: [] }, gen, { userTimezone: TZ });
    assert.equal(merged.triggers[0].timezone, TZ);
  });

  test('and so is one the interview gathered — whichever side wins', () => {
    // The draft normally beats the model. The stamp runs AFTER that choice, so no
    // path can reach publish declaring nothing.
    const draft = { triggers: [{ type: 'schedule', cron: '30 8 * * *' }] };
    const merged = mergeGeneratedSpec(draft, gen, { userTimezone: TZ });
    assert.equal(merged.triggers[0].cron, '30 8 * * *', 'the draft still wins');
    assert.equal(merged.triggers[0].timezone, TZ);
  });

  test('with no zone threaded through, the merge is unchanged', () => {
    const merged = mergeGeneratedSpec({ triggers: [] }, gen);
    assert.equal(merged.triggers[0].timezone, undefined);
  });
});
