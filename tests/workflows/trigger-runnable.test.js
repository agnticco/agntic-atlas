/**
 * A workflow may not publish with a trigger nothing can run.
 *
 * The defect these pin, in full: QA built an Airtable-triggered workflow whose
 * stored trigger was `{"type":"connector_event"}` — no connector, no event, no
 * base, no table. `checkAirtableTriggersArmable` filters with
 * `isAirtableRecordChangedTrigger` (`type==='event' && connector==='airtable'`),
 * matched nothing, and returned "nothing to arm" — so the publish was ALLOWED.
 * The 2026-07-24 fail-closed rule was bypassed rather than weakened, and the
 * result was the silent failure it exists to prevent: saves, shows live, never
 * fires. Eight such workflows are in the QA databases preserved at
 * `agent-org/runs/2026-07-27/evidence-workflow-dbs/`.
 *
 * Every guard here was hand-mutated red→green — see the run report. The cases
 * that matter most are the NEGATIVE ones: this check must not refuse the
 * ordinary triggers, or it trades a silent failure for a loud one that blocks
 * every publish.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunnableTrigger, checkTriggersRunnable, RUNNABLE_TRIGGER_TYPES,
} from '../../src/workflows/trigger-runnable.js';
import { mergeGeneratedSpec } from '../../src/converger/elicitation-graph.js';

// The exact shapes read out of the QA databases, not invented approximations.
const REAL_MALFORMED     = { type: 'connector_event', filter: 'is:unread' };
const REAL_MALFORMED_NUL = { type: 'connector_event', filter: null };
const REAL_AIRTABLE      = {
  type: 'event', connector: 'airtable', event: 'airtable_record_changed',
  filter: { baseId: 'appXXXXXXXXXXXXXX', tableId: 'tblYYYYYYYYYYYYYY' },
};

describe('isRunnableTrigger — scoped to the value, never to the producer', () => {
  test('accepts every type a consumer actually honours', () => {
    assert.ok(isRunnableTrigger({ type: 'email', filter: 'is:unread' }));
    assert.ok(isRunnableTrigger({ type: 'schedule', cron: '0 9 * * *' }));
    assert.ok(isRunnableTrigger({ type: 'manual' }));
    assert.ok(isRunnableTrigger(REAL_AIRTABLE));
    // RE-POINTED 2026-08-03. This asserted that naming the connector was enough —
    // and that exact shape published, showed as live, and could never fire: a real
    // Slack message arrived, verified, and matched nothing, because every
    // dispatcher matches on the EVENT id (`t.event === wantEvent`). Naming the
    // connector was necessary and never sufficient.
    assert.ok(isRunnableTrigger({ type: 'event', connector: 'slack', event: 'slack_message' }));
    assert.equal(isRunnableTrigger({ type: 'event', connector: 'slack' }), false,
      'a connector event with no event id is the shape that silently never fires');
  });

  test('REJECTS the shape that actually shipped', () => {
    assert.equal(isRunnableTrigger(REAL_MALFORMED), false);
    assert.equal(isRunnableTrigger(REAL_MALFORMED_NUL), false);
  });

  test('an event with no connector is un-routable — every dispatcher matches on it', () => {
    assert.equal(isRunnableTrigger({ type: 'event' }), false);
    assert.equal(isRunnableTrigger({ type: 'event', connector: '' }), false);
    assert.equal(isRunnableTrigger({ type: 'event', connector: '   ' }), false);
  });

  test('junk is not runnable, and does not throw', () => {
    for (const junk of [null, undefined, 'email', 42, [], {}, { type: null }, { type: '' }]) {
      assert.equal(isRunnableTrigger(junk), false, `junk: ${JSON.stringify(junk)}`);
    }
  });

  test('the runnable set does not silently include connector_event', () => {
    assert.equal(RUNNABLE_TRIGGER_TYPES.includes('connector_event'), false);
  });
});

describe('checkTriggersRunnable — the publish refusal', () => {
  test('refuses the real malformed trigger, with a code and a human sentence', () => {
    const r = checkTriggersRunnable({ triggers: [REAL_MALFORMED] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TRIGGER_NOT_RUNNABLE');
    // The product's standard: a refusal names something a person can act on.
    assert.match(r.error, /never run|could never/i);
    assert.doesNotMatch(r.error, /connector_event|undefined|null/,
      'the refusal must not leak the internal type name at the user');
  });

  test('an event with no connector gets its OWN sentence, not the generic one', () => {
    const r = checkTriggersRunnable({ triggers: [{ type: 'event' }] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TRIGGER_NO_CONNECTOR');
    assert.match(r.error, /which app/i);
  });

  test('refuses when ANY trigger is unrunnable, not only the first', () => {
    const r = checkTriggersRunnable({
      triggers: [{ type: 'email', filter: 'is:unread' }, REAL_MALFORMED],
    });
    assert.equal(r.ok, false, 'a good trigger must not mask a bad one');
  });

  // ── The negative cases. These are what stop this guard becoming the bug. ────
  test('lets the ordinary triggers through untouched', () => {
    assert.deepEqual(checkTriggersRunnable({ triggers: [{ type: 'email', filter: 'is:unread' }] }), { ok: true });
    assert.deepEqual(checkTriggersRunnable({ triggers: [{ type: 'schedule', cron: '0 9 * * *' }] }), { ok: true });
    assert.deepEqual(checkTriggersRunnable({ triggers: [{ type: 'manual' }] }), { ok: true });
    assert.deepEqual(checkTriggersRunnable({ triggers: [REAL_AIRTABLE] }), { ok: true });
  });

  test('a spec with no triggers is NOT this check\'s business', () => {
    assert.deepEqual(checkTriggersRunnable({ triggers: [] }), { ok: true });
    assert.deepEqual(checkTriggersRunnable({}), { ok: true });
    assert.deepEqual(checkTriggersRunnable(null), { ok: true });
  });
});

describe('mergeGeneratedSpec — never throw a working trigger away for a broken one', () => {
  const NODES = [{ id: 'a', type: 'llm' }];

  test('THE DEFECT: a thin draft trigger no longer beats the complete generated one', () => {
    const merged = mergeGeneratedSpec(
      { triggers: [REAL_MALFORMED] },
      { triggers: [REAL_AIRTABLE], nodes: NODES, edges: [] },
    );
    assert.equal(merged.triggers.length, 1);
    assert.equal(merged.triggers[0].type, 'event');
    assert.equal(merged.triggers[0].connector, 'airtable');
    assert.equal(merged.triggers[0].filter.baseId, 'appXXXXXXXXXXXXXX',
      'the base the model worked out must survive the merge');
  });

  test('the draft STILL wins when it is runnable — a regenerate must not overwrite the user', () => {
    const userSaid = { type: 'email', filter: 'from:boss@acme.com' };
    const merged = mergeGeneratedSpec(
      { triggers: [userSaid] },
      { triggers: [{ type: 'schedule', cron: '0 9 * * *' }], nodes: NODES, edges: [] },
    );
    assert.deepEqual(merged.triggers, [userSaid],
      'a model regenerate must never replace an answer the user actually gave');
  });

  test('a runnable draft wins even when the generated one is also runnable', () => {
    const userSaid = { type: 'schedule', cron: '0 6 * * *' };
    const merged = mergeGeneratedSpec(
      { triggers: [userSaid] },
      { triggers: [REAL_AIRTABLE], nodes: NODES, edges: [] },
    );
    assert.deepEqual(merged.triggers, [userSaid]);
  });

  test('both unrunnable: the draft is kept, so the publish guard is what refuses it', () => {
    const merged = mergeGeneratedSpec(
      { triggers: [REAL_MALFORMED] },
      { triggers: [REAL_MALFORMED_NUL], nodes: NODES, edges: [] },
    );
    assert.deepEqual(merged.triggers, [REAL_MALFORMED],
      'the merge must not invent a preference between two broken triggers');
    assert.equal(checkTriggersRunnable(merged).ok, false,
      'and the guard must still catch it');
  });

  test('an empty draft still falls back to the generated triggers', () => {
    const merged = mergeGeneratedSpec({ triggers: [] }, { triggers: [REAL_AIRTABLE], nodes: NODES, edges: [] });
    assert.deepEqual(merged.triggers, [REAL_AIRTABLE]);
  });
});
