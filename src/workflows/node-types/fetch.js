/**
 * fetch node — calls a registered Source fetcher (e.g. nws-afd).
 */

export const fetchNodeType = {
  type: 'fetch',
  label: 'Fetch (named source)',
  description: 'Pulls data from a registered Source (not a generic web search — specific, curated sources only).',
  icon: 'cloud_download',
  family: 'fetch',
  configSchema: [
    { key: 'source', label: 'Source id', type: 'text',
      hint: 'Must match a registered Source. See the Sources list on the Workflows page.' },
  ],
  previewTemplate: 'Pulls the latest data from the "{source}" source.',
  run: async (cfg, _ctx, services) => {
    if (!services?.scheduler) throw new Error('Fetcher unavailable in this context');
    const sourceId = cfg.source ?? cfg.sourceId;
    if (!sourceId) throw new Error('fetch node requires config.source');
    return await services.scheduler.preview(sourceId, cfg);
  },
};
