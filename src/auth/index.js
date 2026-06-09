/**
 * Auth module — user identity, sessions, and JWT-based middleware.
 *
 * Public surface:
 *   - UserStore, SessionStore   — SQLite-backed
 *   - TokenService              — JWT sign/verify
 *   - AuthProvider              — interface
 *   - LocalAuthProvider         — default implementation (argon2id)
 *   - ensureBootstrap, completeBootstrap — first-run admin flow
 *   - buildAuthMiddleware       — requireAuth / requireAdmin / optionalAuth
 *   - createAuthSubsystem       — convenience constructor used by server.js
 *
 * @module src/auth/index.js
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { UserStore, PLATFORM_TENANT_ID } from './user-store.js';
import { SessionStore } from './session-store.js';
import { TenantStore } from './tenant-store.js';
import { TokenService, COOKIE_TTL_MS, BEARER_TTL_MS } from './token-service.js';
import { AuthProvider } from './auth-provider.js';
import { LocalAuthProvider } from './local-auth-provider.js';
import { ensureBootstrap, completeBootstrap } from './bootstrap.js';
import { buildAuthMiddleware, COOKIE_NAME } from './middleware.js';
import { resolveOAuthKey } from './oauth-key.js';
import { TokenCipher } from './token-cipher.js';
import { OAuthTokenStore } from './oauth-token-store.js';
import { OAuthClient, googleProviderConfig } from './oauth-client.js';
import { getConnector, providerConfigFromManifest } from '../connectors/connector-manifest.js';

export {
  UserStore,
  SessionStore,
  TokenService,
  AuthProvider,
  LocalAuthProvider,
  ensureBootstrap,
  completeBootstrap,
  buildAuthMiddleware,
  COOKIE_NAME,
  COOKIE_TTL_MS,
  BEARER_TTL_MS,
  OAuthTokenStore,
  OAuthClient,
  TokenCipher,
};

/**
 * Convenience: stand up the entire auth subsystem against a single SQLite
 * file. Server.js calls this at boot and then wires the returned services
 * into endpoints + middleware.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbPath]      - default './memory/auth.sqlite'
 * @param {string} [opts.secretPath]  - default './memory/.jwt-secret'
 */
export async function createAuthSubsystem({
  dbPath        = './memory/auth.sqlite',
  secretPath    = './memory/.jwt-secret',
  oauthDbPath   = './memory/oauth.sqlite',
  oauthKeyPath  = './memory/.oauth-key',
} = {}) {
  const absDb = resolve(dbPath);
  try { mkdirSync(dirname(absDb), { recursive: true }); } catch { /* ok */ }

  // Single SQLite handle shared by the user + session stores so they
  // participate in the same WAL and a single close() tears down both.
  const db = new Database(absDb);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  const userStore    = new UserStore({ db });
  await userStore.init();
  const sessionStore = new SessionStore({ db });
  await sessionStore.init();
  const tenantStore  = new TenantStore({ db });
  await tenantStore.init();
  tenantStore.ensurePlatformTenant();
  tenantStore.ensureDefaultTenant(); // home for migrated single-user pilot data

  const tokenService = TokenService.fromEnvOrFile({ secretPath });
  const authProvider = new LocalAuthProvider({ userStore });

  const middleware = buildAuthMiddleware({ tokenService, sessionStore, userStore });

  const bootstrap = ensureBootstrap({ userStore, sessionStore, tenantStore });

  /**
   * Issue a session + signed JWT (carrying the tenant claim `tid`) for a user.
   * The single place login/setup routes mint a token, so the tenant is always
   * stamped into both the session row and the token.
   */
  function issueSession({ user, transport = 'bearer', userAgent = null, ip = null }) {
    const ttlMs = transport === 'cookie' ? COOKIE_TTL_MS : BEARER_TTL_MS;
    const session = sessionStore.create({ userId: user.id, tenantId: user.tenant_id, ttlMs, transport, userAgent, ip });
    const token = tokenService.sign({ userId: user.id, tenantId: user.tenant_id, sessionId: session.id, role: user.role, ttlMs });
    return { session, token, ttlMs };
  }

  // OAuth subsystem (Slice 1). Dedicated SQLite file + dedicated encryption
  // key (lifecycle mirrors .jwt-secret). The token store only ever holds
  // ciphertext; OAuthClient owns the cipher boundary.
  const absOauthDb = resolve(oauthDbPath);
  try { mkdirSync(dirname(absOauthDb), { recursive: true }); } catch { /* ok */ }
  const oauthDb = new Database(absOauthDb);
  const oauthTokenStore = new OAuthTokenStore({ db: oauthDb });
  await oauthTokenStore.init();
  const { key: oauthKey, source: oauthKeySource } = resolveOAuthKey({ keyPath: oauthKeyPath });
  const oauthCipher = new TokenCipher(oauthKey);
  // Slice 5: manifest-driven provider resolution so connector #2/#N are
  // genuinely config-only. A manifest entry carrying an `oauth.provider` spec
  // resolves via providerConfigFromManifest (client id/secret from the
  // per-deployment env-var names it declares — Fork-2B, no secrets in source).
  // Entries without one (e.g. google) fall through to the built-in
  // googleProviderConfig — backward compatible. Truly unknown ids → null →
  // OAuthClient throws "unknown connector" as before.
  const oauth = new OAuthClient({
    store: oauthTokenStore,
    cipher: oauthCipher,
    resolveProvider: (id) =>
      providerConfigFromManifest(getConnector(id)) ??
      (id === 'google' ? googleProviderConfig() : null),
  });

  return {
    db,
    userStore,
    sessionStore,
    tenantStore,
    tokenService,
    authProvider,
    middleware,
    bootstrap,
    issueSession,
    /** Consume a setup token + create the first platform admin. */
    completeBootstrap: (input) => completeBootstrap({ userStore, sessionStore, authProvider, tenantStore }, input),
    platformTenantId: PLATFORM_TENANT_ID,
    oauth,
    oauthTokenStore,
    tokenCipher: oauthCipher, // AES-256-GCM cipher for connector tokens (e.g. Slack OAuth)
    oauthKeySource,
    /** Tear down — call on shutdown. */
    close() {
      try { db.close(); } catch { /* ignore */ }
      try { oauthDb.close(); } catch { /* ignore */ }
    },
  };
}

export default createAuthSubsystem;
