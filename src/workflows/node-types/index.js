/**
 * Node-types index — one place to register every built-in type.
 *
 * To add a new type: create its module next to this file, export the def,
 * then append a line here.
 *
 * P12 Increment A re-cut this library. It used to hold eleven types; four of
 * them (summarize / extract / rewrite) were `llm.js` with a different prompt,
 * and three (tool / mcp_tool / fetch) could not run at all. What is left is the
 * set that is actually runnable, with no two entries doing the same job:
 *
 *   trigger · llm · assemble · connector-action · deliver · search_web
 *
 * v1 specs naming a collapsed type still validate and still run — ./compat-v1.js
 * lifts them. See that file for the full mapping and the reasoning.
 */

import { triggerNodeType }         from './trigger.js';
import { llmNodeType }             from './llm.js';
import { assembleNodeType }        from './assemble.js';
import { deliverNodeType }         from './deliver.js';
import { connectorActionNodeType } from './connector-action.js';
import { searchWebNodeType }       from './search-web.js';

export function registerBuiltInNodeTypes(registry) {
  // Triggers + transport
  registry.register(triggerNodeType);
  registry.register(deliverNodeType);

  // The working steps
  registry.register(llmNodeType);
  registry.register(assembleNodeType);
  registry.register(connectorActionNodeType);
  registry.register(searchWebNodeType);

  return registry;
}

export {
  triggerNodeType, llmNodeType, assembleNodeType,
  deliverNodeType, connectorActionNodeType, searchWebNodeType,
};
