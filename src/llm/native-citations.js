/**
 * native-citations.js — bridge between Anthropic's native web_search response
 * shape and the SSE wire format the agent emits via the <agntic-sources>
 * sentinel.
 *
 * Phase 4 of the native-web_search migration. Phase 5 will call this from
 * agent-graph after a server-side web_search turn to populate state.web_sources
 * and the rendered text the user sees.
 *
 * @module src/llm/native-citations.js
 */

/**
 * Convert Anthropic native web_search output into the legacy source shape used
 * by the frontend (public/js/components/message.js).
 *
 * Inputs come from a ChatModel AIMessage's additionalKwargs (Phase 2):
 *   - serverToolBlocks  : additionalKwargs._serverToolBlocks
 *   - anthropicContent  : additionalKwargs._anthropicContent
 *
 * Output:
 *   {
 *     sources: [{
 *       url, title, snippet, page_age,
 *       cited_snippets: [{ cited_text }]   // distinct fragments that cited this URL
 *     }],
 *     text: string                          // text from anthropicContent with [N]
 *                                           // markers appended at the end of each
 *                                           // text block that cited a source
 *   }
 *
 * Source ordering: first appearance in the search results, deduped by URL.
 * Citation markers: 1-indexed [N] where N = source position + 1, deduped per
 * text block (no [1][1][1] repeats within a single block, but the same source
 * can be cited again in a later block).
 *
 * The output `text` is contract-compatible with the existing
 * injectInlineCitations regex walker — no frontend changes are required for
 * inline citations to keep working.
 *
 * @param {Array<object>} [serverToolBlocks=[]] - blocks of type
 *   `web_search_tool_result` (and optionally `server_tool_use`); the latter is
 *   ignored for source extraction but harmless to include.
 * @param {Array<object>} [anthropicContent=[]] - the full Anthropic content
 *   array; only blocks of type `text` are read.
 * @returns {{ sources: Array<object>, text: string }}
 */
export function mapNativeWebSources(serverToolBlocks = [], anthropicContent = []) {
  // Step 1 — collect sources from web_search_tool_result and web_fetch_tool_result
  // blocks. First-seen order, deduped by URL.
  //
  // web_search_tool_result: content is an array of {type:'web_search_result', url, title, page_age, ...}
  // web_fetch_tool_result:  content is a single {type:'web_fetch_result', url, content:{title,...}, retrieved_at}
  const sourcesByUrl = new Map();
  const addSource = (entry) => {
    if (!entry?.url || sourcesByUrl.has(entry.url)) return;
    sourcesByUrl.set(entry.url, {
      url:            entry.url,
      title:          entry.title ?? '',
      snippet:        '',
      page_age:       entry.page_age ?? null,
      cited_snippets: [],
    });
  };

  for (const block of serverToolBlocks) {
    if (block?.type === 'web_search_tool_result') {
      const results = Array.isArray(block.content) ? block.content : [];
      for (const r of results) {
        if (r?.type !== 'web_search_result' || !r.url) continue;
        addSource({ url: r.url, title: r.title, page_age: r.page_age });
      }
    } else if (block?.type === 'web_fetch_tool_result') {
      const r = block.content;
      if (r?.type === 'web_fetch_result' && r.url) {
        const title = r.content?.title ?? '';
        addSource({ url: r.url, title, page_age: r.retrieved_at });
      }
    }
  }
  const sources    = [...sourcesByUrl.values()];
  const indexByUrl = new Map(sources.map((s, i) => [s.url, i]));

  // Step 2 — walk text blocks, splice [N] markers, attach cited_snippets.
  const textParts = [];
  for (const block of anthropicContent) {
    if (block?.type !== 'text') continue;
    const text = block.text ?? '';
    textParts.push(text);

    const cites = Array.isArray(block.citations) ? block.citations : [];
    if (cites.length === 0) continue;

    const seenInBlock = new Set();
    for (const c of cites) {
      const idx = c?.url ? indexByUrl.get(c.url) : undefined;
      if (idx === undefined) continue;

      // Append [N] marker once per (block, source) pair.
      if (!seenInBlock.has(idx)) {
        textParts.push(`[${idx + 1}]`);
        seenInBlock.add(idx);
      }

      // Record the cited fragment, deduped by literal cited_text.
      const fragment = c.cited_text;
      if (fragment) {
        const seen = sources[idx].cited_snippets.some(s => s.cited_text === fragment);
        if (!seen) sources[idx].cited_snippets.push({ cited_text: fragment });
      }
    }
  }

  return {
    sources,
    text: textParts.join(''),
  };
}
