/**
 * SqliteVectorBackend — persistent vector storage via SQLite.
 *
 * Replaces the JSON file backend for vector stores. Handles any number
 * of vectors without hitting V8 string length limits. Embeddings are
 * stored as Float32 BLOBs (halves storage vs Float64).
 *
 * @module src/rag/sqlite-vector-backend.js
 */

import Database from 'better-sqlite3';

// ── Embedding serialization ──────────────────────────────────────────────────

function embedToBlob(embedding) {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer);
}

function blobToEmbed(buf) {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  return Array.from(f32);
}

// ── Backend class ────────────────────────────────────────────────────────────

export class SqliteVectorBackend {
  /**
   * @param {string} dbPath - Path to the SQLite database file
   */
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id          INTEGER PRIMARY KEY,
        pageContent TEXT    NOT NULL,
        metadata    TEXT    NOT NULL,
        embedding   BLOB   NOT NULL
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Prepared statements for hot paths
    this._insertStmt = this.db.prepare(
      'INSERT OR REPLACE INTO vectors (id, pageContent, metadata, embedding) VALUES (?, ?, ?, ?)'
    );
    this._deleteByIdStmt = this.db.prepare('DELETE FROM vectors WHERE id = ?');
    this._setMetaStmt = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    this._getMetaStmt = this.db.prepare('SELECT value FROM meta WHERE key = ?');
  }

  /**
   * Bulk insert entries. Uses a transaction for performance.
   * @param {Array<{id: number, pageContent: string, metadata: object, embedding: number[]}>} entries
   */
  insertMany(entries) {
    const tx = this.db.transaction((rows) => {
      for (const e of rows) {
        this._insertStmt.run(
          e.id,
          e.pageContent ?? e.text ?? '',
          JSON.stringify(e.metadata ?? {}),
          embedToBlob(e.embedding)
        );
      }
    });
    tx(entries);

    // Update nextId to max + 1
    const maxId = entries.reduce((m, e) => Math.max(m, e.id ?? 0), -1);
    const currentNext = this.getNextId();
    if (maxId + 1 > currentNext) {
      this.setNextId(maxId + 1);
    }
  }

  /**
   * Load all vectors into memory. Returns the same shape as the old JSON format.
   * @returns {{ entries: Array, nextId: number }}
   */
  loadAll() {
    const rows = this.db.prepare('SELECT id, pageContent, metadata, embedding FROM vectors').all();
    const entries = rows.map(row => ({
      id:          row.id,
      pageContent: row.pageContent,
      text:        row.pageContent,  // compat alias
      metadata:    JSON.parse(row.metadata),
      embedding:   blobToEmbed(row.embedding),
    }));

    return {
      entries,
      nextId: this.getNextId(),
    };
  }

  /**
   * Delete all vectors where metadata[key] === value.
   * @param {string} key
   * @param {*} value
   * @returns {number} count of deleted rows
   */
  deleteByMeta(key, value) {
    const result = this.db.prepare(
      `DELETE FROM vectors WHERE json_extract(metadata, '$.' || ?) = ?`
    ).run(key, String(value));
    return result.changes;
  }

  /**
   * Delete a single vector by ID.
   * @param {number} id
   */
  deleteById(id) {
    this._deleteByIdStmt.run(id);
  }

  /**
   * Delete all vectors and reset nextId.
   */
  deleteAll() {
    this.db.exec('DELETE FROM vectors');
    this.setNextId(0);
  }

  /**
   * Get the next available ID.
   * @returns {number}
   */
  getNextId() {
    const row = this._getMetaStmt.get('nextId');
    return row ? parseInt(row.value, 10) : 0;
  }

  /**
   * Set the next available ID.
   * @param {number} n
   */
  setNextId(n) {
    this._setMetaStmt.run('nextId', String(n));
  }

  /**
   * Get the total number of vectors.
   * @returns {number}
   */
  get size() {
    return this.db.prepare('SELECT COUNT(*) as cnt FROM vectors').get().cnt;
  }

  /**
   * Close the database connection.
   */
  close() {
    this.db.close();
  }
}

export default SqliteVectorBackend;
