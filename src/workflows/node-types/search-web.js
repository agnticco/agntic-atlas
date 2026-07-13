/**
 * search_web primitive — pulls news/articles for a topic.
 *
 * Atlas refactor (2026-06): runs on Anthropic's native server-side
 * web_search_20260209 tool via a direct LLM call, replacing the removed
 * client-side Tavily/Brave/DDG tool. The model searches, reads the results,
 * and returns a written digest plus the structured source list mapped through
 * mapNativeWebSources (same shape run-enricher expects: results[].url/title).
 *
 * Requires the active LLM tier to be Anthropic-backed. Non-Anthropic
 * deployments get a clear error instead of a silent empty result.
 */

import { SystemMessage, HumanMessage } from '../../core/message.js';
import { mapNativeWebSources } from '../../llm/native-citations.js';

const NATIVE_WEB_SEARCH = Object.freeze({
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: 3,
  allowed_callers: ['direct'],
});

const DEPTH_INSTRUCTIONS = {
  snippets: 'For each article give only the headline and a one-sentence description.',
  standard: 'For each article give the headline and a ~150-word summary of its content.',
  deep:     'For each article give the headline and a detailed summary (~400 words) including key quotes, figures, and any image or link references.',
};

export const searchWebNodeType = {
  type: 'search_web',
  label: 'Search the web',
  description: 'Searches the web for a topic and returns articles with summaries of their content (links and citations included).',
  icon: 'travel_explore',
  family: 'fetch',
  configSchema: [
    { key: 'topic', label: 'Topic', type: 'text',
      placeholder: 'e.g. agentic AI developer tools',
      hint: 'What to search for. Supports templates like {{date}}.' },
    { key: 'query', label: 'Topic (alias)', type: 'text', optional: true, advanced: true,
      hint: 'Accepted as a synonym for `topic` — run() reads `cfg.topic ?? cfg.query`. Declared so the schema matches what the code actually consumes.' },
    { key: 'count', label: 'How many articles', type: 'number',
      default: 4,
      hint: '1–10. Each article includes a content summary so later steps can pull facts and quotes.' },
    { key: 'depth', label: 'Detail depth', type: 'select',
      options: ['snippets', 'standard', 'deep'],
      default: 'standard', advanced: true,
      hint: 'snippets = headlines only · standard = ~150-word summaries · deep = detailed summaries with quotes/figures.' },
  ],
  previewTemplate: 'Searches the web for "{topic}" and returns {count|3} articles{depth=deep? with detailed summaries|depth=snippets? as headlines only| with standard summaries}.',
  run: async (cfg, ctx, services) => {
    if (!services?.llm) throw new Error('search_web requires the LLM service (native web search runs through the model)');
    const topic = (cfg.topic ?? cfg.query ?? '').trim();
    if (!topic) throw new Error('search_web requires a topic');
    const count = Math.min(Math.max(1, cfg.count ?? 4), 10);
    const depth = cfg.depth ?? 'standard';

    // Native server tools only exist on Anthropic-backed models.
    const tier = ctx.costConfig?.configurable?.modelTier ?? 'balanced';
    const tierLlm = services.llm?.tiers?.[tier] ?? services.llm;
    const provider = tierLlm?.provider ?? services.llm?.provider;
    if (provider && provider !== 'anthropic') {
      throw new Error(
        `search_web requires an Anthropic-backed model tier for native web search (got provider "${provider}"). ` +
        'Set INFERENCE=anthropic or remove search_web steps from this workflow.'
      );
    }

    const system =
      'You are a research step inside an automated workflow. Use the web_search tool to find ' +
      'current articles on the requested topic, then report what you found. Do not ask questions. ' +
      'Cite every article you reference.';
    const prompt =
      `Search the web for: ${topic}\n\n` +
      `Find the ${count} most relevant and recent articles. ${DEPTH_INSTRUCTIONS[depth] ?? DEPTH_INSTRUCTIONS.standard}\n` +
      'Include each article\'s URL.';

    const invokeConfig = {
      ...(ctx.costConfig ?? {}),
      configurable: {
        ...(ctx.costConfig?.configurable ?? {}),
        modelTier: tier,
      },
      tools: [{ ...NATIVE_WEB_SEARCH }],
    };

    const response = await services.llm.invoke(
      [new SystemMessage(system), new HumanMessage(prompt)],
      invokeConfig,
    );

    const serverBlocks = response.additionalKwargs?._serverToolBlocks ?? [];
    const rawContent   = response.additionalKwargs?._anthropicContent ?? [];
    const { sources, text } = mapNativeWebSources(serverBlocks, rawContent);

    const body = text || (typeof response.content === 'string' ? response.content : '');
    const results = sources.slice(0, count).map(s => ({
      title:   s.title ?? '',
      url:     s.url ?? '',
      snippet: (s.cited_snippets?.[0]?.cited_text ?? '').slice(0, 500),
      content: '',
    }));

    return { query: topic, results, provider: 'anthropic-native', body };
  },
};
