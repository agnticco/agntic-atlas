/**
 * Slack actions test suite — exercises all 14 channel handlers against a
 * stub Slack server. Verifies each handler:
 *   - calls the correct Slack API endpoint(s),
 *   - sends the correct payload shape,
 *   - returns the expected result shape,
 *   - throws on missing required config.
 *
 * No real Slack token needed. Prints a pass/fail line per action.
 * Exits 0 only when all pass.
 */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Stub Slack server ───────────────────────────────────────────────────────
// Records the last call to each endpoint; returns canned success responses.
const calls = {};  // endpoint -> { method, path, headers, body }
const stub = http.createServer((req, res) => {
  let buf = ''; req.on('data', (d) => { buf += d; }); req.on('end', () => {
    const endpoint = req.url.replace(/^\//, '');
    let body = {}; try { body = JSON.parse(buf); } catch { try { body = Object.fromEntries(new URLSearchParams(buf)); } catch { /* ignore */ } }
    calls[endpoint] = { body };

    const ok = { ok: true };
    const responses = {
      'chat.postMessage':           { ...ok, ts: '111.001', channel: body.channel ?? 'C001' },
      'conversations.open':         { ...ok, channel: { id: 'D001' } },
      'users.lookupByEmail':        { ...ok, user: { id: 'U999', real_name: 'Test User', name: 'test' } },
      'reactions.add':              ok,
      'files.getUploadURLExternal': { ...ok, upload_url: `http://127.0.0.1:${stub.address().port}/upload`, file_id: 'F001' },
      'upload':                     ok,  // the actual binary upload step
      'files.completeUploadExternal': ok,
      'conversations.create':       { ...ok, channel: { id: 'C002', name: body.name ?? 'new-channel' } },
      'conversations.invite':       ok,
      'conversations.setTopic':     ok,
      'pins.add':                   ok,
      'reminders.add':              { ...ok, reminder: { id: 'R001' } },
      'search.messages':            { ...ok, messages: { matches: [{ ts: '100.001', channel: { name: 'general' }, text: 'hello', permalink: 'https://slack.com/x' }] } },
      'conversations.history':      { ...ok, messages: [{ ts: '200.001', text: 'hi', user: 'U001' }] },
    };
    const reply = responses[endpoint] ?? { ok: false, error: 'unknown_endpoint' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((r) => stub.listen(0, r));
const STUB_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.SLACK_API_URL = STUB_URL;
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

// ── Boot the spine for real channel registration ────────────────────────────
const t = mkdtempSync(join(tmpdir(), 'atlas-slacktest-'));
for (const [k, v] of Object.entries({
  WORKFLOWS_DB: 'w.sqlite', SOURCES_DB: 's.sqlite', VECTOR_DIR: 'vectors',
  AUTH_DB: 'a.sqlite', AUTH_SECRET: '.jwt', OAUTH_DB: 'o.sqlite', OAUTH_KEY: '.okey',
})) process.env[k] = join(t, v);

const { bootSpine } = await import('../../src/api/server.js');
const spine = await bootSpine();
const reg = spine.engine.channelRegistry;

// ── Test harness ────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function deliver(channelId, config, body = 'test output') {
  const handler = reg.getHandler(channelId);
  if (!handler) throw new Error(`channel "${channelId}" not registered`);
  return handler({ config, body, title: null, lastOutput: body });
}

function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }
function assertCalled(endpoint) { assert(calls[endpoint], `Slack API "${endpoint}" was not called`); }
function assertPayload(endpoint, key, val) {
  assertCalled(endpoint);
  const actual = calls[endpoint].body[key];
  assert(actual === val, `${endpoint}: expected ${key}="${val}", got "${actual}"`);
}

// ── post_message ────────────────────────────────────────────────────────────
await test('post_message: posts to channel, returns ts', async () => {
  const r = await deliver('slack', { target: '#general' }, 'hello world');
  assertCalled('chat.postMessage');
  assertPayload('chat.postMessage', 'channel', '#general');
  assert(r.ts === '111.001', `expected ts 111.001 got ${r.ts}`);
  assert(r.delivered === true);
});
await test('post_message: supports username + icon_emoji override', async () => {
  await deliver('slack', { target: '#general', username: 'Atlas Bot', icon_emoji: ':robot_face:' });
  assertPayload('chat.postMessage', 'username', 'Atlas Bot');
  assertPayload('chat.postMessage', 'icon_emoji', ':robot_face:');
});
await test('post_message: throws without target', async () => {
  let threw = false; try { await deliver('slack', {}); } catch { threw = true; }
  assert(threw, 'should throw without target');
});

// ── post_dm ─────────────────────────────────────────────────────────────────
await test('post_dm: opens DM by user ID and posts', async () => {
  const r = await deliver('slack_dm', { user: 'U123' }, 'hello there');
  assertCalled('conversations.open');
  assertPayload('conversations.open', 'users', 'U123');
  assertCalled('chat.postMessage');
  assertPayload('chat.postMessage', 'channel', 'D001');
  assert(r.delivered === true);
  assert(r.ts === '111.001');
});
await test('post_dm: resolves email to user ID first', async () => {
  delete calls['users.lookupByEmail'];
  await deliver('slack_dm', { user: 'alice@example.com' });
  assertCalled('users.lookupByEmail');
  assertPayload('users.lookupByEmail', 'email', 'alice@example.com');
  assertPayload('conversations.open', 'users', 'U999');  // resolved ID from stub
});
await test('post_dm: throws without user', async () => {
  let threw = false; try { await deliver('slack_dm', {}); } catch { threw = true; }
  assert(threw);
});

// ── reply_in_thread ──────────────────────────────────────────────────────────
await test('reply_in_thread: posts with thread_ts', async () => {
  const r = await deliver('slack_reply', { target: 'C001', thread_ts: '100.000' });
  assertPayload('chat.postMessage', 'thread_ts', '100.000');
  assertPayload('chat.postMessage', 'channel', 'C001');
  assert(r.ts === '111.001');
});
await test('reply_in_thread: throws without thread_ts', async () => {
  let threw = false; try { await deliver('slack_reply', { target: 'C001' }); } catch { threw = true; }
  assert(threw);
});

// ── add_reaction ─────────────────────────────────────────────────────────────
await test('add_reaction: calls reactions.add with correct params', async () => {
  delete calls['reactions.add'];
  const r = await deliver('slack_reaction', { target: 'C001', timestamp: '111.001', emoji: 'white_check_mark' });
  assertCalled('reactions.add');
  assertPayload('reactions.add', 'channel', 'C001');
  assertPayload('reactions.add', 'timestamp', '111.001');
  assertPayload('reactions.add', 'name', 'white_check_mark');
  assert(r.delivered === true);
});
await test('add_reaction: throws without emoji', async () => {
  let threw = false; try { await deliver('slack_reaction', { target: 'C001', timestamp: '111' }); } catch { threw = true; }
  assert(threw);
});

// ── upload_file ───────────────────────────────────────────────────────────────
await test('upload_file: 3-step flow (getUploadURL → upload → complete)', async () => {
  delete calls['files.getUploadURLExternal']; delete calls['upload']; delete calls['files.completeUploadExternal'];
  const r = await deliver('slack_file', { target: 'C001', title: 'My Report', filename: 'report.txt' }, 'file content here');
  assertCalled('files.getUploadURLExternal');
  assertCalled('files.completeUploadExternal');
  assertPayload('files.completeUploadExternal', 'channel_id', 'C001');
  assert(r.delivered === true);
  assert(r.fileId === 'F001');
});
await test('upload_file: throws without target', async () => {
  let threw = false; try { await deliver('slack_file', { content: 'x' }); } catch { threw = true; }
  assert(threw);
});

// ── create_channel ────────────────────────────────────────────────────────────
await test('create_channel: calls conversations.create', async () => {
  delete calls['conversations.create'];
  const r = await deliver('slack_create_channel', { name: 'project-alpha' });
  assertCalled('conversations.create');
  assertPayload('conversations.create', 'name', 'project-alpha');
  assert(r.channelId === 'C002');
  assert(r.delivered === true);
});
await test('create_channel: private flag forwarded', async () => {
  await deliver('slack_create_channel', { name: 'secret', is_private: true });
  assert(calls['conversations.create'].body.is_private === true);
});

// ── invite_to_channel ─────────────────────────────────────────────────────────
await test('invite_to_channel: calls conversations.invite', async () => {
  delete calls['conversations.invite'];
  const r = await deliver('slack_invite', { target: 'C001', users: 'U001,U002' });
  assertCalled('conversations.invite');
  assertPayload('conversations.invite', 'channel', 'C001');
  assertPayload('conversations.invite', 'users', 'U001,U002');
  assert(r.delivered === true);
});

// ── set_channel_topic ─────────────────────────────────────────────────────────
await test('set_channel_topic: calls conversations.setTopic', async () => {
  delete calls['conversations.setTopic'];
  const r = await deliver('slack_topic', { target: 'C001', topic: 'Sprint 42 in progress' });
  assertCalled('conversations.setTopic');
  assertPayload('conversations.setTopic', 'channel', 'C001');
  assertPayload('conversations.setTopic', 'topic', 'Sprint 42 in progress');
  assert(r.delivered === true);
});
await test('set_channel_topic: uses body when topic not in config', async () => {
  await deliver('slack_topic', { target: 'C001' }, 'topic from prior step');
  assertPayload('conversations.setTopic', 'topic', 'topic from prior step');
});

// ── pin_message ───────────────────────────────────────────────────────────────
await test('pin_message: calls pins.add', async () => {
  delete calls['pins.add'];
  const r = await deliver('slack_pin', { target: 'C001', timestamp: '111.001' });
  assertCalled('pins.add');
  assertPayload('pins.add', 'channel', 'C001');
  assertPayload('pins.add', 'timestamp', '111.001');
  assert(r.delivered === true);
});

// ── set_reminder ──────────────────────────────────────────────────────────────
await test('set_reminder: calls reminders.add', async () => {
  delete calls['reminders.add'];
  const r = await deliver('slack_reminder', { text: 'Follow up on proposal', time: 'in 1 hour' });
  assertCalled('reminders.add');
  assertPayload('reminders.add', 'text', 'Follow up on proposal');
  assertPayload('reminders.add', 'time', 'in 1 hour');
  assert(r.reminderId === 'R001');
  assert(r.delivered === true);
});
await test('set_reminder: user param forwarded when set', async () => {
  await deliver('slack_reminder', { text: 'remind them', time: 'tomorrow', user: 'U007' });
  assertPayload('reminders.add', 'user', 'U007');
});
await test('set_reminder: uses body as text when config.text absent', async () => {
  await deliver('slack_reminder', { time: 'in 5 minutes' }, 'check the dashboard');
  assertPayload('reminders.add', 'text', 'check the dashboard');
});

// ── lookup_user ───────────────────────────────────────────────────────────────
await test('lookup_user: calls users.lookupByEmail', async () => {
  delete calls['users.lookupByEmail'];
  const r = await deliver('slack_lookup_user', { email: 'bob@example.com' });
  assertCalled('users.lookupByEmail');
  assertPayload('users.lookupByEmail', 'email', 'bob@example.com');
  assert(r.userId === 'U999');
  assert(r.displayName === 'Test User');
  assert(r.delivered === true);
});
await test('lookup_user: throws without email', async () => {
  let threw = false; try { await deliver('slack_lookup_user', {}); } catch { threw = true; }
  assert(threw);
});

// ── search_messages ───────────────────────────────────────────────────────────
await test('search_messages: calls search.messages', async () => {
  delete calls['search.messages'];
  const r = await deliver('slack_search', { query: 'from:@alice in:#general' });
  assertCalled('search.messages');
  assertPayload('search.messages', 'query', 'from:@alice in:#general');
  assert(Array.isArray(r.messages) && r.messages.length === 1);
  assert(r.messages[0].ts === '100.001');
  assert(r.delivered === true);
});
await test('search_messages: forwards limit as count', async () => {
  await deliver('slack_search', { query: 'test', limit: 5 });
  assert(calls['search.messages'].body.count === 5);
});

// ── get_channel_history ───────────────────────────────────────────────────────
await test('get_channel_history: calls conversations.history', async () => {
  delete calls['conversations.history'];
  const r = await deliver('slack_history', { target: 'C001', limit: 10 });
  assertCalled('conversations.history');
  assertPayload('conversations.history', 'channel', 'C001');
  assert(calls['conversations.history'].body.limit === 10);
  assert(Array.isArray(r.messages) && r.messages.length === 1);
  assert(r.delivered === true);
});
await test('get_channel_history: forwards oldest filter', async () => {
  await deliver('slack_history', { target: 'C001', oldest: '1700000000' });
  assertPayload('conversations.history', 'oldest', '1700000000');
});

// ── post_group_dm ─────────────────────────────────────────────────────────────
await test('post_group_dm: opens MPIM and posts', async () => {
  delete calls['conversations.open']; delete calls['chat.postMessage'];
  const r = await deliver('slack_group_dm', { users: 'U001,U002,U003' }, 'team update');
  assertCalled('conversations.open');
  assertPayload('conversations.open', 'users', 'U001,U002,U003');
  assertCalled('chat.postMessage');
  assertPayload('chat.postMessage', 'channel', 'D001');
  assert(r.ts === '111.001');
  assert(r.delivered === true);
});
await test('post_group_dm: throws without users', async () => {
  let threw = false; try { await deliver('slack_group_dm', {}); } catch { threw = true; }
  assert(threw);
});

// ── Cleanup + summary ─────────────────────────────────────────────────────────
stub.close(); spine.close();

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log('SLACK-ACTIONS-FAIL'); process.exit(1); }
console.log('SLACK-ACTIONS-PASS');
process.exit(0);
