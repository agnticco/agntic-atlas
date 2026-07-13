/**
 * v1 → v2 node compat shim (P12 Increment A).
 *
 * Increment A re-cut the node library: four node types that were only ever
 * `llm.js` with a different prompt collapsed into `llm` + `mode`, and three
 * that were never runnable at all were deleted.
 *
 * Nothing in the database was migrated. Instead every v1 node is lifted to its
 * v2 shape on the way in, at the two — and only two — places a node is ever
 * read:
 *
 *   1. WorkflowValidator.validate()  — so a v1 spec still validates
 *   2. FlowTester._runNode()         — so a v1 spec still executes
 *
 * Both the scheduler and the REST run path go through FlowTester, so those two
 * call sites cover every way a workflow can run. Keeping the lift here (rather
 * than rewriting rows) means an old spec is never silently mutated on disk, and
 * the shim can be deleted in one move once no v1 specs remain.
 *
 * THE COLLAPSED TYPES — lifted, and still fully runnable:
 *
 *   summarize → llm (mode: summarize)
 *   extract   → llm (mode: extract)
 *   rewrite   → llm (mode: rewrite)
 *
 * Their v1 config keys (instructions, format, fields, length, style, tone,
 * focus, input) are all declared on the v2 `llm` schema under the same names,
 * so the lift is a type swap plus a `mode` — no key renaming, and no config is
 * dropped.
 *
 *   daily_digest → assemble
 *
 * `daily_digest` did NOT collapse into `llm`, because it is not an LLM node:
 * its run() never touched `services.llm` (it took `_ctx, _services` — both
 * deliberately unused). It is pure, free, deterministic template assembly.
 * Folding it into `llm` would have quietly converted a zero-cost string
 * operation into a paid, non-deterministic model call. It kept its exact run()
 * and config, and moved to `assemble.js` under the honest name.
 *
 * THE DELETED TYPES — rejected at build time, and they were never runnable:
 *
 *   tool · mcp_tool · fetch
 *
 * There is no ToolRegistry in this build (no `src/tools/`, never instantiated)
 * and FlowTester is constructed without `tools`, so a `tool`/`mcp_tool` node
 * threw "Tool registry unavailable" at RUN time, and `fetch` needs a registered
 * `source` rather than a URL. They were dead weight the converger could still
 * emit. They now fail as REMOVED_NODE_TYPE at BUILD time — the same outcome,
 * discovered before the workflow ships instead of at 6am in production.
 */

/** v1 LLM primitives → the `llm` mode they became. */
export const V1_LLM_MODES = Object.freeze({
  summarize: 'summarize',
  extract:   'extract',
  rewrite:   'rewrite',
});

/** v1 types that were renamed, keeping their behaviour byte-for-byte. */
export const V1_RENAMED = Object.freeze({
  daily_digest: 'assemble',
});

/**
 * Types deleted because they cannot run in this build. The value is the reason
 * shown to the user — it must say what to do instead, not just "no".
 */
export const REMOVED_TYPES = Object.freeze({
  tool: 'There is no tool registry in this build, so a "tool" step could never run. Use a connector-action step instead — it reaches the same connectors through their registered capabilities.',
  mcp_tool: 'There is no tool registry in this build, so an "mcp_tool" step could never run. Use a connector-action step instead.',
  fetch: 'The "fetch" step needs a pre-registered source, not a URL, and no sources are registered in this build. To read a web page use a connector-action with web_fetch; to read a file use filesystem_read.',
});

/** Is this a v1 node type that no longer exists as itself? */
export function isV1Type(type) {
  return type in V1_LLM_MODES || type in V1_RENAMED;
}

/** Was this type removed as unrunnable? */
export function isRemovedType(type) {
  return type in REMOVED_TYPES;
}

/**
 * Lift one node to its v2 shape. A v2 node (or an unknown one) is returned
 * unchanged and un-cloned, so this is safe to call on every node on every run.
 *
 * Removed types are NOT lifted — they have no v2 equivalent. They pass through
 * untouched so the validator can reject them by name with a real explanation,
 * rather than being silently rewritten into something they never were.
 *
 * @param {object} node
 * @returns {object} the node, lifted if it needed lifting
 */
export function liftV1Node(node) {
  const type = node?.type;
  if (!type) return node;

  if (type in V1_LLM_MODES) {
    return {
      ...node,
      type: 'llm',
      // An explicit mode always wins — the lift never overwrites a v2 author.
      config: { mode: V1_LLM_MODES[type], ...(node.config ?? {}) },
    };
  }

  if (type in V1_RENAMED) {
    return { ...node, type: V1_RENAMED[type] };
  }

  return node;
}

/** Lift a whole node list. Returns the same array instance if nothing changed. */
export function liftV1Nodes(nodes) {
  if (!Array.isArray(nodes)) return nodes;
  let changed = false;
  const lifted = nodes.map((n) => {
    const l = liftV1Node(n);
    if (l !== n) changed = true;
    return l;
  });
  return changed ? lifted : nodes;
}
