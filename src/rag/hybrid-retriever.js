/**
 * HybridRetriever — dense vector + BM25 sparse search with Reciprocal Rank Fusion
 *
 * Combines two complementary retrieval signals:
 *
 *   Dense  — cosine similarity on embeddings.
 *            Strong on semantic/conceptual queries. Weak on exact terms.
 *
 *   Sparse — BM25 keyword scoring.
 *            Strong on exact names, IDs, codes, rare words. Weak on paraphrases.
 *
 * Results from both paths are merged with Reciprocal Rank Fusion (RRF):
 *
 *   rrf_score(doc) = Σ  1 / (k + rank(doc))
 *
 * where k=60 is the standard RRF constant. No per-path weight tuning needed.
 *
 * The BM25 index is built lazily from VectorStore entries and rebuilt
 * automatically whenever the store size changes (e.g. after ingest or
 * conversation messages are added).
 *
 * Usage:
 *   const retriever = new HybridRetriever({ vectorStore });
 *   const chunks    = retriever.search(query, queryEmbedding, k, { filter });
 *
 * @module src/rag/hybrid-retriever.js
 */

import { BM25Index }     from './bm25-index.js';
import { BaseRetriever } from './base-retriever.js';

const RRF_K = 60;

// Maximum possible RRF score: rank-1 in both dense and sparse paths.
// Used to normalize scores to [0, 1] so callers can apply the same
// threshold semantics as cosine similarity (e.g. MIN_CONTEXT_SCORE).
const RRF_MAX = 2 / (RRF_K + 1);

export class HybridRetriever extends BaseRetriever {
  /**
   * @param {object} options
   * @param {object} options.vectorStore  - VectorStore instance (REQUIRED)
   * @param {number} [options.fetchK]     - Candidates per path before fusion (default k*3)
   * @param {number} [options.bm25k1=1.5] - BM25 k1 parameter
   * @param {number} [options.bm25b=0.75] - BM25 b parameter
   */
  constructor({ vectorStore, fetchK, bm25k1 = 1.5, bm25b = 0.75 } = {}) {
    super();
    if (!vectorStore) throw new Error('HybridRetriever requires a vectorStore');

    this._vectorStore = vectorStore;
    this._fetchK      = fetchK ?? null;  // null = auto (k*3)
    this._bm25        = new BM25Index({ k1: bm25k1, b: bm25b });
    this._indexedSize = -1;
  }

  /** @override — expose the underlying store for same-source expansion. */
  get vectorStore() {
    return this._vectorStore;
  }

  /**
   * Hybrid search — dense + BM25 fused with RRF.
   *
   * @param {string}   query          - Raw query text for BM25
   * @param {number[]} queryEmbedding - Query vector for dense search
   * @param {number}   [k=6]          - Final chunks to return
   * @param {object}   [options]
   * @param {boolean}  [options.includeEmbeddings=false] - Attach embeddings (needed for MMR)
   * @param {Function} [options.filter]                  - Metadata filter predicate
   * @returns {{ text: string, metadata: object, score: number, embedding?: number[] }[]}
   */
  search(query, queryEmbedding, k = 6, { includeEmbeddings = false, filter } = {}) {
    this._ensureIndex();
    if (this.vectorStore.size === 0) return [];

    const fetchK = this._fetchK ?? Math.max(k * 3, 20);

    // ── Dense path ──────────────────────────────────────────────────────────
    const denseResults = this.vectorStore.search(
      queryEmbedding,
      fetchK,
      { includeEmbeddings, filter }
    );

    // ── Sparse path ─────────────────────────────────────────────────────────
    // BM25 returns { id, score } — resolve back to full entries
    const sparseRaw = this._bm25.search(query, fetchK);
    const entryById = new Map(this.vectorStore.entries.map(e => [e.id, e]));

    const sparseResults = sparseRaw
      .map(({ id }) => entryById.get(id))
      .filter(Boolean)
      .filter(entry => !filter || filter(entry))
      .map(entry => ({
        pageContent: entry.pageContent ?? entry.text,
        metadata:    entry.metadata,
        score:       0,
        ...(includeEmbeddings ? { embedding: entry.embedding } : {}),
      }));

    // ── RRF fusion ──────────────────────────────────────────────────────────
    // Use pageContent as dedup key — chunks are unique text segments within the store
    const fused = new Map(); // pageContent → { chunk, rrf }

    const applyRRF = (results) => {
      for (let rank = 0; rank < results.length; rank++) {
        const chunk = results[rank];
        const key   = chunk.pageContent;
        if (!fused.has(key)) fused.set(key, { chunk, rrf: 0 });
        fused.get(key).rrf += 1 / (RRF_K + rank + 1);
      }
    };

    applyRRF(denseResults);
    applyRRF(sparseResults);

    return Array.from(fused.values())
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, k)
      .map(({ chunk, rrf }) => ({ ...chunk, score: rrf / RRF_MAX }));
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Rebuild BM25 index if the vector store has grown since last build.
   * Called automatically at the start of each search.
   */
  _ensureIndex() {
    if (this.vectorStore.size === this._indexedSize) return;
    this._bm25.build(this.vectorStore.entries);
    this._indexedSize = this.vectorStore.size;
  }
}

export default HybridRetriever;
