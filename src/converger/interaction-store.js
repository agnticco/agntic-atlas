/**
 * interaction-store — persists every converger session and its confirmation
 * events for closed-loop analysis.
 *
 * Isolation model matches the rest of the codebase:
 *   - Every write requires a tenantId; the store throws on missing tenant
 *     (fail-closed, no silent unscoped rows).
 *   - Tenant-scoped reads enforce the tenantId in WHERE clauses.
 *   - Platform-admin reads (listAllSessions, queryEvents) have no tenant
 *     filter — enforce the platform-admin role check at the API layer,
 *     not here.
 *
 * Schema:
 *   converger_sessions  — one row per elicitation session
 *   converger_events    — one row per confirmation step within a session
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolve } from 'node:path';

const DEFAULT_PATH = './memory/interactions.sqlite';

function requireTenant(tenantId, op) {
  if (!tenantId) throw new Error(`[interaction-store] tenant scope required for ${op} (refusing unscoped query)`);
}

export class InteractionStore {
  constructor({ dbPath = DEFAULT_PATH } = {}) {
    this.dbPath = resolve(dbPath);
  }

  init() {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS converger_sessions (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        user_id      TEXT,
        intent       TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        completed_at INTEGER,
        outcome      TEXT,        -- 'ratified' | 'abandoned'
        final_spec   TEXT,        -- JSON
        step_count   INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_cs_tenant     ON converger_sessions(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_cs_started    ON converger_sessions(started_at);

      CREATE TABLE IF NOT EXISTS converger_events (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES converger_sessions(id),
        tenant_id       TEXT NOT NULL,
        step            INTEGER NOT NULL,
        type            TEXT NOT NULL,
        -- clarification
        question        TEXT,
        answer          TEXT,
        -- proposal
        component       TEXT,
        proposal_spec   TEXT,
        response_type   TEXT,
        modification    TEXT,
        -- common
        created_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ce_session    ON converger_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_ce_tenant     ON converger_events(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_ce_type       ON converger_events(type);
      CREATE INDEX IF NOT EXISTS idx_ce_response   ON converger_events(response_type);

      -- PROVENANCE (P12 Increment C). Which turn produced each assertion, and
      -- which gaps nobody answered so they went to a person by default.
      --
      -- It lives HERE and not in the spec, deliberately: the spec is what the
      -- engine executes, and an execution artefact should not carry a record of
      -- the conversation that produced it. This table is what the SOP is written
      -- from — "these three cases were never decided; they escalate" is exactly
      -- the sentence a consultant's deliverable needs, and it is the sentence
      -- nobody could write before, because nothing recorded it.
      CREATE TABLE IF NOT EXISTS converger_provenance (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        tenant_id    TEXT NOT NULL,
        kind         TEXT NOT NULL,    -- 'assertion' | 'example' | 'gap_escalated' | 'gap_answered'
        ref_id       TEXT,             -- the assertion / gap id it is about
        step         INTEGER,
        detail       TEXT,             -- JSON
        created_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cp_session ON converger_provenance(session_id);
      CREATE INDEX IF NOT EXISTS idx_cp_tenant  ON converger_provenance(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_cp_kind    ON converger_provenance(kind);
    `);

    return this;
  }

  // ── Provenance ───────────────────────────────────────────────────────────

  appendProvenance(tenantId, sessionId, { kind, refId = null, step = null, detail = null }) {
    requireTenant(tenantId, 'appendProvenance');
    this.db.prepare(`
      INSERT INTO converger_provenance
        (id, session_id, tenant_id, kind, ref_id, step, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId, tenantId, kind, refId, step,
      detail == null ? null : JSON.stringify(detail), Date.now(),
    );
  }

  getProvenance(tenantId, sessionId) {
    requireTenant(tenantId, 'getProvenance');
    return this.db.prepare(`
      SELECT * FROM converger_provenance
       WHERE session_id = ? AND tenant_id = ?
       ORDER BY created_at ASC
    `).all(sessionId, tenantId)
      .map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  startSession(tenantId, sessionId, { intent, userId = null }) {
    requireTenant(tenantId, 'startSession');
    this.db.prepare(`
      INSERT OR IGNORE INTO converger_sessions
        (id, tenant_id, user_id, intent, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, tenantId, userId, intent, Date.now());
  }

  completeSession(tenantId, sessionId, { outcome, finalSpec = null, stepCount = 0 }) {
    requireTenant(tenantId, 'completeSession');
    this.db.prepare(`
      UPDATE converger_sessions
         SET outcome = ?, final_spec = ?, step_count = ?, completed_at = ?
       WHERE id = ? AND tenant_id = ?
    `).run(outcome, finalSpec ? JSON.stringify(finalSpec) : null, stepCount, Date.now(), sessionId, tenantId);
  }

  // ── Event append ─────────────────────────────────────────────────────────

  appendEvent(tenantId, sessionId, entry) {
    requireTenant(tenantId, 'appendEvent');
    const id = `ce_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    if (entry.type === 'clarification') {
      this.db.prepare(`
        INSERT INTO converger_events
          (id, session_id, tenant_id, step, type, question, answer, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, tenantId, entry.step, 'clarification',
             entry.question ?? null, entry.answer ?? null, now);
    } else if (entry.type === 'proposal') {
      this.db.prepare(`
        INSERT INTO converger_events
          (id, session_id, tenant_id, step, type, component, proposal_spec,
           response_type, modification, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, tenantId, entry.step, 'proposal',
             entry.proposal?.component ?? null,
             entry.proposal?.spec ? JSON.stringify(entry.proposal.spec) : null,
             entry.confirmation?.type ?? null,
             entry.confirmation?.modification ?? null,
             now);
    } else if (entry.type === 'ratify') {
      this.db.prepare(`
        INSERT INTO converger_events
          (id, session_id, tenant_id, step, type, response_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, tenantId, entry.step, 'ratify',
             entry.confirmation?.type ?? null, now);

    } else {
      // EVERY OTHER EVENT TYPE. This branch is not a formality: before Increment
      // C this method handled exactly three types and silently dropped anything
      // else — so the moment the graph gained an interrupt, its entire record
      // would have vanished with no error, and the closed-loop analysis would
      // have been quietly blind to the most important turns in the build.
      // An unrecognised event is stored, not discarded.
      this.db.prepare(`
        INSERT INTO converger_events
          (id, session_id, tenant_id, step, type, component, proposal_spec, response_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, sessionId, tenantId, entry.step ?? 0, String(entry.type ?? 'unknown'),
             entry.component ?? null,
             JSON.stringify(entry),
             entry.confirmation?.type ?? null, now);
    }

    // ── Provenance (P12 Increment C) ────────────────────────────────────────
    // Which turn produced each assertion, and which gaps nobody answered.
    try {
      if (entry.type === 'outcome_check') {
        for (const a of entry.outcome?.assertions ?? []) {
          this.appendProvenance(tenantId, sessionId, {
            kind: 'assertion', refId: a.id, step: entry.step,
            detail: { assertion: a, statement: entry.outcome?.statement, confirmedBy: entry.confirmation?.type ?? 'default' },
          });
        }
      }
      if (entry.type === 'gap_review') {
        for (const g of entry.escalated ?? []) {
          this.appendProvenance(tenantId, sessionId, {
            kind: 'gap_escalated', refId: g.id, step: entry.step,
            detail: { code: g.code, class: g.class, message: g.message },
          });
        }
        for (const [gapId, answer] of Object.entries(entry.answers ?? {})) {
          this.appendProvenance(tenantId, sessionId, {
            kind: 'gap_answered', refId: gapId, step: entry.step, detail: { answer },
          });
        }
      }
    } catch { /* provenance is a record, never a blocker on the build */ }
  }

  // ── Tenant-scoped reads ───────────────────────────────────────────────────

  getSession(tenantId, sessionId) {
    requireTenant(tenantId, 'getSession');
    return this.db.prepare(
      `SELECT * FROM converger_sessions WHERE id = ? AND tenant_id = ?`
    ).get(sessionId, tenantId) ?? null;
  }

  listSessions(tenantId, { limit = 50, offset = 0 } = {}) {
    requireTenant(tenantId, 'listSessions');
    return this.db.prepare(`
      SELECT * FROM converger_sessions
       WHERE tenant_id = ?
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?
    `).all(tenantId, limit, offset);
  }

  getEvents(tenantId, sessionId) {
    requireTenant(tenantId, 'getEvents');
    return this.db.prepare(`
      SELECT * FROM converger_events
       WHERE session_id = ? AND tenant_id = ?
       ORDER BY step ASC
    `).all(sessionId, tenantId);
  }

  // ── Platform-admin cross-tenant reads ────────────────────────────────────
  // Enforce platform-admin role at the API layer; no tenant filter here.

  listAllSessions({ limit = 200, offset = 0, tenantId = null } = {}) {
    if (tenantId) {
      return this.db.prepare(`
        SELECT * FROM converger_sessions
         WHERE tenant_id = ?
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?
      `).all(tenantId, limit, offset);
    }
    return this.db.prepare(`
      SELECT * FROM converger_sessions
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  /**
   * Aggregate signal query for closed-loop inference.
   * Returns modification texts, rejection patterns, and unresolvable intents.
   */
  querySignals({ since = 0, tenantId = null } = {}) {
    const args = [since];
    const tenantClause = tenantId ? 'AND e.tenant_id = ?' : '';
    if (tenantId) args.push(tenantId);

    const modifications = this.db.prepare(`
      SELECT e.component, e.modification, e.proposal_spec,
             s.intent, s.tenant_id, e.created_at
        FROM converger_events e
        JOIN converger_sessions s ON s.id = e.session_id
       WHERE e.type = 'proposal'
         AND e.response_type = 'modify'
         AND e.created_at >= ?
         ${tenantClause}
       ORDER BY e.created_at DESC
    `).all(...args);

    const rejections = this.db.prepare(`
      SELECT e.component, e.proposal_spec, s.intent, s.tenant_id, e.created_at
        FROM converger_events e
        JOIN converger_sessions s ON s.id = e.session_id
       WHERE e.type = 'proposal'
         AND e.response_type = 'reject'
         AND e.created_at >= ?
         ${tenantClause}
       ORDER BY e.created_at DESC
    `).all(...args);

    const abandoned = this.db.prepare(`
      SELECT intent, tenant_id, step_count, started_at
        FROM converger_sessions
       WHERE outcome = 'abandoned'
         AND started_at >= ?
         ${tenantId ? 'AND tenant_id = ?' : ''}
       ORDER BY started_at DESC
    `).all(...args);

    return { modifications, rejections, abandoned };
  }
}
