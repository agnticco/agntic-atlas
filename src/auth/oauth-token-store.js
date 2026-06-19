/**
 * OAuthTokenStore — SQLite persistence for per-user OAuth tokens.
 *
 * Pure persistence layer: it stores and returns ciphertext exactly as given.
 * Encryption/decryption is the OAuthClient's responsibility (TokenCipher), so
 * the boundary "plaintext never touches disk" is enforced at one place and
 * this store can never accidentally write a plaintext token.
 *
 * Mirrors the UserStore / SessionStore constructor + init() convention
 * (accepts a shared db handle OR its own dbPath). The connector_id is an
 * opaque string (e.g. 'google'); later slices' MCP rows reference it, never
 * embed the secret.
 *
 * @module src/auth/oauth-token-store.js
 */

import Database from 'better-sqlite3';

// tenant_id is added as a column (user_id is a global UUID, so (user_id,
// connector_id) is already globally unique — no PK rebuild needed). Every method
// is fail-closed: it requires a tenant and filters `AND tenant_id = ?`, so a
// wrong-tenant access can never read or mutate another tenant's credentials.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_tokens (
  user_id            TEXT NOT NULL,
  tenant_id          TEXT NOT NULL DEFAULT 'default',
  connector_id       TEXT NOT NULL,
  access_token_enc   TEXT NOT NULL,
  refresh_token_enc  TEXT,
  scope              TEXT NOT NULL DEFAULT '',
  expiry             INTEGER NOT NULL DEFAULT 0,   -- epoch ms; 0 = unknown
  account            TEXT,                          -- e.g. the connected email
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (user_id, connector_id)
);
CREATE INDEX IF NOT EXISTS idx_oauth_user   ON oauth_tokens(user_id);
`;
// idx_oauth_tenant is created in init() after the tenant_id column is ensured.

function requireTenant(tenantId, where) {
  if (typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new Error(`tenant scope required for ${where} (refusing unscoped vault access)`);
  }
  return tenantId;
}

export class OAuthTokenStore {
  /**
   * @param {object} opts
   * @param {Database.Database|null} [opts.db]     - existing better-sqlite3 handle
   * @param {string}                  [opts.dbPath] - path to open if no handle passed
   */
  constructor({ db = null, dbPath = null } = {}) {
    if (!db && !dbPath) throw new Error('OAuthTokenStore requires either db or dbPath');
    this._ownsDb = !db;
    this.db = db ?? new Database(dbPath);
  }

  async init() {
    if (this._ownsDb) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }
    this.db.exec(SCHEMA);
    const cols = this.db.prepare(`PRAGMA table_info(oauth_tokens)`).all().map((c) => c.name);
    if (!cols.includes('tenant_id')) {
      this.db.exec(`ALTER TABLE oauth_tokens ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_tenant ON oauth_tokens(tenant_id, user_id)`);
  }

  close() {
    if (this._ownsDb && this.db) { try { this.db.close(); } catch { /* ignore */ } }
    this.db = null;
  }

  /**
   * Insert or replace the token row for (user_id, connector_id).
   * @param {object} row
   * @param {string} row.userId
   * @param {string} row.connectorId
   * @param {string} row.accessTokenEnc   - ciphertext (TokenCipher output)
   * @param {string|null} row.refreshTokenEnc - ciphertext or null
   * @param {string} [row.scope]
   * @param {number} [row.expiry]         - epoch ms
   * @param {string|null} [row.account]
   */
  upsert({ tenantId, userId, connectorId, accessTokenEnc, refreshTokenEnc = null, scope = '', expiry = 0, account = null }) {
    requireTenant(tenantId, 'OAuthTokenStore.upsert');
    if (!userId || !connectorId) throw new Error('upsert requires userId and connectorId');
    if (!accessTokenEnc)         throw new Error('upsert requires accessTokenEnc');
    const now = Date.now();
    const existing = this.db
      .prepare('SELECT created_at FROM oauth_tokens WHERE user_id = ? AND connector_id = ? AND tenant_id = ?')
      .get(userId, connectorId, tenantId);
    this.db.prepare(`
      INSERT INTO oauth_tokens
        (user_id, tenant_id, connector_id, access_token_enc, refresh_token_enc, scope, expiry, account, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, connector_id) DO UPDATE SET
        access_token_enc  = excluded.access_token_enc,
        -- keep the prior refresh token when the provider didn't return a new
        -- one (Google omits it on refresh) — never overwrite with NULL.
        refresh_token_enc = COALESCE(excluded.refresh_token_enc, oauth_tokens.refresh_token_enc),
        scope             = excluded.scope,
        expiry            = excluded.expiry,
        account           = COALESCE(excluded.account, oauth_tokens.account),
        updated_at        = excluded.updated_at
    `).run(
      userId, tenantId, connectorId, accessTokenEnc, refreshTokenEnc, scope,
      // epoch-ms timestamps exceed 32 bits — `| 0` would truncate and corrupt
      // the expiry (making the fresh fast-path never fire → refresh-storm).
      (Number.isFinite(+expiry) ? Math.trunc(+expiry) : 0), account,
      existing?.created_at ?? now, now,
    );
    return this.get({ tenantId, userId, connectorId });
  }

  /** Get the raw (still-encrypted) row, or null. Fail-closed: tenant-scoped. */
  get({ tenantId, userId, connectorId }) {
    requireTenant(tenantId, 'OAuthTokenStore.get');
    if (!userId || !connectorId) return null;
    return this.db
      .prepare('SELECT * FROM oauth_tokens WHERE user_id = ? AND connector_id = ? AND tenant_id = ?')
      .get(userId, connectorId, tenantId) || null;
  }

  /** Whether a token row exists for this tenant+owner+connector. */
  has({ tenantId, userId, connectorId }) {
    return !!this.get({ tenantId, userId, connectorId });
  }

  /**
   * Resolve the tenant that owns a connector install by its `account` value
   * (e.g. a Slack team_id). Used to route inbound connector webhooks/events to
   * the correct tenant — the trust boundary for event dispatch. Returns the
   * tenant_id or null. (If two tenants somehow share an account, returns the
   * first; account should be globally unique per connector install.)
   */
  findTenantByAccount({ connectorId, account }) {
    if (!connectorId || !account) return null;
    const row = this.db
      .prepare('SELECT tenant_id FROM oauth_tokens WHERE connector_id = ? AND account = ? LIMIT 1')
      .get(connectorId, account);
    return row?.tenant_id ?? null;
  }

  /** Delete the row. Returns true if a row was removed. Tenant-scoped. */
  delete({ tenantId, userId, connectorId }) {
    requireTenant(tenantId, 'OAuthTokenStore.delete');
    if (!userId || !connectorId) return false;
    const r = this.db
      .prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND connector_id = ? AND tenant_id = ?')
      .run(userId, connectorId, tenantId);
    return r.changes > 0;
  }

  /** Update only the rotated token fields after a refresh. Tenant-scoped. */
  updateTokens({ tenantId, userId, connectorId, accessTokenEnc, refreshTokenEnc = null, expiry = 0 }) {
    requireTenant(tenantId, 'OAuthTokenStore.updateTokens');
    const now = Date.now();
    this.db.prepare(`
      UPDATE oauth_tokens
         SET access_token_enc  = ?,
             refresh_token_enc = COALESCE(?, refresh_token_enc),
             expiry            = ?,
             updated_at        = ?
       WHERE user_id = ? AND connector_id = ? AND tenant_id = ?
    `).run(accessTokenEnc, refreshTokenEnc,
      (Number.isFinite(+expiry) ? Math.trunc(+expiry) : 0),  // not `| 0` — 32-bit truncates epoch-ms
      now, userId, connectorId, tenantId);
    return this.get({ tenantId, userId, connectorId });
  }
}

export default OAuthTokenStore;
