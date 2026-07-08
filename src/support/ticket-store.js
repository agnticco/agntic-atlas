/**
 * TicketStore — SQLite-backed support tickets (bugs / ideas / requests).
 *
 * End users submit tickets from the operator app; platform admins triage them
 * in the admin app and hand the rich brief off to a coding agent. Each ticket
 * carries a captured context bundle (surface, versions, console/network logs)
 * and an optional screenshot path so a bug report is actionable without a
 * back-and-forth.
 *
 * Lives in its own SQLite file (default ./memory/tickets/tickets.sqlite) so it's
 * independent of the workflow/auth DBs. Tenant scoping is fail-closed on writes
 * (a ticket must belong to a tenant) — modeled on user-store.js's requireTenant.
 * Reads are cross-tenant BY DESIGN: only platform admins call them, gated by
 * requirePlatformAdmin at the route layer.
 *
 * NOTE: distinct from src/workflows/feedback-store.js (per-run workflow feedback,
 * a different concept and not wired). Do not conflate the two.
 *
 * @module src/support/ticket-store.js
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS support_tickets (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  user_id              TEXT NOT NULL,
  user_email           TEXT,
  user_name            TEXT,
  type                 TEXT NOT NULL CHECK(type IN ('bug','idea','request')) DEFAULT 'bug',
  severity             TEXT,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  steps                TEXT,
  expected             TEXT,
  actual               TEXT,
  status               TEXT NOT NULL DEFAULT 'new',
  context_json         TEXT,
  screenshot_path      TEXT,
  github_issue_url     TEXT,
  github_issue_number  INTEGER,
  admin_notes          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_tenant  ON support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status  ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON support_tickets(created_at);
`;

/** Statuses a ticket that no longer needs work sits in (everything else is "open"). */
export const CLOSED_STATUSES = ['resolved', 'wontfix', 'closed'];
const ALL_STATUSES = ['new', 'triaged', 'in_progress', ...CLOSED_STATUSES];
const TYPES = ['bug', 'idea', 'request'];
const SEVERITIES = ['blocker', 'high', 'medium', 'low'];

/** Fail-closed guard: a tenant-scoped write must never run without a tenant. */
function requireTenant(tenantId, where) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new Error(`tenant scope required for ${where} (refusing unscoped write)`);
  }
  return tenantId;
}

function clampStr(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

export class TicketStore {
  /**
   * @param {object} opts
   * @param {Database.Database|null} [opts.db]     - Existing better-sqlite3 handle
   * @param {string}                 [opts.dbPath] - Path to open if no handle was passed
   */
  constructor({ db = null, dbPath = null } = {}) {
    if (!db && !dbPath) throw new Error('TicketStore requires either db or dbPath');
    this._ownsDb = !db;
    this.db = db ?? new Database(dbPath);
  }

  async init() {
    if (this._ownsDb) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    this.db.exec(SCHEMA);
    return this;
  }

  close() {
    if (this._ownsDb && this.db) { try { this.db.close(); } catch { /* ignore */ } }
    this.db = null;
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  /**
   * Create a ticket. Tenant + user are mandatory (fail-closed).
   * `context` is an arbitrary JSON-serializable object; it's stored verbatim.
   * @returns {object} the created ticket (context parsed)
   */
  create({
    tenantId, userId, userEmail = null, userName = null,
    type = 'bug', severity = null, title, description,
    steps = null, expected = null, actual = null,
    context = null, screenshotPath = null,
  }) {
    requireTenant(tenantId, 'TicketStore.create');
    if (!userId) throw new Error('TicketStore.create requires userId');
    if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
    const cleanTitle = clampStr(title, 300)?.trim();
    const cleanDesc = clampStr(description, 20_000)?.trim();
    if (!cleanTitle) throw new Error('title is required');
    if (!cleanDesc) throw new Error('description is required');
    const sev = severity && SEVERITIES.includes(severity) ? severity : null;

    const now = new Date().toISOString();
    const id = `tkt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    let contextJson = null;
    if (context) {
      try { contextJson = JSON.stringify(context).slice(0, 200_000); } catch { contextJson = null; }
    }

    this.db.prepare(`
      INSERT INTO support_tickets
        (id, tenant_id, user_id, user_email, user_name, type, severity, title, description,
         steps, expected, actual, status, context_json, screenshot_path, created_at, updated_at)
      VALUES
        (@id, @tenant_id, @user_id, @user_email, @user_name, @type, @severity, @title, @description,
         @steps, @expected, @actual, 'new', @context_json, @screenshot_path, @created_at, @updated_at)
    `).run({
      id, tenant_id: tenantId, user_id: userId,
      user_email: clampStr(userEmail, 320), user_name: clampStr(userName, 200),
      type, severity: sev, title: cleanTitle, description: cleanDesc,
      steps: clampStr(steps, 10_000), expected: clampStr(expected, 10_000), actual: clampStr(actual, 10_000),
      context_json: contextJson, screenshot_path: clampStr(screenshotPath, 500),
      created_at: now, updated_at: now,
    });
    return this.get(id);
  }

  // ── Read (admin — cross-tenant by design, gated by requirePlatformAdmin) ─────

  /** Fetch one ticket by id (with context parsed). Null if not found. */
  get(id) {
    const row = this.db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id);
    return row ? hydrate(row) : null;
  }

  /**
   * List tickets, newest first. All filters optional.
   * @param {object} [opts]
   * @param {string}   [opts.status]   - exact status, or 'open' (any non-closed)
   * @param {string}   [opts.type]     - bug | idea | request
   * @param {string}   [opts.tenantId] - restrict to one tenant
   * @param {number}   [opts.limit]    - default 200
   */
  list({ status = null, type = null, tenantId = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (status === 'open') {
      where.push(`status NOT IN (${CLOSED_STATUSES.map(() => '?').join(',')})`);
      params.push(...CLOSED_STATUSES);
    } else if (status && ALL_STATUSES.includes(status)) {
      where.push('status = ?'); params.push(status);
    }
    if (type && TYPES.includes(type)) { where.push('type = ?'); params.push(type); }
    if (tenantId) { where.push('tenant_id = ?'); params.push(tenantId); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Math.min(1000, Math.max(1, Number(limit) || 200));
    const rows = this.db.prepare(
      `SELECT * FROM support_tickets ${clause} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, lim);
    return rows.map(hydrate);
  }

  /** Headline counts for the admin nav badge + list header. */
  counts() {
    const byStatus = {};
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM support_tickets GROUP BY status').all()) {
      byStatus[r.status] = r.n;
    }
    const byType = {};
    for (const r of this.db.prepare('SELECT type, COUNT(*) AS n FROM support_tickets GROUP BY type').all()) {
      byType[r.type] = r.n;
    }
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM support_tickets').get().n;
    const open = this.db.prepare(
      `SELECT COUNT(*) AS n FROM support_tickets WHERE status NOT IN (${CLOSED_STATUSES.map(() => '?').join(',')})`,
    ).get(...CLOSED_STATUSES).n;
    return { total, open, byStatus, byType };
  }

  // ── Update (admin) ───────────────────────────────────────────────────────────

  /**
   * Patch a ticket's triage fields. Only the provided keys are changed.
   * @returns {object|null} the updated ticket, or null if the id doesn't exist
   */
  update(id, { status, adminNotes, githubIssueUrl, githubIssueNumber } = {}) {
    const existing = this.get(id);
    if (!existing) return null;
    const sets = [];
    const params = {};
    if (status !== undefined) {
      if (!ALL_STATUSES.includes(status)) throw new Error(`status must be one of ${ALL_STATUSES.join(', ')}`);
      sets.push('status = @status'); params.status = status;
    }
    if (adminNotes !== undefined) { sets.push('admin_notes = @admin_notes'); params.admin_notes = clampStr(adminNotes, 20_000); }
    if (githubIssueUrl !== undefined) { sets.push('github_issue_url = @gh_url'); params.gh_url = clampStr(githubIssueUrl, 500); }
    if (githubIssueNumber !== undefined) { sets.push('github_issue_number = @gh_num'); params.gh_num = githubIssueNumber == null ? null : Number(githubIssueNumber); }
    if (!sets.length) return existing;
    sets.push('updated_at = @updated_at'); params.updated_at = new Date().toISOString();
    params.id = id;
    this.db.prepare(`UPDATE support_tickets SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.get(id);
  }
}

/** Row → public shape with context_json parsed into `context`. */
function hydrate(row) {
  let context = null;
  if (row.context_json) { try { context = JSON.parse(row.context_json); } catch { context = null; } }
  const { context_json, ...rest } = row;
  return { ...rest, context, hasScreenshot: !!row.screenshot_path };
}
