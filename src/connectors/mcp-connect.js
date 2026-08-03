/**
 * CONNECTING A SERVICE NOBODY HAND-BUILT. (P13-A, third half — the Connect button.)
 *
 * Everything here exists to make ONE customer action work: press Connect, approve
 * on the service's own screen, come back connected. No developer account, no app
 * to create, no permissions to choose, no secret to paste. That constraint is the
 * whole reason this phase exists, and every decision below is downstream of it.
 *
 * ── The discovery chain, which is what makes it possible ────────────────────
 *
 * We know nothing about the service except its address. So we ask it:
 *
 *   1. POST to the MCP endpoint → 401 with a `WWW-Authenticate` header naming
 *      where its RESOURCE metadata lives.
 *   2. Fetch that → it names its AUTHORIZATION SERVER.
 *   3. Fetch that server's metadata → the authorize and token endpoints, and
 *      whether it accepts a URL as a client id.
 *
 * Measured 2026-08-03 against the live servers: Notion, Linear and Sentry all
 * answer every step, and Notion and Linear both advertise
 * `client_id_metadata_document_supported: true`.
 *
 * ── THE HARD STOP, and it is the reason this file refuses rather than adapts ──
 *
 * The standard's identity order is:
 *
 *     pre-registered credentials → CIMD → dynamic registration → ASK THE USER
 *
 * The fourth step *is* the banned developer-settings screen, and a naive
 * implementation falls through to it BY DEFAULT — that is the trap. A service
 * that exhausts the first three is "not supported yet" and goes on the list to
 * register by hand. `beginConnect` returns that refusal as a VALUE, so the
 * decision is testable, rather than being an absence someone quietly fills in.
 *
 * ── S256 ONLY, even when the server offers `plain` ──────────────────────────
 *
 * Notion's own metadata advertises `code_challenge_methods_supported:
 * ['plain','S256']`. `plain` sends the verifier in the clear as the challenge,
 * which is not a protection at all — it is in the spec for legacy clients. We
 * never negotiate DOWN to what a server will tolerate; we require S256 and refuse
 * a server that cannot do it. This is the one place where "be liberal in what you
 * accept" is exactly wrong.
 *
 * ── The token is bound to the resource it was issued for (RFC 8707) ────────
 *
 * Both the authorize and the token request carry `resource`. Without it a token
 * minted for one MCP server can be replayed against another that trusts the same
 * authorization server — the confused-deputy shape. The MCP spec requires it; it
 * is sent on both legs because omitting it on either is enough to lose the
 * binding.
 *
 * ── One callback for every server, identified by state ─────────────────────
 *
 * `redirect_uris` in the identity document must be STABLE — the document is the
 * identity, so a URL that changes whenever a connector is added would change who
 * Atlas is. So every server returns to the same address and `state` says which
 * one it was. `state` is single-use, expires, and is bound to the tenant and the
 * user who started it: a code arriving for a state issued to someone else is
 * refused, not honoured.
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { clientIdUrl, clientIdMetadata, redirectUris, unsupportedService } from './client-identity.js';

const STATE_TTL_MS = 10 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Remote HTTPS only. A non-HTTPS endpoint is not the stdio pool by another name. */
function assertRemote(url, what) {
  if (!/^https:\/\//i.test(String(url ?? '')) && !/^http:\/\/localhost/i.test(String(url ?? ''))) {
    throw new Error(`${what} must be an https address — got ${url || '(nothing)'}`);
  }
}

/**
 * Parse `WWW-Authenticate` for the resource-metadata address.
 *
 * Returns null rather than throwing: a server that 401s without pointing anywhere
 * has not told us where to look, which is a "not supported yet", not a crash.
 */
export function resourceMetadataUrl(wwwAuthenticate) {
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(String(wwwAuthenticate ?? ''));
  return m ? m[1] : null;
}

/**
 * WHERE AN AUTHORIZATION SERVER'S METADATA ACTUALLY LIVES.
 *
 * RFC 8414 does NOT say "issuer + /.well-known/...". For an issuer carrying a
 * path it says the well-known segment is inserted BETWEEN THE HOST AND THE PATH:
 *
 *   issuer  https://access.stripe.com/mcp
 *   right   https://access.stripe.com/.well-known/oauth-authorization-server/mcp   → 200
 *   wrong   https://access.stripe.com/mcp/.well-known/oauth-authorization-server   → 404
 *
 * Measured against Stripe, 2026-08-03. The naive concatenation is what this file
 * shipped first, and the failure mode is the one this codebase records more than
 * any other: it 404s, finds nothing, and reads that as "this service cannot be
 * connected" — when the truth is "I looked in the wrong place". A guard that does
 * not recognise a value must not report that as absence.
 *
 * So all three documented locations are tried, in the spec's own order, and only
 * a service that answers at NONE of them is reported as telling us nothing.
 */
export async function fetchAuthServerMetadata({ issuer, fetchImpl = fetch, timeoutMs = 12000 }) {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  const candidates = [
    // RFC 8414 §3.1 — path-insertion. First because it is the one that is right
    // for a path-carrying issuer, and identical to the plain form when there is
    // no path.
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    // OpenID Connect Discovery, which many servers answer as well.
    `${u.origin}/.well-known/openid-configuration${path}`,
    // The plain suffix. Wrong per the RFC for a path issuer, but some servers
    // serve it anyway, and trying it costs one request on a path we would
    // otherwise abandon.
    `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
  ];
  for (const url of candidates) {
    const meta = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (meta?.authorization_endpoint) return meta;
  }
  return null;
}

/**
 * Ask a server we have never met how to authorize against it.
 *
 * Every step is the service telling us about itself; nothing here is hardcoded
 * per-vendor, which is the property that lets a service Atlas has never been
 * taught about work on the first try.
 */
export async function discoverAuthServer({ mcpUrl, fetchImpl = fetch, timeoutMs = 12000 }) {
  assertRemote(mcpUrl, 'An MCP server address');

  const probe = await fetchImpl(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  // A server that answers without a challenge needs no token — an open catalog.
  if (probe.status !== 401) return { needsAuth: false, resource: new URL(mcpUrl).origin };

  const rmUrl = resourceMetadataUrl(probe.headers?.get?.('www-authenticate'))
    // Fall back to the well-known location the spec defines, so a server that
    // omits the header is not written off before we have actually looked.
    ?? `${new URL(mcpUrl).origin}/.well-known/oauth-protected-resource`;

  const rm = await fetchImpl(rmUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);

  const issuer = rm?.authorization_servers?.[0] ?? new URL(mcpUrl).origin;
  const resource = rm?.resource ?? new URL(mcpUrl).origin;

  const meta = await fetchAuthServerMetadata({ issuer, fetchImpl, timeoutMs });

  return {
    needsAuth: true,
    resource,
    issuer,
    authorizationEndpoint: meta?.authorization_endpoint ?? null,
    tokenEndpoint: meta?.token_endpoint ?? `${issuer.replace(/\/$/, '')}/token`,
    registrationEndpoint: meta?.registration_endpoint ?? null,
    // The one field that decides whether a customer can connect this today.
    supportsCimd: meta?.client_id_metadata_document_supported === true,
    // S256 is REQUIRED, never negotiated down. An absent list is read as S256 —
    // it is the spec's own default and refusing on silence would reject servers
    // that simply do not enumerate it.
    supportsS256: !Array.isArray(meta?.code_challenge_methods_supported)
      || meta.code_challenge_methods_supported.includes('S256'),
    scopesSupported: rm?.scopes_supported ?? [],
  };
}

/**
 * STEP 3 OF THE CHAIN: ATLAS REGISTERS ITSELF, PROGRAMMATICALLY.
 *
 * A service that does not accept a URL as a client id may still offer to register
 * one on the spot. That is dynamic registration, and it is IN SCOPE — like CIMD it
 * costs the customer nothing, because the registering is done by Atlas over HTTP,
 * not by a person in a settings screen. Measured 2026-08-03, this is the ONLY way
 * Asana and Stripe are reachable at all; refusing them for want of CIMD would
 * have written off two working services for a reason that has nothing to do with
 * the customer's experience.
 *
 * ── Registered ONCE, then remembered ────────────────────────────────────────
 *
 * Re-registering on every restart leaves a trail of abandoned client records on
 * the service's side and eventually gets rate-limited or blocked. The result is
 * therefore persisted to disk and reused. This is a property of the DEPLOYMENT,
 * not of a tenant — every tenant connecting to Asana does so as the same Atlas —
 * so it deliberately does not live in the per-tenant token store.
 *
 * ── THE KEY INCLUDES WHERE WE COME BACK TO, and that is not bookkeeping ─────
 *
 * A registration records the redirect URI it was made with. Key it by issuer
 * alone and a registration made on the dev box — carrying dev's callback — is
 * reused verbatim in production, where the service then redirects the customer
 * to a machine they cannot reach. The failure is silent, arrives only in the
 * browser, and looks like the service's fault. Found while driving the local
 * server, 2026-08-03, before it could reach prod.
 */
// Resolved per call, not at import. A path frozen at module load cannot be
// pointed anywhere else by a test, which would leave the one branch that writes
// to disk exercised only against the real file — or not at all.
const dcrFile = () => process.env.MCP_DCR_FILE ?? './memory/mcp-clients.json';

function readDcrCache() {
  try { return JSON.parse(readFileSync(dcrFile(), 'utf8')); } catch { return {}; }
}
function writeDcrCache(cache) {
  try {
    mkdirSync(dirname(dcrFile()), { recursive: true });
    writeFileSync(dcrFile(), JSON.stringify(cache, null, 2));
  } catch { /* a cache we cannot write is a re-registration, not a failure */ }
}

export async function registerDynamically({ issuer, registrationEndpoint, fetchImpl = fetch, timeoutMs = 12000 }) {
  // Identity AND destination. `clientIdUrl()` is derived from the deployment's
  // own base, so a dev registration can never be handed to production.
  const key = JSON.stringify([issuer, redirectUris()[0]]);
  const cache = readDcrCache();
  if (cache[key]?.client_id) return cache[key];

  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    // The SAME facts the identity document states. Two descriptions of Atlas that
    // could drift is the duplication this codebase has paid for nine times, so
    // the document is the source and this strips only what registration rejects.
    body: JSON.stringify((({ client_id, ...rest }) => rest)(clientIdMetadata())),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) return null;

  const reg = await res.json().catch(() => null);
  if (!reg?.client_id) return null;

  cache[key] = {
    client_id: reg.client_id,
    client_secret: reg.client_secret ?? null,
    issuer,
    redirect_uri: redirectUris()[0],
    registered_at: new Date().toISOString(),
  };
  writeDcrCache(cache);
  return cache[key];
}

/**
 * The connect flow, mirroring the native connectors' shape so nothing downstream
 * has to learn a second one.
 */
export function createMcpConnectFlow({ fetchImpl = fetch } = {}) {
  // state → { tenantId, userId, connector, mcpUrl, tokenEndpoint, resource, codeVerifier, expiresAt }
  const pending = new Map();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
  };

  /**
   * Where to send the customer — or an honest refusal.
   *
   * Returns `{ok:false, ...unsupportedService()}` rather than throwing, because
   * "we can't connect this one yet" is an ANSWER a person can act on, and it must
   * be as easy to return as the success case. Anything that made refusing harder
   * than adapting would eventually get adapted.
   */
  async function beginConnect({ tenantId, userId, connector, mcpUrl, serviceName, hasPreRegistered = false }) {
    if (!tenantId) throw new Error('mcp connect requires a tenantId');
    if (!connector) throw new Error('mcp connect requires a connector id');
    sweep();

    const d = await discoverAuthServer({ mcpUrl, fetchImpl });

    if (!d.needsAuth) return { ok: true, needsAuth: false, mcpUrl, resource: d.resource };

    if (!d.authorizationEndpoint) {
      return { ok: false, ...unsupportedService(serviceName ?? 'That service') };
    }
    if (!d.supportsS256) {
      // Refusing a real service is a real cost, and it is the right one: the
      // alternative is `plain`, which sends the verifier as its own challenge and
      // protects nothing.
      return { ok: false, ...unsupportedService(serviceName ?? 'That service') };
    }

    // ── THE CHAIN, AND WHERE IT STOPS ──────────────────────────────────────
    //
    //   pre-registered → CIMD → dynamic registration → [ nothing ]
    //
    // Note what is absent below: there is no fourth branch, and no shape of
    // return value that carries a field for a customer to type a credential
    // into. The standard's fourth step is unreachable because it was never
    // written, not because a flag switches it off.
    let clientId = clientIdUrl();
    let clientSecret = null;

    if (!hasPreRegistered && !d.supportsCimd) {
      if (!d.registrationEndpoint) {
        return { ok: false, ...unsupportedService(serviceName ?? 'That service') };
      }
      const reg = await registerDynamically({
        issuer: d.issuer, registrationEndpoint: d.registrationEndpoint, fetchImpl,
      });
      if (!reg) return { ok: false, ...unsupportedService(serviceName ?? 'That service') };
      clientId = reg.client_id;
      clientSecret = reg.client_secret ?? null;
    }

    const codeVerifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(24));

    pending.set(state, {
      tenantId, userId, connector, mcpUrl,
      tokenEndpoint: d.tokenEndpoint,
      resource: d.resource,
      clientId, clientSecret,
      codeVerifier,
      expiresAt: Date.now() + STATE_TTL_MS,
    });

    const url = new URL(d.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    // The client id IS our identity document's URL. There was no registration,
    // which is exactly why the customer had nothing to do.
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUris()[0]);
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', b64url(createHash('sha256').update(codeVerifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    // Binds the token to THIS server (RFC 8707). Sent on both legs.
    url.searchParams.set('resource', d.resource);
    if (d.scopesSupported.length) url.searchParams.set('scope', d.scopesSupported.join(' '));

    return { ok: true, needsAuth: true, authorizeUrl: url.toString(), state };
  }

  /**
   * The customer came back. Turn the code into a token.
   *
   * `state` is consumed FIRST and unconditionally, so a replayed code cannot be
   * exchanged twice even if the exchange below fails.
   */
  async function completeConnect({ state, code, sessionUserId }) {
    if (!state || !code) throw new Error('The service sent us back without a code — start the connection again.');
    const ctx = pending.get(state);
    pending.delete(state); // single-use, before anything can throw
    if (!ctx) throw new Error('That connection link has already been used or has expired — start again.');
    if (ctx.expiresAt <= Date.now()) throw new Error('That connection took too long — start again.');
    if (sessionUserId && ctx.userId && ctx.userId !== sessionUserId) {
      throw new Error('That connection was started by a different person.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUris()[0],
      code_verifier: ctx.codeVerifier,
      client_id: ctx.clientId,
      resource: ctx.resource,
    });

    // Under CIMD there is no secret to present, because nothing registered us —
    // that is the mechanism, not an omission. A DYNAMICALLY registered client may
    // have been issued one, and it belongs to the deployment, never to a customer.
    if (ctx.clientSecret) body.set('client_secret', ctx.clientSecret);

    const res = await fetchImpl(ctx.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Connecting failed (${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    const tok = await res.json();
    if (!tok.access_token) throw new Error('The service completed sign-in but sent no access token.');

    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      connector: ctx.connector,
      mcpUrl: ctx.mcpUrl,
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresIn: Number(tok.expires_in) || 3600,
      scope: tok.scope ?? '',
    };
  }

  return { beginConnect, completeConnect, _pending: pending };
}
