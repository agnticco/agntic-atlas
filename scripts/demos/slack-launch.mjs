/**
 * Agntic x Slack launch demo
 *
 * Demonstrates the full Atlas engine working live in a Slack workspace:
 *   1. Creates a new channel "agntic-x-slack"
 *   2. Invites the authorized user into it
 *   3. Posts a launch announcement with a GIF via Slack Block Kit
 *
 * Run with your Atlas admin token and the workspace's user ID:
 *
 *   node scripts/demos/slack-launch.mjs
 *
 * Atlas must be running on localhost:3000 and Slack must be connected.
 */

const BASE = process.env.ATLAS_URL ?? 'http://localhost:3000';
const EMAIL = process.env.ATLAS_EMAIL ?? 'you@agntic.co';
const SLACK_EMAIL = process.env.SLACK_EMAIL ?? 'charles@agntic.co'; // Slack workspace email (may differ from Atlas login)
const PASSWORD = process.env.ATLAS_PASSWORD ?? 'Atlas-41de3879bb';

// ── helpers ──────────────────────────────────────────────────────────────────
async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function run(token, spec) {
  const r = await api('POST', '/workflows/run', { token, body: { spec } });
  if (!r.ok) throw new Error(`run failed: ${r.json.error ?? r.status}`);
  if (r.json.error) throw new Error(r.json.error);
  return r.json;
}

function step(emoji, text) {
  console.log(`${emoji}  ${text}`);
}

// ── boot ─────────────────────────────────────────────────────────────────────
console.log('\n  🚀  Agntic × Slack — launch demo\n');

step('🔐', 'Logging in to Atlas…');
const loginRes = await api('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.json.error}`);
const token = loginRes.json.token;
step('✓', `Logged in as ${loginRes.json.user?.email} (tenant: ${loginRes.json.user?.tenant_id})`);

// Confirm Slack connected
const status = await api('GET', '/connectors/slack/status', { token });
if (!status.json.connected) throw new Error('Slack is not connected — authorize first via /connectors/slack/authorize');
step('✓', `Slack connected to workspace: ${status.json.account}`);

// ── step 1: discover who we are ───────────────────────────────────────────────
step('👤', 'Looking up your Slack user ID…');
const lookupResult = await run(token, {
  name: 'lookup', triggers: [], edges: [],
  nodes: [{ id: 'l', type: 'deliver', config: { channel: 'slack_lookup_user', email: SLACK_EMAIL } }],
});
const myUserId = lookupResult.deliveries?.[0]?.userId;
step('✓', `User ID: ${myUserId}`);

// ── step 2: create the channel ────────────────────────────────────────────────
step('📢', 'Creating channel #agntic-x-slack…');
const createResult = await run(token, {
  name: 'create-channel', triggers: [], edges: [],
  nodes: [{ id: 'c', type: 'deliver', config: { channel: 'slack_create_channel', name: 'agntic-x-slack' } }],
});
const channelId = createResult.deliveries?.[0]?.channelId;
if (!channelId) throw new Error(`Channel creation failed: ${JSON.stringify(createResult)}`);
step('✓', `Channel created: #agntic-x-slack (${channelId})`);

// ── step 3: invite the user ───────────────────────────────────────────────────
step('📨', `Inviting you (${myUserId}) to #agntic-x-slack…`);
await run(token, {
  name: 'invite', triggers: [], edges: [],
  nodes: [{ id: 'i', type: 'deliver', config: { channel: 'slack_invite', target: channelId, users: myUserId } }],
});
step('✓', 'Invited.');

// ── step 4: the launch message ────────────────────────────────────────────────
step('🎉', 'Posting launch announcement with GIF…');

const blocks = JSON.stringify([
  {
    type: 'header',
    text: { type: 'plain_text', text: '🎉  Agntic is now on Slack', emoji: true },
  },
  {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*Agntic just connected to the Slack platform.*\n\nFrom here, our AI workflow engine can post messages, send DMs, react to messages, search channels, manage users, and more — all triggered by real-world events and built through a simple conversation.\n\nThis channel was created, this message was written, and this GIF was posted entirely by the Atlas engine. No manual API calls. Just a workflow.',
    },
  },
  { type: 'divider' },
  {
    type: 'image',
    image_url: 'https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExcW9lMm1rOTYzeGFoZXptZHhwZGt3NzgxN2k4M3IwcWo2bHFtdW5kZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3o7abKhOpu0NwenH3O/giphy.gif',
    alt_text: 'Celebration confetti',
    title: { type: 'plain_text', text: 'The future of work automation is here 🎊' },
  },
  { type: 'divider' },
  {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '⚡ Powered by *Atlas* — conversational workflow automation by Agntic  ·  Connected via OAuth in one click',
      },
    ],
  },
]);

await run(token, {
  name: 'launch-post', triggers: [], edges: [],
  nodes: [{
    id: 'p', type: 'deliver', config: {
      channel: 'slack',
      target: channelId,
      body: 'Agntic is now on Slack 🎉 — visit #agntic-x-slack',
      blocks,
    },
  }],
});
step('✓', 'Message posted!');

// ── done ─────────────────────────────────────────────────────────────────────
console.log(`
  ✅  Done. Check #agntic-x-slack in your Slack workspace.

     Channel : #agntic-x-slack (${channelId})
     Workspace: ${status.json.account}
`);
