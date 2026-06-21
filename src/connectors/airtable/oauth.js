/**
 * Airtable OAuth 2.0 + PKCE install flow.
 *
 * Airtable's flow is standard PKCE but differs from Google in two ways:
 *   - Token endpoint uses HTTP Basic auth (clientId:clientSecret), not body params.
 *   - Refresh tokens are ROTATED on every refresh — always store the new one.
 *
 * Access tokens expire after 3600s (1 hour); refresh tokens last 60 days.
 *
 * Auth is workspace-level: one install per tenant (first admin to connect),
 * stored under the `wsinstall:<tenantId>` synthetic userId — same pattern as
 * the Slack bot-token install. This means one set of credentials drives all
 * automated workflow runs for a tenant, not per-user OAuth.
 *
 * Required env vars:
 *   AIRTABLE_CLIENT_ID       — from airtable.com/create/oauth
 *   AIRTABLE_CLIENT_SECRET   — from airtable.com/create/oauth
 *   OAUTH_REDIRECT_BASE      — shared base (connector callback = <base>/connectors/airtable/callback)
 */

import { randomBytes, createHash } from 'node:crypto';
import { connectorRedirectUri } from '../oauth-redirect.js';

export const AIRTABLE_CONNECTOR_ID = 'airtable';

const AUTHORIZE_URL = 'https://airtable.com/oauth2/v1/authorize';
// Allow tests to override so the token endpoint can be stubbed locally.
const TOKEN_URL     = process.env.AIRTABLE_OAUTH_URL ?? 'https://airtable.com/oauth2/v1/token';
const STATE_TTL_MS  = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000; // refresh 60s before actual expiry

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const basicAuth = (id, secret) => Buffer.from(`${id}:${secret}`).toString('base64');

// Workspace-level synthetic owner — one row per tenant in the vault.
const _owner = (tenantId) => `wsinstall:${tenantId}`;

// ── Config ────────────────────────────────────────────────────────────────────

export function airtableOAuthConfig() {
  return {
    clientId:    process.env.AIRTABLE_CLIENT_ID?.trim()     ?? null,
    clientSecret: process.env.AIRTABLE_CLIENT_SECRET?.trim() ?? null,
    redirectUri: process.env.AIRTABLE_REDIRECT_URI ?? connectorRedirectUri('airtable'),
    // Request the full capability set; user can narrow on Airtable's consent screen.
    scopes: (process.env.AIRTABLE_OAUTH_SCOPES ??
      'data.records:read data.records:write schema.bases:read webhook:manage'
    ).split(/\s+/).filter(Boolean),
  };
}

export function isAirtableOAuthConfigured() {
  const c = airtableOAuthConfig();
  return !!(c.clientId && c.clientSecret);
}

// ── OAuth flow ────────────────────────────────────────────────────────────────

/**
 * Create a stateful PKCE flow for Airtable. Call start() to get the
 * authorize URL, then complete() in the callback route to exchange the code
 * and get tokens. Caller persists them with storeAirtableToken().
 */
export function createAirtableOAuthFlow({ fetchImpl = fetch } = {}) {
  // state → { tenantId, userId, codeVerifier, expiresAt }
  const pending = new Map();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
  };

  function start({ tenantId, userId }) {
    if (!tenantId) throw new Error('airtable oauth start requires tenantId');
    const cfg = airtableOAuthConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error('Airtable OAuth not configured — set AIRTABLE_CLIENT_ID and AIRTABLE_CLIENT_SECRET');
    }
    sweep();

    const codeVerifier  = b64url(randomBytes(32));
    const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
    const state         = b64url(randomBytes(24));

    pending.set(state, { tenantId, userId, codeVerifier, expiresAt: Date.now() + STATE_TTL_MS });

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id',              cfg.clientId);
    url.searchParams.set('redirect_uri',           cfg.redirectUri);
    url.searchParams.set('response_type',          'code');
    url.searchParams.set('scope',                  cfg.scopes.join(' '));
    url.searchParams.set('state',                  state);
    url.searchParams.set('code_challenge',         codeChallenge);
    url.searchParams.set('code_challenge_method',  'S256');

    return { authorizeUrl: url.toString(), state };
  }

  async function complete({ state, code, sessionUserId }) {
    if (!state || !code) throw new Error('Airtable callback missing state or code');
    const ctx = pending.get(state);
    pending.delete(state); // single-use
    if (!ctx) throw new Error('Airtable callback: unknown or already-used state');
    if (ctx.expiresAt <= Date.now()) throw new Error('Airtable callback: state expired — restart the connection');
    if (sessionUserId && ctx.userId && ctx.userId !== sessionUserId) {
      throw new Error('Airtable callback: state was issued for a different user');
    }

    const cfg = airtableOAuthConfig();
    const body = new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  cfg.redirectUri,
      code_verifier: ctx.codeVerifier,
    });

    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization:  `Basic ${basicAuth(cfg.clientId, cfg.clientSecret)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Airtable token exchange failed (${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    const tok = await res.json();
    if (!tok.access_token) throw new Error('Airtable token exchange returned no access_token');

    return {
      tenantId:     ctx.tenantId,
      userId:       ctx.userId,
      accessToken:  tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresIn:    Number(tok.expires_in) || 3600,
      scope:        tok.scope ?? cfg.scopes.join(' '),
    };
  }

  return { start, complete, _pending: pending };
}

// ── Token storage ─────────────────────────────────────────────────────────────

export function storeAirtableToken({ oauthTokenStore, cipher, tenantId, accessToken, refreshToken, expiresIn = 3600, scope = '' }) {
  oauthTokenStore.upsert({
    tenantId,
    userId:          _owner(tenantId),
    connectorId:     AIRTABLE_CONNECTOR_ID,
    accessTokenEnc:  cipher.encrypt(accessToken),
    refreshTokenEnc: refreshToken ? cipher.encrypt(refreshToken) : null,
    scope,
    expiry:          Date.now() + expiresIn * 1_000,
    account:         tenantId,
  });
}

// ── Token retrieval (with auto-refresh) ───────────────────────────────────────

/**
 * Get a valid access token, refreshing if it is expired or within the skew
 * window. Refresh tokens are rotated by Airtable — the new token is persisted
 * immediately. Returns null if the tenant is not connected.
 */
export async function getAirtableAccessToken({ oauthTokenStore, cipher, tenantId, fetchImpl = fetch }) {
  const row = oauthTokenStore.get({ tenantId, userId: _owner(tenantId), connectorId: AIRTABLE_CONNECTOR_ID });
  if (!row) return null;

  const fresh = !row.expiry || row.expiry - REFRESH_SKEW_MS > Date.now();
  if (fresh) {
    try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
  }

  if (!row.refresh_token_enc) {
    // No refresh token — return stale token and let the API call surface the 401.
    try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
  }

  try {
    return await _doRefresh({ oauthTokenStore, cipher, tenantId, row, fetchImpl });
  } catch {
    // Refresh failed — fall back to stale token rather than silently returning null.
    try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
  }
}

/**
 * Synchronous read — no refresh. Used by the synchronous injectTenantTokens
 * path. If the token is expired the API call will fail with a 401; use
 * getAirtableAccessToken() in async contexts to get auto-refresh.
 */
export function getAirtableToken({ oauthTokenStore, cipher, tenantId }) {
  const row = oauthTokenStore.get({ tenantId, userId: _owner(tenantId), connectorId: AIRTABLE_CONNECTOR_ID });
  if (!row) return null;
  try { return cipher.decrypt(row.access_token_enc); } catch { return null; }
}

async function _doRefresh({ oauthTokenStore, cipher, tenantId, row, fetchImpl }) {
  const cfg          = airtableOAuthConfig();
  const refreshToken = cipher.decrypt(row.refresh_token_enc);

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization:  `Basic ${basicAuth(cfg.clientId, cfg.clientSecret)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Airtable token refresh failed (${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
  }
  const tok = await res.json();
  if (!tok.access_token) throw new Error('Airtable token refresh returned no access_token');

  const expiry = Date.now() + (Number(tok.expires_in) || 3600) * 1_000;
  oauthTokenStore.updateTokens({
    tenantId,
    userId:          _owner(tenantId),
    connectorId:     AIRTABLE_CONNECTOR_ID,
    accessTokenEnc:  cipher.encrypt(tok.access_token),
    refreshTokenEnc: tok.refresh_token ? cipher.encrypt(tok.refresh_token) : null,
    expiry,
  });

  return tok.access_token;
}

// ── Connection status helpers ─────────────────────────────────────────────────

export function isAirtableConnected({ oauthTokenStore, tenantId }) {
  return oauthTokenStore.has({ tenantId, userId: _owner(tenantId), connectorId: AIRTABLE_CONNECTOR_ID });
}

export function getAirtableGrant({ oauthTokenStore, tenantId }) {
  const row = oauthTokenStore.get({ tenantId, userId: _owner(tenantId), connectorId: AIRTABLE_CONNECTOR_ID });
  if (!row) return null;
  return {
    connected: true,
    scope:  row.scope ?? '',
    expiry: row.expiry ?? 0,
  };
}

export function disconnectAirtable({ oauthTokenStore, tenantId }) {
  return oauthTokenStore.delete({ tenantId, userId: _owner(tenantId), connectorId: AIRTABLE_CONNECTOR_ID });
}

// ── Scope-aware capability resolution ────────────────────────────────────────

const CAPABILITY_SCOPES = {
  airtable_list_records:   ['data.records:read'],
  airtable_get_record:     ['data.records:read'],
  airtable_search_records: ['data.records:read'],
  airtable_create_record:  ['data.records:write'],
  airtable_update_record:  ['data.records:write'],
  airtable_delete_record:  ['data.records:write'],
  airtable_record_changed: ['webhook:manage'],
};

/**
 * Annotate Airtable capabilities with availability based on granted OAuth scopes.
 * Returns the same shape as resolveGoogleCapabilities / resolveSlackCapabilities
 * so the /capabilities endpoint and converger treat all connectors uniformly.
 */
export function resolveAirtableCapabilities(grantedScopes = []) {
  const granted = new Set(grantedScopes);
  const actions = Object.entries(CAPABILITY_SCOPES).map(([id, required]) => {
    const missing = required.filter(s => !granted.has(s));
    const available = missing.length === 0;
    return {
      id,
      available,
      unavailableReason: available ? null : `missing scope(s): ${missing.join(', ')}`,
    };
  });
  return { connector: 'airtable', grantedScopes: [...granted], actions };
}

/**
 * Per-tenant Airtable capability provider — mirrors createSlackCapabilityProvider
 * and createGoogleCapabilityProvider. Mount on the spine; call resolveForTenant()
 * in /capabilities and the converger.
 */
export function createAirtableCapabilityProvider({ oauthTokenStore }) {
  const cache = new Map(); // tenantId → resolved

  return {
    resolveForTenant(tenantId) {
      if (!tenantId) return { connector: 'airtable', connected: false, grantedScopes: [], actions: [] };
      if (cache.has(tenantId)) return cache.get(tenantId);
      const grant = getAirtableGrant({ oauthTokenStore, tenantId });
      if (!grant) {
        const r = { connector: 'airtable', connected: false, grantedScopes: [], actions: [] };
        cache.set(tenantId, r);
        return r;
      }
      const scopes = grant.scope ? grant.scope.split(/\s+/).filter(Boolean) : [];
      const resolved = { connected: true, ...resolveAirtableCapabilities(scopes) };
      cache.set(tenantId, resolved);
      return resolved;
    },
    refresh(tenantId) {
      if (tenantId) cache.delete(tenantId); else cache.clear();
    },
  };
}
