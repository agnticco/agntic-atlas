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
  // CLOSED as of P12 Increment F — this was the last open-schema node type, and
  // the last hole in UNKNOWN_CONFIG_KEY.
  //
  // The reason it was open is real: an Airtable search takes baseId/tableId, a
  // Sheets read takes spreadsheetId/range, and THIS schema cannot enumerate them —
  // the catalog is built at run time from whichever connectors a tenant has
  // authorised. But it does not follow that nobody can check them. Every
  // capability ALREADY declares its own `configSchema` (capability-registry.js),
  // and the validator already resolves a `deliver` node's channel schema the same
  // way. So the checkable key set is:
  //
  //     this node's OWN keys   ∪   the SELECTED CAPABILITY's declared params
  //
  // …which is exactly how `deliver` has worked since Increment C. Nothing needed
  // inventing; the schema was already there and simply was not consulted.
  //
  // The node's own keys are `action` and `title`, because those are the only two
  // `run()` reads (below). `target` used to be declared here and is NOT read by
  // run() — it is a *capability* param (Slack declares it), and declaring it here
  // meant the node's schema lied in both directions at once: it named a key
  // nothing in this file consumes, and omitted `title`, which it does. A schema
  // that lists keys nothing reads turns the check into theatre — that is the state
  // that let `"model": "claude-opus-4-5"` ship (ENGINEERING-LOG.md, Increment A).
  configPolicy: 'closed',
  configSchema: [
    { key: 'action', label: 'Action', type: 'string', optional: false,
      hint: 'A registered connector capability id, e.g. "slack_history", "airtable_create_record".' },
    { key: 'title', label: 'Title', type: 'string', optional: true,
      hint: 'Optional heading passed to the capability alongside the upstream content.' },
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
