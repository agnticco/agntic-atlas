/**
 * Slack OAuth (v2) install flow for the Slack connector.
 *
 * A client authorizes the Atlas Slack app ("Add to Slack") instead of us touching
 * their API console. We exchange the code via `oauth.v2.access` and store the
 * resulting WORKSPACE bot token encrypted in the per-tenant vault. No Slack
 * Marketplace listing/review is required — this is standard public OAuth
 * distribution (see docs/connectors/slack.md).
 *
 * Slack is NOT a vanilla OAuth provider, so this is a small Slack-specific flow
 * rather than the generic PKCE OAuthClient: scopes are comma-separated, the token
 * endpoint is oauth.v2.access with a Slack-shaped response (bot token in
 * access_token, granted scopes in `scope`, team info), and bot tokens don't expire.
 */

import { randomBytes } from 'node:crypto';
import { connectorRedirectUri } from '../oauth-redirect.js';

const DEFAULT_API_BASE = 'https://slack.com/api';
const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const STATE_TTL_MS = 10 * 60 * 1000;

/** The Slack workspace install is tenant-level. We store its token under a
 *  per-tenant synthetic owner so there is exactly one isolated row per tenant
 *  (the vault PK is (user_id, connector_id), so the owner key must be unique per
 *  tenant — never a shared constant, which would collide across tenants). */
export const workspaceOwner = (tenantId) => `wsinstall:${tenantId}`;
export const SLACK_CONNECTOR_ID = 'slack';

export function slackOAuthConfig() {
  return {
    clientId: process.env.SLACK_CLIENT_ID ?? null,
    clientSecret: process.env.SLACK_CLIENT_SECRET ?? null,
    // Derive from the shared OAUTH_REDIRECT_BASE so one env var drives every
    // connector; SLACK_REDIRECT_URI still overrides when explicitly set.
    redirectUri: process.env.SLACK_REDIRECT_URI ?? connectorRedirectUri(SLACK_CONNECTOR_ID),
  };
}

/** Whether the deployment has the Atlas Slack app's OAuth credentials configured. */
export function isOAuthConfigured() {
  const c = slackOAuthConfig();
  return !!(c.clientId && c.clientSecret && c.redirectUri);
}

// Read the scopes a token was actually granted (Slack returns them in the
// `x-oauth-scopes` header on any Web API call). Used to derive what NEW client
// installs should request — no hardcoded scope list to keep in sync.
async function detectScopesFromToken(token, apiBase, fetchImpl) {
  if (!token) return [];
  try {
    const res = await fetchImpl(`${apiBase}/auth.test`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    return (res.headers?.get?.('x-oauth-scopes') ?? '').split(/[,\s]+/).filter(Boolean);
  } catch { return []; }
}

// Scopes to REQUEST at OAuth (vs. what a tenant has granted). Derived from the
// reference bot/user tokens so the request always matches what this app's tokens
// actually carry — no scope list to maintain. Cached per process.
let _requestScopeCache = null;
export function resetRequestScopeCache() { _requestScopeCache = null; }
async function resolveRequestScopes(fetchImpl) {
  if (_requestScopeCache) return _requestScopeCache;
  const apiBase = process.env.SLACK_API_URL ?? DEFAULT_API_BASE;
  const bot  = await detectScopesFromToken(process.env.SLACK_BOT_TOKEN, apiBase, fetchImpl);
  const user = await detectScopesFromToken(process.env.SLACK_USER_TOKEN, apiBase, fetchImpl);
  if (!bot.length) bot.push('chat:write'); // floor: the app must stay installable
  _requestScopeCache = { bot, user };
  return _requestScopeCache;
}

/**
 * Create an install flow with an in-process CSRF state store. start() returns the
 * authorize URL to send the client to; complete() validates state + exchanges the
 * code and returns the workspace token + granted scopes (caller persists them).
 */
export function createSlackOAuthFlow({ fetchImpl = fetch } = {}) {
  const pending = new Map(); // state -> { tenantId, userId, expiresAt }
  const sweep = () => { const now = Date.now(); for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k); };

  async function start({ tenantId, userId }) {
    if (!tenantId) throw new Error('slack oauth start requires a tenant');
    const cfg = slackOAuthConfig();
    if (!cfg.clientId || !cfg.redirectUri) throw new Error('Slack OAuth not configured (set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_REDIRECT_URI)');
    sweep();
    const state = randomBytes(24).toString('hex');
    pending.set(state, { tenantId, userId: userId ?? null, expiresAt: Date.now() + STATE_TTL_MS });
    // Request whatever this app's reference token(s) actually carry (or the
    // explicit env overrides), so new client installs grant the full set.
    const { bot, user } = await resolveRequestScopes(fetchImpl);
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('scope', bot.join(',')); // Slack bot scopes are comma-separated
    if (user.length) url.searchParams.set('user_scope', user.join(','));
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('state', state);
    return { authorizeUrl: url.toString(), state };
  }

  async function complete({ state, code }) {
    if (!state || !code) throw new Error('Slack callback missing state or code');
    const ctx = pending.get(state);
    pending.delete(state); // single-use, regardless of outcome
    if (!ctx) throw new Error('Slack callback: unknown or already-used state');
    if (ctx.expiresAt <= Date.now()) throw new Error('Slack callback: state expired — restart the connection');

    const cfg = slackOAuthConfig();
    const apiBase = process.env.SLACK_API_URL ?? DEFAULT_API_BASE;
    const body = new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: cfg.redirectUri,
    });
    const res = await fetchImpl(`${apiBase}/oauth.v2.access`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
    let data; try { data = await res.json(); } catch { data = { ok: false, error: 'invalid_json_response' }; }
    if (!data.ok || !data.access_token) throw new Error(`slack oauth.v2.access failed: ${data.error ?? `HTTP ${res.status}`}`);

    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      botToken: data.access_token,            // xoxb- workspace bot token
      botUserId: data.bot_user_id ?? null,
      scopes: (data.scope ?? '').split(/[,\s]+/).filter(Boolean),
      team: data.team ?? null,
      account: data.team?.name ?? data.team?.id ?? null,
    };
  }

  return { start, complete, _pending: pending };
}

/** Persist a workspace install's bot token (encrypted) in the per-tenant vault. */
export function storeSlackToken({ oauthTokenStore, cipher, tenantId, botToken, scopes = [], account = null }) {
  if (!tenantId) throw new Error('storeSlackToken requires a tenant');
  oauthTokenStore.upsert({
    tenantId,
    userId: workspaceOwner(tenantId),
    connectorId: SLACK_CONNECTOR_ID,
    accessTokenEnc: cipher.encrypt(botToken),
    scope: scopes.join(','),
    expiry: 0, // Slack bot tokens don't expire (unless token rotation is enabled)
    account,
  });
}

/** Read a tenant's stored Slack bot token (decrypted), or null if not connected. */
export function getSlackToken({ oauthTokenStore, cipher, tenantId }) {
  if (!tenantId) throw new Error('getSlackToken requires a tenant');
  const row = oauthTokenStore.get({ tenantId, userId: workspaceOwner(tenantId), connectorId: SLACK_CONNECTOR_ID });
  if (!row) return null;
  return {
    botToken: cipher.decrypt(row.access_token_enc),
    scopes: (row.scope ?? '').split(/[,\s]+/).filter(Boolean),
    account: row.account ?? null,
  };
}

/** Read a tenant's stored Slack grant WITHOUT decrypting the token (status/scopes). */
export function getSlackGrant({ oauthTokenStore, tenantId }) {
  if (!tenantId) throw new Error('getSlackGrant requires a tenant');
  const row = oauthTokenStore.get({ tenantId, userId: workspaceOwner(tenantId), connectorId: SLACK_CONNECTOR_ID });
  if (!row) return null;
  return { connected: true, scopes: (row.scope ?? '').split(/[,\s]+/).filter(Boolean), account: row.account ?? null };
}

/** Disconnect (delete) a tenant's Slack install. */
export function disconnectSlack({ oauthTokenStore, tenantId }) {
  if (!tenantId) throw new Error('disconnectSlack requires a tenant');
  return oauthTokenStore.delete({ tenantId, userId: workspaceOwner(tenantId), connectorId: SLACK_CONNECTOR_ID });
}
