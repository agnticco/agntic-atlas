/**
 * UserStore — SQLite-backed user registry with argon2id password hashing.
 *
 * Tables live in the auth SQLite file (default ./memory/auth.sqlite).
 * This is the canonical identity source for LocalAuthProvider. Custom
 * AuthProviders (OIDC/SAML adapters) may ignore password_hash but should
 * still mirror user rows here so ownership queries resolve.
 *
 * @module src/auth/user-store.js
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { log } from '../utils/logger.js';

// Multi-tenant: every user belongs to exactly one tenant (tenant_id). Email stays
// GLOBALLY unique so login-by-email resolves the user's tenant without the client
// having to name their workspace. Platform operators are `admin` users in the
// reserved 'platform' tenant (no separate role → no CHECK-constraint rebuild).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('admin','user')) DEFAULT 'user',
  display_name    TEXT NOT NULL DEFAULT '',
  disabled_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
`;
// NOTE: the tenant_id index is created in the migration (after the column is
// guaranteed) — never in SCHEMA, or exec(SCHEMA) on a legacy table without the
// column would fail with "no such column: tenant_id".

/** Reserved tenant whose admins are platform operators (can manage tenants). */
export const PLATFORM_TENANT_ID = 'platform';

/** Default homepage modules shown when a user has no saved preference. */
// time_saved is on by default so the ROI report (the customer-facing value
// proof) is discoverable out-of-the-box — it's otherwise reachable ONLY via the
// Home time-saved card's "View ROI report" link (B1).
export const DEFAULT_HOMEPAGE_MODULES = ['ai_greeting', 'time_saved'];

/** Fail-closed guard: a tenant-scoped op must never run without a tenant. */
function requireTenant(tenantId, where) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new Error(`tenant scope required for ${where} (refusing unscoped query)`);
  }
  return tenantId;
}

// Argon2id parameters — defaults from the owasp 2024 guidance.
// See docs/multi-user-architecture.md §5.3.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

export class UserStore {
  /**
   * @param {object} opts
   * @param {Database.Database|null} [opts.db]     - Existing better-sqlite3 handle
   * @param {string}                  [opts.dbPath] - Path to open if no handle was passed
   */
  constructor({ db = null, dbPath = null } = {}) {
    if (!db && !dbPath) throw new Error('UserStore requires either db or dbPath');
    this._ownsDb = !db;
    this.db = db ?? new Database(dbPath);
  }

  async init() {
    if (this._ownsDb) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');
    }
    this.db.exec(SCHEMA);
    this._migrateTenantId();
    this._migratePreferences();
  }

  /** Additive migration: add tenant_id to a legacy users table, backfilling 'default'. */
  _migrateTenantId() {
    const cols = this.db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
    if (!cols.includes('tenant_id')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    }
    // Create the index AFTER the column exists (fresh or migrated). Idempotent.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`);
  }

  /** Additive migrations: preferences JSON + last-login timestamp. */
  _migratePreferences() {
    const cols = this.db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
    if (!cols.includes('preferences')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN preferences TEXT`);
    }
    if (!cols.includes('last_login_at')) {
      this.db.exec(`ALTER TABLE users ADD COLUMN last_login_at TEXT`);
    }
  }

  /** Record a successful authentication. Used to tell "invited but not yet signed in". */
  markLogin(userId) {
    if (!userId) return;
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(new Date().toISOString(), userId);
  }

  /** True if any user in the tenant has ever signed in (has a last_login_at). */
  hasLogin(tenantId) {
    if (!tenantId) return false;
    return !!this.db.prepare('SELECT 1 FROM users WHERE tenant_id = ? AND last_login_at IS NOT NULL LIMIT 1').get(tenantId);
  }

  /** Return parsed user preferences, falling back to defaults when unset or corrupt. */
  getPreferences(userId, tenantId) {
    requireTenant(tenantId, 'UserStore.getPreferences');
    const row = this.db.prepare('SELECT preferences FROM users WHERE id = ? AND tenant_id = ?').get(userId, tenantId);
    if (!row?.preferences) return { homepageModules: DEFAULT_HOMEPAGE_MODULES };
    try { return JSON.parse(row.preferences); } catch { return { homepageModules: DEFAULT_HOMEPAGE_MODULES }; }
  }

  close() {
    if (this._ownsDb && this.db) { try { this.db.close(); } catch { /* ignore */ } }
    this.db = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new user. Password is hashed before storage.
   * @param {object} input
   * @param {string} input.email
   * @param {string} input.password
   * @param {'admin'|'user'} [input.role]
   * @param {string} [input.display_name]
   */
  async create({ tenantId, email, password, role = 'user', display_name = '' }) {
    requireTenant(tenantId, 'UserStore.create');
    const normalizedEmail = normalizeEmail(email);
    validateEmail(normalizedEmail);
    validatePassword(password);
    if (!['admin', 'user'].includes(role)) throw new Error('role must be admin or user');

    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) throw new Error('A user with that email already exists.');

    const password_hash = await argon2.hash(password, ARGON2_OPTIONS);
    const now = new Date().toISOString();
    const id  = randomUUID();

    this.db.prepare(`
      INSERT INTO users (id, tenant_id, email, password_hash, role, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, tenantId, normalizedEmail, password_hash, role, String(display_name ?? ''), now, now);

    return this.findById(id);
  }

  /** Global user count (all tenants). Used by platform bootstrap. */
  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  /** Users in one tenant. Used by per-tenant bootstrap / "any admin yet?" checks. */
  countForTenant(tenantId) {
    requireTenant(tenantId, 'UserStore.countForTenant');
    return this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?').get(tenantId).n;
  }

  /** Resolve by primary key (global) — used by middleware for the authed user's own id. */
  findById(id) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? publicShape(row) : null;
  }

  /** Resolve by id WITHIN a tenant — fail-closed for admin "get a user in my tenant". */
  findByIdInTenant(id, tenantId) {
    requireTenant(tenantId, 'UserStore.findByIdInTenant');
    const row = this.db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(id, tenantId);
    return row ? publicShape(row) : null;
  }

  findByEmail(email) {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
    return row ? publicShape(row) : null;
  }

  /** Internal — returns the row including password_hash. Only callable from within the module. */
  _findRowByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
  }

  /** List users in ONE tenant. Fail-closed: throws without a tenant (no global list). */
  list(tenantId) {
    requireTenant(tenantId, 'UserStore.list');
    return this.db.prepare('SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at')
      .all(tenantId).map(publicShape);
  }

  /**
   * Verify credentials. Returns the user on match, null otherwise.
   * Performs argon2 verify + rehash on demand if parameters have drifted.
   */
  async verifyPassword({ email, password }) {
    const row = this._findRowByEmail(email);
    if (!row) return null;
    if (row.disabled_at) return null;
    try {
      const ok = await argon2.verify(row.password_hash, password);
      if (!ok) return null;

      if (argon2.needsRehash(row.password_hash, ARGON2_OPTIONS)) {
        const fresh = await argon2.hash(password, ARGON2_OPTIONS);
        this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
          .run(fresh, new Date().toISOString(), row.id);
      }
      return publicShape(row);
    } catch (err) {
      log.warn(`[user-store] verify failed for ${email}: ${err.message}`);
      return null;
    }
  }

  /**
   * Change a user's password. Optionally verifies the current one first.
   * Returns the user on success; throws on mismatch.
   */
  async changePassword({ userId, oldPassword = null, newPassword }) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row) throw new Error('User not found.');
    if (row.disabled_at) throw new Error('User is disabled.');

    if (oldPassword != null) {
      const ok = await argon2.verify(row.password_hash, oldPassword);
      if (!ok) throw new Error('Current password is incorrect.');
    }
    validatePassword(newPassword);

    const fresh = await argon2.hash(newPassword, ARGON2_OPTIONS);
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(fresh, new Date().toISOString(), userId);
    return this.findById(userId);
  }

  // Admin-on-user ops are tenant-guarded: an admin can only mutate users in their
  // own tenant (WHERE id = ? AND tenant_id = ?). Fail-closed on a missing tenant.
  update(userId, patch, tenantId) {
    requireTenant(tenantId, 'UserStore.update');
    const row = this.db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(userId, tenantId);
    if (!row) throw new Error('User not found.');

    const updates = {};
    if (patch.display_name != null) updates.display_name = String(patch.display_name);
    if (patch.role != null) {
      if (!['admin', 'user'].includes(patch.role)) throw new Error('role must be admin or user');
      updates.role = patch.role;
    }
    if (patch.preferences != null) {
      try { updates.preferences = JSON.stringify(patch.preferences); }
      catch { throw new Error('preferences must be JSON-serializable'); }
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return this.findByIdInTenant(userId, tenantId);

    const assignments = keys.map(k => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE users SET ${assignments}, updated_at = @updated_at WHERE id = @id AND tenant_id = @tenant_id`)
      .run({ ...updates, id: userId, tenant_id: tenantId, updated_at: new Date().toISOString() });
    return this.findByIdInTenant(userId, tenantId);
  }

  /** Soft-disable. Disabled users can't authenticate but their data remains. */
  disable(userId, tenantId) {
    requireTenant(tenantId, 'UserStore.disable');
    this.db.prepare('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), userId, tenantId);
    return this.findByIdInTenant(userId, tenantId);
  }

  enable(userId, tenantId) {
    requireTenant(tenantId, 'UserStore.enable');
    this.db.prepare('UPDATE users SET disabled_at = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(new Date().toISOString(), userId, tenantId);
    return this.findByIdInTenant(userId, tenantId);
  }

  /** Hard delete. Use with care — prefer disable(). Tenant-guarded. */
  delete(userId, tenantId) {
    requireTenant(tenantId, 'UserStore.delete');
    this.db.prepare('DELETE FROM users WHERE id = ? AND tenant_id = ?').run(userId, tenantId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// helpers
// ═══════════════════════════════════════════════════════════════════════════

function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

function validateEmail(email) {
  if (!email || !EMAIL_RE.test(email)) throw new Error('A valid email is required.');
  if (email.length > 254) throw new Error('Email is too long.');
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LEN) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  if (pw.length > 1024) throw new Error('Password is too long.');
}

/**
 * Strip password_hash and normalize fields before returning to callers.
 * disabled_at stays on the object so the admin UI can show status.
 */
function publicShape(row) {
  if (!row) return null;
  return {
    id:           row.id,
    tenant_id:    row.tenant_id ?? 'default',
    email:        row.email,
    role:         row.role,
    display_name: row.display_name ?? '',
    disabled_at:  row.disabled_at ?? null,
    created_at:   row.created_at,
    updated_at:   row.updated_at,
  };
}

export default UserStore;
