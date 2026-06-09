/**
 * mcp_tool node — call any tool from a registered MCP server.
 *
 * The MCP registry publishes every connected server's tools into the main
 * ToolRegistry under namespaced names (`${server}__${remoteName}`). This node
 * exposes that capability as a first-class Flow primitive so workflows can
 * fan out to external services without hardcoding integrations in the engine.
 *
 * @module src/workflows/node-types/mcp-tool.js
 */

export const mcpToolNodeType = {
  type: 'mcp_tool',
  label: 'Call MCP Tool',
  description: 'Invoke a tool from a connected MCP server. Output becomes {{prev}} for the next step.',
  icon: 'extension',
  family: 'low_level',
  configSchema: [
    { key: 'server', label: 'MCP server', type: 'text',
      hint: 'Registered server name (e.g. github). See the MCP Registry page.' },
    { key: 'tool',   label: 'Tool name',  type: 'text',
      hint: "The tool's remote name on that server (e.g. create_issue)." },
    { key: 'args',   label: 'Arguments',  type: 'object', optional: true,
      hint: 'Object passed to the tool. Supports {{prev}}, {{date}}, and {{nodeId.output}} substitutions.' },
  ],
  previewTemplate: 'Calls {server}__{tool}.',

  validate(node) {
    const issues = [];
    const cfg = node.config ?? {};
    if (cfg.server && /__/g.test(cfg.server)) {
      issues.push({
        severity: 'error', code: 'MCP_TOOL_BAD_SERVER',
        message: `Step "${node.label || node.id}": server name "${cfg.server}" must not contain "__".`,
        nodeId: node.id, field: 'config.server',
        hint: 'Use the bare server name (e.g. "github"), not the namespaced tool id.',
      });
    }
    if (cfg.tool && cfg.tool.includes('__')) {
      issues.push({
        severity: 'warning', code: 'MCP_TOOL_SPLIT_NAME',
        message: `Step "${node.label || node.id}": tool name "${cfg.tool}" looks namespaced.`,
        nodeId: node.id, field: 'config.tool',
        hint: 'Split "server__tool" into the server field and the tool field.',
      });
    }
    if (cfg.args != null && (typeof cfg.args !== 'object' || Array.isArray(cfg.args))) {
      issues.push({
        severity: 'error', code: 'MCP_TOOL_ARGS_SHAPE',
        message: `Step "${node.label || node.id}": args must be an object.`,
        nodeId: node.id, field: 'config.args',
      });
    }
    return issues;
  },

  run: async (cfg, _ctx, services) => {
    if (!services?.tools) throw new Error('Tool registry unavailable');

    const server = String(cfg.server ?? '').trim();
    const tool   = String(cfg.tool   ?? '').trim();
    if (!server) throw new Error('mcp_tool requires config.server');
    if (!tool)   throw new Error('mcp_tool requires config.tool');

    const namespacedName = `${server}__${tool}`;
    const registered = services.tools.get?.(namespacedName) ?? services.tools.getTool?.(namespacedName);
    if (!registered) {
      throw new Error(`MCP tool "${namespacedName}" is not available. Check that the "${server}" MCP is connected and exposes "${tool}".`);
    }

    const args = (cfg.args && typeof cfg.args === 'object' && !Array.isArray(cfg.args)) ? cfg.args : {};
    return await registered.invoke(args);
  },
};

export default mcpToolNodeType;
