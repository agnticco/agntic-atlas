/**
 * BM25Index — sparse keyword index for hybrid search
 *
 * Implements Okapi BM25 scoring over a corpus of text chunks.
 * Used alongside dense vector search in HybridRetriever to give hybrid
 * retrieval that handles exact terms, names, IDs, and rare words that
 * embedding models may score poorly.
 *
 * BM25 score for query term q in document D:
 *   IDF(q) * TF(q,D) * (k1+1) / (TF(q,D) + k1*(1 - b + b*|D|/avgdl))
 *
 * Standard parameters:
 *   k1 = 1.5  — term frequency saturation
 *   b  = 0.75 — document length normalization
 *
 * @module src/rag/bm25-index.js
 */

export class BM25Index {
  /**
   * @param {object} [options]
   * @param {number} [options.k1=1.5] - Term frequency saturation
   * @param {number} [options.b=0.75] - Document length normalization
   */
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b  = b;

    this._docs         = [];  // [{ id, length }]
    this._invertedIdx  = {};  // { term: [{ docIdx, freq }] }
    this._avgdl        = 0;
  }

  /**
   * Build the index from an array of VectorStore entries.
   * Replaces any existing index.
   * @param {{ id: *, text: string }[]} entries
   */
  build(entries) {
    this._docs        = [];
    this._invertedIdx = {};

    for (const entry of entries) {
      const tokens  = tokenize(entry.pageContent ?? entry.text ?? '');
      const docIdx  = this._docs.length;
      this._docs.push({ id: entry.id, length: tokens.length });

      // Count term frequencies for this document
      const tf = {};
      for (const token of tokens) tf[token] = (tf[token] ?? 0) + 1;

      for (const [term, freq] of Object.entries(tf)) {
        if (!this._invertedIdx[term]) this._invertedIdx[term] = [];
        this._invertedIdx[term].push({ docIdx, freq });
      }
    }

    const N = this._docs.length;
    this._avgdl = N > 0
      ? this._docs.reduce((sum, d) => sum + d.length, 0) / N
      : 0;
  }

  /**
   * Score all indexed documents against a query string.
   * Returns top-K results sorted by BM25 score descending.
   * @param {string} query
   * @param {number} [k=10]
   * @returns {{ id: *, score: number }[]}
   */
  search(query, k = 10) {
    const N = this._docs.length;
    if (N === 0) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const scores = new Float64Array(N);

    for (const qToken of queryTokens) {
      const postings = this._invertedIdx[qToken];
      if (!postings) continue;

      const df  = postings.length;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const { docIdx, freq } of postings) {
        const dl = this._docs[docIdx].length;
        const tf = freq * (this.k1 + 1)
          / (freq + this.k1 * (1 - this.b + this.b * dl / this._avgdl));
        scores[docIdx] += idf * tf;
      }
    }

    // Collect non-zero scores and sort
    const results = [];
    for (let i = 0; i < N; i++) {
      if (scores[i] > 0) results.push({ id: this._docs[i].id, score: scores[i] });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }

  /** Number of indexed documents */
  get size() {
    return this._docs.length;
  }
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Lowercase, split on non-alphanumeric, drop tokens shorter than 3 chars.
 * No stemming — keeps proper nouns and IDs intact.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3);
}

export default BM25Index;
