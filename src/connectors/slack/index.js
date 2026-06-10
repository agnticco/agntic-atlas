/**
 * Slack connector (P1) — built fresh; the salvage repo had no Slack connector.
 *
 * Two parts:
 *   1. A delivery channel: a workflow `deliver` node with `config.channel = "slack"`
 *      posts the step's content to a Slack channel via `chat.postMessage`.
 *   2. A declarative CAPABILITY MAP (capabilities.json) the AI/converger reads to
 *      understand which Slack functions it may use. Availability is resolved
 *      per-client: an action is AVAILABLE iff it is `implemented` AND the client's
 *      bot token actually grants its `requiredScopes` (auto-detected from Slack).
 *
 * A connector via the full MCP runtime is deferred (MCP is first exercised in P2
 * via the existing `google` connector). See docs/connectors/slack.md.
 *
 * Auth: a bot token with the relevant scopes in `SLACK_BOT_TOKEN` (or per-node
 * `config.token`). `SLACK_API_URL` overrides the API base (the gate points it at a
 * local stub so checks are reproducible without secrets).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { getSlackGrant, isOAuthConfigured } from './oauth.js';

const DEFAULT_API_BASE = 'https://slack.com/api';

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * The declarative capability map — the contract the converger targets. Loaded from
 * capabilities.json so it stays easy to read/edit (add an entry + a handler to grow
 * Slack support; per-client variation falls out of the token's granted scopes).
 */
export const slackCapabilities = JSON.parse(readFileSync(join(__dir, 'capabilities.json'), 'utf8'));

/**
 * Auto-detect the scopes a bot token was actually granted. Slack returns them in
 * the `x-oauth-scopes` response header on any Web API call (we use auth.test).
 * Returns [] when there's no token or the call fails — callers then see every
 * scope-gated action as unavailable (honest, never crashes boot).
 * @returns {Promise<string[]>}
 */
export async function detectGrantedScopes({
  token = process.env.SLACK_BOT_TOKEN,
  apiBase = process.env.SLACK_API_URL ?? DEFAULT_API_BASE,
  fetchImpl = fetch,
} = {}) {
  if (!token) return [];
  try {
    const res = await fetchImpl(`${apiBase}/auth.test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const header = res.headers?.get?.('x-oauth-scopes') ?? '';
    return header.split(',').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Annotate the capability map for a given set of granted scopes. Each action gets
 * `available` (implemented AND all requiredScopes granted) + an `unavailableReason`.
 * Pure/synchronous — no network.
 */
export function resolveSlackCapabilities(grantedScopes = []) {
  const granted = new Set(grantedScopes);
  const actions = slackCapabilities.actions.map((a) => {
    const missing = (a.requiredScopes ?? []).filter((s) => !granted.has(s));
    let available = false;
    let unavailableReason = null;
    if (!a.implemented) unavailableReason = 'not yet implemented';
    else if (missing.length) unavailableReason = `token missing scope(s): ${missing.join(', ')}`;
    else available = true;
    return { ...a, available, unavailableReason };
  });
  return { connector: 'slack', grantedScopes: [...granted], actions };
}

/** AI-readable summary of what Slack functions are usable right now (for prompts). */
export function describeSlackForPrompt(resolved) {
  const lines = ['SLACK CAPABILITIES (only AVAILABLE actions actually work for this workspace)'];
  for (const a of resolved.actions) {
    const status = a.available ? 'available' : `unavailable (${a.unavailableReason})`;
    const cfg = (a.config ?? []).map((f) => `${f.key}${f.required ? '' : '?'}: ${f.type}`).join(', ');
    lines.push(`  - ${a.id} — ${a.label} [${status}]${cfg ? ` · config: { ${cfg} }` : ''}`);
  }
  lines.push('Do not propose UNAVAILABLE actions. If the user asks for one, say it is not enabled for this workspace.');
  return lines.join('\n');
}

/**
 * Per-tenant capability provider. A tenant's granted scopes come from its stored
 * OAuth install grant (the source of truth once a client authorizes the app);
 * falls back to a dev env bot token's scopes (via auth.test) when no grant exists.
 * Mounted on the spine so `/capabilities` and the converger share one view.
 * @param {{ oauthTokenStore?: object, token?: string, apiBase?: string, fetchImpl?: typeof fetch }} [opts]
 */
export function createSlackCapabilityProvider({ oauthTokenStore = null, token = undefined, apiBase = undefined, fetchImpl = undefined } = {}) {
  const cache = new Map(); // tenantId -> resolved capabilities

  async function scopesForTenant(tenantId) {
    if (oauthTokenStore && tenantId) {
      const grant = getSlackGrant({ oauthTokenStore, tenantId });
      if (grant) return grant.scopes;            // installed app grant (preferred)
    }
    const envToken = token ?? process.env.SLACK_BOT_TOKEN;
    if (envToken) return detectGrantedScopes({ token: envToken, apiBase, fetchImpl }); // dev fallback
    return [];
  }

  async function resolveForTenant(tenantId) {
    if (cache.has(tenantId)) return cache.get(tenantId);
    const resolved = resolveSlackCapabilities(await scopesForTenant(tenantId));
    cache.set(tenantId, resolved);
    return resolved;
  }

  return {
    resolveForTenant,
    async describe(tenantId) { return describeSlackForPrompt(await resolveForTenant(tenantId)); },
    /** Drop cached scopes for a tenant (after re-install) or all tenants. */
    refresh(tenantId) { if (tenantId) cache.delete(tenantId); else cache.clear(); },
  };
}

/**
 * Register the Slack delivery channel on a ChannelRegistry.
 * @param {import('../../workflows/channel-registry.js').ChannelRegistry} registry
 * @param {{ fetchImpl?: typeof fetch }} [opts] — injectable fetch (tests/stub)
 */
export function registerSlackChannel(registry, { fetchImpl = fetch } = {}) {
  const ready = () => isOAuthConfigured() || !!process.env.SLACK_BOT_TOKEN;

  // Shared helper — resolves the token, builds a typed Slack API caller.
  function makeApi(config) {
    const token = config.token ?? process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('slack: no token — this tenant has not connected Slack');
    const apiBase = process.env.SLACK_API_URL ?? DEFAULT_API_BASE;
    return async function api(method, payload) {
      const r = await fetchImpl(`${apiBase}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
      let d; try { d = await r.json(); } catch { d = { ok: false, error: 'invalid_json_response' }; }
      if (!d.ok) throw new Error(`slack ${method} failed: ${d.error ?? `HTTP ${r.status}`}`);
      return d;
    };
  }

  // Resolve a user arg (Slack ID or email) to a Slack user ID.
  async function resolveUser(api, user) {
    if (!user) throw new Error('slack: user (ID or email) is required');
    if (!user.includes('@')) return user;
    const r = await api('users.lookupByEmail', { email: user });
    if (!r.user?.id) throw new Error(`slack: could not resolve email "${user}" to a Slack user ID`);
    return r.user.id;
  }

  // ── post_message ───────────────────────────────────────────────────────────
  registry.register({
    id: 'slack', name: 'Slack', icon: 'slack',
    description: 'Posts a message to a Slack channel.',
    configSchema: [
      { key: 'target',     label: 'Channel',      type: 'string',   optional: false },
      { key: 'body',       label: 'Message',       type: 'textarea', optional: true  },
      { key: 'username',   label: 'Bot name',      type: 'string',   optional: true  },
      { key: 'icon_emoji', label: 'Bot icon emoji',type: 'string',   optional: true  },
    ],
    isReady: ready,
    deliver: async ({ config, body, title }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack: config.target (channel) is required');
      const text = title ? `*${title}*\n${body}` : body;
      const payload = { channel: config.target, text };
      if (config.username)   payload.username   = config.username;
      if (config.icon_emoji) payload.icon_emoji = config.icon_emoji;
      const d = await api('chat.postMessage', payload);
      return { delivered: true, channel: 'slack', target: config.target, ts: d.ts, slackChannel: d.channel ?? config.target };
    },
  });

  // ── post_dm ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_dm', name: 'Slack DM', icon: 'slack',
    description: 'Sends a direct message to a user (by Slack user ID or email).',
    configSchema: [
      { key: 'user', label: 'User (ID or email)', type: 'string',   optional: false },
      { key: 'body', label: 'Message',            type: 'textarea', optional: true  },
    ],
    isReady: ready,
    deliver: async ({ config, body, title }) => {
      const api = makeApi(config);
      const userId = await resolveUser(api, config.user);
      const conv = await api('conversations.open', { users: userId });
      const dmChannel = conv.channel?.id;
      if (!dmChannel) throw new Error('slack_dm: conversations.open did not return a channel');
      const text = title ? `*${title}*\n${body}` : body;
      const d = await api('chat.postMessage', { channel: dmChannel, text });
      return { delivered: true, channel: 'slack_dm', target: userId, ts: d.ts, slackChannel: dmChannel };
    },
  });

  // ── reply_in_thread ────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_reply', name: 'Slack Thread Reply', icon: 'slack',
    description: 'Posts a threaded reply under an existing message.',
    configSchema: [
      { key: 'target',    label: 'Channel',          type: 'string',   optional: false },
      { key: 'thread_ts', label: 'Parent message ts', type: 'string',   optional: false },
      { key: 'body',      label: 'Reply text',        type: 'textarea', optional: true  },
    ],
    isReady: ready,
    deliver: async ({ config, body, title }) => {
      const api = makeApi(config);
      if (!config.target)    throw new Error('slack_reply: target channel is required');
      if (!config.thread_ts) throw new Error('slack_reply: thread_ts is required');
      const text = title ? `*${title}*\n${body}` : body;
      const d = await api('chat.postMessage', { channel: config.target, thread_ts: config.thread_ts, text });
      return { delivered: true, channel: 'slack_reply', target: config.target, ts: d.ts };
    },
  });

  // ── add_reaction ───────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_reaction', name: 'Slack Reaction', icon: 'slack',
    description: 'Adds an emoji reaction to a message.',
    configSchema: [
      { key: 'target',    label: 'Channel',    type: 'string', optional: false },
      { key: 'timestamp', label: 'Message ts', type: 'string', optional: false },
      { key: 'emoji',     label: 'Emoji name', type: 'string', optional: false, hint: 'Without colons, e.g. white_check_mark' },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target || !config.timestamp || !config.emoji) throw new Error('slack_reaction: target, timestamp, and emoji are required');
      await api('reactions.add', { channel: config.target, timestamp: config.timestamp, name: config.emoji });
      return { delivered: true, channel: 'slack_reaction' };
    },
  });

  // ── upload_file ────────────────────────────────────────────────────────────
  // Slack's current upload API: getUploadURLExternal → upload → completeUploadExternal
  registry.register({
    id: 'slack_file', name: 'Slack File Upload', icon: 'slack',
    description: 'Uploads text content as a file or snippet to a channel.',
    configSchema: [
      { key: 'target',   label: 'Channel',   type: 'string',   optional: false },
      { key: 'content',  label: 'Content',   type: 'textarea', optional: false },
      { key: 'title',    label: 'Title',     type: 'string',   optional: true  },
      { key: 'filename', label: 'Filename',  type: 'string',   optional: true, hint: 'e.g. report.txt' },
    ],
    isReady: ready,
    deliver: async ({ config, body }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack_file: target channel is required');
      const content = config.content ?? body ?? '';
      const filename = config.filename ?? 'output.txt';
      const title = config.title ?? filename;
      const length = Buffer.byteLength(content, 'utf8');
      // Step 1: get an upload URL
      const urlRes = await api('files.getUploadURLExternal', { filename, length });
      const uploadUrl = urlRes.upload_url;
      const fileId = urlRes.file_id;
      // Step 2: upload the content directly
      await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: content,
      });
      // Step 3: complete and share to the channel
      await api('files.completeUploadExternal', { files: [{ id: fileId, title }], channel_id: config.target });
      return { delivered: true, channel: 'slack_file', target: config.target, fileId };
    },
  });

  // ── create_channel ─────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_create_channel', name: 'Slack Create Channel', icon: 'slack',
    description: 'Creates a new public or private Slack channel.',
    configSchema: [
      { key: 'name',       label: 'Channel name', type: 'string',  optional: false, hint: 'Lowercase, no spaces' },
      { key: 'is_private', label: 'Private',      type: 'boolean', optional: true  },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.name) throw new Error('slack_create_channel: name is required');
      const d = await api('conversations.create', { name: config.name, is_private: !!config.is_private });
      return { delivered: true, channel: 'slack_create_channel', channelId: d.channel?.id, name: d.channel?.name };
    },
  });

  // ── invite_to_channel ──────────────────────────────────────────────────────
  registry.register({
    id: 'slack_invite', name: 'Slack Invite to Channel', icon: 'slack',
    description: 'Invites one or more users to a channel.',
    configSchema: [
      { key: 'target', label: 'Channel',                      type: 'string', optional: false },
      { key: 'users',  label: 'User IDs (comma-separated)',   type: 'string', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target || !config.users) throw new Error('slack_invite: target and users are required');
      await api('conversations.invite', { channel: config.target, users: config.users });
      return { delivered: true, channel: 'slack_invite', target: config.target };
    },
  });

  // ── set_channel_topic ──────────────────────────────────────────────────────
  registry.register({
    id: 'slack_topic', name: 'Slack Set Topic', icon: 'slack',
    description: 'Sets the topic of a Slack channel.',
    configSchema: [
      { key: 'target', label: 'Channel', type: 'string',   optional: false },
      { key: 'topic',  label: 'Topic',   type: 'textarea', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config, body }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack_topic: target channel is required');
      const topic = config.topic ?? body;
      if (!topic) throw new Error('slack_topic: topic text is required');
      await api('conversations.setTopic', { channel: config.target, topic });
      return { delivered: true, channel: 'slack_topic', target: config.target };
    },
  });

  // ── pin_message ────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_pin', name: 'Slack Pin Message', icon: 'slack',
    description: 'Pins a message in a channel.',
    configSchema: [
      { key: 'target',    label: 'Channel',    type: 'string', optional: false },
      { key: 'timestamp', label: 'Message ts', type: 'string', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target || !config.timestamp) throw new Error('slack_pin: target and timestamp are required');
      await api('pins.add', { channel: config.target, timestamp: config.timestamp });
      return { delivered: true, channel: 'slack_pin', target: config.target };
    },
  });

  // ── set_reminder ───────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_reminder', name: 'Slack Set Reminder', icon: 'slack',
    description: 'Creates a reminder for a user or the bot.',
    configSchema: [
      { key: 'text', label: 'Reminder text', type: 'textarea', optional: false },
      { key: 'time', label: 'When',          type: 'string',   optional: false, hint: 'Unix timestamp or natural language e.g. "in 30 minutes"' },
      { key: 'user', label: 'User ID',       type: 'string',   optional: true,  hint: 'Omit to remind the bot itself' },
    ],
    isReady: ready,
    deliver: async ({ config, body }) => {
      const api = makeApi(config);
      const text = config.text ?? body;
      if (!text || !config.time) throw new Error('slack_reminder: text and time are required');
      const payload = { text, time: config.time };
      if (config.user) payload.user = config.user;
      const d = await api('reminders.add', payload);
      return { delivered: true, channel: 'slack_reminder', reminderId: d.reminder?.id };
    },
  });

  // ── lookup_user ────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_lookup_user', name: 'Slack Lookup User', icon: 'slack',
    description: 'Resolves a Slack user ID and display name from an email address.',
    configSchema: [
      { key: 'email', label: 'Email address', type: 'string', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.email) throw new Error('slack_lookup_user: email is required');
      const d = await api('users.lookupByEmail', { email: config.email });
      return { delivered: true, channel: 'slack_lookup_user', userId: d.user?.id, displayName: d.user?.real_name ?? d.user?.name };
    },
  });

  // ── search_messages ────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_search', name: 'Slack Search Messages', icon: 'slack',
    description: 'Searches messages across the workspace.',
    configSchema: [
      { key: 'query', label: 'Search query', type: 'string', optional: false, hint: 'Supports modifiers: in:#channel from:@user' },
      { key: 'limit', label: 'Max results',  type: 'number', optional: true  },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.query) throw new Error('slack_search: query is required');
      const d = await api('search.messages', { query: config.query, count: config.limit ?? 10 });
      const messages = (d.messages?.matches ?? []).map((m) => ({ ts: m.ts, channel: m.channel?.name, text: m.text, permalink: m.permalink }));
      return { delivered: true, channel: 'slack_search', messages };
    },
  });

  // ── get_channel_history ────────────────────────────────────────────────────
  registry.register({
    id: 'slack_history', name: 'Slack Channel History', icon: 'slack',
    description: 'Fetches recent messages from a channel (useful for digest or summarization workflows).',
    configSchema: [
      { key: 'target', label: 'Channel',           type: 'string', optional: false },
      { key: 'limit',  label: 'Message count',     type: 'number', optional: true, hint: 'Default 20, max 100' },
      { key: 'oldest', label: 'After (unix ts)',   type: 'string', optional: true  },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack_history: target channel is required');
      const payload = { channel: config.target, limit: config.limit ?? 20 };
      if (config.oldest) payload.oldest = config.oldest;
      const d = await api('conversations.history', payload);
      const messages = (d.messages ?? []).map((m) => ({ ts: m.ts, text: m.text, user: m.user }));
      return { delivered: true, channel: 'slack_history', target: config.target, messages };
    },
  });

  // ── post_group_dm ──────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_group_dm', name: 'Slack Group DM', icon: 'slack',
    description: 'Opens a multi-person DM (2–8 people) and sends a message.',
    configSchema: [
      { key: 'users', label: 'User IDs (comma-separated)', type: 'string',   optional: false, hint: 'Slack user IDs, 2–8 people' },
      { key: 'body',  label: 'Message',                    type: 'textarea', optional: true  },
    ],
    isReady: ready,
    deliver: async ({ config, body, title }) => {
      const api = makeApi(config);
      if (!config.users) throw new Error('slack_group_dm: users is required');
      const conv = await api('conversations.open', { users: config.users });
      const channel = conv.channel?.id;
      if (!channel) throw new Error('slack_group_dm: conversations.open did not return a channel');
      const text = title ? `*${title}*\n${body}` : body;
      const d = await api('chat.postMessage', { channel, text });
      return { delivered: true, channel: 'slack_group_dm', ts: d.ts, slackChannel: channel };
    },
  });

  return registry;
}

export default registerSlackChannel;
