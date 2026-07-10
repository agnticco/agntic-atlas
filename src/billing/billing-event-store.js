/**
 * BillingEventStore — SQLite log of subscription lifecycle events (signup,
 * reactivation, cancellation, plan change). Powers the admin "Sales" feed + its
 * unseen badge, mirroring TicketStore (src/support/ticket-store.js).
 *
 * Its own SQLite file (default ./memory/billing/events.sqlite), independent of the
 * workflow/auth DBs. Reads are cross-tenant BY DESIGN — only platform admins call
 * them (gated by requirePlatformAdmin at the route). MRR *totals* are derived at
 * the route from the live tenant roster + plan prices; this store only records the
 * event stream (each row carries the mrr delta at the moment it happened).
 *
 * @module src/billing/billing-event-store.js
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export const EVENT_TYPES = ['signup', 'reactivation', 'cancellation', 'plan_change'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS billing_events (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  tenant_id        TEXT,
  tenant_name      TEXT,
  plan             TEXT,
  prev_plan        TEXT,
  amount_cents     INTEGER,
  mrr_delta_cents  INTEGER,
  customer_email   TEXT,
  subscription_id  TEXT,
  seen             INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_events_created ON billing_events(created_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_seen    ON billing_events(seen);
`;

export class BillingEventStore {
  constructor({ db = null, dbPath = null } = {}) {
    if (!db && !dbPath) throw new Error('BillingEventStore requires either db or dbPath');
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

  /** Append a lifecycle event. Best-effort caller — never throws for a missing field. */
  record({ type, tenantId = null, tenantName = null, plan = null, prevPlan = null,
           amountCents = null, mrrDeltaCents = null, customerEmail = null, subscriptionId = null } = {}) {
    const id = `be_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO billing_events
        (id, type, tenant_id, tenant_name, plan, prev_plan, amount_cents, mrr_delta_cents, customer_email, subscription_id, seen, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      id, String(type ?? 'plan_change'), tenantId, tenantName, plan, prevPlan,
      amountCents == null ? null : Math.round(amountCents),
      mrrDeltaCents == null ? null : Math.round(mrrDeltaCents),
      customerEmail, subscriptionId, now,
    );
    return this.get(id);
  }

  get(id) {
    return this.db.prepare('SELECT * FROM billing_events WHERE id = ?').get(id) ?? null;
  }

  /** Most-recent events first. */
  list({ limit = 100 } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare('SELECT * FROM billing_events ORDER BY created_at DESC LIMIT ?').all(n);
  }

  /** `{ total, unseen }` — unseen drives the admin nav badge (like tickets' open count). */
  counts() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM billing_events').get().n;
    const unseen = this.db.prepare('SELECT COUNT(*) AS n FROM billing_events WHERE seen = 0').get().n;
    return { total, unseen };
  }

  /** Mark every event seen — called when the admin opens the Sales view. */
  markAllSeen() {
    const r = this.db.prepare('UPDATE billing_events SET seen = 1 WHERE seen = 0').run();
    return r.changes;
  }
}

export default BillingEventStore;
