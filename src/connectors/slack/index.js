/**
 * Slack connector (P1) — built fresh; the salvage repo had no Slack connector.
 *
 * Implemented as a delivery channel: a workflow `deliver` node with
 * `config.channel = "slack"` posts the step's content to a Slack channel via the
 * Web API (`chat.postMessage`). This is the cheapest end-to-end proof of the
 * spine (new repo -> engine -> Slack), per the Phase 1 plan. A connector via the
 * full MCP runtime is deferred (MCP is first exercised in P2 via the existing
 * `google` connector). See docs/connectors/slack.md.
 *
 * Auth: a bot token with `chat:write` in `SLACK_BOT_TOKEN` (or per-node
 * `config.token`). `SLACK_API_URL` overrides the API base (used by the gate to
 * point at a local stub so the check is reproducible without secrets).
 */

const DEFAULT_API_BASE = 'https://slack.com/api';

/** Capability schema — what this connector can do; the contract P3's converger targets. */
export const slackCapability = {
  connector: 'slack',
  kind: 'delivery-channel',
  channelId: 'slack',
  auth: { env: 'SLACK_BOT_TOKEN', scopes: ['chat:write'] },
  actions: [
    {
      id: 'post_message',
      label: 'Post a message to a Slack channel',
      config: [
        { key: 'target', type: 'string', required: true, hint: 'Channel ID (C…) or #name' },
        { key: 'body', type: 'string', required: false, hint: 'Message text; omit to use the prior step output' },
      ],
      returns: ['ts', 'slackChannel'],
    },
  ],
};

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
