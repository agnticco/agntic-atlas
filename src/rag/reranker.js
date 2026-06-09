/**
 * Reranker — post-retrieval chunk filtering and reranking
 *
 * Improves retrieval quality by applying a second-pass filter or reranking
 * strategy on top of the initial cosine similarity results from VectorStore.
 *
 * Two strategies:
 *
 *   'threshold' — Denoising. Drops chunks whose score falls below minScore.
 *                 Prevents irrelevant chunks from polluting the LLM context.
 *                 Fast, no extra compute beyond what Retriever already did.
 *
 *   'mmr'       — Maximal Marginal Relevance. Re-ranks chunks to balance
 *                 relevance (similarity to query) against diversity (dissimilarity
 *                 to already-selected chunks). Prevents redundant near-duplicate
 *                 chunks from occupying all k slots.
 *
 *                 MMR score = λ · sim(chunk, query) − (1−λ) · max sim(chunk, selected)
 *
 *                 λ=1.0 → pure relevance (identical to original ranking)
 *                 λ=0.0 → pure diversity
 *                 λ=0.5 → balanced (default)
 *
 *                 Requires chunks to include embeddings (pass includeEmbeddings:true
 *                 to VectorStore.search, or use Retriever with reranker attached).
 *
 * Usage via Retriever (recommended):
 *   const reranker  = new Reranker({ strategy: 'mmr', lambda: 0.6, minScore: 0.5 });
 *   const retriever = new Retriever({ vectorStore, embedModel, k: 4, fetchK: 20, reranker });
 *
 * Standalone usage:
 *   const reranked = reranker.rerank({ chunks, queryEmbedding, k: 4 });
 *
 * @module src/rag/reranker.js
 */

import { Runnable } from '../core/runnable.js';

export class Reranker extends Runnable {
  /**
   * @param {object} [options]
   * @param {string} [options.strategy='mmr']   - 'mmr' | 'threshold'
   * @param {number} [options.lambda=0.5]       - MMR relevance/diversity balance (0–1)
   * @param {number} [options.minScore=0.0]     - Minimum score threshold (both strategies)
   */
  constructor(options = {}) {
    super();
    this.strategy = options.strategy ?? 'mmr';
    this.lambda   = options.lambda   ?? 0.5;
    this.minScore = options.minScore ?? 0.0;

    if (!['mmr', 'threshold'].includes(this.strategy)) {
      throw new Error(`Reranker: unknown strategy "${this.strategy}". Use 'mmr' or 'threshold'`);
    }
  }

  /**
   * Rerank and/or filter a set of retrieved chunks.
   *
   * Called by Retriever automatically when attached.
   * Can also be called directly for custom pipelines.
   *
   * @param {object}   options
   * @param {object[]} options.chunks          - Scored chunks from VectorStore.search
   *                                             (must include .embedding for MMR strategy)
   * @param {number[]} options.queryEmbedding  - Query embedding vector
   * @param {number}   [options.k]             - Max chunks to return (defaults to chunks.length)
   * @returns {object[]} Reranked/filtered chunks (without .embedding field)
   */
  rerank({ chunks, queryEmbedding, k }) {
    const limit = k ?? chunks.length;

    // Always apply score threshold first
    let candidates = this.minScore > 0
      ? chunks.filter(c => c.score >= this.minScore)
      : chunks;

    if (candidates.length === 0) return [];

    let result;
    if (this.strategy === 'threshold') {
      result = candidates.slice(0, limit);
    } else {
      result = this._mmr(candidates, queryEmbedding, limit);
    }

    // Strip embeddings from output — they're internal, not needed downstream
    return result.map(({ embedding: _emb, ...chunk }) => chunk);
  }

  /**
   * Runnable interface — accepts { chunks, queryEmbedding, k } object.
   * @param {{ chunks: object[], queryEmbedding: number[], k?: number }} input
   * @returns {object[]}
   */
  _call(input) {
    return this.rerank(input);
  }

  // ── MMR ──────────────────────────────────────────────────────────────────

  /**
   * Maximal Marginal Relevance selection.
   * Greedily picks the next chunk that maximises:
   *   λ · sim(chunk, query) − (1−λ) · max sim(chunk, already_selected)
   *
   * @private
   */
  _mmr(candidates, queryEmbedding, k) {
    const selected  = [];
    const remaining = [...candidates];

    while (selected.length < k && remaining.length > 0) {
      let bestScore = -Infinity;
      let bestIdx   = 0;

      for (let i = 0; i < remaining.length; i++) {
        const chunk      = remaining[i];
        const relevance  = chunk.score; // sim(chunk, query) — already computed

        // Redundancy: max similarity to any already-selected chunk
        const redundancy = selected.length === 0
          ? 0
          : Math.max(...selected.map(s => cosineSimilarity(chunk.embedding, s.embedding)));

        const mmrScore = this.lambda * relevance - (1 - this.lambda) * redundancy;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIdx   = i;
        }
      }

      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    }

    return selected;
  }
}

// ── Cosine similarity (local copy — avoids circular import with vector-store) ──

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export default Reranker;
