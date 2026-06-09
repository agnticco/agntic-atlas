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
 * A cached capability provider: detects the token's scopes once and resolves the
 * map. Mounted on the spine so `/capabilities` and the converger share one view.
 * @param {{ token?: string, apiBase?: string, fetchImpl?: typeof fetch }} [opts]
 */
export function createSlackCapabilityProvider(opts = {}) {
  let cache = null;
  async function resolve() {
    if (!cache) cache = resolveSlackCapabilities(await detectGrantedScopes(opts));
    return cache;
  }
  return {
    resolve,
    async describe() { return describeSlackForPrompt(await resolve()); },
    /** Drop the cached scopes (e.g. after a client re-installs with new scopes). */
    refresh() { cache = null; },
  };
}

/**
 * Register the Slack delivery channel on a ChannelRegistry.
 * @param {import('../../workflows/channel-registry.js').ChannelRegistry} registry
 * @param {{ fetchImpl?: typeof fetch }} [opts] — injectable fetch (tests/stub)
 */
export function registerSlackChannel(registry, { fetchImpl = fetch } = {}) {
  registry.register({
    id: 'slack',
    name: 'Slack',
    description: 'Posts the result to a Slack channel via chat.postMessage. Requires a bot token (chat:write).',
    icon: 'slack',
    configSchema: [
      { key: 'target', label: 'Slack channel', type: 'string', optional: false, hint: 'Channel ID (C…) or #name to post to.' },
      { key: 'body',   label: 'Message',       type: 'textarea', optional: true,  hint: 'Message text. Omit to deliver the previous step output.' },
    ],
    // Ready iff a bot token is configured. (Per-node config.token also works but
    // isn't visible to this static probe.)
    isReady: () => !!process.env.SLACK_BOT_TOKEN,
    deliver: async ({ config, body, title }) => {
      const token = config.token ?? process.env.SLACK_BOT_TOKEN;
      if (!token) throw new Error('slack channel requires a bot token (SLACK_BOT_TOKEN or config.token)');
      const target = config.target;
      if (!target) throw new Error('slack channel requires config.target (channel ID or #name)');

      const apiBase = process.env.SLACK_API_URL ?? DEFAULT_API_BASE;
      const text = title ? `*${title}*\n${body}` : body;

      const res = await fetchImpl(`${apiBase}/chat.postMessage`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: target, text }),
      });
      let data;
      try { data = await res.json(); } catch { data = { ok: false, error: 'invalid_json_response' }; }
      // Slack always returns HTTP 200; success is signalled by the `ok` field.
      if (!res.ok || !data.ok) {
        throw new Error(`slack chat.postMessage failed: ${data.error ?? `HTTP ${res.status}`}`);
      }
      return { delivered: true, channel: 'slack', target, ts: data.ts, slackChannel: data.channel ?? target };
    },
  });
  return registry;
}

export default registerSlackChannel;
