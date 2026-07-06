/**
 * PasswordResetStore — one-time, expiring password-reset tokens.
 *
 * Security model:
 *   - The plaintext token (32 random bytes, base64url) is returned once to the
 *     caller and placed only in the emailed link. Only its SHA-256 hash is
 *     stored, so a database leak never yields usable tokens.
 *   - Single-use: a token is marked used the moment a reset succeeds, and used
 *     or expired tokens never validate again.
 *   - Requesting a new token invalidates any outstanding ones for that user.
 *
 * Shares the auth DB connection (created in createAuthSubsystem).
 */

import { createHash, randomBytes } from 'node:crypto';

export function newResetToken() { return randomBytes(32).toString('base64url'); }
export function hashResetToken(token) { return createHash('sha256').update(String(token)).digest('hex'); }

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export class PasswordResetStore {
  constructor({ db }) { this.db = db; }

  async init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        tenant_id  TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);
    `);
    return this;
  }

  /**
   * Issue a fresh token for a user, invalidating any outstanding ones.
   * Returns the PLAINTEXT token — store only ever persists the hash.
   */
  create({ userId, tenantId, ttlMs = DEFAULT_TTL_MS }) {
    this.db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(userId);
    const token = newResetToken();
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO password_reset_tokens (token_hash, user_id, tenant_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(hashResetToken(token), userId, tenantId, new Date(now).toISOString(), new Date(now + ttlMs).toISOString());
    return token;
  }

  /** Return the row for a valid (unused, unexpired) token, else null. Does not consume. */
  peek(token) {
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(hashResetToken(token));
    if (!row || row.used_at) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    return row;
  }

  /** Mark a token consumed. Returns true if it was still valid + unused. */
  markUsed(token) {
    const info = this.db.prepare(
      'UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL',
    ).run(new Date().toISOString(), hashResetToken(token));
    return info.changes > 0;
  }

  /** Housekeeping: drop expired/used rows. */
  purgeExpired() {
    this.db.prepare('DELETE FROM password_reset_tokens WHERE expires_at < ? OR used_at IS NOT NULL')
      .run(new Date().toISOString());
  }
}
