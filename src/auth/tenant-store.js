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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  status      TEXT NOT NULL CHECK(status IN ('active','suspended')) DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

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
  }

  close() {
    if (this._ownsDb && this.db) { try { this.db.close(); } catch { /* ignore */ } }
    this.db = null;
  }

  /** Ensure the reserved platform tenant exists (idempotent). */
  ensurePlatformTenant() {
    if (!this.get(PLATFORM_TENANT_ID)) {
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?)`).run(PLATFORM_TENANT_ID, 'Platform', PLATFORM_TENANT_ID, now, now);
    }
    return this.get(PLATFORM_TENANT_ID);
  }

  /**
   * Create a tenant. `id` defaults to the slug (stable, human-readable). Throws
   * on a duplicate slug or a malformed slug.
   */
  create({ name, slug, id = null }) {
    const cleanSlug = String(slug ?? '').trim().toLowerCase();
    if (!SLUG_RE.test(cleanSlug)) throw new Error('slug must be 2-63 chars, [a-z0-9-], starting alphanumeric');
    if (cleanSlug === PLATFORM_TENANT_ID) throw new Error('"platform" is reserved');
    const tid = id ?? cleanSlug;
    if (this.get(tid) || this.getBySlug(cleanSlug)) throw new Error('A tenant with that slug already exists.');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO tenants (id, name, slug, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)`).run(tid, String(name ?? cleanSlug), cleanSlug, now, now);
    return this.get(tid);
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

  /** True iff the tenant exists AND is active. Used to gate request handling. */
  isActive(id) {
    const t = this.get(id);
    return !!t && t.status === 'active';
  }

  setStatus(id, status) {
    if (!['active', 'suspended'].includes(status)) throw new Error('status must be active or suspended');
    if (id === PLATFORM_TENANT_ID && status === 'suspended') throw new Error('cannot suspend the platform tenant');
    this.db.prepare('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
    return this.get(id);
  }
}

export default TenantStore;
