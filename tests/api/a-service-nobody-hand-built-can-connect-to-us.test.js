/**
 * ATLAS MUST CLEAR THE BAR IT SETS FOR EVERYONE ELSE.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `connectors/mcp-connect.js` is Atlas connecting to a service nobody hand-built: it
 * 401-probes an MCP URL, follows `WWW-Authenticate` to the resource metadata, reads the
 * authorization server's document, and connects only if that server accepts a URL as a
 * client id. `client-identity.js` states the constraint that produced it — a customer
 * must NEVER be sent to a developer settings screen to paste a secret.
 *
 * The same constraint applies in reverse. Somebody connecting Atlas to Claude should copy
 * a URL and approve a screen. So the first test here does not check a document by hand:
 * it points Atlas's OWN discovery at Atlas. If the chain we demand of Notion does not
 * complete against us, we are asking for something we do not provide.
 *
 * ── The three that are security, not plumbing ──────────────────────────────
 *
 *   1. CIMD MEANS FETCHING A URL THE CALLER SUPPLIED. `client_id` is an address this
 *      server retrieves during authorization, so `client_id=http://169.254.169.254/…`
 *      is a request to read cloud-metadata credentials and hand them back. It goes
 *      through the same guard `web_fetch` uses.
 *   2. THE REDIRECT_URI IS WHERE A CODE LANDS. Only the client's own published document
 *      may say where that is; accepting one from the query string is the open redirect.
 *   3. A CODE IS SINGLE-USE. It is deleted before it is validated, so a replay fails even
 *      when the verifier is correct.
 *
 * ── AND IT IS A SIGN-IN SCREEN, WHICH IS THE OTHER HALF ────────────────────
 *
 * The consent form authenticates. That makes it a second front door, and a door is not
 * exempt from a rule because it is new: a wrong password must count against the same
 * throttle `/auth/login` uses, and a rejected one must not come back in the response.
 * The last three tests exist because neither was true when this file was first written —
 * the re-render carried the submitted password out as a hidden input.
 *
 * ── Mutations, run by hand ─────────────────────────────────────────────────
 *   M1  client_id_metadata_document_supported → false   → 1 red
 *   M2  the SSRF guard is skipped for client_id         → 1 red
 *   M3  redirect_uri is taken from the request          → 1 red
 *   M4  the code is deleted only on success             → 1 red
 *   M5  PKCE compares the verifier, not its hash        → 2 red
 *   M6  the re-render spreads req.body                  → 1 red
 *   M7  a failed sign-in is not reported to the throttle → 1 red
 *   M8  the throttle is never consulted                 → 1 red
 *   M9  canonicalResource returns what it was given     → 1 red
 *   M10 a rotated refresh token coming back is ignored  → 2 red
 *   M11 reuse is detected but the grant is left live    → 2 red
 *   M12 grantIsLive ignores revoked_at / expiry         → 2 red
 *   M13 /mcp does not check the grant behind the token  → 1 red
 *   M14 the consent form accepts any csrf value         → 1 red
 *   M15 /oauth/token is unbounded                       → 1 red
 *
 * M10–M12 take two apiece because reuse detection, revocation and the liveness read are
 * one mechanism seen from three sides: break any of them and both the "grant ends" and
 * the "access tokens stop" tests go red together. That is the coupling working.
 *
 * M5 takes two because comparing the raw verifier fails the happy path as well as the
 * wrong-verifier one — a mutation that breaks the feature outright, not only its guard.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';

import { mountOAuthRoutes } from '../../src/api/oauth.js';
import { mountMcpRoutes } from '../../src/api/mcp.js';
import { createOAuthProvider, resolveClientIdentity, parseScopes } from '../../src/auth/oauth-provider.js';
import { discoverAuthServer } from '../../src/connectors/mcp-connect.js';

const b64url = (b) => Buffer.from(b).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A whole Atlas authorization server on an ephemeral port. */
async function atlas({ authenticate = async () => null, loginThrottle = null, signedIn = false,
                       // A real CIMD fetch would leave the network, so the consent-screen
                       // tests below would 400 before reaching the code they are about.
                       resolveClient = async (id) => ({ clientId: id, name: 'C',
                                                        redirectUris: ['https://c.example/cb'] }),
                     } = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  const server = createServer(app);
  await new Promise(r => server.listen(0, r));
  const issuer = `http://localhost:${server.address().port}`;

  const db = new Database(':memory:');
  const spine = {
    auth: {
      db,
      tokenService: {
        verify: (t) => (signedIn && t === 'sess-1' ? { sub: 'u1', jti: 'j1' } : null),
        signAccess: () => 'access-token',
      },
      userStore: { findById: (id) => ({ id, tenant_id: 't1', disabled_at: null }) },
      sessionStore: { touch: (j) => (j === 'j1' ? { user_id: 'u1' } : null) },
      authProvider: { authenticate },
      issueSession: () => ({ token: 'session' }),
    },
    engine: { workflowStore: { list: () => [], get: () => null }, workflowScheduler: {} },
    interactionStore: null,
  };
  const oauth = createOAuthProvider({
    db, tokenService: spine.auth.tokenService, userStore: spine.auth.userStore, issuer,
  });
  mountOAuthRoutes(app, { spine, oauth, issuer, loginThrottle, resolveClient,
                          setSessionCookie: (res, t) => res.cookie('session', t, { path: '/' }) });
  mountMcpRoutes(app, {
    spine, oauth, issuer,
    requireActiveTenant: (_req, res) => res.status(401).json({ error: 'Unauthorized' }),
  });

  return { issuer, oauth, close: () => new Promise(r => server.close(r)) };
}

describe('Atlas clears its own connection bar', () => {
  test('Atlas\'s discovery chain completes against Atlas', async () => {
    const a = await atlas();
    try {
      // Not a hand-written assertion about a document — the real consumer, pointed at us.
      const found = await discoverAuthServer({ mcpUrl: `${a.issuer}/mcp` });
      assert.equal(found.needsAuth, true, 'the endpoint did not challenge');
      assert.ok(found.authorizationEndpoint, 'no authorization endpoint was discovered');
      assert.equal(found.supportsS256, true, 'S256 is required and was not advertised');
      assert.equal(found.supportsCimd, true,
        'without client_id_metadata_document_supported a customer must pre-register a '
        + 'client, which is the developer-settings screen this product refuses to have');
    } finally { await a.close(); }
  });

  test('the challenge says where to look', async () => {
    const a = await atlas();
    try {
      const res = await fetch(`${a.issuer}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="/,
        'a 401 pointing nowhere reads as "not supported yet" to our own client');
    } finally { await a.close(); }
  });
});

describe('the client_id document is fetched hostilely', () => {
  test('a private address is refused', async () => {
    // client_id is supplied by whoever is asking. This one asks us to read the cloud
    // metadata service and hand the result back.
    for (const bad of ['http://169.254.169.254/latest/meta-data/',
                       'https://127.0.0.1/client.json',
                       'https://localhost/client.json']) {
      await assert.rejects(() => resolveClientIdentity(bad),
        /private|reserved|local|https/i, `accepted ${bad}`);
    }
  });

  test('plain http is refused even when public', async () => {
    await assert.rejects(() => resolveClientIdentity('http://example.com/client.json'), /https/i);
  });

  test('a document that claims a different client_id is unresolvable', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ client_id: 'https://elsewhere.example/x',
                                         redirect_uris: ['https://a.example/cb'] }),
    });
    await assert.rejects(
      () => resolveClientIdentity('https://example.com/client.json', { fetchImpl }),
      /different client_id/,
      'the address IS the identity; a document naming another id is somebody else');
  });

  test('a document with no redirect_uris is refused', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ client_id: 'https://example.com/client.json' }),
    });
    await assert.rejects(() => resolveClientIdentity('https://example.com/client.json', { fetchImpl }),
      /redirect_uris/);
  });
});

describe('the authorization code is single-use and PKCE-bound', () => {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  // The resource is THIS server's own identifier. It used to be a made-up URL, which
  // passed only because the provider wrote whatever it was handed into the token's `aud`.
  const grant = (a) => a.oauth.issueCode({
    userId: 'u1', tenantId: 't1', clientId: 'https://c.example/id.json', clientName: 'C',
    redirectUri: 'https://c.example/cb', scope: 'workflows:read',
    codeChallenge: challenge, resource: a.issuer,
  });
  const redeem = (a, code, over = {}) => a.oauth.redeemCode({
    code, codeVerifier: verifier, clientId: 'https://c.example/id.json',
    redirectUri: 'https://c.example/cb', resource: a.issuer, ...over,
  });

  test('a correct exchange returns a scoped token', async () => {
    const a = await atlas();
    try {
      const out = redeem(a, grant(a));
      assert.equal(out.token_type, 'Bearer');
      assert.equal(out.scope, 'workflows:read');
      assert.ok(out.refresh_token, 'no refresh token — the connection would die in hours');
    } finally { await a.close(); }
  });

  test('the same code cannot be spent twice', async () => {
    const a = await atlas();
    try {
      const code = grant(a);
      redeem(a, code);
      assert.throws(() => redeem(a, code), /already-used|unknown/);
    } finally { await a.close(); }
  });

  test('a wrong verifier is refused', async () => {
    const a = await atlas();
    try {
      assert.throws(() => redeem(a, grant(a), { codeVerifier: 'not-it' }), /PKCE/);
    } finally { await a.close(); }
  });

  test('a code issued for one client cannot be spent by another', async () => {
    const a = await atlas();
    try {
      assert.throws(() => redeem(a, grant(a), { clientId: 'https://other.example/id.json' }),
        /another client/);
    } finally { await a.close(); }
  });

  test('a code cannot be redirected somewhere else', async () => {
    const a = await atlas();
    try {
      assert.throws(() => redeem(a, grant(a), { redirectUri: 'https://evil.example/cb' }),
        /redirect_uri/);
    } finally { await a.close(); }
  });

  test('this server will not mint a token addressed to another service', async () => {
    const a = await atlas();
    try {
      // The replay this prevents: a client asks us for a token naming somebody else's MCP
      // server, then spends our signature there. Refusing at the mint is what makes the
      // `aud` check at /mcp meaningful — otherwise we sign whatever address we are given.
      assert.throws(() => a.oauth.issueCode({
        userId: 'u1', tenantId: 't1', clientId: 'https://c.example/id.json', clientName: 'C',
        redirectUri: 'https://c.example/cb', scope: 'workflows:read',
        codeChallenge: challenge, resource: 'https://other-mcp.example',
      }), /invalid_target/);
      assert.throws(() => redeem(a, grant(a), { resource: 'https://other-mcp.example' }),
        /invalid_target/);
    } finally { await a.close(); }
  });

  test('the MCP endpoint is named as the resource, since that is the URL a user pastes', async () => {
    const a = await atlas();
    try {
      const code = a.oauth.issueCode({
        userId: 'u1', tenantId: 't1', clientId: 'https://c.example/id.json', clientName: 'C',
        redirectUri: 'https://c.example/cb', scope: 'workflows:read',
        codeChallenge: challenge, resource: `${a.issuer}/mcp`,
      });
      assert.ok(redeem(a, code, { resource: `${a.issuer}/mcp` }).access_token,
        'a client that names the endpoint it is connecting to — rather than the issuer — '
        + 'is doing the reasonable thing and must not be locked out');
    } finally { await a.close(); }
  });
});

describe('a rotated refresh token coming back is treated as a copy in circulation', () => {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());

  const connect = (a) => {
    const code = a.oauth.issueCode({
      userId: 'u1', tenantId: 't1', clientId: 'https://c.example/id.json', clientName: 'C',
      redirectUri: 'https://c.example/cb', scope: 'workflows:read',
      codeChallenge: challenge, resource: a.issuer,
    });
    return a.oauth.redeemCode({
      code, codeVerifier: verifier, clientId: 'https://c.example/id.json',
      redirectUri: 'https://c.example/cb', resource: a.issuer,
    });
  };
  const CLIENT = 'https://c.example/id.json';

  test('the ordinary case still works: refresh, then refresh again', async () => {
    const a = await atlas();
    try {
      const first = connect(a);
      const second = a.oauth.refresh({ refreshToken: first.refresh_token, clientId: CLIENT });
      assert.ok(second.refresh_token && second.refresh_token !== first.refresh_token,
        'rotation did not produce a new token');
      assert.ok(a.oauth.refresh({ refreshToken: second.refresh_token, clientId: CLIENT }).access_token,
        'a client that refreshes twice in a row was locked out of its own connection');
    } finally { await a.close(); }
  });

  test('presenting the superseded token ends the grant for everyone', async () => {
    const a = await atlas();
    try {
      const first = connect(a);
      const second = a.oauth.refresh({ refreshToken: first.refresh_token, clientId: CLIENT });

      // The thief's copy of the token the real client already spent.
      assert.throws(() => a.oauth.refresh({ refreshToken: first.refresh_token, clientId: CLIENT }),
        /already rotated/);

      // And the real client's current token is dead too — we cannot tell which party was
      // copied, so the connection ends and the user re-consents.
      assert.throws(() => a.oauth.refresh({ refreshToken: second.refresh_token, clientId: CLIENT }),
        /unknown refresh token/,
        'the grant survived a detected copy, so the thief kept rolling it for 90 days');
    } finally { await a.close(); }
  });

  test('the access tokens issued under that grant stop working too', async () => {
    const a = await atlas();
    try {
      const first = connect(a);
      const live = a.oauth.refresh({ refreshToken: first.refresh_token, clientId: CLIENT });
      const gid = live.refresh_token.split('.')[0];
      assert.equal(a.oauth.grantIsLive(gid), true);

      assert.throws(() => a.oauth.refresh({ refreshToken: first.refresh_token, clientId: CLIENT }));
      assert.equal(a.oauth.grantIsLive(gid), false,
        'detection that leaves the current access token working for another 8 hours is a '
        + 'log line, not a revocation');
    } finally { await a.close(); }
  });

  test('a grant the user revoked is not live', async () => {
    const a = await atlas();
    try {
      const gid = connect(a).refresh_token.split('.')[0];
      assert.equal(a.oauth.revoke(gid, 'u1'), true);
      assert.equal(a.oauth.grantIsLive(gid), false);
    } finally { await a.close(); }
  });
});

describe('scopes default down, never up', () => {
  test('an absent or unknown scope request grants read only', () => {
    for (const asked of [undefined, '', 'admin', 'workflows:delete']) {
      assert.deepEqual(parseScopes(asked), ['workflows:read'],
        `"${asked}" did not default to read — defaulting to full access is how a consent `
        + 'screen ends up lying about what it granted');
    }
  });

  test('a valid request is honoured exactly', () => {
    assert.deepEqual(parseScopes('workflows:read workflows:run'),
      ['workflows:read', 'workflows:run']);
    assert.deepEqual(parseScopes('workflows:run admin'), ['workflows:run']);
  });
});

describe('the consent screen is a sign-in, and inherits every rule sign-ins have', () => {
  /** Post the consent form exactly as the browser would. */
  const submit = (issuer, fields) => fetch(`${issuer}/oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });

  const FORM = {
    client_id: 'https://c.example/id.json', redirect_uri: 'https://c.example/cb',
    response_type: 'code', scope: 'workflows:read', code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256', decision: 'allow',
  };

  test('a rejected password is not written back into the page', async () => {
    const a = await atlas();
    try {
      const res = await submit(a.issuer, { ...FORM, email: 'u@example.com',
                                           password: 'hunter2-correct-horse' });
      const html = await res.text();
      assert.ok(!html.includes('hunter2-correct-horse'),
        'the re-rendered form carried the submitted password back to the browser as a hidden '
        + 'input — in the page source, in the browser cache, and in anything that logged the '
        + 'response body');
    } finally { await a.close(); }
  });

  test('failed attempts here count against the same throttle as /auth/login', async () => {
    const seen = [];
    const a = await atlas({ loginThrottle: {
      retryAfter: () => (seen.length >= 3 ? 60 : 0),
      recordFail: () => seen.push(1),
      clearFails: () => {},
    } });
    try {
      for (let i = 0; i < 3; i++) {
        await submit(a.issuer, { ...FORM, email: 'u@example.com', password: `guess-${i}` });
      }
      assert.equal(seen.length, 3, 'wrong passwords here were never reported to the throttle');

      const res = await submit(a.issuer, { ...FORM, email: 'u@example.com', password: 'guess-4' });
      assert.equal(res.status, 429,
        'this route authenticates but does not throttle, so it is a faster password oracle '
        + 'against the same accounts than the front door it sits beside');
      assert.ok(res.headers.get('retry-after'));
    } finally { await a.close(); }
  });

  test('a correct password proceeds, and clears the failure count', async () => {
    let cleared = 0;
    const a = await atlas({
      authenticate: async () => ({ id: 'u1', tenant_id: 't1', email: 'u@example.com' }),
      loginThrottle: { retryAfter: () => 0, recordFail: () => {}, clearFails: () => { cleared++; } },
    });
    try {
      const res = await submit(a.issuer, { ...FORM, email: 'u@example.com', password: 'right' });
      assert.equal(res.status, 302, 'a valid sign-in did not complete the authorization');
      assert.match(res.headers.get('location') ?? '', /^https:\/\/c\.example\/cb\?code=/);
      assert.equal(cleared, 1, 'a successful sign-in must not leave earlier failures counting');
    } finally { await a.close(); }
  });
});

describe('an approval must come from the screen Atlas rendered', () => {
  const CSRF = createHash('sha256').update('sess-1:oauth-consent').digest('base64url');

  const FORM = {
    client_id: 'https://c.example/id.json', redirect_uri: 'https://c.example/cb',
    response_type: 'code', scope: 'workflows:read', code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256', decision: 'allow',
  };

  /** A signed-in browser posting the consent form. */
  const submit = (issuer, fields) => fetch(`${issuer}/oauth/authorize`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'session=sess-1' },
    body: new URLSearchParams(fields),
  });

  test('the screen Atlas rendered carries a token, and it is accepted', async () => {
    const a = await atlas({ signedIn: true });
    try {
      const res = await submit(a.issuer, { ...FORM, csrf: CSRF });
      assert.equal(res.status, 302, await res.text());
      assert.match(res.headers.get('location') ?? '', /^https:\/\/c\.example\/cb\?code=/);
    } finally { await a.close(); }
  });

  test('a form posted from anywhere else grants nothing', async () => {
    const a = await atlas({ signedIn: true });
    try {
      for (const csrf of [undefined, '', 'guessed', CSRF.slice(0, -1)]) {
        const res = await submit(a.issuer, { ...FORM, ...(csrf === undefined ? {} : { csrf }) });
        assert.equal(res.status, 403,
          `csrf=${JSON.stringify(csrf)} approved a connection. A page on any other site could `
          + "then grant its own client access to a signed-in user's workspace, and the only "
          + 'thing standing in the way would be the session cookie\'s SameSite attribute');
        assert.ok(!(res.headers.get('location') ?? '').includes('code='));
      }
    } finally { await a.close(); }
  });

  test('the sign-in path needs no token, because the password is the proof', async () => {
    const a = await atlas({ authenticate: async () => ({ id: 'u1', tenant_id: 't1' }) });
    try {
      const res = await fetch(`${a.issuer}/oauth/authorize`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...FORM, email: 'u@example.com', password: 'right' }),
      });
      assert.equal(res.status, 302,
        'requiring a token on the path that has no session yet would lock out every '
        + 'first-time connection');
    } finally { await a.close(); }
  });
});

describe('the token endpoint is bounded', () => {
  test('a flood is refused, and says when to come back', async () => {
    const a = await atlas();
    try {
      let last;
      for (let i = 0; i < 32; i++) {
        last = await fetch(`${a.issuer}/oauth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token',
                                      refresh_token: `stale-${i}`, client_id: 'https://c.example/id.json' }),
        });
      }
      assert.equal(last.status, 429,
        'unbounded calls here are unmetered PKCE hashes and database writes, and a refresh '
        + 'attempt can now revoke a grant — so a stale token becomes a way to keep somebody '
        + "else's connection dead");
      assert.ok(last.headers.get('retry-after'));
    } finally { await a.close(); }
  });
});
