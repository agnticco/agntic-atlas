/**
 * VectorStore — in-memory vector store with cosine similarity search
 *
 * Stores { text, embedding, metadata } entries and retrieves the top-K
 * most similar entries for a given query embedding.
 *
 * Persistence: SQLite (default) or legacy FileStore/MemoryStore.
 * SQLite mode writes immediately on add/remove — no persist() needed.
 * Loads all vectors into memory on load() for fast cosine search.
 *
 * @module src/rag/vector-store.js
 */

import { MemoryStore } from '../memory/stores.js';
import { SqliteVectorBackend } from './sqlite-vector-backend.js';

export class VectorStore {
  /**
   * @param {object} [options]
   * @param {string} [options.sqlitePath]   - Path to SQLite database (preferred)
   * @param {object} [options.store]        - Legacy: MemoryStore or FileStore
   * @param {string} [options.storeKey]     - Legacy: key for FileStore persistence
   */
  constructor(options = {}) {
    this._entries = [];
    this._nextId  = 0;

    if (options.sqlitePath) {
      this._sqlite  = new SqliteVectorBackend(options.sqlitePath);
      this.store    = null;
      this.storeKey = null;
    } else {
      this._sqlite  = null;
      this.store    = options.store ?? new MemoryStore();
      this.storeKey = options.storeKey ?? 'vectors';
    }
  }

  /**
   * Add chunks and their embeddings to the store.
   * @param {object[]} chunks     - [{ pageContent, metadata }]
   * @param {number[][]} embeddings - Parallel array of float vectors
   */
  async add(chunks, embeddings) {
    if (chunks.length !== embeddings.length) {
      throw new Error('VectorStore.add: chunks and embeddings must have the same length');
    }

    const newEntries = [];
    for (let i = 0; i < chunks.length; i++) {
      const entry = {
        id:          this._nextId++,
        pageContent: chunks[i].pageContent,
        metadata:    chunks[i].metadata ?? {},
        embedding:   embeddings[i],
      };
      this._entries.push(entry);
      newEntries.push(entry);
    }

    if (this._sqlite) {
      this._sqlite.insertMany(newEntries);
    } else {
      await this.persist();
    }
  }

  /**
   * Find the top-K most similar entries for a query embedding.
   * @param {number[]} queryEmbedding
   * @param {number}   [k=4]
   * @param {object}   [options]
   * @param {boolean}  [options.includeEmbeddings=false]
   * @param {Function} [options.filter]
   * @returns {{ pageContent: string, metadata: object, score: number, embedding?: number[] }[]}
   */
  search(queryEmbedding, k = 4, { includeEmbeddings = false, filter } = {}) {
    if (this._entries.length === 0) return [];

    const entries = filter ? this._entries.filter(filter) : this._entries;

    return entries
      .map(entry => {
        const result = {
          pageContent: entry.pageContent,
          metadata:    entry.metadata,
          score:       cosineSimilarity(queryEmbedding, entry.embedding),
        };
        if (includeEmbeddings) result.embedding = entry.embedding;
        return result;
      })
      .filter(r => isFinite(r.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /** Number of chunks currently stored */
  get size() {
    return this._entries.length;
  }

  /** Read-only access to all entries — used by HybridRetriever for BM25 index */
  get entries() {
    return this._entries;
  }

  /**
   * Remove all entries where metadata[key] === value.
   * @param {string} key
   * @param {string} value
   * @returns {number} count of removed entries
   */
  async removeByMeta(key, value) {
    const before  = this._entries.length;
    this._entries = this._entries.filter(e => e.metadata?.[key] !== value);
    const removed = before - this._entries.length;

    if (removed > 0) {
      if (this._sqlite) {
        this._sqlite.deleteByMeta(key, value);
      } else {
        await this.persist();
      }
    }
    return removed;
  }

  /** Remove all entries */
  async clear() {
    this._entries = [];
    this._nextId  = 0;
    if (this._sqlite) {
      this._sqlite.deleteAll();
    } else {
      await this.store.delete(this.storeKey);
    }
  }

  /** Write current entries to the store (no-op for SQLite — writes are immediate) */
  async persist() {
    if (this._sqlite) return;
    await this.store.save(this.storeKey, {
      entries: this._entries,
      nextId:  this._nextId,
    });
  }

  /** Load entries from the store into memory */
  async load() {
    if (this._sqlite) {
      const state = this._sqlite.loadAll();
      this._entries = state.entries;
      this._nextId  = state.nextId;
      return;
    }
    // Legacy FileStore/MemoryStore path
    const state = await this.store.load(this.storeKey);
    if (state) {
      this._entries = state.entries ?? [];
      this._nextId  = state.nextId ?? this._entries.length;
    }
  }
}

// ── Math ──────────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export default VectorStore;
