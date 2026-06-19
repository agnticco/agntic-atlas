/**
 * Node-types index — one place to register every built-in type.
 *
 * To add a new type: create its module next to this file, export the def,
 * then append a line here.
 */

import { triggerNodeType }      from './trigger.js';
import { fetchNodeType }        from './fetch.js';
import { toolNodeType }         from './tool.js';
import { mcpToolNodeType }      from './mcp-tool.js';
import { llmNodeType }          from './llm.js';
import { deliverNodeType }      from './deliver.js';
import { connectorActionNodeType } from './connector-action.js';

import { searchWebNodeType }    from './search-web.js';
import { summarizeNodeType }    from './summarize.js';
import { rewriteNodeType }      from './rewrite.js';
import { extractNodeType }      from './extract.js';
import { dailyDigestNodeType }  from './daily-digest.js';

export function registerBuiltInNodeTypes(registry) {
  // Triggers + transport
  registry.register(triggerNodeType);
  registry.register(deliverNodeType);

  // High-level primitives (the UX surface)
  registry.register(searchWebNodeType);
  registry.register(summarizeNodeType);
  registry.register(rewriteNodeType);
  registry.register(extractNodeType);
  registry.register(dailyDigestNodeType);
  registry.register(connectorActionNodeType);

  // Low-level escape hatches (hidden from palette unless needed)
  registry.register(fetchNodeType);
  registry.register(toolNodeType);
  registry.register(mcpToolNodeType);
  registry.register(llmNodeType);

  return registry;
}

export {
  triggerNodeType, fetchNodeType, toolNodeType, mcpToolNodeType,
  llmNodeType, deliverNodeType, connectorActionNodeType,
  searchWebNodeType,
  summarizeNodeType, rewriteNodeType, extractNodeType, dailyDigestNodeType,
};
