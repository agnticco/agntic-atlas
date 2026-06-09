/**
 * SessionStore — tracks active JWT sessions + one-time bootstrap tokens.
 *
 * Sessions persist the jti claim from the JWT so we can revoke without
 * waiting for the token to expire. The middleware verifies the JWT
 * cryptographically and then consults this store to confirm the session
 * is still active.
 *
 * @module src/auth/session-store.js
 */

import Database from 'better-sqlite3';
import { randomUUID, randomBytes, createHash } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  tenant_id       TEXT NOT NULL DEFAULT 'default',
  issued_at       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  last_seen_at    TEXT,
  transport       TEXT NOT NULL CHECK(transport IN ('cookie','bearer')) DEFAULT 'cookie',
  user_agent      TEXT,
  ip              TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
-- idx_sessions_tenant is created in init() after the tenant_id column is ensured.

CREATE TABLE IF NOT EXISTS bootstrap_tokens (
  token_hash      TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_boot_expires ON bootstrap_tokens(expires_at);
`;

const BOOTSTRAP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export class SessionStore {
  /**
   * @param {object} opts
   * @param {Database.Database|null} [opts.db]     - Shared handle (preferred)
   * @param {string}                 [opts.dbPath] - Path if opening a new handle
   */
  constructor({ db = null, dbPath = null } = {}) {
    if (!db && !dbPath) throw new Error('SessionStore requires either db or dbPath');
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
    const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
    if (!cols.includes('tenant_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id)`);
  }

  close() {
    if (this._ownsDb && this.db) { try { this.db.close(); } catch {} }
    this.db = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SESSIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * @param {object} opts
   * @param {string} opts.userId
   * @param {number} opts.ttlMs       - Session lifetime in ms (24h for cookies, 30d for bearer)
   * @param {'cookie'|'bearer'} opts.transport
   * @param {string} [opts.userAgent]
   * @param {string} [opts.ip]
   * @returns {{ id, user_id, issued_at, expires_at, transport }}
   */
  create({ userId, tenantId, ttlMs, transport, userAgent = null, ip = null }) {
    if (!userId) throw new Error('userId is required');
    if (!tenantId) throw new Error('tenantId is required');
    if (!ttlMs || ttlMs <= 0) throw new Error('ttlMs must be positive');
    if (!['cookie', 'bearer'].includes(transport)) throw new Error('transport must be cookie or bearer');

    const id         = randomUUID();
    const issuedAt   = new Date();
    const expiresAt  = new Date(issuedAt.getTime() + ttlMs);

    this.db.prepare(`
      INSERT INTO sessions (id, user_id, tenant_id, issued_at, expires_at, transport, user_agent, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, tenantId, issuedAt.toISOString(), expiresAt.toISOString(), transport, userAgent, ip);

    return this.findById(id);
  }

  findById(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ?? null;
  }

  /**
   * True if a session is active: exists, not revoked, not expired.
   * Updates last_seen_at as a side effect of success.
   */
  touch(id) {
    const row = this.findById(id);
    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    return row;
  }

  /** Revoke a single session (logout). */
  revoke(id) {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  /**
   * Revoke every active session for a user (e.g. on password change).
   * @param {string} userId
   * @param {object} [opts]
   * @param {string} [opts.exceptSessionId] - keep this session alive (typically the caller's current session)
   */
  revokeAllForUser(userId, { exceptSessionId = null } = {}) {
    const now = new Date().toISOString();
    if (exceptSessionId) {
      this.db.prepare(`
        UPDATE sessions SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL AND id != ?
      `).run(now, userId, exceptSessionId);
    } else {
      this.db.prepare(`
        UPDATE sessions SET revoked_at = ?
         WHERE user_id = ? AND revoked_at IS NULL
      `).run(now, userId);
    }
  }

  listForUser(userId) {
    return this.db.prepare(`
      SELECT * FROM sessions WHERE user_id = ? ORDER BY issued_at DESC
    `).all(userId);
  }

  /** Delete expired + revoked sessions older than 30 days. Safe to run periodically. */
  prune() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      DELETE FROM sessions
       WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
    `).run(new Date().toISOString(), cutoff);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BOOTSTRAP TOKENS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Issue a one-time setup token. The raw token is returned to the caller to
   * print once; only its sha256 is stored. Previous unused tokens are
   * invalidated so logs always point at a single valid token.
   * @returns {string} raw token (hex, 64 chars)
   */
  createBootstrapToken() {
    this.db.prepare('DELETE FROM bootstrap_tokens WHERE used_at IS NULL').run();
    const raw  = randomBytes(32).toString('hex');
    const hash = sha256(raw);
    const now  = new Date();
    const exp  = new Date(now.getTime() + BOOTSTRAP_TOKEN_TTL_MS);
    this.db.prepare(`
      INSERT INTO bootstrap_tokens (token_hash, created_at, expires_at)
      VALUES (?, ?, ?)
    `).run(hash, now.toISOString(), exp.toISOString());
    return raw;
  }

  /**
   * Atomically consume a setup token. Returns true only if the token was
   * valid AND unused AND unexpired, AND this call was the one that marked
   * it used (prevents race between concurrent setup submissions).
   */
  consumeBootstrapToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return false;
    const hash = sha256(rawToken.trim());
    const row = this.db.prepare('SELECT * FROM bootstrap_tokens WHERE token_hash = ?').get(hash);
    if (!row) return false;
    if (row.used_at) return false;
    if (new Date(row.expires_at).getTime() < Date.now()) return false;

    // Atomic "mark used only if still unused" — if two requests land at the
    // same instant, only one UPDATE will report changes>0.
    const result = this.db.prepare(`
      UPDATE bootstrap_tokens SET used_at = ?
       WHERE token_hash = ? AND used_at IS NULL
    `).run(new Date().toISOString(), hash);

    return result.changes === 1;
  }

  /** Purge stale bootstrap tokens. */
  pruneBootstrapTokens() {
    this.db.prepare(`
      DELETE FROM bootstrap_tokens
       WHERE used_at IS NOT NULL OR expires_at < ?
    `).run(new Date().toISOString());
  }

  /** Whether a currently-valid, unused bootstrap token exists. */
  hasActiveBootstrapToken() {
    const row = this.db.prepare(`
      SELECT token_hash FROM bootstrap_tokens
       WHERE used_at IS NULL AND expires_at > ?
       LIMIT 1
    `).get(new Date().toISOString());
    return !!row;
  }
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export default SessionStore;
