/**
 * BaseRetriever — pluggable retrieval interface.
 *
 * All retriever implementations (HybridRetriever, RagFusionRetriever, or
 * any vertical-specific retriever) must implement this interface. The
 * framework routes through BaseRetriever so the data source can be swapped
 * by providing a different implementation — no framework code changes.
 *
 * Usage:
 *   class LegalClauseRetriever extends BaseRetriever {
 *     async search(query, queryEmbedding, k, options) {
 *       // clause-level chunking + legal stopwords + BM25L
 *       return [{ pageContent, metadata, score }];
 *     }
 *   }
 *
 *   const agent = new AgentGraph({ retriever: new LegalClauseRetriever() });
 *
 * @module src/rag/base-retriever.js
 */

export class BaseRetriever {
  /**
   * Search for relevant chunks.
   *
   * @param {string}   query          - Raw query text
   * @param {number[]} queryEmbedding - Query embedding vector
   * @param {number}   [k=6]          - Number of results to return
   * @param {object}   [options={}]   - Implementation-specific options (filter, etc.)
   * @returns {Promise<Array<{ pageContent: string, metadata: object, score: number }>>}
   */
  async search(query, queryEmbedding, k = 6, options = {}) {
    throw new Error(`${this.constructor.name} must implement search()`);
  }

  /**
   * Optional: access to the underlying vector store for same-source expansion
   * and other advanced operations. Return null if not applicable.
   * @returns {object|null}
   */
  get vectorStore() {
    return null;
  }
}

export default BaseRetriever;
