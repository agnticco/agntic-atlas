/**
 * Web connector — search + fetch, fully self-owned.
 *
 * web_search: Anthropic native web_search_20260209 tool (same model tier already in use).
 *   Connected = ANTHROPIC_API_KEY is set. No Tavily key needed.
 *
 * web_fetch: Mozilla Readability + jsdom. Fetches a URL, extracts the readable
 *   article content (Firefox Reader Mode algorithm). Always available — no API key.
 *
 * Usage: registerWebCapabilities(registry, { llm: spine.llm })
 */

import { Readability }       from '@mozilla/readability';
import { JSDOM }             from 'jsdom';
import { SystemMessage, HumanMessage } from '../../core/message.js';
import { mapNativeWebSources }         from '../../llm/native-citations.js';

const DEPTH_INSTRUCTIONS = {
  snippets: 'For each article give only the headline and a one-sentence description.',
  standard: 'For each article give the headline and a ~150-word summary.',
  deep:     'For each article give the headline and a detailed ~400-word summary with key quotes and figures.',
};

const NATIVE_WEB_SEARCH = Object.freeze({
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: 3,
  allowed_callers: ['direct'],
});

async function runWebSearch(llm, query, { count = 5, depth = 'standard' } = {}) {
  if (!llm) throw new Error('web_search: LLM service not injected — pass llm to registerWebCapabilities');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('web_search requires ANTHROPIC_API_KEY');

  const tier    = 'balanced';
  const tierLlm = llm?.tiers?.[tier] ?? llm;
  const provider = tierLlm?.provider ?? llm?.provider;
  if (provider && provider !== 'anthropic') {
    throw new Error(`web_search requires an Anthropic-backed LLM tier (got "${provider}"). Set ANTHROPIC_API_KEY.`);
  }

  const system =
    'You are a research step inside an automated workflow. ' +
    'Use the web_search tool to find current articles on the topic, then report what you found. ' +
    'Do not ask questions. Cite every article you reference.';
  const prompt =
    `Search the web for: ${query}\n\n` +
    `Find the ${count} most relevant and recent articles. ${DEPTH_INSTRUCTIONS[depth] ?? DEPTH_INSTRUCTIONS.standard}\n` +
    'Include each article\'s URL.';

  const response = await llm.invoke(
    [new SystemMessage(system), new HumanMessage(prompt)],
    { configurable: { modelTier: tier }, tools: [{ ...NATIVE_WEB_SEARCH }] },
  );

  const serverBlocks = response.additionalKwargs?._serverToolBlocks ?? [];
  const rawContent   = response.additionalKwargs?._anthropicContent ?? [];
  const { sources, text } = mapNativeWebSources(serverBlocks, rawContent);

  const body = text || (typeof response.content === 'string' ? response.content : '');
  const results = sources.slice(0, count).map(s => ({
    title:   s.title ?? '',
    url:     s.url ?? '',
    snippet: (s.cited_snippets?.[0]?.cited_text ?? '').slice(0, 500),
  }));

  return { query, results, body, provider: 'anthropic-native' };
}

async function runWebFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AtlasWorkflow/1.0 (Mozilla/5.0 compatible)' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`web_fetch: HTTP ${res.status} fetching ${url}`);
  const html = await res.text();

  const dom     = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();

  if (article) {
    return {
      url,
      title:   article.title   ?? null,
      byline:  article.byline  ?? null,
      content: article.textContent?.replace(/\s{3,}/g, '\n\n').trim() ?? '',
      excerpt: article.excerpt ?? null,
    };
  }

  // Readability couldn't extract — return stripped text
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return { url, title: titleMatch ? titleMatch[1].trim() : null, byline: null, content: stripped, excerpt: null };
}

export function registerWebCapabilities(registry, { llm } = {}) {
  registry.register({
    id:          'web_search',
    connector:   'web',
    name:        'Search the web',
    description: 'Search the web for current news or information. Returns article summaries and links. Powered by Anthropic native web search.',
    positions:   ['step'],
    configSchema: [
      { key: 'query',       label: 'Search query', type: 'text' },
      { key: 'max_results', label: 'Max results',  type: 'number', optional: true, hint: '1–10, default 5' },
      { key: 'depth',       label: 'Detail depth', type: 'select', options: ['snippets', 'standard', 'deep'], optional: true },
    ],
    isReady: () => !!process.env.ANTHROPIC_API_KEY,
    handle: async ({ config }) => {
      const query = (config.query ?? '').trim();
      if (!query) throw new Error('web_search: `query` is required');
      return await runWebSearch(llm, query, {
        count: Math.min(Math.max(1, Number(config.max_results) || 5), 10),
        depth: config.depth ?? 'standard',
      });
    },
  });

  registry.register({
    id:          'web_fetch',
    connector:   'web',
    name:        'Fetch web page',
    description: 'Fetch a URL and extract its readable content using Mozilla Readability (Firefox Reader Mode). Returns title, author, and clean article text.',
    positions:   ['step'],
    configSchema: [
      { key: 'url', label: 'URL', type: 'text', hint: 'The full URL to fetch.' },
    ],
    isReady: () => true,
    handle: async ({ config }) => {
      const url = (config.url ?? '').trim();
      if (!url) throw new Error('web_fetch: `url` is required');
      return await runWebFetch(url);
    },
  });
}

export const WEB_CAPABILITY_IDS = new Set(['web_search', 'web_fetch']);

export function webConnectionStatus() {
  const anthropic = !!process.env.ANTHROPIC_API_KEY;
  return {
    connected: anthropic,
    anthropic,
    detail: anthropic
      ? 'Gives workflows live access to the web — search for current information or fetch and read content from any URL.'
      : 'Set ANTHROPIC_API_KEY to enable web search.',
  };
}
