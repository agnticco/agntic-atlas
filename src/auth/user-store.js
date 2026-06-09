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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL CHECK(role IN ('admin','user')) DEFAULT 'user',
  display_name    TEXT NOT NULL DEFAULT '',
  disabled_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`;

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
  async create({ email, password, role = 'user', display_name = '' }) {
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
      INSERT INTO users (id, email, password_hash, role, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, normalizedEmail, password_hash, role, String(display_name ?? ''), now, now);

    return this.findById(id);
  }

  /** Whether any user exists. Used by bootstrap logic. */
  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  }

  findById(id) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
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

  list() {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicShape);
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

  update(userId, patch) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!row) throw new Error('User not found.');

    const updates = {};
    if (patch.display_name != null) updates.display_name = String(patch.display_name);
    if (patch.role != null) {
      if (!['admin', 'user'].includes(patch.role)) throw new Error('role must be admin or user');
      updates.role = patch.role;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) return this.findById(userId);

    const assignments = keys.map(k => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE users SET ${assignments}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...updates, id: userId, updated_at: new Date().toISOString() });
    return this.findById(userId);
  }

  /** Soft-disable. Disabled users can't authenticate but their data remains. */
  disable(userId) {
    this.db.prepare('UPDATE users SET disabled_at = ?, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), userId);
    return this.findById(userId);
  }

  enable(userId) {
    this.db.prepare('UPDATE users SET disabled_at = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), userId);
    return this.findById(userId);
  }

  /** Hard delete. Use with care — prefer disable(). */
  delete(userId) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
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
    email:        row.email,
    role:         row.role,
    display_name: row.display_name ?? '',
    disabled_at:  row.disabled_at ?? null,
    created_at:   row.created_at,
    updated_at:   row.updated_at,
  };
}

export default UserStore;
