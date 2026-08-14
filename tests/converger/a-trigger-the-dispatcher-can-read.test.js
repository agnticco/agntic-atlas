/**
 * A TRIGGER MUST HAVE THE SHAPE ITS OWN DISPATCHER READS.
 *
 * ── Witnessed 2026-08-03 ─────────────────────────────────────────────────────
 *
 * The first Slack-triggered workflow ever published. It passed its test, went
 * live, and a real message arrived, verified — and matched nothing. Its trigger
 * was stored as
 *
 *   { type:'event', connector:'slack', filter:'channel:#atlas-test-temp' }
 *
 * while `selectSlackFlows` (server.js) matches with
 * `t.type==='event' && t.connector==='slack' && t.event===wantEvent` and reads the
 * channel from `t.filter?.channel`. It failed TWICE over: no `event` id, so it was
 * dropped on the matcher's first line; and `filter` a STRING where an object was
 * expected, so even with the id fixed it would have fired on EVERY channel rather
 * than the one the person named.
 *
 * ── This is `connector_event`, one field along ──────────────────────────────
 *
 * ENGINEERING-LOG.md records that defect and closes with the sentence this file exists to
 * enforce: *keep the runnable set in step with the consumers.* The publish guard
 * checked `type` and `connector` — both correct here — and never that the event id
 * was present. So a workflow that saves, shows as live and can never fire got
 * through the very check written to make that impossible.
 *
 * ── Two halves, and both are needed ──────────────────────────────────────────
 *
 *  · `normalizeConnectorTrigger` gives the trigger the shape the dispatcher reads,
 *    at `mergeGeneratedSpec` — the one point every build passes through, for the
 *    same reason `stampScheduleTimezone` is there. A prompt is a belief about model
 *    behaviour; this is what makes being wrong about it harmless.
 *  · `isRunnableTrigger` now REFUSES a connector event with no id, so a shape
 *    nothing can match is caught loudly at publish rather than going quiet in
 *    production. The normalizer is the fix; the guard is the backstop.
 *
 * ── Mutations, run by hand (2026-08-03) ─────────────────────────────────────
 *
 *   M1  the event id is no longer stamped        → 4 red
 *   M2  a string filter is left as a string      → 2 red
 *   M3  the normalizer overrides a declared id   → 1 red, and ONLY after the
 *       fixture was made distinguishing: the first version declared an id that
 *       recomputation would also produce, so removing the guard changed nothing.
 *   M4  the guard accepts a missing event id     → 2 red
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { normalizeConnectorTrigger } from '../../src/converger/elicitation-graph.js';
import { isRunnableTrigger } from '../../src/workflows/trigger-runnable.js';
import { slackEventKind } from '../../src/api/server.js';

// THE DISPATCHER'S OWN ANSWER, not a literal copied beside it. The first version
// of the normalizer stamped `slack_message` — the capability id — where the matcher
// wants Slack's RAW event type. It shipped and was caught only by reading the real
// dispatcher. Deriving the expectation from `slackEventKind` means that mistake
// cannot be made again in either direction.
const WANT_MESSAGE = slackEventKind({ type: 'message' });
const WANT_MENTION = slackEventKind({ type: 'app_mention' });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = readFileSync(path.join(ROOT, 'src/api/server.js'), 'utf8');

/** THE REAL STORED TRIGGER, lifted from the workflow that went live and never fired. */
const broken = () => [{ type: 'event', connector: 'slack', filter: 'channel:#atlas-test-temp' }];
const fix = (t) => normalizeConnectorTrigger(t)[0];

describe('the shape the dispatcher actually matches on', () => {
  test('the matcher still reads what this file assumes it reads', () => {
    // If the dispatcher changes, this file must change with it — that drift is the
    // entire defect, so it is asserted rather than remembered.
    assert.match(SERVER, /t\.type === 'event' && t\.connector === 'slack' && t\.event === wantEvent/,
      'the Slack matcher moved — re-point the normalizer AND this test');
    assert.match(SERVER, /t\.filter\?\.channel/, 'the channel is read off the filter OBJECT');
  });

  test('the event id is stamped in the vocabulary the matcher uses', () => {
    assert.equal(fix(broken()).event, WANT_MESSAGE);
  });

  test('a capability id is corrected to the raw event type', () => {
    // `slack_message` is what the catalog calls it; `message` is what Slack sends
    // and what the matcher compares against. A model writing the former has
    // declared something no dispatch can match — malformed, not a preference.
    assert.equal(fix([{ type: 'event', connector: 'slack', event: 'slack_message' }]).event, WANT_MESSAGE);
    assert.equal(fix([{ type: 'event', connector: 'slack', event: 'slack_mention' }]).event, WANT_MENTION);
  });

  test('a filter expression becomes the object the matcher reads', () => {
    assert.deepEqual(fix(broken()).filter, { channel: '#atlas-test-temp' },
      'a string filter reads as "no channel filter", which fires on EVERY channel');
  });

  test('and the result is runnable, where the original was not', () => {
    assert.equal(isRunnableTrigger(broken()[0]), false, 'the shape that went live and never fired');
    assert.equal(isRunnableTrigger(fix(broken())), true);
  });

  test('a mention is honoured, because it arrives differently', () => {
    assert.equal(fix([{ type: 'event', connector: 'slack', filter: 'channel:#ops event:slack_mention' }]).event,
      WANT_MENTION);
  });
});

describe('it never overrides what is already right', () => {
  test('a declared event id and object filter are untouched', () => {
    const t = { type: 'event', connector: 'slack', event: WANT_MENTION, filter: { channel: '#x' } };
    assert.deepEqual(fix([t]), t);
  });

  test('a declared id survives even when the filter suggests otherwise', () => {
    // THE CASE THAT MAKES THE GUARD OBSERVABLE. The test above uses a declared
    // `slack_mention` that recomputation would ALSO produce, so removing the
    // "only when absent" guard changed nothing and the mutation survived
    // (measured 2026-08-03). Here the two disagree: the person declared an
    // ordinary message trigger on a channel whose name contains "mentions", and
    // the declaration must win.
    const t = { type: 'event', connector: 'slack', event: WANT_MESSAGE, filter: 'channel:#mentions' };
    assert.equal(fix([t]).event, WANT_MESSAGE,
      'a declared event id is never recomputed — the model may know something the text does not');
  });

  test('other connectors are left alone', () => {
    // Airtable's shape already works and is matched by its own dispatcher. Widening
    // this to every connector would be changing something with no defect in it.
    const t = { type: 'event', connector: 'airtable', event: 'airtable_record_changed', filter: { baseId: 'app1' } };
    assert.deepEqual(fix([t]), t);
  });

  test('email, schedule and manual pass straight through', () => {
    for (const t of [{ type: 'email', filter: 'is:unread' }, { type: 'schedule', cron: '0 9 * * *' }, { type: 'manual' }]) {
      assert.deepEqual(fix([t]), t);
    }
  });

  test('an unparseable filter is dropped, never guessed at', () => {
    // "No channel filter" means ANY channel. Inventing one would silently narrow a
    // workflow the person asked to be broad — the opposite mistake, and a quieter one.
    const t = fix([{ type: 'event', connector: 'slack', filter: 'every message please' }]);
    assert.equal(t.filter, undefined);
    assert.equal(t.event, WANT_MESSAGE);
  });
});

describe('the guard refuses what nothing can match', () => {
  test('a connector event with no id cannot publish', () => {
    assert.equal(isRunnableTrigger({ type: 'event', connector: 'slack' }), false);
    assert.equal(isRunnableTrigger({ type: 'event', connector: 'slack', event: '  ' }), false);
  });

  test('but every well-formed trigger still can', () => {
    // The anti-overreach direction: this guard blocks publishing, so a false
    // refusal stops someone shipping a workflow that would have worked.
    assert.ok(isRunnableTrigger({ type: 'event', connector: 'slack', event: WANT_MESSAGE }));
    assert.ok(isRunnableTrigger({ type: 'event', connector: 'airtable', event: 'airtable_record_changed' }));
    for (const type of ['email', 'schedule', 'manual']) assert.ok(isRunnableTrigger({ type }));
  });
});
