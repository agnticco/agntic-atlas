/**
 * RAGChain — standalone Retrieval-Augmented Generation pipeline
 *
 * Convenience class that wires Retriever → context injection → LLM.
 * Use this for one-shot RAG queries outside of MemoryManager.
 *
 * For agent deployments that need RAG across a full conversation,
 * use VectorMemory inside MemoryManager instead — it integrates
 * automatically with the agent's memory layer.
 *
 * @module src/rag/rag-chain.js
 */

import { Runnable } from '../core/runnable.js';
import { SystemMessage, HumanMessage } from '../core/message.js';

const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant. Answer the user\'s question using ONLY the provided context.\n' +
  'If the answer is not in the context, say "I don\'t have that information in my knowledge base."\n' +
  'Do not use prior knowledge. Cite sources by referencing [1], [2], etc. when relevant.';

export class RAGChain extends Runnable {
  /**
   * @param {object} options
   * @param {object} options.retriever      - Retriever instance (REQUIRED)
   * @param {object} options.llm            - LlamaCppLLM or ChatModel instance (REQUIRED)
   * @param {string} [options.systemPrompt] - System prompt prefix (before context)
   */
  constructor(options = {}) {
    super();

    if (!options.retriever) throw new Error('RAGChain requires a retriever option');
    if (!options.llm)       throw new Error('RAGChain requires an llm option');

    this.retriever    = options.retriever;
    this.llm          = options.llm;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  /**
   * Run a RAG query: retrieve → inject context → generate answer.
   * @param {string} query
   * @returns {Promise<string>}
   */
  async _call(query) {
    const chunks   = await this.retriever.invoke(query);
    const messages = this._buildMessages(query, chunks);
    const response = await this.llm.invoke(messages);
    return response.content;
  }

  /**
   * Streaming variant — yields text tokens as they arrive.
   * @param {string} query
   * @yields {string}
   */
  async* stream(query, config = {}) {
    const chunks   = await this.retriever.invoke(query);
    const messages = this._buildMessages(query, chunks);

    for await (const chunk of this.llm.stream(messages, config)) {
      yield chunk.content;
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _buildMessages(query, chunks) {
    const context = formatChunks(chunks);
    const systemContent = context
      ? `${this.systemPrompt}\n\nCONTEXT:\n${context}`
      : this.systemPrompt;

    return [
      new SystemMessage(systemContent),
      new HumanMessage(query),
    ];
  }
}

/**
 * Format retrieved chunks into a numbered context block.
 * Includes source metadata when available.
 * @param {object[]} chunks - ScoredChunk[]
 * @returns {string}
 */
export function formatChunks(chunks) {
  if (!chunks || chunks.length === 0) return '';

  return chunks
    .map((chunk, i) => {
      const source = chunk.metadata?.source
        ? `Source: ${chunk.metadata.source}\n`
        : '';
      return `[${i + 1}] ${source}${chunk.pageContent}`;
    })
    .join('\n\n---\n\n');
}

export default RAGChain;
