/**
 * tool node — low-level call to any registered tool (built-in or MCP).
 *
 * Prefer higher-level primitives (search_web / summarize /
 * etc.) when they fit. Use tool only when no primitive covers the operation.
 */

export const toolNodeType = {
  type: 'tool',
  label: 'Tool (advanced)',
  description: 'Low-level: invokes any registered tool by name. Prefer a primitive (Search Web, Summarize, etc.) when one exists.',
  icon: 'build',
  family: 'low_level',
  configSchema: [
    { key: 'tool', label: 'Tool name', type: 'text',
      hint: 'Name of a registered tool: web_search, calculator, get_datetime, etc.' },
    { key: 'query', label: 'query (for search tools)', type: 'text', optional: true },
    { key: 'num_results', label: 'num_results (for search tools)', type: 'number', optional: true, advanced: true },
  ],
  previewTemplate: 'Calls the "{tool}" tool{query? with query "{query}"}.',
  run: async (cfg, _ctx, services) => {
    if (!services?.tools) throw new Error('Tool registry unavailable');
    const toolName = cfg.tool ?? cfg.name;
    if (!toolName) throw new Error('tool node requires config.tool');
    const tool = services.tools.get?.(toolName) ?? services.tools.getTool?.(toolName);
    if (!tool) throw new Error(`Tool "${toolName}" not found`);

    let args;
    if (cfg.args && typeof cfg.args === 'object' && !Array.isArray(cfg.args)) {
      args = cfg.args;
    } else {
      const { tool: _t, name: _n, ...rest } = cfg;
      args = rest;
    }
    return await tool.invoke(args);
  },
};
