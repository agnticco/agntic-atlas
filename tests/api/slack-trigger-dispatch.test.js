/**
 * Slack trigger dispatch — the two silent failures found while scoping the
 * workflow library (2026-07-24).
 *
 * Both defects looked like success: the user published a workflow, Atlas showed
 * it live, and it either never fired or fired on everything, saying nothing.
 *
 *   1. A channel filter written the only way a user knows a channel — "#requests" —
 *      was compared against the channel ID Slack puts on the event, so it could
 *      never match. The workflow never fired.
 *   2. The `keywords` filter is declared on the slack_message trigger's config
 *      schema and was enforced by nothing, so the workflow fired on EVERY message
 *      while its own definition promised otherwise.
 *   3. `app_mention` events were dropped by the dispatcher, so the "Slack App
 *      Mention" trigger in the catalog could never run.
 *
 * These assert the SELECTION — which workflows a given Slack event fires — because
 * that is the thing that was wrong. Production calls the same two functions with a
 * real channel resolver; here the resolver is a stub.
 *
 *   node --test tests/api/slack-trigger-dispatch.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSlackFlows, slackEventKind } from '../../src/api/server.js';

// The real workspace: #requests is C01REQ0001, #random is C01RND0002.
const CHANNEL_IDS = { requests: 'C01REQ0001', random: 'C01RND0002' };
const resolveChannelId = async (target) => {
  if (/^[CGDW][A-Z0-9]+$/i.test(target)) return target;
  return CHANNEL_IDS[String(target).replace(/^#/, '')] ?? null;
};

const flow = (slug, trigger) => ({ slug, triggers: [trigger] });
const msgTrigger = (filter) => ({ type: 'event', connector: 'slack', event: 'message', ...(filter ? { filter } : {}) });
const mentionTrigger = () => ({ type: 'event', connector: 'slack', event: 'app_mention' });

const messageIn = (channel, text = 'hello') => ({ type: 'message', channel, text, user: 'U1' });

async function fire(flows, ev, wantEvent = 'message') {
  return selectSlackFlows({ flows, ev, wantEvent, resolveChannelId });
}

// ── 1. Channel filter by NAME ────────────────────────────────────────────────

test('a trigger filtered to "#requests" fires on a message in that channel', async () => {
  const flows = [flow('triage', msgTrigger({ channel: '#requests' }))];
  const fired = await fire(flows, messageIn('C01REQ0001'));
  assert.deepEqual(fired.map((f) => f.slug), ['triage'],
    'a channel filter written by name must resolve to the id Slack sends');
});

test('a bare channel name (no #) also fires', async () => {
  const flows = [flow('triage', msgTrigger({ channel: 'requests' }))];
  const fired = await fire(flows, messageIn('C01REQ0001'));
  assert.equal(fired.length, 1);
});

test('a channel filter still fires when written as a raw channel ID', async () => {
  const flows = [flow('triage', msgTrigger({ channel: 'C01REQ0001' }))];
  const fired = await fire(flows, messageIn('C01REQ0001'));
  assert.equal(fired.length, 1, 'the id form must keep working');
});

test('a message in a DIFFERENT channel does not fire the filtered workflow', async () => {
  const flows = [flow('triage', msgTrigger({ channel: '#requests' }))];
  const fired = await fire(flows, messageIn('C01RND0002'));
  assert.equal(fired.length, 0);
});

test('an UNRESOLVABLE channel matches nothing — it must never degrade to "any channel"', async () => {
  const flows = [flow('triage', msgTrigger({ channel: '#deleted-channel' }))];
  const unresolved = [];
  const fired = await selectSlackFlows({
    flows, ev: messageIn('C01REQ0001'), wantEvent: 'message', resolveChannelId,
    onUnresolved: (w, target) => unresolved.push([w.slug, target]),
  });
  assert.equal(fired.length, 0, 'a filter we cannot resolve must not fire on everything');
  assert.deepEqual(unresolved, [['triage', '#deleted-channel']], 'and it must be reported, not silent');
});

test('no channel filter fires on any channel', async () => {
  const flows = [flow('anychannel', msgTrigger())];
  assert.equal((await fire(flows, messageIn('C01RND0002'))).length, 1);
  assert.equal((await fire(flows, messageIn('C01REQ0001'))).length, 1);
});

// ── 2. Keyword filter is actually enforced ───────────────────────────────────

test('a keyword filter does NOT fire on a message without the keyword', async () => {
  const flows = [flow('urgent', msgTrigger({ keywords: 'urgent, outage' }))];
  const fired = await fire(flows, messageIn('C01RND0002', 'lunch plans anyone'));
  assert.equal(fired.length, 0, 'the keywords option is offered — it must be enforced');
});

test('a keyword filter fires when the message contains one of the words', async () => {
  const flows = [flow('urgent', msgTrigger({ keywords: 'urgent, outage' }))];
  assert.equal((await fire(flows, messageIn('C01RND0002', 'we have an OUTAGE'))).length, 1,
    'matching is case-insensitive');
  assert.equal((await fire(flows, messageIn('C01RND0002', 'this is urgent'))).length, 1);
});

test('keywords accept an array as well as a comma string', async () => {
  const flows = [flow('urgent', msgTrigger({ keywords: ['outage'] }))];
  assert.equal((await fire(flows, messageIn('C01RND0002', 'an outage again'))).length, 1);
  assert.equal((await fire(flows, messageIn('C01RND0002', 'all quiet'))).length, 0);
});

test('an empty keywords value means no keyword restriction', async () => {
  for (const keywords of ['', '   ', [], null, undefined]) {
    const flows = [flow('any', msgTrigger({ keywords }))];
    assert.equal((await fire(flows, messageIn('C01RND0002', 'anything'))).length, 1,
      `empty keywords (${JSON.stringify(keywords)}) must not block the trigger`);
  }
});

test('channel and keyword filters are ANDed, not ORed', async () => {
  const flows = [flow('both', msgTrigger({ channel: '#requests', keywords: 'urgent' }))];
  assert.equal((await fire(flows, messageIn('C01REQ0001', 'urgent please'))).length, 1);
  assert.equal((await fire(flows, messageIn('C01REQ0001', 'no rush'))).length, 0, 'right channel, wrong words');
  assert.equal((await fire(flows, messageIn('C01RND0002', 'urgent please'))).length, 0, 'right words, wrong channel');
});

// ── 3. App mentions reach a workflow ─────────────────────────────────────────

test('an app_mention event is recognised rather than dropped', () => {
  assert.equal(slackEventKind({ type: 'app_mention', text: '<@U0> summarise this' }), 'app_mention');
  assert.equal(slackEventKind({ type: 'message', text: 'hi' }), 'message');
});

test('bot echoes, edits and other event types are still ignored', () => {
  assert.equal(slackEventKind({ type: 'message', bot_id: 'B1' }), null);
  assert.equal(slackEventKind({ type: 'message', subtype: 'message_changed' }), null);
  assert.equal(slackEventKind({ type: 'app_mention', bot_id: 'B1' }), null, 'the bot must not mention itself into a loop');
  assert.equal(slackEventKind({ type: 'reaction_added' }), null);
  assert.equal(slackEventKind(null), null);
});

test('a mention fires an app_mention workflow and NOT a message workflow', async () => {
  const flows = [flow('mention-flow', mentionTrigger()), flow('message-flow', msgTrigger())];
  const fired = await fire(flows, { type: 'app_mention', channel: 'C01RND0002', text: '<@U0> do it', user: 'U1' }, 'app_mention');
  assert.deepEqual(fired.map((f) => f.slug), ['mention-flow'],
    'a mention must not be delivered to plain message triggers as well');
});

test('a plain message does not fire an app_mention workflow', async () => {
  const flows = [flow('mention-flow', mentionTrigger())];
  assert.equal((await fire(flows, messageIn('C01RND0002'))).length, 0);
});

// ── Cross-cutting ────────────────────────────────────────────────────────────

test('non-Slack and non-event triggers are never selected', async () => {
  const flows = [
    flow('email', { type: 'email', filter: 'is:unread' }),
    flow('airtable', { type: 'event', connector: 'airtable', event: 'record_changed' }),
    flow('schedule', { type: 'schedule', cron: '0 9 * * *' }),
  ];
  assert.equal((await fire(flows, messageIn('C01RND0002'))).length, 0);
});

test('a workflow with several Slack triggers fires if ANY of them matches', async () => {
  const multi = { slug: 'multi', triggers: [msgTrigger({ channel: '#random' }), msgTrigger({ channel: '#requests' })] };
  assert.equal((await fire([multi], messageIn('C01REQ0001'))).length, 1);
  assert.equal((await fire([multi], messageIn('C01OTH0003'))).length, 0);
});

test('a matching workflow is returned once, not once per matching trigger', async () => {
  const multi = { slug: 'multi', triggers: [msgTrigger(), msgTrigger({ channel: '#requests' })] };
  const fired = await fire([multi], messageIn('C01REQ0001'));
  assert.equal(fired.length, 1, 'a workflow must not be dispatched twice for one event');
});
