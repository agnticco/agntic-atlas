/**
 * channel-handlers — the real, code-backed delivery channels.
 *
 * Each exported function registers one channel with the ChannelRegistry. Only
 * channels that have a complete handler here are exposed to the Flow builder,
 * the UI, and the runtime. Adding a new channel = writing a handler here (or
 * in a peer module) and calling its register function from server startup.
 *
 * Current roster
 * ──────────────
 *   registerInAppChannel    — Inbox (uses the Inbox page + in-app notifications)
 *   registerWebhookChannel  — HTTP POST to a user-supplied URL
 *
 * Future: registerEmailChannel (when Gmail/Outlook MCPs are wired),
 *         registerSlackChannel, registerFileChannel (when Vault write is live).
 *
 * @module src/workflows/channel-handlers.js
 */

/** Register the in-app (Inbox) channel. Always available. */
export function registerInAppChannel(registry) {
  registry.register({
    id: 'in_app',
    name: 'Inbox (in-app)',
    description: 'Delivers the result to the Agntic Inbox. Shown in the sidebar with an unread badge.',
    icon: 'inbox',
    configSchema: [
      { key: 'title', label: 'Title', type: 'string', optional: true, hint: 'Shown as the inbox item title. Supports {{date}}.' },
    ],
    isReady: () => true,
    deliver: async ({ config, body, title }) => {
      // The inbox render is derived from the run's stored output. Nothing
      // extra needs to happen here — we just return a well-shaped envelope
      // that the Inbox reader understands.
      return {
        delivered: true,
        channel: 'in_app',
        title: title ?? config.title ?? null,
        body,
      };
    },
  });
}

/**
 * Register the webhook channel. Always available; readiness is per-call
 * (depends on the URL the user supplied).
 */
export function registerWebhookChannel(registry) {
  registry.register({
    id: 'webhook',
    name: 'Webhook (HTTP POST)',
    description: 'POSTs the result as JSON to a URL you control. Good for piping Flow output into external systems you own.',
    icon: 'link',
    configSchema: [
      { key: 'url',     label: 'URL',     type: 'string', optional: false },
      { key: 'headers', label: 'Headers', type: 'object', optional: true, hint: 'Extra HTTP headers as an object (e.g. auth tokens)' },
    ],
    isReady: () => true,
    deliver: async ({ config, body, title }) => {
      if (!config.url) throw new Error('webhook channel requires config.url');
      const res = await fetch(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(config.headers ?? {}) },
        body: JSON.stringify({ title, body }),
      });
      if (!res.ok) {
        throw new Error(`webhook POST failed: HTTP ${res.status}`);
      }
      return {
        delivered: true,
        channel: 'webhook',
        status: res.status,
        url: config.url,
        title: title ?? null,
        body,
      };
    },
  });
}

/**
 * Register the generic MCP delivery channel.
 *
 * Flow workflows can deliver their output via any tool on a connected MCP
 * server — `send_email` (Gmail/Outlook), `send_message` (Slack/Discord),
 * `create_issue` (GitHub/Linear), whatever the server exposes.
 *
 * Config schema:
 *   server       — MCP server name, e.g. "gmail"
 *   tool         — remote tool name on that server, e.g. "send_email"
 *   body_arg     — which tool argument should receive the workflow body
 *                  (defaults to "body"; common alternatives: text, content, message)
 *   title_arg    — optional: which tool argument should receive the title
 *                  (defaults to "subject" if present in extra_args, else skipped)
 *   extra_args   — object merged into the invocation before body/title are set
 *
 * Readiness: always true. The specific tool is looked up at delivery time,
 * which means a workflow stays valid when MCPs disconnect/reconnect; only
 * the actual delivery fails if the target is missing.
 */
export function registerMcpChannel(registry, { toolRegistry } = {}) {
  registry.register({
    id: 'mcp',
    name: 'MCP tool',
    description: 'Deliver the output via any tool on a connected MCP server (Gmail, Slack, GitHub, etc.).',
    icon: 'extension',
    configSchema: [
      { key: 'server',     label: 'MCP server',     type: 'string', optional: false, hint: 'Registered server name (see MCP Registry).' },
      { key: 'tool',       label: 'Tool',           type: 'string', optional: false, hint: "The tool's remote name on that server (e.g. send_email)." },
      { key: 'body_arg',   label: 'Body argument',  type: 'string', optional: true,  hint: 'Name of the argument that should receive the workflow body. Defaults to "body".' },
      { key: 'title_arg',  label: 'Title argument', type: 'string', optional: true,  hint: 'Optional argument name that should receive the workflow title (e.g. "subject").' },
      { key: 'extra_args', label: 'Extra args',     type: 'object', optional: true,  hint: 'Object merged into the tool invocation (recipients, channel id, labels, etc.).' },
    ],
    isReady: () => true,
    deliver: async ({ config, body, title }) => {
      const server = String(config.server ?? '').trim();
      const tool   = String(config.tool   ?? '').trim();
      if (!server) throw new Error('mcp channel requires config.server');
      if (!tool)   throw new Error('mcp channel requires config.tool');
      if (!toolRegistry) throw new Error('mcp channel requires a ToolRegistry');

      const namespaced = `${server}__${tool}`;
      const registered = toolRegistry.get?.(namespaced);
      if (!registered) {
        throw new Error(`MCP tool "${namespaced}" is not available. Connect the "${server}" MCP and confirm it exposes "${tool}".`);
      }

      const args = { ...(config.extra_args ?? {}) };
      args[config.body_arg ?? 'body'] = body;
      if (title != null && config.title_arg) args[config.title_arg] = title;

      const result = await registered.invoke(args);
      return {
        delivered: true,
        channel:   'mcp',
        server,
        tool,
        title:     title ?? null,
        body,
        result,
      };
    },
  });
}

/**
 * Convenience: register every built-in handler that ships with the repo.
 * Call once at server startup.
 */
export function registerBuiltInChannels(registry, deps = {}) {
  registerInAppChannel(registry);
  registerWebhookChannel(registry);
  if (deps.toolRegistry) registerMcpChannel(registry, deps);
}
