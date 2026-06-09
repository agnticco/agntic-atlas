/**
 * RagFusionRetriever — multi-query retrieval with Reciprocal Rank Fusion
 *
 * Implements RAG Fusion on top of HybridRetriever:
 *
 *   1. Generate N query variants from the original query using an LLM.
 *      Each variant rephrases the same information need with different vocabulary,
 *      improving recall across embedding and BM25 spaces.
 *
 *   2. Embed each variant and run HybridRetriever on each.
 *
 *   3. Pool all result sets and re-rank with RRF across the full candidate pool.
 *      This promotes chunks that rank well across multiple query perspectives.
 *
 * Why this helps:
 *   A single query like "which region underperformed" may miss chunks that use
 *   "South region miss", "below-target attainment", or "Q1 shortfall". Generating
 *   variants and fusing their results gives much broader recall without needing
 *   a larger k on a single retrieval pass.
 *
 * Falls back to single-query HybridRetriever when no LLM is provided.
 *
 * @module src/rag/rag-fusion-retriever.js
 */

import { BaseRetriever } from './base-retriever.js';
import { log } from '../utils/logger.js';

const RRF_K        = 60;
const NUM_VARIANTS = 3;   // additional variants beyond the original query
const FETCH_MULT   = 3;   // per-variant fetch multiplier before fusion (fetch k*3, return k)

// ── Query variant generation ───────────────────────────────────────────────────

const VARIANT_PROMPT = (query, n) =>
  `Generate ${n} alternative search queries that express the same information need as the query below. ` +
  `Use different vocabulary and phrasing for each to maximize retrieval coverage. ` +
  `Output exactly ${n} queries, one per line, no numbering, no bullets, no explanation.\n\n` +
  `Query: ${query}\n\nVariants:`;

async function generateVariants(llm, query, n) {
  try {
    const response = await llm.invoke(VARIANT_PROMPT(query, n));
    const text     = typeof response === 'string' ? response : response.content ?? '';
    const variants = text
      .split('\n')
      .map(l => l.replace(/^[\d\-\.\*\s]+/, '').trim())
      .filter(l => l.length > 10 && l.length < 300)
      .slice(0, n);
    return variants;
  } catch {
    return [];
  }
}

// ── RRF fusion across multiple result sets ────────────────────────────────────

/**
 * Fuse multiple ranked result arrays using Reciprocal Rank Fusion.
 *
 * Score for each document: Σ 1 / (k + rank)
 * Chunks that appear near the top of multiple result sets score highest.
 *
 * @param {Array<Array>} resultSets  - One array of ranked chunks per query
 * @param {number}       [k=60]     - RRF constant
 * @returns {Array} Fused and sorted chunks with normalized scores
 */
function rrfFuse(resultSets, k = RRF_K) {
  const scores = new Map();
  const chunks  = new Map();

  for (const results of resultSets) {
    for (let rank = 0; rank < results.length; rank++) {
      const chunk = results[rank];
      // Stable identity: source path + chunk index if available, else first 80 chars
      const id = (chunk.metadata?.source ?? '') + '::' +
                 (chunk.metadata?.chunk_index ?? chunk.text?.slice(0, 80) ?? rank);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
      if (!chunks.has(id)) chunks.set(id, chunk);
    }
  }

  const maxScore = 2 / (k + 1); // theoretical max: rank-1 in all sets
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...chunks.get(id), score: score / maxScore }));
}

// ── RagFusionRetriever ────────────────────────────────────────────────────────

export class RagFusionRetriever extends BaseRetriever {
  /**
   * @param {object} options
   * @param {object} options.hybridRetriever  - HybridRetriever instance (REQUIRED)
   * @param {object} options.embedModel       - EmbeddingModel instance (REQUIRED)
   * @param {object} [options.llm]            - LLM for variant generation (falls back to single-query if absent)
   * @param {number} [options.numVariants=3]  - Number of additional query variants to generate
   * @param {boolean} [options.verbose=false]
   */
  constructor({ hybridRetriever, embedModel, llm = null, numVariants = NUM_VARIANTS, verbose = false } = {}) {
    super();
    if (!hybridRetriever) throw new Error('RagFusionRetriever requires a hybridRetriever');
    if (!embedModel)      throw new Error('RagFusionRetriever requires an embedModel');

    this.hybridRetriever = hybridRetriever;
    this.embedModel      = embedModel;
    this.llm             = llm;
    this.numVariants     = numVariants;
    this.verbose         = verbose;
  }

  /** @override — delegate to the underlying HybridRetriever's store. */
  get vectorStore() {
    return this.hybridRetriever?.vectorStore ?? null;
  }

  /**
   * Multi-query hybrid search with RRF fusion.
   * Matches the HybridRetriever.search() call signature for drop-in use.
   *
   * @param {string}   query          - Original query text
   * @param {number[]} queryEmbedding - Embedding of the original query
   * @param {number}   [k=6]          - Final chunks to return after fusion
   * @param {object}   [options={}]   - Passed through to HybridRetriever.search()
   * @returns {Array} Top-k fused chunks sorted by RRF score
   */
  async search(query, queryEmbedding, k = 6, options = {}) {
    // No LLM — single-query fallback
    if (!this.llm) {
      return this.hybridRetriever.search(query, queryEmbedding, k, options);
    }

    // Generate query variants (non-blocking — if generation fails we still have the original)
    const variants = await generateVariants(this.llm, query, this.numVariants);
    const allQueries = [query, ...variants];

    if (this.verbose) {
      log.info(`[RagFusion] ${allQueries.length} queries: ${allQueries.join(', ')}`);
    }

    // Embed variants and run hybrid retrieval on each in parallel
    const fetchK = Math.max(k * FETCH_MULT, 10);
    const resultSets = await Promise.all(
      allQueries.map(async (q, i) => {
        try {
          // Original query already has its embedding — re-use it
          const qVec = i === 0 ? queryEmbedding : await this.embedModel.invoke(q);
          return this.hybridRetriever.search(q, qVec, fetchK, options);
        } catch {
          return [];
        }
      })
    );

    // Fuse all result sets with RRF and return top-k
    const fused = rrfFuse(resultSets);

    if (this.verbose) {
      log.info(`[RagFusion] fused ${fused.length} candidates → returning top ${k}`);
    }

    return fused.slice(0, k);
  }
}

export default RagFusionRetriever;
