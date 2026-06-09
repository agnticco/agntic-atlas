/**
 * FeedbackStore — structured user feedback on workflow runs.
 *
 * Each entry attaches to a workflow (always) and a run (usually). Feedback
 * persists across edits so the next time the user opens the workflow in
 * Flow Builder, the agent's system prompt includes outstanding feedback
 * and can propose targeted fixes.
 *
 * Schema (workflow_feedback):
 *   id          TEXT PRIMARY KEY
 *   workflow_id TEXT NOT NULL  → workflows(id) ON DELETE CASCADE
 *   run_id      TEXT          → workflow_runs(id) ON DELETE SET NULL
 *   rating      TEXT NOT NULL  CHECK ∈ ('good','needs_work','broken')
 *   notes       TEXT
 *   tags        TEXT          (JSON array of tag ids)
 *   addressed   INTEGER 0/1    (user resolved or workflow updated to fix)
 *   created_at  TEXT NOT NULL
 *
 * @module src/workflows/feedback-store.js
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { log } from '../utils/logger.js';

/**
 * Predefined tags surfaced as quick-add chips in the UI. Free-text notes
 * are also supported. Adding a new tag here lights it up everywhere
 * automatically (UI palette, prompt summary, filter queries).
 */
export const FEEDBACK_TAGS = [
  { id: 'too_long',           label: 'Too long' },
  { id: 'too_short',          label: 'Too short' },
  { id: 'irrelevant_sources', label: 'Sources weren\'t relevant' },
  { id: 'outdated_info',      label: 'Information was outdated' },
  { id: 'images_irrelevant',  label: 'Images didn\'t match the stories' },
  { id: 'no_images',          label: 'Should have had images' },
  { id: 'wrong_format',       label: 'Format was wrong' },
  { id: 'tone_off',           label: 'Tone was off' },
  { id: 'factual_error',      label: 'Factual error' },
  { id: 'missing_section',    label: 'Missing a section I wanted' },
  { id: 'too_many_steps',     label: 'Too many parallel sources' },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_feedback (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  user_id     TEXT,
  run_id      TEXT,
  rating      TEXT NOT NULL CHECK(rating IN ('good','needs_work','broken')),
  notes       TEXT,
  tags        TEXT,
  addressed   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id)      REFERENCES workflow_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fb_workflow ON workflow_feedback(workflow_id);
CREATE INDEX IF NOT EXISTS idx_fb_run      ON workflow_feedback(run_id);
CREATE INDEX IF NOT EXISTS idx_fb_addr     ON workflow_feedback(addressed);
-- Note: idx_fb_user is created post-additive in init() since legacy DBs may
-- pre-date the user_id column. See _migrateUserIdIfNeeded() below.
`;

export class FeedbackStore {
  /**
   * @param {object} options
   * @param {string} [options.dbPath] — SQLite file path. Reuses the
   *   workflows DB by default so foreign keys + cascades work.
   */
  constructor({ dbPath = './memory/workflows/workflows.sqlite' } = {}) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);

    // Additive migration for legacy DBs that pre-date user_id on this table.
    // Backfill from workflows.user_id via workflow_id JOIN — orphan-owned
    // rows get NULL and become invisible to user-scoped reads.
    const cols = new Set(this.db.prepare('PRAGMA table_info(workflow_feedback)').all().map(r => r.name));
    if (!cols.has('user_id')) {
      log.info('[feedback-store] adding user_id + backfilling from workflows');
      this.db.exec('ALTER TABLE workflow_feedback ADD COLUMN user_id TEXT');
      this.db.exec(`
        UPDATE workflow_feedback
        SET user_id = (SELECT w.user_id FROM workflows w WHERE w.id = workflow_feedback.workflow_id)
        WHERE workflow_id IS NOT NULL
      `);
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_fb_user ON workflow_feedback(user_id)');

    log.info(`[feedback-store] initialized`);
  }

  /**
   * Persist a new feedback entry. Caller must pass `userId` so the row is
   * stamped with the correct owner — never trusted from the LLM. The user_id
   * column was added in WF-I7; the workflow-store migration backfills it for
   * legacy rows by JOINing to workflows.user_id.
   */
  create({ workflowId, runId = null, rating, notes = null, tags = [], userId = null }) {
    if (!workflowId) throw new Error('feedback requires workflowId');
    if (!['good', 'needs_work', 'broken'].includes(rating)) {
      throw new Error(`invalid rating "${rating}"`);
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO workflow_feedback (id, workflow_id, user_id, run_id, rating, notes, tags, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, workflowId, userId, runId, rating,
      notes && notes.trim() ? notes.trim() : null,
      Array.isArray(tags) && tags.length ? JSON.stringify(tags) : null,
      new Date().toISOString(),
    );
    return this.get(id);
  }

  get(id, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'SELECT * FROM workflow_feedback WHERE id = ?'
      : 'SELECT * FROM workflow_feedback WHERE id = ? AND user_id IS ?';
    const row = userId === undefined
      ? this.db.prepare(sql).get(id)
      : this.db.prepare(sql).get(id, userId);
    return row ? this._parse(row) : null;
  }

  /** All feedback for a workflow, newest first. Scoped by userId. */
  listForWorkflow(workflowId, { unaddressedOnly = false, limit = 50, userId = undefined } = {}) {
    const where = ['workflow_id = ?'];
    const args = [workflowId];
    if (unaddressedOnly) where.push('addressed = 0');
    if (userId !== undefined) { where.push('user_id IS ?'); args.push(userId); }
    args.push(limit);
    const sql = `SELECT * FROM workflow_feedback WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args).map(r => this._parse(r));
  }

  /** All feedback for a specific run (usually 0 or 1). Scoped by userId. */
  listForRun(runId, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'SELECT * FROM workflow_feedback WHERE run_id = ? ORDER BY created_at DESC'
      : 'SELECT * FROM workflow_feedback WHERE run_id = ? AND user_id IS ? ORDER BY created_at DESC';
    return (userId === undefined
      ? this.db.prepare(sql).all(runId)
      : this.db.prepare(sql).all(runId, userId)).map(r => this._parse(r));
  }

  /**
   * Aggregate counts per workflow for the UI's "unaddressed feedback"
   * badge on the workflows list. Scoped by userId. Returns Map<workflow_id, count>.
   */
  unaddressedCountByWorkflow({ userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'SELECT workflow_id, COUNT(*) AS n FROM workflow_feedback WHERE addressed = 0 GROUP BY workflow_id'
      : 'SELECT workflow_id, COUNT(*) AS n FROM workflow_feedback WHERE addressed = 0 AND user_id IS ? GROUP BY workflow_id';
    const rows = userId === undefined
      ? this.db.prepare(sql).all()
      : this.db.prepare(sql).all(userId);
    return new Map(rows.map(r => [r.workflow_id, r.n]));
  }

  /** Mark an entry as addressed. Scoped by userId — no-op if not owned. */
  markAddressed(id, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'UPDATE workflow_feedback SET addressed = 1 WHERE id = ?'
      : 'UPDATE workflow_feedback SET addressed = 1 WHERE id = ? AND user_id IS ?';
    const stmt = this.db.prepare(sql);
    userId === undefined ? stmt.run(id) : stmt.run(id, userId);
    return this.get(id, userId !== undefined ? { userId } : {});
  }

  /** Mark every unaddressed entry on a workflow as resolved. Scoped by userId. */
  markAllAddressed(workflowId, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'UPDATE workflow_feedback SET addressed = 1 WHERE workflow_id = ? AND addressed = 0'
      : 'UPDATE workflow_feedback SET addressed = 1 WHERE workflow_id = ? AND addressed = 0 AND user_id IS ?';
    const r = userId === undefined
      ? this.db.prepare(sql).run(workflowId)
      : this.db.prepare(sql).run(workflowId, userId);
    return r.changes;
  }

  /** Delete a single entry. Scoped by userId. */
  delete(id, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'DELETE FROM workflow_feedback WHERE id = ?'
      : 'DELETE FROM workflow_feedback WHERE id = ? AND user_id IS ?';
    const stmt = this.db.prepare(sql);
    const info = userId === undefined ? stmt.run(id) : stmt.run(id, userId);
    return info.changes > 0;
  }

  /**
   * Format outstanding feedback as a system-prompt block. Scoped by userId.
   */
  describeForPrompt(workflowId, { userId = undefined } = {}) {
    const items = this.listForWorkflow(workflowId, { unaddressedOnly: true, limit: 10, userId });
    if (!items.length) return '';
    const lines = [
      'OUTSTANDING USER FEEDBACK ON THIS WORKFLOW',
      '──────────────────────────────────────────',
      'The user has submitted feedback on past runs that has not yet been addressed.',
      'Take this seriously when proposing edits — these are concrete user complaints',
      'that the next saved version should fix.',
      '',
    ];
    for (const f of items) {
      const when = _shortDate(f.created_at);
      const tags = f.tags?.length ? ` [${f.tags.join(', ')}]` : '';
      const notes = f.notes ? ` — "${f.notes}"` : '';
      lines.push(`  - ${f.rating} (${when})${tags}${notes}`);
    }
    lines.push('');
    lines.push('When you save a fix that addresses one of these items, the user will mark it resolved.');
    return lines.join('\n');
  }

  _parse(row) {
    if (row.tags) { try { row.tags = JSON.parse(row.tags); } catch { row.tags = []; } }
    else row.tags = [];
    row.addressed = !!row.addressed;
    return row;
  }

  close() { this.db?.close(); }
}

function _shortDate(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
