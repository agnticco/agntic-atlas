/**
 * IdempotencyStore — "has this step already run for this thing?" (P12 Increment B.)
 *
 * A trigger re-fires. Gmail redelivers a message, a webhook is retried, the
 * scheduler's retry wrapper (P7) runs the whole flow a second time after a
 * partial failure, or an operator clicks Run again. Without a memory of what has
 * already been done, the connector action runs AGAIN — a second Airtable record,
 * a second email to the customer. The engine had no such memory.
 *
 * A node declares:
 *
 *   "idempotency": { "key": "{{extract.email}}", "on_conflict": "skip" }
 *
 * and the executor records `(workflowId:nodeId, resolvedKey) → output` the first
 * time. On a repeat, `on_conflict` decides: `skip` (default — don't run, hand
 * back the first output), `update` (run again; the action itself upserts), or
 * `error` (fail loudly).
 *
 * The stored output is what makes `skip` safe rather than merely quiet: the
 * downstream steps still receive the record that the FIRST run created, so the
 * workflow completes normally instead of falling over on a missing input.
 *
 * Scope is `workflowId:nodeId`, so two different steps — or two different
 * workflows — can use the same key ("alice@acme.com") without colliding. Keys
 * are hashed (SHA-256): an idempotency key is very often a customer email
 * address or an invoice id, and there is no reason to keep a plaintext index of
 * those on disk when only equality is ever needed.
 *
 * @module src/workflows/idempotency-store.js
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope       TEXT NOT NULL,          -- "<workflowId>:<nodeId>"
  key_hash    TEXT NOT NULL,          -- SHA-256 of the resolved key
  output      TEXT,                   -- the first run's output, JSON
  created_at  TEXT NOT NULL,
  PRIMARY KEY (scope, key_hash)
);
CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);
`;

const hash = (key) => createHash('sha256').update(String(key)).digest('hex');

export class IdempotencyStore {
  constructor({ dbPath = './memory/workflows/idempotency.sqlite' } = {}) {
    this.dbPath = dbPath;
    this.db = null;
  }

  init() {
    if (this.dbPath !== ':memory:') {
      try { mkdirSync(dirname(this.dbPath), { recursive: true }); } catch { /* exists */ }
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    return this;
  }

  /** The prior record for this (scope, key), or null. */
  get(scope, key) {
    const row = this.db
      .prepare('SELECT output, created_at FROM idempotency_keys WHERE scope = ? AND key_hash = ?')
      .get(scope, hash(key));
    if (!row) return null;
    let output = null;
    try { output = row.output == null ? null : JSON.parse(row.output); }
    catch { output = row.output; }
    return { output, createdAt: row.created_at };
  }

  /**
   * Record that this (scope, key) has run, with its output.
   * INSERT OR REPLACE so `on_conflict: 'update'` refreshes the stored output
   * rather than leaving the first run's stale copy behind.
   */
  put(scope, key, output) {
    this.db
      .prepare(`INSERT OR REPLACE INTO idempotency_keys (scope, key_hash, output, created_at)
                VALUES (?, ?, ?, ?)`)
      .run(scope, hash(key), JSON.stringify(output ?? null), new Date().toISOString());
  }

  /** Housekeeping — drop records older than `days`. */
  prune(days = 90) {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoff).changes;
  }

  close() { this.db?.close(); this.db = null; }
}
