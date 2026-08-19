/**
 * ATLAS AS AN AUTHORIZATION SERVER — the half that makes "paste the URL and sign in" work.
 *
 * `connectors/mcp-connect.js` is Atlas connecting TO a service nobody hand-built. This is
 * the mirror: a service nobody hand-built connecting to Atlas. The constraint is the same
 * one stated in `client-identity.js` — nobody should be sent to a developer settings
 * screen to create an integration and paste a secret — and it applies in both directions.
 * A customer connecting Atlas to Claude should copy a URL and approve a screen.
 *
 * ── CIMD IS THE WHOLE MECHANISM ────────────────────────────────────────────
 *
 * `client_id` IS a URL. A client sends one; this server fetches it, reads the document
 * there, and learns who is asking. No registration, no shared secret, nothing for anyone
 * to configure. `discoverAuthServer()` calls the advertising field "the one that decides
 * whether a customer can connect this today" — that field is ours to set now.
 *
 * THE URL IS SUPPLIED BY WHOEVER IS ASKING, so fetching it is an SSRF surface pointed at
 * our own VPS. It goes through `utils/public-url.js` — the same guard `web_fetch` uses,
 * shared rather than copied, including the connect-time re-resolution that closes DNS
 * rebinding. A `client_id` of `http://169.254.169.254/latest/meta-data/` is exactly the
 * request this must refuse.
 *
 * ── SCOPES ARE REAL HERE, UNLIKE EVERYWHERE ELSE IN ATLAS ──────────────────
 *
 * A session token is all-or-nothing: a logged-in user can do everything. An OAuth token
 * cannot be, because the consent screen would then be asking permission for something it
 * could not limit — "connect Atlas" would grant the ability to run every automation in
 * the workspace. So access tokens carry `workflows:read` and/or `workflows:run`, and the
 * MCP endpoint enforces them per tool.
 *
 * ── CODES IN MEMORY, GRANTS ON DISK ────────────────────────────────────────
 *
 * Authorization codes live ~60 seconds and are single-use, so they are held in memory —
 * correct for the single-process deployment, the same reasoning `tenant-guard.js` records
 * for its concurrency map, and the natural seam to externalise when scaling out. Refresh
 * grants must outlive a restart and must be revocable, so those are rows.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { assertPublicUrl, ssrfDispatcher } from '../utils/public-url.js';
import { logEvent } from '../utils/event-log.js';

export const SCOPES = Object.freeze({
  READ: 'workflows:read',
  RUN: 'workflows:run',
});
export const ALL_SCOPES = Object.freeze([SCOPES.READ, SCOPES.RUN]);

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_MS = 8 * 60 * 60 * 1000;        // 8 hours
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 8000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_grants (
  -- STABLE ACROSS ROTATION. The id names the GRANT, not one refresh token, so an access
  -- token can carry it and still be checkable after the client has refreshed. When this
  -- was the refresh token's own jti, every rotation orphaned the access tokens minted
  -- beside it and there was no durable thing for a revocation to point at.
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL,           -- sha256 of the CURRENT refresh token; never the token
  -- The previous one, kept solely to recognise it coming back: a rotated token being
  -- presented again means either a copy is in circulation or the grant is being replayed.
  prev_token_hash TEXT,
  rotated_at   INTEGER,
  user_id      TEXT NOT NULL,
  tenant_id    TEXT NOT NULL,
  client_id    TEXT NOT NULL,
  client_name  TEXT,
  scope        TEXT NOT NULL,
  resource     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_grants_user ON oauth_grants(user_id, revoked_at);
`;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sha256 = (s) => createHash('sha256').update(s).digest();

/** Constant-time compare of two strings of any length. */
function sameSecret(a, b) {
  const ha = sha256(String(a ?? ''));
  const hb = sha256(String(b ?? ''));
  return timingSafeEqual(ha, hb);
}

/** Normalise a scope string to the subset this server actually grants. */
export function parseScopes(requested) {
  const asked = String(requested ?? '').split(/[\s+]+/).filter(Boolean);
  // An empty or unrecognised request gets READ, not everything. Defaulting a scope
  // request to full access is how a consent screen ends up lying about what it granted.
  const granted = asked.filter(s => ALL_SCOPES.includes(s));
  return granted.length ? [...new Set(granted)] : [SCOPES.READ];
}

/**
 * Fetch and validate a client-id metadata document.
 *
 * @returns {Promise<{clientId:string, name:string, redirectUris:string[], uri:string|null}>}
 */
export async function resolveClientIdentity(clientId, { fetchImpl = fetch } = {}) {
  if (!/^https:\/\//i.test(String(clientId ?? ''))) {
    throw new Error('client_id must be an https URL (this server identifies clients by document).');
  }
  await assertPublicUrl(clientId, 'client_id');

  let res;
  try {
    res = await fetchImpl(clientId, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
      dispatcher: ssrfDispatcher,   // connect-time re-resolution; see utils/public-url.js
      redirect: 'error',            // a redirect could land somewhere the check cleared
    });
  } catch (e) {
    throw new Error(`could not read the client_id document: ${e.message}`);
  }
  if (!res.ok) throw new Error(`the client_id document returned HTTP ${res.status}`);

  const text = (await res.text()).slice(0, CIMD_MAX_BYTES);
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('the client_id document is not JSON'); }

  // The address IS the identity. If the document claims a different id then whoever
  // published it is not who is asking, and the identity is unresolvable rather than
  // merely inconsistent — the same assertion client-identity.js makes in reverse.
  if (doc.client_id !== clientId) {
    throw new Error('the client_id document declares a different client_id than its own URL');
  }
  const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter(u => typeof u === 'string') : [];
  if (!redirectUris.length) throw new Error('the client_id document lists no redirect_uris');

  return {
    clientId,
    name: String(doc.client_name ?? new URL(clientId).host).slice(0, 120),
    redirectUris,
    uri: typeof doc.client_uri === 'string' ? doc.client_uri : null,
  };
}

export function createOAuthProvider({ db, tokenService, userStore, issuer }) {
  db.exec(SCHEMA);

  // `CREATE TABLE IF NOT EXISTS` does not add columns to a table that already exists, and
  // this one shipped before rotation-reuse detection did. Any database that saw the
  // earlier version has an oauth_grants without these two, and every refresh against it
  // would throw on an unknown column. Same PRAGMA-then-ALTER pattern as session-store.
  {
    const cols = db.prepare('PRAGMA table_info(oauth_grants)').all().map(c => c.name);
    if (!cols.includes('prev_token_hash')) db.exec('ALTER TABLE oauth_grants ADD COLUMN prev_token_hash TEXT');
    if (!cols.includes('rotated_at')) db.exec('ALTER TABLE oauth_grants ADD COLUMN rotated_at INTEGER');
  }

  /** code -> pending authorization. Short-lived, single-use, never persisted. */
  const codes = new Map();

  const sweep = () => {
    const now = Date.now();
    for (const [code, rec] of codes) if (rec.expiresAt <= now) codes.delete(code);
  };

  const provider = {
    SCOPES, ALL_SCOPES,

    /** Metadata a client reads before it asks for anything. */
    protectedResourceMetadata() {
      return {
        resource: issuer,
        authorization_servers: [issuer],
        scopes_supported: ALL_SCOPES,
        bearer_methods_supported: ['header'],
      };
    },

    authorizationServerMetadata() {
      return {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        scopes_supported: ALL_SCOPES,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],   // public clients, PKCE-protected
        code_challenge_methods_supported: ['S256'],        // S256 only; never negotiated down
        // The field that decides whether a customer can connect without a registration step.
        client_id_metadata_document_supported: true,
      };
    },

    /**
     * The resource identifier we will mint tokens for — ours, or nothing.
     *
     * RFC 8707 `resource` arrives from the client, and we used to write it into the token's
     * `aud` untouched. A client asking for `resource=https://elsewhere.example` therefore got
     * a token from us that CLAIMED to be for another service; the redemption check only
     * confirmed it matched what the same client asked for at authorize, which proves nothing.
     * Narrowing it here means `aud` is always our own identity, which is what makes checking
     * `aud` at the point of use meaningful rather than decorative.
     */
    canonicalResource(resource) {
      if (!resource) return issuer;
      const want = String(resource).replace(/\/+$/, '');
      if (want === issuer || want === `${issuer}/mcp`) return issuer;
      throw new Error('invalid_target: this authorization server does not issue tokens for that resource');
    },

    /** Mint a single-use authorization code bound to the PKCE challenge and resource. */
    issueCode({ userId, tenantId, clientId, clientName, redirectUri, scope, codeChallenge, resource }) {
      sweep();
      const code = b64url(randomBytes(32));
      codes.set(code, {
        userId, tenantId, clientId, clientName, redirectUri, scope, codeChallenge,
        resource: provider.canonicalResource(resource),
        expiresAt: Date.now() + CODE_TTL_MS,
      });
      return code;
    },

    /**
     * Exchange a code for tokens.
     *
     * The code is deleted before anything else is checked, so a replay of a valid code
     * fails even if the verifier is right — single-use has to mean single-use under
     * concurrency, not merely on the happy path.
     */
    redeemCode({ code, codeVerifier, clientId, redirectUri, resource }) {
      sweep();
      const rec = codes.get(code);
      codes.delete(code);
      if (!rec) throw new Error('invalid_grant: unknown or already-used code');
      if (rec.expiresAt <= Date.now()) throw new Error('invalid_grant: the code has expired');
      if (rec.clientId !== clientId) throw new Error('invalid_grant: this code was issued to another client');
      if (rec.redirectUri !== redirectUri) throw new Error('invalid_grant: redirect_uri does not match the request');
      // RFC 8707: a token minted for one resource must not be replayable against another
      // that trusts the same authorization server.
      if (resource && rec.resource && rec.resource !== provider.canonicalResource(resource)) {
        throw new Error('invalid_grant: resource does not match the request');
      }
      const challenge = b64url(sha256(String(codeVerifier ?? '')));
      if (!rec.codeChallenge || !sameSecret(challenge, rec.codeChallenge)) {
        throw new Error('invalid_grant: PKCE verification failed');
      }
      return this.issueTokens(rec);
    },

    issueTokens({ userId, tenantId, clientId, clientName, scope, resource, grantId = null }) {
      const canonical = provider.canonicalResource(resource);
      const id = grantId ?? b64url(randomBytes(16));
      const refreshToken = `${id}.${b64url(randomBytes(32))}`;
      const hash = sha256(refreshToken).toString('hex');
      const now = Date.now();

      if (grantId) {
        // Rotating: the outgoing hash becomes `prev` so its reappearance is recognisable.
        db.prepare(
          `UPDATE oauth_grants SET prev_token_hash = token_hash, token_hash = ?,
                                   rotated_at = ?, expires_at = ? WHERE id = ?`
        ).run(hash, now, now + REFRESH_TTL_MS, id);
      } else {
        db.prepare(
          `INSERT INTO oauth_grants (id, token_hash, user_id, tenant_id, client_id, client_name,
                                     scope, resource, created_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(id, hash, userId, tenantId, clientId,
              clientName ?? null, scope, canonical, now, now + REFRESH_TTL_MS);
      }

      // The access token names its grant, which is what lets revocation reach it. Without
      // `grantId` a revoked grant kept working until the JWT expired 8 hours later — so
      // revocation, and the reuse detection below, were advice rather than enforcement.
      const accessToken = tokenService.signAccess({
        userId, tenantId, scope, resource: canonical, ttlMs: ACCESS_TTL_MS, grantId: id,
      });

      logEvent('oauth.token.issued', { tenant: tenantId, client: clientId, scope });
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        refresh_token: refreshToken,
        scope,
      };
    },

    /**
     * Rotate a refresh token, and treat a rotated one coming back as theft.
     *
     * ── WHY REUSE ENDS THE GRANT (RFC 9700) ──────────────────────────────────
     *
     * Rotation alone does not protect a public client; it only guarantees that a stolen
     * token and the real one cannot both keep working. Which of the two survives is
     * decided by whoever refreshes first, and if the thief wins, the legitimate client
     * simply re-authenticates and NOTHING ANYWHERE RECORDS THAT A COPY EXISTS. The thief
     * holds a rolling 90-day credential nobody is looking for.
     *
     * A rotated token being presented again is the one observable signal that a copy is in
     * circulation. It is not proof of which party is the thief — so the grant ends for
     * both, and the user re-consents. Losing a connection is the cheap outcome here.
     */
    refresh({ refreshToken, clientId }) {
      const [id] = String(refreshToken ?? '').split('.');
      const row = id && db.prepare('SELECT * FROM oauth_grants WHERE id = ?').get(id);
      if (!row) throw new Error('invalid_grant: unknown refresh token');
      const presented = sha256(refreshToken).toString('hex');

      // Checked BEFORE the revoked/expired guards: a replay after the grant is already
      // dead is still the signal worth recording, and a bare "unknown token" would bury it.
      if (row.prev_token_hash && sameSecret(presented, row.prev_token_hash)) {
        db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
          .run(Date.now(), id);
        logEvent('oauth.refresh.reuse', {
          tenant: row.tenant_id, client: row.client_id, grant: id,
        });
        throw new Error('invalid_grant: this refresh token was already rotated; '
                      + 'the grant has been revoked and must be re-authorized');
      }

      if (row.revoked_at) throw new Error('invalid_grant: unknown refresh token');
      if (row.expires_at <= Date.now()) throw new Error('invalid_grant: the refresh token has expired');
      if (row.client_id !== clientId) throw new Error('invalid_grant: issued to another client');
      if (!sameSecret(presented, row.token_hash)) {
        throw new Error('invalid_grant: refresh token does not match');
      }
      const user = userStore.findById(row.user_id);
      if (!user || user.disabled_at || user.tenant_id !== row.tenant_id) {
        throw new Error('invalid_grant: the user is no longer able to grant this');
      }
      // The row is UPDATED in place rather than revoked-and-replaced: the grant is the
      // durable thing, and access tokens already issued against it stay valid until they
      // expire on their own, which is what a client refreshing ahead of time expects.
      return this.issueTokens({
        userId: row.user_id, tenantId: row.tenant_id, clientId: row.client_id,
        clientName: row.client_name, scope: row.scope, resource: row.resource, grantId: id,
      });
    },

    /** Everything a user has connected, for a revocation screen. */
    grantsFor(userId) {
      return db.prepare(
        `SELECT id, client_id AS clientId, client_name AS clientName, scope,
                created_at AS createdAt, expires_at AS expiresAt
           FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
      ).all(userId);
    },

    /**
     * Is this grant still live? Called on every authenticated MCP request.
     *
     * One indexed primary-key read is the price of revocation meaning anything sooner
     * than the access token's own expiry.
     */
    grantIsLive(grantId) {
      if (!grantId) return false;
      const row = db.prepare('SELECT revoked_at, expires_at FROM oauth_grants WHERE id = ?').get(grantId);
      return !!row && !row.revoked_at && row.expires_at > Date.now();
    },

    revoke(id, userId) {
      return db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND user_id = ?')
        .run(Date.now(), id, userId).changes > 0;
    },
  };

  return provider;
}

export default createOAuthProvider;
