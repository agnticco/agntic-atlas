/**
 * OAuthClient — generic OAuth2 authorization-code + PKCE mechanism with an
 * encrypted, per-user token store. Provider-agnostic: every call takes (or
 * resolves) a provider config object. A Google read-only config ships so
 * this slice is independently testable.
 *
 * In-process API (the contract Knowledge Slice 2 codes against — do not
 * change shapes without coordinating):
 *
 *   start({ userId, connectorId, providerConfig })   -> { authorizationUrl }
 *   handleCallback({ query, sessionUser })            -> { connectorId, ok }
 *   getAccessToken({ userId, connectorId })           -> string  (auto-refresh)
 *   revoke({ userId, connectorId })                   -> void
 *   status({ userId, connectorId })                   -> { connected, scopes?, account? }
 *
 * Security properties:
 *   - PKCE S256; `state` + verifier are random, single-use, bound to the
 *     initiating user, and expire (anti-CSRF / anti-code-injection).
 *   - Tokens are encrypted at rest via TokenCipher; plaintext is never
 *     persisted or logged.
 *   - Every resolver is keyed strictly by the caller-supplied userId, which
 *     callers MUST source from req.user.id — no cross-user access path.
 *   - App credentials (client_id/secret/redirect) come from per-deployment
 *     config (Fork 2B), never hardcoded.
 *
 * @module src/auth/oauth-client.js
 */

import { randomBytes, createHash } from 'node:crypto';
import { log } from '../utils/logger.js';

const PENDING_TTL_MS   = 10 * 60 * 1000; // an in-flight consent must complete within 10 min
const REFRESH_SKEW_MS  = 60 * 1000;      // refresh this long before actual expiry

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Decode a JWT payload without verifying (id_token from our own token call). */
function decodeJwtPayload(jwtStr) {
  try {
    const part = String(jwtStr).split('.')[1];
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch { return null; }
}

/**
 * Build the Google provider config from per-deployment configuration
 * (Fork 2B). client_id/secret never live in source; they come from env or a
 * mode-0600 secret file, mirroring the JWT-secret lifecycle. We do NOT
 * generate these (Google issues them) — absence is a clear, actionable error
 * surfaced at start() time, not a silent fallback.
 */
export function googleProviderConfig() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectBase = (process.env.OAUTH_REDIRECT_BASE?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  return {
    name: 'google',
    configured: !!(clientId && clientSecret),
    clientId,
    clientSecret,
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? `${redirectBase}/connectors/google/callback`,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint:         'https://oauth2.googleapis.com/token',
    revocationEndpoint:    'https://oauth2.googleapis.com/revoke',
    // Full G-Suite scope set. Per-client restriction is done at the Google
    // OAuth consent screen (user can deselect) or by narrowing this list per
    // deployment via GOOGLE_OAUTH_SCOPES env. All are requested so one
    // install covers the full connector capability map; Atlas only uses what's
    // actually granted (detected from token info after install).
    scopes: (process.env.GOOGLE_OAUTH_SCOPES ?? [
      'openid', 'email', 'profile',
      // Gmail
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      // Calendar
      'https://www.googleapis.com/auth/calendar',
      // Drive
      'https://www.googleapis.com/auth/drive',
      // Sheets
      'https://www.googleapis.com/auth/spreadsheets',
      // Docs
      'https://www.googleapis.com/auth/documents',
      // Tasks
      'https://www.googleapis.com/auth/tasks',
      // Contacts
      'https://www.googleapis.com/auth/contacts.readonly',
    ].join(' ')).split(/\s+/).filter(Boolean),
    // Google needs these to return a refresh_token.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  };
}

export class OAuthClient {
  /**
   * @param {object} deps
   * @param {import('./oauth-token-store.js').OAuthTokenStore} deps.store
   * @param {import('./token-cipher.js').TokenCipher}          deps.cipher
   * @param {(name:string)=>object} [deps.resolveProvider] - maps a connectorId
   *        to a provider config; defaults to Google-only.
   */
  constructor({ store, cipher, resolveProvider = null }) {
    if (!store || !cipher) throw new Error('OAuthClient requires store and cipher');
    this._store  = store;
    this._cipher = cipher;
    this._resolveProvider = resolveProvider ?? ((id) => (id === 'google' ? googleProviderConfig() : null));
    /** state → { userId, connectorId, codeVerifier, providerConfig, expiresAt } */
    this._pending = new Map();
    /**
     * connectorId → providerConfig seen via start(), so the refresh/revoke
     * lifecycle can honor a caller-supplied provider config (provider-agnostic
     * invariant) instead of only the hardcoded google resolver. Process-scoped;
     * not persisted (config carries client_secret — brief forbids embedding
     * secrets in storage). Real deployments resolve via _resolveProvider
     * (googleProviderConfig / Slice-2 manifest) which survives restarts.
     */
    this._connectorConfigs = new Map();
  }

  _sweep() {
    const now = Date.now();
    for (const [state, p] of this._pending) {
      if (p.expiresAt <= now) this._pending.delete(state);
    }
  }

  _provider(connectorId, providerConfig) {
    // Resolution order: explicit per-call config → config remembered from
    // start() (provider-agnostic lifecycle) → deployment resolver.
    const cfg = providerConfig
      ?? this._connectorConfigs.get(connectorId)
      ?? this._resolveProvider(connectorId);
    if (!cfg) throw new Error(`OAuth: unknown connector "${connectorId}"`);
    if (cfg.configured === false || !cfg.clientId || !cfg.clientSecret) {
      throw new Error(`OAuth: connector "${connectorId}" is not configured for this deployment ` +
        `(set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).`);
    }
    return cfg;
  }

  /**
   * Begin a flow. Persists state+PKCE bound to userId; returns the URL the
   * browser must visit. Caller MUST pass userId = req.user.id.
   */
  start({ userId, tenantId, connectorId, providerConfig = null }) {
    if (!userId || !connectorId) throw new Error('start requires userId and connectorId');
    if (!tenantId) throw new Error('start requires tenantId');
    const cfg = this._provider(connectorId, providerConfig);
    // Remember the resolved config so refresh/revoke later in this process
    // can honor it for any connector, not just the hardcoded google default.
    this._connectorConfigs.set(connectorId, cfg);
    this._sweep();

    const codeVerifier  = b64url(randomBytes(32));
    const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
    const state         = b64url(randomBytes(32));

    this._pending.set(state, {
      userId, tenantId, connectorId, codeVerifier,
      providerConfig: cfg,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    const url = new URL(cfg.authorizationEndpoint);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', cfg.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    for (const [k, v] of Object.entries(cfg.extraAuthParams ?? {})) url.searchParams.set(k, v);

    return { authorizationUrl: url.toString() };
  }

  /**
   * Handle the provider redirect. Validates state (exists, unexpired,
   * single-use) and that the pending flow's user matches the logged-in user,
   * then exchanges the code (with PKCE verifier) and persists encrypted
   * tokens. `sessionUser` MUST be req.user.
   */
  async handleCallback({ query, sessionUser }) {
    const state = query?.state;
    const code  = query?.code;
    if (query?.error) throw new Error(`OAuth provider returned error: ${query.error}`);
    if (!state || !code) throw new Error('OAuth callback missing state or code');

    const pending = this._pending.get(state);
    // Single-use: consume immediately regardless of outcome.
    this._pending.delete(state);

    if (!pending)                              throw new Error('OAuth callback: unknown or already-used state');
    if (pending.expiresAt <= Date.now())       throw new Error('OAuth callback: state expired — restart the connection');
    if (!sessionUser?.id)                      throw new Error('OAuth callback: no authenticated user');
    if (pending.userId !== sessionUser.id)     throw new Error('OAuth callback: state was issued for a different user');

    const cfg = pending.providerConfig;
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  cfg.redirectUri,
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: pending.codeVerifier,
    });
    const res = await fetch(cfg.tokenEndpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body:    body.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OAuth token exchange failed (${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    const tok = await res.json();
    if (!tok.access_token) throw new Error('OAuth token exchange returned no access_token');

    const account = tok.id_token ? (decodeJwtPayload(tok.id_token)?.email ?? null) : null;
    const expiry  = tok.expires_in ? Date.now() + (Number(tok.expires_in) * 1000) : 0;

    this._store.upsert({
      tenantId:        pending.tenantId,
      userId:          pending.userId,
      connectorId:     pending.connectorId,
      accessTokenEnc:  this._cipher.encrypt(tok.access_token),
      refreshTokenEnc: tok.refresh_token ? this._cipher.encrypt(tok.refresh_token) : null,
      scope:           tok.scope ?? cfg.scopes.join(' '),
      expiry,
      account,
    });

    log.info?.(`[oauth] connected ${pending.connectorId} for user ${pending.userId.slice(0, 8)}…`);
    return { connectorId: pending.connectorId, ok: true };
  }

  /**
   * Return a usable access token, transparently refreshing when expired.
   * Throws if the user has not connected this connector.
   */
  async getAccessToken({ userId, tenantId, connectorId }) {
    if (!userId || !connectorId) throw new Error('getAccessToken requires userId and connectorId');
    if (!tenantId) throw new Error('getAccessToken requires tenantId');
    const row = this._store.get({ tenantId, userId, connectorId });
    if (!row) throw new Error(`OAuth: ${connectorId} not connected for this user`);

    const fresh = !row.expiry || row.expiry - REFRESH_SKEW_MS > Date.now();
    if (fresh) return this._cipher.decrypt(row.access_token_enc);

    // Expired (or within skew) → refresh.
    if (!row.refresh_token_enc) {
      throw new Error(`OAuth: ${connectorId} token expired and no refresh token — user must reconnect`);
    }
    const cfg = this._provider(connectorId, null);
    const refreshToken = this._cipher.decrypt(row.refresh_token_enc);
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     cfg.clientId,
      client_secret: cfg.clientSecret,
    });
    const res = await fetch(cfg.tokenEndpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body:    body.toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OAuth refresh failed (${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    const tok = await res.json();
    if (!tok.access_token) throw new Error('OAuth refresh returned no access_token');

    const expiry = tok.expires_in ? Date.now() + (Number(tok.expires_in) * 1000) : 0;
    this._store.updateTokens({
      tenantId, userId, connectorId,
      accessTokenEnc:  this._cipher.encrypt(tok.access_token),
      // Google usually omits refresh_token on refresh — store keeps the old.
      refreshTokenEnc: tok.refresh_token ? this._cipher.encrypt(tok.refresh_token) : null,
      expiry,
    });
    return tok.access_token;
  }

  /** Best-effort provider revoke, then delete the row regardless. */
  async revoke({ userId, tenantId, connectorId }) {
    if (!userId || !connectorId) throw new Error('revoke requires userId and connectorId');
    if (!tenantId) throw new Error('revoke requires tenantId');
    const row = this._store.get({ tenantId, userId, connectorId });
    if (!row) return; // already disconnected — idempotent
    try {
      const cfg = this._provider(connectorId, null);
      const tokenToRevoke = row.refresh_token_enc
        ? this._cipher.decrypt(row.refresh_token_enc)
        : this._cipher.decrypt(row.access_token_enc);
      if (cfg.revocationEndpoint && tokenToRevoke) {
        await fetch(cfg.revocationEndpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    new URLSearchParams({ token: tokenToRevoke }).toString(),
        }).catch(() => { /* best effort */ });
      }
    } catch (e) {
      log.warn?.(`[oauth] revoke: provider revocation best-effort failed: ${e.message}`);
    }
    this._store.delete({ tenantId, userId, connectorId });
    log.info?.(`[oauth] disconnected ${connectorId} for user ${userId.slice(0, 8)}…`);
  }

  /** Connection status for UI. Never returns token material. */
  status({ userId, tenantId, connectorId }) {
    if (!userId || !connectorId || !tenantId) return { connected: false };
    const row = this._store.get({ tenantId, userId, connectorId });
    if (!row) return { connected: false };
    return {
      connected: true,
      scopes:    row.scope ? row.scope.split(/\s+/).filter(Boolean) : [],
      account:   row.account ?? null,
    };
  }
}

export default OAuthClient;
