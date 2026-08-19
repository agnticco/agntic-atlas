/**
 * OAuth endpoints — what a client walks through to connect Atlas by URL alone.
 *
 * Mounted via mountOAuthRoutes(app, { spine, oauth, requireAuth, issuer })
 *
 *   GET  /.well-known/oauth-protected-resource   — which authorization server guards /mcp
 *   GET  /.well-known/oauth-authorization-server — RFC 8414 metadata
 *   GET  /oauth/authorize                        — the consent screen
 *   POST /oauth/authorize                        — the approval, back from that screen
 *   POST /oauth/token                            — code → tokens, and refresh
 *
 * The discovery chain this satisfies is the one `connectors/mcp-connect.js` walks when
 * Atlas connects to somebody else. That file is the specification here: it 401-probes,
 * reads `WWW-Authenticate` (falling back to the well-known path), follows to the
 * authorization server's metadata, requires S256, and connects only if the server accepts
 * a URL as a client id. Everything below exists so Atlas answers its own questions.
 *
 * ── THE CONSENT SCREEN IS THE SECURITY BOUNDARY ────────────────────────────
 *
 * Everything before it is discovery, which is public by design. The screen is the only
 * place a human decides, so it must name who is asking — resolved from the client's own
 * published document, not from anything the client typed into the request — and what they
 * would be able to do. Rendering it is the reason this serves HTML at all, following the
 * standalone-page precedent of `/approvals/:token`: no SPA, no assets, no build step.
 *
 * ── WHY THE FORM CARRIES A SESSION, NOT A LOGIN ────────────────────────────
 *
 * A connecting user is nearly always already signed into Atlas in that browser, so the
 * screen is one click. When they are not, the page shows a sign-in that posts to the
 * normal `/auth/login` and reloads — rather than bouncing through the SPA and trying to
 * come back, which loses the query string that IS the request.
 */

import { parseScopes, redirectAllowed, resolveClientIdentity, SCOPES } from '../auth/oauth-provider.js';
import { logEvent, errFields } from '../utils/event-log.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The only fields that may be carried through the consent screen.
 *
 * The failure path used to re-render with `{...req.body}`, which on a submitted sign-in
 * form meant EMAIL AND PASSWORD were written back out as hidden inputs — the password in
 * the page source, in the browser's cache and in anything that captured the response. An
 * allow-list rather than a deny-list: the next field added to that form must not silently
 * inherit permission to be echoed.
 */
/**
 * A consent approval must be proven to come from Atlas's own screen.
 *
 * Today a forged cross-site POST cannot reach here anyway: the session cookie is
 * SameSite=Lax, so a browser will not attach it to a cross-site form submission. That is a
 * property of a cookie set in server.js for its own reasons — nothing near this file says
 * the consent screen depends on it, and setting SameSite=None (to embed Atlas in an
 * iframe, say) would silently turn "approve this connection" into something any page on
 * the internet could do to a signed-in user, granting an attacker's client access to
 * their workspace. The token makes the requirement explicit and local.
 *
 * It is derived from the session rather than stored, so there is no server-side state and
 * nothing to expire: knowing the value requires already holding the session cookie, and an
 * attacker who holds that has the account regardless.
 */
const consentToken = (req) => {
  const session = req.cookies?.session;
  if (!session) return '';
  return createHash('sha256').update(`${session}:oauth-consent`).digest('base64url');
};

/**
 * Throttle /oauth/token per (IP, client), same shape as the login and password-reset
 * limiters in server.js.
 *
 * Guessing a code or a refresh secret is not the realistic threat — both are 128+ bits of
 * randomness and codes live 60 seconds. What this actually bounds is unmetered work: every
 * call does a PKCE hash and a database write, and `refresh` can now REVOKE A GRANT, so an
 * attacker holding one stale token could hammer the endpoint to keep a connection dead.
 * Fail-open by design — a legitimate client redeems once and refreshes every eight hours,
 * so it never approaches the ceiling.
 */
const TOKEN_MAX_HITS = 30;
const TOKEN_WINDOW_MS = 15 * 60 * 1000;

/** One limiter per mounted server, so its counters are not process-wide shared state. */
export function createTokenThrottle({ max = TOKEN_MAX_HITS, windowMs = TOKEN_WINDOW_MS } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  return function tokenThrottled(req) {
    const now = Date.now();
    const key = `${req.ip}|${String(req.body?.client_id ?? '').slice(0, 200)}`;
    const e = hits.get(key);
    if (!e || now > e.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k); // lazy sweep
      }
      return 0;
    }
    e.count++;
    return e.count > max ? Math.ceil((e.resetAt - now) / 1000) : 0;
  };
}

/** Constant-time equality for two strings of any length. */
function sameToken(a, b) {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

const CARRIED = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state',
                 'code_challenge', 'code_challenge_method', 'resource'];

const carried = (src = {}) => Object.fromEntries(
  CARRIED.map(k => [k, src[k] ?? '']).filter(([, v]) => v !== ''));

const SCOPE_WORDS = {
  [SCOPES.READ]: 'See your automations, their steps and their run history',
  [SCOPES.RUN]: 'Run your automations — which sends messages and writes documents through the services they use',
};

/**
 * The consent page.
 *
 * Inline styles because this must render before any asset loads and outside the SPA;
 * the same reason the approvals page is built this way.
 */
function consentPage({ client, scopes, params, user, error }) {
  const rows = scopes.map(s => `<li>${esc(SCOPE_WORDS[s] ?? s)}</li>`).join('');
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');

  const body = user
    ? `<form method="post" action="/oauth/authorize">
         ${hidden}
         <p class="who">Signed in as <strong>${esc(user.email)}</strong></p>
         <div class="actions">
           <button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
           <button type="submit" name="decision" value="allow" class="primary">Allow access</button>
         </div>
       </form>`
    : `<form method="post" action="/oauth/authorize">
         ${hidden}
         <p class="who">Sign in to continue.</p>
         ${error ? `<p class="error">${esc(error)}</p>` : ''}
         <label>Email<input type="email" name="email" autocomplete="username" required></label>
         <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
         <div class="actions">
           <button type="submit" name="decision" value="allow" class="primary">Sign in and allow</button>
         </div>
       </form>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Connect to Atlas</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0e0e10; color: #e8e8ea; padding: 24px; }
  .card { width: min(440px, 100%); border: 1px solid #ffffff1f; border-radius: 12px;
          padding: 26px; background: #141416; }
  h1 { font-size: 19px; margin: 0 0 6px; }
  .sub { color: #a0a0a8; margin: 0 0 18px; font-size: 14px; }
  ul { margin: 0 0 18px; padding-left: 20px; color: #d0d0d6; }
  li { margin-bottom: 6px; }
  .who { color: #a0a0a8; font-size: 13px; margin: 0 0 14px; }
  label { display: block; font-size: 13px; color: #a0a0a8; margin-bottom: 10px; }
  input[type=email], input[type=password] { display: block; width: 100%; margin-top: 4px;
    padding: 9px 10px; border-radius: 7px; border: 1px solid #ffffff26;
    background: #ffffff0d; color: inherit; font: inherit; box-sizing: border-box; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  button { font: inherit; padding: 9px 15px; border-radius: 7px; cursor: pointer;
           border: 1px solid #ffffff26; background: #ffffff12; color: inherit; }
  .primary { background: #2f6f45; border-color: #3f8a58; }
  .error { color: #f0a5a5; font-size: 13px; margin: 0 0 10px; }
  .origin { color: #7a7a82; font-size: 12px; margin-top: 16px; word-break: break-all; }
</style></head><body>
<div class="card">
  <h1>${esc(client.name)} wants to connect</h1>
  <p class="sub">It is asking for access to your Atlas workspace.</p>
  <ul>${rows}</ul>
  ${body}
  <p class="origin">Identified by <code>${esc(client.clientId)}</code></p>
</div></body></html>`;
}

export function mountOAuthRoutes(app, { spine, oauth, issuer,
                                       loginThrottle = null, setSessionCookie = null,
                                       resolveClient = resolveClientIdentity,
                                       throttle = createTokenThrottle() }) {
  const { tokenService, sessionStore, userStore, authProvider, issueSession } = spine.auth;

  /** Resolve the browser's Atlas session from the cookie, or null. */
  function sessionUser(req) {
    const token = req.cookies?.session;
    const claims = token && tokenService.verify(token);
    if (!claims?.sub || !claims?.jti) return null;
    const session = sessionStore.touch(claims.jti);
    if (!session || session.user_id !== claims.sub) return null;
    const user = userStore.findById(claims.sub);
    return user && !user.disabled_at ? user : null;
  }

  // ── discovery ─────────────────────────────────────────────────────────────
  // Public and unauthenticated by design: a client must be able to learn how to ask
  // before it has anything to ask with.

  /**
   * Agent Deployer's client-ID document.
   *
   * A desktop app has no website of its own to publish this at, and CIMD requires a real
   * https URL. Agntic publishes both the app and this server, so it is served here — the
   * document only has to be reachable, stable and truthful about who is asking. Moving it
   * to agntic.co later changes this route into a redirect and nothing else.
   *
   * The port-less loopback entry is the whole point of redirectAllowed(): the app binds
   * whatever port is free when it starts.
   */
  app.get('/clients/agent-deployer.json', (_req, res) => {
    res.type('application/json').json({
      client_id: `${issuer}/clients/agent-deployer.json`,
      client_name: 'Agent Deployer',
      client_uri: 'https://agntic.co',
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json(oauth.protectedResourceMetadata());
  });
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json(oauth.authorizationServerMetadata());
  });

  // ── authorize ─────────────────────────────────────────────────────────────

  /** Validate the request itself, before any of it reaches a page. */
  async function readAuthorizeRequest(q) {
    if (q.response_type !== 'code') throw new Error('response_type must be "code"');
    if (q.code_challenge_method !== 'S256') {
      // Never negotiated down, matching what Atlas demands of servers it connects to.
      throw new Error('code_challenge_method must be S256');
    }
    if (!q.code_challenge) throw new Error('code_challenge is required');

    const client = await resolveClient(q.client_id);
    // An unregistered redirect_uri is the open-redirect hole; the document is the only
    // thing that may say where a code is allowed to land.
    if (!redirectAllowed(client.redirectUris, q.redirect_uri)) {
      throw new Error('redirect_uri is not listed in the client_id document');
    }
    return { client, scopes: parseScopes(q.scope) };
  }

  app.get('/oauth/authorize', async (req, res) => {
    try {
      const { client, scopes } = await readAuthorizeRequest(req.query);
      res.type('html').send(consentPage({
        client, scopes, user: sessionUser(req), error: null,
        params: { ...carried(req.query), response_type: 'code',
                  code_challenge_method: 'S256', scope: scopes.join(' '),
                  csrf: consentToken(req) },
      }));
    } catch (err) {
      // Rendered, not redirected: at this point the redirect_uri is either absent or
      // unverified, and bouncing an error to an unverified address is the open redirect.
      logEvent('oauth.authorize.rejected', errFields(err));
      res.status(400).type('html').send(
        `<!doctype html><meta charset="utf-8"><title>Cannot connect</title>`
        + `<body style="font:15px system-ui;padding:2rem;background:#0e0e10;color:#e8e8ea">`
        + `<h1 style="font-size:18px">Atlas cannot accept this connection</h1>`
        + `<p>${esc(err.message)}</p></body>`);
    }
  });

  app.post('/oauth/authorize', async (req, res) => {
    try {
      const { client, scopes } = await readAuthorizeRequest(req.body);

      let user = sessionUser(req);

      // Only the cookie-authenticated path needs this. When the form carries credentials
      // the password IS the proof, and an attacker who has it does not need a forgery.
      if (user && !sameToken(req.body.csrf, consentToken(req))) {
        logEvent('oauth.authorize.csrf', { client: client.clientId });
        return res.status(403).type('html').send(consentPage({
          client, scopes, user,
          error: 'This approval did not come from Atlas. Reload the page and try again.',
          params: { ...carried(req.body), csrf: consentToken(req) },
        }));
      }

      if (!user && req.body.email) {
        // THE SAME THROTTLE /auth/login USES. Without it this route is a second, faster
        // password oracle against the same accounts — an attacker would simply guess here
        // instead, and the brake on the front door would count for nothing.
        const wait = loginThrottle?.retryAfter?.(req);
        if (wait) {
          res.setHeader('Retry-After', String(wait));
          return res.status(429).type('html').send(consentPage({
            client, scopes, user: null, params: carried(req.body),
            error: 'Too many failed attempts. Try again in a moment.',
          }));
        }
        user = await authProvider.authenticate({ email: req.body.email, password: req.body.password });
        if (!user) loginThrottle?.recordFail?.(req);
        if (user) {
          loginThrottle?.clearFails?.(req);
          // Give the browser a real session too, so a second connection is one click.
          // Set through the app's own helper rather than a second res.cookie() call:
          // this one had `secure: true` hardcoded and no maxAge, so it behaved differently
          // from every other session cookie and silently failed over plain http.
          const { token } = issueSession({ user });
          setSessionCookie?.(res, token);
        }
      }
      if (!user) {
        return res.status(401).type('html').send(consentPage({
          client, scopes, user: null, error: 'Those credentials were not accepted.',
          params: { ...carried(req.body), csrf: consentToken(req) },
        }));
      }

      const back = new URL(req.body.redirect_uri);
      if (req.body.decision !== 'allow') {
        back.searchParams.set('error', 'access_denied');
        if (req.body.state) back.searchParams.set('state', req.body.state);
        return res.redirect(back.toString());
      }

      const code = oauth.issueCode({
        userId: user.id, tenantId: user.tenant_id,
        clientId: client.clientId, clientName: client.name,
        redirectUri: req.body.redirect_uri, scope: scopes.join(' '),
        codeChallenge: req.body.code_challenge, resource: req.body.resource || issuer,
      });
      logEvent('oauth.authorize.granted', { tenant: user.tenant_id, client: client.clientId, scope: scopes.join(' ') });

      back.searchParams.set('code', code);
      if (req.body.state) back.searchParams.set('state', req.body.state);
      res.redirect(back.toString());
    } catch (err) {
      logEvent('oauth.authorize.error', errFields(err));
      res.status(400).json({ error: 'invalid_request', error_description: err.message });
    }
  });

  // ── token ─────────────────────────────────────────────────────────────────

  app.post('/oauth/token', (req, res) => {
    const fail = (code, description) => res.status(400).json({ error: code, error_description: description });
    const wait = throttle(req);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: 'slow_down',
                                    error_description: 'Too many token requests.' });
    }
    try {
      const grant = req.body?.grant_type;
      if (grant === 'authorization_code') {
        return res.json(oauth.redeemCode({
          code: req.body.code, codeVerifier: req.body.code_verifier,
          clientId: req.body.client_id, redirectUri: req.body.redirect_uri,
          resource: req.body.resource || null,
        }));
      }
      if (grant === 'refresh_token') {
        return res.json(oauth.refresh({
          refreshToken: req.body.refresh_token, clientId: req.body.client_id,
        }));
      }
      return fail('unsupported_grant_type', 'Supported: authorization_code, refresh_token.');
    } catch (err) {
      logEvent('oauth.token.rejected', errFields(err));
      const [code, ...rest] = String(err.message).split(': ');
      return fail(code === 'invalid_grant' ? 'invalid_grant' : 'invalid_request',
                  rest.join(': ') || err.message);
    }
  });
}

export default mountOAuthRoutes;
