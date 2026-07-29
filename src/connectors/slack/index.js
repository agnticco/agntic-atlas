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

// Bridge the two id namespaces: capabilities.json action id → executable channel
// id (what the connector-action/deliver nodes route to). Most follow `slack_<id>`;
// a handful are irregular. Used to project the connector's scope-aware action
// availability (resolveSlackCapabilities) onto the channel catalog so the builder
// only ever offers actions THIS tenant's granted scopes can actually run.
// Only the IRREGULAR pairs are listed; everything else is `slack_<capId>`.
const CAP_TO_CHANNEL = {
  post_message: 'slack', post_dm: 'slack_dm', reply_in_thread: 'slack_reply',
  add_reaction: 'slack_reaction', upload_file: 'slack_file', invite_to_channel: 'slack_invite',
  set_channel_topic: 'slack_topic', pin_message: 'slack_pin', set_reminder: 'slack_reminder',
  search_messages: 'slack_search', get_channel_history: 'slack_history',
  post_group_dm: 'slack_group_dm', send_dm_as_user: 'slack_dm_as_user',
};
export function channelIdForCapability(capId) {
  return CAP_TO_CHANNEL[capId] ?? `slack_${capId}`;
}

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
export function resolveSlackCapabilities(grantedScopes = [], { hasUserToken = false } = {}) {
  const granted = new Set(grantedScopes);
  const actions = slackCapabilities.actions.map((a) => {
    const needsUser = a.tokenType === 'user';
    const missing = (a.requiredScopes ?? []).filter((s) => !granted.has(s));
    let available = false;
    let unavailableReason = null;
    if (!a.implemented) unavailableReason = 'not yet implemented';
    else if (needsUser && !hasUserToken) unavailableReason = 'requires user OAuth token (user OAuth coming soon)';
    else if (!needsUser && missing.length) unavailableReason = `bot token missing scope(s): ${missing.join(', ')}`;
    else available = true;
    return { ...a, available, unavailableReason };
  });
  return { connector: 'slack', grantedScopes: [...granted], hasUserToken, actions };
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
 * Per-tenant capability provider. A tenant's granted scopes come ONLY from its
 * own stored OAuth install grant — the dev env bot token never leaks across
 * tenants (hard isolation). The env token serves a context only when there is no
 * tenant (headless tools/gates) OR for one explicitly-designated dev tenant
 * (SLACK_DEV_TENANT). Mounted on the spine so `/capabilities` and the converger
 * share one view.
 * @param {{ oauthTokenStore?: object, token?: string, apiBase?: string, fetchImpl?: typeof fetch }} [opts]
 */
export function createSlackCapabilityProvider({ oauthTokenStore = null, token = undefined, apiBase = undefined, fetchImpl = undefined } = {}) {
  const cache = new Map(); // tenantId -> resolved capabilities

  // The env bot token may stand in for a tenant only when no tenant is given
  // (headless) or the tenant is the explicitly designated dev tenant. Never for
  // an arbitrary client tenant.
  const envTokenServes = (tenantId) => !tenantId || tenantId === process.env.SLACK_DEV_TENANT;

  async function scopesForTenant(tenantId) {
    if (oauthTokenStore && tenantId) {
      const grant = getSlackGrant({ oauthTokenStore, tenantId });
      if (grant) return grant.scopes;            // the tenant's OWN install grant
    }
    if (!envTokenServes(tenantId)) return [];    // fail-closed: no cross-tenant dev token
    const envToken = token ?? process.env.SLACK_BOT_TOKEN;
    if (envToken) return detectGrantedScopes({ token: envToken, apiBase, fetchImpl });
    return [];
  }

  async function resolveForTenant(tenantId) {
    if (cache.has(tenantId)) return cache.get(tenantId);
    // User-token (xoxp) actions require PER-USER OAuth, which isn't built yet. A
    // shared env user token would run "as user" as the same person for everyone —
    // a user-isolation leak — so it only counts for the dev tenant / headless.
    const hasUserToken = !!(process.env.SLACK_USER_TOKEN) && envTokenServes(tenantId);
    const connected = !!(
      (oauthTokenStore && tenantId && getSlackGrant({ oauthTokenStore, tenantId })) ||
      (envTokenServes(tenantId) && (token ?? process.env.SLACK_BOT_TOKEN))
    );
    const resolved = { connected, ...resolveSlackCapabilities(await scopesForTenant(tenantId), { hasUserToken }) };
    cache.set(tenantId, resolved);
    return resolved;
  }

  /**
   * WHO IS THE OPERATOR *IN SLACK*?
   *
   * Their Atlas login and their Slack account are two different identities, and
   * assuming they are the same builds a workflow that can never deliver. WITNESSED
   * ON PROD, 2026-07-29: the converger was told "when they say DM me, use
   * { channel:'slack_dm', user:'<their Atlas email>' }", so an approval workflow
   * addressed its Slack DM to `hello@agntic.co`. The workspace has four members and
   * exactly one email — `charles@agntic.co`. Every run failed the same way ("no
   * Slack user matches"), which is what the probe was correctly reporting, and it
   * blocked two approval builds from ever verifying.
   *
   * EXACT MATCH OR NOTHING. If the login email names no Slack member we do NOT pick
   * the nearest one: a wrong guess here DMs someone else the operator's drafts and
   * approvals. Unresolved returns the members we CAN see so the converger can ask
   * which of them to use — the same "reason from live connector state, then ask"
   * that the rest of the interview does — instead of inventing an address.
   *
   * Read-only, best-effort: any failure yields `{ resolved:false, candidates:[] }`
   * and the build proceeds exactly as before.
   *
   * @returns {Promise<{resolved: boolean, userId: string|null, email: string|null,
   *                    name: string|null, candidates: Array<{email,name}>}>}
   */
  async function resolveOperatorSlackIdentity(tenantId, loginEmail, { botToken = null } = {}) {
    const miss = { resolved: false, userId: null, email: null, name: null, candidates: [] };
    try {
      const resolved = await resolveForTenant(tenantId);
      if (!resolved?.connected) return miss;
      // The caller supplies the token: decrypting a tenant's stored grant needs the
      // cipher, which lives with auth, not here. The env token still stands in under
      // exactly the same isolation rule as `scopesForTenant`.
      const tok = botToken ?? (envTokenServes(tenantId) ? (token ?? process.env.SLACK_BOT_TOKEN) : null);
      if (!tok) return miss;
      const api = makeSlackApi({ token: tok }, fetchImpl ?? fetch);
      const members = await listMembers(api);
      const usable = members
        .filter(u => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT' && u.profile?.email)
        .map(u => ({ id: u.id, email: u.profile.email, name: u.profile?.real_name ?? u.name ?? null }));
      const want = String(loginEmail ?? '').trim().toLowerCase();
      const hit  = want ? usable.find(u => u.email.toLowerCase() === want) : null;
      if (hit) return { resolved: true, userId: hit.id, email: hit.email, name: hit.name, candidates: [] };
      // Bounded: this goes into a prompt, and a 500-person workspace must not.
      return { ...miss, candidates: usable.slice(0, 8).map(({ email, name }) => ({ email, name })) };
    } catch { return miss; }
  }

  return {
    resolveForTenant,
    resolveOperatorSlackIdentity,
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

/**
 * ── Slack target resolution lives HERE, once ────────────────────────────────
 *
 * These were private to `registerSlackChannel`, so the APPROVAL path in
 * server.js (`postSlack`) had no way to reach them and passed its target
 * straight to `chat.postMessage`. Slack accepts a channel id, a user id or
 * `#name` there — never an EMAIL. So an approval asked over
 * `slack: charles@agntic.co` failed with `channel_not_found` at run time, while
 * the identical email worked for a `slack_dm` DELIVERY, which does resolve it.
 * A human node whose ask never arrives is a workflow that pauses forever.
 *
 * Lifted to module scope unchanged (a pure move) and exported so both paths
 * share ONE definition. A second copy would drift, and the day it drifts is the
 * day an approval reaches nobody.
 */
// Shared helper — resolves the token, builds typed Slack API callers.
// postApi: for methods that accept JSON body (most write APIs).
// getApi:  for methods that require query-string params (reactions.get, pins.list,
//          files.getUploadURLExternal, etc.) — Slack's read APIs often use GET.
export function makeSlackApi(config, fetchImpl = fetch) {
  const token = config.token ?? process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('slack: no token — this tenant has not connected Slack');
  const apiBase = process.env.SLACK_API_URL ?? DEFAULT_API_BASE;

  async function call(method, payload, useGet = false) {
    let url = `${apiBase}/${method}`;
    const opts = { headers: { authorization: `Bearer ${token}` } };
    if (useGet) {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(payload ?? {}).filter(([, v]) => v !== undefined && v !== null))
      ).toString();
      if (qs) url += `?${qs}`;
      opts.method = 'GET';
    } else {
      opts.method = 'POST';
      opts.headers['content-type'] = 'application/json; charset=utf-8';
      opts.body = JSON.stringify(payload);
    }
    const r = await fetchImpl(url, opts);
    let d; try { d = await r.json(); } catch { d = { ok: false, error: 'invalid_json_response' }; }
    if (!d.ok) throw new Error(`slack ${method} failed: ${d.error ?? `HTTP ${r.status}`}`);
    return d;
  }

  const api = (method, payload) => call(method, payload, false);
  api.get = (method, payload) => call(method, payload, true);
  return api;
}

// User-token API helper: uses SLACK_USER_TOKEN (xoxp-) instead of the bot token.
function makeUserApi(config, fetchImpl = fetch) {
  const token = config.token ?? process.env.SLACK_USER_TOKEN;
  if (!token) throw new Error('slack: this action requires a user OAuth token (xoxp-) — set SLACK_USER_TOKEN or wire per-user OAuth');
  return makeSlackApi({ ...config, token }, fetchImpl);
}

// Resolve a channel arg (#name or ID) to a Slack channel ID.
// Most Slack APIs require an ID; chat.postMessage is the exception that accepts #name.
export async function resolveChannel(api, target) {
  if (!target) throw new Error('slack: channel target is required');
  if (/^[CGDW][A-Z0-9]+$/i.test(target)) return target; // already an ID
  const name = target.startsWith('#') ? target.slice(1) : target;
  const d = await api('conversations.list', { exclude_archived: true, limit: 200, types: 'public_channel,private_channel' });
  const ch = (d.channels ?? []).find((c) => c.name === name || c.name_normalized === name);
  if (!ch) throw new Error(`slack: channel "${target}" not found — pass a channel ID (C…) or verify the name`);
  return ch.id;
}

// Resolve a user arg (Slack ID or email) to a Slack user ID.
// Uses users.list scan — users.lookupByEmail is unreliable (invalid_arguments even
// with valid emails and users:read.email scope).
/**
 * Every member, not just the first page.
 *
 * `users.list` is cursor-paginated and every call here asked for `limit: 200` and
 * read `d.members` once. In a workspace with more than 200 people that silently
 * resolves nobody past the first page — the lookup does not error, it just reports
 * "no user found", which is indistinguishable from the address being wrong. Bounded
 * at 10 pages so a pathological workspace cannot stall a build.
 */
export async function listMembers(api, { maxPages = 10 } = {}) {
  const out = [];
  let cursor;
  for (let i = 0; i < maxPages; i += 1) {
    const d = await api.get('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...(d.members ?? []));
    cursor = d.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  return out;
}

// Resolve a user arg (Slack ID or email) to a Slack user ID.
// Uses users.list scan — users.lookupByEmail is unreliable (invalid_arguments even
// with valid emails and users:read.email scope).
export async function resolveUser(api, user) {
  if (!user) throw new Error('slack: user (ID or email) is required');
  if (!user.includes('@')) return user;
  const target = user.toLowerCase().trim();
  const members = await listMembers(api);
  const match = members.find((u) =>
    !u.deleted && (u.profile?.email?.toLowerCase() === target || u.name?.toLowerCase() === target)
  );
  if (!match) throw new Error(`slack: no user found with email "${user}"`);
  return match.id;
}


export function registerSlackChannel(registry, { fetchImpl = fetch } = {}) {
  // Bind the module-scope helpers to THIS registration's fetch, so an injected
  // test double is still honoured after the lift to module scope.
  const makeApi     = (config) => makeSlackApi(config, fetchImpl);
  const makeUserApiL = (config) => makeUserApi(config, fetchImpl);
  const ready = () => isOAuthConfigured() || !!process.env.SLACK_BOT_TOKEN;
  // User-token actions require an xoxp- token (per-user OAuth). Ready when SLACK_USER_TOKEN
  // is set. Per-user OAuth wiring lands in a later phase; for now, set via env for testing.
  const userReady = () => !!process.env.SLACK_USER_TOKEN;

  // ── post_message ───────────────────────────────────────────────────────────
  registry.register({
    id: 'slack', name: 'Slack', icon: 'slack',
    description: 'Posts a message to a Slack channel.',
    outputFormat: 'mrkdwn',
    configSchema: [
      { key: 'target',     label: 'Channel',      type: 'string',   optional: false },
      { key: 'body',       label: 'Message',       type: 'textarea', optional: true  },
      { key: 'username',   label: 'Bot name',      type: 'string',   optional: true  },
      { key: 'icon_emoji', label: 'Bot icon emoji',type: 'string',   optional: true  },
    ],
    isReady: ready,
    // Non-destructive reachability read for the dry-run test: does the channel exist?
    // (`chat.postMessage`'s #1 real failure is channel_not_found.) A read, never a send.
    // resolveChannel THROWS both when the channel definitively doesn't exist AND on a
    // transient API/auth error — only the first should fail the test. A definitive
    // "not found" returns reachable:false (blocks); anything else RE-THROWS so the
    // dry path marks reachability inconclusive rather than failing a valid workflow.
    probe: async ({ config }) => {
      try {
        await resolveChannel(makeApi(config), config.target);
        return { reachable: true };
      } catch (e) {
        if (/not[ _]found/i.test(e.message))
          return { reachable: false, reason: `the Slack channel "${config.target}" wasn't found` };
        throw e;   // transient — let the dry path treat it as inconclusive
      }
    },
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
    description: 'Sends a Slack direct message to any user by email or Slack user ID. Use the logged-in user\'s email when they say "send me", "DM me", or "message me".',
    outputFormat: 'mrkdwn',
    configSchema: [
      { key: 'user', label: 'User (email or Slack ID)', type: 'string',   optional: false, hint: 'Email address or Slack user ID. Use the logged-in user\'s email for "send me" requests.' },
      { key: 'body', label: 'Message',                  type: 'textarea', optional: true  },
    ],
    isReady: ready,
    // Non-destructive reachability read: does the Slack user exist? A read, never a send.
    // Same contract as the channel probe: a definitive "no such user" blocks; a
    // transient error re-throws and is treated as inconclusive by the dry path.
    probe: async ({ config }) => {
      try {
        await resolveUser(makeApi(config), config.user);
        return { reachable: true };
      } catch (e) {
        if (/no user found|not[ _]found/i.test(e.message))
          return { reachable: false, reason: `no Slack user matches "${config.user}"` };
        throw e;   // transient — inconclusive, don't fail a valid workflow
      }
    },
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
    outputFormat: 'mrkdwn',
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
      const channelId = await resolveChannel(api, config.target);
      const text = title ? `*${title}*\n${body}` : body;
      const d = await api('chat.postMessage', { channel: channelId, thread_ts: config.thread_ts, text });
      return { delivered: true, channel: 'slack_reply', target: channelId, ts: d.ts };
    },
  });

  // ── add_reaction ───────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_reaction', name: 'Slack Reaction', icon: 'slack', actionOnly: true,
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
      const channelId = await resolveChannel(api, config.target);
      await api('reactions.add', { channel: channelId, timestamp: config.timestamp, name: config.emoji });
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
      { key: 'content',  label: 'Content',   type: 'textarea', optional: true,  hint: 'Defaults to the previous step\'s output.' },
      { key: 'title',    label: 'Title',     type: 'string',   optional: true  },
      { key: 'filename', label: 'Filename',  type: 'string',   optional: true, hint: 'e.g. report.txt' },
    ],
    isReady: ready,
    deliver: async ({ config, body }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack_file: target channel is required');
      const channelId = await resolveChannel(api, config.target);
      const content = config.content ?? body ?? '';
      const filename = config.filename ?? 'output.txt';
      const title = config.title ?? filename;
      const length = Buffer.byteLength(content, 'utf8');
      // Step 1: get an upload URL — Slack's v2 upload API uses GET with query params
      const urlRes = await api.get('files.getUploadURLExternal', { filename, length });
      const uploadUrl = urlRes.upload_url;
      const fileId = urlRes.file_id;
      // Step 2: upload the content directly
      await fetchImpl(uploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: content,
      });
      // Step 3: complete and share to the channel
      await api('files.completeUploadExternal', { files: [{ id: fileId, title }], channel_id: channelId });
      return { delivered: true, channel: 'slack_file', target: channelId, fileId };
    },
  });

  // ── create_channel ─────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_create_channel', name: 'Slack Create Channel', icon: 'slack', actionOnly: true,
    // Same trait as adding a column: a channel is something the workflow needs to
    // EXIST, not work it repeats on every run.
    oneTimeSetup: true,
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
      const channelId = d.channel?.id;
      // S8-6: conversations.create only joins the bot, so the channel is invisible to
      // the operator. Invite them (by email) so it shows up in their sidebar and they
      // can see anything the workflow posts. Non-fatal — the channel exists either way.
      let invited = false;
      if (channelId && config._operatorEmail) {
        try {
          const u = await api.get('users.lookupByEmail', { email: config._operatorEmail });
          const userId = u.user?.id;
          if (userId) { await api('conversations.invite', { channel: channelId, users: userId }); invited = true; }
        } catch { /* invite is best-effort; channel is still created */ }
      }
      return { delivered: true, channel: 'slack_create_channel', channelId, name: d.channel?.name, invitedOperator: invited };
    },
  });

  // ── invite_to_channel ──────────────────────────────────────────────────────
  registry.register({
    id: 'slack_invite', name: 'Slack Invite to Channel', icon: 'slack', actionOnly: true,
    description: 'Invites one or more users to a channel.',
    configSchema: [
      { key: 'target', label: 'Channel',                      type: 'string', optional: false },
      { key: 'users',  label: 'User IDs (comma-separated)',   type: 'string', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target || !config.users) throw new Error('slack_invite: target and users are required');
      const channelId = await resolveChannel(api, config.target);
      await api('conversations.invite', { channel: channelId, users: config.users });
      return { delivered: true, channel: 'slack_invite', target: channelId };
    },
  });

  // ── set_channel_topic ──────────────────────────────────────────────────────
  registry.register({
    id: 'slack_topic', name: 'Slack Set Topic', icon: 'slack', actionOnly: true,
    description: 'Sets the topic of a Slack channel.',
    configSchema: [
      { key: 'target', label: 'Channel', type: 'string',   optional: false },
      { key: 'topic',  label: 'Topic',   type: 'textarea', optional: true,  hint: 'Defaults to the previous step\'s output.' },
    ],
    isReady: ready,
    deliver: async ({ config, body }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack_topic: target channel is required');
      const channelId = await resolveChannel(api, config.target);
      const topic = config.topic ?? body;
      if (!topic) throw new Error('slack_topic: topic text is required');
      await api('conversations.setTopic', { channel: channelId, topic });
      return { delivered: true, channel: 'slack_topic', target: channelId };
    },
  });

  // ── pin_message ────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_pin', name: 'Slack Pin Message', icon: 'slack', actionOnly: true,
    description: 'Pins a message in a channel.',
    configSchema: [
      { key: 'target',    label: 'Channel',    type: 'string', optional: false },
      { key: 'timestamp', label: 'Message ts', type: 'string', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target || !config.timestamp) throw new Error('slack_pin: target and timestamp are required');
      const channelId = await resolveChannel(api, config.target);
      await api('pins.add', { channel: channelId, timestamp: config.timestamp });
      return { delivered: true, channel: 'slack_pin', target: channelId };
    },
  });

  // ── set_reminder ───────────────────────────────────────────────────────────
  // NOTE: reminders.add requires a USER token (xoxp-), not a bot token. This
  // channel is registered so the AI knows it exists but is unavailable until
  // per-user OAuth tokens are added in a later phase.
  registry.register({
    id: 'slack_reminder', name: 'Slack Set Reminder', icon: 'slack', actionOnly: true,
    description: 'Creates a reminder for a user. NOTE: requires a user OAuth token — not available with a bot token alone.',
    configSchema: [
      { key: 'text', label: 'Reminder text', type: 'textarea', optional: true,  hint: 'Defaults to the previous step\'s output.' },
      { key: 'time', label: 'When',          type: 'string',   optional: false, hint: 'Unix timestamp or natural language e.g. "in 30 minutes"' },
      { key: 'user', label: 'User ID',       type: 'string',   optional: true  },
    ],
    isReady: () => false, // requires user token, not bot token
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
    id: 'slack_lookup_user', name: 'Slack Lookup User', icon: 'slack', actionOnly: true,
    description: 'Resolves a Slack user ID and display name from an email address.',
    configSchema: [
      { key: 'email', label: 'Email address', type: 'string', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.email) throw new Error('slack_lookup_user: email is required');
      const target = config.email.toLowerCase().trim();
      // users.lookupByEmail has undocumented Slack API requirements that make it
      // unreliable even with confirmed emails + users:read.email scope. Scan
      // users.list instead — same net result, always works with the bot token.
      const d = await api.get('users.list', { limit: 200 });
      const match = (d.members ?? []).find((u) =>
        !u.deleted && (u.profile?.email?.toLowerCase() === target || u.name?.toLowerCase() === target)
      );
      if (!match) throw new Error(`slack_lookup_user: no user found with email "${config.email}"`);
      return { delivered: true, channel: 'slack_lookup_user', userId: match.id, displayName: match.real_name || match.name, email: match.profile?.email ?? null };
    },
  });

  // ── search_messages ────────────────────────────────────────────────────────
  // NOTE: search.messages requires a USER token (xoxp-), not a bot token.
  registry.register({
    id: 'slack_search', name: 'Slack Search Messages', icon: 'slack', actionOnly: true,
    description: 'Searches messages across the workspace. NOTE: requires a user OAuth token — not available with a bot token alone.',
    configSchema: [
      { key: 'query', label: 'Search query', type: 'string', optional: false, hint: 'Supports modifiers: in:#channel from:@user' },
      { key: 'limit', label: 'Max results',  type: 'number', optional: true  },
    ],
    isReady: () => false, // requires user token, not bot token
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
    id: 'slack_history', name: 'Slack Channel History', icon: 'slack', actionOnly: true,
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
      const channelId = await resolveChannel(api, config.target);
      const payload = { channel: channelId, limit: config.limit ?? 20 };
      if (config.oldest) payload.oldest = config.oldest;
      const d = await api('conversations.history', payload);
      const messages = (d.messages ?? []).map((m) => ({ ts: m.ts, text: m.text, user: m.user }));
      return { delivered: true, channel: 'slack_history', target: channelId, messages };
    },
  });

  // ── list_channels ─────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_list_channels', name: 'Slack List Channels', icon: 'slack', actionOnly: true,
    description: 'Lists all public (and joined private) channels in the workspace with their IDs and names. Useful for the AI to discover valid channel targets.',
    configSchema: [
      { key: 'limit',            label: 'Max channels',    type: 'number',  optional: true, hint: 'Default 200' },
      { key: 'exclude_archived', label: 'Exclude archived',type: 'boolean', optional: true, hint: 'Default true' },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      const d = await api('conversations.list', {
        exclude_archived: config.exclude_archived !== false,
        limit: config.limit ?? 200,
        types: 'public_channel,private_channel', // groups:read scope enables private channels
      });
      const channels = (d.channels ?? []).map((c) => ({ id: c.id, name: c.name, is_private: !!c.is_private, is_member: !!c.is_member }));
      return { delivered: true, channel: 'slack_list_channels', channels };
    },
  });

  // ── list_users ─────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_list_users', name: 'Slack List Users', icon: 'slack', actionOnly: true,
    description: 'Lists workspace members with their IDs, names, and emails. Useful for the AI to discover user IDs for DMs or lookups.',
    configSchema: [
      { key: 'limit', label: 'Max users', type: 'number', optional: true, hint: 'Default 200' },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      const d = await api.get('users.list', { limit: config.limit ?? 200 });
      const users = (d.members ?? [])
        .filter((u) => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT')
        .map((u) => ({ id: u.id, name: u.real_name || u.name, email: u.profile?.email ?? null, display_name: u.profile?.display_name ?? u.name }));
      return { delivered: true, channel: 'slack_list_users', users };
    },
  });

  // ── join_channel ──────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_join_channel', name: 'Slack Join Channel', icon: 'slack', actionOnly: true,
    description: 'Join a public channel so the bot can post to it without chat:write.public.',
    configSchema: [{ key: 'target', label: 'Channel', type: 'string', optional: false }],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack_join_channel: target is required');
      const channelId = await resolveChannel(api, config.target);
      const d = await api('conversations.join', { channel: channelId });
      return { delivered: true, channel: 'slack_join_channel', channelId: d.channel?.id };
    },
  });

  // ── leave_channel ─────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_leave_channel', name: 'Slack Leave Channel', icon: 'slack', actionOnly: true,
    description: 'Remove the bot from a channel.',
    configSchema: [{ key: 'target', label: 'Channel', type: 'string', optional: false }],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack_leave_channel: target is required');
      const channelId = await resolveChannel(api, config.target);
      await api('conversations.leave', { channel: channelId });
      return { delivered: true, channel: 'slack_leave_channel', channelId };
    },
  });

  // ── remove_reaction ───────────────────────────────────────────────────────
  registry.register({
    id: 'slack_remove_reaction', name: 'Slack Remove Reaction', icon: 'slack', actionOnly: true,
    description: 'Remove an emoji reaction from a message.',
    configSchema: [
      { key: 'target',    label: 'Channel',    type: 'string', optional: false },
      { key: 'timestamp', label: 'Message ts', type: 'string', optional: false },
      { key: 'emoji',     label: 'Emoji name', type: 'string', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target || !config.timestamp || !config.emoji) throw new Error('slack_remove_reaction: target, timestamp, and emoji are required');
      const channelId = await resolveChannel(api, config.target);
      await api('reactions.remove', { channel: channelId, timestamp: config.timestamp, name: config.emoji });
      return { delivered: true, channel: 'slack_remove_reaction' };
    },
  });

  // ── get_reactions ─────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_get_reactions', name: 'Slack Get Reactions', icon: 'slack', actionOnly: true,
    description: 'Get all emoji reactions on a specific message.',
    configSchema: [
      { key: 'target',    label: 'Channel',    type: 'string', optional: false },
      { key: 'timestamp', label: 'Message ts', type: 'string', optional: false },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target || !config.timestamp) throw new Error('slack_get_reactions: target and timestamp are required');
      const channelId = await resolveChannel(api, config.target);
      const d = await api.get('reactions.get', { channel: channelId, timestamp: config.timestamp, full: true });
      const reactions = (d.message?.reactions ?? []).map((r) => ({ emoji: r.name, count: r.count, users: r.users ?? [] }));
      return { delivered: true, channel: 'slack_get_reactions', reactions };
    },
  });

  // ── list_pins ─────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_list_pins', name: 'Slack List Pins', icon: 'slack', actionOnly: true,
    description: 'List all pinned messages and files in a channel.',
    configSchema: [{ key: 'target', label: 'Channel', type: 'string', optional: false }],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.target) throw new Error('slack_list_pins: target is required');
      const channelId = await resolveChannel(api, config.target);
      const d = await api.get('pins.list', { channel: channelId });
      const pins = (d.items ?? []).map((i) => ({ type: i.type, ts: i.message?.ts ?? i.file?.id, text: i.message?.text ?? i.file?.name }));
      return { delivered: true, channel: 'slack_list_pins', target: channelId, pins };
    },
  });

  // ── get_user_profile ──────────────────────────────────────────────────────
  registry.register({
    id: 'slack_get_user_profile', name: 'Slack Get User Profile', icon: 'slack', actionOnly: true,
    description: 'Get detailed profile info for a user: title, phone, avatar, custom fields.',
    configSchema: [{ key: 'user', label: 'User ID', type: 'string', optional: false }],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.user) throw new Error('slack_get_user_profile: user is required');
      const d = await api.get('users.profile.get', { user: config.user });
      const p = d.profile ?? {};
      return { delivered: true, channel: 'slack_get_user_profile', userId: config.user, displayName: p.display_name, realName: p.real_name, title: p.title ?? null, phone: p.phone ?? null, email: p.email ?? null };
    },
  });

  // ── list_usergroups ───────────────────────────────────────────────────────
  registry.register({
    id: 'slack_list_usergroups', name: 'Slack List User Groups', icon: 'slack', actionOnly: true,
    description: 'List all user groups in the workspace.',
    configSchema: [
      { key: 'include_disabled', label: 'Include disabled', type: 'boolean', optional: true },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      const d = await api.get('usergroups.list', { include_disabled: !!config.include_disabled });
      const groups = (d.usergroups ?? []).map((g) => ({ id: g.id, handle: g.handle, name: g.name, count: g.user_count }));
      return { delivered: true, channel: 'slack_list_usergroups', groups };
    },
  });

  // ── get_workspace_info ────────────────────────────────────────────────────
  registry.register({
    id: 'slack_get_workspace_info', name: 'Slack Get Workspace Info', icon: 'slack', actionOnly: true,
    description: 'Get the workspace name, domain, and icon.',
    configSchema: [],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      const d = await api.get('team.info', {});
      const t = d.team ?? {};
      return { delivered: true, channel: 'slack_get_workspace_info', name: t.name, domain: t.domain, id: t.id };
    },
  });

  // ── list_files ────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_list_files', name: 'Slack List Files', icon: 'slack', actionOnly: true,
    description: 'List files shared in the workspace or a specific channel.',
    configSchema: [
      { key: 'target', label: 'Channel (optional)', type: 'string', optional: true },
      { key: 'limit',  label: 'Max results',        type: 'number', optional: true },
    ],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      const payload = { count: config.limit ?? 20 };
      if (config.target) payload.channel = await resolveChannel(api, config.target);
      const d = await api.get('files.list', payload);
      const files = (d.files ?? []).map((f) => ({ id: f.id, name: f.name, title: f.title, type: f.filetype, url: f.permalink }));
      return { delivered: true, channel: 'slack_list_files', files };
    },
  });

  // ── get_dnd_status ────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_get_dnd_status', name: 'Slack Get DND Status', icon: 'slack', actionOnly: true,
    description: "Check whether a user's Do Not Disturb is active (useful before sending a DM).",
    configSchema: [{ key: 'user', label: 'User ID', type: 'string', optional: false }],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      if (!config.user) throw new Error('slack_get_dnd_status: user is required');
      const d = await api.get('dnd.info', { user: config.user });
      return { delivered: true, channel: 'slack_get_dnd_status', userId: config.user, dndEnabled: !!d.dnd_enabled, nextStartTs: d.next_dnd_start_ts ?? null, nextEndTs: d.next_dnd_end_ts ?? null };
    },
  });

  // ── list_emoji ────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_list_emoji', name: 'Slack List Custom Emoji', icon: 'slack', actionOnly: true,
    description: 'List all custom emoji in the workspace (useful for picking valid reaction names).',
    configSchema: [],
    isReady: ready,
    deliver: async ({ config }) => {
      const api = makeApi(config);
      const d = await api.get('emoji.list', {});
      const emoji = Object.keys(d.emoji ?? {});
      return { delivered: true, channel: 'slack_list_emoji', emoji, count: emoji.length };
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

  // ══════════════════════════════════════════════════════════════════════════
  // USER TOKEN ACTIONS (xoxp-) — act on behalf of a user, not the bot.
  // These require SLACK_USER_TOKEN (or config.token with an xoxp- token).
  // Per-user OAuth wiring lands in a later phase; set SLACK_USER_TOKEN for dev.
  // Messages sent via these actions appear FROM the user, not from "Atlas Demo".
  // ══════════════════════════════════════════════════════════════════════════

  // ── send_as_user ───────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_send_as_user', name: 'Slack Send as User', icon: 'slack',
    description: 'Post a message as the authorized user (not the bot). Message appears in channels/DMs from the user\'s own account.',
    configSchema: [
      { key: 'target', label: 'Channel or DM', type: 'string',   optional: false, hint: 'Channel ID (C…) or #name' },
      { key: 'body',   label: 'Message',        type: 'textarea', optional: true },
    ],
    isReady: userReady,
    deliver: async ({ config, body, title }) => {
      const api = makeUserApiL(config);
      if (!config.target) throw new Error('slack_send_as_user: target is required');
      const channelId = await resolveChannel(api, config.target);
      const text = title ? `*${title}*\n${body}` : body;
      const d = await api('chat.postMessage', { channel: channelId, text });
      return { delivered: true, channel: 'slack_send_as_user', target: channelId, ts: d.ts };
    },
  });

  // ── send_dm_as_user ────────────────────────────────────────────────────────
  // This is the one that appears under "Direct Messages" (not "Apps") in Slack.
  registry.register({
    id: 'slack_dm_as_user', name: 'Slack DM as User', icon: 'slack',
    description: 'Send a direct message on behalf of the authorized user. Appears under Direct Messages (not Apps) in the recipient\'s sidebar.',
    outputFormat: 'mrkdwn',
    configSchema: [
      { key: 'user', label: 'Recipient (ID or email)', type: 'string',   optional: false },
      { key: 'body', label: 'Message',                 type: 'textarea', optional: true },
    ],
    isReady: userReady,
    deliver: async ({ config, body, title }) => {
      const api = makeUserApiL(config);
      const userId = await resolveUser(api, config.user);
      const conv = await api('conversations.open', { users: userId });
      const dmChannel = conv.channel?.id;
      if (!dmChannel) throw new Error('slack_dm_as_user: conversations.open did not return a channel');
      const text = title ? `*${title}*\n${body}` : body;
      const d = await api('chat.postMessage', { channel: dmChannel, text });
      return { delivered: true, channel: 'slack_dm_as_user', target: userId, ts: d.ts, slackChannel: dmChannel };
    },
  });

  // ── set_reminder (user token) ──────────────────────────────────────────────
  registry.register({
    id: 'slack_reminder', name: 'Slack Set Reminder', icon: 'slack', actionOnly: true,
    description: 'Create a reminder for the authorized user (or another user). Requires a user OAuth token.',
    configSchema: [
      { key: 'text', label: 'Reminder text', type: 'textarea', optional: true,  hint: 'Defaults to the previous step\'s output.' },
      { key: 'time', label: 'When',          type: 'string',   optional: false, hint: 'Unix timestamp or natural language e.g. "in 30 minutes"' },
      { key: 'user', label: 'User ID',       type: 'string',   optional: true  },
    ],
    isReady: userReady,
    deliver: async ({ config, body }) => {
      const api = makeUserApiL(config);
      const text = config.text ?? body;
      if (!text || !config.time) throw new Error('slack_reminder: text and time are required');
      const payload = { text, time: config.time };
      if (config.user) payload.user = config.user;
      const d = await api('reminders.add', payload);
      return { delivered: true, channel: 'slack_reminder', reminderId: d.reminder?.id };
    },
  });

  // ── list_reminders ─────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_list_reminders', name: 'Slack List Reminders', icon: 'slack', actionOnly: true,
    description: 'List all reminders for the authorized user.',
    configSchema: [],
    isReady: userReady,
    deliver: async ({ config }) => {
      const api = makeUserApiL(config);
      const d = await api.get('reminders.list', {});
      const reminders = (d.reminders ?? []).map((r) => ({ id: r.id, text: r.text, time: r.time, complete: !!r.complete_ts }));
      return { delivered: true, channel: 'slack_list_reminders', reminders };
    },
  });

  // ── search_messages (user token) ───────────────────────────────────────────
  registry.register({
    id: 'slack_search', name: 'Slack Search Messages', icon: 'slack', actionOnly: true,
    description: 'Search messages across the workspace (including private channels and DMs). Requires a user OAuth token.',
    configSchema: [
      { key: 'query', label: 'Search query', type: 'string', optional: false, hint: 'Supports modifiers: in:#channel from:@user' },
      { key: 'limit', label: 'Max results',  type: 'number', optional: true  },
    ],
    isReady: userReady,
    deliver: async ({ config }) => {
      const api = makeUserApiL(config);
      if (!config.query) throw new Error('slack_search: query is required');
      const d = await api.get('search.messages', { query: config.query, count: config.limit ?? 10 });
      const messages = (d.messages?.matches ?? []).map((m) => ({ ts: m.ts, channel: m.channel?.name, text: m.text, permalink: m.permalink }));
      return { delivered: true, channel: 'slack_search', messages };
    },
  });

  // ── search_files (user token) ──────────────────────────────────────────────
  registry.register({
    id: 'slack_search_files', name: 'Slack Search Files', icon: 'slack', actionOnly: true,
    description: 'Search files across the workspace. Requires a user OAuth token.',
    configSchema: [
      { key: 'query', label: 'Search query', type: 'string', optional: false },
      { key: 'limit', label: 'Max results',  type: 'number', optional: true  },
    ],
    isReady: userReady,
    deliver: async ({ config }) => {
      const api = makeUserApiL(config);
      if (!config.query) throw new Error('slack_search_files: query is required');
      const d = await api.get('search.files', { query: config.query, count: config.limit ?? 10 });
      const files = (d.files?.matches ?? []).map((f) => ({ id: f.id, name: f.name, title: f.title, permalink: f.permalink }));
      return { delivered: true, channel: 'slack_search_files', files };
    },
  });

  // ── set_status ─────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_set_status', name: 'Slack Set Status', icon: 'slack', actionOnly: true,
    description: 'Set the authorized user\'s status emoji and status text.',
    configSchema: [
      { key: 'status_text',       label: 'Status text',  type: 'string', optional: false, hint: 'e.g. "In a meeting"' },
      { key: 'status_emoji',      label: 'Status emoji', type: 'string', optional: true,  hint: 'e.g. :calendar:' },
      { key: 'status_expiration', label: 'Expiry (unix ts)', type: 'number', optional: true, hint: '0 = never expires' },
    ],
    isReady: userReady,
    deliver: async ({ config }) => {
      const api = makeUserApiL(config);
      const profile = {
        status_text: config.status_text ?? '',
        status_emoji: config.status_emoji ?? '',
        status_expiration: config.status_expiration ?? 0,
      };
      await api('users.profile.set', { profile: JSON.stringify(profile) });
      return { delivered: true, channel: 'slack_set_status', status_text: profile.status_text, status_emoji: profile.status_emoji };
    },
  });

  // ── set_dnd ────────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_set_dnd', name: 'Slack Set Do Not Disturb', icon: 'slack', actionOnly: true,
    description: 'Enable Do Not Disturb for the authorized user for a given number of minutes.',
    configSchema: [
      { key: 'num_minutes', label: 'Duration (minutes)', type: 'number', optional: true, hint: '0 to turn DND off, otherwise minutes to snooze' },
    ],
    isReady: userReady,
    deliver: async ({ config }) => {
      const api = makeUserApiL(config);
      const mins = config.num_minutes ?? 0;
      if (mins > 0) {
        const d = await api('dnd.setSnooze', { num_minutes: mins });
        return { delivered: true, channel: 'slack_set_dnd', snoozed: true, snoozeEndTs: d.snooze_end_time };
      } else {
        await api('dnd.endSnooze', {});
        return { delivered: true, channel: 'slack_set_dnd', snoozed: false };
      }
    },
  });

  // ── star_message ───────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_star_message', name: 'Slack Star Message', icon: 'slack', actionOnly: true,
    description: 'Star a message on behalf of the authorized user.',
    configSchema: [
      { key: 'target',    label: 'Channel',    type: 'string', optional: false },
      { key: 'timestamp', label: 'Message ts', type: 'string', optional: false },
    ],
    isReady: userReady,
    deliver: async ({ config }) => {
      const api = makeUserApiL(config);
      if (!config.target || !config.timestamp) throw new Error('slack_star_message: target and timestamp are required');
      const channelId = await resolveChannel(api, config.target);
      await api('stars.add', { channel: channelId, timestamp: config.timestamp });
      return { delivered: true, channel: 'slack_star_message' };
    },
  });

  // ── list_stars ─────────────────────────────────────────────────────────────
  registry.register({
    id: 'slack_list_stars', name: 'Slack List Stars', icon: 'slack', actionOnly: true,
    description: 'List items starred by the authorized user.',
    configSchema: [
      { key: 'limit', label: 'Max results', type: 'number', optional: true },
    ],
    isReady: userReady,
    deliver: async ({ config }) => {
      const api = makeUserApiL(config);
      const d = await api.get('stars.list', { count: config.limit ?? 20 });
      const items = (d.items ?? []).map((i) => ({ type: i.type, ts: i.message?.ts ?? null, text: i.message?.text ?? i.file?.name ?? null }));
      return { delivered: true, channel: 'slack_list_stars', items };
    },
  });

  return registry;
}

/**
 * Register Slack inbound-event triggers on a CapabilityRegistry.
 * Fires a workflow when a Slack event arrives via POST /connectors/slack/events.
 *
 * @param {import('../capability-registry.js').CapabilityRegistry} capabilityRegistry
 */
export function registerSlackTriggers(capabilityRegistry) {
  const ready = () => isOAuthConfigured() || !!process.env.SLACK_BOT_TOKEN;

  capabilityRegistry.register({
    id: 'slack_message',
    effect: 'read',
    connector: 'slack',
    positions: ['trigger'],
    name: 'Slack Message',
    description: 'Fires when a message is posted to a Slack channel.',
    icon: 'slack',
    configSchema: [
      { key: 'channel', label: 'Channel (optional)', type: 'string', optional: true, hint: 'Slack channel ID or #name; leave blank to trigger on any channel' },
      { key: 'keywords', label: 'Keywords (optional)', type: 'string', optional: true, hint: 'Comma-separated; trigger only when message contains one of these words' },
    ],
    requiredScopes: ['channels:history', 'channels:read'],
    isReady: ready,
  });

  capabilityRegistry.register({
    id: 'slack_mention',
    effect: 'read',
    connector: 'slack',
    positions: ['trigger'],
    name: 'Slack App Mention',
    description: 'Fires when someone @-mentions the Atlas app in Slack.',
    icon: 'slack',
    configSchema: [],
    requiredScopes: ['app_mentions:read'],
    isReady: ready,
  });
}

export default registerSlackChannel;
