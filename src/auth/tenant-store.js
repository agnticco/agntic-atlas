/**
 * TenantStore — the registry of tenants (clients). The top-level scope: every
 * user and every resource lives under a tenant_id. Lives in the auth SQLite file
 * (shared handle), alongside users/sessions.
 *
 * The reserved `platform` tenant holds platform operators (admins who can manage
 * other tenants). See docs/architecture/multi-tenancy.md.
 *
 * @module src/auth/tenant-store.js
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { PLATFORM_TENANT_ID } from './user-store.js';
import { log } from '../utils/logger.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('active','suspended')) DEFAULT 'active',
  plan        TEXT NOT NULL DEFAULT 'solo',
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Sellable adoption ladder + `internal` (Atlas's own workspace, never sold) and
// the RETIRED `founding` plan, still accepted so historic rows validate. See
// src/entitlements/index.js and docs/architecture/tier-gating.md.
export const VALID_PLANS = ['solo', 'professional', 'team', 'business', 'internal', 'founding'];
const DEFAULT_PLAN = 'solo';

/**
 * Tenants that are Atlas itself, not customers — they get the uncapped `internal`
 * plan. Comma-separated override via INTERNAL_TENANT_IDS; the platform tenant is
 * always included. Kept as config, not a hardcoded id, so a second internal
 * workspace doesn't require a code change.
 */
const INTERNAL_TENANT_IDS = (process.env.INTERNAL_TENANT_IDS ?? 'agntic')
  .split(',').map(s => s.trim()).filter(Boolean);

export class TenantStore {
  constructor({ db = null, dbPath = null } = {}) {
    if (!db && !dbPath) throw new Error('TenantStore requires either db or dbPath');
    this._ownsDb = !db;
    this.db = db ?? new Database(dbPath);
  }

  async init() {
    if (this._ownsDb) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    this.db.exec(SCHEMA);
    // Additive migration: plan column for tier gating (pre-existing DBs).
    const cols = this.db.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
    if (!cols.includes('plan')) {
      this.db.exec("ALTER TABLE tenants ADD COLUMN plan TEXT NOT NULL DEFAULT 'solo'");
    }
    if (!cols.includes('archived_at')) {
      this.db.exec('ALTER TABLE tenants ADD COLUMN archived_at TEXT');
    }
    // Additive migration: Stripe subscription linkage (pilot pricing, 2026-07-09).
    if (!cols.includes('stripe_customer_id')) {
      this.db.exec('ALTER TABLE tenants ADD COLUMN stripe_customer_id TEXT');
    }
    if (!cols.includes('stripe_subscription_id')) {
      this.db.exec('ALTER TABLE tenants ADD COLUMN stripe_subscription_id TEXT');
    }

    // One-time grandfather migration: the pilot pricing rework introduces hard
    // adoption caps (Solo = 1 workflow / 30 runs). Every tenant that already
    // existed when this shipped is moved to the unlimited `founding` plan so the
    // new caps only bind NEW signups. Guarded by a marker row — a name-based
    // guard is unsafe because `team` is both an old and a new plan name, so a
    // real Team customer would be wrongly re-upgraded on every restart.
    this.db.exec(`CREATE TABLE IF NOT EXISTS tenant_store_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    const GRANDFATHER = 'grandfather_pilot_2026_07';
    const already = this.db.prepare('SELECT 1 FROM tenant_store_migrations WHERE name = ?').get(GRANDFATHER);
    if (!already) {
      const now = new Date().toISOString();
      this.db.transaction(() => {
        this.db.prepare(
          "UPDATE tenants SET plan = 'founding', updated_at = ? WHERE id != ? AND plan != 'founding'"
        ).run(now, PLATFORM_TENANT_ID);
        this.db.prepare('INSERT INTO tenant_store_migrations (name, applied_at) VALUES (?, ?)').run(GRANDFATHER, now);
      })();
    }

    // Retire `founding` (2026-07-13). It granted UNLIMITED runs, which is an
    // unbounded cost liability: the only backstop was a flat $25/day ceiling,
    // i.e. up to $750/month per tenant on a $20 plan. Every founding tenant is
    // moved onto a real, capped plan.
    //
    // Atlas's own workspaces move to `internal` (uncapped) instead — our own
    // company must not be rate-limited by a customer tier, and capping it would
    // have stopped our production workflows the moment this shipped.
    //
    // Marker-guarded so it runs exactly once and never re-downgrades a tenant who
    // later upgrades. Ordering matters: promote internal FIRST, then sweep the
    // remaining founding rows to solo, so an internal tenant is never briefly solo.
    const RETIRE_FOUNDING = 'retire_founding_2026_07_13';
    if (!this.db.prepare('SELECT 1 FROM tenant_store_migrations WHERE name = ?').get(RETIRE_FOUNDING)) {
      const now = new Date().toISOString();
      const internalIds = [PLATFORM_TENANT_ID, ...INTERNAL_TENANT_IDS];
      this.db.transaction(() => {
        const marks = internalIds.map(() => '?').join(',');
        this.db.prepare(
          `UPDATE tenants SET plan = 'internal', updated_at = ? WHERE id IN (${marks})`
        ).run(now, ...internalIds);
        this.db.prepare(
          "UPDATE tenants SET plan = 'solo', updated_at = ? WHERE plan = 'founding'"
        ).run(now);
        this.db.prepare('INSERT INTO tenant_store_migrations (name, applied_at) VALUES (?, ?)').run(RETIRE_FOUNDING, now);
      })();
      log.info(`[tenant-store] retired 'founding' plan; internal tenants: ${internalIds.join(', ')}`);
    }
  }

  close() {
    if (this._ownsDb && this.db) { try { this.db.close(); } catch { /* ignore */ } }
    this.db = null;
  }

  /** Idempotently ensure a reserved tenant row exists (no slug validation). */
  _ensureReserved(id, name) {
    if (!this.get(id)) {
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)`).run(id, name, id, now, now);
    }
    return this.get(id);
  }

  /** Ensure the reserved platform tenant exists (idempotent). */
  ensurePlatformTenant() { return this._ensureReserved(PLATFORM_TENANT_ID, 'Platform'); }



  /**
   * Create a tenant. `id` defaults to the slug (stable, human-readable). Throws
   * on a duplicate slug or a malformed slug.
   */
  create({ name, slug, id = null, plan = DEFAULT_PLAN }) {
    const cleanSlug = String(slug ?? '').trim().toLowerCase();
    if (!SLUG_RE.test(cleanSlug)) throw new Error('slug must be 2-63 chars, [a-z0-9-], starting alphanumeric');
    if (cleanSlug === PLATFORM_TENANT_ID) throw new Error('"platform" is reserved');
    const cleanPlan = VALID_PLANS.includes(String(plan)) ? String(plan) : DEFAULT_PLAN;
    const tid = id ?? cleanSlug;
    if (this.get(tid) || this.getBySlug(cleanSlug)) throw new Error('A tenant with that slug already exists.');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tenants (id, name, slug, status, plan, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(tid, String(name ?? cleanSlug), cleanSlug, cleanPlan, now, now);
    return this.get(tid);
  }

  /** Change a tenant's plan (tier gating). */
  setPlan(id, plan) {
    if (!VALID_PLANS.includes(String(plan))) throw new Error('invalid plan');
    this.db.prepare('UPDATE tenants SET plan = ?, updated_at = ? WHERE id = ?')
      .run(String(plan), new Date().toISOString(), id);
    return this.get(id);
  }

  /**
   * Link (or clear) a tenant's Stripe customer/subscription ids. Called by the
   * Stripe webhook handler so cancellations/updates can be reconciled back to a
   * tenant. Pass `null` for either id to leave it unchanged.
   */
  setStripeIds(id, { customerId = undefined, subscriptionId = undefined } = {}) {
    const sets = [];
    const vals = [];
    if (customerId !== undefined) { sets.push('stripe_customer_id = ?'); vals.push(customerId); }
    if (subscriptionId !== undefined) { sets.push('stripe_subscription_id = ?'); vals.push(subscriptionId); }
    if (!sets.length) return this.get(id);
    sets.push('updated_at = ?'); vals.push(new Date().toISOString());
    vals.push(id);
    this.db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.get(id);
  }

  /** Find a tenant by its Stripe customer id (webhook reconciliation). */
  getByStripeCustomer(customerId) {
    if (!customerId) return null;
    return this.db.prepare('SELECT * FROM tenants WHERE stripe_customer_id = ?').get(String(customerId)) ?? null;
  }

  get(id) {
    if (!id) return null;
    return this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) ?? null;
  }

  getBySlug(slug) {
    return this.db.prepare('SELECT * FROM tenants WHERE slug = ?').get(String(slug ?? '').toLowerCase()) ?? null;
  }

  list() {
    return this.db.prepare('SELECT * FROM tenants ORDER BY created_at').all();
  }

  /** True iff the tenant exists, is active, AND is not archived. Gates requests + scheduling. */
  isActive(id) {
    const t = this.get(id);
    return !!t && t.status === 'active' && !t.archived_at;
  }

  setStatus(id, status) {
    if (!['active', 'suspended'].includes(status)) throw new Error('status must be active or suspended');
    if (id === PLATFORM_TENANT_ID && status === 'suspended') throw new Error('cannot suspend the platform tenant');
    this.db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    return this.get(id);
  }

  /**
   * Soft-delete (archive) a tenant — hidden + inactive (users locked out,
   * scheduling halted), but all data is retained so it can be restored. A
   * separate hard-purge removes the data permanently. Cannot archive platform.
   */
  archive(id) {
    if (id === PLATFORM_TENANT_ID) throw new Error('cannot archive the platform tenant');
    if (!this.get(id)) throw new Error('tenant not found');
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tenants SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    return this.get(id);
  }

  /** Restore a previously-archived tenant to active. */
  restore(id) {
    this.db.prepare('UPDATE tenants SET archived_at = NULL, status = ?, updated_at = ? WHERE id = ?')
      .run('active', new Date().toISOString(), id);
    return this.get(id);
  }
}

export default TenantStore;
