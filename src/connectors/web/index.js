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
import dns                   from 'node:dns/promises';
import { lookup as dnsLookup } from 'node:dns';
import net                   from 'node:net';
import { Agent }             from 'undici';
import { SystemMessage, HumanMessage } from '../../core/message.js';
import { mapNativeWebSources }         from '../../llm/native-citations.js';

// ── SSRF guard ───────────────────────────────────────────────────────────────
// web_fetch takes a user/workflow-controlled URL. Without this a workflow could
// point it at cloud metadata (169.254.169.254 → IAM creds), loopback, or private
// network services and read the response back. We reject non-http(s) schemes and
// any host that is — or resolves to — a private/reserved address, and re-check on
// every redirect hop. (Residual: DNS-rebinding TOCTOU between this lookup and the
// socket connect is not covered; would require pinning the resolved IP.)
const MAX_REDIRECTS = 5;

function ipToLong(ip) { return ip.split('.').reduce((a, o) => ((a << 8) + parseInt(o, 10)) >>> 0, 0); }
function v4Blocked(ip) {
  const n = ipToLong(ip);
  const inRange = (base, bits) => (n >>> (32 - bits)) === (ipToLong(base) >>> (32 - bits));
  return inRange('0.0.0.0', 8) || inRange('10.0.0.0', 8) || inRange('100.64.0.0', 10) ||
         inRange('127.0.0.0', 8) || inRange('169.254.0.0', 16) || inRange('172.16.0.0', 12) ||
         inRange('192.0.0.0', 24) || inRange('192.168.0.0', 16) || inRange('198.18.0.0', 15) ||
         n >= ipToLong('224.0.0.0'); // 224.0.0.0/3 — multicast + reserved
}
function ipBlocked(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) {
    const lc = ip.toLowerCase();
    if (lc === '::1' || lc === '::') return true;                 // loopback / unspecified
    if (lc.startsWith('fe8') || lc.startsWith('fe9') || lc.startsWith('fea') || lc.startsWith('feb')) return true; // fe80::/10 link-local
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true;  // fc00::/7 unique-local
    const mapped = lc.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);  // IPv4-mapped
    if (mapped) return v4Blocked(mapped[1]);
    return false;
  }
  return true; // not a recognised IP → block
}
async function assertPublicUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('web_fetch: invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('web_fetch: only http(s) URLs are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (ipBlocked(host)) throw new Error('web_fetch: refusing to fetch a private/reserved address');
    return;
  }
  const lc = host.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local') || lc.endsWith('.internal')) {
    throw new Error('web_fetch: refusing to fetch a local address');
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error(`web_fetch: could not resolve ${host}`); }
  for (const a of addrs) if (ipBlocked(a.address)) throw new Error('web_fetch: host resolves to a private/reserved address');
}

// Connect-time DNS validation: undici calls this to resolve a hostname right
// before opening the socket, so the IP we validate is the exact IP connected to
// — closing the DNS-rebinding TOCTOU where a hostname resolves "public" during
// assertPublicUrl but "private" at connect time. (Literal-IP URLs skip lookup,
// so assertPublicUrl still guards those.)
function guardedLookup(hostname, options, callback) {
  dnsLookup(hostname, { all: true, family: options?.family ?? 0, hints: options?.hints }, (err, addresses) => {
    if (err) return callback(err);
    for (const a of addresses) {
      if (ipBlocked(a.address)) return callback(new Error('web_fetch: host resolves to a private/reserved address'));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}
const ssrfDispatcher = new Agent({ connect: { lookup: guardedLookup } });

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

async function runWebSearch(llm, query, { count = 5, depth = 'standard', sessionId, costContext } = {}) {
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
    { configurable: { modelTier: tier, sessionId: sessionId ?? undefined, costContext: costContext ?? 'web_search' }, tools: [{ ...NATIVE_WEB_SEARCH }] },
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
  // Follow redirects manually so each hop is SSRF-checked (a public URL can 3xx
  // to an internal one).
  let current = url, res, hops = 0;
  for (;;) {
    await assertPublicUrl(current);
    res = await fetch(current, {
      headers: { 'User-Agent': 'AtlasWorkflow/1.0 (Mozilla/5.0 compatible)' },
      redirect: 'manual',
      dispatcher: ssrfDispatcher, // connect-time IP re-validation (anti-rebinding)
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) break;
    if (++hops > MAX_REDIRECTS) throw new Error('web_fetch: too many redirects');
    current = new URL(location, current).toString();
  }
  if (!res.ok) throw new Error(`web_fetch: HTTP ${res.status} fetching ${url}`);
  const html = await res.text();

  const dom     = new JSDOM(html, { url: current });
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
    handle: async ({ config, sessionId, costContext }) => {
      const query = (config.query ?? '').trim();
      if (!query) throw new Error('web_search: `query` is required');
      return await runWebSearch(llm, query, {
        count: Math.min(Math.max(1, Number(config.max_results) || 5), 10),
        depth: config.depth ?? 'standard',
        sessionId,
        costContext,
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
