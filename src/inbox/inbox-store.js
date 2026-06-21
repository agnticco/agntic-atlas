import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class InboxStore {
  constructor({ dbPath }) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this._db = new Database(dbPath);
    this._db.exec('PRAGMA journal_mode=WAL');
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        source_workflow_id TEXT,
        source_run_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        read_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_inbox_tu
        ON inbox_messages(tenant_id, user_id, created_at DESC);
    `);
  }

  _guard(tenantId, userId) {
    if (!tenantId) throw new Error('InboxStore: tenantId required');
    if (!userId)   throw new Error('InboxStore: userId required');
  }

  create({ tenantId, userId, sourceWorkflowId = null, sourceRunId = null, subject = '', content = '' }) {
    this._guard(tenantId, userId);
    const id  = randomUUID();
    const now = Date.now();
    this._db.prepare(
      `INSERT INTO inbox_messages
         (id, tenant_id, user_id, source_workflow_id, source_run_id, subject, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tenantId, userId, sourceWorkflowId, sourceRunId, subject, content, now);
    return this.get(tenantId, userId, id);
  }

  list(tenantId, userId, { limit = 50, offset = 0 } = {}) {
    this._guard(tenantId, userId);
    return this._db.prepare(
      `SELECT * FROM inbox_messages
       WHERE tenant_id = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(tenantId, userId, limit, offset);
  }

  get(tenantId, userId, id) {
    this._guard(tenantId, userId);
    return this._db.prepare(
      `SELECT * FROM inbox_messages WHERE id = ? AND tenant_id = ? AND user_id = ?`
    ).get(id, tenantId, userId) ?? null;
  }

  markRead(tenantId, userId, id) {
    this._guard(tenantId, userId);
    this._db.prepare(
      `UPDATE inbox_messages SET read_at = ?
       WHERE id = ? AND tenant_id = ? AND user_id = ? AND read_at IS NULL`
    ).run(Date.now(), id, tenantId, userId);
    return this.get(tenantId, userId, id);
  }

  delete(tenantId, userId, id) {
    this._guard(tenantId, userId);
    const { changes } = this._db.prepare(
      `DELETE FROM inbox_messages WHERE id = ? AND tenant_id = ? AND user_id = ?`
    ).run(id, tenantId, userId);
    return { deleted: changes > 0 };
  }

  unreadCount(tenantId, userId) {
    this._guard(tenantId, userId);
    return this._db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_messages
       WHERE tenant_id = ? AND user_id = ? AND read_at IS NULL`
    ).get(tenantId, userId)?.n ?? 0;
  }

  close() { try { this._db.close(); } catch { /* ignore */ } }
}
