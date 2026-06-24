/**
 * WorkflowStore — SQLite-backed CRUD for workflows and execution history.
 *
 * Tables:
 *   workflows         — user-created automation definitions (fetch-kind and flow-kind)
 *   workflow_runs     — execution log per workflow
 *   workflow_versions — commit-like history of workflow definitions
 *
 * A workflow has `kind`:
 *   - 'fetch'  → recurring data-source pull (legacy / simple) driven by source_id + schedule
 *   - 'flow'   → generic node-DAG with triggers[], nodes[], edges[], error_handling{}
 *
 * @module src/workflows/workflow-store.js
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { log } from '../utils/logger.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL,
  session_id     TEXT,
  user_id        TEXT,
  tenant_id      TEXT NOT NULL DEFAULT 'default',
  user_intent    TEXT NOT NULL,
  source_id      TEXT NOT NULL DEFAULT '',
  schedule       TEXT NOT NULL DEFAULT '',
  output_format  TEXT NOT NULL DEFAULT 'summary',
  delivery       TEXT NOT NULL DEFAULT 'in_app',
  config         TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','error','draft')),
  last_run       TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wf_status ON workflows(status);
-- NOTE: indexes on user_id are created AFTER the additive-migration step in
-- init() runs ALTER TABLE ADD COLUMN user_id. On a legacy DB this CREATE
-- TABLE IF NOT EXISTS is a no-op (table already exists, missing user_id),
-- and any user_id index here would throw "no such column" before the column
-- is added.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id             TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  status         TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','error')),
  output         TEXT,
  error          TEXT,
  is_test        INTEGER NOT NULL DEFAULT 0,
  steps          TEXT
);

CREATE INDEX IF NOT EXISTS idx_wr_workflow ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wr_started  ON workflow_runs(started_at);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id             TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  snapshot       TEXT NOT NULL,
  message        TEXT,
  author         TEXT NOT NULL DEFAULT 'user',
  created_at     TEXT NOT NULL,
  UNIQUE(workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_wv_workflow ON workflow_versions(workflow_id);
`;

// Additive columns added after the original release. Applied on every init().
const ADDITIVE_COLUMNS = [
  { col: 'name',           type: "TEXT NOT NULL DEFAULT ''" },
  { col: 'description',    type: "TEXT NOT NULL DEFAULT ''" },
  { col: 'kind',           type: "TEXT NOT NULL DEFAULT 'fetch'" },
  { col: 'triggers',       type: "TEXT NOT NULL DEFAULT '[]'" },
  { col: 'nodes',          type: "TEXT NOT NULL DEFAULT '[]'" },
  { col: 'edges',          type: "TEXT NOT NULL DEFAULT '[]'" },
  { col: 'error_handling', type: "TEXT NOT NULL DEFAULT '{}'" },
  { col: 'version',        type: 'INTEGER NOT NULL DEFAULT 1' },
  { col: 'user_id',        type: 'TEXT' },
  { col: 'tenant_id',      type: "TEXT NOT NULL DEFAULT 'default'" },
  { col: 'deleted_at',              type: 'TEXT' },
  { col: 'baseline_duration_s',     type: 'INTEGER NOT NULL DEFAULT 0' },
  { col: 'baseline_recording_path', type: "TEXT NOT NULL DEFAULT ''" },
  { col: 'baseline_set_at',         type: "TEXT NOT NULL DEFAULT ''" },
];

// Additive columns for workflow_runs (same idempotent pattern as ADDITIVE_COLUMNS).
const ADDITIVE_RUN_COLUMNS = [
  { col: 'tokens_in',         type: 'INTEGER' },
  { col: 'tokens_out',        type: 'INTEGER' },
  { col: 'cost_usd',          type: 'REAL' },
  { col: 'llm_calls',         type: 'INTEGER' },
  { col: 'user_id',           type: 'TEXT' },
  { col: 'tenant_id',         type: 'TEXT' },
  { col: 'warnings',          type: 'TEXT' },
  { col: 'error_explanation', type: 'TEXT' },
  { col: 'time_saved_minutes', type: 'REAL' },
];

export class WorkflowStore {
  /**
   * @param {object} options
   * @param {string} [options.dbPath] — Path to SQLite file
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

    // Apply additive columns idempotently for upgrades from older schema
    const existing = new Set(this.db.prepare("PRAGMA table_info(workflows)").all().map(r => r.name));
    for (const { col, type } of ADDITIVE_COLUMNS) {
      if (!existing.has(col)) {
        try { this.db.exec(`ALTER TABLE workflows ADD COLUMN ${col} ${type}`); }
        catch (e) { log.warn(`[workflow-store] could not add column ${col}: ${e.message}`); }
      }
    }

    // Apply additive columns to workflow_runs
    const existingRun = new Set(this.db.prepare("PRAGMA table_info(workflow_runs)").all().map(r => r.name));
    for (const { col, type } of ADDITIVE_RUN_COLUMNS) {
      if (!existingRun.has(col)) {
        try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN ${col} ${type}`); }
        catch (e) { log.warn(`[workflow-store] could not add run column ${col}: ${e.message}`); }
      }
    }

    // Migrate the CHECK constraint on status to include 'draft'. The original
    // schema capped status to ('active','paused','error'); drafts are a new
    // flow-kind state. SQLite can't alter a CHECK in place — so we rebuild
    // the table when we detect the older constraint.
    this._migrateStatusCheckIfNeeded();

    // Drop the legacy global UNIQUE constraint on `slug` and replace with a
    // composite (user_id, slug) so each user owns a separate slug namespace.
    // We probe by attempting two inserts that differ only in user_id; if the
    // global UNIQUE blocks the second, we rebuild the table without it.
    this._migrateUserScopedSlugIfNeeded();

    // Sanity: every required column the rest of the module relies on must
    // exist after the additive-and-rebuild migrations above. If one is
    // missing, fail loudly rather than crash mid-query later.
    const finalCols = new Set(this.db.prepare("PRAGMA table_info(workflows)").all().map(r => r.name));
    for (const required of ['user_id', 'tenant_id', 'kind', 'triggers', 'nodes', 'edges']) {
      if (!finalCols.has(required)) {
        throw new Error(`[workflow-store] migration did not produce required column "${required}". Columns present: ${[...finalCols].join(', ')}`);
      }
    }

    // Always ensure the composite index exists after any migration above
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wf_user_slug ON workflows(user_id, slug);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wf_user ON workflows(user_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wf_tenant ON workflows(tenant_id);`);

    // Runs table additive columns
    const runsCols = new Set(this.db.prepare("PRAGMA table_info(workflow_runs)").all().map(r => r.name));
    if (!runsCols.has('is_test'))      { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0`); } catch {} }
    if (!runsCols.has('steps'))        { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN steps TEXT`); } catch {} }
    if (!runsCols.has('read_at'))      { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN read_at TEXT`); } catch {} }
    if (!runsCols.has('tokens_in'))    { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0`); } catch {} }
    if (!runsCols.has('tokens_out'))   { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0`); } catch {} }
    if (!runsCols.has('cost_usd'))     { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0`); } catch {} }
    if (!runsCols.has('llm_calls'))    { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN llm_calls INTEGER NOT NULL DEFAULT 0`); } catch {} }
    if (!runsCols.has('warnings'))     { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN warnings TEXT`); } catch {} }
    if (!runsCols.has('error_explanation')) { try { this.db.exec(`ALTER TABLE workflow_runs ADD COLUMN error_explanation TEXT`); } catch {} }

    // Sister-table user_id propagation (WF-I7). workflow_runs, workflow_versions,
    // and workflow_feedback all reference workflow_id but were unscoped — the
    // inbox surfaced every user's runs to every other user. Add user_id to each,
    // backfill from workflows.user_id, then index. Idempotent on rerun.
    this._migrateSisterTableUserIdIfNeeded();

    log.info(`[workflow-store] initialized`);
  }

  /**
   * Idempotent migration: ensure workflow_runs and workflow_versions each carry
   * user_id. Backfill from the parent workflow (workflows.user_id) via JOIN on
   * workflow_id. Indexes are created only after the column exists — never
   * inside SCHEMA, because that runs before the additive ALTER.
   *
   * workflow_feedback is owned by FeedbackStore which init()s AFTER us, so it
   * handles its own user_id additive migration and index. Don't reach across.
   */
  _migrateSisterTableUserIdIfNeeded() {
    const tables = ['workflow_runs', 'workflow_versions'];
    for (const table of tables) {
      // Skip tables that don't exist yet — fresh installs run CREATE TABLE
      // IF NOT EXISTS above, but a safety check keeps us robust if the
      // schema definition changes upstream.
      const exists = this.db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?"
      ).get(table);
      if (!exists) continue;

      const cols = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
      // user_id (per-user) and tenant_id (per-tenant) are both backfilled from
      // the parent workflow so sister rows inherit the owner's scope.
      if (!cols.has('user_id')) {
        log.info(`[workflow-store] adding user_id to ${table} + backfilling from workflows`);
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
        this.db.exec(`
          UPDATE ${table}
          SET user_id = (SELECT w.user_id FROM workflows w WHERE w.id = ${table}.workflow_id)
          WHERE workflow_id IS NOT NULL
        `);
      }
      if (!cols.has('tenant_id')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
        this.db.exec(`
          UPDATE ${table}
          SET tenant_id = COALESCE((SELECT w.tenant_id FROM workflows w WHERE w.id = ${table}.workflow_id), 'default')
          WHERE workflow_id IS NOT NULL
        `);
      }
    }
    // Indexes — safe to create now that the columns exist
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wr_user_started ON workflow_runs(user_id, started_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wv_user         ON workflow_versions(user_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wr_tenant       ON workflow_runs(tenant_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wv_tenant       ON workflow_versions(tenant_id)`);

    // Sanity: every sister table this store owns must have user_id + tenant_id
    for (const table of tables) {
      const cols = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
      for (const required of ['user_id', 'tenant_id']) {
        if (!cols.has(required)) {
          throw new Error(`[workflow-store] migration did not produce ${required} on ${table}. Columns: ${[...cols].join(', ')}`);
        }
      }
    }
  }

  _migrateUserScopedSlugIfNeeded() {
    // Probe: insert two probe rows with the same slug but different user_id.
    // If the legacy global UNIQUE on slug rejects the second one, rebuild
    // the table with no inline UNIQUE on slug.
    let needsMigration = false;
    try {
      this.db.exec("BEGIN");
      this.db.exec("INSERT INTO workflows (id, slug, user_id, user_intent, created_at, updated_at) VALUES ('__pu1__', '__probe_user_slug', 'u-probe-1', '', '0', '0')");
      this.db.exec("INSERT INTO workflows (id, slug, user_id, user_intent, created_at, updated_at) VALUES ('__pu2__', '__probe_user_slug', 'u-probe-2', '', '0', '0')");
      this.db.exec("DELETE FROM workflows WHERE id IN ('__pu1__','__pu2__')");
      this.db.exec("COMMIT");
    } catch {
      this.db.exec("ROLLBACK");
      needsMigration = true;
    }
    if (!needsMigration) return;

    log.info('[workflow-store] migrating slug UNIQUE → composite (user_id, slug)');
    const tx = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE workflows_new (
          id             TEXT PRIMARY KEY,
          slug           TEXT NOT NULL,
          session_id     TEXT,
          user_id        TEXT,
          tenant_id      TEXT NOT NULL DEFAULT 'default',
          user_intent    TEXT NOT NULL,
          source_id      TEXT NOT NULL DEFAULT '',
          schedule       TEXT NOT NULL DEFAULT '',
          output_format  TEXT NOT NULL DEFAULT 'summary',
          delivery       TEXT NOT NULL DEFAULT 'in_app',
          config         TEXT NOT NULL DEFAULT '{}',
          status         TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','error','draft')),
          last_run       TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          name           TEXT NOT NULL DEFAULT '',
          description    TEXT NOT NULL DEFAULT '',
          kind           TEXT NOT NULL DEFAULT 'fetch',
          triggers       TEXT NOT NULL DEFAULT '[]',
          nodes          TEXT NOT NULL DEFAULT '[]',
          edges          TEXT NOT NULL DEFAULT '[]',
          error_handling TEXT NOT NULL DEFAULT '{}',
          version        INTEGER NOT NULL DEFAULT 1
        );
      `);
      const oldCols = this.db.prepare("PRAGMA table_info(workflows)").all().map(r => r.name);
      const newCols = this.db.prepare("PRAGMA table_info(workflows_new)").all().map(r => r.name);
      const sharedCols = newCols.filter(c => oldCols.includes(c));
      const list = sharedCols.join(', ');
      this.db.exec(`INSERT INTO workflows_new (${list}) SELECT ${list} FROM workflows;`);
      this.db.exec(`DROP TABLE workflows;`);
      this.db.exec(`ALTER TABLE workflows_new RENAME TO workflows;`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wf_status ON workflows(status);`);
    });
    tx();
  }

  _migrateStatusCheckIfNeeded() {
    // Probe: try inserting and deleting a row with status='draft'. If it fails
    // the CHECK constraint, rebuild the table.
    let needsMigration = false;
    try {
      this.db.exec("BEGIN");
      this.db.exec("INSERT INTO workflows (id, slug, user_intent, created_at, updated_at, status) VALUES ('__probe__', '__probe_' || hex(randomblob(4)), '', '0', '0', 'draft')");
      this.db.exec("DELETE FROM workflows WHERE id = '__probe__'");
      this.db.exec("COMMIT");
    } catch {
      this.db.exec("ROLLBACK");
      needsMigration = true;
    }
    if (!needsMigration) return;

    log.info('[workflow-store] migrating status CHECK to include draft');
    const tx = this.db.transaction(() => {
      // Build a fresh table with the current full schema. MUST include every
      // column ADDITIVE_COLUMNS adds (including user_id) so this rebuild
      // doesn't silently strip a just-added column. If you add a new column
      // upstream, mirror it here.
      this.db.exec(`
        CREATE TABLE workflows_new (
          id             TEXT PRIMARY KEY,
          slug           TEXT NOT NULL,
          session_id     TEXT,
          user_id        TEXT,
          tenant_id      TEXT NOT NULL DEFAULT 'default',
          user_intent    TEXT NOT NULL,
          source_id      TEXT NOT NULL DEFAULT '',
          schedule       TEXT NOT NULL DEFAULT '',
          output_format  TEXT NOT NULL DEFAULT 'summary',
          delivery       TEXT NOT NULL DEFAULT 'in_app',
          config         TEXT NOT NULL DEFAULT '{}',
          status         TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','error','draft')),
          last_run       TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          name           TEXT NOT NULL DEFAULT '',
          description    TEXT NOT NULL DEFAULT '',
          kind           TEXT NOT NULL DEFAULT 'fetch',
          triggers       TEXT NOT NULL DEFAULT '[]',
          nodes          TEXT NOT NULL DEFAULT '[]',
          edges          TEXT NOT NULL DEFAULT '[]',
          error_handling TEXT NOT NULL DEFAULT '{}',
          version        INTEGER NOT NULL DEFAULT 1
        );
      `);
      const oldCols = this.db.prepare("PRAGMA table_info(workflows)").all().map(r => r.name);
      const newCols = this.db.prepare("PRAGMA table_info(workflows_new)").all().map(r => r.name);
      const sharedCols = newCols.filter(c => oldCols.includes(c));
      const list = sharedCols.join(', ');
      this.db.exec(`INSERT INTO workflows_new (${list}) SELECT ${list} FROM workflows;`);
      this.db.exec(`DROP TABLE workflows;`);
      this.db.exec(`ALTER TABLE workflows_new RENAME TO workflows;`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_wf_status ON workflows(status);`);
    });
    tx();
  }

  // ── Workflows ────────────────────────────────────────────────────────────

  /**
   * Create a new workflow. Supports both 'fetch' (legacy) and 'flow' (generic DAG) kinds.
   *
   * For 'fetch' kind:  { slug, sessionId, userIntent, sourceId, schedule, outputFormat, delivery, config }
   * For 'flow' kind:   { slug, sessionId, name, description, userIntent, triggers, nodes, edges, errorHandling, status }
   */
  create(fields = {}) {
    const id  = randomUUID();
    const now = new Date().toISOString();
    const kind = fields.kind ?? (fields.nodes || fields.triggers ? 'flow' : 'fetch');

    const row = {
      id,
      slug:            fields.slug ?? WorkflowStore.slugify(fields.name || fields.userIntent || 'workflow'),
      session_id:      fields.sessionId ?? null,
      user_id:         fields.userId ?? null,
      tenant_id:       fields.tenantId ?? 'default',
      user_intent:     fields.userIntent ?? fields.name ?? '',
      source_id:       fields.sourceId ?? '',
      schedule:        fields.schedule ?? '',
      output_format:   fields.outputFormat ?? 'summary',
      delivery:        fields.delivery ?? 'in_app',
      config:          JSON.stringify(fields.config ?? {}),
      status:          fields.status ?? (kind === 'flow' ? 'draft' : 'active'),
      name:            fields.name ?? fields.userIntent ?? '',
      description:     fields.description ?? '',
      kind,
      triggers:        JSON.stringify(fields.triggers ?? []),
      nodes:           JSON.stringify(fields.nodes ?? []),
      edges:           JSON.stringify(fields.edges ?? []),
      error_handling:  JSON.stringify(fields.errorHandling ?? {}),
      version:         1,
      created_at:      now,
      updated_at:      now,
    };

    this.db.prepare(`
      INSERT INTO workflows (
        id, slug, session_id, user_id, tenant_id, user_intent, source_id, schedule, output_format, delivery,
        config, status, name, description, kind, triggers, nodes, edges, error_handling,
        version, created_at, updated_at
      ) VALUES (
        @id, @slug, @session_id, @user_id, @tenant_id, @user_intent, @source_id, @schedule, @output_format, @delivery,
        @config, @status, @name, @description, @kind, @triggers, @nodes, @edges, @error_handling,
        @version, @created_at, @updated_at
      )
    `).run(row);

    // Record initial version
    this._snapshotVersion(id, 1, 'Initial version', fields.author ?? 'user');

    return this.get(id);
  }

  /**
   * Get a workflow by ID. When `userId` is provided, the workflow is only
   * returned if it belongs to that user — legacy rows with NULL user_id
   * are NOT visible. Pass `userId: null` ONLY for system-wide internal
   * operations (e.g. scheduler ticks) where ownership isn't checked.
   */
  get(id, { userId = undefined, tenantId = undefined } = {}) {
    const where = ['id = ?']; const args = [id];
    if (userId !== undefined)   { where.push('user_id IS ?');   args.push(userId); }
    if (tenantId !== undefined) { where.push('tenant_id IS ?'); args.push(tenantId); }
    const row = this.db.prepare(`SELECT * FROM workflows WHERE ${where.join(' AND ')}`).get(...args);
    return row ? this._parse(row) : null;
  }

  /** Get a workflow by slug, scoped to a user and/or tenant. */
  getBySlug(slug, { userId = undefined, tenantId = undefined } = {}) {
    const where = ['slug = ?']; const args = [slug];
    if (userId !== undefined)   { where.push('user_id IS ?');   args.push(userId); }
    if (tenantId !== undefined) { where.push('tenant_id IS ?'); args.push(tenantId); }
    const row = this.db.prepare(`SELECT * FROM workflows WHERE ${where.join(' AND ')}`).get(...args);
    return row ? this._parse(row) : null;
  }

  /**
   * List workflows. When `userId` is provided, only that user's workflows
   * are returned — legacy NULL-owner rows are hidden. Omit `userId` (or
   * pass `undefined`) ONLY for internal callers like the scheduler.
   */
  list({ status = null, kind = null, userId = undefined, tenantId = undefined } = {}) {
    const where = ['deleted_at IS NULL'];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (kind)   { where.push('kind = ?');   args.push(kind); }
    if (userId !== undefined)   { where.push('user_id IS ?');   args.push(userId); }
    if (tenantId !== undefined) { where.push('tenant_id IS ?'); args.push(tenantId); }
    const sql = `SELECT * FROM workflows WHERE ${where.join(' AND ')} ORDER BY created_at DESC`;
    return this.db.prepare(sql).all(...args).map(r => this._parse(r));
  }

  /**
   * Update mutable workflow fields. When definition fields (nodes, edges, triggers,
   * error_handling, name, description, config) change, bump the version and snapshot.
   *
   * If `userId` is provided, the update only proceeds when the workflow belongs
   * to that user. Pass `userId: undefined` (the default) for internal callers
   * that don't enforce ownership (e.g. scheduler completion writes).
   */
  update(id, fields, { message = null, author = 'user', userId = undefined } = {}) {
    const current = this.get(id, userId !== undefined ? { userId } : {});
    if (!current) return null;

    const map = {
      slug: 'slug', schedule: 'schedule', outputFormat: 'output_format', delivery: 'delivery',
      config: 'config', status: 'status', lastRun: 'last_run', name: 'name',
      description: 'description', triggers: 'triggers', nodes: 'nodes', edges: 'edges',
      errorHandling: 'error_handling', kind: 'kind',
      baseline_duration_s: 'baseline_duration_s',
      baseline_recording_path: 'baseline_recording_path',
      baseline_set_at: 'baseline_set_at',
    };
    const jsonCols = new Set(['config', 'triggers', 'nodes', 'edges', 'error_handling']);
    const definitionCols = new Set(['name', 'description', 'triggers', 'nodes', 'edges', 'error_handling', 'config', 'schedule', 'delivery']);

    const sets = [];
    const vals = [];
    let definitionChanged = false;

    for (const [k, v] of Object.entries(fields)) {
      const col = map[k] ?? k;
      if (!Object.values(map).includes(col)) continue;
      sets.push(`${col} = ?`);
      vals.push(jsonCols.has(col) ? JSON.stringify(v) : v);
      if (definitionCols.has(col)) definitionChanged = true;
    }

    if (sets.length === 0) return current;

    let newVersion = current.version;
    if (definitionChanged) {
      newVersion = (current.version ?? 1) + 1;
      sets.push('version = ?');
      vals.push(newVersion);
    }

    sets.push('updated_at = ?');
    vals.push(new Date().toISOString());
    vals.push(id);

    this.db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    if (definitionChanged) {
      this._snapshotVersion(id, newVersion, message ?? 'Updated workflow', author);
    }
    return this.get(id);
  }

  /**
   * Delete a workflow and its runs (cascading). Returns true if a row was
   * deleted. When `userId` is provided, only the owner's workflow is deleted.
   */
  delete(id, { userId = undefined } = {}) {
    const stmt = userId !== undefined
      ? this.db.prepare('DELETE FROM workflows WHERE id = ? AND user_id IS ?')
      : this.db.prepare('DELETE FROM workflows WHERE id = ?');
    const info = userId !== undefined ? stmt.run(id, userId) : stmt.run(id);
    return info.changes > 0;
  }

  softDelete(id, { userId = undefined, tenantId = undefined } = {}) {
    const where = ['id = ?', 'deleted_at IS NULL'];
    const args = [id];
    if (userId !== undefined) { where.push('user_id IS ?'); args.push(userId); }
    if (tenantId !== undefined) { where.push('tenant_id IS ?'); args.push(tenantId); }
    const info = this.db.prepare(`UPDATE workflows SET deleted_at = ? WHERE ${where.join(' AND ')}`)
      .run(new Date().toISOString(), ...args);
    return info.changes > 0;
  }

  restore(id, { userId = undefined, tenantId = undefined } = {}) {
    const where = ['id = ?', 'deleted_at IS NOT NULL'];
    const args = [id];
    if (userId !== undefined) { where.push('user_id IS ?'); args.push(userId); }
    if (tenantId !== undefined) { where.push('tenant_id IS ?'); args.push(tenantId); }
    const info = this.db.prepare(`UPDATE workflows SET deleted_at = NULL WHERE ${where.join(' AND ')}`)
      .run(...args);
    return info.changes > 0;
  }

  listDeleted({ userId = undefined, tenantId = undefined } = {}) {
    const where = ['deleted_at IS NOT NULL'];
    const args = [];
    if (userId !== undefined) { where.push('user_id IS ?'); args.push(userId); }
    if (tenantId !== undefined) { where.push('tenant_id IS ?'); args.push(tenantId); }
    return this.db.prepare(`SELECT * FROM workflows WHERE ${where.join(' AND ')} ORDER BY deleted_at DESC`)
      .all(...args).map(r => this._parse(r));
  }

  purgeExpiredDeleted(daysOld = 30) {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const info = this.db.prepare('DELETE FROM workflows WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff);
    return info.changes;
  }

  /**
   * Get workflows that are due to run, across ALL users. The scheduler is the
   * only intended caller — it runs workflows regardless of who owns them.
   */
  getDue() {
    // Internal scheduler call — pull every active workflow, no user filter
    const rows = this.db.prepare("SELECT * FROM workflows WHERE status = 'active' ORDER BY created_at DESC").all().map(r => this._parse(r));
    return rows.filter(w => {
      if (w.kind === 'fetch') return this._isDue(w);
      if (w.kind === 'flow')  return this._isFlowDue(w);
      return false;
    });
  }

  // ── Workflow Runs ────────────────────────────────────────────────────────

  /**
   * Start a new run. The run inherits the parent workflow's user_id so the
   * inbox / runs list / cost rollup can scope by user without a JOIN. If
   * the parent workflow has user_id IS NULL (orphan / pre-multi-user row),
   * the run's user_id is also NULL — invisible to every user.
   */
  startRun(workflowId, { isTest = false } = {}) {
    const id  = randomUUID();
    const now = new Date().toISOString();
    const parent = this.db.prepare('SELECT user_id, tenant_id FROM workflows WHERE id = ?').get(workflowId);
    const userId = parent?.user_id ?? null;
    const tenantId = parent?.tenant_id ?? 'default';

    this.db.prepare(`
      INSERT INTO workflow_runs (id, workflow_id, user_id, tenant_id, started_at, status, is_test) VALUES (?, ?, ?, ?, ?, 'running', ?)
    `).run(id, workflowId, userId, tenantId, now, isTest ? 1 : 0);

    // Update last_run on the workflow only for non-test runs
    if (!isTest) {
      this.db.prepare('UPDATE workflows SET last_run = ?, updated_at = ? WHERE id = ?').run(now, now, workflowId);
    }

    return { id, workflow_id: workflowId, user_id: userId, started_at: now, status: 'running', output: null, error: null, is_test: isTest };
  }

  /** Append a step record to an in-progress run. */
  appendStep(runId, step) {
    const row = this.db.prepare('SELECT steps FROM workflow_runs WHERE id = ?').get(runId);
    if (!row) return;
    const steps = row.steps ? JSON.parse(row.steps) : [];
    steps.push({ ...step, at: new Date().toISOString() });
    this.db.prepare('UPDATE workflow_runs SET steps = ? WHERE id = ?').run(JSON.stringify(steps), runId);
  }

  /**
   * Complete a run with success.
   * @param {string} runId
   * @param {*}      output
   * @param {object} [cost]      - { inputTokens, outputTokens, costUsd, calls } from CostTracker
   * @param {Array}  [warnings]  - output-validator warnings (advisory; doesn't fail the run)
   */
  completeRun(runId, output, cost = null, warnings = null, timeSavedMinutes = null) {
    const now = new Date().toISOString();
    const sets = ['status = \'success\'', 'output = ?', 'completed_at = ?'];
    const vals = [typeof output === 'string' ? output : JSON.stringify(output), now];
    if (cost) {
      sets.push('tokens_in = ?', 'tokens_out = ?', 'cost_usd = ?', 'llm_calls = ?');
      vals.push(cost.inputTokens ?? 0, cost.outputTokens ?? 0, cost.costUsd ?? 0, cost.calls ?? 0);
    }
    if (warnings) {
      sets.push('warnings = ?');
      vals.push(JSON.stringify(warnings));
    }
    if (timeSavedMinutes != null) {
      sets.push('time_saved_minutes = ?');
      vals.push(timeSavedMinutes);
    }
    vals.push(runId);
    this.db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /**
   * Complete a run with error. Cost is still recorded because tokens may
   * have burned before the failure. Pass an `explanation` (from the error
   * translator) to persist a user-friendly version alongside the raw text.
   */
  failRun(runId, error, cost = null, explanation = null) {
    const now = new Date().toISOString();
    const errorText = typeof error === 'string' ? error : (error?.message ?? String(error));
    const sets = ['status = \'error\'', 'error = ?', 'completed_at = ?'];
    const vals = [errorText, now];
    if (cost) {
      sets.push('tokens_in = ?', 'tokens_out = ?', 'cost_usd = ?', 'llm_calls = ?');
      vals.push(cost.inputTokens ?? 0, cost.outputTokens ?? 0, cost.costUsd ?? 0, cost.calls ?? 0);
    }
    if (explanation) {
      sets.push('error_explanation = ?');
      vals.push(JSON.stringify(explanation));
    }
    vals.push(runId);
    this.db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /**
   * Aggregate cost rollups per workflow — total tokens + USD across all
   * non-test runs. Scoped to the caller's userId; pass `userId: undefined`
   * for system/admin use only.
   */
  getCostByWorkflow({ userId = undefined } = {}) {
    const where = ['is_test = 0'];
    const args = [];
    if (userId !== undefined) { where.push('user_id IS ?'); args.push(userId); }
    return this.db.prepare(`
      SELECT workflow_id,
             COUNT(*)        AS runs,
             SUM(tokens_in)  AS tokens_in,
             SUM(tokens_out) AS tokens_out,
             SUM(cost_usd)   AS cost_usd,
             SUM(llm_calls)  AS llm_calls,
             MAX(started_at) AS last_run_at
      FROM workflow_runs
      WHERE ${where.join(' AND ')}
      GROUP BY workflow_id
    `).all(...args);
  }

  /** Get runs for a workflow, most recent first. Scoped by userId and/or tenantId. */
  getRuns(workflowId, limit = 20, { userId = undefined, tenantId = undefined } = {}) {
    const where = ['workflow_id = ?'];
    const args = [workflowId];
    if (userId !== undefined)   { where.push('user_id IS ?');   args.push(userId); }
    if (tenantId !== undefined) { where.push('tenant_id IS ?'); args.push(tenantId); }
    args.push(limit);
    return this.db.prepare(
      `SELECT * FROM workflow_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ?`
    ).all(...args).map(r => this._parseRun(r));
  }

  /** Get the most recent run for a workflow (excluding test runs). Scoped by userId. */
  getLastRun(workflowId, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'SELECT * FROM workflow_runs WHERE workflow_id = ? AND is_test = 0 ORDER BY started_at DESC LIMIT 1'
      : 'SELECT * FROM workflow_runs WHERE workflow_id = ? AND user_id IS ? AND is_test = 0 ORDER BY started_at DESC LIMIT 1';
    const row = userId === undefined
      ? this.db.prepare(sql).get(workflowId)
      : this.db.prepare(sql).get(workflowId, userId);
    return row ? this._parseRun(row) : null;
  }

  /** Get a single run by id. Scoped by userId and/or tenantId — returns null on mismatch. */
  getRun(runId, { userId = undefined, tenantId = undefined } = {}) {
    const where = ['id = ?'];
    const args = [runId];
    if (userId !== undefined)   { where.push('user_id IS ?');   args.push(userId); }
    if (tenantId !== undefined) { where.push('tenant_id IS ?'); args.push(tenantId); }
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE ${where.join(' AND ')}`).get(...args);
    return row ? this._parseRun(row) : null;
  }

  /** Mark a run as read (sets read_at=now). Returns true if owned + updated. */
  markRead(runId, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'UPDATE workflow_runs SET read_at = ? WHERE id = ?'
      : 'UPDATE workflow_runs SET read_at = ? WHERE id = ? AND user_id IS ?';
    const stmt = this.db.prepare(sql);
    const info = userId === undefined
      ? stmt.run(new Date().toISOString(), runId)
      : stmt.run(new Date().toISOString(), runId, userId);
    return info.changes > 0;
  }

  /** Mark a run as unread (clears read_at). Returns true if owned + updated. */
  markUnread(runId, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'UPDATE workflow_runs SET read_at = NULL WHERE id = ?'
      : 'UPDATE workflow_runs SET read_at = NULL WHERE id = ? AND user_id IS ?';
    const stmt = this.db.prepare(sql);
    const info = userId === undefined ? stmt.run(runId) : stmt.run(runId, userId);
    return info.changes > 0;
  }

  /** Delete a single run. Returns true if owned + deleted. */
  deleteRun(runId, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'DELETE FROM workflow_runs WHERE id = ?'
      : 'DELETE FROM workflow_runs WHERE id = ? AND user_id IS ?';
    const stmt = this.db.prepare(sql);
    const info = userId === undefined ? stmt.run(runId) : stmt.run(runId, userId);
    return info.changes > 0;
  }

  /**
   * Count unread runs, optionally filtered by delivery channel. Scoped by userId.
   */
  getUnreadCount({ channel = null, excludeTests = true, userId = undefined } = {}) {
    const where = ['(? = 0 OR r.is_test = 0)', 'r.read_at IS NULL', "r.status IN ('success', 'error')"];
    const args = [excludeTests ? 1 : 0];
    if (userId !== undefined) { where.push('r.user_id IS ?'); args.push(userId); }
    const sql = `
      SELECT r.id, w.nodes AS wf_nodes
      FROM workflow_runs r
      JOIN workflows w ON w.id = r.workflow_id
      WHERE ${where.join(' AND ')}
    `;
    const rows = this.db.prepare(sql).all(...args);
    if (!channel) return rows.length;
    return rows.filter(r => {
      try { return JSON.parse(r.wf_nodes).some(n => n.type === 'deliver' && n.config?.channel === channel); }
      catch { return false; }
    }).length;
  }

  /**
   * Recent runs across all of the user's workflows, newest first. Scoped by userId.
   */
  getRecentRuns({ limit = 20, excludeTests = true, statuses = ['success', 'error'], channel = null, userId = undefined } = {}) {
    const statusSql = statuses.map(() => '?').join(',');
    const where = ['(? = 0 OR r.is_test = 0)', `r.status IN (${statusSql})`];
    const args = [excludeTests ? 1 : 0, ...statuses];
    if (userId !== undefined) { where.push('r.user_id IS ?'); args.push(userId); }
    args.push(Math.max(limit * 3, limit + 20));
    const sql = `
      SELECT r.*, w.slug AS wf_slug, w.name AS wf_name, w.user_intent AS wf_user_intent,
             w.kind AS wf_kind, w.status AS wf_status, w.nodes AS wf_nodes
      FROM workflow_runs r
      JOIN workflows w ON w.id = r.workflow_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.started_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...args).map(r => this._parseRun(r));

    // Parse workflow nodes so the client can identify channels used
    for (const r of rows) {
      try { r.wf_nodes = JSON.parse(r.wf_nodes); } catch { r.wf_nodes = []; }
    }

    if (!channel) return rows.slice(0, limit);

    // Channel filter — keep only runs whose workflow has a deliver node on this channel
    const matching = rows.filter(r => (r.wf_nodes ?? []).some(n => n.type === 'deliver' && n.config?.channel === channel));
    return matching.slice(0, limit);
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  /** List versions (oldest → newest) for a workflow. Scoped by userId. */
  getVersions(workflowId, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'SELECT id, workflow_id, version, message, author, created_at FROM workflow_versions WHERE workflow_id = ? ORDER BY version ASC'
      : 'SELECT id, workflow_id, version, message, author, created_at FROM workflow_versions WHERE workflow_id = ? AND user_id IS ? ORDER BY version ASC';
    return userId === undefined
      ? this.db.prepare(sql).all(workflowId)
      : this.db.prepare(sql).all(workflowId, userId);
  }

  /** Load a specific version snapshot. Scoped by userId. */
  getVersion(workflowId, version, { userId = undefined } = {}) {
    const sql = userId === undefined
      ? 'SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?'
      : 'SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ? AND user_id IS ?';
    const row = userId === undefined
      ? this.db.prepare(sql).get(workflowId, version)
      : this.db.prepare(sql).get(workflowId, version, userId);
    if (!row) return null;
    try { row.snapshot = JSON.parse(row.snapshot); } catch {}
    return row;
  }

  /** Revert a workflow to a previous version. Creates a new version record. */
  revertTo(workflowId, version, { author = 'user', userId = undefined } = {}) {
    const v = this.getVersion(workflowId, version, userId !== undefined ? { userId } : {});
    if (!v) throw new Error(`Version ${version} not found for workflow ${workflowId}`);
    const snap = v.snapshot;
    return this.update(workflowId, {
      name: snap.name, description: snap.description, userIntent: snap.user_intent,
      triggers: snap.triggers, nodes: snap.nodes, edges: snap.edges,
      errorHandling: snap.error_handling, config: snap.config,
      schedule: snap.schedule, delivery: snap.delivery,
    }, { message: `Reverted to v${version}`, author, userId });
  }

  /** Snapshot a workflow version. Stamps user_id from the workflow row. */
  _snapshotVersion(workflowId, version, message, author) {
    const wf = this.get(workflowId);
    if (!wf) return;
    this.db.prepare(`
      INSERT OR REPLACE INTO workflow_versions (id, workflow_id, user_id, tenant_id, version, snapshot, message, author, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), workflowId, wf.user_id ?? null, wf.tenant_id ?? 'default', version, JSON.stringify(wf), message ?? '', author ?? 'user', new Date().toISOString());
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Parse JSON columns from a row. */
  _parse(row) {
    for (const col of ['config', 'triggers', 'nodes', 'edges', 'error_handling']) {
      if (row[col] != null) {
        try { row[col] = JSON.parse(row[col]); } catch { row[col] = col === 'error_handling' ? {} : (col === 'config' ? {} : []); }
      }
    }
    return row;
  }

  _parseRun(row) {
    if (row.steps)             { try { row.steps             = JSON.parse(row.steps); }             catch { row.steps = []; } }
    if (row.warnings)          { try { row.warnings          = JSON.parse(row.warnings); }          catch { row.warnings = []; } }
    if (row.error_explanation) { try { row.error_explanation = JSON.parse(row.error_explanation); } catch {} }
    return row;
  }

  /**
   * Check if a flow-kind workflow is due based on its first schedule trigger
   * and last_run. Supports:
   *   { config: { time: "HH:MM" } }              — daily
   *   { config: { cron: "M H * * *" } }          — daily cron
   *   { config: { cron: "M H * * <DOW>" } }      — weekly cron (DOW = 0–6,
   *                                                 comma list, or range a-b;
   *                                                 7 also treated as Sunday)
   *   cron field "* /N * * *" (step syntax)       — every N minutes (sub-daily)
   *   cron field "0 * /N * * *" (step syntax)     — every N hours (sub-daily)
   */
  _isFlowDue(workflow) {
    const triggers = workflow.triggers ?? [];
    for (const t of triggers) {
      if (t?.type !== 'schedule') continue;
      const cron = t.config?.cron;
      const time = t.config?.time;

      // ── Sub-daily: interval-based patterns ──────────────────────────────────
      // These use elapsed time since last_run rather than "once per calendar day."
      if (typeof cron === 'string') {
        const parts = cron.trim().split(/\s+/);
        if (parts.length >= 5 && parts[2] === '*' && parts[3] === '*') {
          const [mField, hField] = parts;

          // */N * * * *  — every N minutes
          const everyMinMatch = mField.match(/^\*\/(\d+)$/);
          if (everyMinMatch && hField === '*') {
            const intervalMs = parseInt(everyMinMatch[1], 10) * 60_000;
            if (!isNaN(intervalMs) && intervalMs > 0) {
              if (!workflow.last_run) return true;
              return (Date.now() - new Date(workflow.last_run).getTime()) >= intervalMs;
            }
          }

          // 0 */N * * *  — every N hours (fires on the hour, every N hours)
          const everyHrMatch = hField.match(/^\*\/(\d+)$/);
          if (everyHrMatch && mField === '0') {
            const intervalMs = parseInt(everyHrMatch[1], 10) * 3_600_000;
            if (!isNaN(intervalMs) && intervalMs > 0) {
              if (!workflow.last_run) return true;
              return (Date.now() - new Date(workflow.last_run).getTime()) >= intervalMs;
            }
          }
        }
      }

      // ── Daily / weekly: fire once per calendar day at a specific time ───────
      let hh = null, mm = null;
      let allowedDows = null;  // null = any day; otherwise Set<0..6>

      if (typeof time === 'string' && /^\d{1,2}:\d{2}$/.test(time)) {
        [hh, mm] = time.split(':').map(n => parseInt(n, 10));
      } else if (typeof cron === 'string') {
        const parts = cron.trim().split(/\s+/);
        if (parts.length >= 5 && parts[2] === '*' && parts[3] === '*') {
          const mParsed = parseInt(parts[0], 10);
          const hParsed = parseInt(parts[1], 10);
          if (!isNaN(mParsed) && !isNaN(hParsed)) {
            const dowField = parts[4];
            if (dowField === '*') {
              mm = mParsed; hh = hParsed;
            } else {
              const dows = _expandDowField(dowField);
              if (dows) { mm = mParsed; hh = hParsed; allowedDows = dows; }
            }
          }
        }
      }
      if (hh == null || mm == null) continue;

      const now = new Date();
      if (allowedDows && !allowedDows.has(now.getDay())) continue;
      if (workflow.last_run) {
        const lastRunDate = new Date(workflow.last_run);
        if (lastRunDate.toDateString() === now.toDateString()) continue;
      }
      if (now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a workflow is due based on its schedule and last_run.
   * Schedule format: "daily HH:MM" (24h, local time).
   */
  _isDue(workflow) {
    const { schedule, last_run } = workflow;
    if (!schedule) return false;

    const match = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i);
    if (!match) return false;

    const targetHour = parseInt(match[1], 10);
    const targetMin  = parseInt(match[2], 10);
    const now = new Date();

    if (last_run) {
      const lastRunDate = new Date(last_run);
      if (lastRunDate.toDateString() === now.toDateString()) return false;
    }

    return now.getHours() > targetHour || (now.getHours() === targetHour && now.getMinutes() >= targetMin);
  }

  /** Generate a URL-safe slug from user intent. */
  static slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60)
      .replace(/^-|-$/g, '');
  }

  close() {
    this.db?.close();
  }
}

/**
 * Expand a cron day-of-week field into a Set of JS getDay() values (0=Sun..6=Sat).
 * Accepts comma-separated ints, ranges (e.g. "1-5"), and treats 7 as Sunday.
 * Returns null if the field is malformed.
 */
function _expandDowField(field) {
  const out = new Set();
  for (const piece of String(field).split(',')) {
    const m = piece.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end   = m[2] != null ? parseInt(m[2], 10) : start;
    if (isNaN(start) || isNaN(end) || start < 0 || end > 7 || start > end) return null;
    for (let i = start; i <= end; i++) out.add(i === 7 ? 0 : i);
  }
  return out.size ? out : null;
}
