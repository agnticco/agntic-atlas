/**
 * connector-action node — runs a connector capability MID-workflow (not as the
 * final delivery). This is what lets a connector be used anywhere, not just as a
 * destination: e.g. look up a Slack user, pull channel history, create a channel,
 * then feed the result into the next step.
 *
 * Execution reuses the exact same handlers the `deliver` node routes to (the
 * ChannelRegistry already holds every connector capability, including the
 * `actionOnly` ones), so no separate ToolRegistry is needed. The handler's return
 * value becomes this node's output and threads downstream like any other step.
 *
 * config: { action: <registered capability id, e.g. "slack_history">, ...action params }
 * The action-specific params (target, user, channel, …) live alongside `action`
 * in config and are passed straight through to the handler.
 */

import { stringifyOutput } from './_node-input.js';

export const connectorActionNodeType = {
  type: 'connector-action',
  label: 'Connector action',
  description: 'Runs a connector capability mid-workflow (e.g. Slack lookup, channel history) and passes its result to the next step.',
  icon: 'plug',
  family: 'action',
  // The ONLY open-schema node type. Its params are per-capability — an Airtable
  // search takes baseId/tableId/filterByFormula, a Sheets read takes
  // spreadsheetId/range — and this schema cannot enumerate them ahead of time,
  // because the capability catalog is built at run time from whichever
  // connectors a tenant has authorised. So UNKNOWN_CONFIG_KEY does not apply
  // here: params pass through to the handler, exactly as the note above says.
  // Increment F closes this properly by validating params against the
  // capability's OWN declared schema ("schema-aware connectors"). Until then
  // this is a real, bounded hole in the config check, and it is the only one.
  configPolicy: 'open',
  configSchema: [
    { key: 'action', label: 'Action', type: 'string', optional: false,
      hint: 'A registered connector capability id, e.g. "slack_history", "slack_lookup_user".' },
    { key: 'target', label: 'Channel / target', type: 'string', optional: true,
      hint: 'Action-specific: the channel, user, or resource the action operates on.' },
  ],
  previewTemplate: 'Runs the {action} connector action.',
  run: async (cfg, ctx, services) => {
    if (!services?.channelRegistry) throw new Error('connector-action node needs a channel registry');
    const actionId = cfg.action;
    if (!actionId) throw new Error('connector-action requires config.action (a registered capability id)');

    const ch = services.channelRegistry.get(actionId);
    if (!ch) throw new Error(`Connector action "${actionId}" is not available in this build.`);
    if (!ch.available) throw new Error(`Connector action "${actionId}" is not ready (${ch.unavailableReason}).`);

    const handler = services.channelRegistry.getHandler(actionId);
    if (!handler) throw new Error(`Connector action "${actionId}" has no handler`);

    // Pass the upstream output through as `body` (some actions consume it; pure
    // read/lookup actions ignore it and work from config alone). Forward the
    // cost-tracking sessionId so LLM-backed connectors (e.g. web_search) emit
    // cost records under the workflow run's session rather than 'unknown'.
    const sessionId   = ctx.costConfig?.configurable?.sessionId;
    const costContext = ctx.costConfig?.configurable?.costContext;
    return handler({ config: cfg, body: stringifyOutput(ctx.lastOutput), title: cfg.title ?? null, lastOutput: ctx.lastOutput, sessionId, costContext });
  },
};
