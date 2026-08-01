/**
 * A SLACK-TRIGGERED WORKFLOW MUST NOT PUBLISH AS LIVE WHEN SLACK CANNOT REACH ATLAS.
 *
 * WITNESSED ON PROD 2026-07-30, re-confirmed 2026-08-01. A Slack-triggered workflow was
 * built, tested ("Contract kept"), published, and shown as live. The bot was in the
 * channel. A human posted the keyword. **Nothing happened** — no run, no delivery, no log.
 *
 * Measured across the entire event-log history: the only Slack paths ever hit are
 * `/status` (57), `/callback` (1), `/authorize` (1), and two `/events` requests 224ms
 * apart that were a deliberate probe of the verification handshake. **Slack has never
 * delivered a real event to this deployment.** The endpoint answers `url_verification`
 * correctly from the public internet, so the gap is the Slack app's own Event
 * Subscriptions configuration — a console setting Atlas cannot read through any API.
 *
 * The fail-closed publishing rule of 2026-07-24 — *"a workflow that saves, shows as live,
 * and can never fire is the lie the product exists to prevent"* — covered Airtable and had
 * no equivalent for Slack. This is that equivalent, and it is the THIRD instance in
 * CLAUDE.md of that rule being reached through a door it did not cover.
 *
 * THE ANTI-FALSE-POSITIVE CASES ARE THE HARD PART, and they are most of this file. The
 * obvious rule — "refuse unless we have seen an event for THIS tenant" — traps every
 * correctly-configured workspace at its first Slack workflow, because no event can arrive
 * before one is published. So the refusal is scoped to the one unambiguous state: this
 * deployment has never received a Slack event from anyone, ever.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync as read } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  checkSlackTriggersArmable, isSlackEventTrigger,
  recordSlackEventSeen, slackDeliveryRecord,
} from '../../src/connectors/slack/delivery-record.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SLACK_SPEC = {
  name: 'Urgent messages',
  triggers: [{ type: 'event', connector: 'slack', event: 'slack_message', channel: '#ops' }],
  nodes: [], edges: [],
};
const CONNECTED = { connected: true };
const NEVER = { everReceived: false };
const DELIVERING = { everReceived: true, firstSeenAt: '2026-08-01T00:00:00.000Z' };

describe('THE PROD CASE — Slack has never delivered an event here', () => {
  test('publishing is refused', () => {
    const r = checkSlackTriggersArmable(SLACK_SPEC, CONNECTED, NEVER);
    assert.equal(r.ok, false, 'a workflow that can never fire was cleared to publish');
    assert.equal(r.code, 'SLACK_EVENTS_NOT_DELIVERING');
  });

  test('and the reason tells a person exactly what to change', () => {
    const r = checkSlackTriggersArmable(SLACK_SPEC, CONNECTED, NEVER);
    assert.match(r.error, /would look live and never actually run/);
    assert.match(r.error, /Event Subscriptions/);
    assert.doesNotMatch(r.error, /webhook|payload|API|endpoint|400|signature/i,
      'no jargon on a refusal a non-technical person has to act on');
  });

  test('Slack not connected at all is its own, different refusal', () => {
    const r = checkSlackTriggersArmable(SLACK_SPEC, { connected: false }, NEVER);
    assert.equal(r.code, 'SLACK_TRIGGER_NOT_CONNECTED');
    assert.match(r.error, /Connect Slack/);
  });
});

describe('IT MUST NOT TRAP A WORKSPACE THAT IS WIRED CORRECTLY', () => {
  test('once ANY event has arrived, publishing is allowed', () => {
    assert.deepEqual(checkSlackTriggersArmable(SLACK_SPEC, CONNECTED, DELIVERING), { ok: true });
  });

  test('a tenant that has not posted YET is not blocked', () => {
    // "Not yet" and "never" are different answers. The deployment is wired; this
    // workspace may simply be quiet, or the bot may not be in the channel — neither is
    // distinguishable from ordinary silence, and blocking would strand them.
    const record = { everReceived: true, firstSeenAt: '2026-08-01T00:00:00.000Z', tenants: { 'someone-else': '2026-08-01T00:00:00.000Z' } };
    assert.deepEqual(checkSlackTriggersArmable(SLACK_SPEC, CONNECTED, record), { ok: true });
  });

  test('a workflow with NO Slack trigger is never touched', () => {
    for (const spec of [
      { triggers: [{ type: 'email' }] },
      { triggers: [{ type: 'schedule', cron: '0 9 * * *' }] },
      { triggers: [{ type: 'event', connector: 'airtable' }] },
      { triggers: [] },
      {},
    ]) {
      assert.deepEqual(checkSlackTriggersArmable(spec, { connected: false }, NEVER), { ok: true },
        JSON.stringify(spec));
    }
  });

  test('a workflow that merely POSTS to Slack is not a Slack trigger', () => {
    // Delivery to Slack needs no Event Subscriptions at all — Atlas pushes, Slack does
    // not have to reach us. Blocking it would refuse the commonest Slack workflow there is.
    const posts = { triggers: [{ type: 'email' }], nodes: [{ id: 'd', type: 'deliver', config: { channel: 'slack', target: '#ops' } }] };
    assert.deepEqual(checkSlackTriggersArmable(posts, CONNECTED, NEVER), { ok: true });
  });

  test('only an event trigger naming Slack counts', () => {
    assert.equal(isSlackEventTrigger({ type: 'event', connector: 'slack' }), true);
    assert.equal(isSlackEventTrigger({ type: 'event', connector: 'SLACK' }), true);
    assert.equal(isSlackEventTrigger({ type: 'event', connector: 'airtable' }), false);
    assert.equal(isSlackEventTrigger({ type: 'event' }), false, 'an event with no connector arms nothing');
    assert.equal(isSlackEventTrigger({ type: 'slack' }), false);
    assert.equal(isSlackEventTrigger(null), false);
  });

  test('the LEGACY connector_event shape is not claimed by this check', () => {
    /**
     * Added after mutation: dropping the `type === 'event'` test survived the suite,
     * because every case above that could have caught it also lacked a `connector`.
     * `connector_event` is the unrunnable legacy type CLAUDE.md records — EIGHT stored
     * workflows carry it — and it is refused earlier and more accurately by
     * `TRIGGER_NOT_RUNNABLE` ("it does not say which base to watch, so it could never
     * start"). Claiming it here would answer a question this check cannot answer, with a
     * Slack-specific sentence about Event Subscriptions that is not the user's problem.
     */
    assert.equal(isSlackEventTrigger({ type: 'connector_event', connector: 'slack' }), false);
    assert.deepEqual(
      checkSlackTriggersArmable({ triggers: [{ type: 'connector_event', connector: 'slack' }] }, CONNECTED, NEVER),
      { ok: true }, 'a legacy trigger was given a Slack refusal that does not describe its problem');
  });
});

describe('the record of what Slack has actually delivered', () => {
  let dir, file;
  const fresh = () => { dir = mkdtempSync(path.join(tmpdir(), 'atlas-slack-')); file = path.join(dir, 'seen.json'); };

  test('a deployment that has seen nothing says so', () => {
    fresh();
    assert.equal(slackDeliveryRecord({ file }).everReceived, false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('one event flips it, permanently', () => {
    fresh();
    recordSlackEventSeen('tenant-a', { file, now: '2026-08-01T10:00:00.000Z' });
    const r = slackDeliveryRecord({ file });
    assert.equal(r.everReceived, true);
    assert.equal(r.firstSeenAt, '2026-08-01T10:00:00.000Z');
    assert.equal(r.tenants['tenant-a'], '2026-08-01T10:00:00.000Z');
    rmSync(dir, { recursive: true, force: true });
  });

  test('the FIRST sighting is kept, not overwritten by later ones', () => {
    fresh();
    recordSlackEventSeen('a', { file, now: '2026-08-01T10:00:00.000Z' });
    recordSlackEventSeen('b', { file, now: '2026-08-02T10:00:00.000Z' });
    const r = slackDeliveryRecord({ file });
    assert.equal(r.firstSeenAt, '2026-08-01T10:00:00.000Z');
    assert.equal(r.tenants.b, '2026-08-02T10:00:00.000Z');
    rmSync(dir, { recursive: true, force: true });
  });

  test('an event with no resolvable tenant still proves the plumbing works', () => {
    // It is evidence about the DEPLOYMENT, which is what the gate reads. Requiring a
    // tenant would throw away the very first event from an unrecognised workspace.
    fresh();
    recordSlackEventSeen(null, { file, now: '2026-08-01T10:00:00.000Z' });
    assert.equal(slackDeliveryRecord({ file }).everReceived, true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a corrupt or unreadable record reads as "never seen", not as a crash', () => {
    fresh();
    writeFileSync(file, 'not json at all');
    assert.equal(slackDeliveryRecord({ file }).everReceived, false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('recording never throws, whatever the disk does', () => {
    // Bookkeeping must never cost an inbound event.
    assert.doesNotThrow(() => recordSlackEventSeen('t', { file: '/proc/nope/cannot/write.json' }));
  });
});

describe('it is wired into the paths that matter', () => {
  /** SOURCE-level, and weaker than the rest — both routes close over the request. */
  const BUILDER = read(path.join(ROOT, 'src/api/builder.js'), 'utf8');
  const SERVER  = read(path.join(ROOT, 'src/api/server.js'), 'utf8');

  test('BOTH publish paths gate on it — POST and the PUT that is the real publish', () => {
    // CLAUDE.md: the PUT "IS the publish path for most workflows". Guarding only the POST
    // would leave the commonest door open, which is how the Airtable rule was bypassed.
    assert.equal((BUILDER.match(/checkSlackTriggersArmable\(spec, slack, slackDeliveryRecord\(\)\)/g) ?? []).length, 2);
  });

  test('the events route records a sighting before dispatching', () => {
    const at = SERVER.indexOf("app.post('/connectors/slack/events'");
    assert.ok(at > 0, 're-point this test');
    const body = SERVER.slice(at, at + 1600);
    assert.match(body, /recordSlackEventSeen\(/);
    assert.ok(body.indexOf('recordSlackEventSeen') < body.indexOf('dispatchSlackEvent'),
      'an event that matches no workflow still proves Slack can reach us — record first');
  });

  test('the verification handshake does NOT count as a delivered event', () => {
    // The handshake is answered before any of this, and two probe requests to it are
    // exactly what made the prod log look briefly like Slack had delivered something.
    const at = SERVER.indexOf("app.post('/connectors/slack/events'");
    const body = SERVER.slice(at, at + 1600);
    const urlVerify = body.indexOf('url_verification');
    assert.ok(urlVerify > 0 && urlVerify < body.indexOf('recordSlackEventSeen'),
      'url_verification must return before anything is recorded');
  });
});
